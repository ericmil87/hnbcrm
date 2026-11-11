"use node";
/**
 * PDF → texto (P2.2 do onboarding v2), a partir do spike P0.5
 * (temp/landing-onboarding-v2/spikes/pdf/RELATORIO.md) e da revisão do P2.2.
 *
 * `unpdf@2.1.0` (pdf.js embutido, sem binário nativo). Camadas:
 *  1. Tamanho (10 MB) e `%PDF-` nos primeiros 1024 bytes.
 *  2. Pré-varredura (`preflightPdf`), na thread principal, ANTES do pdf.js:
 *     - `/Encrypt` → recusa (inclusive só senha de dono);
 *     - para cada stream, lê o `/Filter` do dicionário (direto ou indireto,
 *       nome ou cadeia) e DECODIFICA a cadeia com teto: ASCIIHex e ASCII85
 *       antes, Flate com qualquer cabeçalho zlib que o pdf.js aceitaria
 *       (`(cmf & 0x0f) === 8`, `((cmf<<8)|flg) % 31 === 0`, sem dicionário);
 *       LZW, RunLength, Crypt e filtros desconhecidos → recusa; filtros de
 *       imagem (DCT/JPX/CCITT/JBIG2) só no fim da cadeia;
 *     - o dado é decodificado do início do stream até o fim natural do
 *       codec (fim do deflate, `>` do ASCIIHex, `~>` do ASCII85) — nunca até
 *       `/Length` nem até o primeiro `endstream`: o pdf.js ignora `/Length`
 *       errado e um `endstream` literal no meio do dado enganaria a varredura;
 *     - tetos: 16 MB por stream e 48 MB somados (ver PDF_LIMITS).
 *  3. pdf.js num `worker_threads` com prazo: no fim do prazo, `terminate()`
 *     mata a thread mesmo no meio de trabalho síncrono (Promise.race não
 *     interrompe a descompressão/parse síncronos). O código do worker é uma
 *     string (`eval: true`, nada a empacotar) e importa o `unpdf` pelo caminho
 *     absoluto resolvido aqui — por isso `unpdf` está em
 *     `convex.json → node.externalPackages` (instalado no deploy). Se o
 *     worker não puder subir (pacote não resolvível, worker_threads
 *     indisponível), cai para a execução na própria thread com o mesmo prazo
 *     cooperativo por página (o comportamento anterior).
 *  Configurações do pdf.js: sem fontes do SO, sem XFA, sem scripts, imagens
 *  não decodificadas (`maxImageSize`); `isEvalSupported:false` explícito
 *  (o pdf.js 6 já não tem o caminho de `eval`).
 *  Escaneado (texto < 40 caracteres) → `{ text: "", scanned: true }`.
 *  Nunca logar conteúdo nem nome do arquivo; só código de erro.
 */
import { inflateRawSync, constants as zlibConstants } from "node:zlib";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { getDocumentProxy } from "unpdf";
import { cleanUntrustedText } from "./untrustedText";

/**
 * Tetos da pré-varredura: 16 MB por stream e 48 MB somados. A action Node tem
 * 512 MB; o spike mediu ~2,1× de RSS sobre o volume descomprimido (400 MB →
 * 854 MB) e ~70–100 MB de base. 48 MB × ~2,1 + base fica perto de 200 MB,
 * com folga para a cópia do arquivo e o worker. Um PDF de texto de 40
 * páginas tem poucos MB de streams (conteúdo + fontes). Efeito colateral
 * aceito: PDF escaneado com muitas imagens Flate grandes é recusado
 * (TOO_BIG_EXPANSION) — o caminho para esse material é foto/print na visão.
 */
export const PDF_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPages: 40,
  hardMaxPages: 300,
  maxChars: 60_000,
  timeoutMs: 20_000,
  minTextChars: 40,
  maxStreamOutBytes: 16 * 1024 * 1024,
  maxTotalInflateBytes: 48 * 1024 * 1024,
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
  | "UNSUPPORTED_FILTER"
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
  UNSUPPORTED_FILTER: "Esse PDF usa um formato interno que não leio por segurança. Exporte de novo como PDF.",
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
  /** Onde o pdf.js rodou (diagnóstico). */
  isolation: "worker" | "inline";
};

// ---------------------------------------------------------------------------
// Pré-varredura
// ---------------------------------------------------------------------------

const FILTER_ALIASES: Record<string, string> = {
  Fl: "FlateDecode",
  AHx: "ASCIIHexDecode",
  A85: "ASCII85Decode",
  LZW: "LZWDecode",
  RL: "RunLengthDecode",
  CCF: "CCITTFaxDecode",
  DCT: "DCTDecode",
};
const IMAGE_FILTERS = new Set(["DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode"]);

type PreflightLimits = Pick<PdfLimits, "maxStreamOutBytes" | "maxTotalInflateBytes">;

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}
function hexVal(c: number): number {
  return c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x61 + 10;
}

/** ASCIIHexDecode até `>` (ou o fim), ignorando o que não é hex, como o pdf.js. */
export function decodeAsciiHex(input: Uint8Array, cap: number): Uint8Array {
  const out = new Uint8Array(Math.min(cap + 1, Math.ceil(input.length / 2) + 1));
  let n = 0;
  let hi = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x3e) break; // '>'
    if (!isHex(c)) continue;
    if (hi < 0) hi = hexVal(c);
    else {
      if (n >= cap) throw new PdfExtractError("TOO_BIG_EXPANSION");
      out[n++] = (hi << 4) | hexVal(c);
      hi = -1;
    }
  }
  if (hi >= 0) {
    if (n >= cap) throw new PdfExtractError("TOO_BIG_EXPANSION");
    out[n++] = hi << 4;
  }
  return out.subarray(0, n);
}

/** ASCII85Decode até `~>` (ou o fim); `z` = 4 zeros. */
export function decodeAscii85(input: Uint8Array, cap: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let buf = new Uint8Array(Math.min(cap, 1 << 16) + 4);
  let n = 0;
  let total = 0;
  const push = (b: number) => {
    if (total >= cap) throw new PdfExtractError("TOO_BIG_EXPANSION");
    if (n === buf.length) {
      chunks.push(buf);
      buf = new Uint8Array(buf.length);
      n = 0;
    }
    buf[n++] = b;
    total++;
  };
  const group: number[] = [];
  const flush = (count: number) => {
    while (group.length < 5) group.push(84); // 'u' - 33
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    for (let k = 0; k < count; k++) push(bytes[k]);
    group.length = 0;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x7e) break; // '~' (de "~>")
    if (c <= 0x20) continue;
    if (c === 0x7a && group.length === 0) {
      for (let k = 0; k < 4; k++) push(0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 33);
    if (group.length === 5) flush(4);
  }
  if (group.length > 1) flush(group.length - 1);
  chunks.push(buf.subarray(0, n));
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Flate como o pdf.js: cabeçalho zlib válido; inflate cru com teto. null = pdf.js recusaria. */
export function inflateLikePdfJs(input: Uint8Array, cap: number): Uint8Array | null {
  if (input.length < 2) return null;
  const cmf = input[0];
  const flg = input[1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) return null;
  try {
    return inflateRawSync(input.subarray(2), {
      maxOutputLength: cap,
      finishFlush: zlibConstants.Z_SYNC_FLUSH, // tolera truncado
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") throw new PdfExtractError("TOO_BIG_EXPANSION");
    return null; // corrompido: o pdf.js também não expande
  }
}

/** Índice "num gen" → posição do corpo do objeto (último vence, como em atualização incremental). */
function indexObjects(s: string): Map<string, number> {
  const idx = new Map<string, number>();
  const re = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) idx.set(`${m[1]} ${m[2]}`, m.index + m[0].length);
  return idx;
}

function resolveObjectText(s: string, objIndex: Map<string, number>, num: string, gen: string): string | null {
  const at = objIndex.get(`${num} ${gen}`);
  if (at === undefined) return null;
  const end = s.indexOf("endobj", at);
  return s.slice(at, end === -1 ? Math.min(s.length, at + 512) : Math.min(end, at + 512));
}

/** Cadeias de filtro do dicionário (todas as ocorrências de /Filter). null = não resolvível. */
export function parseFilterChains(dict: string, s = "", objIndex = new Map<string, number>()): string[][] | null {
  const chains: string[][] = [];
  const re = /\/Filter\s*(\[[^\]]{0,512}\]|\/[A-Za-z0-9.#_-]{1,64}|(\d{1,10})\s+(\d{1,5})\s+R)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dict))) {
    let value = m[1];
    if (m[2] !== undefined) {
      const resolved = resolveObjectText(s, objIndex, m[2], m[3]);
      if (resolved === null) return null;
      const inner = /^\s*(\[[^\]]{0,512}\]|\/[A-Za-z0-9.#_-]{1,64})/.exec(resolved);
      if (!inner) return null;
      value = inner[1];
    }
    const names = (value.match(/\/[A-Za-z0-9.#_-]+/g) ?? []).map((x) => {
      const name = x.slice(1);
      return FILTER_ALIASES[name] ?? name;
    });
    if (value.startsWith("[") && /\d+\s+\d+\s+R/.test(value)) return null; // referência dentro da cadeia
    chains.push(names);
  }
  return chains;
}

/** Decodifica a cadeia com teto; devolve o tamanho final. Lança se perigoso. */
export function measureFilterChain(data: Uint8Array, chain: string[], cap: number): number {
  let cur = data;
  for (let i = 0; i < chain.length; i++) {
    const f = chain[i];
    if (f === "ASCIIHexDecode") cur = decodeAsciiHex(cur, cap);
    else if (f === "ASCII85Decode") cur = decodeAscii85(cur, cap);
    else if (f === "FlateDecode") {
      const out = inflateLikePdfJs(cur, cap);
      if (out === null) return 0; // o pdf.js trata como stream vazio
      cur = out;
    } else if (IMAGE_FILTERS.has(f)) {
      if (i !== chain.length - 1) throw new PdfExtractError("UNSUPPORTED_FILTER");
      return cur.length; // imagem: não decodificada na extração de texto
    } else {
      // LZWDecode, RunLengthDecode, Crypt e qualquer nome desconhecido
      throw new PdfExtractError("UNSUPPORTED_FILTER");
    }
  }
  return chain.length ? cur.length : 0;
}

/** Fim do dado pelo /Length (número), null sem /Length, "unresolved" se indireto e não achado. */
function streamLengthEnd(
  dict: string,
  s: string,
  objIndex: Map<string, number>,
  start: number
): number | null | "unresolved" {
  const m = /\/Length\s+(\d{1,10})(?:\s+(\d{1,5})\s+R)?/.exec(dict);
  if (!m) return null;
  let len: number;
  if (m[2] !== undefined) {
    const txt = resolveObjectText(s, objIndex, m[1], m[2]);
    const n = txt === null ? null : /^\s*(\d{1,10})/.exec(txt);
    if (!n) return "unresolved";
    len = Number(n[1]);
  } else {
    len = Number(m[1]);
  }
  return Number.isFinite(len) ? Math.min(start + len, s.length) : null;
}

/**
 * Pré-varredura: criptografado recusado; cada stream com filtro é
 * decodificado (com teto) do início até o fim natural do codec.
 */
export function preflightPdf(bytes: Uint8Array, o: PreflightLimits): void {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = raw.subarray(0, 1024).toString("latin1");
  if (!head.includes("%PDF-")) throw new PdfExtractError("NOT_PDF");
  const s = raw.toString("latin1");
  if (/\/Encrypt\b/.test(s)) throw new PdfExtractError("ENCRYPTED");
  const objIndex = indexObjects(s);
  const kw = /stream(\r\n|\n|\r)/g;
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = kw.exec(s))) {
    const pos = m.index;
    if (pos >= 3 && s.startsWith("end", pos - 3)) continue;
    // Dicionário: do último "obj" (janela de 4 KB) até a palavra "stream".
    const windowStart = Math.max(0, pos - 4096);
    let dict = s.slice(windowStart, pos);
    const objAt = dict.lastIndexOf("obj");
    if (objAt !== -1) dict = dict.slice(objAt + 3);
    if (!dict.trimEnd().endsWith(">>")) continue; // não é palavra-chave de stream
    const start = pos + m[0].length;
    const chains = parseFilterChains(dict, s, objIndex);
    if (chains === null) throw new PdfExtractError("UNSUPPORTED_FILTER");
    // Região que o pdf.js PODE ler: até start+/Length (direto ou indireto
    // resolvido) ou até o 1º "endstream" — usamos a MAIOR (um "endstream"
    // literal cedo não encurta a checagem). /Length indireto não resolvível
    // (ex.: dentro de object stream) → até o fim do arquivo.
    const firstEnd = s.indexOf("endstream", start);
    const lenEnd = streamLengthEnd(dict, s, objIndex, start);
    let regionEnd: number;
    if (lenEnd === "unresolved") regionEnd = s.length;
    else regionEnd = Math.max(firstEnd === -1 ? s.length : firstEnd, lenEnd ?? 0);
    regionEnd = Math.min(regionEnd, s.length);
    let biggest = 0;
    for (const chain of chains) {
      biggest = Math.max(biggest, measureFilterChain(raw.subarray(start, regionEnd), chain, o.maxStreamOutBytes));
    }
    total += biggest;
    if (total > o.maxTotalInflateBytes) throw new PdfExtractError("TOO_BIG_EXPANSION");
    // Próxima busca: depois do /Length confirmado por "endstream", senão do 1º "endstream".
    let next = firstEnd === -1 ? s.length : firstEnd;
    if (typeof lenEnd === "number" && /^\s*endstream/.test(s.slice(lenEnd, lenEnd + 16))) next = lenEnd;
    kw.lastIndex = Math.max(next, start);
  }
}

// ---------------------------------------------------------------------------
// Extração (worker com terminate no prazo; fallback na thread)
// ---------------------------------------------------------------------------

const PDFJS_OPTIONS = {
  disableFontFace: true,
  useSystemFonts: false,
  enableXfa: false,
  stopAtErrors: false,
  verbosity: 0,
  maxImageSize: 1_000_000,
};

type RawPages = { numPages: number; pages: string[] };
type WorkerMsg =
  | { kind: "ok"; numPages: number; pages: string[] }
  | { kind: "setup" }
  | { kind: "open-error"; name?: string }
  | { kind: "too-many" }
  | { kind: "timeout" }
  | { kind: "error"; name?: string };

/** Código do worker (string: nada a empacotar). Importa o unpdf pelo caminho absoluto. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
(async () => {
  let mod;
  try { mod = await import(pathToFileURL(workerData.unpdfPath).href); }
  catch (e) { parentPort.postMessage({ kind: "setup" }); return; }
  const o = workerData.opts;
  const deadline = Date.now() + o.timeoutMs;
  let pdf;
  try {
    try {
      pdf = await mod.getDocumentProxy(new Uint8Array(workerData.buffer), Object.assign({ isEvalSupported: false }, workerData.pdfjsOptions));
    } catch (e) { parentPort.postMessage({ kind: "open-error", name: e && e.name }); return; }
    const numPages = pdf.numPages;
    if (numPages > o.hardMaxPages) { parentPort.postMessage({ kind: "too-many" }); return; }
    const last = Math.min(numPages, o.maxPages);
    const pages = [];
    let chars = 0;
    for (let i = 1; i <= last; i++) {
      if (Date.now() > deadline) { parentPort.postMessage({ kind: "timeout" }); return; }
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      page.cleanup();
      const t = tc.items.map((it) => (it.str || "") + (it.hasEOL ? "\\n" : " ")).join("");
      pages.push(t);
      chars += t.length;
      if (chars >= o.rawCharBudget) break;
    }
    parentPort.postMessage({ kind: "ok", numPages, pages });
  } catch (e) {
    parentPort.postMessage({ kind: "error", name: e && e.name });
  } finally {
    try { if (pdf) await pdf.loadingTask.destroy(); } catch (e) {}
  }
})();
`;

function openErrorToCode(name: string | undefined): PdfErrorCode {
  if (name === "PasswordException") return "ENCRYPTED";
  if (name === "InvalidPDFException" || name === "FormatError" || name === "MissingPDFException") return "CORRUPT";
  return "PARSE_FAILED";
}

function resolveUnpdfPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve("unpdf");
  } catch {
    return null;
  }
}

/** Orçamento de caracteres CRUS lidos (a limpeza encolhe espaços; folga de 50%). */
function rawCharBudget(o: PdfLimits): number {
  return Math.ceil(o.maxChars * 1.5);
}

/** Roda o pdf.js num worker. `null` = worker indisponível (o chamador cai para a thread). */
function runInWorker(copy: Uint8Array, o: PdfLimits, deadline: number): Promise<RawPages | null> {
  const unpdfPath = resolveUnpdfPath();
  if (!unpdfPath) return Promise.resolve(null);
  return new Promise<RawPages | null>((resolve, reject) => {
    let worker: Worker;
    const buffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          unpdfPath,
          buffer,
          pdfjsOptions: PDFJS_OPTIONS,
          opts: {
            timeoutMs: Math.max(0, deadline - Date.now()),
            hardMaxPages: o.hardMaxPages,
            maxPages: o.maxPages,
            rawCharBudget: rawCharBudget(o),
          },
        },
        transferList: [buffer],
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        stdout: true,
        stderr: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new PdfExtractError("TIMEOUT"))), Math.max(0, deadline - Date.now()));
    worker.on("message", (msg: WorkerMsg) => {
      finish(() => {
        switch (msg.kind) {
          case "ok":
            resolve({ numPages: msg.numPages, pages: msg.pages });
            break;
          case "setup":
            resolve(null);
            break;
          case "open-error":
            reject(new PdfExtractError(openErrorToCode(msg.name)));
            break;
          case "too-many":
            reject(new PdfExtractError("TOO_MANY_PAGES"));
            break;
          case "timeout":
            reject(new PdfExtractError("TIMEOUT"));
            break;
          default:
            reject(new PdfExtractError("PARSE_FAILED"));
        }
      });
    });
    worker.on("error", (e: Error & { code?: string }) => {
      finish(() =>
        reject(new PdfExtractError(e?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "TOO_BIG_EXPANSION" : "PARSE_FAILED"))
      );
    });
    worker.on("exit", () => {
      finish(() => reject(new PdfExtractError("PARSE_FAILED")));
    });
  });
}

/** Mesmo laço, na própria thread (fallback; prazo cooperativo por página). */
async function runInline(copy: Uint8Array, o: PdfLimits, deadline: number): Promise<RawPages> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfExtractError("TIMEOUT")), Math.max(0, deadline - Date.now()));
  });
  const work = (async (): Promise<RawPages> => {
    try {
      pdf = await getDocumentProxy(copy, { ...({ isEvalSupported: false } as object), ...PDFJS_OPTIONS });
    } catch (e) {
      throw new PdfExtractError(openErrorToCode((e as { name?: string })?.name));
    }
    const numPages = pdf.numPages;
    if (numPages > o.hardMaxPages) throw new PdfExtractError("TOO_MANY_PAGES");
    const last = Math.min(numPages, o.maxPages);
    const pages: string[] = [];
    let chars = 0;
    for (let i = 1; i <= last; i++) {
      if (Date.now() > deadline) throw new PdfExtractError("TIMEOUT");
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      page.cleanup();
      const t = (tc.items as Array<{ str?: string; hasEOL?: boolean }>)
        .map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : " "))
        .join("");
      pages.push(t);
      chars += t.length;
      if (chars >= rawCharBudget(o)) break;
    }
    return { numPages, pages };
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    try {
      await pdf?.loadingTask?.destroy();
    } catch {
      // já destruído
    }
  }
}

function assemble(raw: RawPages, o: PdfLimits, isolation: "worker" | "inline"): PdfExtractResult {
  const parts: string[] = [];
  let invisibleChars = 0;
  let tagChars = 0;
  let chars = 0;
  let truncated = raw.numPages > raw.pages.length;
  let pagesRead = 0;
  for (const pageText of raw.pages) {
    const cleaned = cleanUntrustedText(pageText);
    invisibleChars += cleaned.stats.invisibleChars;
    tagChars += cleaned.stats.tagChars;
    pagesRead++;
    if (cleaned.text) {
      parts.push(cleaned.text);
      chars += cleaned.text.length + 2;
    }
    if (chars >= o.maxChars) {
      truncated = truncated || pagesRead < raw.pages.length || chars > o.maxChars;
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
    numPages: raw.numPages,
    pagesRead,
    truncated: hasText ? truncated : false,
    invisibleChars,
    tagChars,
    isolation,
  };
}

/** `bytes` é copiado. Lança `PdfExtractError` (código tipado). */
export async function extractPdfText(
  bytes: Uint8Array,
  opts: Partial<PdfLimits> & { isolation?: "worker" | "inline" } = {}
): Promise<PdfExtractResult> {
  const { isolation = "worker", ...limits } = opts;
  const o: PdfLimits = { ...PDF_LIMITS, ...limits };
  if (bytes.byteLength === 0) throw new PdfExtractError("EMPTY");
  if (bytes.byteLength > o.maxBytes) throw new PdfExtractError("TOO_LARGE");
  preflightPdf(bytes, o);
  const deadline = Date.now() + o.timeoutMs;
  const copy = new Uint8Array(bytes); // o pdf.js destaca o buffer que recebe
  try {
    if (isolation === "worker") {
      const viaWorker = await runInWorker(copy, o, deadline);
      if (viaWorker) return assemble(viaWorker, o, "worker");
    }
    return assemble(await runInline(copy, o, deadline), o, "inline");
  } catch (e) {
    if (e instanceof PdfExtractError) throw e;
    throw new PdfExtractError("PARSE_FAILED");
  }
}
