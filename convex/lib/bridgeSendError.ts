/**
 * Classificação PURA dos erros de envio do gateway bridge (wuzapi/whatsmeow) e
 * a política de retry que sai dela. Nada aqui toca o banco.
 *
 * Fatos medidos (PROD, 3 casos em 30 dias, mesma forma):
 * - `no LID found for <jid> from server`: o usync respondeu e o WhatsApp NÃO tem
 *   conta naquele JID exato. Significa "não registrado" OU "registrado na outra
 *   grafia" (9º dígito BR) — o texto não distingue, e repetir a mesma grafia
 *   falha sempre. Só `checkBridgeNumber` resolve.
 * - `failed to get user info for … to fill LID cache: …` é falha TRANSITÓRIA do
 *   lookup (timeout, desconexão, `429: rate-overlimit`).
 * - Destinatário que bloqueou o remetente NÃO aparece em erro nenhum.
 *
 * Regra de ouro (proteção das contas dos clientes contra ban): erro desconhecido
 * NUNCA é reenviado. Só `transient` e um único `rate_limited` têm retry, com teto.
 */

export type BridgeErrorKind =
  | "recipient_not_found"
  | "transient"
  | "rate_limited"
  | "session"
  | "permanent"
  /**
   * Pode ter sido enviada: timeout/EOF/5xx/"sem id" DEPOIS de o gateway aceitar o
   * envio. Nunca reenvia sozinho (duplicaria a mensagem para o cliente); o reenvio
   * manual exige aceite explícito de que talvez já tenha sido entregue.
   */
  | "ambiguous";

export const BRIDGE_ERROR_KINDS: BridgeErrorKind[] = [
  "recipient_not_found",
  "transient",
  "rate_limited",
  "session",
  "permanent",
  "ambiguous",
];

export function classifyBridgeSendError(input: {
  /** Texto de erro do gateway (ou da exceção de rede). */
  error?: string | null;
  /** HTTP status da resposta, quando houve resposta. */
  status?: number;
  /** `fetch` lançou (sem resposta): rede/timeout/DNS. */
  network?: boolean;
}): BridgeErrorKind {
  const text = (input.error ?? "").toLowerCase();
  const status = input.status;

  if (text.includes("no lid found")) return "recipient_not_found";

  if (status === 429 || text.includes("rate-overlimit") || text.includes("rate limit") || text.includes("too many requests")) {
    return "rate_limited";
  }

  // PROVAVELMENTE ANTES do envio (lookup do usync / store local de LID): só estes
  // e a conexão recusada/DNS são seguros para reenviar sozinho.
  if (text.includes("failed to get user info") || text.includes("fill lid cache")) return "transient";
  if (text.includes("failed to get lid for pn")) return "transient";
  if (/connection refused|econnrefused|no such host|enotfound|getaddrinfo/.test(text)) return "transient";

  // A PARTIR DAQUI nada prova que a mensagem não saiu. Tudo isto vem ANTES de
  // `session`/`permanent`: o texto da exceção engana ("websocket disconnected
  // before message send returned response" parece sessão, mas o nó já foi enviado).
  if (input.network === true) return "ambiguous";
  // Qualquer 2xx sem id reconhecido (o parser não leu a grafia do id): quase certo
  // que saiu.
  if (status !== undefined && status >= 200 && status < 300) return "ambiguous";
  if (
    /timeout|timed out|deadline exceeded|connection reset|econnreset|\beof\b|network|fetch failed|socket hang up|context canceled|aborted|before message send|websocket disconnected|socket disconnected|invalid response body|não retornou o id|falha inesperada/.test(text)
  ) {
    return "ambiguous";
  }
  // Texto de pedido inválido conhecido (mesmo num 5xx): reenviar o mesmo corpo não adianta.
  if (/invalid|missing|required|malformed|could not decode|unsupported|too large|not allowed|bad request/.test(text) && !/session|token/.test(text)) {
    return "permanent";
  }
  // 5xx/408 (inclusive com texto de sessão): o proxy/gateway pode ter falhado
  // depois de enviar.
  if (status !== undefined && (status === 408 || status >= 500)) return "ambiguous";

  if (
    /no session|not logged in|logged out|not connected|client is nil|disconnected|unauthorized|invalid token|session not found/.test(text) ||
    status === 401 ||
    status === 403
  ) {
    return "session";
  }

  // 4xx de pedido (400/404/413/422) e qualquer desconhecido: não reenvia sozinho.
  return "permanent";
}

/**
 * A falha veio ANTES de o gateway enviar (HTTP 4xx de pedido recusado)? Só então
 * `permanent`/`session` dispensam o aceite de "pode já ter sido entregue" no
 * reenvio manual.
 */
export function isPreSendHttpRejection(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

/** Envios no total (o 1º + retries) para `transient`. */
export const BRIDGE_MAX_SEND_ATTEMPTS = 3;
/** Atraso antes da 2ª e da 3ª tentativa (cresce). O pacing do canal soma por cima. */
export const BRIDGE_TRANSIENT_DELAYS_MS = [30_000, 120_000];
/** `rate_limited`: UM retry, bem depois. */
export const BRIDGE_RATE_LIMIT_DELAY_MS = 15 * 60_000;

export type BridgeRetryPlan = { retry: true; delayMs: number } | { retry: false };

/**
 * @param attemptsSoFar envios JÁ feitos (inclui o que acabou de falhar), >= 1
 * @param rateRetried já houve um retry por rate limit nesta mensagem
 */
export function bridgeRetryPlan(kind: BridgeErrorKind, attemptsSoFar: number, rateRetried: boolean): BridgeRetryPlan {
  if (kind === "transient") {
    if (attemptsSoFar >= BRIDGE_MAX_SEND_ATTEMPTS) return { retry: false };
    const delayMs = BRIDGE_TRANSIENT_DELAYS_MS[Math.min(Math.max(attemptsSoFar, 1) - 1, BRIDGE_TRANSIENT_DELAYS_MS.length - 1)];
    return { retry: true, delayMs };
  }
  if (kind === "rate_limited") {
    if (rateRetried || attemptsSoFar >= BRIDGE_MAX_SEND_ATTEMPTS) return { retry: false };
    return { retry: true, delayMs: BRIDGE_RATE_LIMIT_DELAY_MS };
  }
  return { retry: false };
}

/** Textos PT-BR para a equipe (nunca o texto cru do gateway nos casos conhecidos). */
export const NOT_ON_WHATSAPP_DELIVERY_ERROR =
  "Este número não está no WhatsApp (ou está cadastrado com outro formato) — confira o número do contato";
export const NOT_ON_WHATSAPP_BLOCKED_ERROR =
  "Número sem WhatsApp (verificado antes) — envio automático bloqueado. Confirme o número do contato";
export const NUMBER_CHECK_UNAVAILABLE_ERROR =
  "O WhatsApp não encontrou este número e a verificação ficou indisponível agora — tente novamente em instantes";
