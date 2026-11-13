/**
 * Caixa exibida de uma imagem no thread, calculada ANTES de ela carregar.
 *
 * Com `width`/`height` gravados no anexo, a bolha já nasce com o tamanho final
 * e nada se desloca quando a imagem chega (o Safari do iOS não tem âncora de
 * rolagem, então todo crescimento acima da tela empurra a leitura).
 *
 * A regra é a mesma do CSS de quem não tem dimensões (`max-w`/`max-h` com a
 * proporção preservada, sem ampliar): foto cabe em 240×240, figurinha em
 * 128×128. Única diferença: foto de proporção extrema (panorâmica, print
 * comprido) reduzida a uma tira ganha um lado menor mínimo e é recortada pelo
 * `object-cover`, nunca além do tamanho natural dela.
 */

export type AttachmentBox = { width: number; height: number };

export const IMAGE_BOX_MAX = 240;
export const STICKER_BOX_MAX = 128;
/** Lado menor mínimo de uma foto reduzida (só fotos; figurinha não recorta). */
export const IMAGE_BOX_MIN = 64;

function usable(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 1;
}

export function attachmentBox(
  width: unknown,
  height: unknown,
  kind: "image" | "sticker" = "image"
): AttachmentBox | null {
  if (!usable(width) || !usable(height)) return null;
  const max = kind === "sticker" ? STICKER_BOX_MAX : IMAGE_BOX_MAX;
  const scale = Math.min(1, max / width, max / height);
  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));
  if (kind === "image" && scale < 1) {
    // Nunca passa do tamanho natural: imagem de 2000×30 fica 240×30.
    w = Math.max(w, Math.min(IMAGE_BOX_MIN, Math.round(width)));
    h = Math.max(h, Math.min(IMAGE_BOX_MIN, Math.round(height)));
  }
  return { width: w, height: h };
}
