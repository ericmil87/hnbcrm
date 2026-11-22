/**
 * Agenda v2 (D1) — execução das tools de agenda do Atendente. Chamado por `schedulingAi.ts` (mutations/query
 * internas da action do atendente) e por `executeAttendantToolCore` (aprovação humana do rascunho).
 *
 * REGRAS (plano §3.4, §6.3; revisão de segurança D1):
 *  - o executor RECONFERE tudo (módulo, IA da org, política `schedSettings.ai`, serviço e recurso ativos, contato não
 *    "fora do comercial"): filtrar o registry da run não basta (precedente `allowMoveStages`);
 *  - nada que venha do texto do cliente vira argumento de escrita sem passar por CÓDIGO DE OFERTA emitido nesta
 *    conversa (`resolveOffer`: válido 30 min, emitido ANTES da última mensagem do cliente);
 *  - a reserva SÓ passa por `bookAppointmentCore` (a porta); aqui não há insert nem patch de agendamento. As únicas
 *    escritas são `schedConversationState` (via `schedAiState`), repasse (`createHandoffCore`) e as da própria porta;
 *  - a IA só sabe "livre"/"ocupado": `searchSlots` com audiência `ai` sanitiza (sem nome de recurso, de cliente,
 *    motivo ou pontuação); as `alternatives` da porta vêm no mesmo formato sanitizado;
 *  - nenhum `catch` em volta da porta: erro inesperado aborta a mutation (nada fica pela metade) e a action devolve
 *    ao modelo um erro genérico.
 *
 * CUSTO DE LEITURA por chamada (documentos): `findAvailableTimes` = acesso (org, settings, conversa, lead, contato,
 * ≤ 101 serviços, ≤ 101 recursos, estado da conversa) + `searchSlots` (`loadWindow`: ≈ 40–60 documentos para 1 dia,
 * 80–250 para 7 dias; + uma segunda janela de até 7 dias só quando a pedida veio vazia). `bookOfferedTime` = acesso +
 * estado + 1 leitura por idempotência + a leitura da porta (≈ 15–25 documentos; até 45 com fallback). O contexto do
 * prompt (`schedContextCore`) lê o acesso + o estado da conversa + até 100 linhas de agendamento do contato (lotes de 20). Nada disso assina (mutation/query avulsa).
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { createHandoffCore } from "../handoffs";
import { orgAiActive } from "./agentSecurity";
import { effectiveRelation, isOffBusiness } from "./contactRelation";
import { getLeadRef } from "./leadRef";
import { modulesOf } from "./orgModules";
import { hasPermission, type Permissions, resolvePermissions, type Role } from "./permissions";
import {
  bookedResult,
  type FindArgs,
  findSlotsResult,
  formatDayLabel,
  formatOfferLine,
  formatSlotText,
  MAX_FIND_CALLS_PER_HOUR,
  FIND_WINDOW_MS,
  MAX_SERVICES_IN_PROMPT,
  matchResource,
  matchService,
  noSlotsResult,
  parseBookArgs,
  parseFindArgs,
  type ProfessionalNote,
  proposedResult,
  type SchedCurrentOffer,
  type SchedPromptService,
  type SchedUpcoming,
  serviceListText,
  type ToolText,
  toolError,
} from "./schedAttendantTools";
import { loadConversationState, offersStateOf, saveConversationState } from "./schedAiState";
import { type Alternative, type BookFailure, type BookResult, bookAppointmentCore, bookPartyCore } from "./schedBookingOps";
import { MAX_RESOURCES_PER_ORG, MAX_SERVICES_PER_ORG } from "./schedConstants";
import { consumeOffer, currentOffers, invalidateOffers, issueOffers, type OfferPick, type OfferRecord, resolveOffer } from "./schedOffers";
import { resolveDateRef } from "./schedRelativeDates";
import { type SearchSlotsResult, searchSlots } from "./schedSearch";
import { resolveSchedSettings, type ResolvedSchedSettings } from "./schedSettingsDefaults";
import { assertValidTimezone } from "./schedTime";
import type { Slot } from "./schedViews";

type ReadCtx = { db: QueryCtx["db"] };

/** Resultado de uma tool + o que o RUNTIME precisa (nada disto vai ao modelo). */
export type SchedToolOutcome = {
  result: ToolText;
  control: {
    /** Horários (início, ms) devolvidos neste ato (busca, reserva, alternativas, prévia): alimentam o `schedClaimGuard`. */
    offeredTimes: number[];
    booked?: "pending" | "scheduled";
    /** Início do agendamento reservado neste ato (com `booked`). */
    bookedStartTime?: number;
    /** Um repasse para humano foi criado (ou já existia): a resposta do turno pode sair mesmo assim. */
    handoff: boolean;
    /** Só na prévia (`mode:"preview"`): o horário em texto, para o rótulo da ação proposta no rascunho. */
    slotText?: string;
    /** Horários devolvidos/reservados que o servidor NOMEOU (profissional pedido e honrado): o `schedClaimGuard` só deixa a IA ligar o nome a eles. */
    named?: Array<{ startTime: number; professional: string }>;
  };
};

const namedOf = (offers: ReadonlyArray<{ startTime: number; professional?: string }>): { named?: Array<{ startTime: number; professional: string }> } => {
  const named = offers.flatMap((o) => (o.professional ? [{ startTime: o.startTime, professional: o.professional }] : []));
  return named.length > 0 ? { named } : {};
};

const outcome = (result: ToolText, extra: Partial<SchedToolOutcome["control"]> = {}): SchedToolOutcome => ({
  result,
  control: { offeredTimes: [], handoff: false, ...extra },
});

// ---------------------------------------------------------------------------
// Acesso: as condições em que as tools existem (registro) e valem (execução)
// ---------------------------------------------------------------------------

export type SchedAiReason =
  | "org"
  | "modulo_desligado"
  | "ia_desligada"
  | "agente"
  | "sem_permissao"
  | "conversa"
  | "grupo"
  | "sem_contato"
  | "nao_cliente"
  | "politica"
  | "sem_servico"
  | "sem_recurso";

export type SchedAiAccess =
  | { ok: false; reason: SchedAiReason }
  | {
      ok: true;
      org: Doc<"organizations">;
      tz: string;
      settings: ResolvedSchedSettings;
      agent: Doc<"teamMembers">;
      conversation: Doc<"conversations"> | null;
      lead: Doc<"leads"> | null;
      contact: Doc<"contacts"> | null;
      services: Doc<"schedServices">[];
      /** Recursos ATIVOS da org (já lidos para o gate `sem_recurso`): a busca resolve o profissional pedido por eles. */
      resources: Doc<"schedResources">[];
      /** Política de reserva EFETIVA: `auto` só com o aceite do dono (`autoAck`); sem ele vale `propose`. */
      bookPolicy: "propose" | "auto";
      canBook: boolean;
    };

/**
 * `conversationId` ausente = simulador (sem conversa nem contato). Com conversa: 1:1, contato da conversa presente e
 * não "fora do comercial". `need: "book"` exige também `ai.book !== "off"` e permissão `agenda:edit` do agente.
 */
export async function loadSchedAiAccess(
  ctx: ReadCtx,
  args: { organizationId: Id<"organizations">; agentMemberId: Id<"teamMembers">; conversationId?: Id<"conversations">; need: "consult" | "book" }
): Promise<SchedAiAccess> {
  const org = await ctx.db.get(args.organizationId);
  if (!org) return { ok: false, reason: "org" };
  if (!modulesOf(org).scheduling) return { ok: false, reason: "modulo_desligado" };
  if (!orgAiActive(org)) return { ok: false, reason: "ia_desligada" };
  const agent = await ctx.db.get(args.agentMemberId);
  if (!agent || agent.organizationId !== org._id || agent.type !== "ai" || agent.status !== "active") {
    return { ok: false, reason: "agente" };
  }
  // RBAC do agente (mesma regra de `assertAgentCan`, que exige o ctx completo): a IA precisa de `agenda`.
  const permissions = resolvePermissions(agent.role as Role, agent.permissions as Permissions | undefined);
  if (!hasPermission(permissions, "agenda", args.need === "book" ? "edit" : "view_own")) {
    return { ok: false, reason: "sem_permissao" };
  }

  let conversation: Doc<"conversations"> | null = null;
  let lead: Doc<"leads"> | null = null;
  let contact: Doc<"contacts"> | null = null;
  if (args.conversationId) {
    conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.organizationId !== org._id) return { ok: false, reason: "conversa" };
    if (conversation.kind === "group") return { ok: false, reason: "grupo" };
    lead = await getLeadRef(ctx.db, conversation.leadId);
    if (!lead || lead.organizationId !== org._id) return { ok: false, reason: "conversa" };
    contact = lead.contactId ? await ctx.db.get(lead.contactId) : null;
    if (!contact || contact.organizationId !== org._id) return { ok: false, reason: "sem_contato" };
    if (isOffBusiness(effectiveRelation(contact, conversation))) return { ok: false, reason: "nao_cliente" };
  }

  const doc = await ctx.db
    .query("schedSettings")
    .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
    .first();
  const settings = resolveSchedSettings(doc);
  if (!settings.ai.consult) return { ok: false, reason: "politica" };
  const canBook = settings.ai.book !== "off";
  if (args.need === "book" && !canBook) return { ok: false, reason: "politica" };

  const all = await ctx.db
    .query("schedServices")
    .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
    .take(MAX_SERVICES_PER_ORG + 1);
  const services = all
    .filter((s) => s.active && s.aiBookable !== false)
    .sort((a, b) => a.sortOrder - b.sortOrder || (a._id < b._id ? -1 : 1));
  if (services.length === 0) return { ok: false, reason: "sem_servico" };
  const resources = await ctx.db
    .query("schedResources")
    .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
    .take(MAX_RESOURCES_PER_ORG + 1);
  const activeResources = resources.filter((r) => r.active);
  if (activeResources.length === 0) return { ok: false, reason: "sem_recurso" };

  const tz = assertValidTimezone(org.settings.timezone);
  const bookPolicy = settings.ai.book === "auto" && settings.ai.autoAck !== undefined ? "auto" : "propose";
  return { ok: true, org, tz, settings, agent, conversation, lead, contact, services, resources: activeResources, bookPolicy, canBook };
}

const ACCESS_MESSAGE: Record<SchedAiReason, string> = {
  org: "A agenda não está disponível.",
  modulo_desligado: "A agenda não está ligada neste negócio.",
  ia_desligada: "A agenda não está disponível para a IA.",
  agente: "A agenda não está disponível para este atendente.",
  sem_permissao: "A agenda não está disponível para este atendente.",
  conversa: "A agenda não está disponível nesta conversa.",
  grupo: "A agenda não está disponível em grupos.",
  sem_contato: "A agenda precisa do contato desta conversa.",
  nao_cliente: "A agenda não está disponível para este contato.",
  politica: "A IA não está autorizada a mexer na agenda neste negócio.",
  sem_servico: "Não há serviço liberado para marcação pela IA.",
  sem_recurso: "Não há sala ou profissional ativo na agenda.",
};

const accessError = (reason: SchedAiReason): SchedToolOutcome =>
  outcome(toolError("agenda_desligada", `${ACCESS_MESSAGE[reason]} Diga ao cliente que a equipe confirma os horários e, se ele quiser marcar, chame requestHandoff.`));

// ---------------------------------------------------------------------------
// Contexto do prompt
// ---------------------------------------------------------------------------

export type SchedRunContext = {
  tools: { find: boolean; book: boolean };
  book: "propose" | "auto";
  services: SchedPromptService[];
  moreServices: boolean;
  /** Próximos agendamentos ativos do contato (até 10; o prompt mostra 3). Alimentam o `schedClaimGuard` (E). */
  upcoming: SchedUpcoming[];
  /** Ofertas VIGENTES da conversa: já MOSTRADAS ao cliente (`shownAt`) e não vencidas. Só estes códigos valem. */
  offers: SchedCurrentOffer[];
  timezone: string;
  /** Nomes dos recursos ativos da org: SÓ para o `schedClaimGuard` (nunca entram no prompt nem no envelope). */
  guardNames: string[];
};

const UPCOMING_STATUSES = ["pending_approval", "scheduled", "confirmed"] as const;
const UPCOMING_PAGE_SIZE = 20;
const UPCOMING_PAGES = 5;
const UPCOMING_SHOWN = 10;

function priceLabel(cents: number | undefined, currency: string): string | undefined {
  if (cents === undefined || !Number.isFinite(cents) || cents < 0) return undefined;
  const value = (cents / 100).toFixed(2).split(".").join(",");
  return currency === "BRL" ? `R$ ${value}` : `${currency} ${value}`;
}

/**
 * Próximos agendamentos ativos do contato. O índice por contato não filtra status: lê em lotes de 20 por início
 * (até 5 lotes = 100 linhas) e para ao juntar `limit`; cancelados/remarcados no meio não escondem os seguintes.
 */
export async function loadUpcomingOfContact(
  ctx: ReadCtx,
  args: { organizationId: Id<"organizations">; contactId: Id<"contacts">; now: number; tz: string; limit?: number }
): Promise<SchedUpcoming[]> {
  const limit = args.limit ?? UPCOMING_SHOWN;
  const active: Doc<"schedAppointments">[] = [];
  const seen = new Set<string>();
  let from = args.now;
  let inclusive = true;
  for (let page = 0; page < UPCOMING_PAGES && active.length < limit; page++) {
    const rows = await ctx.db
      .query("schedAppointments")
      .withIndex("by_contact_and_start", (q) =>
        inclusive ? q.eq("contactId", args.contactId).gte("startTime", from) : q.eq("contactId", args.contactId).gt("startTime", from)
      )
      .take(UPCOMING_PAGE_SIZE);
    for (const r of rows) {
      if (seen.has(r._id)) continue;
      seen.add(r._id);
      if (r.organizationId === args.organizationId && (UPCOMING_STATUSES as readonly string[]).includes(r.status)) active.push(r);
    }
    if (rows.length < UPCOMING_PAGE_SIZE) break;
    from = rows[rows.length - 1].startTime;
    inclusive = false;
  }
  return active.slice(0, limit).map((r, i) => ({
    ref: `a${i + 1}`,
    label: formatSlotText(r.startTime, args.now, args.tz),
    startTime: r.startTime,
    serviceName: r.serviceName,
    status: r.status as SchedUpcoming["status"],
    // Nomes do retrato do agendamento: só o `schedClaimGuard` os lê (ligar "com o Léo" ao horário que de fato é com ele).
    resourceNames: r.resources.map((x) => x.name),
  }));
}

/** Contato da conversa 1:1 (sem exigir IA, serviço nem recurso): o guard de afirmação precisa dos agendamentos dele. */
async function contactOfConversation(
  ctx: ReadCtx,
  org: Doc<"organizations">,
  conversationId: Id<"conversations"> | undefined
): Promise<Doc<"contacts"> | null> {
  if (!conversationId) return null;
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.organizationId !== org._id || conversation.kind === "group") return null;
  const lead = await getLeadRef(ctx.db, conversation.leadId);
  if (!lead || lead.organizationId !== org._id || !lead.contactId) return null;
  const contact = await ctx.db.get(lead.contactId);
  return contact && contact.organizationId === org._id ? contact : null;
}

/**
 * `null` = módulo `scheduling` desligado (nada de agenda na run). Com o módulo ligado SEMPRE devolve o contexto: as
 * `tools` dizem se existem nesta run (mesmas condições do executor, `loadSchedAiAccess`), e `upcoming`/`offers` alimentam o
 * output guard (que fica LIGADO com o módulo, mesmo sem as tools) e o envelope do prompt.
 */
export async function schedContextCore(
  ctx: ReadCtx,
  args: { organizationId: Id<"organizations">; agentMemberId: Id<"teamMembers">; conversationId?: Id<"conversations">; now: number }
): Promise<SchedRunContext | null> {
  const org = await ctx.db.get(args.organizationId);
  if (!org || !modulesOf(org).scheduling) return null;
  const access = await loadSchedAiAccess(ctx, { ...args, need: "consult" });
  const contact = access.ok ? access.contact : await contactOfConversation(ctx, org, args.conversationId);
  let tz = "America/Sao_Paulo";
  try {
    tz = assertValidTimezone(org.settings.timezone);
  } catch {
    // fuso inválido: o guard e o prompt seguem no padrão do produto
  }
  const upcoming = contact ? await loadUpcomingOfContact(ctx, { organizationId: org._id, contactId: contact._id, now: args.now, tz }) : [];
  let offers: SchedCurrentOffer[] = [];
  if (access.ok && args.conversationId) {
    const state = await loadConversationState(ctx, args.conversationId);
    offers = currentOffers(offersStateOf(state), args.now).map((o) => ({
      code: o.code,
      label: formatSlotText(o.startTime, args.now, tz),
      startTime: o.startTime,
      ...(o.professional ? { professional: o.professional } : {}),
    }));
  }
  if (!access.ok) {
    return { tools: { find: false, book: false }, book: "propose", services: [], moreServices: false, upcoming, offers, timezone: tz, guardNames: [] };
  }
  const listed = access.services.slice(0, MAX_SERVICES_IN_PROMPT);
  const currency = org.settings.currency;
  return {
    tools: { find: true, book: access.canBook },
    book: access.bookPolicy,
    services: listed.map((sv) => ({ name: sv.name, durationMin: sv.durationMin, ...(priceLabel(sv.priceCents, currency) ? { priceLabel: priceLabel(sv.priceCents, currency) } : {}) })),
    moreServices: access.services.length > MAX_SERVICES_IN_PROMPT,
    upcoming,
    offers,
    timezone: access.tz,
    guardNames: access.resources.map((r) => r.name),
  };
}

// ---------------------------------------------------------------------------
// findAvailableTimes
// ---------------------------------------------------------------------------

export type FindSearchOutcome =
  | { kind: "error"; result: ToolText }
  | { kind: "none"; result: ToolText }
  | {
      kind: "slots";
      service: Doc<"schedServices">;
      args: FindArgs;
      echo: string;
      tz: string;
      now: number;
      /** Os horários a oferecer, na ordem (o pedido, quando livre, vem primeiro). */
      slots: Slot[];
      hasMore: boolean;
      /** Horários livres distintos na janela pedida. */
      total: number;
      /** Hora pedida: `available` = o primeiro de `slots` é o horário pedido. */
      wanted?: { timeMin: number; available: boolean };
      /** O que o servidor fez com o profissional/sala pedido (só com `args.professional`). */
      professional?: ProfessionalNote;
      /** Nome do recurso que TODAS as ofertas têm (filtro honrado); as ofertas e a reserva o fixam. */
      named?: string;
    };

/** Leitura pura da busca (serve ao executor e ao simulador): serviço, data, profissional, hora, `searchSlots` com audiência `ai`. */
export async function runFindSearch(
  ctx: ReadCtx,
  access: Extract<SchedAiAccess, { ok: true }>,
  args: FindArgs,
  now: number
): Promise<FindSearchOutcome> {
  const idPicked = ctx.db.normalizeId("schedServices", args.service);
  const byId = idPicked ? access.services.find((s) => s._id === idPicked) : undefined;
  const service =
    byId ??
    (() => {
      const m = matchService(
        access.services.map((s) => ({ id: s._id as string, name: s.name, durationMin: s.durationMin })),
        args.service
      );
      return m ? access.services.find((s) => s._id === m.id) : undefined;
    })();
  if (!service) {
    return {
      kind: "error",
      result: toolError(
        "servico_desconhecido",
        `Serviços disponíveis: ${serviceListText(access.services)}. Pergunte ao cliente qual deles ele quer e use o nome exato.`
      ),
    };
  }
  const maxAdvanceDays = service.maxAdvanceDays ?? access.settings.maxAdvanceDays;
  const when = resolveDateRef(args.dateRef, now, access.tz, { maxAdvanceDays });
  if (!when.ok) return { kind: "error", result: toolError("data_invalida", when.error) };
  const base = {
    organizationId: access.org._id,
    serviceId: service._id,
    fromLocalDate: when.from,
    toLocalDate: when.to,
    period: args.period,
    audience: "ai" as const,
    now,
    limit: 3,
    ...(args.people > 1 ? { partySize: args.people } : {}),
    ...(args.timeMin !== undefined ? { wantTimeMin: args.timeMin } : {}),
  };

  // Profissional/sala pedido: o SERVIDOR resolve o nome para um recurso ativo da org (nunca id vindo do modelo). Achou um só: a busca
  // filtra por ele e a oferta o nomeia. Ambíguo, desconhecido, que não faz o serviço ou sem horário: busca sem filtro e a resposta diz isso.
  let found: SearchSlotsResult;
  let professional: ProfessionalNote | undefined;
  let named: string | undefined;
  if (args.professional && args.people > 1) {
    professional = { kind: "ignored_group" };
    found = await searchSlots(ctx, base);
  } else if (args.professional) {
    const m = matchResource(access.resources.map((r) => ({ id: r._id as string, name: r.name })), args.professional);
    if (m.kind === "found") {
      const filtered = await searchSlots(ctx, { ...base, resourceIds: [m.resource.id as Id<"schedResources">] });
      if (filtered.slots.length > 0 || filtered.reason === "unverifiable") {
        found = filtered;
        professional = { kind: "filtered", name: m.resource.name };
        named = m.resource.name;
      } else {
        professional = filtered.reason === "no_matching_resource" ? { kind: "not_for_service", name: m.resource.name } : { kind: "not_available", name: m.resource.name };
        found = await searchSlots(ctx, base);
      }
    } else {
      professional = m.kind === "ambiguous" ? { kind: "ambiguous" } : { kind: "not_found" };
      found = await searchSlots(ctx, base);
    }
  } else {
    found = await searchSlots(ctx, base);
  }
  if (found.reason === "unverifiable" && found.slots.length === 0) {
    return {
      kind: "error",
      result: toolError(
        "agenda_indisponivel",
        "Não consegui verificar a agenda agora. Diga ao cliente que a equipe confirma o horário e chame requestHandoff."
      ),
    };
  }
  if (found.slots.length === 0) {
    const next = found.firstPossible ? formatDayLabel(found.firstPossible.startTime, now, access.tz) : undefined;
    return {
      kind: "none",
      result: noSlotsResult({
        echo: when.echo,
        period: args.period,
        people: args.people,
        nextDateLabel: next,
        ...(args.timeMin !== undefined ? { wanted: { timeMin: args.timeMin } } : {}),
        ...(professional ? { professional } : {}),
      }),
    };
  }
  // Hora pedida e livre: vem como PRIMEIRA oferta; senão as mais próximas dela (e a resposta diz que o pedido está indisponível).
  let slots = found.slots;
  let wanted: { timeMin: number; available: boolean } | undefined;
  if (found.wanted) {
    const hit = found.wanted.slot;
    wanted = { timeMin: found.wanted.timeMin, available: hit !== undefined };
    slots = hit ? [hit, ...found.slots.filter((x) => x.startTime !== hit.startTime)].slice(0, 3) : found.wanted.nearest.length > 0 ? found.wanted.nearest : found.slots;
  }
  return {
    kind: "slots",
    service,
    args,
    echo: when.echo,
    tz: access.tz,
    now,
    slots,
    hasMore: found.totalFree > slots.length,
    total: found.totalFree,
    ...(wanted ? { wanted } : {}),
    ...(professional ? { professional } : {}),
    ...(named ? { named } : {}),
  };
}

const picksOf = (service: Doc<"schedServices">, slots: readonly Slot[], people: number, professional?: string): OfferPick[] =>
  slots.map((s) => ({
    serviceId: service._id,
    startTime: s.startTime,
    resourceIds: s.resourceIds,
    ...(people > 1 ? { people } : {}),
    ...(professional ? { professional } : {}),
  }));

async function openHandoff(
  ctx: MutationCtx,
  access: Extract<SchedAiAccess, { ok: true }>,
  conversationId: Id<"conversations">,
  reason: string,
  summary: string
): Promise<boolean> {
  if (!access.lead) return false;
  await createHandoffCore(ctx, {
    leadId: access.lead._id,
    conversationId,
    fromMemberId: access.agent._id,
    reason,
    summary,
    suggestedActions: ["Conferir a agenda e responder o cliente sobre o horário"],
    origin: "ai_tool",
    onDuplicate: "skip",
  });
  return true;
}

export async function findAvailableTimesCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; agentMemberId: Id<"teamMembers">; conversationId: Id<"conversations">; argsJson: string }
): Promise<SchedToolOutcome> {
  const now = Date.now(); // a tool lê o relógio UMA vez
  const access = await loadSchedAiAccess(ctx, { ...args, need: "consult" });
  if (!access.ok) return accessError(access.reason);

  // Teto de consultas por conversa (modelo que entra em laço): estourou, repasse para humano.
  const state = await loadConversationState(ctx, args.conversationId);
  const prev = state?.findCalls;
  const windowStart = prev && now - prev.windowStart < FIND_WINDOW_MS ? prev.windowStart : now;
  const count = (windowStart === prev?.windowStart ? prev.count : 0) + 1;
  if (count > MAX_FIND_CALLS_PER_HOUR) {
    const handoff = await openHandoff(ctx, access, args.conversationId, "Muitas consultas de horário na conversa", "A IA consultou a agenda várias vezes sem fechar um horário. A equipe precisa assumir.");
    return outcome(
      toolError("limite_de_consultas", "Foram muitas consultas de horário nesta conversa. Diga ao cliente que a equipe vai ajudar com o horário; um repasse foi criado."),
      { handoff }
    );
  }
  await saveConversationState(ctx, {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    existing: state,
    patch: { findCalls: { windowStart, count } },
    now,
  });

  const parsed = parseFindArgs(args.argsJson);
  if (!parsed.ok) return outcome(toolError(parsed.error, parsed.proximo_passo));
  const searched = await runFindSearch(ctx, access, parsed.args, now);
  if (searched.kind !== "slots") return outcome(searched.result);

  const fresh = await loadConversationState(ctx, args.conversationId);
  const issued = issueOffers(offersStateOf(fresh), picksOf(searched.service, searched.slots, parsed.args.people, searched.named), now);
  await saveConversationState(ctx, {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    existing: fresh,
    patch: { offers: issued.state },
    now,
  });
  const lines = issued.issued.map((o) => formatOfferLine(o.code, o.startTime, now, searched.tz, o.professional));
  return outcome(
    findSlotsResult({
      echo: searched.echo,
      period: parsed.args.period,
      people: parsed.args.people,
      lines,
      hasMore: searched.hasMore,
      total: searched.total,
      ...(searched.wanted ? { wanted: searched.wanted } : {}),
      ...(searched.professional ? { professional: searched.professional } : {}),
    }),
    { offeredTimes: issued.issued.map((o) => o.startTime), ...namedOf(issued.issued) }
  );
}

// ---------------------------------------------------------------------------
// bookOfferedTime
// ---------------------------------------------------------------------------

const TAKEN_CODES = new Set([
  "CAPACITY_EXCEEDED",
  "RESOURCE_CLOSED",
  "OUTSIDE_HOURS",
  "RESOURCE_BLOCKED",
  "BUFFER_OVERLAP",
  "INTERNAL_EVENT_OVERLAP",
  "MIN_NOTICE",
  "MAX_ADVANCE",
  "OFF_GRID",
  "PAST_START",
]);
const ALREADY_HAS_CODES = new Set(["MAX_ACTIVE_PER_CONTACT", "CLIENT_OVERLAP"]);
const ACTIVE_BOOKED = ["pending_approval", "scheduled", "confirmed", "checked_in", "completed"] as const;

/** Chave de idempotência da reserva: conversa + código da oferta (o código nunca é reaproveitado na conversa). */
export const offerIdempotencyKey = (conversationId: string, code: string) => `ai:${conversationId}:${code}`;

const OFFER_ERROR_TEXT = {
  desconhecida: toolError(
    "oferta_desconhecida",
    "Esse código não é de uma oferta desta conversa. Consulte os horários de novo com findAvailableTimes e só reserve o que o cliente escolher."
  ),
  expirada: toolError(
    "oferta_expirada",
    "A oferta venceu (vale 30 minutos). Consulte os horários de novo, ofereça e peça a confirmação do cliente."
  ),
  sem_resposta_do_cliente: toolError(
    "aguarde_resposta_do_cliente",
    "O cliente ainda não respondeu a esta oferta. Apresente os horários, espere a escolha dele e só então reserve (em outra rodada)."
  ),
} as const;

export async function bookOfferedTimeCore(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    agentMemberId: Id<"teamMembers">;
    conversationId: Id<"conversations">;
    argsJson: string;
    /** `preview`: valida tudo e NÃO grava (rascunho do modo sugestão com a política `auto`). */
    mode: "commit" | "preview";
    approvedBy?: Id<"teamMembers">;
    agentRunId?: string;
    /** Relógio do chamador (a aprovação do rascunho lê UMA vez e passa adiante). */
    now?: number;
  }
): Promise<SchedToolOutcome> {
  const now = args.now ?? Date.now();
  const access = await loadSchedAiAccess(ctx, { ...args, need: "book" });
  if (!access.ok) return accessError(access.reason);
  const conversation = access.conversation!;
  const contact = access.contact!;

  const parsed = parseBookArgs(args.argsJson);
  if (!parsed.ok) return outcome(toolError(parsed.error, parsed.proximo_passo));
  const code = parsed.offer;

  // Retry da mesma reserva (o commit da resposta abortou e o turno rodou de novo): devolve o MESMO agendamento.
  const key = offerIdempotencyKey(args.conversationId, code);
  const existing = await ctx.db
    .query("schedAppointments")
    .withIndex("by_organization_and_idempotency", (q) => q.eq("organizationId", args.organizationId).eq("idempotencyKey", key))
    .first();
  if (existing && existing.conversationId === args.conversationId && (ACTIVE_BOOKED as readonly string[]).includes(existing.status)) {
    const slotText = formatSlotText(existing.startTime, now, access.tz);
    const kind = existing.status === "pending_approval" ? "pending" : "scheduled";
    return outcome(bookedResult(kind, slotText, true), { booked: kind, bookedStartTime: existing.startTime, offeredTimes: [existing.startTime] });
  }

  const state = await loadConversationState(ctx, args.conversationId);
  const offers = offersStateOf(state);
  const resolved = resolveOffer(offers, code, now, conversation.lastInboundAt);
  if (!resolved.ok) {
    // Retry de um GRUPO já reservado: a oferta foi consumida e o 1º agendamento do grupo guarda a chave com o sufixo `#0` da porta.
    if (resolved.error === "desconhecida") {
      const party = await ctx.db
        .query("schedAppointments")
        .withIndex("by_organization_and_idempotency", (q) => q.eq("organizationId", args.organizationId).eq("idempotencyKey", `${key}#0`))
        .first();
      if (party && party.conversationId === args.conversationId && (ACTIVE_BOOKED as readonly string[]).includes(party.status)) {
        const kind = party.status === "pending_approval" ? "pending" : "scheduled";
        return outcome(bookedResult(kind, formatSlotText(party.startTime, now, access.tz), true), { booked: kind, bookedStartTime: party.startTime, offeredTimes: [party.startTime] });
      }
    }
    return outcome(OFFER_ERROR_TEXT[resolved.error]);
  }
  const offer = resolved.offer;

  const people = offer.people ?? 1;
  const auditMetadata = {
    conversationId: args.conversationId,
    offer: code,
    ...(people > 1 ? { people } : {}),
    ...(args.agentRunId ? { agentRunId: args.agentRunId } : {}),
    ...(args.approvedBy ? { approvedBy: args.approvedBy } : {}),
  };
  const book = {
    organizationId: args.organizationId,
    actor: { type: "ai" as const, member: access.agent, conversationId: args.conversationId },
    origin: "ai" as const,
    serviceId: offer.serviceId as Id<"schedServices">,
    variantKey: offer.variantKey,
    startTime: offer.startTime,
    contactId: contact._id,
    leadId: access.lead?._id,
    conversationId: args.conversationId,
    resourceIds: offer.resourceIds as Id<"schedResources">[],
    idempotencyKey: key,
    auditMetadata,
    now,
  };

  // Grupo (2–4 pessoas): o tamanho vem da OFERTA (o servidor o guardou na busca; a IA não o informa na escrita). A porta de grupo
  // (`bookPartyCore`) aloca uma pessoa por vez, tudo ou nada, com a mesma checagem de capacidade; o grupo da IA SEMPRE fica
  // aguardando a equipe (nunca `scheduled`), e os acompanhantes entram com nome genérico (a IA não tem o nome de terceiros).
  let result: BookResult | { ok: true; party: true; duplicate: boolean } | BookFailure;
  if (people > 1 && args.mode === "commit") {
    const party = await bookPartyCore(ctx, {
      ...book,
      initialStatus: "pending_approval",
      companions: Array.from({ length: people - 1 }, (_, i) => ({ guestName: `Acompanhante ${i + 1}` })),
    });
    result = party.ok ? { ok: true, party: true, duplicate: party.duplicate } : party;
  } else {
    result = await bookAppointmentCore(ctx, {
      ...book,
      mode: args.mode,
      // Só `auto` com aceite pede `scheduled`; a porta ainda recusa (vira pending) em primeira visita ou com aviso. Grupo: sempre a equipe.
      initialStatus: people === 1 && access.bookPolicy === "auto" ? "scheduled" : "pending_approval",
      // Reserva = o plano da OFERTA: o recurso que a busca mostrou (e, se nomeado, que o cliente pediu) não é trocado em silêncio;
      // se ele foi tomado, é "horário tomado" com alternativas, não outro profissional. Grupo só marca a pessoa principal na prévia.
      ...(people === 1 && offer.resourceIds.length > 0 ? { allowResourceFallback: false } : {}),
    });
  }

  if (result.ok) {
    const professionalLabel = offer.professional;
    if ("preview" in result) {
      const slotText = formatSlotText(offer.startTime, now, access.tz);
      return outcome(proposedResult(slotText, { people, professional: professionalLabel }), { slotText, offeredTimes: [offer.startTime], ...namedOf([{ startTime: offer.startTime, professional: professionalLabel }]) });
    }
    const slotText = formatSlotText(offer.startTime, now, access.tz);
    const kind = "party" in result || result.status === "pending_approval" ? "pending" : "scheduled";
    await saveConversationState(ctx, {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      existing: state,
      // Reserva fechada: o contador de "horário tomado" recomeça (o repasse é para quem perdeu 2 horários SEGUIDOS).
      patch: { offers: consumeOffer(offers, code), slotTakenCount: 0 },
      now,
    });
    return outcome(bookedResult(kind, slotText, result.duplicate, { people, professional: professionalLabel }), {
      booked: kind,
      bookedStartTime: offer.startTime,
      offeredTimes: [offer.startTime],
      ...namedOf([{ startTime: offer.startTime, professional: professionalLabel }]),
    });
  }

  const codes = new Set(result.violations.map((x) => x.code as string));
  if (codes.has("AI_DAILY_LIMIT")) {
    const handoff = await openHandoff(ctx, access, args.conversationId, "Limite diário de marcações da IA", "A IA atingiu o limite diário de marcações para este cliente. A equipe precisa conferir.");
    return outcome(
      toolError("precisa_de_pessoa", "O limite de marcações da IA para este cliente hoje foi atingido: um repasse foi criado. Diga ao cliente que a equipe confirma."),
      { handoff }
    );
  }
  if ([...codes].some((c) => ALREADY_HAS_CODES.has(c))) {
    const upcoming = await loadUpcomingOfContact(ctx, { organizationId: args.organizationId, contactId: contact._id, now, tz: access.tz });
    const list = upcoming.map((u) => `${u.label} (${u.serviceName})`).join("; ");
    return outcome(
      toolError(
        "ja_tem_marcado",
        `Este cliente já tem horário${list ? `: ${list}` : " ativo nesse período"}. Não reserve outro; se ele quer trocar, chame requestHandoff para a equipe remarcar.`
      ),
      { offeredTimes: upcoming.map((u) => u.startTime) }
    );
  }
  if ([...codes].some((c) => TAKEN_CODES.has(c))) {
    return await slotTaken(ctx, { access, args, state, offers, code, offer, alternatives: result.alternatives, now });
  }
  const handoff = await openHandoff(ctx, access, args.conversationId, "Reserva de horário não concluída", "A IA não conseguiu registrar o horário escolhido pelo cliente. A equipe precisa conferir.");
  return outcome(
    toolError("precisa_de_pessoa", "Não foi possível registrar este horário: um repasse foi criado. Diga ao cliente que a equipe confirma."),
    { handoff }
  );
}

/** `horario_tomado`: invalida as ofertas antigas, reemite até 2 das alternativas e conta (no 2º, repasse). */
async function slotTaken(
  ctx: MutationCtx,
  input: {
    access: Extract<SchedAiAccess, { ok: true }>;
    args: { organizationId: Id<"organizations">; conversationId: Id<"conversations"> };
    state: Doc<"schedConversationState"> | null;
    offers: ReturnType<typeof offersStateOf>;
    code: string;
    offer: OfferRecord;
    alternatives: Alternative[];
    now: number;
  }
): Promise<SchedToolOutcome> {
  const { access, args, offer, now } = input;
  // Grupo: as alternativas da porta são de UMA pessoa; para o grupo a IA consulta de novo (`findAvailableTimes` com people).
  const group = (offer.people ?? 1) > 1;
  const picks: OfferPick[] = group ? [] : input.alternatives.slice(0, 2).map((s) => ({ serviceId: offer.serviceId, variantKey: offer.variantKey, startTime: s.startTime, resourceIds: s.resourceIds }));
  const cleared = invalidateOffers(input.offers);
  const next = picks.length > 0 ? issueOffers(cleared, picks, now) : { state: cleared, issued: [] as OfferRecord[] };
  const takenCount = (input.state?.slotTakenCount ?? 0) + 1;
  await saveConversationState(ctx, {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    existing: input.state,
    patch: { offers: next.state, slotTakenCount: takenCount },
    now,
  });
  const lines = next.issued.map((o) => formatOfferLine(o.code, o.startTime, now, access.tz));
  if (takenCount >= 2) {
    const handoff = await openHandoff(ctx, access, args.conversationId, "Horário tomado duas vezes na conversa", "Dois horários escolhidos pelo cliente foram tomados antes da reserva. A equipe precisa assumir.");
    return outcome(
      toolError("horario_tomado", "Esse horário acabou de ser ocupado, e já foi a segunda vez nesta conversa: um repasse foi criado. Diga ao cliente que a equipe vai ajudar a escolher o horário."),
      { handoff }
    );
  }
  const alt =
    lines.length > 0
      ? `Alternativas livres (os códigos antigos deixaram de valer):\n${lines.join("\n")}`
      : group
        ? `Não há alternativa livre para o grupo de ${offer.people} pessoas neste horário.`
        : "Não há alternativas livres no mesmo dia.";
  return outcome(
    {
      status: "erro",
      error: "horario_tomado",
      resultado: alt,
      proximo_passo:
        lines.length > 0
          ? `Diga que esse horário acabou de ser ocupado, ofereça as alternativas (sem o código) e espere o cliente escolher; só então reserve.${offer.professional ? ` Estas alternativas NÃO são com ${offer.professional}: diga que a equipe confirma quem atende.` : ""}`
          : group
            ? `Diga que esse horário acabou de ser ocupado e consulte outro dia com findAvailableTimes (people: ${offer.people}).`
            : "Diga que esse horário acabou de ser ocupado e consulte outra data com findAvailableTimes.",
    },
    { offeredTimes: next.issued.map((o) => o.startTime) }
  );
}

// ---------------------------------------------------------------------------
// Validators de retorno das internas (o convex-test não valida `returns`: ver os testes)
// ---------------------------------------------------------------------------

export const professionalNoteValidator = v.union(
  v.object({ kind: v.literal("filtered"), name: v.string() }),
  v.object({ kind: v.literal("not_found") }),
  v.object({ kind: v.literal("ambiguous") }),
  v.object({ kind: v.literal("not_available"), name: v.string() }),
  v.object({ kind: v.literal("not_for_service"), name: v.string() }),
  v.object({ kind: v.literal("ignored_group"), name: v.optional(v.string()) })
);
export const toolTextValidator = v.object({
  status: v.string(),
  resultado: v.optional(v.string()),
  error: v.optional(v.string()),
  proximo_passo: v.optional(v.string()),
  ha_mais: v.optional(v.union(v.literal("sim"), v.literal("nao"))),
});
export const schedToolOutcomeValidator = v.object({
  result: toolTextValidator,
  control: v.object({
    offeredTimes: v.array(v.number()),
    booked: v.optional(v.union(v.literal("pending"), v.literal("scheduled"))),
    bookedStartTime: v.optional(v.number()),
    handoff: v.boolean(),
    slotText: v.optional(v.string()),
    named: v.optional(v.array(v.object({ startTime: v.number(), professional: v.string() }))),
  }),
});
export const schedContextValidator = v.union(
  v.null(),
  v.object({
    tools: v.object({ find: v.boolean(), book: v.boolean() }),
    book: v.union(v.literal("propose"), v.literal("auto")),
    services: v.array(v.object({ name: v.string(), durationMin: v.number(), priceLabel: v.optional(v.string()) })),
    moreServices: v.boolean(),
    upcoming: v.array(
      v.object({
        ref: v.string(),
        label: v.string(),
        startTime: v.number(),
        serviceName: v.string(),
        status: v.union(v.literal("pending_approval"), v.literal("scheduled"), v.literal("confirmed")),
        resourceNames: v.optional(v.array(v.string())),
      })
    ),
    offers: v.array(v.object({ code: v.string(), label: v.string(), startTime: v.number(), professional: v.optional(v.string()) })),
    timezone: v.string(),
    guardNames: v.array(v.string()),
  })
);
