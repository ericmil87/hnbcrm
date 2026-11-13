/**
 * Mede largura/altura de uma imagem no navegador antes do upload, para o
 * servidor gravar em `files.width`/`height` (a mutation não lê o blob).
 *
 * Usa `<img>` + `naturalWidth/Height` de propósito: é o mesmo caminho que
 * desenha a imagem no thread, então a orientação EXIF já vem aplicada em todo
 * navegador atual (o `createImageBitmap` varia). Nunca lança nem trava o
 * envio: qualquer falha (formato que o navegador não abre, demora) devolve
 * `null` e o arquivo sobe sem dimensões.
 */

export type MeasuredImage = { width: number; height: number };

const MEASURE_TIMEOUT_MS = 4000;

export function measureImageFile(file: Blob, timeoutMs = MEASURE_TIMEOUT_MS): Promise<MeasuredImage | null> {
  if (!file.type.toLowerCase().startsWith("image/")) return Promise.resolve(null);
  if (typeof Image === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve(null);
      return;
    }
    const img = new Image();
    let settled = false;
    const finish = (result: MeasuredImage | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        URL.revokeObjectURL(url);
      } catch {
        // sem efeito
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      finish(width > 0 && height > 0 ? { width, height } : null);
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}
