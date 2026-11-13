/**
 * Regras puras de arquivo no composer: colar (Ctrl/Cmd+V) e arrastar-e-soltar
 * passam pelo mesmo upload do botão de clipe; aqui só se decide o que fazer
 * com o `DataTransfer` (extrair arquivos, nomear, interceptar ou não).
 */

export const ACCEPTED_ATTACHMENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "application/json",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/3gpp",
] as const;

/** Máximo de anexos por mensagem (o limite por canal fica na validação do canal). */
export const MAX_ATTACHMENTS = 5;

/** Subconjunto de `DataTransfer` que as regras leem (facilita o teste). */
export interface TransferLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
  types?: ArrayLike<string> | null;
  getData?: (format: string) => string;
}

/** Arrastando arquivo (e não texto selecionado, link ou elemento da página)? */
export function isFileDrag(dt: TransferLike | null | undefined): boolean {
  if (!dt?.types) return false;
  return Array.from(dt.types).includes("Files");
}

/** Arquivos do `DataTransfer`: `files`, ou `items` quando `files` vem vazio (sem duplicar). */
export function filesFromTransfer(dt: TransferLike | null | undefined): File[] {
  if (!dt) return [];
  const direct = dt.files ? Array.from(dt.files) : [];
  if (direct.length > 0) return direct;
  const out: File[] = [];
  for (const item of dt.items ? Array.from(dt.items) : []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

const pad = (n: number, size = 2) => String(n).padStart(size, "0");

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
};

/** Nomes que os navegadores dão a captura de tela/imagem copiada. */
function isGenericName(name: string): boolean {
  return name.trim() === "" || /^image\.[a-z0-9]+$/i.test(name.trim());
}

/** `imagem-colada-AAAAMMDD-HHMMSS.png` para colagem sem nome de verdade. */
export function pastedFileName(file: { name: string; type: string }, now: Date): string {
  if (!isGenericName(file.name)) return file.name;
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const mime = file.type.split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[mime] ?? (mime.startsWith("image/") ? "png" : "bin");
  const isImage = mime.startsWith("image/") || mime === "";
  return `${isImage ? "imagem-colada" : "arquivo-colado"}-${stamp}.${ext}`;
}

export type PasteDecision =
  | { intercept: false }
  | { intercept: true; files: File[] };

/**
 * Colar: só intercepta quando há arquivo. Planilha/Word copiados trazem texto
 * E uma imagem genérica ("image.png"): nesse caso o texto vence e o colar segue
 * normal. Arquivo com nome de verdade (copiado no gerenciador de arquivos)
 * anexa mesmo com o nome em texto na área de transferência.
 */
export function decidePaste(dt: TransferLike | null | undefined, now: Date): PasteDecision {
  const files = filesFromTransfer(dt);
  if (files.length === 0) return { intercept: false };
  const hasText = (dt?.getData?.("text/plain") ?? "").trim() !== "";
  if (hasText && files.every((f) => isGenericName(f.name))) return { intercept: false };
  return {
    intercept: true,
    files: files.map((file) => {
      const name = pastedFileName(file, now);
      return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
    }),
  };
}
