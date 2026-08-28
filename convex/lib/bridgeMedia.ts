/**
 * Pure adapter for the wuzapi (whatsmeow) media DOWNLOAD API — the inbound half
 * of Wave U4 for the unofficial WhatsApp "bridge" provider. No Convex context and
 * no fetch: it only builds the download request from a whatsmeow media descriptor
 * and interprets the response, so it is trivially unit-testable. The action
 * (convex/bridge.ts) owns the actual fetch + storage.
 *
 * wuzapi returns media ALREADY DECRYPTED over REST (it holds the session keys),
 * so the CRM never has to reimplement the whatsmeow mediaKey/HKDF/AES decrypt —
 * it hands wuzapi the descriptor (URL/DirectPath/MediaKey/FileSHA256/…) and gets
 * back the plaintext bytes as base64.
 *
 * ⚠️ The exact wuzapi download contract is NOT confirmed against a live gateway —
 * the pilot (U6) validates it. Everything marked `VALIDAR:` is the current best
 * assumption; the parser is deliberately tolerant of casing and of a base64 vs
 * data-URI response so it survives whichever serialization wuzapi emits.
 */

import type { BridgeSendRequest } from "./bridgeSend";

export type BridgeDownloadResult =
  | { ok: true; base64: string; mimeType?: string }
  | { ok: false; error: string };

/** whatsmeow media kinds we carry from the ingress parser (bridgeParse.ts). */
export type BridgeMediaKind = "image" | "sticker" | "audio" | "video" | "document";

// kind → wuzapi download endpoint. Stickers are webp images and have no dedicated
// download route, so they reuse the image one.
// VALIDAR: paths `/chat/download{image,video,audio,document}` against live wuzapi.
const DOWNLOAD_PATH: Record<BridgeMediaKind, string> = {
  image: "/chat/downloadimage",
  sticker: "/chat/downloadimage",
  audio: "/chat/downloadaudio",
  video: "/chat/downloadvideo",
  document: "/chat/downloaddocument",
};

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

/**
 * Best-effort FileLength from the descriptor, so the action can skip an oversized
 * download BEFORE fetching the bytes. Returns undefined when absent/unparseable
 * (whatsmeow serializes uint64 as a JSON string).
 */
export function descriptorFileLength(descriptor: Record<string, any> | undefined): number | undefined {
  const raw = pick(descriptor, "fileLength", "FileLength", "fileLen", "size", "Size");
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

// ── O que da mídia do bridge PODE ser persistido ─────────────────────────────
//
// O descriptor do whatsmeow é MATERIAL CRIPTOGRÁFICO: `MediaKey` é a chave que
// decifra o blob na CDN do WhatsApp, e `FileEncSHA256`/`FileSHA256` são os
// hashes que o acompanham. Guardar isso em `messages.metadata` — texto claro, em
// registro que fica para sempre — é vazamento esperando acontecer. O descriptor
// só serve DURANTE o download (a action monta o request e joga fora); depois é
// lixo sensível.
//
// Duas camadas, no espírito de `lib/exportSanitize.ts`:
//  1. allowlist do que fica (o que serve para diagnóstico depois do fato);
//  2. denylist explícita de campos de chave, aplicada por cima — assim, se
//     alguém acrescentar campo à allowlist ou ao parser, a chave não passa.

/** Campos de chave/hash que NUNCA podem ser persistidos (nome normalizado). */
export const MEDIA_KEY_DENY_PATTERNS: readonly RegExp[] = [
  /mediakey/,
  /encsha/,
  /filesha/,
  /\bsha256\b/,
  /secret/,
  /key$/,
];

/** minúsculas, só letras e dígitos (`media_key` → `mediakey`). */
function normalizeMediaField(key: string): string {
  return String(key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `true` se o campo carrega (ou pode carregar) material de chave. */
export function isMediaKeyField(key: string): boolean {
  const normalized = normalizeMediaField(key);
  if (normalized === "") return false;
  return MEDIA_KEY_DENY_PATTERNS.some((pattern) => pattern.test(normalized));
}

const MAX_STRIP_DEPTH = 12;

/**
 * Varre um valor (objeto/array) removendo TODO campo de chave, em qualquer
 * profundidade. Rede de segurança para o resto do `metadata` da mensagem — o
 * parser guarda o evento cru em `metadata.raw` quando não reconhece o tipo
 * (`lib/bridgeParse.ts`), e um tipo de mídia não suportado levaria o descriptor
 * inteiro junto. Usada no ingest e no backfill.
 */
export function stripMediaKeyMaterial(value: unknown, depth = 0): unknown {
  if (depth > MAX_STRIP_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map((item) => stripMediaKeyMaterial(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined || isMediaKeyField(key)) continue;
      out[key] = stripMediaKeyMaterial(child, depth + 1);
    }
    return out;
  }
  return value;
}

/** Forma segura de `metadata.bridgeMedia` — só diagnóstico, zero segredo. */
export type SafeBridgeMediaMeta = {
  kind?: string;
  mimeType?: string;
  filename?: string;
  fileLength?: number;
};

/**
 * Reduz a mídia recebida do webhook ao que pode ficar gravado na mensagem:
 * tipo, mimetype, nome e tamanho. O descriptor inteiro (com `MediaKey`) fica
 * SÓ na memória da action que faz o download.
 */
export function sanitizeBridgeMediaMeta(media: {
  kind?: string;
  mimeType?: string;
  filename?: string;
  descriptor?: Record<string, any>;
  [key: string]: any;
}): SafeBridgeMediaMeta {
  const safe: SafeBridgeMediaMeta = {};
  if (typeof media?.kind === "string" && media.kind) safe.kind = media.kind;
  if (typeof media?.mimeType === "string" && media.mimeType) safe.mimeType = media.mimeType;
  if (typeof media?.filename === "string" && media.filename) safe.filename = media.filename;
  // `descriptor` no ingest; no re-processamento (backfill) o tamanho já está no
  // topo — ler dos dois mantém a função idempotente.
  const fileLength = descriptorFileLength(media?.descriptor) ?? descriptorFileLength(media);
  if (fileLength !== undefined) safe.fileLength = fileLength;

  // Camada 2: a allowlist acima já não copia chave nenhuma; esta varredura é a
  // rede de segurança para quando ela crescer.
  for (const key of Object.keys(safe) as Array<keyof SafeBridgeMediaMeta>) {
    if (isMediaKeyField(key)) delete safe[key];
  }
  return safe;
}

/**
 * Build the POST request that asks wuzapi to download + decrypt one media node.
 *
 * The body echoes the whatsmeow media descriptor fields wuzapi needs to fetch and
 * decrypt from WhatsApp's CDN. We emit the Go/PascalCase spelling wuzapi's struct
 * expects, reading them tolerantly from whatever casing the webhook delivered.
 *
 * VALIDAR: the exact body wuzapi's download handler decodes (field names +
 * whether MediaKey/FileEncSHA256/FileSHA256 must be base64 vs hex). We pass the
 * descriptor values through unchanged — wuzapi emitted them, so it round-trips.
 */
export function buildBridgeDownloadRequest(params: {
  baseUrl: string;
  token: string;
  kind: BridgeMediaKind;
  descriptor: Record<string, any>;
}): BridgeSendRequest {
  const base = params.baseUrl.replace(/\/+$/, "");
  const d = params.descriptor ?? {};

  const body: Record<string, unknown> = {
    Url: pick(d, "url", "URL", "Url"),
    DirectPath: pick(d, "directPath", "DirectPath"),
    MediaKey: pick(d, "mediaKey", "MediaKey"),
    Mimetype: pick(d, "mimetype", "Mimetype", "mimeType"),
    FileEncSHA256: pick(d, "fileEncSha256", "FileEncSHA256", "fileEncSHA256"),
    FileSHA256: pick(d, "fileSha256", "FileSHA256", "fileSHA256"),
    FileLength: pick(d, "fileLength", "FileLength"),
  };
  // Drop undefined keys so the JSON stays clean for the gateway.
  for (const k of Object.keys(body)) {
    if (body[k] === undefined) delete body[k];
  }

  return {
    url: `${base}${DOWNLOAD_PATH[params.kind]}`,
    headers: {
      "Content-Type": "application/json",
      token: params.token,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Split a `data:<mime>;base64,<payload>` URI; returns raw string untouched
 * otherwise. CONFIRMADO no piloto: mimetypes com parâmetro — p.ex. mensagens de
 * voz `audio/ogg; codecs=opus` — carregam `;` extra, então o parse é pela
 * PRIMEIRA vírgula (regex por `;` quebrava e o atob recebia o "data:" cru).
 */
function stripDataUri(value: string): { base64: string; mimeType?: string } {
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    if (comma > -1) {
      const meta = value.slice(5, comma); // ex.: "audio/ogg; codecs=opus;base64"
      const mime = meta.replace(/;\s*base64\s*$/i, "").trim();
      return { base64: value.slice(comma + 1), mimeType: strUndef(mime) };
    }
  }
  return { base64: value };
}

/**
 * Interpret a wuzapi download response into decrypted base64 bytes (+ mime type)
 * or a readable error.
 *
 * VALIDAR: assumed success envelope is
 *   { code: 200, success: true, data: { Data: "data:image/jpeg;base64,…", Mimetype } }
 * We also accept a bare base64 payload and several field spellings so the parser
 * survives variants. wuzapi may instead stream raw bytes for some builds — that
 * path is handled in the action (non-JSON response), not here.
 */
export function parseBridgeDownloadResponse(
  httpOk: boolean,
  status: number,
  responseBody: unknown
): BridgeDownloadResult {
  const b = (responseBody && typeof responseBody === "object" ? responseBody : {}) as Record<string, any>;
  const data = (b.data ?? b.Data ?? {}) as Record<string, any>;

  const explicitFail = b.success === false || b.Success === false;

  const rawPayload =
    (typeof data === "object"
      ? strUndef(pick(data, "Data", "data", "Base64", "base64", "Media", "media"))
      : undefined) ??
    // Some builds may return the payload at the top level.
    strUndef(pick(b, "Data", "Base64", "base64"));

  if (httpOk && !explicitFail && rawPayload) {
    const { base64, mimeType } = stripDataUri(rawPayload);
    const declaredMime =
      strUndef(pick(data, "Mimetype", "mimetype", "mimeType")) ??
      strUndef(pick(b, "Mimetype", "mimetype")) ??
      mimeType;
    if (base64.length === 0) {
      return { ok: false, error: "Gateway retornou mídia vazia" };
    }
    return { ok: true, base64, mimeType: declaredMime };
  }

  const error =
    strUndef(pick(b, "error", "Error", "message", "Message")) ??
    (httpOk && !rawPayload
      ? "Gateway não retornou os bytes da mídia"
      : `Falha ao baixar mídia (HTTP ${status})`);
  return { ok: false, error };
}

/** Decode a base64 string to bytes (Convex + Node both expose atob). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode bytes to base64 in chunks (avoids arg-count limits on fromCharCode). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Build the `data:<mime>;base64,<payload>` URI wuzapi's send endpoints expect. */
export function toDataUri(bytes: Uint8Array, mimeType: string): string {
  const mime = mimeType && mimeType.length > 0 ? mimeType : "application/octet-stream";
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}
