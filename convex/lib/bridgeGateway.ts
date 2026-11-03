/**
 * Bridge (wuzapi) HTTP helpers shared by `channelConfigs.ts` (web actions) and
 * `lib/channelReconnectCore.ts` (v0.78, reconnect from Telegram). Moved out of
 * `channelConfigs.ts` so the core does not import the registered module
 * (cycle); `channelConfigs.ts` re-exports `bridgeFetchJson` for old importers.
 */
import { buildBridgeAdminUsersRequest, phoneFromAdminUsers, phoneFromJid, type BridgeHttpRequest } from "./bridgeSession";

/**
 * Atrasos da presença após o pareamento: 2 s cobre o `Connected` do wuzapi; 30 s
 * cobre o `available` que ele reenvia no `PushNameSetting` / sync de app-state.
 */
export const BRIDGE_PRESENCE_AFTER_CONNECT_MS = [2_000, 30_000];

// Fire one wuzapi REST request (built by the pure adapter) and parse the JSON.
export async function bridgeFetchJson(
  req: BridgeHttpRequest,
  opts?: { timeoutMs?: number }
): Promise<{ httpOk: boolean; status: number; body: unknown }> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
    ...(opts?.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { httpOk: res.ok, status: res.status, body };
}

// Validate + normalize a bridge REST base URL (must be http/https). Returns trimmed value.
export function normalizeBridgeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("bridgeBaseUrl inválido — informe uma URL http(s) completa");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("bridgeBaseUrl deve usar http ou https");
  }
  return trimmed;
}

/**
 * Número do canal: do JID quando o gateway informa; senão `GET /admin/users`
 * com o admin token, só no gateway gerenciado (o admin token nunca vai para
 * outro host). Self-hosted sem JID → undefined.
 */
export async function resolveBridgePhone(params: {
  fromStatusJid?: string;
  baseUrl: string;
  instanceId?: string;
}): Promise<string | undefined> {
  const direct = phoneFromJid(params.fromStatusJid);
  if (direct) return direct;

  const adminToken = process.env.WA_BRIDGE_ADMIN_TOKEN;
  const managedUrl = process.env.WA_BRIDGE_DEFAULT_URL;
  if (!adminToken || !params.instanceId) return undefined;
  // Só manda o admin token para o gateway que é nosso.
  if (!managedUrl || normalizeBridgeBaseUrl(managedUrl) !== normalizeBridgeBaseUrl(params.baseUrl)) {
    return undefined;
  }

  try {
    const res = await bridgeFetchJson(buildBridgeAdminUsersRequest({ baseUrl: params.baseUrl, adminToken }));
    if (!res.httpOk) return undefined;
    return phoneFromAdminUsers(res.body, params.instanceId);
  } catch {
    return undefined;
  }
}
