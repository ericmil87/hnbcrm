/**
 * Texto da tradução automática (F1). PURO.
 *
 * 1. Placeholders: URLs, e-mails, telefones, @menções e termos do glossário
 *    saem do texto ANTES do provedor (`⟦U1⟧`, `⟦E1⟧`, `⟦P1⟧`, `⟦M1⟧`, `⟦G1⟧`) e
 *    voltam depois. Nenhum provedor consegue "traduzir" um link ou um nome de
 *    empreendimento.
 * 2. Guard pós-tradução: o conjunto de URLs, os números, os emojis e as marcas
 *    do WhatsApp (`*`, `_`, `~`) precisam sobreviver, e o tamanho tem de ficar
 *    entre 0,3× e 3,5× o original. Falhou = tenta o próximo provedor.
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
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

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

/** Números normalizados: "1.500,00" e "1,500.00" valem o mesmo conjunto de dígitos. */
function numbersOf(text: string): string[] {
  return (text.match(NUMBER_RE) ?? []).map((n) => n.replace(/[.,]/g, ""));
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
  if (!sameMultiset(numbersOf(src), numbersOf(out))) return { ok: false, reason: "números alterados" };
  if (!sameMultiset(src.match(EMOJI_RE) ?? [], out.match(EMOJI_RE) ?? [])) {
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
