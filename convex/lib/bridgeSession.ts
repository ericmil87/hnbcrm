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
 * Eventos que o gateway deve mandar para o nosso webhook.
 *
 * Message = mensagens (nos DOIS sentidos — o evento de uma mensagem enviada pelo
 * app do celular é o mesmo, com `Info.IsFromMe: true`); ReadReceipt = ticks de
 * entrega/leitura; os demais são sinais de sessão (deslogado/ban/cliente
 * desatualizado) — o ingress responde 200 e ignora os que ainda não trata.
 * CONFIRMADO contra o `supportedEventTypes` do wuzapi (constants.go).
 *
 * Usada TANTO no provisionamento quanto no connect, de propósito: são os dois
 * caminhos que escrevem `users.events` no gateway, e divergir entre eles é o que
 * degradava a assinatura silenciosamente.
 */
export const BRIDGE_WEBHOOK_EVENTS = [
  "Message",
  "ReadReceipt",
  "LoggedOut",
  "TemporaryBan",
  "ClientOutdated",
] as const;

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
      // O default TEM de ser a lista inteira, não `["Message"]`. O handler
      // `Connect()` do wuzapi faz `UPDATE users SET events=$1` com o que vier
      // aqui, então um Subscribe curto REESCREVE a assinatura feita no
      // provisionamento — foi assim que os recibos de entrega/leitura morreram
      // em produção (todas as instâncias ficaram com `events: "Message"` e os
      // outbound travaram em "sent"). Mandar a lista completa também CONSERTA
      // instâncias já degradadas no primeiro reconnect.
      Subscribe:
        params.subscribe && params.subscribe.length > 0 ? params.subscribe : [...BRIDGE_WEBHOOK_EVENTS],
      Immediate: false,
    }),
  };
}

/**
 * POST /session/logout — DESVINCULA o aparelho da conta do WhatsApp.
 *
 * Usa o token da PRÓPRIA instância, não o admin: assim funciona também em
 * gateway self-hosted, onde o CRM não tem credencial administrativa. Difere de
 * `/session/disconnect`, que só derruba o socket e deixa o aparelho vinculado —
 * o que não resolve nada aqui, porque o aparelho vinculado continua ocupando
 * slot e recebendo eventos quando reconectar.
 *
 * Responde 500 quando a sessão não estava logada/conectada; para o nosso uso
 * (encerrar uma conexão antiga) isso é sucesso na prática — já não havia o que
 * desvincular.
 */
export function buildBridgeLogoutRequest(params: {
  baseUrl: string;
  token: string;
}): BridgeHttpRequest {
  return {
    method: "POST",
    url: `${trimBase(params.baseUrl)}/session/logout`,
    headers: { "Content-Type": "application/json", token: params.token },
    body: "{}",
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
          : BRIDGE_WEBHOOK_EVENTS.join(","),
      // CONFIRMADO no piloto (2026-07-19): webhooks POR INSTÂNCIA são assinados
      // com a hmac_key do usuário (mín. 32 chars) — a env WUZAPI_GLOBAL_HMAC_KEY
      // só assina o webhook global. Sem este campo o webhook chega SEM assinatura
      // e o ingress rejeita com 401. Só o AddUser aceita hmacKey (EditUser não).
      ...(params.hmacKey ? { hmacKey: params.hmacKey } : {}),
    }),
  };
}

/**
 * GET /admin/users — listagem administrativa das instâncias do gateway.
 *
 * Existe por um motivo específico: `GET /session/status` devolve `jid: ""` mesmo
 * com a sessão logada (medido contra o gateway real em 16/09/2026, em três
 * instâncias), então o número pareado NÃO é descobrível pelo token da instância.
 * A listagem admin lê a coluna `jid` do banco do gateway, que está correta.
 *
 * Usa o token ADMIN, que o CRM só tem no gateway gerenciado (env
 * WA_BRIDGE_ADMIN_TOKEN). Em gateway self-hosted este caminho não existe e o
 * número é aprendido pelo tráfego (ver `selfPhone` em lib/bridgeParse.ts).
 */
export function buildBridgeAdminUsersRequest(params: {
  baseUrl: string;
  adminToken: string;
}): BridgeHttpRequest {
  return {
    method: "GET",
    url: `${trimBase(params.baseUrl)}/admin/users`,
    headers: { Authorization: params.adminToken },
  };
}

/**
 * Acha o JID de UMA instância na listagem admin, pelo nome (que é como o CRM
 * nomeia a instância: `bridgeInstanceId`). Devolve só os dígitos do telefone.
 */
export function phoneFromAdminUsers(
  responseBody: unknown,
  instanceName: string
): string | undefined {
  const b = (responseBody && typeof responseBody === "object" ? responseBody : {}) as Record<string, any>;
  const raw = b.data ?? b.Data ?? responseBody;
  const users = Array.isArray(raw) ? raw : [];
  for (const user of users) {
    if (!user || typeof user !== "object") continue;
    const name = (user as Record<string, any>).name ?? (user as Record<string, any>).Name;
    if (name !== instanceName) continue;
    return phoneFromJid((user as Record<string, any>).jid ?? (user as Record<string, any>).Jid);
  }
  return undefined;
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

// ── Campanhas: checar se números têm WhatsApp (wuzapi POST /user/check) ──
//
// API.md: POST /user/check, Token header, body {"Phone":["5491155554444", …]}
//   → { code, success, data: { Users: [ { Query, IsInWhatsapp, JID, VerifiedName } ] } }
// Parser tolerante a casing (IsInWhatsapp / IsInWhatsApp / isInWhatsapp) e ao
// envelope (data.Users / Users / data.users).
export function buildBridgeCheckUserRequest(params: {
  baseUrl: string;
  token: string;
  phones: string[];
}): BridgeHttpRequest {
  return {
    method: "POST",
    url: `${trimBase(params.baseUrl)}/user/check`,
    headers: { "Content-Type": "application/json", token: params.token },
    body: JSON.stringify({ Phone: params.phones }),
  };
}

export type BridgeCheckUserResult =
  | { ok: true; users: Array<{ phone: string; onWhatsapp: boolean; jid?: string }> }
  | { ok: false; error: string };

export function parseBridgeCheckUserResponse(
  httpOk: boolean,
  httpStatus: number,
  body: unknown
): BridgeCheckUserResult {
  const root = (body && typeof body === "object" ? body : {}) as Record<string, any>;
  if (!httpOk) {
    const err = pick(root, "error", "Error", "message") ?? `HTTP ${httpStatus}`;
    return { ok: false, error: String(err) };
  }
  if (root.success === false) {
    return { ok: false, error: String(pick(root, "error", "Error", "message") ?? "Gateway recusou a checagem") };
  }
  const data = pick(root, "data", "Data") ?? root;
  const users = pick(data, "Users", "users");
  if (!Array.isArray(users)) return { ok: false, error: "Resposta sem lista de usuários" };
  return {
    ok: true,
    users: users.map((u: Record<string, any>) => {
      const query = String(pick(u, "Query", "query", "Phone", "phone") ?? "");
      const jid = strUndef(pick(u, "JID", "Jid", "jid"));
      const flag = pick(u, "IsInWhatsapp", "IsInWhatsApp", "isInWhatsapp", "isInWhatsApp");
      const onWhatsapp = typeof flag === "boolean" ? flag : Boolean(jid);
      return {
        phone: query.replace(/\D+/g, "") || (phoneFromJid(jid) ?? ""),
        onWhatsapp,
        ...(jid ? { jid } : {}),
      };
    }),
  };
}
