/**
 * Política de entrega de avisos (C1) — PURA, sem `ctx`. Uma única função decide
 * se um aviso sai por um canal para um membro: `shouldDeliver`.
 *
 * Quem usa: `createNotification` (sino + agendamento do Telegram), a entrega do
 * Telegram (recheque), `dispatchNotification` (e-mail) e, no E1, o push.
 *
 * Modelo de preferência (aditivo, sem migração):
 *  - flags antigos (`taskAssigned`…): `false` desliga o tipo em TODOS os canais
 *    (exceto o sino de tipos acionáveis, que nunca desliga);
 *  - `channels.{email,telegram,push}[flag]`: por canal; vence o flag antigo e o preset;
 *  - `preset` ("all" | "mine" | "none") do membro, senão o da org
 *    (`settings.notificationDefaults.preset`), senão "all" (= comportamento de antes);
 *  - `pausedUntil` (e o `mutedUntil` legado do vínculo do Telegram) e `quietHours`
 *    seguram os canais EXTERNOS (`hold_*`); o sino nunca é segurado;
 *  - `urgentBypass` (padrão true): pedido de ajuda da IA fura pausa e silêncio.
 */
import type { NotificationType } from "./notify";
import { PUSH_TEMPLATES } from "./webPush";

export type NotifChannel = "bell" | "email" | "telegram" | "push";
export type ExternalChannel = Exclude<NotifChannel, "bell">;
export type NotifPreset = "all" | "mine" | "none";
export type PolicyDecision = "deliver" | "hold_paused" | "hold_quiet" | "off";

export type QuietHours = { enabled: boolean; start: string; end: string; timeZone: string };

export type PolicyPrefs = {
  preset?: NotifPreset;
  channels?: Partial<Record<ExternalChannel, Record<string, boolean>>>;
  pausedUntil?: number;
  quietHours?: QuietHours;
  urgentBypass?: boolean;
  /** Flags antigos (`taskAssigned`…) e quaisquer outros campos da linha. */
  [field: string]: unknown;
};

export type PolicyOrgDefaults = { preset?: NotifPreset; hidePreviewOnLockScreen?: boolean } | null | undefined;

/** Tipo de aviso do sino → flag de preferência (e `eventType` do e-mail). */
export const PREFERENCE_FLAG: Record<NotificationType, string> = {
  task_assigned: "taskAssigned",
  task_comment_mention: "taskCommentMention",
  task_due_soon: "taskDueSoon",
  task_overdue: "taskOverdue",
  handoff_requested: "handoffRequested",
  handoff_resolved: "handoffResolved",
  ai_draft_pending: "aiDraftPending",
  campaign_completed: "campaignCompleted",
  campaign_paused: "campaignPaused",
  group_joined: "groupJoined",
  group_mention: "groupMention",
  group_post_pending: "groupPostPending",
  group_post_failed: "groupPostFailed",
  group_opportunity: "groupOpportunity",
  group_digest: "groupDigest",
  // Só sino/Telegram: não existe template de e-mail para este evento.
  ai_followup_needs_human: "aiFollowupNeedsHuman",
  conversation_transferred: "conversationTransferred",
  channel_session_lost: "channelSessionLost",
  // Um flag só para aviso e teto de gasto (também é o eventType do e-mail).
  ai_spend_warning: "aiSpendAlert",
  ai_spend_reached: "aiSpendAlert",
  new_message: "newMessage",
  lead_assigned: "leadAssigned",
  // Billing B4: um flag so para os avisos de plano (tambem e o eventType do e-mail).
  plan_usage_warning: "planAlert",
  plan_usage_reached: "planAlert",
  plan_overage_cap_reached: "planAlert",
  trial_ending: "planAlert",
  plan_read_only: "planAlert",
  plan_payment_overdue: "planAlert",
};

/** `eventType` de e-mail que compartilha o flag de outro evento. */
const EVENT_FLAG_ALIAS: Record<string, string> = { taskOverdueSummary: "taskOverdue" };

/** Flags conhecidos (chaves aceitas em `channels.*`). */
export const KNOWN_FLAGS: readonly string[] = Array.from(
  new Set([...Object.values(PREFERENCE_FLAG), "dailyDigest"])
);

/**
 * Tipos ACIONÁVEIS (seção 4 do PLANO): alguém precisa agir. O sino deles nunca
 * é desligável; só e-mail/Telegram/push. Os demais (campanhas, grupos exceto
 * menção, custo de IA, repasse resolvido) seguem a preferência, inclusive no sino.
 */
export const ACTIONABLE_TYPES: readonly NotificationType[] = [
  "handoff_requested",
  "new_message",
  "conversation_transferred",
  "task_comment_mention",
  "group_mention",
  "ai_draft_pending",
  "task_assigned",
  "task_due_soon",
  "task_overdue",
  "lead_assigned",
  "channel_session_lost",
  "ai_followup_needs_human",
];
export const ACTIONABLE_FLAGS: readonly string[] = Array.from(
  new Set(ACTIONABLE_TYPES.map((t) => PREFERENCE_FLAG[t]))
);

/** Fora de "Só o que é comigo" nos canais externos (informativo/administrativo). */
export const NON_PERSONAL_FLAGS = new Set([
  "campaignCompleted",
  "campaignPaused",
  "groupJoined",
  "groupPostPending",
  "groupPostFailed",
  "groupOpportunity",
  "groupDigest",
  "aiSpendAlert",
  "planAlert",
]);

/**
 * Flags de preferência cujo tipo tem template de push (o que o app mostra no
 * canal "Push"). Derivado de `PUSH_TEMPLATES` × `PREFERENCE_FLAG`.
 */
export const PUSH_PREFERENCE_FLAGS: readonly string[] = Array.from(
  new Set((Object.keys(PUSH_TEMPLATES) as NotificationType[]).map((t) => PREFERENCE_FLAG[t]))
);

/** Furam pausa e silêncio quando `urgentBypass !== false` (E3). */
const URGENT_FLAGS = new Set(["handoffRequested"]);

/** Aceita o tipo do sino, o `eventType` do e-mail ou o próprio flag. */
export function flagOf(typeOrEvent: string): string {
  return (PREFERENCE_FLAG as Record<string, string>)[typeOrEvent] ?? EVENT_FLAG_ALIAS[typeOrEvent] ?? typeOrEvent;
}

export function isActionable(typeOrEvent: string): boolean {
  return ACTIONABLE_FLAGS.includes(flagOf(typeOrEvent));
}

export const DEFAULT_QUIET_START = "21:00";
export const DEFAULT_QUIET_END = "08:00";

/** O canal aceita este flag, ignorando pausa e silêncio? (matriz de "Personalizar"). */
export function channelAllows(
  flag: string,
  channel: NotifChannel,
  prefs: PolicyPrefs | null | undefined,
  orgDefaults: PolicyOrgDefaults
): boolean {
  const legacyOff = prefs?.[flag] === false;
  // Sino: acionável sempre registra (flag antigo vale só para os canais externos);
  // informativo segue o flag antigo.
  if (channel === "bell") return isActionable(flag) || !legacyOff;
  // Informativo: Telegram/push só chegam se o sino do tipo também está ligado (canal && sino).
  if (legacyOff && !isActionable(flag) && (channel === "telegram" || channel === "push")) return false;
  const explicit = prefs?.channels?.[channel]?.[flag];
  if (explicit !== undefined) return explicit;
  if (legacyOff) return false;
  const preset = prefs?.preset ?? orgDefaults?.preset ?? "all";
  if (preset === "none") return false;
  if (preset === "mine" && NON_PERSONAL_FLAGS.has(flag)) return false;
  return true;
}

function minutesOf(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function isValidHHMM(hhmm: string): boolean {
  return minutesOf(hhmm) !== null;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Minutos desde 00:00 no fuso (fuso inválido cai em UTC). */
export function localMinutes(at: number, timeZone: string): number {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(at));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (g("hour") % 24) * 60 + g("minute");
}

/** `[start, end)` no fuso; atravessa a meia-noite quando start > end; start == end = nunca. */
export function isInQuietHours(at: number, q: QuietHours | undefined): boolean {
  if (!q?.enabled) return false;
  const s = minutesOf(q.start);
  const e = minutesOf(q.end);
  if (s === null || e === null || s === e) return false;
  const m = localMinutes(at, q.timeZone);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/**
 * Fim da pausa vigente (a maior entre o campo novo e o `mutedUntil` legado do vínculo), ou undefined.
 * `mutedUntil` é só da transição: o `/pausar` novo grava `pausedUntil` e limpa o legado.
 */
export function activePausedUntil(
  prefs: PolicyPrefs | null | undefined,
  legacyMutedUntil: number | undefined,
  now: number
): number | undefined {
  const until = Math.max(prefs?.pausedUntil ?? 0, legacyMutedUntil ?? 0);
  return until > now ? until : undefined;
}

export function shouldDeliver(args: {
  /** Tipo do sino (`task_assigned`) ou `eventType` de e-mail (`taskAssigned`). */
  type: NotificationType | string;
  channel: NotifChannel;
  prefs: PolicyPrefs | null | undefined;
  orgDefaults?: PolicyOrgDefaults;
  now: number;
  /** `telegramLinks.mutedUntil` (legado, lido junto com `pausedUntil` na transição). */
  legacyMutedUntil?: number;
}): PolicyDecision {
  const flag = flagOf(args.type);
  const { prefs, channel, now } = args;
  if (!channelAllows(flag, channel, prefs, args.orgDefaults)) return "off";
  // O sino registra sempre: pausa e silêncio só seguram o que "toca" fora do app.
  if (channel === "bell") return "deliver";
  if (URGENT_FLAGS.has(flag) && prefs?.urgentBypass !== false) return "deliver";
  if (activePausedUntil(prefs, args.legacyMutedUntil, now) !== undefined) return "hold_paused";
  // O resumo diário (e-mail das 8h) não é intrusivo: ignora o silêncio; a pausa continua valendo.
  if (flag !== "dailyDigest" && isInQuietHours(now, prefs?.quietHours)) return "hold_quiet";
  return "deliver";
}
