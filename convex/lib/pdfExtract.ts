"use node";
/**
 * PDF → texto (P2.2 do onboarding v2), a partir do spike P0.5
 * (temp/landing-onboarding-v2/spikes/pdf/RELATORIO.md) e da revisão do P2.2.
 *
 * `unpdf@2.1.0` (pdf.js embutido, sem binário nativo). Camadas:
 *  1. Tamanho (10 MB) e `%PDF-` nos primeiros 1024 bytes.
 *  2. Pré-varredura (`preflightPdf`, PRIMEIRA barreira), na thread
 *     principal, antes do pdf.js:
 *     - `/Encrypt` → recusa (inclusive só senha de dono);
 *     - TODA ocorrência de `stream` (fora "endstream") tem o dado farejado
 *       em dois inícios (logo após a palavra-chave e após o próximo fim de
 *       linha, como o pdf.js) — zlib que o pdf.js aceitaria → infla com teto;
 *       só hex/ASCII85 → decodifica e fareja de novo; a busca segue logo após
 *       a palavra-chave (chamariz em comentário/string não esconde nada);
 *     - o `/Filter` do dicionário (nome, cadeia, indireto, `#xx`) também é
 *       decodificado; LZW, RunLength, Crypt e desconhecidos → recusa;
 *     - saída descomprimida que contém `stream` (ex.: /ObjStm) é varrida de
 *       novo (profundidade limitada);
 *     - tetos: 16 MB por stream e 48 MB somados (ver PDF_LIMITS); streams de
 *       imagem (`/Subtype /Image`) não são decodificados nem contados;
 *     - custo linear: fim de linha e `endstream` em cache, orçamento de 32 MB
 *       para os decodificadores ASCII, até 20 mil `stream` e o MESMO prazo da
 *       leitura, checado a cada `stream` (TIMEOUT).
 *  3. pdf.js SÓ num `worker_threads`, com duas travas na thread principal:
 *     prazo (`terminate()` → TIMEOUT; Promise.race não interrompe trabalho
 *     síncrono) e VIGIA DE MEMÓRIA — a DEFESA PRINCIPAL: a cada 20 ms mede o
 *     RSS do processo; passou de RSS inicial + `PDF_WORKER_RSS_CAP_BYTES` ou do
 *     teto absoluto `PDF_WORKER_RSS_ABS_MAX_BYTES` →
 *     `terminate()` → TOO_BIG_EXPANSION. (`resourceLimits` do worker só cobre o
 *     heap JS; ArrayBuffers ficam fora — medido na revisão.) Worker
 *     indisponível → UNAVAILABLE: falha fechada, o pdf.js nunca roda sem vigia.
 *     O código do worker é uma string (`eval: true`, nada a empacotar) e
 *     importa o `unpdf` pelo caminho absoluto resolvido aqui — por isso
 *     `unpdf` está em `convex.json → node.externalPackages`.
 *  Configurações do pdf.js: sem fontes do SO, sem XFA, sem scripts, imagens
 *  não decodificadas (`maxImageSize`); `isEvalSupported:false` explícito
 *  (o pdf.js 6 já não tem o caminho de `eval`).
 *  Escaneado (texto < 40 caracteres) → `{ text: "", scanned: true }`.
 *  Nunca logar conteúdo nem nome do arquivo; só código de erro.
 */
import { inflateRawSync, constants as zlibConstants } from "node:zlib";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
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
  | "UNAVAILABLE"
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
  UNAVAILABLE: "A leitura de PDF está indisponível no momento. Tente de novo mais tarde ou envie prints das páginas.",
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
  /** Onde o pdf.js rodou (sempre "worker": sem worker a leitura falha fechada). */
  isolation: "worker";
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

/** Bytes de entrada varridos pelos decodificadores ASCII (orçamento global). */
export type ScanCounter = { bytes: number };

/**
 * ASCIIHexDecode até `>` (ou o fim), ignorando o que não é hex, como o pdf.js.
 * O buffer de saída cresce conforme decodifica (não aloca `len/2` de saída
 * para um stream que termina no primeiro byte).
 */
export function decodeAsciiHex(input: Uint8Array, cap: number, scan?: ScanCounter): Uint8Array {
  let out = new Uint8Array(Math.min(cap + 1, 4096));
  let n = 0;
  let hi = -1;
  let i = 0;
  const put = (v: number) => {
    if (n >= cap) throw new PdfExtractError("TOO_BIG_EXPANSION");
    if (n === out.length) {
      const bigger = new Uint8Array(Math.min(cap + 1, out.length * 2));
      bigger.set(out);
      out = bigger;
    }
    out[n++] = v;
  };
  for (; i < input.length; i++) {
    const c = input[i];
    if (c === 0x3e) break; // '>'
    if (!isHex(c)) continue;
    if (hi < 0) hi = hexVal(c);
    else {
      put((hi << 4) | hexVal(c));
      hi = -1;
    }
  }
  if (scan) scan.bytes += i;
  if (hi >= 0) put(hi << 4);
  return out.subarray(0, n);
}

/** ASCII85Decode até `~>` (ou o fim); `z` = 4 zeros. */
export function decodeAscii85(input: Uint8Array, cap: number, scan?: ScanCounter): Uint8Array {
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
  let i = 0;
  for (; i < input.length; i++) {
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
  if (scan) scan.bytes += i;
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

/** Nome PDF com escapes `#xx` decodificados (o pdf.js decodifica). */
export function decodePdfName(name: string): string {
  return name.replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
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
  const win = s.slice(at, at + 512); // nunca varre além de 512 caracteres
  const end = win.indexOf("endobj");
  return end === -1 ? win : win.slice(0, end);
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
      const name = decodePdfName(x.slice(1));
      return FILTER_ALIASES[name] ?? name;
    });
    if (value.startsWith("[") && /\d+\s+\d+\s+R/.test(value)) return null; // referência dentro da cadeia
    chains.push(names);
  }
  return chains;
}

/** Decodifica a cadeia com teto. `data` null = filtro de imagem no fim (não decodificado). Lança se perigoso. */
export function decodeFilterChain(
  data: Uint8Array,
  chain: string[],
  cap: number,
  scan?: ScanCounter
): { size: number; data: Uint8Array | null } {
  let cur = data;
  for (let i = 0; i < chain.length; i++) {
    const f = chain[i];
    if (f === "ASCIIHexDecode") cur = decodeAsciiHex(cur, cap, scan);
    else if (f === "ASCII85Decode") cur = decodeAscii85(cur, cap, scan);
    else if (f === "FlateDecode") {
      const out = inflateLikePdfJs(cur, cap);
      if (out === null) return { size: 0, data: null }; // o pdf.js trata como stream vazio
      cur = out;
    } else if (IMAGE_FILTERS.has(f)) {
      if (i !== chain.length - 1) throw new PdfExtractError("UNSUPPORTED_FILTER");
      return { size: cur.length, data: null }; // imagem: não decodificada na extração de texto
    } else {
      // LZWDecode, RunLengthDecode, Crypt e qualquer nome desconhecido
      throw new PdfExtractError("UNSUPPORTED_FILTER");
    }
  }
  return chain.length ? { size: cur.length, data: cur } : { size: 0, data: null };
}

/** Compat: só o tamanho. */
export function measureFilterChain(data: Uint8Array, chain: string[], cap: number): number {
  return decodeFilterChain(data, chain, cap).size;
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

/** Fins dos cabeçalhos `N G obj` em ordem (busca binária do objeto que contém um stream). */
function objectHeaderEnds(s: string): number[] {
  const out: number[] = [];
  const re = /\d{1,10}\s+\d{1,5}\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m.index + m[0].length);
  return out;
}

function lastBefore(sorted: number[], pos: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= pos) {
      ans = sorted[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const SNIFF_PREFIX = 1024;
const SNIFF_MAX_DEPTH = 4;
/** Profundidade da re-varredura de saídas descomprimidas que contêm `stream` (ex.: /ObjStm). */
const NESTED_SCAN_MAX_DEPTH = 3;
// Um PDF legítimo varre ~1× o arquivo (≤ 10 MB) aqui; 32 MB dá folga e corta abuso.
const ASCII_SCAN_BUDGET = 32 * 1024 * 1024;
/** Ocorrências de `stream` aceitas (somando as varreduras aninhadas). */
export const MAX_STREAM_KEYWORDS = 20_000;

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
}

/** Os primeiros bytes (sem espaço) são só do alfabeto hex (até `>`)? */
function looksHex(d: Uint8Array): boolean {
  let seen = 0;
  for (let i = 0; i < d.length && i < SNIFF_PREFIX; i++) {
    const c = d[i];
    if (isWs(c)) continue;
    if (c === 0x3e) return seen >= 2;
    if (!isHex(c)) return false;
    seen++;
  }
  return seen >= 16;
}

/** Os primeiros bytes (sem espaço) são só do alfabeto ASCII85 (até `~`)? */
function looksAscii85(d: Uint8Array): boolean {
  let seen = 0;
  for (let i = 0; i < d.length && i < SNIFF_PREFIX; i++) {
    const c = d[i];
    if (isWs(c)) continue;
    if (c === 0x7e) return seen >= 5;
    if (!((c >= 0x21 && c <= 0x75) || c === 0x7a)) return false;
    seen++;
  }
  return seen >= 16;
}

/** Cabeçalho zlib que o pdf.js aceitaria. */
function looksZlib(d: Uint8Array): boolean {
  return d.length >= 2 && (d[0] & 0x0f) === 8 && ((d[0] << 8) | d[1]) % 31 === 0 && (d[1] & 0x20) === 0;
}

type ScanState = {
  total: number;
  /** Bytes varridos pelos decodificadores ASCII (farejamento e cadeias). */
  scan: ScanCounter;
  keywords: number;
  deadline: number;
  o: PreflightLimits;
};

function checkScanBudget(st: ScanState): void {
  if (st.scan.bytes > ASCII_SCAN_BUDGET) throw new PdfExtractError("TOO_BIG_EXPANSION");
}

/**
 * Fareja o PRÓPRIO dado (zlib → infla; só hex/ASCII85 → decodifica e fareja
 * de novo). `zlibData` = dado para o zlib (até o fim natural do deflate),
 * `asciiData` = região para hex/ASCII85. Guarda as saídas em `decoded`.
 */
function sniffInto(
  zlibData: Uint8Array,
  asciiData: Uint8Array,
  st: ScanState,
  decoded: Uint8Array[],
  depth = 0
): number {
  if (depth >= SNIFF_MAX_DEPTH || asciiData.length < 2) return 0;
  const cap = st.o.maxStreamOutBytes;
  if (looksZlib(zlibData)) {
    const out = inflateLikePdfJs(zlibData, cap);
    if (!out) return 0;
    decoded.push(out);
    return Math.max(out.length, sniffInto(out, out, st, decoded, depth + 1));
  }
  const hex = looksHex(asciiData);
  if (hex || looksAscii85(asciiData)) {
    const out = hex ? decodeAsciiHex(asciiData, cap, st.scan) : decodeAscii85(asciiData, cap, st.scan);
    checkScanBudget(st);
    decoded.push(out);
    return Math.max(out.length, sniffInto(out, out, st, decoded, depth + 1));
  }
  return 0;
}

/** Compat/teste: maior tamanho decodificado pelo farejamento (lança acima do teto). */
export function sniffExpansion(data: Uint8Array, cap: number): number {
  const st: ScanState = {
    total: 0,
    scan: { bytes: 0 },
    keywords: 0,
    deadline: Infinity,
    o: { maxStreamOutBytes: cap, maxTotalInflateBytes: Infinity },
  };
  return sniffInto(data, data, st, []);
}

/**
 * Próximo fim de linha a partir de `from`, com cache monotônico (uma busca
 * por posição do arquivo, não uma por `stream`): sem isso, `stream~` repetido
 * sem quebras era quadrático.
 */
class EolFinder {
  private nl = -2;
  private cr = -2;
  constructor(private readonly s: string) {}
  /** Início do dado segundo o pdf.js (`skipToNextLine`): depois do próximo fim de linha. */
  afterNextEol(from: number): number {
    if (this.nl !== -1 && this.nl < from) this.nl = this.s.indexOf("\n", from);
    if (this.cr !== -1 && this.cr < from) this.cr = this.s.indexOf("\r", from);
    const nl = this.nl === -1 ? Infinity : this.nl;
    const cr = this.cr === -1 ? Infinity : this.cr;
    if (nl === Infinity && cr === Infinity) return this.s.length;
    if (cr < nl) return cr + 1 === nl ? nl + 1 : cr + 1;
    return nl + 1;
  }
}

/** Dicionário de imagem (`/Subtype /Image`, com escapes `#xx`). */
function isImageDict(dict: string): boolean {
  const re = /\/Subtype\s*\/([A-Za-z0-9#]{1,32})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dict))) if (decodePdfName(m[1]) === "Image") return true;
  return false;
}

/**
 * Varre um buffer (o arquivo, ou uma saída descomprimida que contém
 * `stream`): TODA ocorrência de `stream` (não precedida de "end") tem o dado
 * farejado em DOIS inícios — logo após a palavra-chave (com no máximo uma
 * quebra) e após o próximo fim de linha (como o `skipToNextLine` do pdf.js:
 * `stream JUNK\n`, `stream%x\n`) — e a cadeia `/Filter` do dicionário, se
 * houver, é decodificada. A busca continua logo após a palavra-chave (nunca
 * pula até `endstream`), então chamarizes em comentário/string não escondem o
 * stream real. Saídas que contêm `stream` (ex.: /ObjStm) são varridas de novo.
 */
function scanBuffer(raw: Buffer, st: ScanState, top: { s: string; objIndex: Map<string, number> }, depth: number): void {
  const s = depth === 0 ? top.s : raw.toString("latin1");
  const objIndex = depth === 0 ? top.objIndex : indexObjects(s);
  const headers = objectHeaderEnds(s);
  const cap = st.o.maxStreamOutBytes;
  const kw = /stream/g;
  const eol = new EolFinder(s);
  let prevKwEnd = 0;
  let cachedEnd = -2; // próximo "endstream" já achado (busca monotônica)
  let m: RegExpExecArray | null;
  while ((m = kw.exec(s))) {
    const pos = m.index;
    const kwEnd = pos + 6;
    if (pos >= 3 && s.startsWith("end", pos - 3)) continue;
    if (++st.keywords > MAX_STREAM_KEYWORDS) throw new PdfExtractError("TOO_LARGE");
    if (Date.now() > st.deadline) throw new PdfExtractError("TIMEOUT");
    // Dois inícios possíveis do dado.
    let a = kwEnd;
    if (s.charCodeAt(a) === 0x0d) a++;
    if (s.charCodeAt(a) === 0x0a) a++;
    const b = eol.afterNextEol(kwEnd);
    // Dicionário: do cabeçalho `N G obj` mais próximo (ou da palavra-chave anterior) até aqui.
    const dict = s.slice(Math.max(lastBefore(headers, pos), prevKwEnd, 0), pos);
    prevKwEnd = kwEnd;
    // Imagem: o pdf.js não decodifica imagens na extração de texto, e uma
    // foto Flate legítima passa fácil de 16 MB (2500×2500 RGB = 19 MB). Não é
    // medida aqui nem conta no total; quem rotula uma bomba de conteúdo como
    // imagem esbarra no vigia de memória do worker (defesa principal).
    if (isImageDict(dict)) {
      kw.lastIndex = kwEnd;
      continue;
    }
    let chains = parseFilterChains(dict, top.s, top.objIndex);
    if (chains === null) {
      if (depth === 0) throw new PdfExtractError("UNSUPPORTED_FILTER");
      chains = []; // dentro de saída descomprimida: o farejamento cobre
    }
    if (cachedEnd !== -1 && cachedEnd < kwEnd) cachedEnd = s.indexOf("endstream", kwEnd);
    const decoded: Uint8Array[] = [];
    let biggest = 0;
    for (const start of a === b ? [a] : [a, b]) {
      const firstEnd = cachedEnd === -1 ? s.length : cachedEnd;
      const lenEnd = streamLengthEnd(dict, s, objIndex, start);
      let regionEnd =
        lenEnd === "unresolved" ? s.length : Math.max(firstEnd >= start ? firstEnd : s.length, lenEnd ?? 0);
      regionEnd = Math.min(regionEnd, s.length);
      const region = raw.subarray(start, regionEnd);
      for (const chain of chains) {
        const r = decodeFilterChain(region, chain, cap, st.scan);
        checkScanBudget(st);
        biggest = Math.max(biggest, r.size);
        if (r.data) decoded.push(r.data);
      }
      // zlib até o fim natural do deflate (sem confiar em /Length nem endstream).
      biggest = Math.max(biggest, sniffInto(raw.subarray(start), region, st, decoded));
    }
    st.total += biggest;
    if (st.total > st.o.maxTotalInflateBytes) throw new PdfExtractError("TOO_BIG_EXPANSION");
    if (depth < NESTED_SCAN_MAX_DEPTH) {
      for (const out of decoded) {
        const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
        if (buf.indexOf("stream", 0, "latin1") !== -1) scanBuffer(buf, st, top, depth + 1);
      }
    }
    kw.lastIndex = kwEnd;
  }
}

/**
 * Pré-varredura (PRIMEIRA barreira; a defesa principal é o vigia de memória
 * do worker): criptografado recusado; streams farejados como em `scanBuffer`.
 */
export function preflightPdf(bytes: Uint8Array, o: PreflightLimits, deadline = Infinity): void {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = raw.subarray(0, 1024).toString("latin1");
  if (!head.includes("%PDF-")) throw new PdfExtractError("NOT_PDF");
  const s = raw.toString("latin1");
  if (/\/Encrypt\b/.test(s)) throw new PdfExtractError("ENCRYPTED");
  scanBuffer(raw, { total: 0, scan: { bytes: 0 }, keywords: 0, deadline, o }, { s, objIndex: indexObjects(s) }, 0);
}

// ---------------------------------------------------------------------------
// Extração: pdf.js SÓ no worker, com prazo e vigia de memória
// ---------------------------------------------------------------------------

/**
 * Teto de crescimento do RSS do processo enquanto o worker do pdf.js roda
 * (DEFESA PRINCIPAL contra bomba de descompressão: `resourceLimits` do worker
 * não conta ArrayBuffers). A action Node tem 512 MB; o pico medido de um PDF
 * normal de 200 páginas foi ~104 MB de RSS total.
 */
export const PDF_WORKER_RSS_CAP_BYTES = 250 * 1024 * 1024;
/**
 * Teto ABSOLUTO de RSS do processo durante a leitura (protege os 512 MB da
 * action quando a base já está inflada por outro trabalho do processo).
 */
export const PDF_WORKER_RSS_ABS_MAX_BYTES = 450 * 1024 * 1024;
/** Intervalo do vigia de memória. */
export const PDF_WORKER_RSS_POLL_MS = 20;

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

function resolveUnpdfPath(override?: string): string | null {
  if (override !== undefined && process.env.VITEST === "true") return override;
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

/**
 * Roda o pdf.js num worker com DUAS travas na thread principal: prazo
 * (`terminate()` → TIMEOUT) e vigia de memória (RSS acima de rss inicial +
 * teto → `terminate()` → TOO_BIG_EXPANSION). Worker indisponível → UNAVAILABLE
 * (falha fechada: nunca roda o pdf.js sem vigia).
 */
function runInWorker(
  copy: Uint8Array,
  o: PdfLimits,
  deadline: number,
  rssCapBytes: number,
  rssAbsMaxBytes: number,
  unpdfPathOverride?: string
): Promise<RawPages> {
  const unpdfPath = resolveUnpdfPath(unpdfPathOverride);
  if (!unpdfPath) return Promise.reject(new PdfExtractError("UNAVAILABLE"));
  return new Promise<RawPages>((resolve, reject) => {
    const buffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
    const rssStart = process.memoryUsage.rss();
    let worker: Worker;
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
        // Só o heap JS; ArrayBuffers ficam fora — por isso o vigia de RSS abaixo.
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      });
    } catch {
      reject(new PdfExtractError("UNAVAILABLE"));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new PdfExtractError("TIMEOUT"))), Math.max(0, deadline - Date.now()));
    const watchdog = setInterval(() => {
      const rss = process.memoryUsage.rss();
      if (rss - rssStart > rssCapBytes || rss > rssAbsMaxBytes) {
        finish(() => reject(new PdfExtractError("TOO_BIG_EXPANSION")));
      }
    }, PDF_WORKER_RSS_POLL_MS);
    worker.on("message", (msg: WorkerMsg) => {
      finish(() => {
        switch (msg.kind) {
          case "ok":
            resolve({ numPages: msg.numPages, pages: msg.pages });
            break;
          case "setup":
            reject(new PdfExtractError("UNAVAILABLE"));
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

function assemble(raw: RawPages, o: PdfLimits): PdfExtractResult {
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
    isolation: "worker",
  };
}

export type PdfExtractOptions = Partial<PdfLimits> & {
  /** Teto do vigia de memória sobre a base (padrão PDF_WORKER_RSS_CAP_BYTES). */
  rssCapBytes?: number;
  /** Teto absoluto do RSS do processo (padrão PDF_WORKER_RSS_ABS_MAX_BYTES). */
  rssAbsMaxBytes?: number;
  /** Só em teste (VITEST): pula a pré-varredura para exercitar o vigia. */
  skipPreflightForTests?: boolean;
  /** Só em teste (VITEST): caminho do unpdf (inexistente = worker indisponível). */
  unpdfPathForTests?: string;
};

/** `bytes` é copiado. Lança `PdfExtractError` (código tipado). */
export async function extractPdfText(bytes: Uint8Array, opts: PdfExtractOptions = {}): Promise<PdfExtractResult> {
  const {
    rssCapBytes = PDF_WORKER_RSS_CAP_BYTES,
    rssAbsMaxBytes = PDF_WORKER_RSS_ABS_MAX_BYTES,
    skipPreflightForTests,
    unpdfPathForTests,
    ...limits
  } = opts;
  const o: PdfLimits = { ...PDF_LIMITS, ...limits };
  if (bytes.byteLength === 0) throw new PdfExtractError("EMPTY");
  if (bytes.byteLength > o.maxBytes) throw new PdfExtractError("TOO_LARGE");
  // O prazo começa ANTES da pré-varredura e vale para ela (checado a cada `stream`).
  const deadline = Date.now() + o.timeoutMs;
  if (!(skipPreflightForTests && process.env.VITEST === "true")) preflightPdf(bytes, o, deadline);
  const copy = new Uint8Array(bytes); // o buffer vai transferido ao worker
  try {
    return assemble(await runInWorker(copy, o, deadline, rssCapBytes, rssAbsMaxBytes, unpdfPathForTests), o);
  } catch (e) {
    if (e instanceof PdfExtractError) throw e;
    throw new PdfExtractError("PARSE_FAILED");
  }
}
