/**
 * Imagem JPEG embutida num PDF ESCANEADO — puro, sem Node, sem inflar nada.
 *
 * PDF escaneado (sem camada de texto) costuma ser uma imagem por página, e o
 * scanner/app grava essa imagem com `/Filter /DCTDecode`: o stream cru JÁ É um
 * arquivo JPEG. Em vez de rasterizar a página (não há canvas nativo numa action
 * do Convex), recortamos os bytes do stream e entregamos ao MESMO passe de
 * visão que descreve imagens do WhatsApp.
 *
 * Segurança: nenhum filtro é decodificado (só `slice` de bytes já presentes no
 * arquivo, que o chamador limita a ≤ 5 MB), então não há expansão de memória.
 * Só aceita dicionário com UM filtro (DCTDecode), `/Subtype /Image`, sem
 * `/ImageMask`, JPEG com SOI/EOI e 1 ou 3 componentes (CMYK/YCCK vira recusa).
 *
 * Limite conhecido (honesto): sem percorrer a árvore de páginas, "a imagem da
 * 1ª página" é aproximada por "o primeiro stream JPEG grande, na ordem do
 * arquivo". Para comprovante/recibo de 1 página (o caso real) é exata; num PDF
 * escaneado de várias páginas gravado fora de ordem pode vir outra página.
 */

export type EmbeddedJpeg = { bytes: Uint8Array; width: number; height: number };

/** JPEGs menores que isto são logotipo/carimbo, não a página escaneada. */
export const EMBEDDED_JPEG_MIN_BYTES = 8 * 1024;
const MIN_SIDE_PX = 200;
const MAX_STREAMS_SCANNED = 2000;
const MAX_DICT_CHARS = 4000;

function latin1(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  }
  return parts.join("");
}

/** Componentes do primeiro SOF (0xC0..0xCF, menos DHT/JPG/DAC); null se ilegível. */
function jpegComponents(jpeg: Uint8Array): number | null {
  let i = 2;
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return i + 9 < jpeg.length ? jpeg[i + 9] : null;
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function filterNames(dict: string): string[] | null {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (!m) return null;
  return [...m[1].matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]);
}

export function findFirstEmbeddedJpeg(pdf: Uint8Array, maxBytes: number): EmbeddedJpeg | null {
  const text = latin1(pdf);
  const re = /stream(?:\r\n|\n)/g;
  let seen = 0;
  for (let m = re.exec(text); m && seen < MAX_STREAMS_SCANNED; m = re.exec(text)) {
    seen++;
    const streamAt = m.index;
    // "endstream" também casa com /stream/: ignore.
    if (streamAt >= 3 && text.slice(streamAt - 3, streamAt) === "end") continue;
    const objAt = text.lastIndexOf("obj", streamAt);
    if (objAt < 0 || streamAt - objAt > MAX_DICT_CHARS) continue;
    const dict = text.slice(objAt, streamAt);
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    if (/\/ImageMask\s+true\b/.test(dict)) continue;
    const filters = filterNames(dict);
    if (!filters || filters.length !== 1 || (filters[0] !== "DCTDecode" && filters[0] !== "DCT")) continue;
    const width = Number(/\/Width\s+(\d+)/.exec(dict)?.[1]);
    const height = Number(/\/Height\s+(\d+)/.exec(dict)?.[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    if (width < MIN_SIDE_PX || height < MIN_SIDE_PX) continue;
    const start = streamAt + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    while (stop > start && (text.charCodeAt(stop - 1) === 0x0a || text.charCodeAt(stop - 1) === 0x0d)) stop--;
    const size = stop - start;
    if (size < EMBEDDED_JPEG_MIN_BYTES || size > maxBytes) continue;
    const jpeg = pdf.slice(start, stop);
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) continue;
    if (jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) continue;
    const comps = jpegComponents(jpeg);
    if (comps !== 1 && comps !== 3) continue;
    return { bytes: jpeg, width, height };
  }
  return null;
}
