/**
 * Presença GLOBAL do bridge (wuzapi `POST /user/presence`) — o único lugar que
 * a dispara. Sem `ctx`; faz o fetch para o cron, a action de aplicação e o
 * "colchete" do digitando (`convex/whatsapp.ts`) compartilharem o mesmo código.
 *
 * Por que existe: o WhatsApp silencia o CELULAR do cliente enquanto um aparelho
 * vinculado está `available`, e o wuzapi anuncia `available` a cada `Connected`.
 * Com `bridgePhoneNotifications` ausente/true o CRM fica `unavailable`.
 */
import {
  buildBridgeGlobalPresenceRequest,
  desiredBridgePresence,
  parseBridgeAckResponse,
  type BridgeGlobalPresence,
} from "./bridgeSend";

/** Timeout curto: 50 canais × (sonda 8 s + presença) precisam caber no tick. */
export const BRIDGE_PRESENCE_TIMEOUT_MS = 4_000;

/**
 * Anuncia a presença global. Best effort: NUNCA lança; devolve o motivo da
 * falha (sem token nem telefone).
 */
export async function applyBridgePresence(
  baseUrl: string,
  token: string,
  type: BridgeGlobalPresence
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const req = buildBridgeGlobalPresenceRequest({ baseUrl, token, type });
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(BRIDGE_PRESENCE_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    return parseBridgeAckResponse(res.ok, res.status, body);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "erro de rede" };
  }
}

/**
 * O WhatsApp pode não repassar o `composing` de um aparelho vinculado que está
 * `unavailable`. Então, quando o canal está no modo "celular continua tocando",
 * o digitando vai num colchete: `available` → composing → envio → `unavailable`.
 * No modo legado (`available` o tempo todo) não há colchete.
 */
export function typingNeedsPresenceBracket(config: { bridgePhoneNotifications?: boolean }): boolean {
  return desiredBridgePresence(config) === "unavailable";
}

/** Abre o colchete (antes do composing). Devolve se abriu — feche só nesse caso. */
export async function openTypingPresenceBracket(
  config: { bridgePhoneNotifications?: boolean },
  baseUrl: string,
  token: string
): Promise<boolean> {
  if (!typingNeedsPresenceBracket(config)) return false;
  const res = await applyBridgePresence(baseUrl, token, "available");
  if (!res.ok) console.warn(`bridge presence: falha ao abrir o digitando: ${res.error}`);
  return true;
}

/** Fecha o colchete (depois do envio/paused). Best effort. */
export async function closeTypingPresenceBracket(
  config: { bridgePhoneNotifications?: boolean },
  baseUrl: string,
  token: string
): Promise<void> {
  if (!typingNeedsPresenceBracket(config)) return;
  const res = await applyBridgePresence(baseUrl, token, "unavailable");
  if (!res.ok) console.warn(`bridge presence: falha ao fechar o digitando: ${res.error}`);
}
