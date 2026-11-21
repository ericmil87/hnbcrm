/**
 * Agenda v2 (C1) — interpretar a confirmação que o HUMANO manda pelo WhatsApp ("Ok, confirmado quinta 10h") e marcar
 * ou PROPOR o agendamento. Falso positivo (criar um agendamento que não existe) é o erro grave: na dúvida, só PROPÕE.
 *
 * REGRA PARA CRIAR SOZINHO (plano §8.1; faltando qualquer uma, vira proposta de 1 toque para a equipe):
 *  1. parser: `act = confirmou`, `level = completo`, `form = explicito`, dia e hora tirados DA PRÓPRIA mensagem;
 *  2. classificador LLM (schema fechado, validado no servidor) concorda em ato, dia e hora (só com IA ligada na org);
 *  3. há proposta ABERTA com o mesmo dia e a mesma hora (< 48 h): mensagem do cliente, oferta da IA ou mensagem
 *     anterior do humano (`matchesProposal`, comparação determinística). Resposta curta ("ok", "👍") nunca cria:
 *     só vira proposta de 1 toque, já preenchida pela proposta do CLIENTE (a forma não é `explicito`);
 *  4. serviço inequívoco: citado, único serviço ativo ou "serviço padrão".
 *
 * FLUXO: gancho (custo zero no caminho comum) → `internalStart` (mutation: lê o contexto mínimo, roda o parser,
 * decide o que dá para decidir sem LLM) → [`internalClassify` (action, só se TUDO o mais passou)] → `internalDecide`
 * (mutation: cria pela porta, aprova o pendente ou grava a proposta).
 *
 * LGPD: `schedInterpretations` NUNCA guarda texto de mensagem (só ids, ato, dia/hora, flags e o código do motivo).
 * Nenhuma mensagem automática sai para o cliente por causa disto: aviso e Desfazer só para a equipe.
 *
 * Este arquivo escreve em `schedInterpretations`/`schedConversationState`; por isso NÃO cita a tabela
 * `schedAppointments` (guard `schedulingPort.test.ts`: leituras vão por `schedRead`, escritas pelas portas).
 */
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { spendBlockedNow } from "../aiSpend";
import { orgAiActive } from "./agentSecurity";
import { isMembershipRevoked } from "./auth";
import { isOffBusiness, type ContactRelation } from "./contactRelation";
import { createNotification } from "./notify";
import { notificationCopy } from "./notificationCopy";
import { resolveEntityNotifications } from "./notificationResolve";
import { modulesOf } from "./orgModules";
import { hasPermission, type Permissions, resolvePermissions, type Role } from "./permissions";
import { outboundBlockedFor } from "./readOnly";
import {
  CONFIRM_MAX_CHARS,
  type ConfirmServiceRef,
  extractDateTimeMentions,
  parseConfirmation,
  type ParsedConfirmation,
  prefilterConfirmation,
} from "./schedConfirmParser";
import {
  type AppointmentDoc,
  bookAppointmentCore,
  cancelAppointmentCore,
  loadAppointmentOfOrg,
  rescheduleAppointmentCore,
  setAppointmentStatusCore,
  throwSchedRules,
  undoHumanConfirmBookingCore,
} from "./schedBookingOps";
import {
  buildClassifierPrompt,
  buildDayEnum,
  classifierHistory,
  collectProposals,
  findMatchingProposal,
  hasCorrectionWords,
  isWeakReply,
  looksLikeCorrection,
  prepClientText,
  INTERPRET_CONTEXT_MESSAGES,
  INTERPRET_MAX_AGE_MS,
  llmAgrees,
  type LlmVerdict,
  type MessageLite,
  type ProposalCandidate,
  resolveServiceForConversation,
  SUGGESTION_TTL_MS,
  textOfMessage,
  CLASSIFIER_DAY_ENUM,
} from "./schedInterpretPure";
import { readContactAppointmentsFrom } from "./schedRead";
import { resolveSchedSettings, type ResolvedSchedSettings } from "./schedSettingsDefaults";
import { ACTIVE_STATUSES } from "./schedStatus";
import { atLocalMinutes, assertValidTimezone, diffLocalDays, formatLocalDateLabel, isValidLocalDate, localDateOf } from "./schedTime";

const MINUTE_MS = 60_000;
/** Rede de segurança: se a segunda leitura não voltar, a mensagem vira proposta (sem LLM). */
export const CLASSIFY_WATCHDOG_MS = 3 * MINUTE_MS;
const MAX_NOTIFY_RECIPIENTS = 25;
const SERVICES_CAP = 100;
const SUGGESTION_SWEEP = 10;

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

// ---------------------------------------------------------------------------
// Gancho (custo zero no caminho comum)
// ---------------------------------------------------------------------------

export type InterpretHookArgs = {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  messageId: Id<"messages">;
  content: string;
  contentType?: "text" | "image" | "file" | "audio";
  /** Quando a mensagem foi enviada (carimbo do WhatsApp para a do aparelho; relógio do servidor para a do app). */
  sentAt: number;
  now: number;
  isInternal?: boolean;
  /** Remetente é IA (membro de IA): nunca interpreta. */
  senderIsAi?: boolean;
  isGroup?: boolean;
  /** Espelho `conversations.contactRelation`: contato "não é cliente" nunca é interpretado. */
  contactRelation?: ContactRelation | null;
  /** A importação de histórico usa o mesmo ingest do aparelho: ignorada. */
  importedFromHistory?: boolean;
};

/**
 * Chamado depois do insert de TODA mensagem outbound de HUMANO em conversa 1:1 (envio pelo app e mensagem digitada no
 * celular que o bridge ingere). Sequência barata e SEM leitura de banco até o pré-filtro: texto, 1:1, ≤ 600 caracteres,
 * enviada há ≤ 10 min, contato comercial → `prefilterConfirmation` (puro) OU resposta curta ("ok", "👍") OU palavra de
 * correção ("ops", "na verdade": só olha se houve marcação/sugestão há pouco, o início confere) → só então lê a org (módulo
 * ligado, modo leitura) e a configuração (interpretação ≠ desligada) → agenda `internalStart`. Com módulo ou interpretação
 * desligados e pré-filtro positivo ficam 1 a 2 leituras (a org e a configuração): custo aceito, documentado.
 *
 * À PROVA DE FALHA: qualquer exceção aqui (agendador, leitura) é registrada e engolida. O gancho roda dentro da mutation
 * que grava a mensagem; se ele lançasse, o envio cairia (no ingest do celular o bridge reentregaria em laço).
 */
export async function maybeScheduleConfirmationInterpretation(ctx: MutationCtx, args: InterpretHookArgs): Promise<boolean> {
  try {
    return await scheduleInterpretationIfWorthIt(ctx, args);
  } catch (e) {
    console.error("[schedInterpret] gancho falhou (a mensagem segue):", e instanceof Error ? e.message : "erro desconhecido");
    return false;
  }
}

async function scheduleInterpretationIfWorthIt(ctx: MutationCtx, args: InterpretHookArgs): Promise<boolean> {
  if (args.isInternal || args.senderIsAi || args.isGroup || args.importedFromHistory === true) return false;
  if (args.contentType === "audio") return false;
  const text = args.content ?? "";
  if (text.trim().length === 0 || text.length > CONFIRM_MAX_CHARS) return false;
  if (args.now - args.sentAt > INTERPRET_MAX_AGE_MS) return false;
  if (args.contactRelation && isOffBusiness(args.contactRelation)) return false;
  if (!prefilterConfirmation(text).pass && !isWeakReply(text) && !looksLikeCorrection(text)) return false;
  const org = await ctx.db.get(args.organizationId);
  if (!org || !modulesOf(org).scheduling) return false;
  if (outboundBlockedFor(org, args.now)) return false;
  const settings = await loadSettings(ctx, args.organizationId);
  if (settings.humanConfirm.mode === "off") return false;
  await ctx.scheduler.runAfter(0, internal.schedulingInterpret.internalStart, { messageId: args.messageId });
  return true;
}

async function loadSettings(ctx: { db: QueryCtx["db"] }, organizationId: Id<"organizations">): Promise<ResolvedSchedSettings> {
  const doc = await ctx.db
    .query("schedSettings")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .first();
  return resolveSchedSettings(doc);
}

/**
 * Mensagem editada ou apagada no aparelho. Proposta ainda ABERTA: só é descartada (agendamento já criado não é tocado; o
 * Desfazer é da equipe). Linha ainda `pending` (segunda leitura em curso): a decisão usaria o texto antigo, então a linha
 * é APAGADA e, se foi edição, a interpretação é refeita com o texto novo (`internalStart` de novo). Uma leitura indexada,
 * só para mensagem do humano.
 */
export async function dismissOpenInterpretationOfMessage(
  ctx: MutationCtx,
  message: Pick<Doc<"messages">, "_id" | "organizationId" | "direction">,
  opts: { edited?: boolean } = {}
): Promise<boolean> {
  if (message.direction !== "outbound") return false;
  const row = await ctx.db
    .query("schedInterpretations")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .first();
  if (!row || row.organizationId !== message.organizationId) return false;
  if (row.status === "pending") {
    await ctx.db.delete(row._id);
    if (opts.edited) await ctx.scheduler.runAfter(0, internal.schedulingInterpret.internalStart, { messageId: message._id });
    return true;
  }
  if (row.status !== "open") return false;
  await ctx.db.patch(row._id, { status: "dismissed", outcome: "dismissed", reason: "mensagem_alterada" });
  return true;
}

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------

type Case = {
  now: number;
  org: Doc<"organizations">;
  tz: string;
  settings: ResolvedSchedSettings;
  message: Doc<"messages">;
  conversation: Doc<"conversations">;
  lead: Doc<"leads">;
  contact: Doc<"contacts"> | null;
  /** Serviços ATIVOS da org. */
  services: Doc<"schedServices">[];
};

type GateOutcome = { ok: true; c: Case } | { ok: false; reason: string };

/** Carrega e confere tudo que a interpretação precisa; `fresh` aplica a regra dos 10 minutos (só no início). */
async function loadCase(ctx: MutationCtx, messageId: Id<"messages">, opts: { fresh: boolean }): Promise<GateOutcome> {
  const now = Date.now();
  const message = await ctx.db.get(messageId);
  if (!message) return { ok: false, reason: "mensagem_inexistente" };
  const fromHuman =
    message.direction === "outbound" &&
    message.senderType === "human" &&
    !message.isInternal &&
    message.metadata?.revoked !== true &&
    message.metadata?.importedFromHistory !== true &&
    (message.metadata?.via === undefined || message.metadata?.via === "device") &&
    message.contentType !== "audio";
  if (!fromHuman) return { ok: false, reason: "nao_e_do_humano" };
  const text = message.content ?? "";
  if (text.trim().length === 0 || text.length > CONFIRM_MAX_CHARS) return { ok: false, reason: "texto_invalido" };
  if (opts.fresh && now - message.createdAt > INTERPRET_MAX_AGE_MS) return { ok: false, reason: "mensagem_antiga" };
  const conversation = await ctx.db.get(message.conversationId);
  if (!conversation || conversation.organizationId !== message.organizationId) return { ok: false, reason: "conversa_inexistente" };
  if (conversation.kind === "group" || !conversation.leadId) return { ok: false, reason: "nao_e_1_a_1" };
  const lead = await ctx.db.get(conversation.leadId);
  if (!lead || lead.organizationId !== message.organizationId) return { ok: false, reason: "lead_inexistente" };
  const contact = lead.contactId ? await ctx.db.get(lead.contactId) : null;
  if (contact && contact.organizationId !== message.organizationId) return { ok: false, reason: "contato_de_outra_org" };
  if (isOffBusiness(contact?.relation) || isOffBusiness(conversation.contactRelation)) return { ok: false, reason: "fora_do_comercial" };
  const org = await ctx.db.get(message.organizationId);
  if (!org || !modulesOf(org).scheduling) return { ok: false, reason: "modulo_desligado" };
  if (outboundBlockedFor(org, now)) return { ok: false, reason: "modo_leitura" };
  let tz: string;
  try {
    tz = assertValidTimezone(org.settings.timezone);
  } catch {
    return { ok: false, reason: "fuso_invalido" };
  }
  const settings = await loadSettings(ctx, org._id);
  if (settings.humanConfirm.mode === "off") return { ok: false, reason: "interpretacao_desligada" };
  const services = (
    await ctx.db
      .query("schedServices")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(SERVICES_CAP)
  ).filter((s) => s.active);
  return { ok: true, c: { now, org, tz, settings, message, conversation, lead, contact, services } };
}

function contactName(contact: Doc<"contacts"> | null): string | undefined {
  if (!contact) return undefined;
  const name = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.replace(/\s+/g, " ").trim();
  return name.length > 0 ? name : undefined;
}

/** "qui, 27/11 às 10:00" (dia e/ou hora que existirem). */
function whenLabelOf(date?: string, min?: number): string | undefined {
  const day = date ? formatLocalDateLabel(date).slice(0, -5) : undefined;
  const time = min !== undefined ? `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}` : undefined;
  if (day && time) return `${day} às ${time}`;
  if (day) return day;
  if (time) return `às ${time}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Escrita da linha de interpretação (nunca com texto de mensagem)
// ---------------------------------------------------------------------------

type Parsed = { localDate?: string; timeMin?: number; serviceId?: Id<"schedServices"> };
type Checks = { parser: boolean; llm?: boolean; agree?: boolean; proposal?: boolean; service?: boolean };
type RowFinal = {
  act: string;
  parsed: Parsed;
  checks: Checks;
  decision: Doc<"schedInterpretations">["decision"];
  status: Doc<"schedInterpretations">["status"];
  appointmentId?: AppointmentDoc["_id"];
  reason?: string;
};

async function writeRow(ctx: MutationCtx, c: Case, existing: Doc<"schedInterpretations"> | null, row: RowFinal): Promise<Id<"schedInterpretations">> {
  if (existing) {
    await ctx.db.patch(existing._id, {
      act: row.act,
      parsed: compact({ ...row.parsed }),
      checks: compact({ ...row.checks }),
      decision: row.decision,
      status: row.status,
      appointmentId: row.appointmentId,
      reason: row.reason,
    });
    return existing._id;
  }
  return await ctx.db.insert(
    "schedInterpretations",
    compact({
      organizationId: c.org._id,
      conversationId: c.conversation._id,
      messageId: c.message._id,
      act: row.act,
      parsed: compact({ ...row.parsed }),
      checks: compact({ ...row.checks }),
      decision: row.decision,
      status: row.status,
      appointmentId: row.appointmentId,
      reason: row.reason,
      createdAt: c.now,
    })
  );
}

/** Proposta de 1 toque nova: as abertas mais velhas do MESMO ato na conversa envelhecem (a equipe vê só a atual). */
async function supersedeOlderOpen(ctx: MutationCtx, c: Case, act: string, keep: Id<"schedInterpretations">): Promise<void> {
  const open = await ctx.db
    .query("schedInterpretations")
    .withIndex("by_conversation_and_status", (q) => q.eq("conversationId", c.conversation._id).eq("status", "open"))
    .take(SUGGESTION_SWEEP);
  for (const r of open) {
    if (r._id !== keep && r.act === act && r.organizationId === c.org._id) await ctx.db.patch(r._id, { status: "expired", reason: "substituida" });
  }
}

/**
 * Quem recebe o aviso: remetente (mensagem do app) e responsável do lead, com `agenda >= edit`. A mensagem do CELULAR não
 * tem remetente: sem responsável do lead, avisa só quem tem `agenda: manage` (admins), nunca 25 pessoas com push.
 */
async function recipientsOf(ctx: MutationCtx, c: Case): Promise<Doc<"teamMembers">[]> {
  const human = (m: Doc<"teamMembers">) => m.organizationId === c.org._id && m.type === "human" && !isMembershipRevoked(m) && !!m.userId;
  const level = (m: Doc<"teamMembers">, l: "edit" | "manage") =>
    hasPermission(resolvePermissions(m.role as Role, m.permissions as Permissions | undefined), "agenda", l);
  const direct: Doc<"teamMembers">[] = [];
  for (const id of [c.message.senderId, c.lead.assignedTo]) {
    if (!id || direct.some((m) => m._id === id)) continue;
    const m = await ctx.db.get(id);
    if (m && human(m) && level(m, "edit")) direct.push(m);
  }
  if (direct.length > 0) return direct.slice(0, MAX_NOTIFY_RECIPIENTS);
  const humans = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", c.org._id).eq("type", "human"))
    .take(200);
  return humans.filter((m) => human(m) && level(m, "manage")).slice(0, MAX_NOTIFY_RECIPIENTS);
}

function whenLabelOfStart(startTime: number, tz: string): string {
  const date = localDateOf(startTime, tz);
  const min = Math.round((startTime - atLocalMinutes(date, 0, tz)) / MINUTE_MS);
  return whenLabelOf(date, min) ?? "o horário";
}

async function notifyCreated(
  ctx: MutationCtx,
  c: Case,
  p: { interpretationId: Id<"schedInterpretations">; appointmentId: AppointmentDoc["_id"]; startTime: number; inConflict: boolean; approved?: boolean }
): Promise<void> {
  const whenLabel = whenLabelOfStart(p.startTime, c.tz);
  for (const m of await recipientsOf(ctx, c)) {
    await createNotification(ctx, {
      organizationId: c.org._id,
      memberId: m._id,
      type: "appointment_created",
      ...notificationCopy({ type: "appointment_created", contactName: contactName(c.contact), whenLabel, inConflict: p.inConflict, approved: p.approved }),
      conversationId: c.conversation._id,
      data: { appointmentId: p.appointmentId, interpretationId: p.interpretationId, source: "human_message", inConflict: p.inConflict, ...(p.approved ? { approved: true } : {}) },
    });
  }
}

type SuggestKind = "confirmou" | "remarcou" | "cancelou" | "aprovar" | "substituir" | "correcao";

async function notifySuggestion(
  ctx: MutationCtx,
  c: Case,
  p: { interpretationId: Id<"schedInterpretations">; act: string; parsed: Parsed; reason?: string; fromStart?: number }
): Promise<void> {
  const kind: SuggestKind =
    p.reason === "aprovar_pendente" ? "aprovar" : p.reason === "substituir_pendente" ? "substituir" : p.reason === "correcao" ? "correcao" : p.act === "remarcou" ? "remarcou" : p.act === "cancelou" ? "cancelou" : "confirmou";
  for (const m of await recipientsOf(ctx, c)) {
    await createNotification(ctx, {
      organizationId: c.org._id,
      memberId: m._id,
      type: "appointment_suggestion",
      ...notificationCopy({
        type: "appointment_suggestion",
        kind,
        contactName: contactName(c.contact),
        whenLabel: whenLabelOf(p.parsed.localDate, p.parsed.timeMin),
        ...(p.fromStart !== undefined ? { fromLabel: whenLabelOfStart(p.fromStart, c.tz) } : {}),
      }),
      conversationId: c.conversation._id,
      data: { interpretationId: p.interpretationId, source: "human_message", act: p.act, ...(p.reason ? { reason: p.reason } : {}) },
    });
  }
}

/** Grava (ou atualiza) a PROPOSTA de 1 toque e avisa a equipe. */
async function propose(
  ctx: MutationCtx,
  c: Case,
  existing: Doc<"schedInterpretations"> | null,
  p: { act: string; parsed: Parsed; checks: Checks; reason: string; appointmentId?: AppointmentDoc["_id"]; fromStart?: number }
): Promise<Id<"schedInterpretations">> {
  const { fromStart, ...rowPart } = p;
  const id = await writeRow(ctx, c, existing, { ...rowPart, decision: "proposed", status: "open" });
  await supersedeOlderOpen(ctx, c, p.act, id);
  await notifySuggestion(ctx, c, { interpretationId: id, act: p.act, parsed: p.parsed, reason: p.reason, fromStart });
  return id;
}

/** `propos`: guarda a proposta do humano na conversa (48 h); a resposta do cliente é reavaliada como confirmação. */
async function recordHumanProposal(ctx: MutationCtx, c: Case, parsed: Parsed): Promise<void> {
  const state = await ctx.db
    .query("schedConversationState")
    .withIndex("by_conversation", (q) => q.eq("conversationId", c.conversation._id))
    .first();
  const proposal = compact({
    localDate: parsed.localDate,
    timeMin: parsed.timeMin,
    serviceId: parsed.serviceId,
    fromMessageId: c.message._id,
    at: c.message.createdAt,
    expiresAt: c.message.createdAt + SUGGESTION_TTL_MS,
  });
  if (state && state.organizationId === c.org._id) {
    await ctx.db.patch(state._id, { proposal, updatedAt: c.now });
    return;
  }
  await ctx.db.insert("schedConversationState", {
    organizationId: c.org._id,
    conversationId: c.conversation._id,
    offerSeq: 0,
    offers: [],
    proposal,
    updatedAt: c.now,
  });
}

// ---------------------------------------------------------------------------
// internalStart: contexto mínimo → parser → o que dá para decidir sem LLM
// ---------------------------------------------------------------------------

export type StartResult = { status: "skipped" | "duplicate" | "final" | "pending"; reason?: string };

type Plan =
  | { kind: "final"; row: RowFinal }
  | { kind: "propose"; act: string; parsed: Parsed; checks: Checks; reason: string; appointmentId?: AppointmentDoc["_id"]; fromStart?: number }
  | { kind: "llm"; row: RowFinal };

/** "Já marcado" (nada novo). O pendente de aprovação NÃO entra: a confirmação do humano pode aprová-lo. */
const ALREADY_BOOKED = ACTIVE_STATUSES.filter((x) => x !== "pending_approval") as readonly string[];
const BOOKED = ["pending_approval", "scheduled", "confirmed"] as const;
/** Correção do humano logo depois de uma marcação/sugestão desta via. */
const CORRECTION_WINDOW_MS = 30 * MINUTE_MS;

const localMinutesOf = (ms: number, tz: string): number => Math.round((ms - atLocalMinutes(localDateOf(ms, tz), 0, tz)) / MINUTE_MS);

/** A marcação/sugestão mais recente DESTA via na conversa, nos últimos 30 min (para a correção "ops, terça 10h"). */
async function findRecentInterpretation(ctx: MutationCtx, c: Case): Promise<Doc<"schedInterpretations"> | null> {
  const rows = await ctx.db
    .query("schedInterpretations")
    .withIndex("by_organization_and_created", (q) => q.eq("organizationId", c.org._id).gte("createdAt", c.now - CORRECTION_WINDOW_MS))
    .order("desc")
    .take(30);
  return (
    rows.find(
      (r) =>
        r.conversationId === c.conversation._id &&
        r.messageId !== c.message._id &&
        (r.decision === "created" || r.decision === "approved_existing" || (r.decision === "proposed" && r.status === "open"))
    ) ?? null
  );
}

/**
 * Correção logo depois ("Ops, segunda não, terça 10h", "Corrigindo: confirmado terça 10h"): cita OUTRO dia ou hora, ou nega o
 * anterior. NUNCA age sozinha: vira sugestão de REMARCAR apontando para o agendamento criado, ou substitui a sugestão aberta.
 */
async function planCorrection(ctx: MutationCtx, c: Case, recent: Doc<"schedInterpretations">): Promise<Plan | null> {
  const text = c.message.content;
  const rp = recent.parsed as Parsed;
  const mentions = extractDateTimeMentions(text, { now: c.message.createdAt, tz: c.tz });
  const repeats = mentions.some((m) => m.localDate === rp.localDate && m.timeMin === rp.timeMin && m.localDate !== undefined);
  if (repeats) return null;
  const differs = mentions.filter((m) => (m.localDate !== undefined && m.localDate !== rp.localDate) || (m.timeMin !== undefined && m.timeMin !== rp.timeMin));
  const pick = differs.find((m) => m.localDate !== undefined && m.timeMin !== undefined) ?? differs[0];
  if (!pick && !hasCorrectionWords(text)) return null;
  const parsed: Parsed = compact({ localDate: pick?.localDate, timeMin: pick?.timeMin, serviceId: rp.serviceId });
  if (recent.decision === "created" || recent.decision === "approved_existing") {
    return { kind: "propose", act: "remarcou", parsed, checks: { parser: false }, reason: "correcao", appointmentId: recent.appointmentId };
  }
  // Sugestão ainda aberta: a nova leitura a substitui (quando há horário novo).
  if (!pick) return null;
  await ctx.db.patch(recent._id, { status: "expired", reason: "corrigida" });
  return { kind: "propose", act: recent.act, parsed, checks: { parser: false }, reason: "correcao", appointmentId: recent.appointmentId };
}

export async function startInterpretation(ctx: MutationCtx, messageId: Id<"messages">): Promise<StartResult> {
  const existing = await ctx.db
    .query("schedInterpretations")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .first();
  if (existing) return { status: "duplicate" };
  const gate = await loadCase(ctx, messageId, { fresh: true });
  if (!gate.ok) return { status: "skipped", reason: gate.reason };
  const c = gate.c;
  if (c.services.length === 0) return { status: "skipped", reason: "sem_servico" };

  const text = c.message.content;
  const passes = prefilterConfirmation(text).pass;
  const weak = isWeakReply(text);
  if (!passes && !weak && !looksLikeCorrection(text)) return { status: "skipped", reason: "pre_filtro" };
  // Sem marcação/sugestão desta via há pouco, uma mensagem que só parece correção não tem o que corrigir: nem lê o resto.
  const recent = await findRecentInterpretation(ctx, c);
  if (!passes && !weak && !recent) return { status: "skipped", reason: "sem_correcao" };

  const messages = (
    await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", c.conversation._id))
      .order("desc")
      .take(INTERPRET_CONTEXT_MESSAGES)
  ).filter((m) => !m.isInternal);
  const state = await ctx.db
    .query("schedConversationState")
    .withIndex("by_conversation", (q) => q.eq("conversationId", c.conversation._id))
    .first();
  const owned = state && state.organizationId === c.org._id ? state : null;
  const lite: MessageLite[] = messages.map((m) => ({
    _id: m._id, direction: m.direction, senderType: m.senderType, isInternal: m.isInternal, contentType: m.contentType,
    content: m.content, transcriptText: m.transcriptText, metadata: m.metadata, createdAt: m.createdAt,
  }));
  const collection = collectProposals({
    messages: lite,
    currentId: c.message._id,
    currentAt: c.message.createdAt,
    offers: (owned?.offers ?? []).map((o) => ({ startTime: o.startTime, serviceId: o.serviceId, issuedAt: o.issuedAt })),
    stored: owned?.proposal ? { localDate: owned.proposal.localDate, timeMin: owned.proposal.timeMin, serviceId: owned.proposal.serviceId, at: owned.proposal.at } : undefined,
    now: c.now,
    tz: c.tz,
  });
  // "ok", "sim", "👍": só interessam com uma proposta clara do cliente logo antes; senão nem linha se grava.
  if (!passes && !recent && collection.lastClient === undefined) return { status: "skipped", reason: "sem_proposta" };
  const refs: Array<ConfirmServiceRef<string>> = c.services.map((s) => ({ _id: s._id, name: s.name }));
  const parsed = parseConfirmation<string>(text, { now: c.message.createdAt, tz: c.tz, services: refs, proposal: collection.lastClient });
  // Correção do que ESTA via fez há pouco (remarcar/cancelar têm o fluxo próprio; confirmação IGUAL à anterior não é correção).
  if (recent && parsed.act !== "remarcou" && parsed.act !== "cancelou") {
    const correction = await planCorrection(ctx, c, recent);
    if (correction?.kind === "propose") {
      await propose(ctx, c, null, correction);
      return { status: "final", reason: correction.reason };
    }
  }
  if (!passes && !weak) return { status: "skipped", reason: "sem_correcao" };
  const plan = await planInterpretation(ctx, c, parsed, collection, lite);

  switch (plan.kind) {
    case "final":
      await writeRow(ctx, c, null, plan.row);
      return { status: "final", reason: plan.row.reason };
    case "propose":
      await propose(ctx, c, null, plan);
      return { status: "final", reason: plan.reason };
    case "llm": {
      await writeRow(ctx, c, null, plan.row);
      await ctx.scheduler.runAfter(0, internal.schedulingInterpret.internalClassify, { messageId });
      // Rede de segurança: se a segunda leitura não voltar, a mensagem vira proposta (nunca fica "pendente" para sempre).
      await ctx.scheduler.runAfter(CLASSIFY_WATCHDOG_MS, internal.schedulingInterpret.internalDecide, { messageId, llm: { status: "unavailable" } });
      return { status: "pending" };
    }
  }
}

async function aiAvailable(ctx: MutationCtx, c: Case): Promise<boolean> {
  return orgAiActive(c.org) && !(await spendBlockedNow(ctx, c.org, c.now));
}

function parsedOf(p: ParsedConfirmation<string>, serviceId?: string): Parsed {
  return compact({ localDate: p.localDate, timeMin: p.timeMin, serviceId: serviceId as Id<"schedServices"> | undefined });
}

async function planInterpretation(
  ctx: MutationCtx,
  c: Case,
  p: ParsedConfirmation<string>,
  collection: ReturnType<typeof collectProposals>,
  lite: ReadonlyArray<MessageLite>
): Promise<Plan> {
  const base: Checks = { parser: p.act === "confirmou" && p.level === "completo" && p.form === "explicito" };
  const ignored = (reason: string, parsed: Parsed = {}): Plan => ({
    kind: "final",
    row: { act: p.act, parsed, checks: base, decision: "ignored", status: "done", reason },
  });

  if (p.act === "nenhum" || p.act === "informativo") return ignored(p.act);

  if (p.act === "propos") {
    if (p.localDate === undefined && p.timeMin === undefined) return ignored("sem_dia_ou_hora");
    const parsed = parsedOf(p, p.serviceId);
    await recordHumanProposal(ctx, c, parsed);
    return { kind: "final", row: { act: "propos", parsed, checks: base, decision: "proposal_saved", status: "done" } };
  }

  const contactId = c.contact?._id;

  if (p.act === "remarcou" || p.act === "cancelou") {
    const actives = await readContactAppointmentsFrom(ctx, c.org._id, contactId, c.now, BOOKED, 20);
    if (actives.length === 0) return ignored("sem_agendamento");
    const target = actives.length === 1 ? actives[0] : undefined;
    return {
      kind: "propose",
      act: p.act,
      parsed: parsedOf(p, target ? target.serviceId : undefined),
      checks: base,
      reason: "ato_nao_automatico",
      appointmentId: target?._id,
    };
  }

  // ── confirmou
  const hasDate = p.localDate !== undefined;
  const hasTime = p.timeMin !== undefined;
  const startTime = hasDate && hasTime ? atLocalMinutes(p.localDate!, p.timeMin!, c.tz) : undefined;
  if (startTime !== undefined && startTime <= c.now) return ignored("horario_passado");
  const pastWord = p.negatives.includes("horario_passado") || p.negatives.includes("data_passada");

  // Já marcado para esse horário: nada novo (idempotente).
  if (startTime !== undefined) {
    const same = (await readContactAppointmentsFrom(ctx, c.org._id, contactId, startTime, ALREADY_BOOKED, 20)).find((a) => a.startTime === startTime);
    if (same) {
      return { kind: "final", row: { act: "confirmou", parsed: parsedOf(p, same.serviceId), checks: base, decision: "confirmed_existing", status: "done", appointmentId: same._id } };
    }
  }

  const auto = c.settings.humanConfirm.mode === "auto";
  const aiOn = auto ? await aiAvailable(ctx, c) : false;

  // Pedidos pendentes de aprovação do contato (da IA ou do link). Aprovar pela mensagem SÓ com dia E hora da própria mensagem
  // iguais aos do pendente (modo auto, IA concordando). Sem dia/hora, ou em outro horário: sugestão, nunca ato.
  const pendings = (await readContactAppointmentsFrom(ctx, c.org._id, contactId, c.now, ["pending_approval"], 20)).filter((a) => a.rescheduleOfId === undefined);
  if (pendings.length > 0) {
    const pendParsed = (a: (typeof pendings)[number]): Parsed => ({ localDate: localDateOf(a.startTime, c.tz), timeMin: localMinutesOf(a.startTime, c.tz), serviceId: a.serviceId });
    const explicitBoth = p.fromMessage.localDate !== undefined && p.fromMessage.timeMin !== undefined;
    const sameTime = startTime !== undefined ? pendings.find((a) => a.startTime === startTime) : undefined;
    if (sameTime) {
      if (auto && aiOn && explicitBoth && p.level === "completo" && p.form === "explicito") {
        return { kind: "llm", row: { act: "confirmou", parsed: pendParsed(sameTime), checks: { ...base, proposal: true, service: true }, decision: "pending", status: "pending", appointmentId: sameTime._id } };
      }
      return { kind: "propose", act: "confirmou", parsed: pendParsed(sameTime), checks: base, reason: "aprovar_pendente", appointmentId: sameTime._id };
    }
    if (!hasDate && !hasTime && pendings.length === 1) {
      return { kind: "propose", act: "confirmou", parsed: pendParsed(pendings[0]), checks: base, reason: "aprovar_pendente", appointmentId: pendings[0]._id };
    }
    if (startTime !== undefined) {
      // O contato já pediu OUTRO horário: não cria um segundo; pergunta se é para substituir o pedido.
      const only = pendings.length === 1 ? pendings[0] : undefined;
      return {
        kind: "propose",
        act: "remarcou",
        parsed: parsedOf(p, only?.serviceId ?? p.serviceId),
        checks: base,
        reason: "substituir_pendente",
        appointmentId: only?._id,
        fromStart: only?.startTime,
      };
    }
  }

  const parsed = parsedOf(p, p.serviceId);
  // Sem dia nem hora não há o que sugerir ("ok, confirmado" sobre qualquer coisa).
  if (!hasDate && !hasTime) return ignored("sem_dia_ou_hora");

  const strictFind = findMatchingProposal(p, collection, c.now, true);
  const looseFind = strictFind.match ? strictFind : findMatchingProposal(p, collection, c.now, false);
  const matched: ProposalCandidate | undefined = strictFind.match;
  const service = resolveServiceForConversation({
    activeServices: c.services.map((s) => ({ _id: s._id, name: s.name })),
    parserServiceId: p.serviceId,
    parserAmbiguous: p.negatives.includes("servico_ambiguo"),
    proposalServiceId: (matched ?? looseFind.match)?.serviceId,
    conversationTexts: lite.filter((m) => c.now - m.createdAt < SUGGESTION_TTL_MS).map((m) => textOfMessage(m)).filter((t) => t.length > 0),
    defaultServiceId: c.settings.humanConfirm.defaultServiceId,
  });
  const checks: Checks = { ...base, proposal: matched !== undefined, service: service.ok };
  const withService: Parsed = compact({ ...parsed, serviceId: (service.serviceId ?? parsed.serviceId) as Id<"schedServices"> | undefined });
  const suggest = (reason: string): Plan => ({ kind: "propose", act: "confirmou", parsed: withService, checks, reason });

  if (!auto) return suggest(pastWord ? "horario_passado" : "modo_sugerir");
  if (pastWord && (!hasDate || !hasTime)) return suggest("horario_passado");
  if (!base.parser) {
    if (p.form === "resposta_curta") return suggest("resposta_curta");
    if (!(p.fromMessage.localDate !== undefined && p.fromMessage.timeMin !== undefined)) return suggest("sem_dia_ou_hora");
    return suggest("leitura_incompleta");
  }
  if (matched === undefined) {
    if (looseFind.match) return suggest("proposta_sem_intencao");
    return suggest(strictFind.reason === "sem_proposta" ? "sem_proposta" : "sem_proposta_coincidente");
  }
  if (!service.ok) return suggest(service.reason);
  if (p.negatives.includes("data_distante")) return suggest("data_distante");
  const daysAhead = diffLocalDays(localDateOf(c.now, c.tz), p.localDate!);
  if (daysAhead < 0 || daysAhead >= CLASSIFIER_DAY_ENUM) return suggest("data_distante");
  if (!aiOn) return suggest("sem_ia");
  return { kind: "llm", row: { act: "confirmou", parsed: withService, checks, decision: "pending", status: "pending" } };
}

// ---------------------------------------------------------------------------
// Contexto da segunda leitura (query interna lê isto; a action monta o pedido)
// ---------------------------------------------------------------------------

export type ClassifierContext =
  | { ok: false }
  | {
      ok: true;
      organizationId: Id<"organizations">;
      conversationId: Id<"conversations">;
      messageId: Id<"messages">;
      tz: string;
      providerConfig: unknown;
      prompt: { system: string; user: string };
      messageText: string;
      days: Array<{ date: string }>;
      services: Array<{ _id: string; name: string }>;
    };

export async function loadClassifierContext(ctx: QueryCtx, messageId: Id<"messages">, now: number): Promise<ClassifierContext> {
  const row = await ctx.db
    .query("schedInterpretations")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .first();
  if (!row || row.status !== "pending") return { ok: false };
  const message = await ctx.db.get(messageId);
  const org = await ctx.db.get(row.organizationId);
  if (!message || !org || message.organizationId !== org._id || !orgAiActive(org)) return { ok: false };
  const tz = assertValidTimezone(org.settings.timezone);
  const services = (
    await ctx.db
      .query("schedServices")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(SERVICES_CAP)
  ).filter((s) => s.active);
  const messages = (
    await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", message.conversationId))
      .order("desc")
      .take(INTERPRET_CONTEXT_MESSAGES)
  ).filter((m) => !m.isInternal);
  const lite: MessageLite[] = messages.map((m) => ({
    _id: m._id, direction: m.direction, senderType: m.senderType, isInternal: m.isInternal, contentType: m.contentType,
    content: m.content, transcriptText: m.transcriptText, metadata: m.metadata, createdAt: m.createdAt,
  }));
  const days = buildDayEnum(message.createdAt, tz);
  const prompt = buildClassifierPrompt({
    now,
    tz,
    messageText: message.content,
    history: classifierHistory(lite, message._id, message.createdAt, now),
    days,
    serviceNames: services.map((s) => s.name),
  });
  return {
    ok: true,
    organizationId: org._id,
    conversationId: message.conversationId,
    messageId,
    tz,
    providerConfig: org.settings.aiConfig?.providerConfig ?? null,
    prompt,
    messageText: message.content,
    days: days.map((d) => ({ date: d.date })),
    services: services.map((s) => ({ _id: s._id, name: s.name })),
  };
}

// ---------------------------------------------------------------------------
// internalDecide: cria pela porta, aprova o pendente ou grava a proposta
// ---------------------------------------------------------------------------

export type DecideResult = { decision: Doc<"schedInterpretations">["decision"] | "noop"; reason?: string; appointmentId?: AppointmentDoc["_id"] };

const LLM_REASON: Record<Exclude<LlmVerdict["status"], "ok">, string> = {
  unavailable: "ia_indisponivel",
  invalid: "ia_resposta_invalida",
  bad_evidence: "ia_evidencia_invalida",
};

export async function decideInterpretation(ctx: MutationCtx, messageId: Id<"messages">, llm: LlmVerdict | undefined): Promise<DecideResult> {
  const row = await ctx.db
    .query("schedInterpretations")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .first();
  if (!row || row.status !== "pending") return { decision: "noop" };
  const gate = await loadCase(ctx, messageId, { fresh: false });
  if (!gate.ok) {
    await ctx.db.patch(row._id, { decision: "ignored", status: "done", reason: gate.reason });
    return { decision: "ignored", reason: gate.reason };
  }
  const c = gate.c;
  // Editada depois de a linha nascer: a leitura é do texto ANTIGO. Descarta (a edição pelo aparelho já refaz com o texto novo).
  const editedAt = typeof c.message.metadata?.editedAt === "number" ? c.message.metadata.editedAt : undefined;
  if (c.message.metadata?.edited === true && (editedAt === undefined || editedAt >= row.createdAt)) {
    await ctx.db.patch(row._id, { decision: "ignored", status: "done", reason: "mensagem_alterada" });
    return { decision: "ignored", reason: "mensagem_alterada" };
  }
  const verdict: LlmVerdict = llm ?? { status: "unavailable" };
  const parsed = row.parsed as Parsed;
  const approveId = row.appointmentId;
  const hasWhen = parsed.localDate !== undefined || parsed.timeMin !== undefined;
  const agree = llmAgrees(verdict, { localDate: parsed.localDate, timeMin: parsed.timeMin, serviceId: parsed.serviceId, checkService: approveId === undefined });
  const checks: Checks = { ...row.checks, llm: verdict.status === "ok", agree };
  const act = row.act;

  const fallback = async (reason: string): Promise<DecideResult> => {
    if (!hasWhen) {
      await writeRow(ctx, c, row, { act, parsed, checks, decision: "ignored", status: "done", reason });
      return { decision: "ignored", reason };
    }
    await propose(ctx, c, row, { act, parsed, checks, reason });
    return { decision: "proposed", reason };
  };

  if (c.settings.humanConfirm.mode !== "auto") return await fallback("modo_sugerir");
  if (!agree) return await fallback(verdict.status === "ok" ? "ia_divergente" : LLM_REASON[verdict.status]);

  // Aprovar o pendente (a IA ou o link propuseram; o humano confirmou).
  if (approveId) {
    try {
      await ctx.runMutation(internal.schedulingMutations.internalSetAppointmentStatus, {
        organizationId: c.org._id,
        appointmentId: approveId,
        actor: { type: "system", via: "human_message" },
        to: "scheduled",
      });
    } catch {
      return await fallback("nao_foi_possivel_aprovar");
    }
    await writeRow(ctx, c, row, { act, parsed, checks, decision: "approved_existing", status: "done", appointmentId: approveId });
    // Toda aprovação automática avisa a equipe (e é desfazível: volta a `pending_approval`).
    if (parsed.localDate !== undefined && parsed.timeMin !== undefined) {
      await notifyCreated(ctx, c, { interpretationId: row._id, appointmentId: approveId, startTime: atLocalMinutes(parsed.localDate, parsed.timeMin, c.tz), inConflict: false, approved: true });
    }
    return { decision: "approved_existing", appointmentId: approveId };
  }

  // Criar pela porta (sub-transação: se algo lançar, nada fica pela metade e a mensagem vira proposta).
  if (parsed.serviceId === undefined || parsed.localDate === undefined || parsed.timeMin === undefined) return await fallback("leitura_incompleta");
  const startTime = atLocalMinutes(parsed.localDate, parsed.timeMin, c.tz);
  let result: BookViaPortResult;
  try {
    result = await bookViaPort(ctx, c, { serviceId: parsed.serviceId, startTime });
  } catch {
    return await fallback("erro_ao_marcar");
  }
  if (!result.ok) {
    return await fallback(`regra:${result.violations[0]?.code ?? "desconhecida"}`);
  }
  const appointmentId = result.appointmentId!;
  if (!result.created) {
    // Já existia (idempotência ou o contato já tinha esse horário): nada novo.
    await writeRow(ctx, c, row, { act, parsed, checks, decision: "confirmed_existing", status: "done", appointmentId });
    return { decision: "confirmed_existing", appointmentId };
  }
  await writeRow(ctx, c, row, { act, parsed, checks, decision: "created", status: "done", appointmentId });
  await notifyCreated(ctx, c, { interpretationId: row._id, appointmentId, startTime, inConflict: result.inConflict });
  return { decision: "created", appointmentId };
}

type BookViaPortResult = {
  ok: boolean;
  created: boolean;
  duplicate: boolean;
  inConflict: boolean;
  appointmentId?: AppointmentDoc["_id"];
  violations: Array<{ code: string }>;
};

async function bookViaPort(ctx: MutationCtx, c: Case, p: { serviceId: Id<"schedServices">; startTime: number }): Promise<BookViaPortResult> {
  return await ctx.runMutation(internal.schedulingMutations.internalBookAppointment, {
    organizationId: c.org._id,
    serviceId: p.serviceId,
    startTime: p.startTime,
    contactId: c.contact?._id,
    leadId: c.lead._id,
    conversationId: c.conversation._id,
    actor: { type: "system", via: "human_message" },
    origin: "human_message",
    initialStatus: "scheduled",
    conflictToQueue: true,
    idempotencyKey: `hm:${c.message._id}`,
    sourceMessageId: c.message._id,
  });
}

// ---------------------------------------------------------------------------
// Equipe: aceitar/recusar a sugestão e desfazer a criação automática
// ---------------------------------------------------------------------------

export type SuggestionEdits = { localDate?: string; timeMin?: number; serviceId?: Id<"schedServices">; appointmentId?: AppointmentDoc["_id"] };

async function resolveRowNotifications(ctx: MutationCtx, row: Doc<"schedInterpretations">, types: Array<"appointment_suggestion" | "appointment_created">, member: Doc<"teamMembers">, reason: string): Promise<void> {
  await resolveEntityNotifications(ctx, {
    organizationId: row.organizationId,
    target: { conversationId: row.conversationId },
    resolvedByMemberId: member._id,
    reason,
    types,
    scanLimit: 50,
  });
}

async function auditInterpretation(
  ctx: MutationCtx,
  row: Doc<"schedInterpretations">,
  member: Doc<"teamMembers">,
  p: { description: string; metadata: Record<string, unknown>; now: number }
): Promise<void> {
  await ctx.db.insert("auditLogs", {
    organizationId: row.organizationId,
    entityType: "schedInterpretation",
    entityId: row._id,
    action: "update",
    actorId: member._id,
    actorType: "human",
    // Sem texto de mensagem: ids, ato, códigos.
    metadata: { via: "app", messageId: row.messageId, conversationId: row.conversationId, act: row.act, ...p.metadata },
    description: p.description,
    severity: "low",
    createdAt: p.now,
  });
}

async function loadOpenSuggestion(ctx: MutationCtx, organizationId: Id<"organizations">, id: Id<"schedInterpretations">): Promise<Doc<"schedInterpretations">> {
  const row = await ctx.db.get(id);
  // Inexistente e de outra org dão a MESMA resposta.
  if (!row || row.organizationId !== organizationId) throw new ConvexError("Sugestão não encontrada");
  if (row.decision !== "proposed" || row.status !== "open") throw new ConvexError("Esta sugestão já foi respondida ou não vale mais.");
  return row;
}

export async function dismissSuggestionCore(ctx: MutationCtx, args: { organizationId: Id<"organizations">; interpretationId: Id<"schedInterpretations">; member: Doc<"teamMembers">; now: number }): Promise<void> {
  const row = await loadOpenSuggestion(ctx, args.organizationId, args.interpretationId);
  await ctx.db.patch(row._id, { status: "dismissed", outcome: "dismissed", answeredBy: args.member._id, answeredAt: args.now });
  await auditInterpretation(ctx, row, args.member, { description: "Ignorou a sugestão de marcar horário", metadata: { accepted: false }, now: args.now });
  await resolveRowNotifications(ctx, row, ["appointment_suggestion"], args.member, "interpretation_answered");
}

export async function acceptSuggestionCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; interpretationId: Id<"schedInterpretations">; member: Doc<"teamMembers">; edits?: SuggestionEdits; force?: string[]; now: number }
): Promise<{ appointmentId?: AppointmentDoc["_id"] }> {
  const row = await loadOpenSuggestion(ctx, args.organizationId, args.interpretationId);
  if (args.now - row.createdAt > SUGGESTION_TTL_MS) throw new ConvexError("Esta sugestão venceu (48 h). Marque pela Agenda.");
  const conversation = await ctx.db.get(row.conversationId);
  const lead = conversation?.leadId ? await ctx.db.get(conversation.leadId) : null;
  if (!conversation || conversation.organizationId !== args.organizationId || !lead || lead.organizationId !== args.organizationId) {
    throw new ConvexError("Conversa não encontrada");
  }
  const contact = lead.contactId ? await ctx.db.get(lead.contactId) : null;
  if (contact && contact.organizationId !== args.organizationId) throw new ConvexError("Contato não encontrado");
  const e = args.edits ?? {};
  if (e.localDate !== undefined && !isValidLocalDate(e.localDate)) throw new ConvexError("Data inválida.");
  if (e.timeMin !== undefined && (!Number.isInteger(e.timeMin) || e.timeMin < 0 || e.timeMin > 1439)) throw new ConvexError("Hora inválida.");
  const parsed = row.parsed as Parsed;
  const localDate = e.localDate ?? parsed.localDate;
  const timeMin = e.timeMin ?? parsed.timeMin;
  const serviceId = e.serviceId ?? parsed.serviceId;
  const org = await ctx.db.get(args.organizationId);
  if (!org) throw new ConvexError("Organização não encontrada");
  const tz = assertValidTimezone(org.settings.timezone);
  const actor = { type: "human" as const, member: args.member, via: "app" as const };
  const edited =
    (e.localDate !== undefined && e.localDate !== parsed.localDate) ||
    (e.timeMin !== undefined && e.timeMin !== parsed.timeMin) ||
    (e.serviceId !== undefined && e.serviceId !== parsed.serviceId) ||
    (e.appointmentId !== undefined && e.appointmentId !== row.appointmentId);

  let appointmentId: AppointmentDoc["_id"] | undefined;
  if (row.act === "cancelou" || row.act === "remarcou") {
    const targetId = e.appointmentId ?? row.appointmentId;
    const target = targetId ? await loadAppointmentOfOrg(ctx, args.organizationId, targetId) : null;
    if (!target) throw new ConvexError("Escolha qual agendamento do cliente aplicar.");
    if (target.contactId !== lead.contactId) throw new ConvexError("Esse agendamento não é deste cliente.");
    if (row.act === "cancelou") {
      await cancelAppointmentCore(ctx, { appointment: target, actor, byClass: "staff", now: args.now });
      appointmentId = target._id;
    } else {
      if (localDate === undefined || timeMin === undefined) throw new ConvexError("Informe o novo dia e a nova hora.");
      const res = await rescheduleAppointmentCore(ctx, {
        appointment: target, actor, startTime: atLocalMinutes(localDate, timeMin, tz), force: args.force, idempotencyKey: `hmr:${row._id}`, now: args.now,
      });
      if (!res.ok) throwSchedRules(res.violations, res.alternatives);
      if ("preview" in res) throw new ConvexError("Resposta inesperada da prévia.");
      appointmentId = res.appointmentId;
    }
  } else {
    if (localDate === undefined || timeMin === undefined || serviceId === undefined) throw new ConvexError("Informe o dia, a hora e o serviço.");
    const service = await ctx.db.get(serviceId);
    if (!service || service.organizationId !== args.organizationId || !service.active) throw new ConvexError("Serviço não encontrado");
    const startTime = atLocalMinutes(localDate, timeMin, tz);
    // Já existe um pendente de aprovação desse contato nesse horário: a confirmação do humano o aprova.
    const pend = (await readContactAppointmentsFrom(ctx, args.organizationId, contact?._id, startTime, ["pending_approval"], 10)).find((a) => a.startTime === startTime && a.rescheduleOfId === undefined);
    if (pend) {
      await setAppointmentStatusCore(ctx, { appointment: pend, actor, to: "scheduled", now: args.now });
      appointmentId = pend._id;
    } else {
      const res = await bookAppointmentCore(ctx, {
        organizationId: args.organizationId,
        actor,
        origin: "staff",
        serviceId,
        startTime,
        contactId: contact?._id,
        leadId: lead._id,
        conversationId: conversation._id,
        initialStatus: "scheduled",
        force: args.force,
        sourceMessageId: row.messageId,
        idempotencyKey: `hms:${row._id}`,
        now: args.now,
      });
      if (!res.ok) throwSchedRules(res.violations, res.alternatives);
      if ("preview" in res) throw new ConvexError("Resposta inesperada da prévia.");
      appointmentId = res.appointmentId;
    }
  }
  await ctx.db.patch(row._id, compact({ status: "accepted" as const, outcome: edited ? ("edited" as const) : ("accepted" as const), appointmentId, answeredBy: args.member._id, answeredAt: args.now }));
  await auditInterpretation(ctx, row, args.member, { description: "Aceitou a sugestão de marcar horário", metadata: { accepted: true, edited, appointmentId }, now: args.now });
  await resolveRowNotifications(ctx, row, ["appointment_suggestion"], args.member, "interpretation_answered");
  return { appointmentId };
}

/** Desfazer a criação (ou a aprovação) automática (porta própria, 24 h) e marcar a interpretação como `undone`. */
export async function undoHumanConfirmCore(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; appointmentId: AppointmentDoc["_id"]; member: Doc<"teamMembers">; now: number }
): Promise<{ appointmentId: AppointmentDoc["_id"]; kind: "created" | "approved" }> {
  const res = await undoHumanConfirmBookingCore(ctx, { organizationId: args.organizationId, appointmentId: args.appointmentId, actor: { type: "human", member: args.member, via: "app" }, now: args.now });
  let row: Doc<"schedInterpretations"> | null = null;
  if (res.sourceMessageId) {
    row = await ctx.db
      .query("schedInterpretations")
      .withIndex("by_message", (q) => q.eq("messageId", res.sourceMessageId!))
      .first();
  } else {
    // Aprovação: o agendamento não guarda a mensagem; acha a linha `approved_existing` recente que aponta para ele.
    const recent = await ctx.db
      .query("schedInterpretations")
      .withIndex("by_organization_and_created", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(200);
    row = recent.find((r) => r.decision === "approved_existing" && r.appointmentId === res.appointmentId && r.outcome === undefined) ?? null;
  }
  if (row && row.organizationId === args.organizationId) {
    await ctx.db.patch(row._id, { outcome: "undone", answeredBy: args.member._id, answeredAt: args.now });
    await resolveRowNotifications(ctx, row, ["appointment_created"], args.member, "undone");
  }
  return { appointmentId: res.appointmentId, kind: res.kind };
}

// ---------------------------------------------------------------------------
// Leituras para a tela e para a medição
// ---------------------------------------------------------------------------

/** Sugestões ABERTAS (e ainda dentro das 48 h) da conversa, da mais nova para a mais antiga. */
export async function listOpenSuggestionsOfConversation(
  ctx: { db: QueryCtx["db"] },
  p: { organizationId: Id<"organizations">; conversationId: Id<"conversations">; now: number }
): Promise<Array<Doc<"schedInterpretations">>> {
  const rows = await ctx.db
    .query("schedInterpretations")
    .withIndex("by_conversation_and_status", (q) => q.eq("conversationId", p.conversationId).eq("status", "open"))
    .order("desc")
    .take(20);
  return rows.filter((r) => r.organizationId === p.organizationId && r.decision === "proposed" && p.now - r.createdAt < SUGGESTION_TTL_MS);
}

/** Taxa de "desfeito" da org (para a tela sugerir "Só sugerir"): criadas sozinhas × desfeitas, nas últimas `limit` linhas. */
export async function undoRateOfOrg(
  ctx: { db: QueryCtx["db"] },
  p: { organizationId: Id<"organizations">; limit: number }
): Promise<{ created: number; undone: number; rate: number | null; suggested: number; accepted: number; dismissed: number; sample: number }> {
  const rows = await ctx.db
    .query("schedInterpretations")
    .withIndex("by_organization_and_created", (q) => q.eq("organizationId", p.organizationId))
    .order("desc")
    .take(Math.max(1, Math.min(p.limit, 1000)));
  let created = 0;
  let undone = 0;
  let suggested = 0;
  let accepted = 0;
  let dismissed = 0;
  for (const r of rows) {
    if (r.decision === "created") {
      created++;
      if (r.outcome === "undone") undone++;
    } else if (r.decision === "proposed") {
      suggested++;
      if (r.outcome === "accepted" || r.outcome === "edited") accepted++;
      if (r.outcome === "dismissed") dismissed++;
    }
  }
  return { created, undone, rate: created > 0 ? undone / created : null, suggested, accepted, dismissed, sample: rows.length };
}
