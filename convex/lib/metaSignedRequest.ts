/**
 * `signed_request` dos callbacks da Meta (desautorizar / exclusão de dados). Puro:
 * sem rede, sem ctx. Formato: `<sig base64url>.<payload base64url>`, `sig` =
 * HMAC-SHA256 do payload (a parte base64url, como veio) com o App Secret.
 * O `user_id` nunca é logado.
 */

/** Tolerância do `issued_at`: a Meta reenvia, mas um pedido de dias atrás é replay. */
export const SIGNED_REQUEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Comparação em tempo constante (tokens de handshake/assinatura). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export type SignedRequestResult =
  | { ok: true; userId: string; issuedAt: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "bad_algorithm" | "bad_payload" | "expired" };

function base64UrlToBytes(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(input)) return null;
  try {
    const b64 = input.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacB64Url(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToBase64Url(new Uint8Array(mac));
}

/** Gera um `signed_request` (testes; em produção quem assina é a Meta). */
export async function signRequestPayload(payload: Record<string, unknown>, appSecret: string): Promise<string> {
  const enc = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${await hmacB64Url(enc, appSecret)}.${enc}`;
}

/** Nunca lança. `now` entra por argumento (sem `Date.now()` aqui). */
export async function parseSignedRequest(
  raw: string | null | undefined,
  appSecret: string,
  now: number
): Promise<SignedRequestResult> {
  if (!raw || !appSecret) return { ok: false, reason: "malformed" };
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [sig, payloadB64] = parts;

  const expected = await hmacB64Url(payloadB64, appSecret);
  // A Meta assina sem padding; tolera `=` no final do que recebemos.
  if (!safeEqual(sig.replace(/=+$/, ""), expected)) return { ok: false, reason: "bad_signature" };

  const bytes = base64UrlToBytes(payloadB64);
  if (!bytes) return { ok: false, reason: "bad_payload" };
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "bad_payload" };
  const p = payload as Record<string, unknown>;
  if (typeof p.algorithm !== "string" || p.algorithm.toUpperCase() !== "HMAC-SHA256") {
    return { ok: false, reason: "bad_algorithm" };
  }
  const userId = typeof p.user_id === "string" ? p.user_id : typeof p.user_id === "number" ? String(p.user_id) : "";
  if (!userId || !/^[0-9A-Za-z_-]{1,64}$/.test(userId)) return { ok: false, reason: "bad_payload" };
  const issued = typeof p.issued_at === "number" ? p.issued_at : Number(p.issued_at);
  if (!Number.isFinite(issued) || issued <= 0) return { ok: false, reason: "bad_payload" };
  const issuedAt = issued * 1000;
  if (now - issuedAt > SIGNED_REQUEST_MAX_AGE_MS) return { ok: false, reason: "expired" };
  return { ok: true, userId, issuedAt };
}
