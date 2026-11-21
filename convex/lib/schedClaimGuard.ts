/**
 * Agenda v2 (D1) — regra do output guard: a resposta da IA ao cliente não pode AFIRMAR um horário "marcado",
 * "confirmado", "agendado" ou "reservado" sem que o servidor tenha de fato registrado isso (plano §3.6).
 *
 * PURO (sem `ctx`, sem relógio próprio). A regra gira em torno dos HORÁRIOS citados, não só dos verbos (lista de verbos
 * nunca converge): cada menção de dia/hora na resposta (`extractDateTimeMentions`, o extrator do parser de confirmação)
 * é comparada com o que o servidor sabe:
 *  - E = agendamentos EXISTENTES do contato (com status: marcado × aguardando a equipe);
 *  - R = reserva feita NESTA rodada (com status; a prévia do modo sugestão conta como oferta, não como reserva);
 *  - O = ofertas vigentes (já mostradas ao cliente) e as emitidas neste turno.
 *
 * Os horários são lidos por `schedTimeText` (casador PRÓPRIO para texto da IA: não herda o bloqueio por condicional
 * do extrator de mensagens de cliente; o dia atravessa frases e linhas). Regras, por tipo de horário citado na frase:
 *  1. fora de E ∪ R ∪ O, em frase DE AGENDA (oferece ou fecha horário de atendimento: verbo de oferta/fechamento de
 *     agenda, substantivo horário/vaga/consulta/sessão/atendimento/agenda, ou nome de serviço) → `time_not_offered`.
 *     "Posso te ligar amanhã às 10h?", "O curso começa dia 20 às 19h." não são de agenda e passam;
 *  2. só em O (ofertado, sem reserva): LISTA DE PERMISSÃO — a frase só passa se for OFERTA (tenho/temos/há/disponível/
 *     vaga/opções…), LISTA de horários, PERGUNTA (inclui pergunta-eco "né?/certo?"), hedge (vou/posso/se/caso/assim que/
 *     não) ou read-back seguido de pedido de confirmação; qualquer outra frase que cite o horário é afirmação →
 *     `claim_without_booking` (além do léxico de fechamento, que barra antes);
 *  3. em R/E aguardando a equipe: só passa dizendo que o pedido foi registrado/aguarda/será confirmado pela equipe;
 *     "a equipe já confirmou", "foi aprovado" → `confirmed_but_pending`;
 *  4. em R/E marcado: livre;
 *  5. fechamento SEM horário ("Prontinho! Seu horário está confirmado") só passa com R marcado nesta rodada ou com
 *     exatamente UM agendamento marcado em E; com pendente → `confirmed_but_pending`; sem nada → `claim_without_booking`.
 *
 * NÃO barra: pergunta, citação do cliente ("você pediu…", texto entre aspas), negação, condicional ("assim que a
 * equipe confirmar"), promessa futura, horário de funcionamento, indisponibilidade ("quinta às 17h está ocupado"),
 * pagamento "confirmado", "horários marcados no site". Corpus de casos: `schedClaimGuard.test.ts`.
 */
import { dayMatches, extractAiTimes, norm, splitSentences, type TimeMention, todayOf } from "./schedTimeText";
import { localDateOf, minutesOfDay } from "./schedTime";

export type KnownTime = { localDate: string; timeMin: number };
export type KnownBooking = KnownTime & { status: "pending" | "scheduled" };
export type ClaimState = {
  now: number;
  tz: string;
  /** E: agendamentos existentes do contato. */
  existing: KnownBooking[];
  /** R: reserva feita nesta rodada (pending = pedido registrado; scheduled = marcado). */
  booked: KnownBooking[];
  /** O: ofertas vigentes + emitidas neste turno + prévia do modo sugestão. */
  offered: KnownTime[];
  /** Nomes dos serviços ativos da org: citar um deles torna a frase "de agenda". */
  serviceNames?: string[];
};
export type ClaimViolation = {
  kind: "claim_without_booking" | "confirmed_but_pending" | "time_not_offered" | "reschedule_claim";
  /** Trecho da frase (≤ 80 caracteres) para log; nunca o texto inteiro. */
  evidence: string;
};

const EVIDENCE_MAX = 80;

export function knownTime(startTime: number, tz: string): KnownTime {
  return { localDate: localDateOf(startTime, tz), timeMin: minutesOfDay(startTime, tz) };
}

/** Remove o que o cliente disse e a IA só repete: texto entre aspas. */
function stripQuotes(s: string): string {
  return s.replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, " ");
}

function sentencesOf(text: string): string[] {
  return (stripQuotes(text).match(/[^.!?\n]+[.!?]*/g) ?? []).map((x) => x.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Léxico de fechamento
// ---------------------------------------------------------------------------

type Level = "strong" | "closer" | "soft";
/**
 * `domain`: o marcador é do próprio domínio de agenda (marcado, agendado, reservado, garantido…): vale como "de agenda"
 * mesmo sem substantivo. `needsMention`: só conta com horário citado na mensagem. `readback`: pode aparecer no read-back
 * que as instruções pedem ("anotado: segunda às 08:00. Posso registrar?").
 */
type Marker = { re: RegExp; level: Level; needsMention?: boolean; readback?: boolean; domain?: boolean };

const MARKERS: Marker[] = [
  { re: /\bmarcad(?:[oa]|inh|issim)\w*\b(?!\s+como\b)/g, level: "strong", domain: true },
  { re: /\bagendad(?:[oa]|inh|issim)\w*\b/g, level: "strong", domain: true },
  { re: /\bconfirmad(?:[oa]|inh|issim)\w*\b/g, level: "strong" },
  { re: /\bgarantid\w*\b|\bgaranti(?:i|mos)\b/g, level: "strong", domain: true },
  { re: /\b(?:marquei|agendei|marcamos|agendamos|confirmei|encaixei|separei|coloquei|incluí|inclui|adicionei|segurei|bloqueei)\b/g, level: "strong", domain: true },
  { re: /\bja confirm(?:ou|aram|amos)\b|\bconfirm(?:ou|aram)\b|\baprovad[oa]s?\b|\baprov(?:ou|aram)\b/g, level: "strong" },
  { re: /\bconfirm(?:o|amos)\s+(?:(?:o|a|os|as|seu|sua|seus|suas)\s+)*(?:horario|agendamento|consulta|sessao|atendimento|reserva|marcacao|visita)s?\b/g, level: "strong" },
  { re: /\b(?:fica|ficou)\s+(?:para|pra)\b/g, level: "strong" },
  { re: /\bfica\s+(?:entao\s+)?(?:na\s+|no\s+|a\s+)?(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje)\b/g, level: "strong", needsMention: true },
  { re: /\b(?:esta|estao|ficou|ficaram)\s+(?:tudo\s+)?certo\b|\btudo certo\b/g, level: "strong" },
  { re: /\bpode vir\b|\b(?:fica|ficou|continua) (?:valendo|de pe)\b|\besta de pe\b|\b(?:fica|ficou) certo\b/g, level: "strong" },
  { re: /\batualizad[oa]\b(?=[^.!?]*\b(?:consulta|sessao|horario|agendamento)\b)|\binscrevi\b|\bconfirmacao feita\b|\bfeit[oa] o agendamento\b|\bagendamento (?:esta )?feito\b/g, level: "strong", domain: true },
  { re: /\bte (?:espero|esperamos|vejo|aguardo|aguardamos|atende|atendo|recebo|recebe|mando)\b|\bnos (?:vemos|falamos)\b|\bate (?:la|logo|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/g, level: "strong", needsMention: true, domain: true },
  { re: /✅|✔/g, level: "strong" },
  { re: /\bja esta na agenda\b|\bna agenda (?:de|para|pra|do dia)\b|\bna lista de\b/g, level: "strong", domain: true },
  { re: /\bsua (?:consulta|sessao|vaga|reserva|visita|avaliacao|presenca) (?:e|esta)\b|\bvoce sera atendid[oa]\b/g, level: "strong" },
  { re: /\be (?:seu|sua)\b|\bja era\b/g, level: "strong", needsMention: true, domain: true },
  { re: /\bprontinho\b|\bpronto\b|\bfeito(?=\s*[!,:;]|\s*$)|\bcertinho\b|\btudo pronto\b/g, level: "closer", readback: true },
  { re: /\bcombinad\w*\b|\bfechad[oa]\b|\banotad[oa]\b|\banotei\b/g, level: "closer", readback: true },
  { re: /\breservad[oa]\w*\b|\breservei\b|\breservamos\b/g, level: "soft", domain: true },
  { re: /\bregistrad[oa]s?\b|\bregistrei\b|\bregistramos\b/g, level: "soft" },
  { re: /\bdeixei\b/g, level: "soft", needsMention: true },
];

/** Antes do marcador, na mesma oração: negação, condição, pergunta, promessa futura, desejo, modal. */
const HEDGE_BEFORE =
  /\b(?:nao|nem|nunca|ainda nao|sem|vou|vamos|vai|posso|podemos|pode|podem|deve|devem|preciso|precisa|quero|quer|queria|queira|gostaria|deseja|para (?:deixar|ficar|ser|estar|ver|saber)|pra (?:deixar|ficar|ser|estar|ver|saber)|assim que|quando|se|caso|ate que|antes de|depois que|apos|talvez|como|sera|seria|estara|so|nenhum|nenhuma)\b/;
/** Condição que abre a frase vale até o fim dela, mesmo depois de vírgula: "Se der certo, fica marcado". */
const CONDITION_OPENER = /\b(?:se|caso|assim que|quando|ate que|depois que|desde que)\b/;
/** Frases que narram o que o CLIENTE disse: nunca são afirmação nem horário inventado. */
const CUSTOMER_CITATION = /^\s*(?:voce|vc|o senhor|a senhora)\s+(?:disse|falou|pediu|mencionou|escreveu|quer|queria|informou|perguntou|prefere|escolheu|comentou|contou)\b/;
const UNAVAILABLE_CUE = /\b(?:nao tenho|nao temos|nao ha|indisponivel|indisponiveis|ocupad[oa]s?|lotad[oa]s?|sem vaga|sem horario|nao consigo|nao da|ja passou|nao esta livre|nao esta disponivel)\b/;
const BUSINESS_CUE = /\b(?:fecha|fecho|fechar|encerro|encerramos|fechamos|fechado ate|abre|abrimos|aberto|abertos|aberta|funciona|funcionamos|funcionamento|atendemos|atende as|atende de|expediente|horario de atendimento|estacionamento)\b/;
const PAYMENT_CUE = /\b(?:pagamento|pix|comprovante|boleto|cartao|transferencia|compra|cadastro|recebimento|fatura|cobranca|valor)\b/;
const SCHEDULE_NOUN = /\b(?:horario|horarios|consulta|consultas|sessao|sessoes|atendimento|vaga|vagas|agendamento|reserva|marcacao|avaliacao|visita|agenda)\b/;
/** "os horários marcados no site podem estar desatualizados": o plural genérico não é afirmação sobre ESTE cliente. */
const GENERIC_PLURAL = /\b(?:horarios|agendamentos|consultas|sessoes|atendimentos|vagas)\s+(?:ja\s+)?(?:marcad|agendad|reservad|confirmad)/;
/** Pedido AGUARDANDO a equipe: o que a frase pode dizer. */
const PENDING_OK = /\b(?:registrad[oa]s?|registrei|registramos|aguard\w+|pendente|pedido|solicit\w+|sera confirmad\w*|a equipe (?:vai|ira|ainda vai|confirma|confirmara|ira confirmar)|equipe confirm(?:a|ar|ara))\b/;
const PENDING_QUALIFIER = /\b(?:aguard\w*|pendente|pedido|solicit\w*|equipe)\b/;
/** Oferta ou pergunta: o que a frase pode dizer sobre um horário só OFERTADO. */
const OFFER_VERB = /\b(?:tenho|temos|ha|tem|consigo|conseguimos|encaixo|encaixamos|oferec\w+|disponivel|disponiveis|vagas?|opcao|opcoes|livres?|que tal|pode ser|prefere|qual (?:horario|dia|fica)|horarios?)\b|\b(?:posso|podemos)\s+(?:te\s+)?(?:oferecer|marcar|encaixar|reservar|agendar|registrar|anotar)\b/;
/** Hedge de oferta: promessa futura, desejo, condição, negação. */
const OFFER_HEDGE = /\b(?:vou|vamos|posso|podemos|gostaria|quer|prefere|se|caso|assim que|quando|nao|ainda nao|sem|talvez|depende|preciso|precisa)\b/;
/** Última frase pede a confirmação do cliente: a anterior é um read-back, não um fechamento. */
const CONFIRM_QUESTION = /\b(?:posso (?:registrar|reservar|marcar|seguir|confirmar|anotar|fechar|prosseguir)|podemos (?:registrar|reservar|marcar|seguir|fechar)|confirma\b|esta certo|certo\b|correto\b|pode ser\b|ok\b|fechamos|e isso|e esse|e essa|quer que eu (?:registre|reserve|marque|anote)|devo (?:registrar|reservar|marcar|seguir))/;
/** "…, tá?", "…, certo?": pergunta-eco; o que vem antes continua sendo afirmação. */
const TAG_QUESTION = /,\s*(?:ta|tá|ne|né|certo|ok|combinado|beleza|tudo bem|viu|fechou|fechado|blz|entendeu|pode ser)\s*\?\s*$/i;

type Hit = { level: Level; needsMention: boolean; readback: boolean; domain: boolean };

function isHedged(sentence: string, at: number): boolean {
  const before = sentence.slice(0, at);
  if (CONDITION_OPENER.test(before)) return true;
  const clause = before.split(/[,;:()—]/).pop() ?? "";
  return HEDGE_BEFORE.test(clause.trim().split(/\s+/).slice(-6).join(" "));
}

function markersIn(n: string): Hit[] {
  const out: Hit[] = [];
  for (const m of MARKERS) {
    m.re.lastIndex = 0;
    for (const found of n.matchAll(m.re)) {
      if (isHedged(n, found.index ?? 0)) continue;
      // "cadastro confirmado", "pagamento confirmado": o assunto do marcador não é horário.
      const near = (n.slice(0, found.index ?? 0).split(/[,;:()—]/).pop() ?? "").trim().split(/\s+/).slice(-5).join(" ");
      if (PAYMENT_CUE.test(near)) continue;
      out.push({ level: m.level, needsMention: m.needsMention === true, readback: m.readback === true, domain: m.domain === true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remarcação / cancelamento afirmados (a IA ainda NÃO tem tool para isso: sempre barrado)
// ---------------------------------------------------------------------------

const CHANGE_CLAIM =
  /\b(?:remarc(?:ad[oa]\w*|amos)|remarquei|reagend(?:ad[oa]\w*|ei|amos)|troquei|trocad[oa]\w*|trocamos|mudei|mudad[oa]\w*|mudamos|passei (?:o|seu|sua|a|para|pra)|passou (?:para|pra)|transferid[oa]\w*|transferi|transferimos|adiei|adiad[oa]\w*|adiamos|antecipei|antecipad[oa]\w*)\b/g;
const CANCEL_CLAIM = /\b(?:cancelei|cancelad[oa]\w*|cancelamos|desmarquei|desmarcad[oa]\w*|desmarcamos)\b/g;
const SUBJECT_FICA = /\b(?:horario|consulta|sessao|atendimento|agendamento)\b[^.!?]*\b(?:fica|ficou) (?:para|pra)\b/;
const INSTEAD_OF = /\b(?:em vez de|ao inves de)\b/;

/** A frase AFIRMA mudança ou cancelamento de um agendamento (nunca passa: a IA não remarca nem cancela neste bloco). */
function claimsChange(n: string, hasMention: boolean, hasOfferVerb: boolean): boolean {
  const nounOrTime = SCHEDULE_NOUN.test(n) || hasMention;
  for (const re of [CHANGE_CLAIM, CANCEL_CLAIM]) {
    re.lastIndex = 0;
    for (const m of n.matchAll(re)) {
      if (isHedged(n, m.index ?? 0)) continue;
      if (nounOrTime) return true;
    }
  }
  if (SUBJECT_FICA.test(n) && !isHedged(n, n.search(/\b(?:fica|ficou) (?:para|pra)\b/))) return true;
  return INSTEAD_OF.test(n) && hasMention && !hasOfferVerb;
}

// ---------------------------------------------------------------------------
// Horários citados × horários conhecidos
// ---------------------------------------------------------------------------

type Match = "inventado" | "oferta" | "pendente" | "marcado";

function sameTime(k: KnownTime, m: TimeMention, today: string): boolean {
  return k.timeMin === m.timeMin && (m.day === undefined || dayMatches(m.day, k.localDate, today));
}

/** Prioridade: reserva desta rodada > agendamento existente > oferta. Hora sem dia compara só a hora. */
function classify(m: TimeMention, st: ClaimState, today: string): Match {
  const r = st.booked.filter((k) => sameTime(k, m, today));
  const e = st.existing.filter((k) => sameTime(k, m, today));
  const hit = r.length > 0 ? r : e;
  if (hit.length > 0) return hit.some((k) => k.status === "scheduled") ? "marcado" : "pendente";
  if (st.offered.some((k) => sameTime(k, m, today))) return "oferta";
  return "inventado";
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/** A frase tem só dia/hora e ligações ("- 08:00", "Segunda-feira, 15/06:"): item de lista de horários. */
function isBareTimeSentence(n: string): boolean {
  const words = n
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^(?:\d+|\d+h\d*|\d+hs|as|a|e|ou|das|de|dia|da|manha|tarde|noite|feira|segunda|terca|quarta|quinta|sexta|sabado|domingo|hoje|amanha|depois|meio|meia|ponto|hora|horas|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|uma|duas|tres|quatro|cinco|seis|sete)$/.test(w));
  return words.length === 0;
}

/** Há hora ou dia citados na frase (mesmo que a frase tenha sido pulada)? */
function mentionsAnyTime(raw: string): boolean {
  return extractAiTimes(raw).length > 0;
}

type Sentence = {
  raw: string;
  n: string;
  question: boolean;
  tagQuestion: boolean;
  skip: boolean;
  mentions: TimeMention[];
};

export function detectUnbackedBookingClaim(text: string, st: ClaimState): ClaimViolation | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const stripped = text.replace(/"[^"]*"|“[^”]*”|«[^»]*»/g, " ");
  const today = todayOf(st.now, st.tz);
  const all = extractAiTimes(stripped);
  const parts = splitSentences(stripped);
  const sentences: Sentence[] = parts.map((p, i) => {
    const tag = TAG_QUESTION.test(`${p.raw}${p.term}`);
    const body = tag ? p.raw.replace(/,\s*[^,]*$/, "") : p.raw;
    const n = norm(body);
    const skip = CUSTOMER_CITATION.test(n) || UNAVAILABLE_CUE.test(n) || BUSINESS_CUE.test(n);
    return {
      raw: p.raw.trim(),
      n,
      question: p.term.includes("?"),
      tagQuestion: tag,
      skip,
      mentions: skip ? [] : all.filter((m) => m.sentence === i),
    };
  });
  const live = sentences.filter((s) => s.raw.length > 0);
  const last = live[live.length - 1];
  const endsWithConfirmQuestion = !!last && last.question && CONFIRM_QUESTION.test(last.n);
  const whole = live.map((s) => s.n).join(" ");
  const pendingQualified = PENDING_QUALIFIER.test(whole);
  const messageNoun = SCHEDULE_NOUN.test(whole);
  const messageHasMention = live.some((s) => s.mentions.length > 0);
  const serviceNames = (st.serviceNames ?? []).map((x) => norm(x)).filter((x) => x.length >= 3);
  const mentionsService = (n: string) => serviceNames.some((sv) => n.includes(sv));

  const bookedScheduled = st.booked.some((k) => k.status === "scheduled");
  const bookedPending = st.booked.some((k) => k.status === "pending");
  const scheduledExisting = st.existing.filter((k) => k.status === "scheduled");
  const pendingExisting = st.existing.some((k) => k.status === "pending");

  const messageMatches = live.flatMap((s) => s.mentions.map((m) => classify(m, st, today)));

  // Marcadores só em frases afirmativas (pergunta de verdade não afirma nada; pergunta-eco avalia o que vem antes).
  const hitsOf = (s: Sentence): Hit[] =>
    s.question && !s.tagQuestion
      ? []
      : markersIn(s.n).filter((h) => {
          if (h.level === "closer" && !(messageHasMention || messageNoun)) return false;
          if (h.needsMention && !messageHasMention) return false;
          if (h.readback && endsWithConfirmQuestion) return false;
          return true;
        });

  const isAgendaSentence = (s: Sentence, hits: Hit[]) =>
    OFFER_VERB.test(s.n) ||
    SCHEDULE_NOUN.test(s.n) ||
    mentionsService(s.n) ||
    hits.some((h) => h.domain) ||
    (hits.length > 0 && /\b(?:seu|sua|voce|pra voce|para voce|no seu nome)\b/.test(s.n));
  const lastIsRealQuestion = !!last && last.question && !last.tagQuestion;

  // Uma afirmação de agenda em qualquer frase ("Marcado!") vale para o dia e hora citados nas outras ("Quinta às 15h.").
  const messageClaim = live.some((s) => !s.skip && hitsOf(s).some((h) => h.domain || messageNoun));

  // 0. Remarcação ou cancelamento AFIRMADOS: sempre barrado (a IA não tem tool de remarcar/cancelar; é repasse para humano).
  for (const s of live) {
    if (s.skip || (s.question && !s.tagQuestion)) continue;
    if (claimsChange(s.n, s.mentions.length > 0 || mentionsAnyTime(s.raw), OFFER_VERB.test(s.n))) return { kind: "reschedule_claim", evidence: s.raw.slice(0, EVIDENCE_MAX) };
  }

  // 1. Horário inventado em frase DE AGENDA.
  for (const s of live) {
    if (s.skip || s.mentions.length === 0) continue;
    const hits = hitsOf(s);
    const agenda = isAgendaSentence(s, hits) || messageClaim;
    if (!agenda) continue;
    if (s.mentions.some((m) => classify(m, st, today) === "inventado")) return { kind: "time_not_offered", evidence: s.raw.slice(0, EVIDENCE_MAX) };
  }

  // 2. Por frase: fechamento (léxico), lista de permissão para horário só ofertado e para pedido pendente.
  for (const s of live) {
    if (s.skip) continue;
    if (GENERIC_PLURAL.test(s.n)) continue;
    const evidence = s.raw.slice(0, EVIDENCE_MAX);
    const hits = hitsOf(s);
    // Hora SEM dia em frase que não é de agenda ("Chego na clínica às nove") não é horário de atendimento.
    const agendaS = isAgendaSentence(s, hits);
    const own = s.mentions.filter((m) => m.day !== undefined || agendaS).map((m) => classify(m, st, today));
    const definitive = (hs: Hit[]) => hs.some((h) => h.level === "strong") || (hs.some((h) => h.level === "closer") && !pendingQualified);

    if (hits.length > 0 && hits.some((h) => h.domain) && own.includes("inventado")) return { kind: "time_not_offered", evidence };
    if (hits.length > 0) {
      const matches = own.length > 0 ? own : messageMatches;
      if (matches.length > 0) {
        if (matches.includes("oferta")) return { kind: "claim_without_booking", evidence };
        if (matches.includes("pendente") && (definitive(hits) || !pendingQualified)) return { kind: "confirmed_but_pending", evidence };
      } else if (!bookedScheduled) {
        // Fechamento SEM horário citado.
        if (bookedPending || (scheduledExisting.length === 0 && pendingExisting)) {
          if (definitive(hits) || !pendingQualified) return { kind: "confirmed_but_pending", evidence };
        } else if (scheduledExisting.length !== 1) {
          return { kind: "claim_without_booking", evidence };
        }
      }
    }

    // Lista de permissão por tipo de horário citado na frase.
    if (own.includes("oferta")) {
      const allowed =
        s.question ||
        lastIsRealQuestion || // "Para sexta, nove da manhã. Qual prefere?": a oferta é a pergunta
        OFFER_VERB.test(s.n) ||
        OFFER_HEDGE.test(s.n) ||
        isBareTimeSentence(s.n) ||
        endsWithConfirmQuestion;
      if (!allowed) return { kind: "claim_without_booking", evidence };
    }
    if (own.includes("pendente")) {
      const allowed = s.question || PENDING_OK.test(s.n) || OFFER_HEDGE.test(s.n) || isBareTimeSentence(s.n);
      if (!allowed) return { kind: "confirmed_but_pending", evidence };
    }
  }
  return null;
}

/** Instrução da nova tentativa quando a rodada foi descartada por `kind` (o texto nunca vai ao cliente). */
export function claimNudge(kind: ClaimViolation["kind"]): string {
  switch (kind) {
    case "claim_without_booking":
      return "Sua resposta anterior foi DESCARTADA: ela afirmava um horário marcado, confirmado, reservado ou registrado, mas nada foi registrado para esse horário. Se o cliente já escolheu um horário que você ofereceu, use bookOfferedTime (sozinha, numa rodada própria); senão ofereça horários com findAvailableTimes, ou repita o horário e PERGUNTE se pode registrar. Não afirme marcação sem o resultado da ferramenta.";
    case "confirmed_but_pending":
      return 'Sua resposta anterior foi DESCARTADA: ela dizia "confirmado/marcado/garantido/aprovado", mas o horário só foi REGISTRADO e aguarda a confirmação da equipe. Use a frase canônica do resultado da ferramenta: pedido registrado, aguardando a confirmação da equipe.';
    case "reschedule_claim":
      return "Sua resposta anterior foi DESCARTADA: ela afirmava que um horário foi REMARCADO, trocado ou CANCELADO, e você não faz isso. Se o cliente quer remarcar ou cancelar, diga que a equipe cuida e use requestHandoff; não afirme mudança nenhuma.";
    case "time_not_offered":
      return "Sua resposta anterior foi DESCARTADA: ela citava um dia e hora que o sistema não devolveu. Cite somente os horários retornados por findAvailableTimes (ou listados em ofertas_vigentes / horarios_do_cliente), ou consulte de novo.";
  }
}

/** Texto FIXO enviado quando o guard barra duas vezes: nunca falha o turno nem deixa o cliente sem resposta. */
export const SCHED_SAFE_TEXT = "Vou confirmar os horários com a equipe e já te retorno.";
