/**
 * Dimensões de imagem a partir dos PRIMEIROS bytes do arquivo (sem decodificar,
 * sem dependência). Serve para gravar `files.width`/`files.height` na entrada
 * da mídia e a bolha do thread já nascer com o tamanho final (sem salto de
 * rolagem quando a imagem carrega — o Safari do iOS não tem âncora de rolagem).
 *
 * Formatos: JPEG (SOFn, pulando APPn; orientação EXIF 5–8 troca largura e
 * altura, como o navegador exibe), PNG (IHDR), GIF (tela lógica) e WebP
 * (VP8, VP8L, VP8X).
 *
 * Limitações (devolvem `null`, e a UI cai no comportamento sem dimensões):
 *  - JPEG cujo SOF fica além dos bytes entregues (EXIF/ICC/miniatura grandes):
 *    quem chama com uma janela curta perde essas; `IMAGE_HEADER_BYTES` cobre a
 *    maioria.
 *  - Orientação gravada só em XMP (sem EXIF) não é lida.
 *  - HEIC/AVIF/BMP/TIFF/SVG não são lidos.
 *
 * Nunca lança. Valores fora de 1..`MAX_IMAGE_DIMENSION` viram `null`.
 */

export type ImageSize = { width: number; height: number };

export const MAX_IMAGE_DIMENSION = 20_000;

/** Janela sugerida para quem não tem o arquivo inteiro em mãos. */
export const IMAGE_HEADER_BYTES = 256 * 1024;

function valid(width: number, height: number): ImageSize | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1) return null;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) return null;
  return { width, height };
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) =>
  b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u32le = (b: Uint8Array, o: number) =>
  b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + b[o + 3] * 0x1000000;

function ascii(b: Uint8Array, o: number, text: string): boolean {
  if (o + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (b[o + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function readPng(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || !ascii(b, 12, "IHDR")) return null;
  return valid(u32be(b, 16), u32be(b, 20));
}

function readGif(b: Uint8Array): ImageSize | null {
  if (b.length < 10) return null;
  return valid(u16le(b, 6), u16le(b, 8));
}

function readWebp(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    // Quadro-chave com o código de início 9D 01 2A; 14 bits por lado.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return valid(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return valid((bits & 0x3fff) + 1, (Math.floor(bits / 0x4000) & 0x3fff) + 1);
  }
  if (ascii(b, 12, "VP8X")) {
    return valid(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return null;
}

/** Orientação EXIF (1–8) de um segmento APP1, ou `null`. */
function exifOrientation(b: Uint8Array, start: number, end: number): number | null {
  // "Exif\0\0" + cabeçalho TIFF (ordem de bytes, 42, deslocamento do IFD0).
  if (end - start < 14 || !ascii(b, start, "Exif") || b[start + 4] !== 0 || b[start + 5] !== 0) {
    return null;
  }
  const tiff = start + 6;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const big = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  const r16 = (o: number) => (little ? u16le(b, o) : u16be(b, o));
  const r32 = (o: number) => (little ? u32le(b, o) : u32be(b, o));
  if (r16(tiff + 2) !== 42) return null;
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (r16(entry) === 0x0112) {
      const value = r16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

function readJpeg(b: Uint8Array): ImageSize | null {
  let o = 2;
  let orientation: number | null = null;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1];
    // Preenchimento (FF FF …): anda um byte.
    if (marker === 0xff) {
      o += 1;
      continue;
    }
    // Marcadores sem carga: RSTn, SOI, TEM.
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      o += 2;
      continue;
    }
    // Fim da imagem ou início dos dados comprimidos sem SOF antes: desiste.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, o + 2);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (o + 9 > b.length) return null;
      const height = u16be(b, o + 5);
      const width = u16be(b, o + 7);
      return orientation !== null && orientation >= 5
        ? valid(height, width)
        : valid(width, height);
    }
    if (marker === 0xe1 && orientation === null) {
      orientation = exifOrientation(b, o + 4, Math.min(b.length, o + 2 + length));
    }
    o += 2 + length;
  }
  return null;
}

/** Lê `{ width, height }` dos primeiros bytes de uma imagem; `null` se não der. */
export function readImageSize(bytes: Uint8Array | ArrayBuffer | null | undefined): ImageSize | null {
  try {
    if (!bytes) return null;
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 10) return null;
    if (b[0] === 0xff && b[1] === 0xd8) return readJpeg(b);
    if (b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n")) return readPng(b);
    if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return readGif(b);
    if (ascii(b, 0, "RIFF")) return readWebp(b);
    return null;
  } catch {
    return null;
  }
}

/**
 * Par de dimensões vindo de fora (navegador, REST): só passa se os dois forem
 * inteiros em 1..`MAX_IMAGE_DIMENSION`; senão `{}` (ignora, sem erro).
 */
export function sanitizeImageSize(
  mimeType: string,
  width: unknown,
  height: unknown
): ImageSize | Record<string, never> {
  if (!mimeType.toLowerCase().startsWith("image/")) return {};
  if (typeof width !== "number" || typeof height !== "number") return {};
  return valid(width, height) ?? {};
}

/**
 * Campos prontos para espalhar num insert/args (`{ width, height }` ou `{}`),
 * para quem tem os bytes em mãos. Só mede `image/*`.
 */
export function imageSizeFields(
  mimeType: string,
  bytes: Uint8Array | ArrayBuffer | null | undefined
): ImageSize | Record<string, never> {
  if (!mimeType.toLowerCase().startsWith("image/")) return {};
  return readImageSize(bytes) ?? {};
}

/** Junta o começo de uma lista de pedaços (stream lido em chunks) até `max` bytes. */
export function headOfChunks(chunks: readonly Uint8Array[], max = IMAGE_HEADER_BYTES): Uint8Array {
  let total = 0;
  for (const c of chunks) {
    total += c.byteLength;
    if (total >= max) break;
  }
  const out = new Uint8Array(Math.min(total, max));
  let o = 0;
  for (const c of chunks) {
    if (o >= out.length) break;
    const part = c.byteLength > out.length - o ? c.subarray(0, out.length - o) : c;
    out.set(part, o);
    o += part.byteLength;
  }
  return out;
}
