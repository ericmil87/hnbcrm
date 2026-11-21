/**
 * Agenda v2 (D1) — regra do output guard: a resposta da IA ao cliente não pode AFIRMAR um horário "marcado",
 * "confirmado", "agendado" ou "reservado" sem que o servidor tenha de fato registrado isso (plano §3.6).
 *
 * PURO (sem `ctx`, sem relógio). É a rede de proteção do que o modelo diz; a verdade vem do estado:
 *  - `bookedThisTurn`: resultado de `bookOfferedTime` NESTE turno (`pending` = pedido registrado, aguarda a equipe;
 *    `scheduled` = marcado de fato);
 *  - `contactHas`: agendamentos futuros do contato (lidos antes do turno);
 *  - `offeredLabels`: horários que o servidor devolveu neste turno (busca ou reserva) e os já marcados do contato.
 *
 * Três violações:
 *  - `claim_without_booking`: afirma marcação, e nem neste turno nem antes houve agendamento;
 *  - `confirmed_but_pending`: diz "confirmado/marcado" quando só existe pedido aguardando a equipe;
 *  - `time_not_offered`: cita dia + hora como disponível ou marcado e esse horário nunca foi devolvido pelo servidor.
 *
 * Falso positivo custa caro (a rodada é descartada e refeita), então a regra só olha frases AFIRMATIVAS: perguntas,
 * ofertas de horário, condicionais ("se der", "assim que a equipe confirmar"), negações, promessa futura ("vou
 * marcar"), citação do cliente ("você pediu…", texto entre aspas) e "confirmo o recebimento do comprovante" ficam
 * de fora. Detalhe e lista de casos: `schedClaimGuard.test.ts`.
 */

export type ClaimState = {
  bookedThisTurn: "none" | "pending" | "scheduled";
  contactHas: "none" | "pending_only" | "scheduled";
  offeredLabels: string[];
};
export type ClaimViolation = {
  kind: "claim_without_booking" | "confirmed_but_pending" | "time_not_offered";
  /** Trecho da frase (≤ 80 caracteres) para log; nunca o texto inteiro. */
  evidence: string;
};

const EVIDENCE_MAX = 80;

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
// Marcas de horário
// ---------------------------------------------------------------------------

const HOUR_RES: RegExp[] = [
  /\b(\d{1,2})\s*(?:h|hs|hrs?|horas?)\s*(\d{2})?\b/g,
  /\b(\d{1,2}):(\d{2})\b/g,
  /\bas\s+(\d{1,2})(?!\s*(?:pessoas?|dias?|vezes|anos?|min|reais|%|\/))\b/g,
];
const WEEKDAY_FULL: Array<[RegExp, number]> = [
  [/\bdomingo\b/, 0],
  [/\bsegunda(?:-feira)?\b/, 1],
  [/\bterca(?:-feira)?\b/, 2],
  [/\bquarta(?:-feira)?\b/, 3],
  [/\bquinta(?:-feira)?\b/, 4],
  [/\bsexta(?:-feira)?\b/, 5],
  [/\bsabado\b/, 6],
];
/** Rótulos do servidor também usam a forma curta ("qui, 27/11/2026"). */
const WEEKDAY_SHORT: Array<[RegExp, number]> = [
  [/\bdom\b/, 0],
  [/\bseg\b/, 1],
  [/\bter\b/, 2],
  [/\bqua\b/, 3],
  [/\bqui\b/, 4],
  [/\bsex\b/, 5],
  [/\bsab\b/, 6],
];
const DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g;
const RELATIVE_DAY_RE = /\b(hoje|amanha|depois de amanha)\b/;

const pad2 = (n: number | string) => String(n).padStart(2, "0");

function hoursIn(n: string): string[] {
  const out = new Set<string>();
  for (const re of HOUR_RES) {
    re.lastIndex = 0;
    for (const m of n.matchAll(re)) {
      const h = Number(m[1]);
      const min = m[2] ? Number(m[2]) : 0;
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) out.add(`${pad2(h)}:${pad2(min)}`);
    }
  }
  return [...out];
}

function datesIn(n: string): string[] {
  const out = new Set<string>();
  DATE_RE.lastIndex = 0;
  for (const m of n.matchAll(DATE_RE)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) out.add(`${pad2(d)}/${pad2(mo)}`);
  }
  return [...out];
}

function weekdaysIn(n: string, table: Array<[RegExp, number]>): number[] {
  return table.filter(([re]) => re.test(n)).map(([, i]) => i);
}

function hasDayMark(n: string): boolean {
  return datesIn(n).length > 0 || weekdaysIn(n, WEEKDAY_FULL).length > 0 || RELATIVE_DAY_RE.test(n);
}
function hasHourMark(n: string): boolean {
  return hoursIn(n).length > 0 || /\bmeio[- ]dia\b/.test(n);
}
const hasTimeMark = (n: string) => hasHourMark(n) || hasDayMark(n);

// ---------------------------------------------------------------------------
// Verbos de afirmação
// ---------------------------------------------------------------------------

/** Afirmações de marcação (formas do próprio domínio: dispensam marca de horário). */
const BOOKING_STRONG = /\b(?:marcad[oa]s?(?!\s+como\b)|agendad[oa]s?|marquei|agendei|marcamos|agendamos)\b/g;
/** Confirmação/reserva: só valem como afirmação de horário junto de marca de dia ou hora. */
const CONFIRM_STRONG = /\b(?:confirmad[oa]s?|confirmei|confirm(?:o|amos)\s+(?:(?:o|a|os|as|seu|sua|seus|suas)\s+)*(?:horario|agendamento|consulta|sessao|atendimento|reserva|marcacao|visita)s?)\b/g;
const RESERVE_SOFT = /\b(?:reservad[oa]s?|reservei|reservamos|ficou para|fica para|te espero|te aguardo|te aguardamos|nos vemos)\b/g;

/** Antes do verbo, dentro da mesma oração: negação, condição, pergunta, promessa futura, desejo. */
const HEDGE_BEFORE =
  /\b(?:nao|nem|nunca|ainda nao|sem|vou|vamos|vai|posso|podemos|pode|preciso|precisa|quero|quer|queria|queira|gostaria|deseja|para|pra|assim que|quando|se|caso|ate que|ate|antes de|depois que|apos|talvez|como|sera|seria|estara|so)\b/;
/** Condição que abre a frase vale até o fim dela, mesmo depois de vírgula: "Se der certo, fica marcado". */
const CONDITION_OPENER = /\b(?:se|caso|assim que|quando|ate que|depois que|desde que)\b/;
/** Frases que narram o que o CLIENTE disse (citação) ou pedem dado: nunca são afirmação. */
const CUSTOMER_CITATION = /^(?:voce|vc|o senhor|a senhora)\s+(?:disse|falou|pediu|mencionou|escreveu|quer|queria|informou|perguntou)\b/;
/** Para `time_not_offered`: a frase oferece, indica ou marca um horário. */
const OFFERING_CUE = /\b(?:tenho|temos|disponivel|disponiveis|vaga|vagas|livre|livres|opcao|opcoes|encaixo|consigo|posso (?:te )?(?:oferecer|marcar)|horario)\b/;
const UNAVAILABLE_CUE = /\b(?:nao tenho|nao temos|nao ha|indisponivel|indisponiveis|ocupad[oa]s?|lotad[oa]s?|sem vaga|sem horario|nao consigo|nao da|ja passou)\b/;
const PENDING_QUALIFIER = /\b(?:aguard\w*|pendente|pedido|solicit\w*|registrad[oa]|equipe)\b/;

type Claim = { kind: "strong" | "confirm" | "soft"; index: number };

function claimsIn(n: string): Claim[] {
  const out: Claim[] = [];
  const scan = (re: RegExp, kind: Claim["kind"]) => {
    re.lastIndex = 0;
    for (const m of n.matchAll(re)) {
      if (!isHedged(n, m.index ?? 0)) out.push({ kind, index: m.index ?? 0 });
    }
  };
  scan(BOOKING_STRONG, "strong");
  scan(CONFIRM_STRONG, "confirm");
  scan(RESERVE_SOFT, "soft");
  return out;
}

/** Oração que antecede o verbo (até a última vírgula/ponto e vírgula/dois-pontos), últimas ~6 palavras. */
function isHedged(sentence: string, at: number): boolean {
  const before = sentence.slice(0, at);
  if (CONDITION_OPENER.test(before)) return true;
  const clause = before.split(/[,;:()—]/).pop() ?? "";
  const words = clause.trim().split(/\s+/).slice(-6).join(" ");
  return HEDGE_BEFORE.test(words);
}

// ---------------------------------------------------------------------------
// Horários oferecidos (rótulos do servidor)
// ---------------------------------------------------------------------------

type OfferedKey = { hhmm: string[]; dates: string[]; weekdays: number[] };

function parseOffered(label: string): OfferedKey {
  const n = norm(label);
  return {
    hhmm: hoursIn(n),
    dates: datesIn(n),
    weekdays: [...new Set([...weekdaysIn(n, WEEKDAY_FULL), ...weekdaysIn(n, WEEKDAY_SHORT)])],
  };
}

function isOffered(sentenceN: string, offered: OfferedKey[]): boolean {
  const hours = hoursIn(sentenceN);
  const dates = datesIn(sentenceN);
  const days = weekdaysIn(sentenceN, WEEKDAY_FULL);
  const relative = RELATIVE_DAY_RE.test(sentenceN);
  if (hours.length === 0) return true;
  return hours.every((h) =>
    offered.some((o) => {
      if (!o.hhmm.includes(h)) return false;
      if (dates.length === 0 && days.length === 0) return true;
      if (dates.some((d) => o.dates.includes(d))) return true;
      if (days.some((d) => o.weekdays.includes(d))) return true;
      // Sem data nem dia da semana cruzáveis: "hoje/amanhã" não dá para conferir sem relógio; confia no horário.
      return relative && dates.length === 0 && days.length === 0;
    })
  );
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

export function detectUnbackedBookingClaim(text: string, ctx: ClaimState): ClaimViolation | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const sentences = sentencesOf(text);
  const whole = norm(sentences.join(" "));
  const textHasTimeMark = hasTimeMark(whole);
  const effective: "none" | "pending" | "scheduled" =
    ctx.bookedThisTurn !== "none"
      ? ctx.bookedThisTurn
      : ctx.contactHas === "scheduled"
        ? "scheduled"
        : ctx.contactHas === "pending_only"
          ? "pending"
          : "none";
  const offered = ctx.offeredLabels.map(parseOffered);
  const pendingQualified = PENDING_QUALIFIER.test(whole);

  const assertive = sentences.filter((raw) => !/\?\s*$/.test(raw) && !CUSTOMER_CITATION.test(norm(raw)));
  // Uma afirmação em qualquer frase ("Marcado!") vale para o dia e hora citados nas outras ("Quinta, 26/11, às 15h.").
  const messageClaims = assertive.some((raw) => claimsIn(norm(raw)).some((c) => c.kind === "strong" || textHasTimeMark));

  for (const raw of assertive) {
    const n = norm(raw);

    const claims = claimsIn(n).filter((c) => c.kind === "strong" || textHasTimeMark);
    const evidence = raw.slice(0, EVIDENCE_MAX);
    if (claims.length > 0) {
      if (effective === "none") return { kind: "claim_without_booking", evidence };
      if (effective === "pending") {
        const hard = claims.some((c) => c.kind === "strong" || c.kind === "confirm");
        if (hard) return { kind: "confirmed_but_pending", evidence };
        if (!pendingQualified) return { kind: "confirmed_but_pending", evidence };
      }
    }

    // Dia + hora citados como disponíveis ou marcados e que o servidor nunca devolveu.
    if (hasDayMark(n) && hoursIn(n).length > 0 && !UNAVAILABLE_CUE.test(n)) {
      const asserting = messageClaims || OFFERING_CUE.test(n);
      if (asserting && !isOffered(n, offered)) return { kind: "time_not_offered", evidence };
    }
  }
  return null;
}

/** Instrução da nova tentativa quando a rodada foi descartada por `kind` (o texto nunca vai ao cliente). */
export function claimNudge(kind: ClaimViolation["kind"]): string {
  switch (kind) {
    case "claim_without_booking":
      return "Sua resposta anterior foi DESCARTADA: ela afirmava um horário marcado, confirmado ou reservado, mas nada foi registrado neste atendimento. Se o cliente já escolheu um horário que você ofereceu, use bookOfferedTime (sozinha, numa rodada própria); senão ofereça horários com findAvailableTimes ou diga que a equipe confirma. Não afirme marcação sem o resultado da ferramenta.";
    case "confirmed_but_pending":
      return 'Sua resposta anterior foi DESCARTADA: ela dizia "confirmado/marcado", mas o horário só foi REGISTRADO e aguarda a confirmação da equipe. Diga apenas que o pedido foi registrado e que a equipe confirma em breve.';
    case "time_not_offered":
      return "Sua resposta anterior foi DESCARTADA: ela citava um dia e hora que o sistema não devolveu. Cite somente os horários retornados por findAvailableTimes neste atendimento (ou consulte de novo).";
  }
}
