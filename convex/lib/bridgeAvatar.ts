/**
 * Foto de perfil pelo gateway (wuzapi `POST /user/avatar`) — adaptador PURO.
 *
 * MEDIDO no gateway de produção: HTTP 200, envelope `{code, data, success}`,
 * `data` com chaves minúsculas `url`, `id`, `type`, `direct_path`, `hash`.
 * `data.id` muda quando a pessoa troca a foto. `data.url` é do host
 * `pps.whatsapp.net` e expira em ~10 dias: NUNCA é guardada, só baixada.
 * NÃO medido (vem do upstream, tratado com tolerância): foto oculta → 500 com
 * "hidden their profile picture"; sem foto → 500 "does not have a profile
 * picture" / "no avatar found"; 429 possível.
 */

/** Teto do arquivo baixado (a miniatura medida tem ~2 KB). */
export const MAX_AVATAR_BYTES = 200 * 1024;
export const AVATAR_FETCH_TIMEOUT_MS = 10_000;

export type AvatarResponse =
  | { kind: "ok"; url: string; pictureId?: string }
  | { kind: "none" }
  | { kind: "hidden" }
  | { kind: "rate_limited" }
  | { kind: "error" };

function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Texto de erro do envelope (string crua, `error`, `message` ou `data` string). */
function errorText(body: unknown): string {
  if (typeof body === "string") return body;
  const candidates = [
    pick(body, "error", "Error"),
    pick(body, "message", "Message"),
    pick(body, "data", "Data"),
  ];
  return candidates.filter((c): c is string => typeof c === "string").join(" | ");
}

const RATE_LIMIT_RE = /rate.?limit|rate-overlimit|too many requests|overlimit/i;

/**
 * Interpreta a resposta do gateway. Nunca lança. `body` é o JSON já lido (ou o
 * texto cru quando não era JSON).
 */
export function parseAvatarResponse(status: number, body: unknown): AvatarResponse {
  if (status === 429) return { kind: "rate_limited" };
  const text = errorText(body);

  const envelopeCode = pick(body, "code", "Code");
  const envelopeSuccess = pick(body, "success", "Success");
  const failed =
    status < 200 ||
    status >= 300 ||
    envelopeSuccess === false ||
    (typeof envelopeCode === "number" && envelopeCode >= 400);

  if (failed) {
    if (RATE_LIMIT_RE.test(text) || envelopeCode === 429) return { kind: "rate_limited" };
    if (/hidden their profile picture/i.test(text)) return { kind: "hidden" };
    if (/does not have a profile picture|no avatar found/i.test(text)) return { kind: "none" };
    return { kind: "error" };
  }

  const data = pick(body, "data", "Data") ?? body;
  const url = pick(data, "url", "URL", "Url");
  if (typeof url !== "string" || url.length === 0) return { kind: "error" };
  const rawId = pick(data, "id", "ID", "Id");
  const pictureId =
    typeof rawId === "string" && rawId.length > 0
      ? rawId
      : typeof rawId === "number"
        ? String(rawId)
        : undefined;
  return { kind: "ok", url, ...(pictureId ? { pictureId } : {}) };
}

/** `https:` e host terminando em `.whatsapp.net` (senão recusa: sem SSRF). */
export function isAllowedAvatarUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host.endsWith(".whatsapp.net") && host.length > ".whatsapp.net".length;
  } catch {
    return false;
  }
}

export type AvatarMime = "image/jpeg" | "image/png" | "image/webp";

/** Tipo pelos primeiros bytes (o `Content-Type` do servidor não conta). */
export function sniffAvatarMime(bytes: Uint8Array): AvatarMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return null;
}

/** Valida o arquivo baixado: peso e tipo. `null` = recusado. */
export function validateAvatarBytes(bytes: Uint8Array): { mime: AvatarMime; size: number } | null {
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;
  const mime = sniffAvatarMime(bytes);
  return mime ? { mime, size: bytes.length } : null;
}

/** Corpo do `POST /user/avatar`: miniatura (96×96), a que a lista usa. */
export function buildAvatarRequestBody(phone: string): string {
  return JSON.stringify({ Phone: phone, Preview: true });
}

/**
 * Lê o corpo no máximo até `max` bytes (stream): passou disso, cancela a leitura e
 * devolve `null` — um servidor que ignora `Content-Length` não enche a memória.
 */
export async function readBodyCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
