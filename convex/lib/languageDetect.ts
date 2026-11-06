/**
 * Detecção de idioma barata, sem LLM (tradução automática F1). PURA.
 *
 * `tinyld/light` (JS puro, sem dependências) dá o palpite; uma heurística de
 * stopwords de português × espanhol corrige a confusão mais cara no Brasil
 * (portunhol, "para", "que", "de"). Texto curto (< 20 letras), só emoji,
 * URL ou número devolve `undefined`: a mensagem HERDA o idioma da conversa.
 *
 * O resultado é só um palpite com `confidence` (0–1). Quem decide trocar o
 * idioma da conversa é `lib/translationLang.ts` (regra das 2 divergentes).
 */
import { detectAll } from "tinyld/light";
import { LANGUAGE_CODES, baseLanguage, normalizeLanguageCode } from "./languages";

export const MIN_ALPHA_CHARS = 20;

export type DetectedLanguage = { lang: string; confidence: number };

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const MENTION_RE = /@\w+/g;

/** Só as letras que contam para detectar (sem URL, e-mail, menção, número, emoji). */
export function alphabeticText(text: string): string {
  return String(text ?? "")
    .replace(URL_RE, " ")
    .replace(EMAIL_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countAlphaChars(text: string): number {
  return (alphabeticText(text).match(/\p{L}/gu) ?? []).length;
}

// Palavras que quase só aparecem numa das duas línguas (minúsculas, sem acento
// removido de propósito: "não", "você", "ñ" já são sinais fortes).
const PT_ONLY = new Set([
  "não", "nao", "você", "voce", "vocês", "voces", "obrigado", "obrigada", "tá", "ta",
  "então", "entao", "também", "tambem", "muito", "isso", "aqui", "gostaria",
  "quero", "tenho", "estou", "vou", "pra", "pro", "com", "uma", "do", "da", "dos", "das",
  "na", "nas", "ao", "às", "é", "são", "sao",
  "bom", "boa", "dia", "noite", "olá", "ola", "oi", "tudo", "bem", "preço",
  "agora", "ainda", "onde", "quando", "qual", "meu", "minha", "seu", "sua", "vocês", "têm",
]);
const ES_ONLY = new Set([
  "sí", "usted", "ustedes", "gracias", "muy", "pero", "eso", "aquí", "aqui",
  "quiero", "tengo", "estoy", "voy", "con", "una", "del", "el", "los", "las", "al",
  "es", "son", "bueno", "buena", "buenas", "buenos", "días", "dias",
  "noches", "hola", "bien", "precio", "ahora", "todavía", "donde", "dónde",
  "cuando", "cuándo", "cómo", "cuál", "mi", "su", "tienen", "puedo", "hay", "y",
  "también", "tambien", "qué", "señor", "señora", "disponibilidad", "semana",
]);
// "no", "fin", "está" e "también" estão nos dois: o peso vem das exclusivas.
const PT_EXCLUSIVE = [...PT_ONLY].filter((w) => !ES_ONLY.has(w));
const ES_EXCLUSIVE = [...ES_ONLY].filter((w) => !PT_ONLY.has(w));
const PT_SET = new Set(PT_EXCLUSIVE);
const ES_SET = new Set(ES_EXCLUSIVE);

/** Placar pt × es por stopwords + caracteres exclusivos (ã/õ/ç × ñ/¿/¡). */
export function portugueseSpanishScore(text: string): { pt: number; es: number } {
  const lower = String(text ?? "").toLowerCase();
  let pt = 0;
  let es = 0;
  for (const w of lower.split(/[^\p{L}]+/u)) {
    if (!w) continue;
    if (PT_SET.has(w)) pt++;
    if (ES_SET.has(w)) es++;
  }
  pt += (lower.match(/[ãõç]/g) ?? []).length;
  es += (lower.match(/[ñ¿¡]/g) ?? []).length * 2;
  return { pt, es };
}

const ONLY = LANGUAGE_CODES.map(baseLanguage).filter((c, i, a) => a.indexOf(c) === i);

/**
 * Detecta o idioma do texto. `undefined` = não dá para dizer (curto demais,
 * só emoji/URL/número, ou língua fora do catálogo).
 */
export function detectLanguage(text: string): DetectedLanguage | undefined {
  const alpha = alphabeticText(text);
  if (countAlphaChars(alpha) < MIN_ALPHA_CHARS) return undefined;

  let ranked: { lang: string; accuracy: number }[] = [];
  try {
    ranked = detectAll(alpha, { only: ONLY });
  } catch {
    ranked = [];
  }
  const { pt, es } = portugueseSpanishScore(alpha);

  // Heurística pt × es: decide quando o placar é claro, mesmo que o tinyld
  // tenha errado ou devolvido nada.
  const stopwordTotal = pt + es;
  if (stopwordTotal >= 2 && (pt >= es * 2 || es >= pt * 2)) {
    const winner = pt > es ? "pt" : "es";
    const top = ranked[0]?.lang;
    if (!top || top === "pt" || top === "es" || ranked[0].accuracy < 0.5) {
      const share = Math.max(pt, es) / stopwordTotal;
      return {
        lang: normalizeLanguageCode(winner)!,
        confidence: round(Math.min(0.95, 0.55 + share * 0.4)),
      };
    }
  }

  if (ranked.length === 0) return undefined;
  const top = ranked[0];
  const lang = normalizeLanguageCode(top.lang);
  if (!lang) return undefined;
  // `accuracy` do tinyld não é probabilidade: normaliza pelo 2º colocado.
  const second = ranked[1]?.accuracy ?? 0;
  const margin = top.accuracy + second > 0 ? top.accuracy / (top.accuracy + second) : 0;
  let confidence = Math.max(margin, Math.min(1, top.accuracy));
  // pt × es sem placar claro de stopwords = incerto.
  if ((top.lang === "pt" || top.lang === "es") && ranked[1] && ["pt", "es"].includes(ranked[1].lang)) {
    confidence = Math.min(confidence, 0.7);
  }
  return { lang, confidence: round(confidence) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
