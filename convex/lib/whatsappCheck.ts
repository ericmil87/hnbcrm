/**
 * Marcador "este número não tem WhatsApp" (`contacts.whatsappCheck`) e as
 * regras que dependem dele. Porta ÚNICA: ninguém escreve `whatsappCheck` nem
 * decide bloqueio por ele fora daqui.
 *
 * Semântica:
 * - O marcador guarda o número a que se refere (`phone`, só dígitos). Só vale
 *   enquanto o número ATUAL do contato (`whatsappNumber ?? phone`) for igual:
 *   editar o número invalida SEM precisar limpar (a comparação falha).
 *   Mensagem recebida do contato limpa de vez (`clearWhatsappCheck`).
 * - Quem fecha a porta para envio AUTOMÁTICO é o dispatch
 *   (`whatsapp.dispatchMessage`): IA, follow-up, agendadas, boas-vindas e
 *   campanha caem todas lá, então um único gate cobre os cinco. A mensagem só
 *   passa com `metadata.notOnWhatsappAck` (aceite humano explícito e auditado).
 * - Envio MANUAL (inbox, encaminhar, REST/MCP) NÃO é travado: "avisar, não
 *   travar" — recusa com `NOT_ON_WHATSAPP:` salvo `notOnWhatsappAck: true`, e o
 *   uso do aceite grava auditoria (espelha o `optOutAck` da Nova conversa).
 */
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { getLeadRef } from "./leadRef";
import { resolveConversationChannelConfig } from "./channelResolve";
import { configProvider } from "../channelConfigs";
import { normalizeCampaignPhone, phoneLookupCandidates } from "./phone";
import { isPhoneSuppressed } from "./campaignAudience";
import { buildSearchText } from "./searchText";

/** Prefixo estável que a UI usa para abrir o aceite (como `OPT_OUT:`). */
export const NOT_ON_WHATSAPP_SEND_PREFIX = "NOT_ON_WHATSAPP:";
export const NOT_ON_WHATSAPP_SEND_ERROR =
  "Este número não está no WhatsApp (verificado pelo gateway). A mensagem provavelmente não será entregue. Confirme que quer enviar mesmo assim.";

export const NOT_FOUND_SEND_ERROR =
  "As últimas mensagens para este número falharam porque o WhatsApp não o encontrou. A mensagem provavelmente não será entregue. Confirme que quer enviar mesmo assim.";
/** Aceite (envio a número sem WhatsApp, reenvio de mensagem possivelmente entregue) só de uma PESSOA. */
export const HUMAN_ACK_REQUIRED_ERROR =
  "Somente uma pessoa pode confirmar este envio — a IA e chaves de API de membros de IA não podem dar esse aceite";

/** "Verificado" vale por 30 dias; depois a boas-vindas pergunta de novo ao gateway. */
export const VERIFIED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type WhatsappCheck = NonNullable<Doc<"contacts">["whatsappCheck"]>;

export const digitsOf = (raw: string | undefined | null): string => (raw ?? "").replace(/\D+/g, "");

/** Número que o dispatch usa para o contato (só dígitos), ou "" se não houver. */
export function currentSendDigits(contact: Pick<Doc<"contacts">, "phone" | "whatsappNumber">): string {
  return digitsOf(contact.whatsappNumber ?? contact.phone);
}

/**
 * O contato está marcado "sem WhatsApp" PARA O NÚMERO para o qual se vai enviar?
 * `not_on_whatsapp` vale para QUALQUER grafia BR do número (a checagem pergunta as
 * duas de uma vez: se nenhuma existe, trocar o 9º dígito não muda nada). `verified`
 * continua exato (ver `isRecentlyVerified`).
 */
export function isMarkedNotOnWhatsapp(
  contact: Pick<Doc<"contacts">, "phone" | "whatsappNumber" | "whatsappCheck"> | null | undefined,
  toPhone?: string | null
): boolean {
  const check = contact?.whatsappCheck;
  if (!contact || !check || check.status !== "not_on_whatsapp") return false;
  const current = currentSendDigits(contact);
  if (!current || !phoneLookupCandidates(current).includes(check.phone)) return false;
  const target = digitsOf(toPhone);
  return !target || phoneLookupCandidates(target).includes(check.phone);
}

/**
 * Depois de editar o número (`phone`/`whatsappNumber`) o marcador continua valendo?
 * `not_on_whatsapp`: sim se o novo número é só OUTRA grafia do mesmo número;
 * `verified`: só se os dígitos são os mesmos. Usado por quem limpa o marcador na edição.
 */
export function markerSurvivesNumberChange(check: WhatsappCheck | undefined, newDigits: string): boolean {
  if (!check || !newDigits) return false;
  return check.status === "not_on_whatsapp"
    ? phoneLookupCandidates(newDigits).includes(check.phone)
    : check.phone === newDigits;
}

/** Falhas `recipient_not_found` seguidas para o número atual a partir das quais o automático para. */
export const NOT_FOUND_FAILS_BLOCK = 2;

/**
 * Contador de `recipient_not_found` do número atual. EXATO nos dígitos (como
 * `verified`): um `no LID found` diz respeito àquele JID e só a ele — a outra
 * grafia não foi tentada. (O marcador `not_on_whatsapp` é que vale para as duas,
 * porque a checagem do gateway perguntou ambas.) Nada marcado + checagem
 * indisponível/inconclusiva = cada envio seguinte iria ao mesmo JID.
 */
export function notFoundFailCount(
  contact: Pick<Doc<"contacts">, "phone" | "whatsappNumber" | "whatsappFails"> | null | undefined,
  toPhone?: string | null
): number {
  const f = contact?.whatsappFails;
  if (!contact || !f) return 0;
  const current = currentSendDigits(contact);
  if (!current || f.phone !== current) return 0;
  const target = digitsOf(toPhone);
  if (target && target !== f.phone) return 0;
  return f.count;
}

/** Bloqueia o envio automático (e pede aceite no manual): marcado OU falhas demais seguidas. */
export function isAutomatedSendBlocked(
  contact: Pick<Doc<"contacts">, "phone" | "whatsappNumber" | "whatsappCheck" | "whatsappFails"> | null | undefined,
  toPhone?: string | null
): boolean {
  return isMarkedNotOnWhatsapp(contact, toPhone) || notFoundFailCount(contact, toPhone) >= NOT_FOUND_FAILS_BLOCK;
}

export async function recordNotFoundFail(ctx: MutationCtx, contactId: Id<"contacts">, now: number): Promise<void> {
  const contact = await ctx.db.get(contactId);
  if (!contact) return;
  const current = currentSendDigits(contact);
  if (!current) return;
  const prev = notFoundFailCount(contact);
  await ctx.db.patch(contactId, { whatsappFails: { phone: current, count: prev + 1, at: now } });
}

/** Envio aceito pelo gateway: o número existe, zera o contador. */
export async function clearNotFoundFails(ctx: MutationCtx, contactId: Id<"contacts">): Promise<void> {
  const contact = await ctx.db.get(contactId);
  if (contact?.whatsappFails) await ctx.db.patch(contactId, { whatsappFails: undefined });
}

export function isRecentlyVerified(
  contact: Pick<Doc<"contacts">, "phone" | "whatsappNumber" | "whatsappCheck">,
  now: number
): boolean {
  const check = contact.whatsappCheck;
  return (
    !!check &&
    check.status === "verified" &&
    check.phone === currentSendDigits(contact) &&
    now - check.checkedAt < VERIFIED_TTL_MS
  );
}

/**
 * Grava o resultado de uma checagem para o número ATUAL do contato (o marcador
 * guarda os dígitos que o dispatch lê, não a versão normalizada que foi
 * perguntada ao gateway). `expectedPhone` protege contra corrida: se o número
 * do contato já mudou desde a checagem, não grava. Não regrava quando nada
 * mudou.
 */
export async function setWhatsappCheck(
  ctx: MutationCtx,
  contactId: Id<"contacts">,
  status: WhatsappCheck["status"],
  now: number,
  expectedPhone?: string
): Promise<void> {
  const contact = await ctx.db.get(contactId);
  if (!contact) return;
  const digits = currentSendDigits(contact);
  if (!digits) return;
  if (expectedPhone !== undefined && digitsOf(expectedPhone) !== digits) return;
  // "Existe" para o MESMO número que já deu `no LID` seguido é inconclusivo (o
  // self-heal faz o mesmo): não grava `verified` — isso zeraria o contador e
  // reabriria o envio automático a um JID que o WhatsApp recusou. Só entrega aceita
  // pelo gateway, mensagem recebida ou mudança de número zeram o contador.
  if (status === "verified" && notFoundFailCount(contact, digits) > 0) return;
  // Sempre regrava: `checkedAt` é o instante da ÚLTIMA consulta (a guarda de espera
  // de 10 min depende dele).
  await ctx.db.patch(contactId, {
    whatsappCheck: { phone: digits, status, checkedAt: now },
  });
}

/** Espera mínima entre consultas ao gateway para o MESMO número, e teto por dia (UTC). */
export const LOOKUP_MIN_GAP_MS = 10 * 60 * 1000;
export const LOOKUP_DAILY_CAP = 3;
const START_FLOW_BURST_MS = 2 * 60 * 1000;

export type LookupReservation =
  | { ok: true }
  | { ok: false; reason: "wait" | "daily_cap"; retryAfter: number };

/**
 * "Posso consultar o gateway por este contato agora?" — porta ÚNICA do orçamento
 * de consultas (self-heal, pré-checagem das boas-vindas, "Tentar novamente").
 * Reserva gravando no próprio contato (OCC serializa mensagens diferentes do
 * mesmo contato): 10 min entre consultas e no máximo 3 por dia por número.
 * O orçamento é do CONTATO (não do número). Marcador `not_on_whatsapp` recente
 * (< 10 min) também conta como "acabou de consultar".
 */
export async function reserveWhatsappLookup(
  ctx: MutationCtx,
  contactId: Id<"contacts">,
  now: number,
  /** Nova conversa: a 1ª reserva abre UMA consulta extra (conferir + iniciar) por 2 min, isenta só do espaçamento e contada no teto. */
  opts?: { startFlow?: boolean }
): Promise<LookupReservation> {
  const contact = await ctx.db.get(contactId);
  if (!contact) return { ok: false, reason: "wait", retryAfter: now + LOOKUP_MIN_GAP_MS };
  const digits = currentSendDigits(contact);
  const day = new Date(now).toISOString().slice(0, 10);
  const prev = contact.whatsappLookup;
  if (opts?.startFlow && prev?.burst && now < prev.burst.until) {
    // Segunda consulta da MESMA interação: isenta só do espaçamento de 10 min (não
    // renova `at`), mas CONTA no teto diário — a vaga foi guardada ao abrir a rajada.
    await ctx.db.patch(contactId, {
      whatsappLookup: { phone: digits, at: prev.at, day: prev.day, count: prev.day === day ? prev.count + 1 : 1 },
    });
    return { ok: true };
  }
  // POR CONTATO, sem olhar o número: um contato tem um número por vez, e editar
  // 13 ↔ 12 dígitos (ou A → B → A) não pode devolver o orçamento — a checagem
  // pergunta as duas grafias de uma vez.
  let last = prev?.at ?? 0;
  const check = contact.whatsappCheck;
  if (check && check.status === "not_on_whatsapp") last = Math.max(last, check.checkedAt);
  if (last && now - last < LOOKUP_MIN_GAP_MS) return { ok: false, reason: "wait", retryAfter: last + LOOKUP_MIN_GAP_MS };
  const count = prev && prev.day === day ? prev.count : 0;
  if (count >= LOOKUP_DAILY_CAP) {
    const tomorrow = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    return { ok: false, reason: "daily_cap", retryAfter: tomorrow };
  }
  await ctx.db.patch(contactId, {
    whatsappLookup: {
      phone: digits,
      at: now,
      day,
      count: count + 1,
      // Só abre a rajada se sobra vaga para a 2ª consulta: o teto diário é VERDADEIRO
      // (no máximo LOOKUP_DAILY_CAP consultas por dia, rajada inclusa).
      ...(opts?.startFlow && count + 2 <= LOOKUP_DAILY_CAP ? { burst: { until: now + START_FLOW_BURST_MS } } : {}),
    },
  });
  return { ok: true };
}

export async function clearWhatsappCheck(ctx: MutationCtx, contactId: Id<"contacts">): Promise<void> {
  const contact = await ctx.db.get(contactId);
  if (contact?.whatsappCheck) await ctx.db.patch(contactId, { whatsappCheck: undefined });
}

/** A conversa sai pelo gateway bridge? (config resolvida como no dispatch.) */
export async function conversationIsBridge(
  ctx: QueryCtx | MutationCtx,
  conversation: Doc<"conversations">
): Promise<boolean> {
  const config = await resolveConversationChannelConfig(ctx, conversation);
  return !!config && config.channel === "whatsapp" && configProvider(config) === "bridge";
}

/** Contato 1:1 da conversa (null em grupo, sem lead ou sem contato). */
export async function contactOfConversation(
  ctx: QueryCtx | MutationCtx,
  conversation: Doc<"conversations">
): Promise<Doc<"contacts"> | null> {
  if (conversation.kind === "group") return null;
  const lead = await getLeadRef(ctx.db, conversation.leadId);
  if (!lead?.contactId) return null;
  const contact = await ctx.db.get(lead.contactId);
  return contact && contact.organizationId === conversation.organizationId ? contact : null;
}

/**
 * Patch do contato quando o WhatsApp confirmou OUTRA grafia (única regra, usada
 * pela Nova conversa e pelo self-heal do dispatch). `whatsappNumber` é o que o
 * dispatch lê; `phone` só troca quando é o MESMO número noutra grafia (não
 * apaga um fixo cadastrado à parte).
 */
export function canonicalContactPatch(
  contact: Pick<Doc<"contacts">, "phone" | "whatsappNumber">,
  canonicalPhone: string
): { patch: { whatsappNumber?: string; phone?: string }; previousPhone?: string } {
  const patch: { whatsappNumber?: string; phone?: string } = {};
  const spellings = phoneLookupCandidates(canonicalPhone);
  const dispatchDigits = currentSendDigits(contact);
  const previousPhone = dispatchDigits && dispatchDigits !== canonicalPhone ? dispatchDigits : undefined;
  if (digitsOf(contact.whatsappNumber) !== canonicalPhone) patch.whatsappNumber = canonicalPhone;
  const phoneDigits = digitsOf(contact.phone);
  if (!phoneDigits || (phoneDigits !== canonicalPhone && (spellings.includes(phoneDigits) || phoneDigits === dispatchDigits))) {
    patch.phone = canonicalPhone;
  }
  return { patch, ...(previousPhone ? { previousPhone } : {}) };
}

/**
 * O número que o gateway devolveu é OUTRA GRAFIA do número que foi perguntado
 * (12/13 dígitos BR)? `checkBridgeNumber` pode devolver um telefone lido de
 * `/user/lid`; um mapa de LID errado não pode reescrever o contato para outra
 * pessoa. Fora dos candidatos = resposta inconclusiva (não reescreve, não marca).
 */
export function isSpellingOfSameNumber(askedPhone: string | undefined | null, canonical: string | undefined | null): boolean {
  const asked = digitsOf(askedPhone);
  const c = digitsOf(canonical);
  return /^\d{8,15}$/.test(c) && asked !== "" && phoneLookupCandidates(asked).includes(c);
}

/**
 * O número (dígitos de `contact.whatsappNumber ?? phone`) é o MESMO que foi
 * checado? Mesma grafia, outra grafia BR, ou o mesmo número sem DDI normalizado.
 * Evita gravar marcador num número que ninguém perguntou ao gateway.
 */
export function contactNumberWasChecked(
  contact: Pick<Doc<"contacts">, "phone" | "whatsappNumber">,
  checkedPhone: string,
  defaultCountry?: string
): boolean {
  const digits = currentSendDigits(contact);
  if (!digits) return false;
  const candidates = phoneLookupCandidates(digitsOf(checkedPhone));
  if (candidates.includes(digits)) return true;
  const n = normalizeCampaignPhone(digits, defaultCountry);
  return n.ok && candidates.includes(n.phone);
}

/** Opt-out em qualquer grafia BR do número (palavra-chave grava o JID cru). */
export async function isOptedOutAnySpelling(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  phone: string
): Promise<boolean> {
  const digits = digitsOf(phone);
  for (const candidate of new Set([digits, ...phoneLookupCandidates(digits)])) {
    if (candidate && (await isPhoneSuppressed(ctx, organizationId, candidate))) return true;
  }
  return false;
}

/** Telefone com máscara para texto de timeline/auditoria: só os 4 últimos dígitos. */
export function maskPhone(raw: string | undefined | null): string {
  const d = digitsOf(raw);
  return d.length <= 4 ? "****" : `${"*".repeat(d.length - 4)}${d.slice(-4)}`;
}

/**
 * Aplica o número confirmado pelo WhatsApp ao contato (+ marcador `verified`,
 * auditoria e nota na timeline do lead). Devolve false quando nada mudou.
 */
export async function applyCanonicalNumberToContact(
  ctx: MutationCtx,
  contact: Doc<"contacts">,
  canonicalPhone: string,
  args: { now: number; via: string; leadId?: Id<"leads">; actorId?: Id<"teamMembers">; actorType?: "system" | "human" }
): Promise<boolean> {
  const { patch, previousPhone } = canonicalContactPatch(contact, canonicalPhone);
  if (Object.keys(patch).length === 0) return false;
  await ctx.db.patch(contact._id, {
    ...patch,
    searchText: buildSearchText({ ...contact, ...patch }),
    whatsappCheck: { phone: canonicalPhone, status: "verified", checkedAt: args.now },
    // Número corrigido e confirmado: o contador era do JID antigo.
    ...(contact.whatsappFails ? { whatsappFails: undefined } : {}),
    updatedAt: args.now,
  });
  const actorType = args.actorType ?? "system";
  await ctx.db.insert("auditLogs", {
    organizationId: contact.organizationId,
    entityType: "contact",
    entityId: contact._id,
    action: "update",
    ...(args.actorId ? { actorId: args.actorId } : {}),
    actorType,
    metadata: {
      via: args.via,
      ...(previousPhone ? { previousPhoneMasked: maskPhone(previousPhone) } : {}),
      whatsappNumberMasked: maskPhone(canonicalPhone),
    },
    description: "Número de WhatsApp do contato corrigido para a grafia confirmada pelo gateway",
    severity: "low",
    createdAt: args.now,
  });
  if (args.leadId) {
    await ctx.db.insert("activities", {
      organizationId: contact.organizationId,
      leadId: args.leadId,
      type: "note",
      actorType,
      ...(args.actorId ? { actorId: args.actorId } : {}),
      content: `Número de WhatsApp corrigido (${maskPhone(previousPhone)} → ${maskPhone(canonicalPhone)}): o WhatsApp só reconhece esta grafia`,
      metadata: { contactId: contact._id },
      createdAt: args.now,
    });
  }
  return true;
}

/**
 * Envio MANUAL a contato marcado "sem WhatsApp": sem aceite → ConvexError
 * `NOT_ON_WHATSAPP:`; com aceite devolve `true` e o chamador chama
 * `recordNotOnWhatsappAck` depois de inserir a mensagem. `false` = sem aviso.
 */
export async function assertManualSendAllowed(
  ctx: QueryCtx | MutationCtx,
  conversation: Doc<"conversations">,
  ack: boolean | undefined,
  /** Quem envia: o aceite é SEMPRE de uma pessoa (membro `ai` nunca aceita). */
  member?: Pick<Doc<"teamMembers">, "type"> | null
): Promise<boolean> {
  if (conversation.channel !== "whatsapp") return false;
  // Marcador e contador são do BRIDGE: um envio pela Meta não é afetado por eles.
  if (!(await conversationIsBridge(ctx, conversation))) return false;
  const contact = await contactOfConversation(ctx, conversation);
  if (!isAutomatedSendBlocked(contact)) return false;
  if (ack !== true) {
    throw new ConvexError(
      `${NOT_ON_WHATSAPP_SEND_PREFIX} ${isMarkedNotOnWhatsapp(contact) ? NOT_ON_WHATSAPP_SEND_ERROR : NOT_FOUND_SEND_ERROR}`
    );
  }
  if (member?.type === "ai") throw new ConvexError(HUMAN_ACK_REQUIRED_ERROR);
  return true;
}

/** Carimba a mensagem com o aceite (o dispatch deixa passar) e audita. */
export async function recordNotOnWhatsappAck(
  ctx: MutationCtx,
  args: { messageId: Id<"messages">; member: Doc<"teamMembers">; now: number; via?: "app" | "api" }
): Promise<void> {
  const message = await ctx.db.get(args.messageId);
  if (!message) return;
  await ctx.db.patch(args.messageId, {
    metadata: {
      ...(message.metadata ?? {}),
      notOnWhatsappAck: { by: args.member._id, at: args.now, via: args.via ?? "app" },
    },
  });
  await ctx.db.insert("auditLogs", {
    organizationId: message.organizationId,
    entityType: "message",
    entityId: args.messageId,
    action: "update",
    actorId: args.member._id,
    actorType: args.member.type === "ai" ? "ai" : "human",
    metadata: { conversationId: message.conversationId, notOnWhatsappAck: true, via: args.via ?? "app" },
    description: "Envio manual a número sem WhatsApp confirmado (aceite do operador)",
    severity: "high",
    createdAt: args.now,
  });
}
