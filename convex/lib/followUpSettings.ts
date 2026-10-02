/**
 * Valores EFETIVOS da configuração de follow-up do atendente (v0.60).
 *
 * Fonte ÚNICA: o backend decide com isto e a UI mostra exatamente isto. Todo
 * número da feature é configurável pelo editor do atendente — ausente cai no
 * default do produto, e o default precisa estar num lugar só (era isso ou três
 * cópias de "30" espalhadas entre `fire`, tela e documentação).
 *
 * Módulo PURO (sem ctx, sem Date.now()).
 */

export type FollowUpMode = "off" | "draft" | "send";

export type FollowUpProfileConfig = {
  mode: FollowUpMode;
  maxChain?: number;
  quietStartHour?: number;
  quietEndHour?: number;
  dailyCap?: number;
  eventDateField?: string;
};

export type FollowUpSettings = {
  /** O que acontece no vencimento. */
  mode: FollowUpMode;
  /** Follow-ups SEGUIDOS sem inbound do cliente antes de escalar (anti-insistência). */
  maxChain: number;
  /** Janela de silêncio (hora local), INTERSECTADA com o horário de atendimento. */
  quietStartHour: number;
  quietEndHour: number;
  /** Teto diário por NÚMERO; 0 = sem teto. */
  dailyCap: number;
  /** Chave do custom field (lead, tipo data) com a data do evento alvo; undefined = sem a guarda. */
  eventDateField: string | undefined;
};

/**
 * Fim do evento (epoch ms) a partir do valor cru do custom field, ou null se
 * ausente/ilegível. Número = epoch como está. String só com data ("2027-02-04")
 * vale até o FIM daquele dia (+24h sobre 00:00 UTC) — o follow-up do próprio dia
 * do evento ainda é legítimo e não depende do fuso. String com hora é
 * comparada como está. Puro.
 */
export function parseEventEnd(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? t + 24 * 60 * 60 * 1000 : t;
}

/**
 * Ausente = "draft" (decisão D1): a tarefa da IA deixa de ser cosmética em toda
 * org existente, mas nada sai sozinho. Quem quer envio automático liga na tela.
 */
export const DEFAULT_FOLLOW_UP_MODE: FollowUpMode = "draft";
export const DEFAULT_MAX_CHAIN = 2;
export const DEFAULT_QUIET_START_HOUR = 8;
export const DEFAULT_QUIET_END_HOUR = 20;
/** D5: estimativas calibráveis, como nas campanhas — não são limites oficiais. */
export const DEFAULT_DAILY_CAP_BRIDGE = 30;
export const DEFAULT_DAILY_CAP_META = 100;

export const MAX_CHAIN_LIMIT = 5;
export const MAX_DAILY_CAP = 500;

/**
 * Inteiro dentro da faixa, ou o default. Fracionário NÃO é arredondado: "2.5h"
 * de janela não existe no produto, e truncar silenciosamente transformaria um
 * bug da tela num horário que ninguém escolheu.
 */
function intOr(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

/**
 * Resolve a configuração efetiva a partir do perfil do agente e do transporte
 * do canal. `provider` null (canal não resolvido) é tratado como Meta — mesma
 * postura conservadora da condição 11 da elegibilidade.
 */
export function resolveFollowUpSettings(
  profile: { followUps?: FollowUpProfileConfig } | null | undefined,
  provider: "meta" | "bridge" | null | undefined
): FollowUpSettings {
  const cfg = profile?.followUps;
  const defaultCap = provider === "bridge" ? DEFAULT_DAILY_CAP_BRIDGE : DEFAULT_DAILY_CAP_META;

  const quietStart = intOr(cfg?.quietStartHour, DEFAULT_QUIET_START_HOUR, 0, 24);
  const quietEnd = intOr(cfg?.quietEndHour, DEFAULT_QUIET_END_HOUR, 0, 24);

  return {
    mode: cfg?.mode ?? DEFAULT_FOLLOW_UP_MODE,
    maxChain: intOr(cfg?.maxChain, DEFAULT_MAX_CHAIN, 1, MAX_CHAIN_LIMIT),
    // Faixa invertida ou vazia gravada por uma versão antiga da UI não pode
    // virar "nunca manda nada" nem "manda de madrugada": volta ao default.
    quietStartHour: quietStart < quietEnd ? quietStart : DEFAULT_QUIET_START_HOUR,
    quietEndHour: quietStart < quietEnd ? quietEnd : DEFAULT_QUIET_END_HOUR,
    // 0 é um valor VÁLIDO (sem teto), então não pode cair no `intOr` com min 1.
    dailyCap: intOr(cfg?.dailyCap, defaultCap, 0, MAX_DAILY_CAP),
    eventDateField: cfg?.eventDateField?.trim() || undefined,
  };
}
