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
 * Regras:
 *  1. Horário citado que não está em E ∪ R ∪ O = inventado → `time_not_offered` (vale também em pergunta);
 *  2. horário só em O (ofertado, não reservado): a resposta só pode OFERECER ou PERGUNTAR; qualquer marcador
 *     assertivo de fechamento (léxico amplo) → `claim_without_booking`;
 *  3. horário em R/E aguardando a equipe: só pode dizer que o pedido foi REGISTRADO e aguarda confirmação; fechamento
 *     definitivo → `confirmed_but_pending`;
 *  4. horário em R/E marcado: livre;
 *  5. fechamento SEM horário ("Prontinho! Seu horário está confirmado") só passa com R marcado nesta rodada ou com
 *     exatamente UM agendamento marcado em E; com pendente → `confirmed_but_pending`; sem nada → `claim_without_booking`.
 *
 * NÃO barra: pergunta, citação do cliente ("você pediu…", texto entre aspas), negação, condicional ("assim que a
 * equipe confirmar"), promessa futura, horário de funcionamento, indisponibilidade ("quinta às 17h está ocupado"),
 * pagamento "confirmado", "horários marcados no site". Corpus de casos: `schedClaimGuard.test.ts`.
 */
import { extractDateTimeMentions } from "./schedConfirmParser";
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
};
export type ClaimViolation = {
  kind: "claim_without_booking" | "confirmed_but_pending" | "time_not_offered";
  /** Trecho da frase (≤ 80 caracteres) para log; nunca o texto inteiro. */
  evidence: string;
};

const EVIDENCE_MAX = 80;

export function knownTime(startTime: number, tz: string): KnownTime {
  return { localDate: localDateOf(startTime, tz), timeMin: minutesOfDay(startTime, tz) };
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
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
type Marker = { re: RegExp; level: Level; needsMention?: boolean; readback?: boolean };

const DAYS = "segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje";
/**
 * `strong`: fecha o horário (marcado, confirmado, "te espero"…). `closer`: palavra de fechamento ("prontinho",
 * "combinado") que só conta com horário ou assunto de agenda na mensagem. `soft`: registro/reserva ("reservei",
 * "pedido registrado"), aceitável só como pedido AGUARDANDO a equipe. `needsMention`: só conta com horário citado.
 * `readback`: pode aparecer no read-back que as instruções pedem ("anotado: segunda às 08:00. Posso registrar?").
 */
const MARKERS: Marker[] = [
  { re: /\bmarcad(?:[oa]s?|inh[oa]s?|issim[oa]s?)\b(?!\s+como\b)/g, level: "strong" },
  { re: /\bagendad(?:[oa]s?|inh[oa]s?|issim[oa]s?)\b/g, level: "strong" },
  { re: /\bconfirmad(?:[oa]s?|inh[oa]s?|issim[oa]s?)\b/g, level: "strong" },
  { re: /\bgarantid[oa]s?\b|\bgaranti(?:i|mos)\b/g, level: "strong" },
  { re: /\b(?:marquei|agendei|marcamos|agendamos|confirmei|encaixei|separei|coloquei|incluí|inclui|adicionei)\b/g, level: "strong" },
  { re: /\bconfirm(?:o|amos)\s+(?:(?:o|a|os|as|seu|sua|seus|suas)\s+)*(?:horario|agendamento|consulta|sessao|atendimento|reserva|marcacao|visita)s?\b/g, level: "strong" },
  { re: /\b(?:fica|ficou)\s+(?:para|pra)\b/g, level: "strong" },
  { re: /\bfica\s+(?:entao\s+)?(?:na\s+|no\s+|a\s+)?(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje)\b/g, level: "strong", needsMention: true },
  { re: /\b(?:esta|estao|ficou|ficaram)\s+(?:tudo\s+)?certo\b|\btudo certo\b/g, level: "strong" },
  { re: /\bpode vir\b/g, level: "strong" },
  { re: /\bte (?:espero|vejo|aguardo|aguardamos)\b|\bnos vemos\b|\bate (?:la|logo|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/g, level: "strong" },
  { re: /✅|✔/g, level: "strong" },
  { re: /\bja esta na agenda\b|\bna agenda (?:de|para|pra|do dia)\b/g, level: "strong" },
  { re: /\bsua (?:consulta|sessao|vaga|reserva|visita|avaliacao) e\b|\bvoce sera atendid[oa]\b/g, level: "strong" },
  { re: /\be (?:seu|sua)\b/g, level: "strong", needsMention: true },
  { re: /\bprontinho\b|\bpronto\b|\bfeito(?=\s*[!,:;]|\s*$)|\bcertinho\b/g, level: "closer", readback: true },
  { re: /\bcombinad[oa]\b|\bfechad[oa]\b|\banotad[oa]\b|\banotei\b/g, level: "closer", readback: true },
  { re: /\breservad(?:[oa]s?|inh[oa]s?)\b|\breservei\b|\breservamos\b/g, level: "soft" },
  { re: /\bregistrad[oa]s?\b|\bregistrei\b|\bregistramos\b/g, level: "soft" },
];

/** Antes do marcador, na mesma oração: negação, condição, pergunta, promessa futura, desejo, modal. */
const HEDGE_BEFORE =
  /\b(?:nao|nem|nunca|ainda nao|sem|vou|vamos|vai|posso|podemos|pode|podem|deve|devem|preciso|precisa|quero|quer|queria|queira|gostaria|deseja|para (?:deixar|ficar|ser|estar|ver|saber)|pra (?:deixar|ficar|ser|estar|ver|saber)|assim que|quando|se|caso|ate que|antes de|depois que|apos|talvez|como|sera|seria|estara|so|nenhum|nenhuma)\b/;
/** Condição que abre a frase vale até o fim dela, mesmo depois de vírgula: "Se der certo, fica marcado". */
const CONDITION_OPENER = /\b(?:se|caso|assim que|quando|ate que|depois que|desde que)\b/;
/** Frases que narram o que o CLIENTE disse: nunca são afirmação nem horário inventado. */
const CUSTOMER_CITATION = /^(?:voce|vc|o senhor|a senhora)\s+(?:disse|falou|pediu|mencionou|escreveu|quer|queria|informou|perguntou|prefere|escolheu)\b/;
const UNAVAILABLE_CUE = /\b(?:nao tenho|nao temos|nao ha|indisponivel|indisponiveis|ocupad[oa]s?|lotad[oa]s?|sem vaga|sem horario|nao consigo|nao da|ja passou|nao esta livre|nao esta disponivel)\b/;
const BUSINESS_CUE = /\b(?:fecha|fechamos|fechado ate|abre|abrimos|aberto|abertos|aberta|funciona|funcionamos|funcionamento|atendemos|expediente|horario de atendimento)\b/;
const PAYMENT_CUE = /\b(?:pagamento|pix|comprovante|boleto|cartao|transferencia|compra|cadastro|recebimento|fatura|cobranca|valor)\b/;
const SCHEDULE_NOUN = /\b(?:horario|horarios|consulta|sessao|atendimento|vaga|agendamento|reserva|marcacao|avaliacao|visita)\b/;
/** "os horários marcados no site podem estar desatualizados": o plural genérico não é afirmação sobre ESTE cliente. */
const GENERIC_PLURAL = /\b(?:horarios|agendamentos|consultas|sessoes|atendimentos|vagas)\s+(?:ja\s+)?(?:marcad|agendad|reservad|confirmad)/;
const PENDING_QUALIFIER = /\b(?:aguard\w*|pendente|pedido|solicit\w*|equipe)\b/;
/** Última frase pede a confirmação do cliente: a anterior é um read-back, não um fechamento. */
const CONFIRM_QUESTION = /\b(?:posso (?:registrar|reservar|marcar|seguir|confirmar|anotar|fechar|prosseguir)|podemos (?:registrar|reservar|marcar|seguir|fechar)|confirma\b|esta certo|certo\b|correto\b|pode ser\b|ok\b|fechamos|e isso|e esse|e essa|quer que eu (?:registre|reserve|marque|anote)|devo (?:registrar|reservar|marcar|seguir))/;

/** "…, tá?", "…, certo?": pergunta-eco; o que vem antes continua sendo afirmação. */
const TAG_QUESTION = /,\s*(?:ta|tá|ne|né|certo|ok|combinado|beleza|tudo bem)\s*\?\s*$/i;

type Hit = { level: Level; needsMention: boolean; readback: boolean };

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
      const near = (n.slice(0, found.index ?? 0).split(/[,;:()\u2014]/).pop() ?? "").trim().split(/\s+/).slice(-5).join(" ");
      if (PAYMENT_CUE.test(near)) continue;
      out.push({ level: m.level, needsMention: m.needsMention === true, readback: m.readback === true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Horários citados × horários conhecidos
// ---------------------------------------------------------------------------

type Mention = { localDate?: string; timeMin?: number };
type Match = "inventado" | "oferta" | "pendente" | "marcado";

const same = (k: KnownTime, m: { localDate?: string; timeMin: number }) =>
  k.timeMin === m.timeMin && (m.localDate === undefined || k.localDate === m.localDate);

/** Prioridade: reserva desta rodada > agendamento existente > oferta. */
function classify(m: { localDate?: string; timeMin: number }, st: ClaimState): Match {
  const r = st.booked.filter((k) => same(k, m));
  const e = st.existing.filter((k) => same(k, m));
  const hit = r.length > 0 ? r : e;
  if (hit.length > 0) return hit.some((k) => k.status === "scheduled") ? "marcado" : "pendente";
  if (st.offered.some((k) => same(k, m))) return "oferta";
  return "inventado";
}

/**
 * O extrator foi feito para mensagens do HUMANO/cliente: "tenho", "consigo", "posso" + verbo de agenda viram "ocupado" ou
 * "intenção" e derrubam o trecho. Na boca da IA são ofertas ("tenho quinta às 15h"); troca-se o verbo por um neutro.
 */
const OFFER_VERBS = /\b(?:tenho|temos|consigo|conseguimos|posso|podemos|encaixo|encaixamos)\b/gi;

/**
 * Texto da IA preparado para o extrator: verbos de oferta neutros e SEM vírgula entre dia/data e a hora ("quinta-feira,
 * 26/11, às 10:00" → "quinta-feira 26/11 às 10:00"; com a vírgula o extrator separa em "dia" e "hora solta").
 */
export function neutralizeForMentions(sentence: string): string {
  return sentence
    .replace(OFFER_VERBS, "há vaga")
    .replace(/(\d{4}|\d{1,2}\/\d{1,2}|feira|s[aá]bado|domingo|segunda|ter[cç]a|quarta|quinta|sexta),\s+(?=\d|[àa]s\b)/gi, "$1 ");
}

function mentionsOf(sentence: string, st: ClaimState): Mention[] {
  try {
    return extractDateTimeMentions(neutralizeForMentions(sentence), { now: st.now, tz: st.tz });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export function detectUnbackedBookingClaim(text: string, st: ClaimState): ClaimViolation | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const sentences = sentencesOf(text);
  const isQuestion = (raw: string) => /\?\s*$/.test(raw) && !TAG_QUESTION.test(raw);
  const asserted = sentences.filter((raw) => !isQuestion(raw) && !CUSTOMER_CITATION.test(norm(raw)));
  const whole = norm(sentences.join(" "));
  const last = sentences[sentences.length - 1] ?? "";
  const endsWithConfirmQuestion = /\?\s*$/.test(last) && CONFIRM_QUESTION.test(norm(last));
  const pendingQualified = PENDING_QUALIFIER.test(whole);
  const messageNoun = SCHEDULE_NOUN.test(whole);

  // Menções com hora de cada frase (o extrator já descarta negação, faixa "das X às Y", passado e limite).
  const perSentence = sentences.map((raw) => {
    const n = norm(raw);
    const skip = CUSTOMER_CITATION.test(n) || UNAVAILABLE_CUE.test(n) || BUSINESS_CUE.test(n);
    const body = TAG_QUESTION.test(raw) ? raw.replace(TAG_QUESTION, ".") : raw;
    return { raw, n: norm(body), skip, mentions: skip ? [] : mentionsOf(body, st), question: isQuestion(raw) };
  });
  const messageHasMention = perSentence.some((s) => s.mentions.length > 0);

  // 1. Horário inventado: dia+hora ou hora solta que o servidor nunca devolveu.
  for (const s of perSentence) {
    for (const m of s.mentions) {
      if (m.timeMin === undefined) continue;
      if (classify({ localDate: m.localDate, timeMin: m.timeMin }, st) === "inventado") {
        return { kind: "time_not_offered", evidence: s.raw.slice(0, EVIDENCE_MAX) };
      }
    }
  }

  // Menções da mensagem inteira (para o marcador de uma frase que cita o horário em outra).
  const messageMatches = perSentence.flatMap((s) =>
    s.mentions.filter((m) => m.timeMin !== undefined).map((m) => classify({ localDate: m.localDate, timeMin: m.timeMin! }, st))
  );

  // E sem horário citado: o agendamento marcado do contato é único?
  const scheduledExisting = st.existing.filter((k) => k.status === "scheduled");
  const bookedScheduled = st.booked.some((k) => k.status === "scheduled");
  const bookedPending = st.booked.some((k) => k.status === "pending");
  const pendingExisting = st.existing.some((k) => k.status === "pending");

  for (const s of perSentence) {
    if (s.question) continue;
    if (!asserted.includes(s.raw)) continue;
    if (GENERIC_PLURAL.test(s.n)) continue;
    if (UNAVAILABLE_CUE.test(s.n)) continue;
    const hits = markersIn(s.n).filter((h) => {
      if (h.level === "closer" && !(messageHasMention || messageNoun)) return false;
      if (h.needsMention && !messageHasMention) return false;
      if (h.readback && endsWithConfirmQuestion) return false;
      return true;
    });
    if (hits.length === 0) continue;
    const evidence = s.raw.slice(0, EVIDENCE_MAX);

    const own = s.mentions.filter((m) => m.timeMin !== undefined).map((m) => classify({ localDate: m.localDate, timeMin: m.timeMin! }, st));
    const matches = own.length > 0 ? own : messageMatches;
    if (matches.length > 0) {
      if (matches.includes("oferta")) return { kind: "claim_without_booking", evidence };
      if (matches.includes("pendente")) {
        // `strong` aqui = strong ou closer; closer com a mensagem já qualificada ("a equipe confirma") passa.
        const definitive = hits.some((h) => h.level === "strong") || (hits.some((h) => h.level === "closer") && !pendingQualified);
        if (definitive || !pendingQualified) return { kind: "confirmed_but_pending", evidence };
      }
      continue; // marcado
    }

    // Fechamento SEM horário citado.
    if (bookedScheduled) continue;
    if (bookedPending) {
      const definitive = hits.some((h) => h.level === "strong") || (hits.some((h) => h.level === "closer") && !pendingQualified);
      if (definitive || !pendingQualified) return { kind: "confirmed_but_pending", evidence };
      continue;
    }
    if (scheduledExisting.length === 1) continue;
    if (scheduledExisting.length === 0 && pendingExisting) {
      const definitive = hits.some((h) => h.level === "strong") || (hits.some((h) => h.level === "closer") && !pendingQualified);
      if (definitive || !pendingQualified) return { kind: "confirmed_but_pending", evidence };
      continue;
    }
    return { kind: "claim_without_booking", evidence };
  }
  return null;
}

/** Instrução da nova tentativa quando a rodada foi descartada por `kind` (o texto nunca vai ao cliente). */
export function claimNudge(kind: ClaimViolation["kind"]): string {
  switch (kind) {
    case "claim_without_booking":
      return "Sua resposta anterior foi DESCARTADA: ela afirmava um horário marcado, confirmado, reservado ou registrado, mas nada foi registrado para esse horário. Se o cliente já escolheu um horário que você ofereceu, use bookOfferedTime (sozinha, numa rodada própria); senão ofereça horários com findAvailableTimes, ou repita o horário e PERGUNTE se pode registrar. Não afirme marcação sem o resultado da ferramenta.";
    case "confirmed_but_pending":
      return 'Sua resposta anterior foi DESCARTADA: ela dizia "confirmado/marcado/garantido", mas o horário só foi REGISTRADO e aguarda a confirmação da equipe. Use a frase canônica do resultado da ferramenta: pedido registrado, aguardando a confirmação da equipe.';
    case "time_not_offered":
      return "Sua resposta anterior foi DESCARTADA: ela citava um dia e hora que o sistema não devolveu. Cite somente os horários retornados por findAvailableTimes (ou listados em ofertas_vigentes / horarios_do_cliente), ou consulte de novo.";
  }
}
