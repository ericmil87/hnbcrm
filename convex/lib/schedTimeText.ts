/**
 * Agenda v2 (D1) — horários e dias citados num TEXTO DA IA (puro).
 *
 * O extrator do parser de confirmação (`extractDateTimeMentions`) foi feito para mensagens do cliente/humano e
 * descarta a frase com condicional ("se/caso/quando"), negação, pergunta de funcionamento etc. Aqui é o contrário:
 * o texto é da IA, o conjunto de horários é pequeno e conhecido (ofertas, agendamentos), e esconder um horário atrás
 * de "se preferir" não pode escondê-lo do guard nem do marcador de "mostrada". Este módulo só LÊ: devolve cada hora
 * citada com o último dia citado antes dela (o dia atravessa frases e linhas), e quem chama decide o que fazer.
 *
 * Horas aceitas: `08:00`, `8h`, `8hs`, `8h30`, "às 8", "pras 8", por extenso ("às oito", "às cinco da tarde",
 * "às oito e meia"), "meio-dia", "meio-dia e meia", "meia-noite". Faixas ("das 8 às 18h") e limites ("até as 18h",
 * "depois das 18h") NÃO são horário oferecido: somem do texto. Duração ("50 minutos", "1 hora") nunca é hora.
 * Dias: dia da semana, data (`15/06`), "dia 15", hoje, amanhã, depois de amanhã.
 */
import type { LocalDate } from "./schedTime";
import { addLocalDays, localDateOf, weekdayOf } from "./schedTime";

export type DayRef =
  | { kind: "weekday"; weekday: number }
  | { kind: "date"; month: number; day: number }
  | { kind: "dom"; day: number }
  | { kind: "rel"; offset: 0 | 1 | 2 };

export type TimeMention = {
  timeMin: number;
  /** Último dia citado ANTES da hora (no texto inteiro); ausente = nenhum dia citado até ali. */
  day?: DayRef;
  /** Índice da frase (linha/`.!?;`) em que a hora aparece. */
  sentence: number;
};

export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const WEEKDAY_RES: Array<[RegExp, number]> = [
  [/\bdomingo\b/g, 0],
  [/\bsegunda(?:-feira)?\b/g, 1],
  [/\bterca(?:-feira)?\b/g, 2],
  [/\bquarta(?:-feira)?\b/g, 3],
  [/\bquinta(?:-feira)?\b/g, 4],
  [/\bsexta(?:-feira)?\b/g, 5],
  [/\bsabado\b/g, 6],
];

const NUM_WORDS: Record<string, number> = {
  zero: 0, uma: 1, um: 1, duas: 2, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
};
const WORD_ALT = Object.keys(NUM_WORDS).join("|");

type Tok = { at: number; end: number } & (
  | { kind: "time"; timeMin: number }
  | { kind: "day"; day: DayRef }
  | { kind: "break" }
);

/** Troca por espaços (preserva posições) o que NÃO é horário oferecido: faixas e limites. */
function maskNonOffers(n: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return n
    .replace(/\b(?:das|de)\s+\d{1,2}(?::\d{2}|h\d{0,2}|hs)?[ \t]*(?:as|a|ate|-)[ \t]*\d{1,2}(?::\d{2}|h\d{0,2}|hs)?/g, blank)
    .replace(/\b\d{1,2}(?::\d{2}|h\d{0,2}|hs)[ \t]*(?:as|a|ate|-)[ \t]*\d{1,2}(?::\d{2}|h\d{0,2}|hs)\b/g, blank)
    .replace(/\b(?:ate|depois|antes|apos|a partir)\s+(?:d?as?|do|da)?\s*\d{1,2}(?::\d{2}|h\d{0,2}|hs)?/g, blank)
    .replace(/\b(?:domingos|segundas|tercas|quartas|quintas|sextas|sabados)\b/g, blank);
}

function pushTimes(n: string, out: Tok[]): void {
  const add = (m: RegExpMatchArray, timeMin: number) => {
    if (timeMin >= 0 && timeMin < 1440) out.push({ kind: "time", at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, timeMin });
  };
  const periodShift = (h: number, after: string): number => {
    const p = /^\s*(?:da|de|a)\s+(tarde|noite|manha|madrugada)\b/.exec(after);
    if (p && (p[1] === "tarde" || p[1] === "noite") && h < 12) return h + 12;
    return h;
  };
  // 08:00
  for (const m of n.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h < 24 && mi < 60) add(m, periodShift(h, n.slice((m.index ?? 0) + m[0].length)) * 60 + mi);
  }
  // 8h, 8hs, 8h30, 8 hrs
  for (const m of n.matchAll(/\b(\d{1,2})\s*(?:h|hs|hrs)(?:\s*(\d{2}))?\b/g)) {
    const h = Number(m[1]);
    const mi = m[2] ? Number(m[2]) : 0;
    if (h < 24 && mi < 60) add(m, periodShift(h, n.slice((m.index ?? 0) + m[0].length)) * 60 + mi);
  }
  // "às 8", "pras 8", "as 10 horas" (não "às 10 pessoas")
  for (const m of n.matchAll(/\b(?:as|pras|pra as|para as)\s+(\d{1,2})(?!\s*(?:pessoas?|dias?|vezes|anos?|min\w*|reais|%|\/|:\d|h(?:s|rs)?\b|h\d))\b/g)) {
    const h = Number(m[1]);
    if (h < 24) add(m, periodShift(h, n.slice((m.index ?? 0) + m[0].length)) * 60);
  }
  // "8 da manhã", "5 da tarde"
  for (const m of n.matchAll(/\b(\d{1,2})\s+da\s+(manha|tarde|noite)\b/g)) {
    const h = Number(m[1]);
    if (h < 24) add(m, periodShift(h, ` da ${m[2]}`) * 60);
  }
  // por extenso: "às oito", "às cinco da tarde", "às oito e meia", "às dez e quinze"
  const wordRe = new RegExp(`\\b(?:as|pras|pra as|para as|a)\\s+(${WORD_ALT})(?:\\s+e\\s+(meia|quinze|trinta|quarenta e cinco|quarenta))?\\b(?!\\s*(?:minutos?|min|pessoas?|dias?|vezes|anos?|reais))`, "g");
  for (const m of n.matchAll(wordRe)) {
    const h = NUM_WORDS[m[1]];
    const extra = m[2] === "meia" || m[2] === "trinta" ? 30 : m[2] === "quinze" ? 15 : m[2] === "quarenta e cinco" ? 45 : m[2] === "quarenta" ? 40 : 0;
    add(m, periodShift(h, n.slice((m.index ?? 0) + m[0].length)) * 60 + extra);
  }
  // meio-dia, meia-noite (com "e meia")
  for (const m of n.matchAll(/\bmeio[- ]dia(?:\s+e\s+(meia|quinze))?\b/g)) add(m, 720 + (m[1] === "meia" ? 30 : m[1] === "quinze" ? 15 : 0));
  for (const m of n.matchAll(/\bmeia[- ]noite\b/g)) add(m, 0);
}

function pushDays(n: string, out: Tok[]): void {
  for (const [re, weekday] of WEEKDAY_RES) {
    for (const m of n.matchAll(re)) out.push({ kind: "day", at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, day: { kind: "weekday", weekday } });
  }
  for (const m of n.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) out.push({ kind: "day", at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, day: { kind: "date", month, day } });
  }
  for (const m of n.matchAll(/\bdia\s+(\d{1,2})\b(?!\s*(?:\/|de\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)))/g)) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) out.push({ kind: "day", at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, day: { kind: "dom", day } });
  }
  for (const m of n.matchAll(/\b(depois de amanha|amanha|hoje)\b/g)) {
    out.push({ kind: "day", at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, day: { kind: "rel", offset: m[1] === "hoje" ? 0 : m[1] === "amanha" ? 1 : 2 } });
  }
}

/** Frases = trechos entre sequências de `.`, `!`, `?`, `;` e quebras de linha (mesma segmentação de `splitSentences`). */
function breaks(n: string): number[] {
  const out: number[] = [];
  for (const m of n.matchAll(/[.!?;\n]+/g)) out.push(m.index ?? 0);
  return out;
}

/** Frases do texto (com o terminador), na MESMA segmentação do índice `sentence` de `extractAiTimes`. */
export function splitSentences(text: string): Array<{ raw: string; term: string }> {
  const out: Array<{ raw: string; term: string }> = [];
  let last = 0;
  for (const m of text.matchAll(/[.!?;\n]+/g)) {
    out.push({ raw: text.slice(last, m.index ?? 0), term: m[0] });
    last = (m.index ?? 0) + m[0].length;
  }
  out.push({ raw: text.slice(last), term: "" });
  return out;
}

export function extractAiTimes(text: string): TimeMention[] {
  const n = maskNonOffers(norm(text));
  const toks: Tok[] = [];
  pushTimes(n, toks);
  pushDays(n, toks);
  toks.sort((a, b) => a.at - b.at || (a.kind === "day" ? -1 : 1));
  const bs = breaks(n);
  const sentenceOf = (pos: number) => bs.filter((b) => b < pos).length;
  const out: TimeMention[] = [];
  let day: DayRef | undefined;
  const seen = new Set<string>();
  for (const t of toks) {
    if (t.kind === "day") {
      day = t.day;
      continue;
    }
    if (t.kind !== "time") continue;
    const key = `${t.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ timeMin: t.timeMin, ...(day ? { day } : {}), sentence: sentenceOf(t.at) });
  }
  return out;
}

/** O dia citado é compatível com a data local `date`? `today` ancora "hoje/amanhã". */
export function dayMatches(day: DayRef, date: LocalDate, today: LocalDate): boolean {
  const [, mm, dd] = date.split("-").map(Number) as [number, number, number];
  switch (day.kind) {
    case "weekday":
      return weekdayOf(date) === day.weekday;
    case "date":
      return day.month === mm && day.day === dd;
    case "dom":
      return day.day === dd;
    case "rel":
      return addLocalDays(today, day.offset) === date;
  }
}

export function todayOf(now: number, tz: string): LocalDate {
  return localDateOf(now, tz);
}
