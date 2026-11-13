/**
 * Bytes sintéticos de imagem para testes (montados em código: uma fixture em
 * base64 dispararia o guard `secretScan`). Só o cabeçalho é válido; não são
 * imagens decodificáveis.
 */

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const text = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const pad = (n: number) => new Array<number>(n).fill(0);

export function pngBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89, ...text("PNG\r\n\x1a\n"),
    ...be32(13), ...text("IHDR"), ...be32(width), ...be32(height), 8, 6, 0, 0, 0,
    ...pad(8),
  ]);
}

export function gifBytes(width: number, height: number, version: "87a" | "89a" = "89a"): Uint8Array {
  return new Uint8Array([...text(`GIF${version}`), ...le16(width), ...le16(height), 0, 0, 0, ...pad(8)]);
}

function riff(fourcc: string, payload: number[]): Uint8Array {
  return new Uint8Array([
    ...text("RIFF"), ...le32(4 + 8 + payload.length), ...text("WEBP"),
    ...text(fourcc), ...le32(payload.length), ...payload,
  ]);
}

/** WebP com perda (VP8): quadro-chave + código de início + 14 bits por lado. */
export function webpLossyBytes(width: number, height: number): Uint8Array {
  return riff("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), ...pad(8)]);
}

/** WebP sem perda (VP8L): assinatura 0x2F + (largura-1) e (altura-1) em 14 bits. */
export function webpLosslessBytes(width: number, height: number): Uint8Array {
  const bits = (width - 1) + (height - 1) * 0x4000;
  return riff("VP8L", [0x2f, ...le32(bits), ...pad(8)]);
}

/** WebP estendido (VP8X; animado/alfa): tela em 24 bits menos 1. */
export function webpExtendedBytes(width: number, height: number): Uint8Array {
  return riff("VP8X", [0x10, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), ...pad(8)]);
}

function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...be16(payload.length + 2), ...payload];
}

/** APP1/EXIF mínimo só com a tag de orientação (0x0112). */
export function exifSegment(orientation: number, littleEndian = false): number[] {
  const w16 = littleEndian ? le16 : be16;
  const w32 = littleEndian ? le32 : be32;
  return segment(0xe1, [
    ...text("Exif"), 0, 0,
    ...(littleEndian ? text("II") : text("MM")), ...w16(42), ...w32(8),
    ...w16(1),
    ...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), 0, 0,
    ...w32(0),
  ]);
}

export function jpegBytes(
  width: number,
  height: number,
  opts: {
    /** Marcador do SOF (0xC0 base, 0xC1 estendido, 0xC2 progressivo…). */
    sof?: number;
    orientation?: number;
    littleEndianExif?: boolean;
    /** Bytes de enchimento num APP2 antes do SOF (perfil ICC grande). */
    filler?: number;
  } = {}
): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  out.push(...segment(0xe0, [...text("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (opts.orientation !== undefined) out.push(...exifSegment(opts.orientation, opts.littleEndianExif));
  if (opts.filler) out.push(...segment(0xe2, pad(opts.filler)));
  // DQT e DHT falsos: precisam ser pulados (0xC4 NÃO é SOF).
  out.push(...segment(0xdb, pad(65)));
  out.push(...segment(0xc4, pad(20)));
  out.push(...segment(opts.sof ?? 0xc0, [8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  out.push(...segment(0xda, pad(10)), ...pad(16), 0xff, 0xd9);
  return new Uint8Array(out);
}
