/**
 * Texto da tradução automática (F1). PURO.
 *
 * 1. Placeholders: URLs, e-mails, telefones, @menções e termos do glossário
 *    saem do texto ANTES do provedor (`⟦U1⟧`, `⟦E1⟧`, `⟦P1⟧`, `⟦M1⟧`, `⟦G1⟧`) e
 *    voltam depois. Nenhum provedor consegue "traduzir" um link ou um nome de
 *    empreendimento.
 * 2. Guard pós-tradução: o conjunto de URLs, os números (normalizados, ver
 *    `numbersOf`: "10h" = "10:00", "1.500,00" = "1,500.00"), os emojis e as
 *    marcas do WhatsApp (`*`, `_`, `~`) precisam sobreviver, e o tamanho tem de
 *    ficar entre 0,3× e 3,5× o original. Falhou = tenta o próximo provedor.
 * 3. Parser da resposta do LLM `{"lang","text"}`, tolerante a cerca de código.
 */

export type ProtectedText = { text: string; tokens: Array<{ token: string; value: string }> };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
// Telefone: 8+ dígitos com separadores comuns, opcionalmente com "+".
const PHONE_RE = /(?<![\w⟦])\+?\d[\d\s().-]{6,}\d(?![\w⟧])/g;
const MENTION_RE = /(?<![\w@])@[\w.]{2,}/g;
const TOKEN_RE = /⟦[A-Z]\d+⟧/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Troca o que não pode ser traduzido por tokens estáveis. */
export function protectText(text: string, glossary: readonly string[] = []): ProtectedText {
  const tokens: ProtectedText["tokens"] = [];
  const counters: Record<string, number> = {};
  const replace = (input: string, re: RegExp, prefix: string): string =>
    input.replace(re, (match) => {
      const existing = tokens.find((t) => t.value === match && t.token.startsWith(`⟦${prefix}`));
      if (existing) return existing.token;
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      const token = `⟦${prefix}${counters[prefix]}⟧`;
      tokens.push({ token, value: match });
      return token;
    });
  let out = String(text ?? "");
  out = replace(out, URL_RE, "U");
  out = replace(out, EMAIL_RE, "E");
  out = replace(out, MENTION_RE, "M");
  out = replace(out, PHONE_RE, "P");
  // Termos mais longos primeiro ("Residencial Mar Azul" antes de "Mar").
  const terms = [...glossary].filter((t) => t.trim()).sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "giu");
    out = replace(out, re, "G");
  }
  return { text: out, tokens };
}

/**
 * Devolve os valores originais. `ok:false` quando um token sumiu, apareceu
 * duplicado de forma inventada ou o provedor criou token novo.
 */
export function restoreText(translated: string, tokens: ProtectedText["tokens"]): { ok: boolean; text: string } {
  let out = String(translated ?? "");
  // Alguns provedores trocam os colchetes matemáticos por espaços em volta.
  out = out.replace(/⟦\s*([A-Z]\d+)\s*⟧/g, "⟦$1⟧");
  let ok = true;
  for (const { token } of tokens) {
    if (!out.includes(token)) ok = false;
  }
  const known = new Set(tokens.map((t) => t.token));
  for (const found of out.match(TOKEN_RE) ?? []) {
    if (!known.has(found)) ok = false;
  }
  for (const { token, value } of tokens) {
    out = out.split(token).join(value);
  }
  return { ok, text: out };
}

// ── Guard pós-tradução ──────────────────────────────────────────────────────

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
// Seletores de variação (U+FE0E/U+FE0F) e modificadores de tom de pele não
// contam: "❤️" e "❤", "👍🏽" e "👍" são o mesmo emoji para o guard.
const EMOJI_NOISE_RE = /[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;
const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};
// Horário explícito em 12h: "2:30 pm", "6 p.m.", "10am".
const AMPM_RE = /(?<![\d.,:])(\d{1,2})(?:[:.h](\d{2}))?\s?([ap])\.?\s?m\.?(?![\p{L}\d])/giu;
// Horário: "10h", "14h30", "10h00", "10:00", "14:30", "14 h". Minuto "00" some.
const TIME_RE = /(?<![\d.,:])(\d{1,2})(?:\s?h(\d{2})?(?![\p{L}\d])|:(\d{2})(?![\d]))/giu;

function multiset(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

function sameMultiset(a: string[], b: string[]): boolean {
  const ma = multiset(a);
  const mb = multiset(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (mb.get(k) !== v) return false;
  return true;
}

/** O que sobra de `a` depois de tirar `b` (diferença de multiconjuntos). */
function multisetMinus(a: string[], b: string[]): string[] {
  const mb = multiset(b);
  const out: string[] = [];
  for (const v of a) {
    const n = mb.get(v) ?? 0;
    if (n > 0) mb.set(v, n - 1);
    else out.push(v);
  }
  return out;
}

type NumberRuns = { runs: string[]; times: string[] };

function canonicalTime(hour: string, minute: string | undefined): string {
  const h = String(Number(hour));
  return minute && minute !== "00" ? `${h}${minute}` : h;
}

/**
 * Números de um texto, normalizados para a comparação do guard.
 *
 * Regra (o que um tradutor legítimo muda e que NÃO conta como número alterado):
 * - Separadores de milhar e decimal somem: "1.500,00", "1,500.00" e "1500,00"
 *   são o mesmo número. Centavos "00" no fim também ("R$ 1.500" = "R$ 1.500,00").
 *   Grupo de 3 zeros NÃO some ("1.000" continua mil).
 * - Espaço fino/não separável entre milhares ("1 500") vira parte do número.
 * - Horário: "10h", "10h00", "10:00" e "10 am" valem "10"; "14h30", "14:30",
 *   "14.30" e "2:30 pm" valem "1430". Só horário com am/pm é convertido de 12h.
 * - Sobrescrito vira dígito ("85m²" = "85m2"); ordinal perde o sufixo
 *   ("1º" = "1st" = "1o"), porque só os dígitos entram.
 * - URLs saem da conta (já são comparadas inteiras como links).
 */
function numbersOf(text: string): NumberRuns {
  const times: string[] = [];
  let s = text.replace(URL_RE, " ");
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (d) => SUPERSCRIPT_DIGITS[d] ?? d);
  s = s.replace(/(\d)[\u00A0\u202F](?=\d{3}(?!\d))/g, "$1");
  s = s.replace(AMPM_RE, (_m, h: string, mm: string | undefined, ap: string) => {
    let hour = Number(h);
    if (hour > 12) return _m;
    if (ap.toLowerCase() === "p" && hour < 12) hour += 12;
    if (ap.toLowerCase() === "a" && hour === 12) hour = 0;
    const t = canonicalTime(String(hour), mm);
    times.push(t);
    return ` ${t} `;
  });
  s = s.replace(TIME_RE, (_m, h: string, hMin: string | undefined, colonMin: string | undefined) => {
    if (Number(h) > 24) return _m;
    const t = canonicalTime(h, hMin ?? colonMin);
    times.push(t);
    return ` ${t} `;
  });
  const runs = (s.match(NUMBER_RE) ?? []).map((n) => n.replace(/[.,]00$/, "").replace(/[.,]/g, ""));
  return { runs, times };
}

/** "1430" → "230" (o mesmo horário escrito em 12h, sem am/pm). */
function as12h(time: string): string | undefined {
  const minute = time.length > 2 ? time.slice(-2) : "";
  const hour = Number(minute ? time.slice(0, -2) : time);
  if (!(hour >= 13 && hour <= 23)) return undefined;
  return `${hour - 12}${minute}`;
}

/** Pares de marca do WhatsApp (`*negrito*`, `_itálico_`, `~tachado~`) — contagem. */
function markCount(text: string, mark: "*" | "_" | "~"): number {
  // Ignora o que está dentro de URLs (underscore em link é comum).
  const noUrls = text.replace(URL_RE, " ");
  const re = mark === "*" ? /\*/g : mark === "_" ? /_/g : /~/g;
  return (noUrls.match(re) ?? []).length;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

export const MIN_LENGTH_RATIO = 0.3;
export const MAX_LENGTH_RATIO = 3.5;

export function checkTranslation(original: string, translated: string): GuardResult {
  const src = String(original ?? "");
  const out = String(translated ?? "");
  if (!out.trim()) return { ok: false, reason: "tradução vazia" };
  const urlsA = src.match(URL_RE) ?? [];
  const urlsB = out.match(URL_RE) ?? [];
  if (!sameMultiset(urlsA, urlsB)) return { ok: false, reason: "links alterados" };
  const numbersA = numbersOf(src);
  const numbersB = numbersOf(out);
  const missing = multisetMinus(numbersA.runs, numbersB.runs);
  const extra = multisetMinus(numbersB.runs, numbersA.runs);
  if (missing.length > 0) {
    // "14h30" → "2:30" sem am/pm: hora ambígua para quem lê (6:00 de manhã?).
    const ambiguous = missing.some((n) => numbersA.times.includes(n) && extra.includes(as12h(n) ?? "\u0000"));
    return { ok: false, reason: ambiguous ? "horário convertido para 12h sem am/pm" : "números alterados" };
  }
  if (extra.length > 0) return { ok: false, reason: "número novo na tradução" };
  const emojis = (t: string) => t.replace(EMOJI_NOISE_RE, "").match(EMOJI_RE) ?? [];
  if (!sameMultiset(emojis(src), emojis(out))) {
    return { ok: false, reason: "emojis alterados" };
  }
  for (const mark of ["*", "_", "~"] as const) {
    const a = markCount(src, mark);
    const b = markCount(out, mark);
    // Balanceada (par) sempre que a original era; quantidade igual quando havia marcas.
    if (a !== b && (a > 0 || b % 2 !== 0)) return { ok: false, reason: "formatação do WhatsApp alterada" };
  }
  const lenA = [...src].length;
  const lenB = [...out].length;
  // Texto bem curto ("Sim" → "Yes"/"Sí") varia muito em proporção: só mede acima de 12 caracteres.
  if (lenA >= 12) {
    const ratio = lenB / lenA;
    if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) return { ok: false, reason: "tamanho fora do esperado" };
  }
  return { ok: true };
}

// ── Resposta do LLM ─────────────────────────────────────────────────────────

/**
 * Lê `{"lang":"es","text":"…"}` da resposta do modelo. Aceita cerca de código
 * (```json … ```) e texto em volta do objeto. `undefined` = resposta inválida.
 */
export function parseLlmTranslationReply(raw: string | null | undefined): { lang?: string; text: string } | undefined {
  if (typeof raw !== "string") return undefined;
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const text = typeof obj.text === "string" ? obj.text : typeof obj.translation === "string" ? obj.translation : undefined;
  if (text === undefined || !text.trim()) return undefined;
  const lang = typeof obj.lang === "string" && obj.lang.trim() ? obj.lang.trim() : undefined;
  return { lang, text };
}
