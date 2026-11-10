/**
 * "Tentar novamente" de uma mensagem de saída que FALHOU — regras PURAS e o que
 * a UI lê para decidir se mostra o botão. O fluxo (checagem do número, reset,
 * despacho) mora em `convex/messageRetry.ts`.
 */
import type { BridgeErrorKind } from "./bridgeSendError";
import { translationOf } from "./translationGate";

/** Reenvios manuais por mensagem. */
export const MAX_MANUAL_RETRIES = 3;
/** Consultas ao gateway (checagem do número) por mensagem, e espera mínima entre elas. */
export const MAX_NUMBER_CHECKS = 3;
export const NUMBER_CHECK_WAIT_MS = 10 * 60 * 1000;

export type RetryRefusalReason =
  | "not_found"
  | "not_failed"
  | "in_flight"
  | "limit"
  | "opt_out"
  | "not_on_whatsapp"
  | "check_unavailable"
  | "not_sendable"
  | "translation_pending"
  | "channel_unavailable"
  | "maybe_delivered"
  | "check_wait";

export const RETRY_REFUSAL_TEXT: Record<RetryRefusalReason, string> = {
  not_found: "Mensagem não encontrada",
  not_failed: "Só dá para tentar novamente uma mensagem que falhou",
  in_flight: "Esta mensagem já está sendo reenviada — aguarde o resultado",
  limit: "Limite de reenvios manuais atingido para esta mensagem — escreva uma nova mensagem ou confira o número do contato",
  opt_out: "Este número pediu para não receber mensagens — não é possível reenviar",
  not_on_whatsapp: "Este número não está no WhatsApp — confira o número do contato antes de tentar de novo",
  check_unavailable: "Não foi possível confirmar o número no WhatsApp agora — tente novamente em instantes",
  not_sendable: "Esta mensagem não pode ser reenviada",
  translation_pending: "A tradução desta mensagem não terminou — use as ações de tradução",
  maybe_delivered:
    "O envio pode já ter chegado ao cliente (o gateway não confirmou a falha). Confirme que quer reenviar mesmo assim — a mensagem pode ficar duplicada",
  check_wait: "O número foi conferido há pouco — aguarde alguns minutos antes de tentar de novo",
  channel_unavailable: "O número de WhatsApp está desconectado ou inativo — reconecte em Configurações → Canais antes de tentar de novo",
};

export type DeliveryRetryInfo = {
  /** Mostrar o botão "Tentar novamente" (falhou, dentro do teto, sem reenvio em curso). */
  canRetry: boolean;
  /** O reenvio refaz a checagem do número no WhatsApp antes (pode recusar). */
  requiresCheck: boolean;
  /** Reenvios manuais já feitos / teto. */
  manualRetries: number;
  maxManualRetries: number;
  /** Classe do último erro do bridge, quando houver. */
  errorKind?: BridgeErrorKind;
  /** Reenviar exige aceite de que a mensagem pode já ter sido entregue (`maybeDeliveredAck`). */
  requiresDeliveredAck: boolean;
  /** Consultas ao gateway já gastas / teto. Esgotadas = sem botão. */
  numberChecks: number;
  maxNumberChecks: number;
  /**
   * "Um reenvio AGORA seria recusado até este instante" (ms epoch; a UI compara com o
   * próprio relógio). Só presente quando o reenvio exigiria nova consulta ao número
   * (`requiresCheck`).
   */
  retryAfter?: number;
  /** Quando o backoff automático vence (ms epoch). Passado há muito = retry órfão: a UI não deve mostrar "reenviando". */
  autoRetryNextAt?: number;
  /** O sistema está tentando de novo sozinho (backoff do bridge): mostrar "reenviando". */
  autoRetrying: boolean;
};

type RetryMessage = {
  direction: string;
  isInternal: boolean;
  deliveryStatus?: string;
  externalId?: string;
  metadata?: Record<string, any>;
};

/**
 * O reenvio manual exige aceite de "pode já ter sido entregue" a menos que a
 * falha seja PROVADAMENTE anterior ao envio. Lista positiva (o resto pede o aceite):
 * - classe `recipient_not_found`, `transient` ou `rate_limited` (lookup/recusa antes do envio);
 * - `metadata.deliveryPreSend === true`: recusa local (canal desconectado, gate,
 *   opt-out, anexo, configuração) ou HTTP 4xx do gateway;
 * Sem classe gravada (mensagens antigas, 5xx/rede da Meta) = pede o aceite. Um
 * `deliveryErrorCode` da Meta SOZINHO não dispensa: códigos genéricos vêm com 5xx;
 * só vale o HTTP 4xx (gravado como `deliveryPreSend`).
 */
export function needsDeliveredAck(metadata: Record<string, any> | undefined): boolean {
  const kind = metadata?.deliveryErrorKind;
  if (kind === "recipient_not_found" || kind === "transient" || kind === "rate_limited") return false;
  if (metadata?.deliveryPreSend === true) return false;
  return true;
}

export function manualRetriesOf(message: Pick<RetryMessage, "metadata">): number {
  const n = message.metadata?.manualRetries;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Estado de retry de uma mensagem para a UI. `null` quando não se aplica
 * (entrante, nota interna, entregue, ainda pendente sem retry automático).
 */
export function deliveryRetryInfo(message: RetryMessage): DeliveryRetryInfo | null {
  if (message.direction !== "outbound" || message.isInternal) return null;
  const meta = message.metadata ?? {};
  const kind = meta.deliveryErrorKind as BridgeErrorKind | undefined;
  const manualRetries = manualRetriesOf(message);
  const numberChecks = typeof meta.numberChecks === "number" && meta.numberChecks > 0 ? Math.floor(meta.numberChecks) : 0;
  const lastCheck = typeof meta.lastNumberCheckAt === "number" ? meta.lastNumberCheckAt : undefined;
  const base = {
    numberChecks,
    maxNumberChecks: MAX_NUMBER_CHECKS,
    requiresDeliveredAck: needsDeliveredAck(meta),
    manualRetries,
    maxManualRetries: MAX_MANUAL_RETRIES,
    ...(kind ? { errorKind: kind } : {}),
  };
  if (!message.deliveryStatus && !message.externalId && meta.bridgeRetry) {
    const nextAt = (meta.bridgeRetry as { nextAt?: number }).nextAt;
    return {
      ...base,
      canRetry: false,
      requiresCheck: false,
      autoRetrying: true,
      ...(typeof nextAt === "number" ? { autoRetryNextAt: nextAt } : {}),
    };
  }
  if (message.deliveryStatus !== "failed" || message.externalId) return null;
  const t = translationOf({ metadata: message.metadata });
  const heldByTranslation = t?.role === "outbound" && (t.status === "pending" || t.status === "failed");
  const requiresCheck = kind === "recipient_not_found";
  // `retryAfter` = "um reenvio AGORA seria recusado até este instante". Só existe
  // quando o reenvio exigiria nova consulta ao número (senão um `transient` depois
  // de um reenvio conferido mostraria um botão desligado à toa).
  // Mensagem de campanha: quem reenvia é a campanha ("Reenviar falhas"); o botão
  // da bolha criaria um 2º envio.
  const fromCampaign = !!meta.campaign;
  return {
    ...base,
    canRetry:
      !fromCampaign &&
      !heldByTranslation && manualRetries < MAX_MANUAL_RETRIES && !(requiresCheck && numberChecks >= MAX_NUMBER_CHECKS),
    requiresCheck,
    ...(requiresCheck && lastCheck !== undefined ? { retryAfter: lastCheck + NUMBER_CHECK_WAIT_MS } : {}),
    autoRetrying: false,
  };
}

/** Metadados de falha que o reenvio zera (o estado de segurança — `selfHealAt`, `bridgeAttempts` — fica). */
export function metadataForRetry(metadata: Record<string, any> | undefined): Record<string, any> {
  const {
    deliveryError: _e,
    deliveryErrorCode: _c,
    deliveryErrorKind: _k,
    deliveryPreSend: _p,
    numberCheck: _n,
    bridgeRetry: _r,
    ...rest
  } = metadata ?? {};
  return rest;
}
