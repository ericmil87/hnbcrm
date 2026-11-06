/**
 * Texto da tradução automática (F1). PURO.
 *
 * 1. Placeholders: URLs, e-mails, telefones, @menções e termos do glossário
 *    saem do texto ANTES do provedor e voltam depois. Nenhum provedor consegue
 *    "traduzir" um link ou um nome de empreendimento. Dois formatos:
 *    - `llm` (padrão): `⟦U1⟧`, `⟦E1⟧`, `⟦P1⟧`, `⟦M1⟧`, `⟦G1⟧`, citados pelo
 *      prompt do modelo, que os copia sem problema.
 *    - `libre`: `{1}`, `{2}`… (um contador só) para links/telefones/menções/
 *      e-mails/glossário. Hora da tarde "19h"/"18h45" vai como "19:00"/"18:45"
 *      (com "h" o servidor pt→en a trocava por 12h sem am/pm; ver
 *      `LIBRE_PM_TIME_RE`). EMOJI no começo ou no fim de uma linha sai do texto e
 *      volta colado na mesma linha; emoji no meio da linha vira `XEMO1X`.
 *      Medido no servidor próprio em 06/11/2026: o modelo pt→en corta o texto
 *      no primeiro `⟦` ("Me liga no ⟦P1⟧ ou…" → "Call me at ") e no primeiro
 *      emoji ("Oi 👍🏽 *promoção*…" → "Hi "). `{n}` sobreviveu no lugar em
 *      en/es/fr/it/de para links e nomes, mas some quando está sozinho no
 *      começo da frase ou depois de "Oi"; `XEMO1X` (cara de palavra) não some
 *      nesses lugares. As quebras de linha são preservadas pelo servidor; se a
 *      contagem de linhas mudar, a restauração falha e vale o próximo provedor.
 * 2. Guard pós-tradução: o conjunto de URLs, os números (normalizados, ver
 *    `numbersOf`: "10h" = "10:00", "1.500,00" = "1,500.00"), os emojis e as
 *    marcas do WhatsApp (`*`, `_`, `~`) precisam sobreviver, e o tamanho tem de
 *    ficar entre 0,3× e 3,5× o original. Falhou = tenta o próximo provedor.
 * 3. Parser da resposta do LLM `{"lang","text"}`, tolerante a cerca de código.
 */

export type ProtectedText = {
  text: string;
  tokens: Array<{ token: string; value: string }>;
  /** Só `libre`: emojis tirados do começo/fim de cada linha (índice = linha). */
  edges?: Array<{ lead: string; trail: string }>;
};
export type TokenShape = "llm" | "libre";

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
// Telefone: 8+ dígitos com separadores comuns, opcionalmente com "+".
// O "(" do DDD entra no token: "(⟦P1⟧" solto faz o servidor alucinar.
const PHONE_RE = /(?<![\w⟦{])(?:\(\+?|\+)?\d[\d\s().-]{6,}\d(?![\w⟧}])/g;
const MENTION_RE = /(?<![\w@])@[\w.]{2,}/g;
// Só `libre`: hora da tarde/noite no formato brasileiro ("19h", "18h45").
// Medido em 06/11/2026 no servidor: pt→en devolve "6:45"/"7:00" sem am/pm (o
// guard reprova com razão) e "Chega 18h45" vira "It's 6:45". Reescrito como
// "18:45" antes do envio, ele costuma sair intacto ("Comes 18:45", "at 19:00").
// Token `{n}` foi medido e descartado: o número some do contexto e o modelo
// erra o sentido sem o guard perceber ("Chega {3}" → "Enough {3}"). Só 13–23h:
// "2h de duração" não pode virar relógio, e "10h" → "10:00" já não é ambíguo.
const LIBRE_PM_TIME_RE = /(?<![\p{L}\p{N}{.,:/])(1[3-9]|2[0-3])h([0-5]\d)?(?![\p{L}\p{N}:])/giu;
const TOKEN_RE = /⟦[A-Z]\d+⟧/g;
const LIBRE_TOKEN_RE = /\{\d+\}|XEMO\d+X/gi;
// Sequência de emojis (com tom de pele, seletor de variação, ZWJ, bandeira e
// keycap) vira UM token: "🙏🙏" e "👨‍👩‍👧" voltam exatamente como eram.
const EMOJI_UNIT =
  "(?:[#*0-9]\\uFE0F?\\u20E3|\\p{Regional_Indicator}{2}|\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*)*)";
const EMOJI_RUN = `${EMOJI_UNIT}(?:\\s*${EMOJI_UNIT})*`;
const EMOJI_RUN_RE = new RegExp(EMOJI_RUN, "gu");
const LEAD_EMOJI_RE = new RegExp(`^\\s*${EMOJI_RUN}\\s*`, "u");
const TRAIL_EMOJI_RE = new RegExp(`\\s*${EMOJI_RUN}\\s*$`, "u");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Troca o que não pode ser traduzido por tokens estáveis (formato em `TokenShape`). */
export function protectText(text: string, glossary: readonly string[] = [], shape: TokenShape = "llm"): ProtectedText {
  const tokens: ProtectedText["tokens"] = [];
  const counters: Record<string, number> = {};
  let libreCounter = 0;
  const replace = (input: string, re: RegExp, prefix: string): string =>
    input.replace(re, (match) => {
      const existing = tokens.find((t) => t.value === match && (shape === "libre" || t.token.startsWith(`⟦${prefix}`)));
      if (existing) return existing.token;
      let token: string;
      if (shape === "libre") {
        libreCounter += 1;
        token = prefix === "J" ? `XEMO${libreCounter}X` : `{${libreCounter}}`;
      } else {
        counters[prefix] = (counters[prefix] ?? 0) + 1;
        token = `⟦${prefix}${counters[prefix]}⟧`;
      }
      tokens.push({ token, value: match });
      return token;
    });
  let out = String(text ?? "");
  // "{1}" escrito pelo próprio usuário não pode ser confundido com um token.
  if (shape === "libre") out = replace(out, /\{\s*\d+\s*\}/g, "L");
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
  if (shape !== "libre") return { text: out, tokens };
  out = out.replace(LIBRE_PM_TIME_RE, (_m, h: string, mm: string | undefined) => `${h}:${mm ?? "00"}`);
  // Emoji na borda da linha sai do texto; no meio da linha vira token-palavra.
  const edges: NonNullable<ProtectedText["edges"]> = [];
  const lines = out.split("\n").map((line) => {
    const lead = line.match(LEAD_EMOJI_RE)?.[0] ?? "";
    let rest = line.slice(lead.length);
    const trail = rest.match(TRAIL_EMOJI_RE)?.[0] ?? "";
    rest = rest.slice(0, rest.length - trail.length);
    edges.push({ lead, trail });
    return replace(rest, EMOJI_RUN_RE, "J");
  });
  return { text: lines.join("\n"), tokens, edges };
}

/**
 * Devolve os valores originais em uma passada só (um valor restaurado nunca é
 * expandido de novo). `ok:false` quando um token sumiu ou o provedor criou
 * token novo. Aceita espaço dentro do token ("⟦ U1 ⟧", "{ 1 }").
 */
export function restoreText(
  translated: string,
  protectedText: ProtectedText | ProtectedText["tokens"],
  shape: TokenShape = "llm"
): { ok: boolean; text: string } {
  const tokens = Array.isArray(protectedText) ? protectedText : protectedText.tokens;
  const edges = Array.isArray(protectedText) ? undefined : protectedText.edges;
  let out = String(translated ?? "");
  let ok = true;
  if (shape === "libre") {
    // Espaço dentro das chaves e caixa do token-palavra ("xemo1x") variam.
    out = out.replace(/\{\s*(\d+)\s*\}/g, "{$1}").replace(/XEMO(\d+)X/gi, "XEMO$1X");
  } else {
    // Alguns provedores trocam os colchetes matemáticos por espaços em volta.
    out = out.replace(/⟦\s*([A-Z]\d+)\s*⟧/g, "⟦$1⟧");
  }
  for (const { token } of tokens) {
    if (!out.includes(token)) ok = false;
  }
  const values = new Map(tokens.map((t) => [t.token, t.value]));
  out = out.replace(shape === "libre" ? LIBRE_TOKEN_RE : TOKEN_RE, (found) => {
    const value = values.get(found);
    if (value === undefined) {
      ok = false;
      return found;
    }
    return value;
  });
  if (edges && edges.some((e) => e.lead || e.trail)) {
    const lines = out.split("\n");
    if (lines.length !== edges.length) return { ok: false, text: out };
    out = lines
      .map((line, i) => {
        const { lead, trail } = edges[i];
        let l = line;
        if (lead) l = lead + l.trimStart();
        if (trail) l = l.trimEnd() + trail;
        return l;
      })
      .join("\n");
  }
  return { ok, text: out };
}

/** Sobrou algo para traduzir? (Só emojis/links/números = não.) */
export function hasTranslatableText(protectedText: ProtectedText): boolean {
  const bare = protectedText.text.replace(LIBRE_TOKEN_RE, " ").replace(TOKEN_RE, " ");
  return /\p{L}/u.test(bare);
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
  // Espaço comum como milhar só com decimal depois ("R$ 1 500.00", saída fr).
  s = s.replace(/(?<![\d.,])\d{1,3}(?: \d{3})+(?=[.,]\d{2}(?!\d))/g, (m) => m.replace(/ /g, ""));
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
