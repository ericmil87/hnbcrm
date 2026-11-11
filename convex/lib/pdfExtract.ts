"use node";
/**
 * PDF → texto (P2.2 do onboarding v2), a partir do spike P0.5
 * (temp/landing-onboarding-v2/spikes/pdf/RELATORIO.md).
 *
 * `unpdf@2.1.0` (pdf.js embutido, sem binário nativo, empacota sozinho no
 * esbuild do Convex — sem `externalPackages`). Configurações de segurança do
 * relatório (seção 6):
 *  - `isEvalSupported:false` (caminho do CVE-2024-4367), sem fontes do SO, sem
 *    XFA, sem scripts, imagens não decodificadas (`maxImageSize` pequeno);
 *  - PDF com `/Encrypt` é recusado ANTES de abrir (inclusive só senha de dono);
 *  - pré-varredura dos streams Flate com `inflateSync({maxOutputLength})`:
 *    `Promise.race` NÃO protege contra bomba de descompressão (é síncrona na
 *    mesma thread), e a action Node tem 512 MB;
 *  - limites: 10 MB, 300 páginas declaradas (acima = recusa), 40 lidas,
 *    60.000 caracteres, prazo 20 s checado a cada página, 32 MB por stream e
 *    128 MB somados;
 *  - o buffer é COPIADO (o pdf.js destaca o ArrayBuffer que recebe);
 *  - escaneado (texto < 40 caracteres) → `{ text: "", scanned: true }`.
 * Nunca logar conteúdo nem nome do arquivo; só código de erro.
 */
import { inflateSync, constants as zlibConstants } from "node:zlib";
import { getDocumentProxy } from "unpdf";
import { cleanUntrustedText } from "./untrustedText";

export const PDF_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPages: 40,
  hardMaxPages: 300,
  maxChars: 60_000,
  timeoutMs: 20_000,
  minTextChars: 40,
  maxStreamOutBytes: 32 * 1024 * 1024,
  maxTotalInflateBytes: 128 * 1024 * 1024,
};
export type PdfLimits = typeof PDF_LIMITS;

export type PdfErrorCode =
  | "EMPTY"
  | "NOT_PDF"
  | "TOO_LARGE"
  | "ENCRYPTED"
  | "CORRUPT"
  | "TOO_MANY_PAGES"
  | "TOO_BIG_EXPANSION"
  | "TIMEOUT"
  | "PARSE_FAILED";

/** Mensagens curtas em PT-BR (podem ir ao usuário). */
export const PDF_ERROR_MESSAGES: Record<PdfErrorCode, string> = {
  EMPTY: "O arquivo está vazio.",
  NOT_PDF: "Não consegui abrir esse arquivo.",
  TOO_LARGE: "Arquivo grande demais; envie só as páginas com serviços e preços.",
  ENCRYPTED: "O PDF tem senha ou proteção. Exporte uma cópia sem proteção.",
  CORRUPT: "Não consegui abrir esse arquivo.",
  TOO_MANY_PAGES: "Arquivo grande demais; envie só as páginas com serviços e preços.",
  TOO_BIG_EXPANSION: "Não consegui abrir esse arquivo com segurança.",
  TIMEOUT: "O PDF demorou demais para ser lido.",
  PARSE_FAILED: "Não consegui ler esse PDF.",
};

export class PdfExtractError extends Error {
  readonly code: PdfErrorCode;
  constructor(code: PdfErrorCode) {
    super(PDF_ERROR_MESSAGES[code]);
    this.name = "PdfExtractError";
    this.code = code;
  }
}

export type PdfExtractResult = {
  text: string;
  scanned: boolean;
  numPages: number;
  pagesRead: number;
  truncated: boolean;
  invisibleChars: number;
  tagChars: number;
};

/** Pré-varredura barata: criptografado recusado; stream Flate que explode recusado. */
export function preflightPdf(bytes: Uint8Array, o: Pick<PdfLimits, "maxStreamOutBytes" | "maxTotalInflateBytes">): void {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = raw.subarray(0, 1024).toString("latin1");
  if (!head.includes("%PDF-")) throw new PdfExtractError("NOT_PDF");
  const s = raw.toString("latin1");
  if (/\/Encrypt\b/.test(s)) throw new PdfExtractError("ENCRYPTED");
  let total = 0;
  let pos = 0;
  while ((pos = s.indexOf("stream", pos)) !== -1) {
    if (pos >= 3 && s.startsWith("endstream", pos - 3)) {
      pos += 6;
      continue;
    }
    let start = pos + 6;
    if (s[start] === "\r") start++;
    if (s[start] === "\n") start++;
    const end = s.indexOf("endstream", start);
    if (end === -1) break;
    pos = end + 9;
    if (raw[start] !== 0x78) continue; // sem cabeçalho zlib: não é Flate simples
    let out: Buffer;
    try {
      out = inflateSync(raw.subarray(start, end), {
        maxOutputLength: o.maxStreamOutBytes,
        finishFlush: zlibConstants.Z_SYNC_FLUSH, // tolera stream truncado
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") throw new PdfExtractError("TOO_BIG_EXPANSION");
      continue; // stream corrompido: o pdf.js decide
    }
    total += out.length;
    if (total > o.maxTotalInflateBytes) throw new PdfExtractError("TOO_BIG_EXPANSION");
  }
}

type TextItem = { str?: string; hasEOL?: boolean };

/** `bytes` é copiado. Lança `PdfExtractError` (código tipado). */
export async function extractPdfText(bytes: Uint8Array, opts: Partial<PdfLimits> = {}): Promise<PdfExtractResult> {
  const o: PdfLimits = { ...PDF_LIMITS, ...opts };
  if (bytes.byteLength === 0) throw new PdfExtractError("EMPTY");
  if (bytes.byteLength > o.maxBytes) throw new PdfExtractError("TOO_LARGE");
  preflightPdf(bytes, o);
  const deadline = Date.now() + o.timeoutMs;
  const copy = new Uint8Array(bytes);
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfExtractError("TIMEOUT")), o.timeoutMs);
  });
  const work = (async (): Promise<PdfExtractResult> => {
    try {
      pdf = await getDocumentProxy(copy, {
        // pdf.js 6 já não tem o caminho de `eval` das fontes (a opção sumiu
        // dos tipos); fica explícita por defesa caso a versão regrida.
        ...({ isEvalSupported: false } as object),
        disableFontFace: true,
        useSystemFonts: false,
        enableXfa: false,
        stopAtErrors: false,
        verbosity: 0,
        maxImageSize: 1_000_000,
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "PasswordException") throw new PdfExtractError("ENCRYPTED");
      if (name === "InvalidPDFException" || name === "FormatError" || name === "MissingPDFException") {
        throw new PdfExtractError("CORRUPT");
      }
      throw new PdfExtractError("PARSE_FAILED");
    }
    const numPages = pdf.numPages;
    if (numPages > o.hardMaxPages) throw new PdfExtractError("TOO_MANY_PAGES");
    const last = Math.min(numPages, o.maxPages);
    const parts: string[] = [];
    let chars = 0;
    let truncated = numPages > last;
    let pagesRead = 0;
    let invisibleChars = 0;
    let tagChars = 0;
    for (let i = 1; i <= last; i++) {
      if (Date.now() > deadline) throw new PdfExtractError("TIMEOUT");
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      page.cleanup();
      const rawText = (tc.items as TextItem[])
        .map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : " "))
        .join("");
      const cleaned = cleanUntrustedText(rawText);
      invisibleChars += cleaned.stats.invisibleChars;
      tagChars += cleaned.stats.tagChars;
      pagesRead++;
      if (cleaned.text) {
        parts.push(cleaned.text);
        chars += cleaned.text.length + 2;
      }
      if (chars >= o.maxChars) {
        truncated = truncated || i < numPages || chars > o.maxChars;
        break;
      }
    }
    let text = parts.join("\n\n");
    if (text.length > o.maxChars) {
      text = text.slice(0, o.maxChars);
      truncated = true;
    }
    const hasText = text.replace(/\s/g, "").length >= o.minTextChars;
    return {
      text: hasText ? text : "",
      scanned: !hasText,
      numPages,
      pagesRead,
      truncated: hasText ? truncated : false,
      invisibleChars,
      tagChars,
    };
  })();
  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    if (e instanceof PdfExtractError) throw e;
    throw new PdfExtractError("PARSE_FAILED");
  } finally {
    clearTimeout(timer);
    try {
      await pdf?.loadingTask?.destroy();
    } catch {
      // já destruído
    }
  }
}
