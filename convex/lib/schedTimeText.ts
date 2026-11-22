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
  /** Índice da ORAÇÃO (frase partida também por "mas/porém"): recorte da negação ("oito e meia não tenho, mas tenho 8h…"). */
  clause: number;
  /** Posição da hora no texto normalizado (`norm(text)`, mesmo comprimento): para medir a distância até uma negação ou oferta. */
  at: number;
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

/** Horas por extenso, 1 a 23 (não há "às um"/"às dois": a hora é "uma"/"duas"). Mais longas primeiro na alternação. */
const NUM_WORDS: Record<string, number> = {
  "vinte e tres": 23, "vinte e duas": 22, "vinte e uma": 21, vinte: 20, dezenove: 19, dezoito: 18, dezessete: 17, dezesseis: 16, quinze: 15,
  quatorze: 14, catorze: 14, treze: 13, doze: 12, onze: 11, dez: 10, nove: 9, oito: 8, sete: 7, seis: 6, cinco: 5, quatro: 4, tres: 3, duas: 2, uma: 1,
};
const WORD_ALT = Object.keys(NUM_WORDS).join("|");
/** Hora por extenso SEM "às": só com dia/substantivo de agenda antes ou continuando uma lista de horas. */
const NOUN_CONTEXT = /\b(?:vaga|vagas|horario|horarios|consulta|sessao|atendimento|agenda|agendamento|disponivel|livre)\b/;
const DURATION_CUE = /\b(?:dura|duracao|leva|demora|tempo|valor|custa|cerca de|uns|umas|mais de|menos de|apenas|ate|depois|antes|apos)\b|r\$/;
const NEXT_NOUN_EXCLUDE = /^\s*(?:pessoas?|sessoes|sessao|minutos?|min\b|dias?|vezes|anos?|reais|real\b|consultas?|pacientes?|vagas?|opcoes|horarios|semanas?|meses|mes\b|exames?|parcelas?)/;

type Tok = { at: number; end: number } & (
  | { kind: "time"; timeMin: number }
  | { kind: "day"; day: DayRef }
  | { kind: "break" }
);

/** Troca por espaços (preserva posições) o que NÃO é horário oferecido: faixas e limites. */
function maskNonOffers(n: string, keepRangeStart: boolean): string {
  const blank = (m: string) => " ".repeat(m.length);
  // Faixa "das X às Y": some inteira (guard) ou deixa só o INÍCIO como hora ("às X"; marcação de ofertas mostradas).
  const range = (m: string, start: string) => (keepRangeStart ? `as ${start}`.padEnd(m.length, " ") : blank(m));
  return n
    .replace(/\b(?:das|de)\s+(\d{1,2}(?::\d{2}|h\d{0,2}|hs)?)[ \t]*(?:as|a|ate|-)[ \t]*\d{1,2}(?::\d{2}|h\d{0,2}|hs)?/g, (m, a) => range(m, a))
    .replace(/\b(\d{1,2}(?::\d{2}|h\d{0,2}|hs))[ \t]*(?:as|a|ate|-)[ \t]*\d{1,2}(?::\d{2}|h\d{0,2}|hs)\b/g, (m, a) => (keepRangeStart ? a.padEnd(m.length, " ") : blank(m)))
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
  // por extenso COM "às": "às oito", "às cinco da tarde", "às oito e meia", "às dez e quinze", "às dez em ponto"
  const extraOf = (x: string | undefined) => (x === "meia" || x === "trinta" ? 30 : x === "quinze" ? 15 : x === "quarenta e cinco" ? 45 : x === "quarenta" ? 40 : 0);
  const tail = "(?:\\s+e\\s+(meia|quinze|trinta|quarenta e cinco|quarenta))?(?:\\s+(?:em ponto|horas?))?";
  const wordRe = new RegExp(`\\b(?:as|pras|pra as|para as|a)\\s+(${WORD_ALT})${tail}\\b(?!\\s*(?:minutos?|min|pessoas?|dias?|vezes|anos?|reais))`, "g");
  for (const m of n.matchAll(wordRe)) {
    // "para as duas juntas", "vaga para as duas:" = para AS DUAS PESSOAS, não 2h (sem período, "e meia" nem "horas" depois).
    if (m[1] === "duas" && /^(?:para|pra)\s/.test(m[0]) && !m[2] && !/^\s*(?:horas?\b|em ponto|da\s+(?:tarde|manha|noite|madrugada))/.test(n.slice((m.index ?? 0) + m[0].length))) continue;
    if (m[1] === "duas" && /^\s*(?:juntas|juntos|pessoas|sessoes|aulas|vagas|opcoes|vezes|mulheres|amigas|criancas)\b/.test(n.slice((m.index ?? 0) + m[0].length))) continue;
    add(m, periodShift(NUM_WORDS[m[1]], n.slice((m.index ?? 0) + m[0].length)) * 60 + extraOf(m[2]));
  }
  // SEM "às": "quinta dez e meia", "sexta oito em ponto", "segunda oito horas, nove horas ou cinco da tarde"
  const bare = new RegExp(`\\b(${WORD_ALT})${tail}\\b`, "g");
  const dayRe = /\b(?:domingo|segunda|terca|quarta|quinta|sexta|sabado|hoje|amanha|dia\s+\d{1,2}|\d{1,2}\/\d{1,2})(?:-feira)?\b/g;
  for (const m of n.matchAll(bare)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (out.some((t) => t.kind === "time" && t.at <= at && at < t.end)) continue; // já lida com "às"
    if (NEXT_NOUN_EXCLUDE.test(n.slice(end))) continue;
    const sentStart = Math.max(n.lastIndexOf(".", at), n.lastIndexOf("!", at), n.lastIndexOf("?", at), n.lastIndexOf("\n", at), n.lastIndexOf(";", at)) + 1;
    const window = n.slice(Math.max(sentStart, at - 40), at);
    if (DURATION_CUE.test(window)) continue;
    const prevWord = /(?:^|\s)(\w+)\s*$/.exec(window)?.[1];
    if (prevWord && /^(?:de|em|por|com|para|pra|a|o|e|que|sao|faz|ha|faltam|falta|ja)$/.test(prevWord) && !/^e$/.test(prevWord)) continue;
    const prevTime = [...out].reverse().find((t) => t.kind === "time" && t.end <= at);
    const continuation = prevTime !== undefined && /^[\s,;]*(?:ou|e)?[\s,;]*$/.test(n.slice(prevTime.end, at)) && n.slice(prevTime.end, at).length <= 6;
    const dayBefore = [...window.matchAll(dayRe)].length > 0;
    const nounBefore = NOUN_CONTEXT.test(window);
    if (!(continuation || dayBefore || nounBefore)) continue;
    const w = m[1];
    // "uma"/"duas" soltas são artigo/quantidade ("uma vaga", "duas opções"): só com período, "em ponto" ou minutos.
    if ((w === "uma" || w === "duas") && m[0] === w && !/^\s+da\s+(?:tarde|manha|noite)/.test(n.slice(end))) continue;
    add(m, periodShift(NUM_WORDS[w], n.slice(end)) * 60 + extraOf(m[2]));
  }
  // lista numérica com a unidade só no fim: "Segunda: 8, 9 ou 17h" (o "h" vale para a lista inteira)
  for (const m of n.matchAll(/(?<![\d/:])\b((?:\d{1,2}\s*(?:,|;|ou|e)\s*)+)(\d{1,2})\s*(?:h|hs|hrs)(?!\d)\b/g)) {
    const nums = [...m[1].matchAll(/\d{1,2}/g)];
    if (nums.some((x) => Number(x[0]) > 23)) continue;
    for (const x of nums) {
      const pos = (m.index ?? 0) + (x.index ?? 0);
      if (out.some((t) => t.kind === "time" && t.at === pos)) continue;
      out.push({ kind: "time", at: pos, end: pos + x[0].length, timeMin: Number(x[0]) * 60 });
    }
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

export function extractAiTimes(text: string, opts: { keepRangeStart?: boolean } = {}): TimeMention[] {
  const n = maskNonOffers(norm(text), opts.keepRangeStart === true);
  const toks: Tok[] = [];
  pushTimes(n, toks);
  pushDays(n, toks);
  toks.sort((a, b) => a.at - b.at || (a.kind === "day" ? -1 : 1));
  const bs = breaks(n);
  const sentenceOf = (pos: number) => bs.filter((b) => b < pos).length;
  // Oração = frase partida também por "mas/porém/só que": cada uma tem o seu índice.
  const clauseBreaks = [...bs, ...[...n.matchAll(/\b(?:mas|porem|so que)\b/g)].map((m) => m.index ?? 0)].sort((a, b) => a - b);
  const clauseOf = (pos: number) => clauseBreaks.filter((b) => b < pos).length;
  const out: TimeMention[] = [];
  let day: DayRef | undefined;
  const seen = new Set<string>();
  for (let ti = 0; ti < toks.length; ti++) {
    const t = toks[ti];
    if (t.kind === "day") {
      day = t.day;
      continue;
    }
    if (t.kind !== "time") continue;
    const key = `${t.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // "10h de terça ou 14h de quarta": o dia que vem DEPOIS, ligado por "de/do/da", é o da hora (não o dia da hora anterior).
    const next = toks[ti + 1];
    const own = next && next.kind === "day" && /^\s+(?:de|do|da|no|na)\s+$/.test(n.slice(t.end, next.at)) ? next.day : day;
    out.push({ timeMin: t.timeMin, ...(own ? { day: own } : {}), sentence: sentenceOf(t.at), clause: clauseOf(t.at), at: t.at });
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
