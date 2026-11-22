/**
 * Agenda v2 (PR C0) — parser determinístico de confirmação de horário em PT-BR (puro).
 *
 * Quando o dono do negócio responde ao cliente pelo WhatsApp ("Ok, confirmado quinta 10h"),
 * este módulo decide se a mensagem PARECE uma confirmação de horário e extrai ato, dia e hora.
 * É o pré-filtro barato (custo zero quando negativo) e a segunda opinião de um classificador LLM
 * (outro PR). Nunca grava nada e não lê banco.
 *
 * Duas camadas, de propósito:
 *  1. EXTRAÇÃO ("parcial"): acha ato, dia e hora por trecho e descarta trechos com negação,
 *     pergunta, passado, promessa, relato, assunto comercial etc. Alimenta o humano (proposta de
 *     1 toque) e o classificador LLM com evidência literal.
 *  2. LISTA DE PERMISSÃO ("completo"): `level: "completo"` só sai quando a mensagem INTEIRA cabe numa
 *     forma fechada: [saudação curta] + [marcador forte de confirmação] + [dia] + [hora] + [fecho curto
 *     de uma lista fechada]. Qualquer palavra fora do vocabulário reconhecido rebaixa para "parcial".
 *     Quem for marcar sozinho só pode confiar em "completo"; "parcial" vira proposta para o humano.
 *
 * Falso positivo é o pior erro: na dúvida o resultado é "nenhum", "informativo", "propos" ou parcial.
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
  /**
   * Proposta aberta na conversa. Só completa dia/hora de uma RESPOSTA CURTA ("ok", "combinado", "👍")
   * quando `by === "cliente"` e `at` tem menos de 48 h. O parser nunca decide sozinho: quem chama ainda
   * confere `matchesProposal` (terceira condição do plano §8.1).
   */
  proposal?: ConfirmProposal;
};

export type ConfirmProposal = {
  localDate?: LocalDate;
  timeMin?: number;
  /** Quem fez a proposta: mensagem do cliente, oferta da IA ou mensagem anterior do humano. */
  by: "cliente" | "ia" | "humano";
  /** Instante (ms) da proposta. */
  at: number;
};

/** Validade de uma proposta aberta. */
export const PROPOSAL_TTL_MS = 48 * 60 * 60 * 1000;

export type ConfirmEvidence = {
  /** Trechos literais (substrings de `normalizeConfirmationText(text)`) que sustentam cada campo. */
  act: string[];
  date: string[];
  time: string[];
  service: string[];
  /** Trechos que derrubaram a leitura (negação, pergunta, passado, relato…). */
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
  /**
   * "completo" = confirmação em forma fechada (mensagem inteira na lista de permissão) com dia e hora;
   * "parcial" = há ato, mas fora da forma fechada ou sem dia/hora; "nenhum" = sem ato.
   * Só "completo" autoriza marcar sozinho.
   */
  level: "completo" | "parcial" | "nenhum";
  /** Dia/hora vieram da `proposal` da conversa, não da mensagem. */
  fromProposal: { date: boolean; time: boolean };
  /** Dia/hora tirados DA PRÓPRIA mensagem (sem preenchimento pela proposta). */
  fromMessage: { localDate?: LocalDate; timeMin?: number };
  /**
   * "explicito": dia e hora escritos na própria mensagem. "resposta_curta": algum deles veio da proposta
   * ("ok", "fechado", "👍"). Só existe quando há ato acionável.
   */
  form?: "explicito" | "resposta_curta";
  evidence: ConfirmEvidence;
  signals: string[];
  negatives: string[];
};

export type PrefilterResult = { pass: boolean; signals: string[]; negatives: string[] };

/** Acima disso a mensagem não é uma resposta curta de confirmação (e o custo fica limitado). */
export const CONFIRM_MAX_CHARS = 600;

/**
 * Forma de texto sobre a qual `evidence` é calculada (NFC). Quem validar a evidência deve comparar
 * `normalizeConfirmationText(texto).includes(trecho)`.
 */
export function normalizeConfirmationText(text: string): string {
  return text.normalize("NFC");
}

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
 * "ª"/"º" ficam (servem para "5ª feira").
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
const g = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");

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
const EMOJI = "[\\ud83c-\\ud83e][\\udc00-\\udfff]|[\\u2600-\\u27bf]|\\ufe0f|\\u200d";

const num = (gr: string): number => (/^\d/.test(gr) ? Number(gr) : (NUM_WORDS[gr] ?? NaN));

// Atos
const RE_REMARCAR =
  /\b(?:remarc\w*|remarqu\w*|reagend\w*|adi(?:ar|amos|ei|ou|ado|ada)|antecip\w+|(?:mudar|mudamos|mudei|trocar|trocamos|trocei)\s+(?:o\s+|a\s+|do\s+|da\s+)?(?:horario|dia|data|para|pra)|(?:passar|passamos|passei|transferir|transferimos|transferi)\s+(?:o\s+\w+\s+|a\s+\w+\s+)?(?:pra|para))\b/;
// Só formas verbais ("cancelamentos" é substantivo de política, não ato).
const RE_CANCELAR = /\b(?:cancel(?:ar|ei|amos|ou|ad[oa]s?|e)|desmarc(?:ar|amos|ou|ad[oa]s?)|desmarqu(?:ei|emos|e)|desagend(?:ar|ei|amos|ou|ad[oa]s?))\b/;
// Marcadores FORTES de confirmação dirigidos ao cliente (particípio ou 1ª pessoa do passado).
// "confirmo/te confirmo" NÃO entram: no presente é promessa ("te confirmo amanhã").
const RE_CONFIRMAR = new RegExp(
  [
    "(?:confirmad|combinad|marcad|agendad|fechad|reservad|garantid|anotad)(?:o|a|issim[oa]|inh[oa])+s?",
    "confirm(?:ei|amos)",
    "fechou",
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
  "g",
);
// Respostas curtas que só valem com uma proposta aberta na conversa (mensagem inteira, lista fechada).
const WEAK_WORDS =
  "ok|okay|okk+|blz|beleza|certo|perfeito|show|isso|sim|positivo|tranquilo|combina|bora|pode ser|serve|ta bom|ta otimo|ta ok|fica bom|otimo|claro|por favor";
const RE_WEAK_EMOJI = /\ud83d\udc4d|\ud83d\udc4c|\u2705|\ud83e\udd1d|\ud83d\ude4f/g;
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
    "confirm(?:a|e|em)",
    "ou",
  ]
    .map((p) => `\\b${p}\\b`)
    .join("|"),
);
// Último trecho que só pergunta "tá bom?" mesmo sem "?".
const TAG_ONLY = /^\s*(?:(?:e\s+)?(?:ne(?:\s+nao)?|certo|ta|ta bom|ta certo|tudo bem|beleza|blz|pode ser|ok|combinado|fechado|ne nao|nao)\s*)+$/;

// Bloqueadores por trecho
const SAFE_NEG =
  /\b(?:sem (?:problemas?|falta|duvida|compromisso|atraso)|nao (?:tem problema|ha problema|se preocupe|esqueca|esquece|falte|atrase|se atrase|tem pressa|precisa (?:trazer|levar|pagar|nada|se preocupar|chegar|avisar|ligar|jejum|de jejum)))\b/g;
const RE_NEG = /\b(?:nao|nem|nunca|jamais|sem|nada|impossivel|infelizmente|indisponivel|lotad[oa]|ocupad[oa]|cheio|cheia|esgotad[oa]|desisti\w*|recus\w+|naum|nn|n)\b/;
const RE_PAST =
  /\b(?:ontem|anteontem|antes de ontem|semana passada|mes passado|ano passado|passad[oa]s?|ultim[oa]s?|foi(?!\s+(?:marcad|agendad|confirmad|combinad|fechad|reservad|anotad|remarcad|reagendad|cancelad|desmarcad))|fui|fomos|foram|estive|esteve|estiveram|veio|vieram|vim|viemos|faltou|faltaram|faltei|compareceu|compareci|compareceram|aconteceu|atrasou|atrasei|tinha|tinhamos|tinham|estava|estavam|estavamos|havia|era|eram|ja passou|apareceu|chegou|ligou|mandou|enviou|pagou|esqueceu|esqueci|ficou(?!\s+(?:marcad|combinad|agendad|confirmad|fechad|reservad|anotad))|deveria|devia|queria)\b/;
const RE_INTENT =
  /\b(?:vou|vamos|vai|iremos|irei|preciso|precisamos|posso|podemos|consigo|conseguimos|tenho que|temos que|deixa eu|deixe eu|tentar|tento|tentamos)\s+(?:\w+\s+){0,2}(?:confirmar|marcar|agendar|ver|verificar|checar|olhar|consultar|fechar|encaixar|avisar|responder|saber)\b/;
const RE_FUNC =
  /\b(?:funcionamos|funcionamento|funciona(?:mos)?|expediente|abrimos|abre|reabr\w+|abertos?|abertas?|fecha(?:mos)?\s+(?:as|ate|de|aos|nos)|horario (?:de|do) (?:atendimento|funcionamento|trabalho|expediente)|atendimento (?:de|das|da|ate|nos|aos|em)|aos (?:sabados|domingos|feriados)|feriados?|plantao|fim de semana|final de semana|fds|dias? uteis?|dia util|sexta[- ]?feira santa)\b|(?<!te )atend(?:o|emos)\b(?!\s+(?:voce|vc|ele|ela))/;
const RE_PLURAL_DAY = /\b(?:domingos|segundas|tercas|quartas|quintas|sextas|sabados)\b/;
const RE_EVERY = new RegExp(`\\b(?:tod[oa]s?|cada)\\s+(?:(?:a|o|as|os)\\s+)?(?:dias?|semanas?|${FULL_DAY_ALT})`);
const RE_DAY_RANGE = new RegExp(`\\b(?:${DAY_ALT})(?:[- ]?feira)?\\s*(?:a|ate|e|\\/|-)\\s*(?:${DAY_ALT})\\b`);
const RE_LIMIT_NUM = /\b(?:ate|antes|depois|apos|a partir)\s+(?:d[eoa]s?\s+|o\s+|a\s+)?(?:as\s+)?(?:dia\s+)?(?:\d{1,2}(?:[:h]\d{0,2})?(?:hs|hrs|hr|h)?|meio[- ]?dia)/;
const RE_LIMIT_DAY = /\b(?:antes|depois|apos|a partir)\s+(?:d[eoa]s?\s+|o\s+|a\s+)?(?:as\s+)?(?:dia\s+)?(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje)/;
const RE_UNTIL_DAY = /\bate\s+(?:o\s+|a\s+)?(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje)/; // despedida só no início do trecho
// Assunto de outra natureza: financeiro, comercial, política, entrega, estabelecimento, terceiros ausentes.
const OTHER_WORDS = [
  "recebimento|comprovante|pagamento|pix|boleto|pedido|cadastro|e-?mail|cpf|cnpj|entrega|envio|nota fiscal|fatura|orcamento|transferencia|deposito|compra|cartao",
  "promocao|promocoes|promo|desconto|descontos|oferta|ofertas|live|black friday|cupom|brinde|sorteio|lancamento|encomenda|retirar|retirada|buscar|motoboy|frete|sinal|pre[- ]?(?:agend|reserv|marc|cadastr)\\w*",
  "antecedencia|politica|multa|taxa|regulamento|so com|somente com|apenas com",
  "manutencao|balanco|reforma|ferias|inventario|obra|treinamento|folga|recesso|viajou|viajando|doente|evento|aniversario",
].join("|");
const RE_OTHER = new RegExp(`(?<![a-z0-9])(?:${OTHER_WORDS})(?![a-z0-9])`);
// Valor/preço/parcelas no mesmo trecho: ruído que tira da forma fechada, mas não derruba a confirmação.
const RE_PRICE = /(?<![a-z0-9])(?:valor|preco|custa|reais|real|parcel\w*|juros|total)(?![a-z0-9])|%|r\$/;
const RE_BUSY = new RegExp(
  "\\b(?:ja\\s+(?:esta|ta|foi|estava)\\s+(?:reservad|agendad|marcad|ocupad)\\w*|outr[oa]s?\\s+(?:cliente|pessoa|paciente)|por\\s+outr[oa]|com\\s+outr[oa]|tenho(?!\\s+(?:vaga|horario|encaixe|disponibilidade))|ja\\s+tenho|tem\\s+(?:cliente|paciente|alguem))\\b",
);
const RE_QSTART =
  /^\s*(?:e\s+)?(?:qual|quais|quando|quanto|quantos|que horas|a que horas|onde|quem|por que|porque|como|sera que|seria possivel|tem como|da pra|da para|consegue|poderia|podia|pode me|voce consegue|vc consegue|tem horario|tem vaga|ainda tem|ta livre|esta livre)\b/;
const RE_COND =
  /\b(?:se|caso|talvez|quem sabe|vou ver|ver se|depende|provavelmente|acho que|acredito|vamos ver|vou tentar|preciso ver|ter que ver|a confirmar|salvo|so se|quando|assim que|desde que)\b/;
// Bloqueios da mensagem inteira
const RE_PROMISE = /\b(?:confirmo|confirmamos|confirmar|confirmaremos|te confirmo)\b/;
const RE_REPORT = /\b(?:disse|disseram|escreveu|escreveram|mandou|falou|avisou|perguntou|pediu|informou|contou|comentou|respondeu|prometeu|garantiu)\b/;
const RE_QUOTE = /["\u201c\u201d\u00ab\u00bb]|(?:^|[\s(])'[^']{4,}'/;
const RE_FORWARD = /\b(?:encaminhad[oa]s?|encaminhei|fwd|fw|reenviand\w+|reenviad\w+|reencaminh\w+|em resposta a|respondendo a)\b/;
const RE_QUOTE_LINE = /(?:^|\n)\s*>/;
// "Maria: …", "[10:32, 21/11/2026] Cliente: …": transcrição de conversa, não resposta do dono
const SPEAKER_LABEL = /^\s*(?:\[[^\]]{0,40}\]\s*)?(?!(?:Confirmado|Confirmada|Fechado|Combinado|Agendado|Marcado|Importante|Obs|Atenção|Aten[cç]ão|Lembrete|Aviso|Agenda|Horário|Hor[aá]rio|Ok)\s*:)\p{Lu}[\p{L}.]{1,20}(?:\s\p{Lu}[\p{L}.]{1,20})?:\s/u;
const RE_BRACKET_TIMESTAMP = /^\s*\[\d/;
const RE_IRONY = /\b(?:so que nao|sqn|brincadeira|zoeira|mentira)\b/;
const KEEP_AS_COMO = /\b(?:como|conforme)\s+(?:combinado|falamos|conversamos|combinamos|marcado|agendado)\b/g;

// possessivo antes de um marcador só vale se o substantivo for do próprio atendimento
const OWN_NOUNS = new Set([
  "consulta", "horario", "agendamento", "sessao", "atendimento", "procedimento", "reserva", "visita", "avaliacao", "aula", "vaga", "mesa", "retorno", "exame", "corte", "massagem", "limpeza", "vez", "hora", "agenda", "marcacao", "cirurgia", "revisao", "vistoria", "orcamento", "reuniao_com_voce",
]);
const FIRST_PERSON = /^(?:confirm(?:ei|amos)|marqu(?:ei|emos)|marcamos|agend(?:ei|amos)|anotei|reservei)$/;
const CLIENT_DIRECTED = new RegExp(`^\\s*(?:(?:seu|sua|voce|vc|te)\\b|(?:pra|para)\\s+(?:voce|vc)\\b|(?:pra|para|no|na|em|dia|as|pelas|hoje|amanha|hj|depois|\\d|${FULL_DAY_ALT}|${Object.keys(WEEKDAY_ABBR).join("|")})\\b)`);
const THIRD_PARTY_NAME = /(?:^|\s)(?:[Aa]|[Oo]|[Aa][Oo]|À|à|[Dd][Aa]|[Dd][Oo])\s+(?:Dr\.?a?\s+)?\p{Lu}\p{L}+/u;
const OBJECT_AFTER_VIR = /^\s*(?:\w+\s+){0,2}(?:buscar|retirar|pegar|entregar|deixar|pagar|assinar|trazer|levar)\b/;
const ESTABLISHMENT = /\b(?:loja|clinica|salao|consultorio|escritorio|agenda|unidade|estabelecimento|casa|estaremos|ficaremos|ficamos|estamos|fica|vamos ficar)\b/;
const FOLLOW_OK = new Set([
  "as", "a", "de", "que", "q", "pra", "para", "ao", "aos", "dia", "cedo", "manha", "tarde", "noite", "ou", "e", "depois", "antes", "no", "na", "em", "por", "com", "hoje", "amanha", "feira", "proxima", "prox", "passada", "sim", "ok", "ne", "tb", "tambem", "mesmo", "mesma", "logo", "sem", "pode", "vem", "fica", "ate", "so", "hein", "entao", "mas", "ta", "pelas", "pras", "meio", "meia", "te", "eu", "voce", "vc",
]);
const DETERMINER = /\b(?:a|o|na|no|da|do|sua|seu|essa|esse|esta|este|minha|meu|uma|um|nesta|nessa)\s+$/;
const ORDINAL_AFTER = /^\s*(?:via|vez|parcela|opcao|chance|mao|fase|etapa|sessao|consulta|visita|ligacao|tentativa|vaga|parte|linha|coluna|pessoa|prova|chamada|lista|turma|aula|dose|aplicacao|rodada|camada|fila)\b/;

// ───────────────────────── análise por trecho ─────────────────────────

type DayTok = { at: number } & (
  | { kind: "rel"; offset: number; lit: string }
  | { kind: "wd"; wd: number; mod: "bare" | "next" | "weekNext"; lit: string }
  | { kind: "dom"; day: number; lit: string }
  | { kind: "dmy"; d: number; m: number; y?: number; lit: string }
);
type TimeTok = { at: number; min: number | null; lit: string; why?: string };
type ActHit = { act: "remarcou" | "cancelou" | "confirmou" | "propos"; lit: string };
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type Span = [number, number]; // absoluto, sobre o texto normalizado

type Seg = {
  start: number;
  end: number;
  question: boolean;
  blockers: string[]; // sem "pergunta"
  acts: ActHit[];
  days: DayTok[];
  times: TimeTok[];
  blockedLits: string[];
  tagQuestion: boolean;
  hasRange: boolean;
  /** Citou limite ("até as 10h", "depois das 14"): conta como dia/hora para rebaixar, nunca é forma fechada. */
  limited: boolean;
  hasLimit: boolean;
  /** Posição (absoluta) de "para/pra" depois de "remarcar": o que vem depois é o novo horário. */
  newFrom?: number;
  /** Valor/preço no trecho: nunca forma fechada. */
  noisy: boolean;
  /** Trechos consumidos por marcador forte, dia e hora (para a lista de permissão). */
  spans: Span[];
  markerCount: number;
};

type Analysis = { text: string; n: string; segs: Seg[]; globalBlock: string[]; globalLits: string[] };

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
  } else if (h >= 0 && h <= 7) {
    // "3h", "7h" sem período: 03:00 ou 15:00, 07:00 ou 19:00.
    return { min: null, why: "hora_ambigua" };
  }
  return { min: hh * 60 + minutes };
}

const DURATION_PREFIX = /(?:^|\s)(?:por|durante|dura|duram|duracao|daqui|daqui a|em|faltam|falta|cerca de|aproximadamente|mais de|a cada|(?:consulta|sessao|atendimento|aula|reuniao|duracao|tempo) de)\s*$/;
const HORAS_PREFIX = /(?:\bas|pelas|pras)\s*$/;
// Depois de "às/pras/pelas N" só vale fim, pontuação, emoji, h, "e meia", "da/de <período>", "em ponto".
const AS_TAIL = `(?=\\s*(?:$|[.,;:!?)\\u2014\\-]|${EMOJI}|e\\s+meia\\b|(?:da|de)\\s+(?:${PERIOD})\\b|em\\s+ponto\\b|hs?\\b|hrs?\\b|(?:ta\\s+|esta\\s+)?(?:confirmad|combinad|marcad|fechad|agendad)\\w*|pode\\s+vir\\b|te\\s+espero\\b|sem\\s+atraso\\b))`;

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
    days: [],
    times: [],
    blockedLits: [],
    tagQuestion: false,
    hasRange: false,
    limited: false,
    hasLimit: false,
    noisy: false,
    spans: [],
    markerCount: 0,
  };
  const block = (kind: string, m: RegExpExecArray | null) => {
    if (!seg.blockers.includes(kind)) seg.blockers.push(kind);
    if (m) seg.blockedLits.push(lit(m.index, m.index + m[0].length));
  };
  const span = (a: number, b: number) => seg.spans.push([start + a, start + b]);

  // ── bloqueadores
  const tn = maskRe(maskRe(t2, SAFE_NEG), KEEP_AS_COMO);
  let m: RegExpExecArray | null;
  // "remarcado de ontem 10h pra amanhã": o dia antigo (passado) antes de "para/pra" não derruba o trecho
  const remarcarAt = RE_REMARCAR.exec(t2);
  const paraAt = remarcarAt ? /\b(?:para|pra|pro)\b/.exec(t2.slice(remarcarAt.index + remarcarAt[0].length)) : null;
  const newFrom = remarcarAt && paraAt ? remarcarAt.index + remarcarAt[0].length + paraAt.index : 0;
  if (paraAt) seg.newFrom = start + newFrom;
  if ((m = RE_NEG.exec(tn))) block("negacao", m);
  if ((m = RE_PAST.exec(newFrom ? t2.slice(newFrom) : t2))) block("passado", m);
  if ((m = RE_INTENT.exec(t2))) block("intencao", m);
  let limitHit: RegExpExecArray | null = null;
  const limitRes = [RE_LIMIT_NUM, RE_LIMIT_DAY];
  if (!/^\s*ate\b/.test(t2)) limitRes.push(RE_UNTIL_DAY); // "até quinta" no início do trecho é despedida
  for (const re of limitRes) if (!limitHit) limitHit = re.exec(t2);
  if ((m = RE_OTHER.exec(t2))) block("outro_assunto", m);
  if ((m = RE_BUSY.exec(t2))) block("ocupado", m);
  if (RE_PRICE.test(t2)) seg.noisy = true;
  for (const re of [RE_FUNC, RE_DAY_RANGE, RE_EVERY]) {
    if ((m = re.exec(t2))) block("funcionamento", m);
  }
  // plural de dia ("sábados") só com minúscula: "Domingos" capitalizado é nome próprio
  for (const x of t2.matchAll(g(RE_PLURAL_DAY))) {
    const ch = orig[start + x.index!];
    if (ch === ch.toLowerCase()) block("funcionamento", x);
  }
  const isQuestion = question || RE_QSTART.test(maskRe(t2, KEEP_AS_COMO));
  seg.question = isQuestion;
  seg.tagQuestion = question;

  // ── atos
  const hit = (act: ActHit["act"], re: RegExp) => {
    const x = re.exec(t2);
    if (x) seg.acts.push({ act, lit: lit(x.index, x.index + x[0].length) });
  };
  const propor = RE_PROPOR.exec(maskRe(t2, KEEP_AS_COMO));
  hit("remarcou", RE_REMARCAR);
  hit("cancelou", RE_CANCELAR);
  for (const x of t2.matchAll(RE_CONFIRMAR)) {
    const a = x.index!;
    const b = a + x[0].length;
    const before = t2.slice(0, a);
    // possessivo + substantivo de terceiro antes do marcador ("o horário da sua mãe está confirmado")
    const poss = [...before.matchAll(/\b(?:seu|sua|seus|suas|meu|minha|meus|minhas|dele|dela|deles|delas)\s+([a-z]+)/g)];
    if (poss.some((p) => !OWN_NOUNS.has(p[1]))) continue;
    if (/^pode (?:vir|passar)/.test(x[0]) && OBJECT_AFTER_VIR.test(t2.slice(b))) continue;
    // "marquei/agendei/anotei…" só valem dirigidos ao cliente ou colados a dia/hora ("marquei a reunião com…" é de equipe)
    if (FIRST_PERSON.test(x[0]) && !CLIENT_DIRECTED.test(t2.slice(b))) continue;
    // "A Maria já está confirmada…": terceiro nomeado antes do particípio
    if (/^[a-z]+(?:o|a|issim[oa]|inh[oa])s?$/.test(x[0]) && THIRD_PARTY_NAME.test(orig.slice(start, start + a))) continue;
    if (/^fechad|^fechou/.test(x[0]) && ESTABLISHMENT.test(t2)) continue;
    seg.acts.push({ act: "confirmou", lit: lit(a, b) });
    seg.markerCount++;
    span(a, b);
  }

  // ── tokens (máscara progressiva sobre `s`)
  let s = t;
  const scan = (re: RegExp, fn: (x: RegExpExecArray) => boolean) => {
    const hits: Array<[number, number]> = [];
    for (const x of s.matchAll(re)) if (fn(x)) hits.push([x.index!, x.index! + x[0].length]);
    for (const [a, b] of hits) s = s.slice(0, a) + " ".repeat(b - a) + s.slice(b);
  };
  const xlit = (x: RegExpExecArray) => lit(x.index!, x.index! + x[0].length);
  const xspan = (x: RegExpExecArray) => span(x.index!, x.index! + x[0].length);
  const pushDay = (x: RegExpExecArray, tok: DistributiveOmit<DayTok, "at">) => {
    seg.days.push({ ...tok, at: start + x.index! } as DayTok);
    xspan(x);
  };

  // "até as 10h", "depois das 14": limite, não é horário; some do texto e rebaixa a forma fechada
  for (const re of [RE_LIMIT_NUM, RE_LIMIT_DAY]) s = maskRe(s, g(re));
  if (!/^\s*ate\b/.test(t2)) s = maskRe(s, g(RE_UNTIL_DAY));
  s = maskRe(s, g(RE_PLURAL_DAY));
  s = maskRe(s, g(RE_EVERY));
  s = maskRe(s, g(RE_DAY_RANGE));
  s = maskRe(s, /\bsexta[- ]?feira santa\b/g);
  // "depois de amanhã" vira token a partir de t
  s = maskRe(s, /\b(?:depois|dps|depos)\s+d[eo]\s+amanha+\b|\bdepois\s+d\s+amanha\b/g);
  for (const x of t.matchAll(/\b(?:depois|dps|depos)\s+d[eo]\s+amanha+\b|\bdepois\s+d\s+amanha\b/g)) {
    pushDay(x, { kind: "rel", offset: 2, lit: xlit(x) });
  }

  // faixa de horário: resolve o início e marca (nunca forma fechada)
  const rangeStart = (x: RegExpExecArray, h: number, mi: number) => {
    const r = applyPeriod(h, mi, undefined);
    seg.times.push({ at: start + x.index!, min: r.min, lit: xlit(x), why: r.why });
    seg.hasRange = true;
    return true;
  };
  scan(/\b(?:das?|de|entre)\s+(\d{1,2})(?::(\d{2})|\s*(?:h|hs|hr|hrs)\s*(\d{2})?|\s*horas?)?\s*(?:as|a|ate|e)\s+\d{1,2}(?::\d{2}|\s*(?:h|hs|hr|hrs|horas?)\b)?(?:\s*\d{2})?\b/g, (x) =>
    rangeStart(x, Number(x[1]), Number(x[2] ?? x[3] ?? 0)),
  );
  scan(/\b(\d{1,2})(?::(\d{2})|\s*h(?:s|r|rs)?\s*(\d{0,2}))\s*(?:-|ate|as|a)\s*\d{1,2}(?::\d{2}|\s*h)(?:s|r|rs)?\s*\d{0,2}/g, (x) =>
    rangeStart(x, Number(x[1]), Number(x[2] ?? (x[3] || 0))),
  );

  // dd/mm[/aa[aa]]
  scan(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?!\d)/g, (x) => {
    const d = Number(x[1]);
    const mo = Number(x[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return false;
    const y = x[3] ? (x[3].length === 2 ? 2000 + Number(x[3]) : Number(x[3])) : undefined;
    pushDay(x, { kind: "dmy", d, m: mo, y, lit: xlit(x) });
    return true;
  });
  // dd-mm (26-11): só dois dígitos de cada lado e sem cara de quantidade ("2-3 pessoas")
  scan(new RegExp(`(?<![\\d-])(\\d{1,2})-(\\d{1,2})(?![\\d-])(?!\\s*(?:${QTY})\\b)`, "g"), (x) => {
    const d = Number(x[1]);
    const mo = Number(x[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return false;
    pushDay(x, { kind: "dmy", d, m: mo, lit: xlit(x) });
    return true;
  });
  // dd.mm (26.11); "10.30" com minuto > 12 é hora, não data
  scan(/(?<![\d.$])(\d{1,2})\.(\d{1,2})(?![\d.])/g, (x) => {
    const d = Number(x[1]);
    const mo = Number(x[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return false;
    if (/[$]\s*$/.test(t.slice(Math.max(0, x.index! - 4), x.index!))) return false;
    pushDay(x, { kind: "dmy", d, m: mo, lit: xlit(x) });
    return true;
  });
  // "27 de novembro", "27 nov" (com "de"); rua/avenida com data no nome não é data
  scan(
    new RegExp(`(?:\\bdia\\s+)?\\b(\\d{1,2})[\u00ba\u00b0]?\\s*(?:de\\s+)?(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\\b|(?:\\bdia\\s+)?\\b(\\d{1,2})\\s+(?:de\\s+)?(?:(jan|fev|abr|mai|jun|jul|ago|out|nov|dez)|(?<=de\\s)(mar|set))\\b`, "g"),
    (x) => {
      const d = Number(x[1] ?? x[3]);
      const mo = MONTHS[x[2] ?? x[4] ?? x[5]];
      if (!mo || d < 1 || d > 31) return false;
      const before = t.slice(0, x.index!);
      if (!/^dia\b/.test(x[0]) && /\b(?:da|na|rua|r|av|avenida|travessa|tv|alameda|al|praca|pca|rodovia|estrada|largo)\.?\s*$/.test(before)) return true; // endereço: consome sem virar data
      pushDay(x, { kind: "dmy", d, m: mo, lit: xlit(x) });
      return true;
    },
  );
  // "dia 27"
  scan(/\bdia\s+(\d{1,2})[\u00ba\u00b0]?(?![\d:/])(?!\s*(?:h|hs)\b)/g, (x) => {
    const d = Number(x[1]);
    if (d < 1 || d > 31) return false;
    pushDay(x, { kind: "dom", day: d, lit: xlit(x) });
    return true;
  });

  // semana que vem solta: sem dia da semana colado não resolve nada
  // O modificador só vale COLADO ao dia; o trecho do modificador entra nos spans (forma fechada).
  const wdMod = (a: number, b: number): "bare" | "next" | "weekNext" => {
    const before = t.slice(0, a);
    const after = t.slice(b);
    let mm: RegExpExecArray | null;
    if ((mm = /^\s*(?:da\s+|na\s+)?(?:semana\s+(?:que|q)\s+vem|proxima\s+semana|semana\s+proxima)/.exec(after))) {
      span(b, b + mm[0].length);
      return "weekNext";
    }
    if ((mm = /(?:semana\s+(?:que|q)\s+vem|proxima\s+semana)\s+(?:n[ao]\s+)?$/.exec(before))) {
      span(a - mm[0].length, a);
      return "weekNext";
    }
    if ((mm = /^\s*(?:que vem|q vem|qvem|proxima|prox|que vai vir)\b/.exec(after))) {
      span(b, b + mm[0].length);
      return "next";
    }
    if ((mm = /\b(?:proxim[oa]|prox)\.?\s+(?:n[ao]\s+)?$/.exec(before))) {
      span(a - mm[0].length, a);
      return "next";
    }
    return "bare";
  };

  // dia da semana por extenso
  scan(new RegExp(`\\b(${FULL_DAY_ALT})(?:[- ]?feira)?\\b`, "g"), (x) => {
    const a = x.index!;
    const b = a + x[0].length;
    const after = t.slice(b);
    if (ORDINAL_AFTER.test(after)) return true; // "segunda dose", "sexta sessão": ordinal
    if (/^\s+santa\b/.test(after)) return true;
    const nextWord = /^\s+([a-z]+)/.exec(after)?.[1];
    if (DETERMINER.test(t.slice(0, a)) && nextWord && !FOLLOW_OK.has(nextWord) && !MONTHS[nextWord]) return true; // "a segunda dose", "sua sexta sessão"
    pushDay(x, { kind: "wd", wd: WEEKDAYS[x[1]], mod: wdMod(a, b), lit: xlit(x) });
    return true;
  });
  // "5ª feira", "5a feira", "5ªf", "5-feira" — "Nª"/"Nº" sozinhos são ordinal ("2ª sessão", "4º andar")
  scan(/\b([2-6])\s*(?:ª|a)\s*-?\s*(?:feira|f)\b|\b([2-6])\s*-?\s*feira\b/g, (x) => {
    const k = Number(x[1] ?? x[2]);
    pushDay(x, { kind: "wd", wd: k - 1, mod: wdMod(x.index!, x.index! + x[0].length), lit: xlit(x) });
    return true;
  });
  // "4ª 8h30": ordinal feminino colado a uma hora é dia da semana; "2ª sessão", "4º andar" continuam ordinais
  scan(new RegExp(`\\b([2-6])\\s*\\u00aa(?=\\s*(?:as\\s+|a\\s+)?(?:(?:${NUM})\\s*(?:h|hs|hr|hrs|:\\d{2})|meio[- ]?dia))`, "g"), (x) => {
    pushDay(x, { kind: "wd", wd: Number(x[1]) - 1, mod: wdMod(x.index!, x.index! + x[0].length), lit: xlit(x) });
    return true;
  });
  // abreviações ambíguas ("ter", "sex", "dom"…) só contam coladas a uma hora
  scan(new RegExp(`\\b(${Object.keys(WEEKDAY_ABBR).join("|")})\\b\\.?(?:[- ]?feira)?`, "g"), (x) => {
    const a = x.index!;
    const b = a + x[0].length;
    const after = t.slice(b);
    const timeNext =
      new RegExp(`^\\s*(?:as\\s+|a\\s+|pelas\\s+)?(?:(?:${NUM})\\s*(?:h|hs|hr|hrs|:\\d{2})|(?:${NUM})\\s*(?:da|de)\\s+(?:${PERIOD})|meio[- ]?dia|\\d{1,2}\\s*$|\\d{1,2}\\s+(?!${QTY}))`).test(after) &&
      !new RegExp(`^\\s*as\\s+\\d{1,2}\\s+(?:${QTY})\\b`).test(after);
    if (!timeNext) return false;
    if (x[1] === "ter" && /\b(?:vou|vai|vamos|vao|posso|pode|podemos|pra|para|que|so|nao|ainda|de|a|ao|vc|voce|eu|ele|ela|tem|deve|preciso|quero|queria|e|ja)\s*$/.test(t.slice(0, a))) return false;
    pushDay(x, { kind: "wd", wd: WEEKDAY_ABBR[x[1]], mod: wdMod(a, b), lit: xlit(x) });
    return true;
  });

  // "quinta (26)": dia do mês entre parênteses só vale ao lado de um dia da semana (e precisa bater com ele)
  if (seg.days.some((d) => d.kind === "wd")) {
    scan(/\((\d{1,2})\)/g, (x) => {
      const d = Number(x[1]);
      if (d < 1 || d > 31) return false;
      pushDay(x, { kind: "dom", day: d, lit: xlit(x) });
      return true;
    });
  }
  // hoje / amanhã
  scan(/\b(?:hoje|hj)\b/g, (x) => {
    pushDay(x, { kind: "rel", offset: 0, lit: xlit(x) });
    return true;
  });
  scan(/\b(?:amanha+|amanh|amnha)\b/g, (x) => {
    pushDay(x, { kind: "rel", offset: 1, lit: xlit(x) });
    return true;
  });

  // horas
  const pushTime = (x: RegExpExecArray, h: number, minutes: number, period: string | undefined) => {
    const r = applyPeriod(h, minutes, period);
    seg.times.push({ at: start + x.index!, min: r.min, lit: xlit(x), why: r.why });
    xspan(x);
  };
  scan(/\bmeio[- ]?dia(?:\s+e\s+meia)?\b/g, (x) => {
    seg.times.push({ at: start + x.index!, min: 12 * 60 + (/meia/.test(x[0]) ? 30 : 0), lit: xlit(x) });
    xspan(x);
    return true;
  });
  scan(
    new RegExp(`\\b(${NUM})\\s*(horas?|hrs|hr|hs|h)(?:(\\d{2})(?!\\d)(?:\\s*min\\w*)?)?(?![a-z])(?:\\s+e\\s+(meia)\\b)?(?:\\s*(?:da|de|a)\\s+(${PERIOD}))?`, "g"),
    (x) => {
      const a = x.index!;
      const before = t.slice(0, a);
      const long = x[2].startsWith("hora");
      const hour = num(x[1]);
      const tailAfter = t.slice(a + x[0].length);
      if (DURATION_PREFIX.test(before)) {
        seg.times.push({ at: start + a, min: null, lit: xlit(x), why: "duracao" });
        return true;
      }
      if (long && !x[5] && !HORAS_PREFIX.test(before) && !/^\s*em ponto/.test(tailAfter)) {
        // "10 horas" solto: hora de relógio só entre 7 e 23 e sem cara de duração
        if (!(hour >= 8 && hour <= 23) || /^\s+(?:de|por|seguid|livre|disponiv|antes|depois|atras|cedo|ate)/.test(tailAfter)) {
          seg.times.push({ at: start + a, min: null, lit: xlit(x), why: "duracao" });
          return true;
        }
      }
      pushTime(x, hour, x[4] ? 30 : x[3] ? Number(x[3]) : 0, x[5]);
      return true;
    },
  );
  scan(new RegExp(`(?<![\\d:])(\\d{1,2}):(\\d{2})(?![\\d:])(?:\\s*(?:hs|hrs|hr|h)(?![a-z]))?(?:\\s*(?:da|de|a)\\s+(${PERIOD}))?`, "g"), (x) => {
    pushTime(x, Number(x[1]), Number(x[2]), x[3]);
    return true;
  });
  // 10.30 (ponto) como hora: só com minuto > 12, fora de preço
  scan(/(?<![\d.$])(\d{1,2})\.([1-5]\d)(?![\d.])/g, (x) => {
    const mi = Number(x[2]);
    if (mi <= 12 || /[$]\s*$/.test(t.slice(Math.max(0, x.index! - 4), x.index!))) return false;
    pushTime(x, Number(x[1]), mi, undefined);
    return true;
  });
  scan(new RegExp(`\\b(?:as|pelas|pras)\\s+(${NUM})\\s+e\\s+meia\\b(?:\\s*(?:da|de|a)\\s+(${PERIOD}))?`, "g"), (x) => {
    pushTime(x, num(x[1]), 30, x[2]);
    return true;
  });
  scan(new RegExp(`\\b(?:as|pelas|pras)\\s+(${NUM})(?:\\s*(?:da|de|a)\\s+(${PERIOD}))?${AS_TAIL}`, "g"), (x) => {
    pushTime(x, num(x[1]), 0, x[2]);
    return true;
  });
  // "9 e meia" sem "às"
  scan(new RegExp(`\\b(${NUM})\\s+e\\s+meia\\b(?:\\s*(?:da|de|a)\\s+(${PERIOD}))?`, "g"), (x) => {
    pushTime(x, num(x[1]), 30, x[2]);
    return true;
  });
  scan(new RegExp(`\\b(${NUM})\\s*(?:da|de)\\s+(${PERIOD})\\b`, "g"), (x) => {
    pushTime(x, num(x[1]), 0, x[2]);
    return true;
  });

  if (limitHit) {
    seg.limited = true;
    if (seg.days.length === 0 && seg.times.length === 0) block("limite", limitHit);
    else seg.hasLimit = true;
  }
  // proposta (marcador no próprio trecho) vence qualquer ato do trecho; "ou" só conta com dia/hora
  const hasTokens = seg.days.length > 0 || seg.times.length > 0;
  const weakPropor = !hasTokens && (propor?.[0] === "pode ser" || propor?.[0] === "serve");
  if (propor && !weakPropor && (propor[0] !== "ou" || hasTokens)) {
    seg.acts = [{ act: "propos", lit: lit(propor.index, propor.index + propor[0].length) }];
    seg.markerCount = 0;
  }
  return seg;
}

// Ponto entre dígitos (26.11, 10.30) e após abreviação (Av., Dra.) não separa trechos.
const SPLIT_RE = /[!?;\n,]+|(?<!\d)\.+|\.+(?!\d)|\b(?:mas|porem|entretanto)\b/g;
const ABBREV_BEFORE = /\b(?:av|r|dr|dra|sr|sra|tv|al|pca|prof|ex|tel|n|no)$/;

function analyze(text: string): Analysis {
  const n = fold(text);
  const segs: Seg[] = [];
  const bounds: Array<{ from: number; to: number; q: boolean }> = [];
  let last = 0;
  for (const x of n.matchAll(SPLIT_RE)) {
    if (x[0] === "." && ABBREV_BEFORE.test(n.slice(0, x.index!))) continue;
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
  // bloqueios da mensagem inteira
  const globalBlock: string[] = [];
  const globalLits: string[] = [];
  const nk = maskRe(n, KEEP_AS_COMO);
  const test = (kind: string, re: RegExp, src: string = nk) => {
    const x = re.exec(src);
    if (x) {
      globalBlock.push(kind);
      globalLits.push(text.slice(x.index, x.index + x[0].length).trim());
    }
  };
  test("condicional", RE_COND, maskRe(nk, /\bse\s+(?:deus quiser)\b/g));
  test("promessa", RE_PROMISE);
  test("relato", RE_REPORT);
  test("citacao", RE_QUOTE);
  test("emoji_negativo", RE_NEG_EMOJI, n);
  test("encaminhada", RE_FORWARD);
  if (RE_QUOTE_LINE.test(text)) {
    globalBlock.push("citacao");
    globalLits.push(">");
  }
  const sl = SPEAKER_LABEL.exec(text) ?? RE_BRACKET_TIMESTAMP.exec(text);
  if (sl) {
    globalBlock.push("transcricao");
    globalLits.push(sl[0].trim());
  }
  test("ironia", RE_IRONY);
  return { text, n, segs, globalBlock, globalLits };
}

const isClean = (s: Seg) => s.blockers.length === 0 && !s.question;
const isQuestionOnly = (s: Seg) => s.blockers.length === 0 && s.question;
const segHasTokens = (s: Seg) => s.days.length > 0 || s.times.length > 0;
const segCarries = (s: Seg) => segHasTokens(s) || s.limited;

// ───────────────────────── lista de permissão ("completo") ─────────────────────────

const RE_OPENING_CLOSING = new RegExp(
  [
    "oi|ola|bom dia|boa tarde|boa noite|tudo bem|tudo certo|ok|okay|certo|beleza|blz|show|perfeito|otimo|claro|sim|valeu|obrigad[oa]|muito obrigad[oa]|obg|brigad[oa]",
    "ate la|ate logo|ate breve|ate mais|ate|abracos?|beijos?|bjs?|tchau|um otimo dia|boa semana|conte comigo",
  ]
    .join("|")
    .replace(/^/, "\\b(?:")
    .concat(")\\b"),
  "g",
);
const RE_CONNECTORS = /\b(?:pra|para|no|na|em|nesta|nessa|esta|essa|ta|ficou|as|a|dia|do|da|de)\b/g;
// "pra você" e "sua avaliação/consulta…" depois do marcador: dirigido ao cliente, serviço genérico
const RE_DIRECTED = /\b(?:(?:pra|para)\s+(?:voce|vc)|(?:sua|seu)\s+(?:avaliacao|consulta|sessao|horario|atendimento|aula|agendamento))\b/g;
// Emojis permitidos na forma fechada (com tons de pele e seletor de variação); qualquer outro emoji é sobra.
const ALLOWED_EMOJI = /(?:\u2705|\ud83d\udc4d|\ud83d\udc4c|\ud83d\ude4f|\ud83d\ude0a|\ud83d\ude42|\ud83d\ude09|\ud83e\udd1d|\u2764|\ud83d\ude18|\ud83e\udd70)(?:\ud83c[\udffb-\udfff])?\ufe0f?/g;
const ANY_PICTOGRAPH = /[\ud800-\udfff\u2190-\u2bff\u203c\u2049\u2122\u200d\ufe0f]/;
// Emoji claramente negativo/incerto: nem "confirmou".
const RE_NEG_EMOJI = /\ud83d\udc4e|\u274c|\u274e|\ud83d\udeab|\ud83d\ude45|\u2753|\u2754|\u2049|\ud83e\udd14|\ud83e\udd37|\ud83e\udd21|\ud83d\ude44|\ud83d\ude43|\u2716|\u26d4|\ud83d\uded1|\ud83d\ude21|\ud83d\ude20|\ud83d\ude12/;
// Termina em conector solto ("…10h nã", "…quinta 10h mas"): mensagem truncada.
const TRAILING_CONNECTOR = /\b(?:na|no|nas|nos|mas|e|que|de|do|da|pra|para|com|ou|se|em|a|o|as|os|ate|nao|nem|so|porem|pois)[\s\W]*$/;

/**
 * Forma fechada: depois de tirar marcadores fortes, dia, hora (já extraídos), saudação/fecho da
 * lista fechada, conectores e pontuação/emoji, não sobra nenhuma letra ou número. Sem "?".
 */
function fitsClosedForm(a: Analysis, extra?: RegExp): boolean {
  if (a.globalBlock.length > 0 || a.n.includes("?")) return false;
  if (a.segs.some((s) => s.blockers.length > 0 || s.question || s.hasRange || s.hasLimit || s.noisy)) return false;
  const chars = a.n.split("");
  for (const sg of a.segs) for (const [x, y] of sg.spans) for (let i = x; i < y; i++) chars[i] = " ";
  let r = chars.join("");
  if (TRAILING_CONNECTOR.test(a.n.replace(ALLOWED_EMOJI, " "))) return false;
  if (extra) r = r.replace(extra, " ");
  r = r.replace(ALLOWED_EMOJI, " ").replace(RE_DIRECTED, " ").replace(RE_OPENING_CLOSING, " ").replace(RE_CONNECTORS, " ");
  return !/[a-z0-9\u00aa\u00ba$%@#+*=/\\]/.test(r) && !ANY_PICTOGRAPH.test(r);
}

// ───────────────────────── pré-filtro ─────────────────────────

/**
 * Zero leitura de banco e independe de fuso/relógio. Passa com marca de tempo OU verbo de
 * compromisso em trecho limpo; cai com faixa de funcionamento, pergunta, negação, condicional ou
 * passado. É um filtro barato: quem passa ainda precisa de `parseConfirmation`.
 */
export function prefilterConfirmation(raw: string): PrefilterResult {
  const negatives: string[] = [];
  if (typeof raw !== "string" || !raw.trim()) return { pass: false, signals: [], negatives: ["vazio"] };
  const text = normalizeConfirmationText(raw);
  if (text.length > CONFIRM_MAX_CHARS) return { pass: false, signals: [], negatives: ["texto_longo"] };
  const a = analyze(text);
  for (const gb of a.globalBlock) negatives.push(gb);
  for (const s of a.segs) {
    for (const b of s.blockers) if (!negatives.includes(b)) negatives.push(b);
    if (s.question && !negatives.includes("pergunta")) negatives.push("pergunta");
  }
  const signals: string[] = [];
  for (const s of a.segs.filter(isClean)) {
    for (const act of s.acts) signals.push(`ato:${act.act}`);
    if (s.hasRange && s.markerCount === 0) {
      if (!negatives.includes("faixa")) negatives.push("faixa"); // "das 9 às 12" sem marcador: horário de funcionamento
      continue;
    }
    if (s.days.length) signals.push("dia");
    if (s.times.length) signals.push("hora");
  }
  const uniq = [...new Set(signals)];
  return { pass: a.globalBlock.length === 0 && uniq.length > 0, signals: uniq, negatives };
}

// ───────────────────────── resolução ─────────────────────────

type DateRes = { date: LocalDate | null; why?: string };

function resolveDay(tok: DayTok, today: LocalDate, nowMin: number): DateRes {
  const [ty, tm, td] = ymdParts(today);
  const dow = weekdayOf(today);
  switch (tok.kind) {
    case "rel":
      // "amanhã" escrito entre 00h e 05h locais: o remetente pode estar falando do dia que ainda "não virou" para ele
      if (tok.offset >= 1 && nowMin < 300) return { date: null, why: "amanha_madrugada" };
      return { date: addDays(today, tok.offset) };
    case "wd": {
      if (tok.mod === "weekNext") {
        const toMonday = ((1 - dow + 7) % 7) || 7;
        return { date: addDays(today, toMonday + ((tok.wd + 6) % 7)) };
      }
      const k = (tok.wd - dow + 7) % 7;
      if (tok.mod === "next") {
        // "sábado que vem" dito na sexta: amanhã ou daqui a 8 dias?
        if (k === 1) return { date: null, why: "proximo_dia_semana_amanha" };
        return { date: addDays(today, k || 7) };
      }
      if (k === 0) return { date: null, why: "dia_semana_hoje" }; // "quinta" numa quinta: hoje ou semana que vem?
      return { date: addDays(today, k) };
    }
    case "dom": {
      if (tok.day >= td) return validYmd(ty, tm, tok.day) ? { date: fmtDate(ty, tm, tok.day) } : { date: null, why: "dia_invalido" };
      const nm = tm === 12 ? 1 : tm + 1;
      const ny = tm === 12 ? ty + 1 : ty;
      if (!validYmd(ny, nm, tok.day)) return { date: null, why: "dia_invalido" };
      // dia que acabou de passar neste mês (1–3 dias): provavelmente referência ao passado; resolve, com aviso, e nunca "completo"
      return { date: fmtDate(ny, nm, tok.day), why: td - tok.day <= 3 ? "dia_ja_passou_neste_mes" : undefined };
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
      // virada de ano: só se a data do ano seguinte estiver a até 60 dias; senão é referência a data que já passou
      if (validYmd(ty + 1, tok.m, tok.d) && daysBetween(today, fmtDate(ty + 1, tok.m, tok.d)) <= 60) return { date: fmtDate(ty + 1, tok.m, tok.d) };
      return { date: null, why: "data_passada" };
    }
  }
}

function pickDate(tokens: DayTok[], today: LocalDate, nowMin: number, negatives: string[]): { date?: LocalDate; lits: string[] } {
  const lits = tokens.map((t) => t.lit);
  if (tokens.length === 0) return { lits };
  const explicit: LocalDate[] = [];
  const weekdays: Array<{ wd: number; date: LocalDate | null }> = [];
  let unresolved = false;
  for (const tok of tokens) {
    const r = resolveDay(tok, today, nowMin);
    if (r.why) negatives.push(r.why);
    if (tok.kind === "wd") weekdays.push({ wd: tok.wd, date: r.date });
    else if (r.date) explicit.push(r.date);
    else unresolved = true;
  }
  if (unresolved) return { lits }; // um dia citado que não resolve (data inválida/passada) não deixa outro "ganhar"
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
    if (weekdays.some((w) => w.date === null)) return { lits };
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

export function parseConfirmation<TId extends string = string>(raw: string, ctx: ParseConfirmationContext<TId>): ParsedConfirmation<TId> {
  assertTz(ctx.tz);
  const empty = (act: ConfirmAct, negatives: string[], blocked: string[] = []): ParsedConfirmation<TId> => ({
    act,
    resolved: { act: false, date: false, time: false },
    level: "nenhum",
    fromProposal: { date: false, time: false },
    fromMessage: {},
    evidence: { act: [], date: [], time: [], service: [], blocked },
    signals: [],
    negatives,
  });
  if (typeof raw !== "string" || !raw.trim()) return empty("nenhum", ["vazio"]);
  const text = normalizeConfirmationText(raw);
  if (text.length > CONFIRM_MAX_CHARS) return empty("nenhum", ["texto_longo"]);

  const a = analyze(text);
  const negatives: string[] = [...a.globalBlock];
  for (const s of a.segs) {
    for (const b of s.blockers) if (!negatives.includes(b)) negatives.push(b);
    if (s.question && !negatives.includes("pergunta")) negatives.push("pergunta");
  }
  const blockedLits = [...a.globalLits, ...a.segs.flatMap((s) => s.blockedLits)];
  if (a.globalBlock.length) return empty("nenhum", negatives, blockedLits);

  const clean = a.segs.filter(isClean);
  const qOnly = a.segs.filter(isQuestionOnly);
  const blocked = a.segs.filter((s) => s.blockers.length > 0);
  const cleanActs = clean.flatMap((s) => s.acts);
  const has = (act: ActHit["act"]) => cleanActs.filter((h) => h.act === act);
  const infoOnly = () =>
    blocked.some((s) => s.blockers.includes("funcionamento")) && !blocked.some((s) => s.blockers.some((b) => b !== "funcionamento"));

  let act: ConfirmAct = "nenhum";
  let actLits: string[] = [];
  let pool: Seg[] = clean;
  let weakClosed = false;

  const todayClock = localClock(ctx.now, ctx.tz);
  const proposalRaw = ctx.proposal;
  const proposalFresh = proposalRaw !== undefined && ctx.now - proposalRaw.at < PROPOSAL_TTL_MS;
  if (proposalRaw && !proposalFresh) negatives.push("proposta_velha");
  // só proposta do CLIENTE e recente preenche dia/hora de resposta curta
  const proposal = proposalFresh && proposalRaw.by === "cliente" ? proposalRaw : undefined;
  if (proposalRaw && proposalFresh && !proposal) negatives.push("proposta_nao_e_do_cliente");
  const actSegs = (k: ActHit["act"]) => clean.filter((s) => s.acts.some((h) => h.act === k) && segHasTokens(s));

  if (has("remarcou").length) {
    act = "remarcou";
    actLits = has("remarcou").map((h) => h.lit);
    const own = actSegs("remarcou");
    if (own.length) pool = own;
    // "remarcado de quinta 10h para sexta 14h": vale o que vem depois de "para/pra"
    const nf = pool.find((s) => s.newFrom !== undefined)?.newFrom;
    if (nf !== undefined) {
      const later = (at: number) => at >= nf;
      if (pool.some((s) => s.days.some((d) => later(d.at)) || s.times.some((tt) => later(tt.at)))) {
        pool = pool.map((s) => ({ ...s, days: s.days.filter((d) => later(d.at)), times: s.times.filter((tt) => later(tt.at)) }));
      }
    }
  } else if (has("cancelou").length) {
    act = "cancelou";
    actLits = has("cancelou").map((h) => h.lit);
    const own = actSegs("cancelou");
    if (own.length) pool = own;
  } else if (has("confirmou").length) {
    act = "confirmou";
    actLits = has("confirmou").map((h) => h.lit);
    const lastSeg = a.segs[a.segs.length - 1];
    const cleanHasTokens = clean.some(segHasTokens);
    const blockedHasTokens = blocked.some(segCarries);
    const lastTagOnly = !segHasTokens(lastSeg) && lastSeg.acts.length === 0 && a.segs.length > 1 && TAG_ONLY.test(a.n.slice(lastSeg.start, lastSeg.end));
    if (clean.some((s) => segHasTokens(s) && s.acts.some((h) => h.act === "propos"))) {
      // "Fechado! Mas só consigo quinta 10h": contraproposta, não confirmação
      act = "propos";
      actLits = has("propos").map((h) => h.lit);
      negatives.push("contraproposta");
    } else if (lastTagOnly || (lastSeg.question && lastSeg.blockers.length === 0 && !segHasTokens(lastSeg) && a.segs.length > 1 && TAG_ONLY.test(a.n.slice(lastSeg.start, lastSeg.end)))) {
      // "fechado quinta 10h, né?" / "… certo": pergunta-etiqueta, mesmo sem "?"
      act = "propos";
      negatives.push("pergunta_etiqueta");
    } else if (qOnly.some(segHasTokens) && cleanHasTokens) {
      // outro dia/hora em pergunta junto da confirmação: conflito
      act = "nenhum";
      actLits = [];
      negatives.push("conflito_proposta");
    } else if (!cleanHasTokens && blockedHasTokens) {
      // o dia/hora citado caiu em trecho negado/passado/ocupado: não confirma nada
      act = infoOnly() ? "informativo" : "nenhum";
      actLits = [];
    } else if (!cleanHasTokens && qOnly.some(segHasTokens)) {
      act = "propos";
      pool = qOnly;
    } else {
      const own = clean.filter((s) => s.acts.some((h) => h.act === "confirmou") && segHasTokens(s));
      if (own.length && own.length < clean.filter(segHasTokens).length) {
        // dia/hora em outro trecho limpo (sem marcador) também contam; mantém o pool todo
        pool = clean;
      }
    }
  } else if (has("propos").length) {
    act = "propos";
    actLits = has("propos").map((h) => h.lit);
    pool = [...clean, ...qOnly];
    if (!pool.some(segHasTokens)) {
      act = "nenhum";
      actLits = [];
    }
  } else if (proposal && (proposal.localDate !== undefined || proposal.timeMin !== undefined)) {
    // "ok", "sim", "pode ser", "👍" respondendo a uma proposta aberta: só a mensagem INTEIRA na lista fechada
    const weakRe = new RegExp(`\\b(?:${WEAK_WORDS})\\b`, "g");
    const weakHit = weakRe.test(a.n) || new RegExp(RE_WEAK_EMOJI.source).test(a.n); // sem /g: .test com /g guarda estado entre chamadas
    if (weakHit && a.segs.every((s) => s.blockers.length === 0 && !s.question)) {
      const extra = new RegExp(`${weakRe.source}|${RE_WEAK_EMOJI.source}|${EMOJI}`, "g");
      const ok = fitsClosedForm({ ...a, segs: a.segs }, extra);
      const d = pickDate(clean.flatMap((s) => s.days), todayClock.date, todayClock.minutes, []).date;
      const tm = pickTime(clean.flatMap((s) => s.times), []).min;
      const consistent =
        (d === undefined || proposal.localDate === undefined || d === proposal.localDate) && (tm === undefined || proposal.timeMin === undefined || tm === proposal.timeMin);
      if (ok && consistent) {
        act = "confirmou";
        weakClosed = true;
        actLits = [text.trim()];
        negatives.push("so_com_proposta");
      } else if (ok) {
        negatives.push("diverge_da_proposta");
      }
    }
  }
  if (act === "nenhum") {
    if (qOnly.some(segHasTokens) && !blocked.some(segHasTokens) && !proposalRaw && qOnly.some((s) => s.acts.some((h) => h.act === "propos"))) {
      act = "propos";
      pool = qOnly;
      negatives.push("pergunta_com_horario");
    } else if (qOnly.some(segHasTokens) && !blocked.some(segHasTokens) && !clean.some(segHasTokens) && !weakClosed) {
      act = "propos";
      pool = qOnly;
      negatives.push("pergunta_com_horario");
    } else if (infoOnly() || a.segs.some((s) => s.hasRange && s.blockers.length === 0 && !s.acts.length)) {
      act = "informativo";
    }
  }

  if (act === "nenhum" || act === "informativo") return empty(act, negatives, blockedLits);

  // ── dia e hora
  const days = pool.flatMap((s) => s.days);
  const times = pool.flatMap((s) => s.times);
  const d = pickDate(days, todayClock.date, todayClock.minutes, negatives);
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

  const fromMessage = { localDate, timeMin };
  const fromProposal = { date: false, time: false };
  if (act === "confirmou" && proposal) {
    const sameDay = localDate === undefined || proposal.localDate === undefined || localDate === proposal.localDate;
    const sameTime = timeMin === undefined || proposal.timeMin === undefined || timeMin === proposal.timeMin;
    if (localDate === undefined && d.lits.length === 0 && proposal.localDate !== undefined && sameTime) {
      localDate = proposal.localDate;
      fromProposal.date = true;
    }
    if (timeMin === undefined && tm.lits.length === 0 && proposal.timeMin !== undefined && sameDay) {
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
  if (localDate !== undefined && daysBetween(todayClock.date, localDate) > 30) negatives.push("data_distante");
  const form: "explicito" | "resposta_curta" = !weakClosed && fromMessage.localDate !== undefined && fromMessage.timeMin !== undefined ? "explicito" : "resposta_curta";
  // lista de permissão: só "completo" se a mensagem inteira cabe na forma fechada
  const closed = act === "confirmou" && (weakClosed || (resolved.date && resolved.time && a.segs.some((s) => s.markerCount > 0) && fitsClosedForm(a)));
  const SOFT = ["dia_ja_passou_neste_mes", "proximo_dia_semana_amanha", "amanha_madrugada"];
  const soft = negatives.some((x) => SOFT.includes(x));
  const level: ParsedConfirmation["level"] = closed && !soft && resolved.date && resolved.time ? "completo" : "parcial";
  if (act === "confirmou" && level === "parcial" && resolved.date && resolved.time) negatives.push("fora_da_forma_fechada");
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
    level,
    fromProposal,
    fromMessage: { localDate: fromMessage.localDate, timeMin: fromMessage.timeMin },
    form,
    evidence: { act: actLits, date: d.lits, time: tm.lits, service: svc.lits, blocked: blockedLits },
    signals,
    negatives: [...new Set(negatives)],
  };
}

// ───────────────────────── terceira condição: proposta coincidente ─────────────────────────

export type ProposalMatch = {
  ok: boolean;
  /** "ok" ou o motivo da recusa (ex.: "dia_diferente", "hora_diferente", "proposta_velha"). */
  reason:
    | "ok"
    | "nao_confirmou"
    | "sem_proposta"
    | "proposta_velha"
    | "proposta_incompleta"
    | "sem_dia_ou_hora"
    | "resposta_curta_exige_cliente"
    | "dia_diferente"
    | "hora_diferente";
};

/**
 * Terceira condição para criar sozinho (plano §8.1): existe uma proposta aberta (< 48 h) com o MESMO dia
 * e a MESMA hora que o parser tirou da própria mensagem. Pura; a escolha da proposta (mensagem anterior
 * do cliente, oferta da IA, mensagem anterior do humano) é de quem chama.
 *
 * - `form: "explicito"`: compara `fromMessage` (dia e hora escritos na mensagem) com a proposta, de qualquer origem.
 * - `form: "resposta_curta"`: a proposta precisa ser do cliente (o "ok" do dono à própria proposta não confirma nada).
 *
 * Isto NÃO substitui `level === "completo"`: quem chama confere os dois.
 */
export function matchesProposal(parsed: Pick<ParsedConfirmation, "act" | "form" | "localDate" | "timeMin" | "fromMessage">, proposal: ConfirmProposal | undefined, now: number): ProposalMatch {
  if (parsed.act !== "confirmou") return { ok: false, reason: "nao_confirmou" };
  if (!proposal) return { ok: false, reason: "sem_proposta" };
  if (now - proposal.at >= PROPOSAL_TTL_MS) return { ok: false, reason: "proposta_velha" };
  if (proposal.localDate === undefined || proposal.timeMin === undefined) return { ok: false, reason: "proposta_incompleta" };
  const short = parsed.form === "resposta_curta";
  if (short && proposal.by !== "cliente") return { ok: false, reason: "resposta_curta_exige_cliente" };
  const date = short ? parsed.localDate : parsed.fromMessage.localDate;
  const time = short ? parsed.timeMin : parsed.fromMessage.timeMin;
  if (date === undefined || time === undefined) return { ok: false, reason: "sem_dia_ou_hora" };
  if (date !== proposal.localDate) return { ok: false, reason: "dia_diferente" };
  if (time !== proposal.timeMin) return { ok: false, reason: "hora_diferente" };
  return { ok: true, reason: "ok" };
}

// ───────────────────────── menções de dia/hora (mensagens do CLIENTE) ─────────────────────────

export type DateTimeMention = {
  localDate?: LocalDate;
  timeMin?: number;
  /** Trechos literais (substrings de `normalizeConfirmationText(text)`). */
  evidence: string[];
};

const MENTION_BLOCKED_GLOBAL = new Set(["condicional", "relato", "citacao", "encaminhada", "transcricao", "ironia", "emoji_negativo"]);

/**
 * Menções de dia e/ou hora numa mensagem (do cliente), SEM exigir marcador de confirmação — para o
 * chamador achar a proposta aberta nas mensagens anteriores. Mesmas regras de ambiguidade do parser;
 * na dúvida devolve vazio: dia que não resolve descarta a menção, trecho com negação/passado/limite/
 * faixa/assunto financeiro não conta, hora ambígua ou "depois das 18h" não é hora exata. Pergunta conta
 * ("pode ser quinta às 10?"). Duas menções na mesma frase ("quinta 10h ou sexta 14h") viram duas.
 */
export function extractDateTimeMentions(raw: string, ctx: { now: number; tz: string }): DateTimeMention[] {
  assertTz(ctx.tz);
  if (typeof raw !== "string" || !raw.trim()) return [];
  const text = normalizeConfirmationText(raw);
  if (text.length > CONFIRM_MAX_CHARS) return [];
  const a = analyze(text);
  if (a.globalBlock.some((b) => MENTION_BLOCKED_GLOBAL.has(b))) return [];
  const clock = localClock(ctx.now, ctx.tz);
  const out: DateTimeMention[] = [];
  const seen = new Set<string>();
  for (const seg of a.segs) {
    if (seg.blockers.length > 0 || seg.hasRange || seg.hasLimit) continue;
    const toks = [
      ...seg.days.map((d) => ({ k: "d" as const, at: d.at, d })),
      ...seg.times.map((tt) => ({ k: "t" as const, at: tt.at, t: tt })),
    ].sort((x, y) => x.at - y.at);
    type Group = { days: DayTok[]; time?: TimeTok };
    const groups: Group[] = [];
    let cur: Group = { days: [] };
    let lastEnd = -1;
    let lastKind: "d" | "t" | undefined;
    const flush = () => {
      if (cur.days.length || cur.time) groups.push(cur);
      cur = { days: [] };
    };
    for (const tk of toks) {
      const between = lastEnd >= 0 ? a.n.slice(lastEnd, tk.at) : "";
      if (tk.k === "d") {
        // dias seguidos sem "ou/e/vírgula" entre si descrevem o MESMO dia ("quinta 26/11", "quinta (26)")
        const sameDay = lastKind === "d" && !/\b(?:ou|e)\b/.test(between);
        if (!sameDay && cur.days.length > 0) flush();
        // "segunda, 10h e terça, 15h": uma hora e, depois de "e/ou", OUTRO dia: o dia novo não herda a hora anterior.
        if (lastKind === "t" && cur.time && cur.days.length === 0 && /\b(?:ou|e)\b/.test(between)) flush();
        cur.days.push(tk.d);
        lastEnd = tk.at + tk.d.lit.length;
        lastKind = "d";
      } else {
        if (cur.time) flush();
        cur.time = tk.t;
        lastEnd = tk.at + tk.t.lit.length;
        lastKind = "t";
      }
    }
    flush();
    for (const gr of groups) {
      const neg: string[] = [];
      let date: LocalDate | undefined;
      if (gr.days.length) {
        date = pickDate(gr.days, clock.date, clock.minutes, neg).date;
        if (date === undefined) continue; // dia citado que não resolve: descarta a menção inteira
        if (date < clock.date) continue;
      }
      let time: number | undefined;
      if (gr.time) {
        const tm = pickTime([gr.time], neg);
        time = tm.min;
        if (time === undefined && date === undefined) continue;
        if (time !== undefined && date === clock.date && time <= clock.minutes) continue;
      }
      if (date === undefined && time === undefined) continue;
      const key = `${date ?? "-"}|${time ?? "-"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ localDate: date, timeMin: time, evidence: [...gr.days.map((d) => d.lit), ...(gr.time ? [gr.time.lit] : [])] });
    }
  }
  return mergeSplitMention(out, text);
}

/** Entre o dia e a hora só pontuação, período do dia e "às": "terça, 15h", "terça de tarde, 15h" são UMA menção. */
const MENTION_GLUE_RE = /^[\s,;:\-–—]*(?:(?:de |da |pela |a )?(?:manha|tarde|noite)\s*[,;:\-–—]*\s*)?(?:(?:as|a|por volta d[ae]s?) )?$/;

/**
 * "terça, 15h" e "terça de tarde, 15h" saem do segmentador como um dia sem hora e uma hora sem dia. Quando um dia sem hora é seguido
 * de uma hora sem dia e o trecho entre eles é só cola (vírgula, período, "às"), é uma menção só ("segunda, 10h e terça, 15h" são
 * duas). Qualquer outra coisa no meio ("terça eu não posso, 15h") deixa como está.
 */
function mergeSplitMention(out: DateTimeMention[], text: string): DateTimeMention[] {
  if (out.length < 2) return out;
  const lowered = fold(text);
  const merged: DateTimeMention[] = [];
  let cursor = 0;
  for (let i = 0; i < out.length; i++) {
    const day = out[i];
    const time = out[i + 1];
    if (day.localDate !== undefined && day.timeMin === undefined && time && time.timeMin !== undefined && time.localDate === undefined) {
      const dayLit = fold(day.evidence[day.evidence.length - 1]);
      const timeLit = fold(time.evidence[0]);
      const a = lowered.indexOf(dayLit, cursor);
      const b = a < 0 ? -1 : lowered.indexOf(timeLit, a + dayLit.length);
      if (a >= 0 && b >= 0 && MENTION_GLUE_RE.test(lowered.slice(a + dayLit.length, b))) {
        merged.push({ localDate: day.localDate, timeMin: time.timeMin, evidence: [...day.evidence, ...time.evidence] });
        cursor = b + timeLit.length;
        i++;
        continue;
      }
    }
    merged.push(day);
  }
  return merged;
}
