/**
 * Pure adapter for the wuzapi (whatsmeow) SESSION + ADMIN REST API — the pairing
 * / health half of the unofficial WhatsApp "bridge" provider (Wave U5). No Convex
 * context and no fetch: it only builds the request pieces and interprets the
 * responses, so it is trivially unit-testable. The action (convex/channelConfigs.ts)
 * owns the actual fetch, the decrypt, and the DB writes.
 *
 * Endpoints + shapes are taken from the wuzapi API.md (asternic/wuzapi):
 *   POST /session/connect   Token header   body {Subscribe:[...], Immediate:false}
 *     → { code, success, data: { details, events, jid, webhook } }
 *   GET  /session/status    Token header
 *     → { code, success, data: { Connected: bool, LoggedIn: bool } }
 *   GET  /session/qr        Token header
 *     → { code, success, data: { QRCode: "data:image/png;base64,…" } }
 *   POST /admin/users       Authorization header (ADMIN token)
 *     body { name, token, webhook, events } → { id }
 *
 * The parsers stay tolerant of casing (data/Data, Connected/connected, QRCode/qr)
 * so they survive whichever serialization a given wuzapi build emits. Anything
 * still uncertain against a LIVE gateway is marked `VALIDAR:` for the U6 pilot.
 */

export interface BridgeHttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** The four session states we surface in the Channels UI. */
export type BridgeSessionState =
  | "connected" // paired + online — ready to send/receive
  | "connecting" // paired but the socket is temporarily down (reconnecting)
  | "qr" // not paired — a QR is available to scan
  | "disconnected" // not paired and no QR (logged out / never paired / banned)
  | "banned"; // gateway explicitly reported the number as banned/removed

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** First defined value among the given keys (tolerates casing differences). */
function pick(obj: Record<string, any> | null | undefined, ...keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function strUndef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** JID ("5491155554444.0:52@s.whatsapp.net") → phone digits, else undefined. */
export function phoneFromJid(jid: string | undefined): string | undefined {
  if (!jid) return undefined;
  const at = jid.indexOf("@");
  let user = at >= 0 ? jid.slice(0, at) : jid;
  user = user.split(":")[0].split(".")[0];
  const digits = user.replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits : undefined;
}

// ── Request builders ──

/**
 * GET /session/status — is this instance connected + logged in?
 * VALIDAR: header name `Token` (we send lowercase `token`, HTTP headers are
 * case-insensitive — matches convex/lib/bridgeSend.ts) against the live gateway.
 */
export function buildBridgeStatusRequest(params: { baseUrl: string; token: string }): BridgeHttpRequest {
  return {
    method: "GET",
    url: `${trimBase(params.baseUrl)}/session/status`,
    headers: { token: params.token },
  };
}

/**
 * POST /session/hmac/config — grava a chave HMAC do usuário E atualiza o cache
 * em memória do wuzapi. CONFIRMADO no piloto (2026-07-19): o AddUser persiste o
 * hmacKey no banco, mas o assinador de webhooks lê do cache, que só carrega a
 * chave no restart — sem esta chamada pós-provisionamento os webhooks saem SEM
 * assinatura até o gateway reiniciar (bug do upstream).
 */
export function buildBridgeHmacConfigRequest(params: {
  baseUrl: string;
  token: string;
  hmacKey: string;
}): BridgeHttpRequest {
  return {
    method: "POST",
    url: `${trimBase(params.baseUrl)}/session/hmac/config`,
    headers: { "Content-Type": "application/json", token: params.token },
    // Atenção: este endpoint usa `hmac_key` (snake_case), diferente do
    // `hmacKey` (camelCase) do POST /admin/users — inconsistência do upstream.
    body: JSON.stringify({ hmac_key: params.hmacKey }),
  };
}

/**
 * POST /session/connect — bring the socket up so a QR can be issued (or the
 * session resumes). `Subscribe` defaults to Message; the real event subscription
 * that matters for ingress is set per-instance at provisioning (`/admin/users`).
 */
export function buildBridgeConnectRequest(params: {
  baseUrl: string;
  token: string;
  subscribe?: string[];
}): BridgeHttpRequest {
  return {
    method: "POST",
    url: `${trimBase(params.baseUrl)}/session/connect`,
    headers: { "Content-Type": "application/json", token: params.token },
    body: JSON.stringify({
      Subscribe: params.subscribe && params.subscribe.length > 0 ? params.subscribe : ["Message"],
      Immediate: false,
    }),
  };
}

/** GET /session/qr — fetch the base64 data-URI QR to display for pairing. */
export function buildBridgeQrRequest(params: { baseUrl: string; token: string }): BridgeHttpRequest {
  return {
    method: "GET",
    url: `${trimBase(params.baseUrl)}/session/qr`,
    headers: { token: params.token },
  };
}

/**
 * POST /admin/users — provision a new instance (org = 1 user/token/number) with a
 * per-instance token + a webhook pointing at the CRM's bridge ingress. Uses the
 * ADMIN token (ephemeral, never persisted), NOT a per-instance token.
 */
export function buildBridgeProvisionRequest(params: {
  baseUrl: string;
  adminToken: string;
  name: string;
  token: string;
  webhook: string;
  events?: string;
  hmacKey?: string;
}): BridgeHttpRequest {
  return {
    method: "POST",
    url: `${trimBase(params.baseUrl)}/admin/users`,
    headers: { "Content-Type": "application/json", Authorization: params.adminToken },
    body: JSON.stringify({
      name: params.name,
      token: params.token,
      webhook: params.webhook,
      // Message = inbound, ReadReceipt = ticks; os demais são sinais de sessão
      // (deslogado/ban/cliente desatualizado) — o ingress ignora com 200 os que
      // ainda não trata. CONFIRMADO no piloto contra constants.go do wuzapi.
      events:
        params.events && params.events.length > 0
          ? params.events
          : "Message,ReadReceipt,LoggedOut,TemporaryBan,ClientOutdated",
      // CONFIRMADO no piloto (2026-07-19): webhooks POR INSTÂNCIA são assinados
      // com a hmac_key do usuário (mín. 32 chars) — a env WUZAPI_GLOBAL_HMAC_KEY
      // só assina o webhook global. Sem este campo o webhook chega SEM assinatura
      // e o ingress rejeita com 401. Só o AddUser aceita hmacKey (EditUser não).
      ...(params.hmacKey ? { hmacKey: params.hmacKey } : {}),
    }),
  };
}

// ── Response parsers ──

export type BridgeStatusResult =
  | { ok: true; connected: boolean; loggedIn: boolean; jid?: string }
  | { ok: false; error: string };

/** Interpret a GET /session/status response. */
export function parseBridgeStatusResponse(
  httpOk: boolean,
  status: number,
  responseBody: unknown
): BridgeStatusResult {
  const b = (responseBody && typeof responseBody === "object" ? responseBody : {}) as Record<string, any>;
  const data = (b.data ?? b.Data ?? {}) as Record<string, any>;
  const explicitFail = b.success === false || b.Success === false;

  if (!httpOk || explicitFail) {
    const error =
      strUndef(pick(b, "error", "Error", "message", "Message")) ??
      (status === 401 ? "Token da instância inválido ou instância removida" : `Falha ao consultar status (HTTP ${status})`);
    return { ok: false, error };
  }

  return {
    ok: true,
    connected: pick(data, "Connected", "connected") === true,
    loggedIn: pick(data, "LoggedIn", "loggedIn") === true,
    jid: strUndef(pick(data, "Jid", "jid", "JID")),
  };
}

export type BridgeQrResult =
  | { ok: true; qrCode?: string; loggedIn: boolean }
  | { ok: false; error: string };

/**
 * Interpret a GET /session/qr response. A logged-in session returns no QR (there
 * is nothing to scan) — that is `ok:true` with no `qrCode`, not an error.
 * VALIDAR: exact field spelling of the QR payload against the live gateway.
 */
export function parseBridgeQrResponse(
  httpOk: boolean,
  status: number,
  responseBody: unknown
): BridgeQrResult {
  const b = (responseBody && typeof responseBody === "object" ? responseBody : {}) as Record<string, any>;
  const data = (b.data ?? b.Data ?? {}) as Record<string, any>;
  const explicitFail = b.success === false || b.Success === false;

  if (!httpOk || explicitFail) {
    const error =
      strUndef(pick(b, "error", "Error", "message", "Message")) ??
      `Falha ao obter o QR (HTTP ${status})`;
    return { ok: false, error };
  }

  const qrCode = strUndef(pick(data, "QRCode", "qrcode", "qrCode", "qr", "QR"));
  const loggedIn = pick(data, "LoggedIn", "loggedIn") === true;
  return { ok: true, qrCode, loggedIn };
}

export type BridgeProvisionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/** Interpret a POST /admin/users response ({ id } on success). */
export function parseBridgeProvisionResponse(
  httpOk: boolean,
  status: number,
  responseBody: unknown
): BridgeProvisionResult {
  const b = (responseBody && typeof responseBody === "object" ? responseBody : {}) as Record<string, any>;
  const data = (b.data ?? b.Data ?? {}) as Record<string, any>;
  const explicitFail = b.success === false || b.Success === false;

  const rawId = pick(b, "id", "Id", "ID") ?? pick(data, "id", "Id", "ID");
  const id = typeof rawId === "number" ? String(rawId) : strUndef(rawId);

  if (httpOk && !explicitFail && id) {
    return { ok: true, id };
  }

  const error =
    strUndef(pick(b, "error", "Error", "message", "Message")) ??
    (status === 401 ? "Admin token inválido — verifique o token de administração do gateway" : `Falha ao provisionar instância (HTTP ${status})`);
  return { ok: false, error };
}

/**
 * Fold a status probe (+ optional QR availability) into the UI session state and a
 * human-readable PT-BR detail. Pure — the action decides ok/active vs error from
 * `state === "connected"`.
 */
export function mapBridgeSessionState(input: {
  connected: boolean;
  loggedIn: boolean;
  jid?: string;
  hasQr?: boolean;
}): { state: BridgeSessionState; healthDetail: string; phone?: string } {
  const phone = phoneFromJid(input.jid);

  if (input.loggedIn && input.connected) {
    return {
      state: "connected",
      healthDetail: phone ? `Conectado como +${phone}` : "Conectado",
      phone,
    };
  }
  if (input.loggedIn && !input.connected) {
    return {
      state: "connecting",
      healthDetail: "Sessão pareada — reconectando ao WhatsApp…",
      phone,
    };
  }
  if (!input.loggedIn && input.hasQr) {
    return {
      state: "qr",
      healthDetail: "Aguardando pareamento — escaneie o QR no WhatsApp do número",
    };
  }
  return {
    state: "disconnected",
    healthDetail: "Deslogado — reconecte escaneando o QR",
  };
}
