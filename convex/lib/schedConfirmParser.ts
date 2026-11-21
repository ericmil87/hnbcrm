/**
 * Agenda v2 (PR C0) — parser determinístico de confirmação de horário em PT-BR (puro).
 *
 * Quando o dono do negócio responde ao cliente pelo WhatsApp ("Ok, confirmado quinta 10h"),
 * este módulo decide se a mensagem PARECE uma confirmação de horário e extrai ato, dia e hora.
 * É o pré-filtro barato (custo zero quando negativo) e a segunda opinião de um classificador LLM
 * (outro PR). Ele nunca grava nada e não lê banco.
 *
 * Regra de ouro: falso positivo é o pior erro. Na dúvida o resultado é "nenhum", "informativo",
 * "propos" ou uma confirmação PARCIAL (dia/hora não resolvidos). O ato "confirmou" só sai de um
 * trecho limpo (sem negação, pergunta, passado, intenção futura, faixa de funcionamento…).
 *
 * Puro: o relógio (`now`, instante de envio) e o fuso IANA da org entram por argumento; nada de
 * `Date.now()` nem do TZ do processo. `Intl` puro, sem dependência. Fuso inválido lança.
 *
 * Resolução de data auto-contida de propósito (o PR A2 traz `schedRelativeDates` para as tools da
 * IA; a unificação fica para depois).
 */

export type LocalDate = string; // "YYYY-MM-DD"

export type ConfirmAct = "confirmou" | "propos" | "remarcou" | "cancelou" | "informativo" | "nenhum";

export type ConfirmServiceRef<TId extends string = string> = { _id: TId; name: string };

export type ParseConfirmationContext<TId extends string = string> = {
  /** Instante de envio da mensagem (ms). */
  now: number;
  /** Fuso IANA da org. */
  tz: string;
  services?: Array<ConfirmServiceRef<TId>>;
  /** Proposta aberta na conversa: completa dia/hora que a resposta curta ("ok, pode ser") não repete. */
  proposal?: { localDate?: LocalDate; timeMin?: number };
};

export type ConfirmEvidence = {
  /** Trechos literais (da mensagem original) que sustentam cada campo. */
  act: string[];
  date: string[];
  time: string[];
  service: string[];
  /** Trechos que derrubaram a leitura (negação, pergunta, passado, faixa…). */
  blocked: string[];
};

export type ParsedConfirmation<TId extends string = string> = {
  act: ConfirmAct;
  /** Só vem preenchido para confirmou/propos/remarcou/cancelou. */
  localDate?: LocalDate;
  /** Minutos desde 00:00 locais. */
  timeMin?: number;
  serviceId?: TId;
  /** `act`: houve ato acionável; `date`/`time`: resolvidos (na mensagem ou pela proposta). */
  resolved: { act: boolean; date: boolean; time: boolean };
  /** "completo" = ato + dia + hora; "parcial" = ato sem dia ou sem hora; "nenhum" = sem ato. */
  level: "completo" | "parcial" | "nenhum";
  /** Dia/hora vieram da `proposal` da conversa, não da mensagem. */
  fromProposal: { date: boolean; time: boolean };
  evidence: ConfirmEvidence;
  signals: string[];
  negatives: string[];
};

export type PrefilterResult = { pass: boolean; signals: string[]; negatives: string[] };

/** Acima disso a mensagem não é uma resposta curta de confirmação. */
export const CONFIRM_MAX_CHARS = 600;

// ───────────────────────── datas locais (puro, Intl) ─────────────────────────

const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

function assertTz(tz: string): void {
  // Lança RangeError em fuso inválido.
  new Intl.DateTimeFormat("en-US", { timeZone: tz });
}

function localClock(at: number, tz: string): { date: LocalDate; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { date: `${g("year")}-${pad2(g("month"))}-${pad2(g("day"))}`, minutes: (g("hour") % 24) * 60 + g("minute") };
}

function ymdParts(date: LocalDate): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}
function fmtDate(y: number, m: number, d: number): LocalDate {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}
function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function addDays(date: LocalDate, n: number): LocalDate {
  const [y, m, d] = ymdParts(date);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return fmtDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function weekdayOf(date: LocalDate): number {
  const [y, m, d] = ymdParts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
}
function daysBetween(a: LocalDate, b: LocalDate): number {
  const [ya, ma, da] = ymdParts(a);
  const [yb, mb, db] = ymdParts(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / DAY_MS);
}

// ───────────────────────── normalização (mesmo comprimento) ─────────────────────────

/**
 * Minúsculas, sem acento, espaços normalizados — UM caractere de saída por unidade UTF-16 de
 * entrada, para que os índices do texto normalizado valham no original (evidência literal).
 * "ª"/"º" ficam (servem para "5ª").
 */
function fold(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      out += " ";
      continue;
    }
    const d = ch.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    out += d.length === 0 ? " " : d[0];
  }
  return out;
}

function maskRe(s: string, re: RegExp): string {
  return s.replace(re, (m) => " ".repeat(m.length));
}

// ───────────────────────── vocabulário ─────────────────────────

const WEEKDAYS: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const WEEKDAY_ABBR: Record<string, number> = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};
const NUM_WORDS: Record<string, number> = { uma: 1, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12 };
const NUM = `\\d{1,2}|${Object.keys(NUM_WORDS).join("|")}`;
const PERIOD = "manha|tarde|noite|madrugada";
const DAY_ALT = "domingo|segunda|terca|quarta|quinta|sexta|sabado|seg|ter|qua|qui|sex|sab|dom";
const FULL_DAY_ALT = "domingo|segunda|terca|quarta|quinta|sexta|sabado";
const QTY =
  "pessoas?|vezes|parcelas?|reais|real|dias|anos|meses|semanas|unidades|itens|fotos|mil|min|minutos|kg|kgs|litros|clientes|convidados|vagas|lugares|cadeiras|mesas|pacientes|criancas|adultos|sessoes|consultas|primeiras|primeiros";

const num = (g: string): number => (/^\d/.test(g) ? Number(g) : (NUM_WORDS[g] ?? NaN));

// Atos
const RE_REMARCAR =
  /\b(?:remarc\w*|remarqu\w*|reagend\w*|adi(?:ar|amos|ei|ou|ado|ada)|antecip\w+|(?:mudar|mudamos|mudei|trocar|trocamos|trocei)\s+(?:o\s+|a\s+)?(?:horario|dia|data|para|pra)|(?:passar|passamos|passei|transferir|transferimos|transferi)\s+(?:o\s+\w+\s+|a\s+\w+\s+)?(?:pra|para))\b/;
const RE_CANCELAR = /\b(?:cancel\w*|desmarc\w*|desmarqu\w*|desagend\w*)/;
const RE_CONFIRMAR = new RegExp(
  [
    "confirmad[oa]+s?",
    "confirm(?:o|ei|amos|ou)",
    "fechad[oa]+s?",
    "fechou",
    "combinad[oa]+s?",
    "marcad[oa]+s?",
    "agendad[oa]+s?",
    "reservad[oa]s?",
    "garantid[oa]s?",
    "anotad[oa]s?",
    "marqu(?:ei|emos)",
    "marcamos",
    "agend(?:ei|amos)",
    "anotei",
    "reservei",
    "te espero",
    "te aguardo",
    "te esperamos",
    "te aguardamos",
    "vou te esperar",
    "estamos te esperando",
    "esperamos (?:voce|vc)",
    "aguardamos (?:voce|vc)",
    "te vejo",
    "pode (?:vir|vim|passar|comparecer|chegar)",
    "te atend(?:o|emos)",
    "atend(?:o|emos) (?:voce|vc)",
    "vou te atender",
  ]
    .map((p) => `\\b${p}\\b`)
    .join("|"),
);
// Respostas curtas que só valem com uma proposta aberta na conversa.
const RE_WEAK = /\b(?:ok|okay|okk+|blz|beleza|certo|perfeito|show|isso|sim|positivo|tranquilo|combina|bora|pode ser|serve|ta bom|ta otimo|fica bom)\b/;
// O humano oferece/pergunta/pede confirmação do outro lado: ainda é proposta.
const RE_PROPOR = new RegExp(
  [
    "pode ser",
    "poderia",
    "poderiamos",
    "podemos",
    "podia",
    "consegue",
    "conseguimos",
    "consigo",
    "(?:tenho|temos|tem) (?:vaga|horario|encaixe|disponibilidade)",
    "que tal",
    "seria",
    "serve",
    "funciona",
    "topa",
    "prefere",
    "preferencia",
    "melhor",
    "disponivel",
    "disponiveis",
    "livre",
    "vago",
    "vaga",
    "opcao",
    "opcoes",
    "encaixo",
    "encaixar",
    "sugiro",
    "sugestao",
    "proponho",
    "proposta",
    "da pra",
    "da para",
    "tem como",
    "me (?:diz|fala|avisa|confirma\\w*)",
    "confirm(?:a|e|em|ar)",
    "ou",
  ]
    .map((p) => `\\b${p}\\b`)
    .join("|"),
);
const TAG_QUESTION = /\b(?:pode ser|pode|ta bom|ta ok|ok|certo|ne|nao|tudo bem|blz|beleza|serve|combinado|fechado|confirma|confirmamos|ta|topa|bora|ta certo|esta bom|esta certo)\b/;

// Bloqueadores
const SAFE_NEG = /\b(?:sem (?:problemas?|falta|duvida|compromisso)|nao (?:tem problema|ha problema|se preocupe|esqueca|esquece|falte|atrase|se atrase|tem pressa|precisa (?:trazer|levar|pagar|nada|se preocupar|chegar|avisar|ligar)))\b/g;
const RE_NEG = /\b(?:nao|nem|nunca|jamais|sem|impossivel|infelizmente|indisponivel|lotad[oa]|ocupad[oa]|cheio|cheia|esgotad[oa]|desisti\w*|recus\w+|naum|nn|n)\b/;
const RE_PAST =
  /\b(?:ontem|anteontem|antes de ontem|semana passada|mes passado|ano passado|passad[oa]s?|ultim[oa]s?|foi(?!\s+(?:marcad|agendad|confirmad|combinad|fechad|reservad|anotad))|fui|fomos|foram|estive|esteve|estiveram|veio|vieram|vim|viemos|faltou|faltaram|faltei|compareceu|compareci|compareceram|aconteceu|atrasou|atrasei|tinha|tinhamos|tinham|estava|estavam|estavamos|havia|era|eram|ja passou|apareceu|chegou|ligou|mandou|enviou|pagou|esqueceu|esqueci|ficou(?!\s+(?:marcad|combinad|agendad|confirmad|fechad|reservad|anotad))|deveria|devia|queria)\b/;
const RE_INTENT =
  /\b(?:vou|vamos|vai|iremos|irei|preciso|precisamos|posso|podemos|consigo|conseguimos|tenho que|temos que|deixa eu|deixe eu|tentar|tento|tentamos)\s+(?:\w+\s+){0,2}(?:confirmar|marcar|agendar|ver|verificar|checar|olhar|consultar|fechar|encaixar|avisar|responder|saber)\b/;
const RE_FUNC =
  /\b(?:funcionamos|funcionamento|funciona(?:mos)?|expediente|abrimos|abre|abertos?|abertas?|fecha(?:mos)?\s+(?:as|ate|de|aos|nos)|horario (?:de|do) (?:atendimento|funcionamento|trabalho|expediente)|atendimento (?:de|das|da|ate|nos|aos|em)|aos (?:sabados|domingos|feriados)|feriados?|plantao|fim de semana|final de semana|fds|dias? uteis?|dia util)\b|(?<!te )atend(?:o|emos)\b(?!\s+(?:voce|vc|ele|ela))/;
const RE_PLURAL_DAY = /\b(?:domingos|segundas|tercas|quartas|quintas|sextas|sabados)\b/;
const RE_EVERY = new RegExp(`\\b(?:tod[oa]s?|cada)\\s+(?:(?:a|o|as|os)\\s+)?(?:dias?|semanas?|${FULL_DAY_ALT})`);
const RE_DAY_RANGE = new RegExp(`\\b(?:${DAY_ALT})(?:[- ]?feira)?\\s*(?:a|ate|e|\\/|-)\\s*(?:${DAY_ALT})\\b`);
const RE_TIME_RANGE_A = /\b(?:das?|de|entre)\s+\d{1,2}\s*(?:h|hs|hr|hrs|horas?|:\d{2}|h\d{2})?\s*(?:as|a|ate|e)\s+\d{1,2}\b/;
const RE_TIME_RANGE_B = /\b\d{1,2}(?::\d{2}|\s*h(?:s|r|rs)?\s*\d{0,2})\s*(?:-|ate|as|a)\s*\d{1,2}(?::\d{2}|\s*h)/;
const RE_LIMIT = /\b(?:ate|antes|depois|apos|a partir)\s+(?:d[eoa]s?\s+|o\s+|a\s+)?(?:as\s+)?(?:dia\s+)?(?:\d|meio|segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje)/;
const RE_FIN = /\b(?:recebimento|comprovante|pagamento|pix|boleto|pedido|cadastro|e-?mail|cpf|cnpj|entrega|envio|nota fiscal|fatura|orcamento|transferencia|deposito|compra|cartao)\b/;
const RE_QSTART =
  /^\s*(?:e\s+)?(?:qual|quais|quando|quanto|quantos|que horas|a que horas|onde|quem|por que|porque|como|sera que|seria possivel|tem como|da pra|da para|consegue|poderia|podia|pode me|voce consegue|vc consegue|tem horario|tem vaga|ainda tem|ta livre|esta livre)\b/;
const RE_COND =
  /\b(?:se|caso|talvez|quem sabe|vou ver|ver se|depende|provavelmente|acho que|acredito|vamos ver|vou tentar|preciso ver|ter que ver|a confirmar|salvo|so se|quando|assim que|desde que)\b/;
const KEEP_AS_COMO = /\b(?:como|conforme)\s+(?:combinado|falamos|conversamos|combinamos|marcado|agendado)\b/g;

// ───────────────────────── análise por trecho ─────────────────────────

type DayTok =
  | { kind: "rel"; offset: number; lit: string }
  | { kind: "wd"; wd: number; mod: "bare" | "next" | "weekNext"; lit: string }
  | { kind: "dom"; day: number; lit: string }
  | { kind: "dmy"; d: number; m: number; y?: number; lit: string };
type TimeTok = { min: number | null; lit: string; why?: string };
type ActHit = { act: "remarcou" | "cancelou" | "confirmou" | "propos"; lit: string };

type Seg = {
  start: number;
  end: number;
  question: boolean;
  blockers: string[]; // sem "pergunta"
  acts: ActHit[];
  weak: boolean;
  days: DayTok[];
  times: TimeTok[];
  weekNext: boolean;
  blockedLits: string[];
  tagQuestion: boolean;
  words: number;
};

type Analysis = { text: string; n: string; segs: Seg[]; globalBlock: string[] };

function applyPeriod(h: number, minutes: number, period: string | undefined): { min: number | null; why?: string } {
  if (h > 23 || minutes > 59) return { min: null, why: "hora_invalida" };
  let hh = h;
  if (period) {
    if (period === "tarde") {
      if (h >= 1 && h <= 11) hh = h + 12;
      else if (!(h === 12 || (h >= 13 && h <= 18))) return { min: null, why: "hora_ambigua" };
    } else if (period === "noite") {
      if (h >= 1 && h <= 11) hh = h + 12;
      else if (!(h >= 18 && h <= 23)) return { min: null, why: "hora_ambigua" };
    } else if (period === "manha") {
      if (!(h >= 5 && h <= 11)) return { min: null, why: "hora_ambigua" };
    } else if (period === "madrugada") {
      if (!(h >= 1 && h <= 5)) return { min: null, why: "hora_ambigua" };
    }
  } else if (h >= 1 && h <= 6) {
    // "3h" sem período pode ser 03:00 ou 15:00.
    return { min: null, why: "hora_ambigua" };
  } else if (h === 0) {
    return { min: null, why: "hora_ambigua" };
  }
  return { min: hh * 60 + minutes };
}

const DURATION_PREFIX = /(?:^|\s)(?:por|durante|dura|duram|duracao|daqui|daqui a|em|faltam|falta|cerca de|aproximadamente|mais de|a cada|(?:consulta|sessao|atendimento|aula|reuniao|duracao|tempo) de)\s*$/;
const HORAS_PREFIX = /(?:\bas|pelas|pras)\s*$/;

function analyzeSegment(orig: string, n: string, start: number, end: number, question: boolean): Seg {
  const t = n.slice(start, end);
  const t2 = maskRe(t, /\b(?:depois|dps|depos)\s+d[eo]\s+amanha+\b|\bdepois\s+d\s+amanha\b/g);
  const lit = (a: number, b: number) => orig.slice(start + a, start + b).trim();
  const seg: Seg = {
    start,
    end,
    question,
    blockers: [],
    acts: [],
    weak: false,
    days: [],
    times: [],
    weekNext: false,
    blockedLits: [],
    tagQuestion: false,
    words: t.trim().split(/\s+/).filter(Boolean).length,
  };
  const block = (kind: string, m: RegExpExecArray | null) => {
    if (!seg.blockers.includes(kind)) seg.blockers.push(kind);
    if (m) seg.blockedLits.push(lit(m.index, m.index + m[0].length));
  };

  // ── bloqueadores
  const tn = maskRe(maskRe(t2, SAFE_NEG), KEEP_AS_COMO);
  let m: RegExpExecArray | null;
  if ((m = RE_NEG.exec(tn))) block("negacao", m);
  if ((m = RE_PAST.exec(t2))) block("passado", m);
  if ((m = RE_INTENT.exec(t2))) block("intencao", m);
  if ((m = RE_LIMIT.exec(t2))) block("limite", m);
  if ((m = RE_FIN.exec(t2))) block("outro_assunto", m);
  for (const re of [RE_FUNC, RE_PLURAL_DAY, RE_EVERY, RE_DAY_RANGE, RE_TIME_RANGE_A, RE_TIME_RANGE_B]) {
    if ((m = re.exec(t2))) block("funcionamento", m);
  }
  const isQuestion = question || RE_QSTART.test(maskRe(t2, KEEP_AS_COMO));
  seg.question = isQuestion;
  seg.tagQuestion = question && seg.words <= 6 && TAG_QUESTION.test(t2);

  // ── atos
  const hit = (act: ActHit["act"], re: RegExp) => {
    const x = re.exec(t2);
    if (x) seg.acts.push({ act, lit: lit(x.index, x.index + x[0].length) });
    return !!x;
  };
  const propor = RE_PROPOR.exec(maskRe(t2, KEEP_AS_COMO));
  hit("remarcou", RE_REMARCAR);
  hit("cancelou", RE_CANCELAR);
  hit("confirmou", RE_CONFIRMAR);
  seg.weak = RE_WEAK.test(t2);

  // ── tokens (máscara progressiva sobre `s`)
  let s = t;
  const scan = (re: RegExp, fn: (x: RegExpExecArray) => boolean) => {
    const hits: Array<[number, number]> = [];
    for (const x of s.matchAll(re)) if (fn(x)) hits.push([x.index!, x.index! + x[0].length]);
    for (const [a, b] of hits) s = s.slice(0, a) + " ".repeat(b - a) + s.slice(b);
  };
  const xlit = (x: RegExpExecArray) => lit(x.index!, x.index! + x[0].length);

  // faixas viram bloqueio (já marcado acima); só mascaramos para não virar token
  s = maskRe(s, RE_TIME_RANGE_A.global ? RE_TIME_RANGE_A : new RegExp(RE_TIME_RANGE_A.source, "g"));
  s = maskRe(s, new RegExp(RE_TIME_RANGE_B.source, "g"));
  s = maskRe(s, new RegExp(RE_DAY_RANGE.source, "g"));
  s = maskRe(s, new RegExp(RE_PLURAL_DAY.source, "g"));
  s = maskRe(s, new RegExp(RE_EVERY.source, "g"));
  s = maskRe(s, /\b(?:depois|dps|depos)\s+d[eo]\s+amanha+\b|\bdepois\s+d\s+amanha\b/g);
  // "depois de amanhã" volta como token abaixo, a partir de t
  for (const x of t.matchAll(/\b(?:depois|dps|depos)\s+d[eo]\s+amanha+\b|\bdepois\s+d\s+amanha\b/g)) {
    seg.days.push({ kind: "rel", offset: 2, lit: xlit(x) });
  }

  // dd/mm[/aa[aa]]
  scan(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?!\d)/g, (x) => {
    const d = Number(x[1]);
    const mo = Number(x[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return false;
    const y = x[3] ? (x[3].length === 2 ? 2000 + Number(x[3]) : Number(x[3])) : undefined;
    seg.days.push({ kind: "dmy", d, m: mo, y, lit: xlit(x) });
    return true;
  });
  // "27 de novembro", "27 nov" (com "de")
  scan(
    new RegExp(`(?:\\bdia\\s+)?\\b(\\d{1,2})\\s*(?:de\\s+)?(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\\b|(?:\\bdia\\s+)?\\b(\\d{1,2})\\s+de\\s+(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\\b`, "g"),
    (x) => {
      const d = Number(x[1] ?? x[3]);
      const mo = MONTHS[x[2] ?? x[4]];
      if (!mo || d < 1 || d > 31) return false;
      seg.days.push({ kind: "dmy", d, m: mo, lit: xlit(x) });
      return true;
    },
  );
  // "dia 27"
  scan(/\bdia\s+(\d{1,2})(?:\s*[ºo°](?![a-z]))?(?![\d:/]|\s*h\b|\s*hs\b)/g, (x) => {
    const d = Number(x[1]);
    if (d < 1 || d > 31) return false;
    seg.days.push({ kind: "dom", day: d, lit: xlit(x) });
    return true;
  });

  // semana que vem
  scan(/\b(?:semana|sem)\s+(?:que|q)\s+vem\b|\bproxima\s+semana\b|\bsemana\s+proxima\b/g, () => {
    seg.weekNext = true;
    return true;
  });

  const wdMod = (a: number, b: number): "bare" | "next" | "weekNext" => {
    const before = t.slice(0, a);
    const after = t.slice(b);
    if (/^\s*(?:da\s+)?(?:semana\s+(?:que|q)\s+vem|proxima\s+semana|semana\s+proxima)/.test(after) || seg.weekNext) return "weekNext";
    if (/^\s*(?:que vem|q vem|qvem|proxima|prox|que vai vir)\b/.test(after) || /\b(?:proxim[oa]|prox)\.?\s+(?:n[ao]\s+)?$/.test(before)) return "next";
    return "bare";
  };
  const ORDINAL_AFTER = /^\s*(?:via|vez|parcela|opcao|chance|mao|fase|etapa|sessao|consulta|visita|ligacao|tentativa|vaga|parte|linha|coluna|pessoa|prova|chamada|lista|turma|aula)\b/;

  // dia da semana por extenso
  scan(new RegExp(`\\b(${FULL_DAY_ALT})(?:[- ]?feira)?\\b`, "g"), (x) => {
    const a = x.index!;
    const b = a + x[0].length;
    if (ORDINAL_AFTER.test(t.slice(b))) return true; // consome sem virar dia
    seg.days.push({ kind: "wd", wd: WEEKDAYS[x[1]], mod: wdMod(a, b), lit: xlit(x) });
    return true;
  });
  // "5ª", "5a feira", "5ªf"
  scan(/\b([2-6])\s*(?:ª|º)(?:\s*-?\s*(?:feira|f)\b)?|\b([2-6])\s*[ao]?\s*-?\s*(?:feira|f)\b/g, (x) => {
    const k = Number(x[1] ?? x[2]);
    seg.days.push({ kind: "wd", wd: k - 1, mod: wdMod(x.index!, x.index! + x[0].length), lit: xlit(x) });
    return true;
  });
  // abreviações ambíguas ("ter", "sex", "dom"…) só contam coladas a uma hora
  scan(new RegExp(`\\b(${Object.keys(WEEKDAY_ABBR).join("|")})\\b\\.?(?:[- ]?feira)?`, "g"), (x) => {
    const a = x.index!;
    const b = a + x[0].length;
    const after = t.slice(b);
    const timeNext = new RegExp(`^\\s*(?:as\\s+|a\\s+|pelas\\s+)?(?:(?:${NUM})\\s*(?:h|hs|hr|hrs|:\\d{2})|(?:${NUM})\\s*(?:da|de)\\s+(?:${PERIOD})|meio[- ]?dia|\\d{1,2}\\s*$|\\d{1,2}\\s+(?!${QTY}))`).test(after) &&
      !new RegExp(`^\\s*as\\s+\\d{1,2}\\s+(?:${QTY})\\b`).test(after);
    if (!timeNext) return false;
    if (x[1] === "ter" && /\b(?:vou|vai|vamos|vao|posso|pode|podemos|pra|para|que|so|nao|ainda|de|a|ao|vc|voce|eu|ele|ela|tem|deve|preciso|quero|queria|e|ja)\s*$/.test(t.slice(0, a))) return false;
    seg.days.push({ kind: "wd", wd: WEEKDAY_ABBR[x[1]], mod: wdMod(a, b), lit: xlit(x) });
    return true;
  });

  // hoje / amanhã
  scan(/\b(?:hoje|hj)\b/g, (x) => {
    seg.days.push({ kind: "rel", offset: 0, lit: xlit(x) });
    return true;
  });
  scan(/\b(?:amanha+|amanh|amnha)\b/g, (x) => {
    seg.days.push({ kind: "rel", offset: 1, lit: xlit(x) });
    return true;
  });

  // horas
  const pushTime = (x: RegExpExecArray, h: number, minutes: number, period: string | undefined) => {
    const r = applyPeriod(h, minutes, period);
    seg.times.push({ min: r.min, lit: xlit(x), why: r.why });
  };
  scan(/\bmeio[- ]?dia(?:\s+e\s+meia)?\b/g, (x) => {
    seg.times.push({ min: 12 * 60 + (/meia/.test(x[0]) ? 30 : 0), lit: xlit(x) });
    return true;
  });
  scan(
    new RegExp(`\\b(${NUM})\\s*(?:horas?|hrs|hr|hs|h)(?:(\\d{2})(?!\\d)(?:\\s*min\\w*)?)?(?![a-z])(?:\\s+e\\s+(meia)\\b)?(?:\\s*(?:da|de|a)\\s+(${PERIOD}))?`, "g"),
    (x) => {
      const a = x.index!;
      const before = t.slice(0, a);
      const isLong = /hora/.test(x[0].slice(x[1].length));
      if (DURATION_PREFIX.test(before)) {
        seg.times.push({ min: null, lit: xlit(x), why: "duracao" });
        return true;
      }
      if (isLong && !x[4] && !HORAS_PREFIX.test(before) && !/em ponto/.test(t.slice(a + x[0].length, a + x[0].length + 10))) {
        seg.times.push({ min: null, lit: xlit(x), why: "duracao" });
        return true;
      }
      pushTime(x, num(x[1]), x[3] ? 30 : x[2] ? Number(x[2]) : 0, x[4]);
      return true;
    },
  );
  scan(new RegExp(`(?<![\\d:])(\\d{1,2}):(\\d{2})(?![\\d:])(?:\\s*(?:hs|hrs|hr|h)(?![a-z]))?(?:\\s*(?:da|de|a)\\s+(${PERIOD}))?`, "g"), (x) => {
    pushTime(x, Number(x[1]), Number(x[2]), x[3]);
    return true;
  });
  scan(
    new RegExp(`\\b(?:as|pelas|pras)\\s+(${NUM})(?:\\s+e\\s+(meia)\\b)?(?!\\s*(?:%|x\\b|:|/|h\\b|hs\\b|hrs?\\b|\\d)|\\s+(?:${QTY})\\b)(?:\\s*(?:da|de|a)\\s+(${PERIOD}))?`, "g"),
    (x) => {
      pushTime(x, num(x[1]), x[2] ? 30 : 0, x[3]);
      return true;
    },
  );
  scan(new RegExp(`\\b(${NUM})\\s*(?:da|de)\\s+(${PERIOD})\\b`, "g"), (x) => {
    pushTime(x, num(x[1]), 0, x[2]);
    return true;
  });

  // proposta (marcador no próprio trecho) vence qualquer ato do trecho; "ou" só conta com dia/hora
  const hasTokens = seg.days.length > 0 || seg.times.length > 0;
  const weakPropor = !hasTokens && (propor?.[0] === "pode ser" || propor?.[0] === "serve");
  if (propor && !weakPropor && (propor[0] !== "ou" || hasTokens)) {
    seg.acts = [{ act: "propos", lit: lit(propor.index, propor.index + propor[0].length) }];
    seg.weak = false;
  }
  return seg;
}

const SPLIT_RE = /[.!?;\n,]+|\b(?:mas|porem|so que|entretanto)\b/g;

function analyze(text: string): Analysis {
  const n = fold(text);
  const segs: Seg[] = [];
  const bounds: Array<{ from: number; to: number; q: boolean }> = [];
  let last = 0;
  for (const x of n.matchAll(SPLIT_RE)) {
    bounds.push({ from: last, to: x.index!, q: false });
    // o terminador marca pergunta no trecho que ele fecha
    if (x[0].includes("?")) bounds[bounds.length - 1].q = true;
    last = x.index! + x[0].length;
  }
  bounds.push({ from: last, to: n.length, q: false });
  for (const b of bounds) {
    if (!n.slice(b.from, b.to).trim()) continue;
    segs.push(analyzeSegment(text, n, b.from, b.to, b.q));
  }
  const globalBlock: string[] = [];
  const cm = RE_COND.exec(maskRe(maskRe(n, KEEP_AS_COMO), /\bse\s+(?:deus quiser)\b/g));
  if (cm) globalBlock.push("condicional");
  return { text, n, segs, globalBlock };
}

const isClean = (s: Seg) => s.blockers.length === 0 && !s.question;
const isQuestionOnly = (s: Seg) => s.blockers.length === 0 && s.question;

// ───────────────────────── pré-filtro ─────────────────────────

/**
 * Zero leitura de banco e independe de fuso/relógio. Passa com marca de tempo OU verbo de
 * compromisso em trecho limpo; cai com faixa de funcionamento, pergunta, negação, condicional ou
 * passado. É um filtro barato: quem passa ainda precisa de `parseConfirmation`.
 */
export function prefilterConfirmation(raw: string): PrefilterResult {
  const negatives: string[] = [];
  const text = typeof raw === "string" ? raw.normalize("NFC") : raw;
  if (typeof text !== "string" || !text.trim()) return { pass: false, signals: [], negatives: ["vazio"] };
  if (text.length > CONFIRM_MAX_CHARS) return { pass: false, signals: [], negatives: ["texto_longo"] };
  const a = analyze(text);
  for (const g of a.globalBlock) negatives.push(g);
  for (const s of a.segs) {
    for (const b of s.blockers) if (!negatives.includes(b)) negatives.push(b);
    if (s.question && !negatives.includes("pergunta")) negatives.push("pergunta");
  }
  const signals: string[] = [];
  for (const s of a.segs.filter(isClean)) {
    for (const act of s.acts) signals.push(`ato:${act.act}`);
    if (s.days.length) signals.push("dia");
    if (s.times.length) signals.push("hora");
  }
  const uniq = [...new Set(signals)];
  return { pass: a.globalBlock.length === 0 && uniq.length > 0, signals: uniq, negatives };
}

// ───────────────────────── resolução ─────────────────────────

type DateRes = { date: LocalDate | null; why?: string };

function resolveDay(tok: DayTok, today: LocalDate): DateRes {
  const [ty, tm, td] = ymdParts(today);
  const dow = weekdayOf(today);
  switch (tok.kind) {
    case "rel":
      return { date: addDays(today, tok.offset) };
    case "wd": {
      if (tok.mod === "weekNext") {
        const toMonday = ((1 - dow + 7) % 7) || 7;
        return { date: addDays(today, toMonday + ((tok.wd + 6) % 7)) };
      }
      const k = (tok.wd - dow + 7) % 7;
      if (tok.mod === "next") return { date: addDays(today, k || 7) };
      if (k === 0) return { date: null, why: "dia_semana_hoje" }; // "quinta" numa quinta: hoje ou semana que vem?
      return { date: addDays(today, k) };
    }
    case "dom": {
      if (tok.day >= td) return validYmd(ty, tm, tok.day) ? { date: fmtDate(ty, tm, tok.day) } : { date: null, why: "dia_invalido" };
      const nm = tm === 12 ? 1 : tm + 1;
      const ny = tm === 12 ? ty + 1 : ty;
      return validYmd(ny, nm, tok.day) ? { date: fmtDate(ny, nm, tok.day) } : { date: null, why: "dia_invalido" };
    }
    case "dmy": {
      if (tok.y !== undefined) {
        if (!validYmd(tok.y, tok.m, tok.d)) return { date: null, why: "data_invalida" };
        const d = fmtDate(tok.y, tok.m, tok.d);
        return d < today ? { date: null, why: "data_passada" } : { date: d };
      }
      if (!validYmd(ty, tok.m, tok.d)) return { date: null, why: "data_invalida" };
      const d = fmtDate(ty, tok.m, tok.d);
      if (d >= today) return { date: d };
      if (daysBetween(d, today) > 60 && validYmd(ty + 1, tok.m, tok.d)) return { date: fmtDate(ty + 1, tok.m, tok.d) }; // virada de ano
      return { date: null, why: "data_passada" };
    }
  }
}

function pickDate(tokens: DayTok[], today: LocalDate, weekNext: boolean, negatives: string[]): { date?: LocalDate; lits: string[] } {
  const lits = tokens.map((t) => t.lit);
  if (tokens.length === 0) {
    if (weekNext) negatives.push("semana_que_vem_sem_dia");
    return { lits };
  }
  const explicit: LocalDate[] = [];
  const weekdays: Array<{ wd: number; date: LocalDate | null }> = [];
  for (const tok of tokens) {
    const tk = tok.kind === "wd" && weekNext && tok.mod === "bare" ? { ...tok, mod: "weekNext" as const } : tok;
    const r = resolveDay(tk, today);
    if (r.why) negatives.push(r.why);
    if (tok.kind === "wd") weekdays.push({ wd: tok.wd, date: r.date });
    else if (r.date) explicit.push(r.date);
  }
  let dates: LocalDate[];
  if (explicit.length) {
    // o dia da semana citado precisa bater com alguma data explícita
    for (const w of weekdays) {
      if (!explicit.some((e) => weekdayOf(e) === w.wd)) {
        negatives.push("dia_semana_diverge");
        return { lits };
      }
    }
    dates = [...new Set(explicit)];
  } else {
    dates = [...new Set(weekdays.map((w) => w.date).filter((d): d is LocalDate => !!d))];
  }
  if (dates.length > 1) {
    negatives.push("varios_dias");
    return { lits };
  }
  return { date: dates[0], lits };
}

function pickTime(tokens: TimeTok[], negatives: string[]): { min?: number; lits: string[] } {
  const lits = tokens.map((t) => t.lit);
  if (tokens.length === 0) return { lits };
  for (const t of tokens) if (t.why) negatives.push(t.why);
  if (tokens.some((t) => t.min === null)) return { lits };
  const mins = [...new Set(tokens.map((t) => t.min as number))];
  if (mins.length > 1) {
    negatives.push("varios_horarios");
    return { lits };
  }
  return { min: mins[0], lits };
}

const foldName = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pickService<TId extends string>(n: string, services: Array<ConfirmServiceRef<TId>> | undefined, original: string): { id?: TId; lits: string[]; ambiguous: boolean } {
  if (!services || services.length === 0) return { lits: [], ambiguous: false };
  const flat = n.replace(/[^a-z0-9]/g, " ");
  const found: Array<{ id: TId; lit: string }> = [];
  for (const sv of services) {
    const name = foldName(sv.name);
    if (name.length < 3) continue;
    const x = new RegExp(`(?<![a-z0-9])${escapeRe(name)}s?(?![a-z0-9])`).exec(flat);
    if (x) found.push({ id: sv._id, lit: original.slice(x.index, x.index + x[0].length) });
  }
  const ids = [...new Set(found.map((f) => f.id))];
  if (ids.length === 1) return { id: ids[0], lits: found.map((f) => f.lit), ambiguous: false };
  return { lits: found.map((f) => f.lit), ambiguous: ids.length > 1 };
}

// ───────────────────────── parser ─────────────────────────

const NO_ACT: ConfirmAct[] = ["nenhum", "informativo"];

export function parseConfirmation<TId extends string = string>(raw: string, ctx: ParseConfirmationContext<TId>): ParsedConfirmation<TId> {
  assertTz(ctx.tz);
  const empty = (act: ConfirmAct, negatives: string[], blocked: string[] = [], signals: string[] = []): ParsedConfirmation<TId> => ({
    act,
    resolved: { act: false, date: false, time: false },
    level: "nenhum",
    fromProposal: { date: false, time: false },
    evidence: { act: [], date: [], time: [], service: [], blocked },
    signals,
    negatives,
  });
  if (typeof raw !== "string" || !raw.trim()) return empty("nenhum", ["vazio"]);
  const text = raw.normalize("NFC");
  if (text.length > CONFIRM_MAX_CHARS) return empty("nenhum", ["texto_longo"]);

  const a = analyze(text);
  const negatives: string[] = [...a.globalBlock];
  for (const s of a.segs) {
    for (const b of s.blockers) if (!negatives.includes(b)) negatives.push(b);
    if (s.question && !negatives.includes("pergunta")) negatives.push("pergunta");
  }
  const blockedLits = a.segs.flatMap((s) => s.blockedLits);
  if (a.globalBlock.length) return empty("nenhum", negatives, blockedLits);

  const clean = a.segs.filter(isClean);
  const qOnly = a.segs.filter(isQuestionOnly);
  const blocked = a.segs.filter((s) => s.blockers.length > 0);
  const cleanActs = clean.flatMap((s) => s.acts);
  const has = (act: ActHit["act"]) => cleanActs.filter((h) => h.act === act);
  const hasTokens = (s: Seg) => s.days.length > 0 || s.times.length > 0;

  let act: ConfirmAct = "nenhum";
  let actLits: string[] = [];
  let pool: Seg[] = clean;

  const todayClock = localClock(ctx.now, ctx.tz);
  const proposal = ctx.proposal;

  if (has("remarcou").length) {
    act = "remarcou";
    actLits = has("remarcou").map((h) => h.lit);
  } else if (has("cancelou").length) {
    act = "cancelou";
    actLits = has("cancelou").map((h) => h.lit);
  } else if (has("confirmou").length) {
    act = "confirmou";
    actLits = has("confirmou").map((h) => h.lit);
    // pergunta-etiqueta no fim ("fechado quinta 10h, pode ser?") ainda é proposta
    const lastSeg = a.segs[a.segs.length - 1];
    const cleanHasTokens = clean.some(hasTokens);
    const blockedHasTokens = blocked.some(hasTokens);
    if (clean.some((s) => hasTokens(s) && s.acts.some((h) => h.act === "propos"))) {
      // "Fechado! Mas só consigo quinta 10h": contraproposta, não confirmação
      act = "propos";
      actLits = has("propos").map((h) => h.lit);
      negatives.push("contraproposta");
    } else if (lastSeg.question && lastSeg.tagQuestion && lastSeg.blockers.length === 0) {
      act = "propos";
      negatives.push("pergunta_etiqueta");
    } else if (qOnly.some((s) => hasTokens(s)) && cleanHasTokens) {
      // outro dia/hora em pergunta junto da confirmação: conflito
      act = "nenhum";
      actLits = [];
      negatives.push("conflito_proposta");
    } else if (!cleanHasTokens && blockedHasTokens) {
      // o dia/hora citado caiu em trecho negado/passado/faixa: não confirma nada
      act = blocked.some((s) => s.blockers.includes("funcionamento")) && !blocked.some((s) => s.blockers.some((b) => b !== "funcionamento")) ? "informativo" : "nenhum";
      actLits = [];
    } else if (!cleanHasTokens && qOnly.some(hasTokens)) {
      act = "propos";
      pool = qOnly;
    }
  } else if (has("propos").length) {
    act = "propos";
    actLits = has("propos").map((h) => h.lit);
    pool = [...clean, ...qOnly];
    if (!pool.some(hasTokens)) {
      act = "nenhum";
      actLits = [];
    }
  } else if (proposal && clean.some((s) => s.weak) && a.n.trim().length <= 60) {
    // "ok", "beleza", "pode ser" respondendo a uma proposta aberta
    const tokensOk = clean.every((s) => {
      const d = pickDate(s.days, todayClock.date, false, []).date;
      const tm = pickTime(s.times, []).min;
      return (d === undefined || proposal.localDate === undefined || d === proposal.localDate) && (tm === undefined || proposal.timeMin === undefined || tm === proposal.timeMin);
    });
    if (tokensOk && (proposal.localDate !== undefined || proposal.timeMin !== undefined)) {
      act = "confirmou";
      actLits = clean.filter((s) => s.weak).map((s) => text.slice(s.start, s.end).trim());
      negatives.push("so_com_proposta");
    } else {
      negatives.push("diverge_da_proposta");
    }
  } else if (qOnly.some(hasTokens) && !blocked.some(hasTokens)) {
    act = "propos";
    pool = qOnly;
    actLits = [];
    negatives.push("pergunta_com_horario");
  } else if (blocked.some((s) => s.blockers.includes("funcionamento")) && !blocked.some((s) => s.blockers.some((b) => b !== "funcionamento"))) {
    act = "informativo";
  }

  if (act === "nenhum" || act === "informativo") return empty(act, negatives, blockedLits, []);

  // ── dia e hora
  const days = pool.flatMap((s) => s.days);
  const times = pool.flatMap((s) => s.times);
  const weekNext = pool.some((s) => s.weekNext);
  const d = pickDate(days, todayClock.date, weekNext, negatives);
  const tm = pickTime(times, negatives);
  let localDate = d.date;
  let timeMin = tm.min;
  // horário no passado do mesmo dia não resolve
  if (localDate !== undefined && localDate < todayClock.date) {
    negatives.push("data_passada");
    localDate = undefined;
  }
  if (localDate === todayClock.date && timeMin !== undefined && timeMin <= todayClock.minutes) {
    negatives.push("horario_passado");
    timeMin = undefined;
  }

  const fromProposal = { date: false, time: false };
  if (act === "confirmou" && proposal) {
    if (localDate === undefined && d.lits.length === 0 && proposal.localDate !== undefined) {
      localDate = proposal.localDate;
      fromProposal.date = true;
    }
    if (timeMin === undefined && tm.lits.length === 0 && proposal.timeMin !== undefined) {
      timeMin = proposal.timeMin;
      fromProposal.time = true;
    }
    if (localDate !== undefined && localDate < todayClock.date) {
      negatives.push("proposta_no_passado");
      localDate = undefined;
      fromProposal.date = false;
    }
    if (localDate === todayClock.date && timeMin !== undefined && timeMin <= todayClock.minutes) {
      negatives.push("horario_passado");
      timeMin = undefined;
      fromProposal.time = false;
    }
  }

  const svc = pickService<TId>(a.n, ctx.services, text);
  if (svc.ambiguous) negatives.push("servico_ambiguo");

  const resolved = { act: true, date: localDate !== undefined, time: timeMin !== undefined };
  const signals = [`ato:${act}`];
  if (resolved.date) signals.push("dia");
  if (resolved.time) signals.push("hora");
  if (svc.id) signals.push("servico");
  return {
    act,
    localDate,
    timeMin,
    serviceId: svc.id,
    resolved,
    level: resolved.date && resolved.time ? "completo" : "parcial",
    fromProposal,
    evidence: { act: actLits, date: d.lits, time: tm.lits, service: svc.lits, blocked: blockedLits },
    signals,
    negatives: [...new Set(negatives)],
  };
}
