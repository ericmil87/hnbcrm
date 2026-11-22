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

export type KnownTime = {
  localDate: string;
  timeMin: number;
  /**
   * Recursos (chaves de `resourceKey`) que este horário TEM de verdade e que a IA pode citar: a oferta nomeada pelo servidor
   * (profissional pedido e honrado) ou os recursos do agendamento já existente. Ausente = nenhum nome pode ser ligado ao horário.
   */
  resources?: string[];
};
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
  /** Um repasse para a equipe foi criado neste turno ou vai na MESMA rodada (`requestHandoff`): "já passei para a equipe" é verdade. */
  handoff?: boolean;
  /** Horas do dia (minutos) que o CONHECIMENTO da org cita (turmas fixas, funcionamento): descrever uma delas não é horário inventado. */
  knowledgeTimes?: number[];
  /** Nomes (qualquer forma) dos profissionais e salas ATIVOS da org: citar um com um horário só vale se a oferta o nomeou. */
  resourceNames?: string[];
};
export type ClaimViolation = {
  kind: "claim_without_booking" | "confirmed_but_pending" | "time_not_offered" | "reschedule_claim" | "resource_not_offered" | "handoff_claim";
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
type Marker = {
  re: RegExp;
  level: Level;
  needsMention?: boolean;
  readback?: boolean;
  domain?: boolean;
  /** Não conta quando o trecho que vem ANTES (as últimas palavras da oração) casa com isto: "com hora marcada", "registro certinho". */
  notAfter?: RegExp;
  /** `notAfter` só vale quando a frase NÃO cita dia/hora ("com hora marcada" é regra; "está com hora marcada para terça" é afirmação). */
  exemptOnlyWithoutTime?: boolean;
  /** Hedge ('vou', 'não') não desfaz: "Vou te esperar terça às 10h" e "Não esqueça: terça às 10h" CONFIRMAM o horário. */
  noHedge?: boolean;
};

/** "registro certinho", "quem confirma certinho": advérbio de um verbo de explicar/registrar, não "Tudo certinho!". */
const CERTINHO_ADVERB = /\b(?:registr\w*|confirm\w*|anot\w*|explic\w*|entend\w*|resolv\w*|ajud\w*|avis\w*|organiz\w*|encaminh\w*|passar|passo|ver|fazer|deixar)\b(?:\s+\w+){0,2}\s*$/;
/** "com hora marcada", "só com horário marcado": regra do negócio, não marcação deste cliente. */
const MARCADO_NOUN_PHRASE = /\b(?:com|por|sem|so com|apenas com|somente com)\s+(?:hora|horario|agendamento)s?\s*$/;

const MARKERS: Marker[] = [
  { re: /\bmarcad(?:[oa]|inh|issim)\w*\b(?!\s+como\b)/g, level: "strong", domain: true, notAfter: MARCADO_NOUN_PHRASE, exemptOnlyWithoutTime: true },
  { re: /\bagendad(?:[oa]|inh|issim)\w*\b/g, level: "strong", domain: true },
  { re: /\bconfirmad(?:[oa]|inh|issim)\w*\b/g, level: "strong" },
  { re: /\bgarantid\w*\b|\bgaranti(?:i|mos)\b/g, level: "strong", domain: true },
  { re: /\b(?:marquei|agendei|marcamos|agendamos|confirmei|encaixei|separei|coloquei|incluí|inclui|adicionei|segurei|bloqueei)\b/g, level: "strong", domain: true },
  { re: /\bja confirm(?:ou|aram|amos)\b|\bconfirm(?:ou|aram)\b|\baprovad[oa]s?\b|\baprov(?:ou|aram)\b/g, level: "strong" },
  { re: /\bconfirm(?:o|amos)\s+(?:(?:o|a|os|as|seu|sua|seus|suas)\s+)*(?:horario|agendamento|consulta|sessao|atendimento|reserva|marcacao|visita)s?\b/g, level: "strong" },
  { re: /\b(?:fica|ficou)\s+(?:para|pra)\b/g, level: "strong" },
  // "Então fica terça às 10h. Posso registrar?": leitura-eco que as instruções pedem; só vale com a pergunta no fim.
  { re: /\bfica\s+(?:entao\s+)?(?:na\s+|no\s+|a\s+)?(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje)\b/g, level: "strong", needsMention: true, readback: true },
  { re: /\b(?:esta|estao|ficou|ficaram)\s+(?:tudo\s+)?certo\b|\btudo certo\b/g, level: "strong" },
  { re: /\bpode vir\b(?!\s+(?:com|de|usando|vestindo|sem|trazendo|na hora|que|ate))|\b(?:fica|ficou|continua) (?:valendo|de pe)\b|\besta de pe\b|\b(?:fica|ficou) certo\b/g, level: "strong" },
  { re: /\batualizad[oa]\b(?=[^.!?]*\b(?:consulta|sessao|horario|agendamento)\b)|\binscrevi\b|\bconfirmacao feita\b|\bfeit[oa] o agendamento\b|\bagendamento (?:esta )?feito\b/g, level: "strong", domain: true },
  { re: /\bte (?:espero|esperamos|vejo|aguardo|aguardamos|atende|atendo|recebo|recebe|mando)\b|\bnos (?:vemos|falamos)\b/g, level: "strong", needsMention: true, domain: true },
  // Despedida: "Até lá!" depois de "pedido registrado, aguardando a equipe" é cortesia, não confirmação (closer: só barra sem o qualificador de pendente).
  { re: /\bate (?:la|logo|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b/g, level: "closer", needsMention: true, domain: true },
  // ✅ sozinho é marcador de lista ("✅ roupa confortável"): só pesa com horário ou assunto de pedido na frase (`aboutBooking`).
  { re: /✅|✔/g, level: "soft" },
  // "Seu horário é terça às dez", "sua consulta ficou para…": posse = afirmação (não é oferta só porque a frase diz "horário").
  { re: /\b(?:seu|sua)\s+(?:horario|consulta|sessao|vaga|aula|atendimento|avaliacao)\s+(?:e|eh|ficou|fica|sera)\b/g, level: "strong", needsMention: true, domain: true },
  { re: /\b(?:vou|vamos)\s+te\s+(?:esperar|aguardar|receber)\b|\bnao\s+(?:se\s+)?esqueca\b/g, level: "strong", needsMention: true, domain: true, noHedge: true },
  { re: /\bja esta na agenda\b|\bna agenda (?:de|para|pra|do dia)\b|\bna lista de\b/g, level: "strong", domain: true },
  { re: /\bsua (?:consulta|sessao|vaga|reserva|visita|avaliacao|presenca) (?:e|esta)\b|\bvoce sera atendid[oa]\b/g, level: "strong" },
  // "O horário é seu!" fecha a frase; "já que é sua primeira vez" não.
  { re: /\be (?:seu|sua)(?=\s*(?:[!.,;:]|$)|\s+(?:horario|vaga|consulta|sessao|atendimento|agendamento|reserva)\b)|\bja era\b/g, level: "strong", needsMention: true, domain: true },
  { re: /\bprontinho\b|\bpronto\b|\bfeito(?=\s*[!,:;]|\s*$)|\btudo pronto\b/g, level: "closer", readback: true },
  { re: /\bcertinho\b/g, level: "closer", readback: true, notAfter: CERTINHO_ADVERB },
  // "Anotei que você quer só com o Léo", "anotei sua preferência": anotar o que o cliente DISSE não é reservar horário.
  { re: /\bcombinad\w*\b|\bfechad[oa]\b|\banotad[oa]\b|\banotei\b(?!\s+(?:que\s+(?:voce|vc)\s+(?:quer|queria|prefere|so|pediu|precisa|gosta|disse|nao)\b|(?:sua|a|essa|seu|o|esse)\s+(?:preferencia|duvida|pergunta|recado|observacao|nome|numero|contato|email)\b))/g, level: "closer", readback: true },
  { re: /\breservad[oa]\w*\b|\breservei\b|\breservamos\b/g, level: "soft", domain: true },
  { re: /\bregistrad[oa]s?\b|\bregistrei\b|\bregistramos\b/g, level: "soft" },
  { re: /\bdeixei\b/g, level: "soft", needsMention: true },
];

/** Antes do marcador, na mesma oração: negação, condição, pergunta, promessa futura, desejo, modal. */
const HEDGE_BEFORE =
  /\b(?:nao|nem|nunca|ainda nao|sem|vou|vamos|vai|posso|podemos|pode|podem|deve|devem|preciso|precisa|quero|quer|queria|queira|gostaria|deseja|para (?:deixar|ficar|ser|estar|ver|saber)|pra (?:deixar|ficar|ser|estar|ver|saber)|assim que|quando|se|caso|ate que|antes de|depois que|apos|talvez|como|sera|seria|estara|so|nenhum|nenhuma)\b/;
/** "nada foi marcado", "quem já está marcado": o marcador é negado ou é objeto da pergunta, só quando vem logo depois. */
const HEDGE_RIGHT_BEFORE = /\b(?:nada\s+(?:(?:foi|esta|estava|ficou|ainda|ate agora)\s+)*|quem\s+(?:ja\s+)?(?:esta|estao|ficou|ficaram|foi)\s+|ninguem\s+(?:(?:esta|foi|ficou)\s+)?|que\s+(?:ja\s+)?(?:esta|estao|estava|estavam|foi|era)\s+)$/;
/** Condição que abre a frase vale até o fim dela, mesmo depois de vírgula: "Se der certo, fica marcado". */
const CONDITION_OPENER_AT_START = /^(?:e\s+)?(?:se|caso|assim que|quando|ate que|depois que|desde que)\b/;
/** Frases que narram o que o CLIENTE disse: nunca são afirmação nem horário inventado. */
const CUSTOMER_CITATION = /^\s*(?:voce|vc|o senhor|a senhora)\s+(?:disse|falou|pediu|mencionou|escreveu|quer|queria|informou|perguntou|prefere|escolheu|comentou|contou)\b|^\s*(?:que bom|otimo|legal|ainda bem|obrigad[oa])\s+que\s+(?:voce|vc)\s+\w+(?:\s+\w+){0,3}\s*$/;
/** "Marina, você quer…": o vocativo no começo não muda de quem a frase fala. */
const VOCATIVE = /^\s*[A-ZÀ-Ý][\p{L}'-]+(?: [A-ZÀ-Ý][\p{L}'-]+)?,\s*/u;
const UNAVAILABLE_CUE = /\b(?:nao tenho|nao temos|nao ha|indisponivel|indisponiveis|ocupad[oa]s?|lotad[oa]s?|sem vaga|sem horario|nao consigo|nao da|ja passou|nao esta livre|nao esta disponivel|preenchid[oa]s?|esgotad[oa]s?|cheio|cheia|nao estao mais|nao esta mais|ja foi tomad[oa]|ja foi preenchid[oa]|nao tem (?:mais )?(?:horario|horarios|vaga|vagas|disponivel|disponiveis|disponibilidade|como|esse horario|este horario))\b|\bnao tem\s*$/;
const BUSINESS_CUE = /\b(?:fecha|fecho|fechar|encerro|encerramos|fechamos|fechado ate|abre|abrimos|aberto|abertos|aberta|funciona|funcionamos|funcionamento|atendemos|atende as|atende de|atende so|atende apenas|atendemos so|atendemos apenas|atendimento (?:e|eh|funciona) (?:so|apenas|somente)|expediente|horario de atendimento|estacionamento)\b/;
/** Regra de funcionamento ("o último horário começa às 17h10", "tolerância de atraso"): descreve, não oferece; só vale sem afirmar vaga. */
const INFO_CUE = /\b(?:ultimo horario|primeiro horario|horario de entrada|toleranc\w*|atraso|chegar|chegada|chegue|antecedencia)\b/;
/** A frase AFIRMA disponibilidade ("tenho 18h", "está livre", "consigo"). */
const ASSERT_AVAIL = /\b(?:disponivel|disponiveis|livres?|sobrou|sobraram|restou|consigo|conseguimos|encaixo|encaixamos|tenho)\b|\b(?:temos|tem|ha)(?:\s+(?:ainda|tambem|mais|as|os|o|a|uma|um))*\s+(?:\d|horarios?|vagas?|opcao|opcoes)/;
/** "Vou ver se temos vaga nesse horário": o horário citado é o que será verificado, não uma oferta. */
const VERIFY_PROMISE = /\b(?:vou|vamos)\s+(?:ver|verificar|conferir|consultar|checar|olhar|confirmar)\b|\b(?:eles|elas|a equipe|nossa equipe|o time)\s+(?:vai\s+|vao\s+|ira\s+|irao\s+)?(?:ver|verifica\w*|confirma\w*|conferem|confere|ajusta\w*|checa\w*|olha\w*)\b|\bposso\s+(?:ver|verificar|conferir|consultar|checar|olhar)\b|\bdeixa eu\s+(?:ver|verificar|conferir|consultar)\b/;
/** Pergunta que pergunta o DIA ("qual dia você prefere", "prefere outro dia"): o horário que vem junto é o do pedido. */
const DAY_QUESTION = /\b(?:qual|que|outro)\s+dia\b|\bprefere\s+(?:outro\s+)?dia\b/;
/** A frase fala de remarcar/cancelar e de a equipe cuidar disso. */
const CHANGE_TOPIC = /\b(?:remarca\w*|reagend\w*|cancel\w*|troca\w*|ajust\w*|alteracao|alterar|mudanca|mudar)\b/;
const TEAM_WORD = /\b(?:equipe|time|eles|elas|atendente|colegas|pessoal)\b/;
/** Repasse para a equipe dito pela IA ("já passei seu pedido para eles", "avisei a equipe"): só vale com o repasse criado. */
const HANDOFF_PASS = /\b(?:passei|passou|passamos|transferi|transferimos|encaminhei|encaminhamos|repassei|repassamos|deixei|avisei|avisamos|informei|comuniquei)\b[^.!?,;]{0,70}?\b(?:para|pra|com)\s+(?:a\s+|o\s+)?(?:(?:nossa|nosso|minha)\s+)?(?:equipe|time|eles|elas|atendente|atendentes|colegas|pessoal|responsaveis?|humanos?|setor)\b|\b(?:avisei|avisamos|informei|comuniquei)\s+(?:a|o)\s+(?:nossa\s+)?(?:equipe|time)\b/;
/** "para quarta", "pra dia 25", "para as 9h": destino de uma mudança de horário. */
const MOVE_TARGET = /\b(?:para|pra)\s+(?:o\s+|a\s+|as\s+)?(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje|dia\s+\d|\d)/;
/** "A equipe cuida / resolve / responde": o que a equipe fará depois do repasse. */
const HANDOFF_TEAM_ACTS = /\b(?:equipe|eles|elas|time)\b[^.!?]{0,40}\b(?:cuid\w+|resolv\w+|respond\w+|retorn\w+|confirm\w+|avali\w+|vao|vai|ira|irao)\b/;
const PAYMENT_CUE = /\b(?:pagamento|pix|comprovante|boleto|cartao|transferencia|compra|cadastro|recebimento|fatura|cobranca|valor)\b/;
const SCHEDULE_NOUN = /\b(?:horario|horarios|consulta|consultas|sessao|sessoes|atendimento|vaga|vagas|agendamento|reserva|marcacao|avaliacao|visita|agenda)\b/;
/** "os horários marcados no site podem estar desatualizados": o plural genérico não é afirmação sobre ESTE cliente. */
const GENERIC_PLURAL = /\b(?:horarios|agendamentos|consultas|sessoes|atendimentos|vagas)\s+(?:ja\s+)?(?:marcad|agendad|reservad|confirmad)/;
/** Pedido AGUARDANDO a equipe: o que a frase pode dizer. */
const PENDING_OK = /\b(?:registrad[oa]s?|registrei|registramos|aguard\w+|pendente|pedido|solicit\w+|sera confirmad\w*|a equipe (?:vai|ira|ainda vai|confirma|confirmara|ira confirmar)|equipe confirm(?:a|ar|ara))\b/;
const PENDING_QUALIFIER = /\b(?:aguard\w*|pendente|pedido|solicit\w*|equipe)\b/;
/** Oferta ou pergunta: o que a frase pode dizer sobre um horário só OFERTADO. */
const POSSESSIVE_SLOT = /\b(?:seu|sua)\s+(?:horario|consulta|sessao|vaga|aula|atendimento|avaliacao)\s+(?:e|eh|ficou|fica|sera)\b/;
const OFFER_VERB = /\b(?:tenho|temos|ha|tem|consigo|conseguimos|encaixo|encaixamos|oferec\w+|disponivel|disponiveis|vagas?|opcao|opcoes|livres?|que tal|pode ser|prefere|qual (?:horario|dia|fica)|horarios?)\b|\b(?:posso|podemos)\s+(?:te\s+)?(?:oferecer|marcar|encaixar|reservar|agendar|registrar|anotar)\b/;
/** Hedge de oferta: promessa futura, desejo, condição, negação. */
const OFFER_HEDGE = /\b(?:vou|vamos|posso|podemos|gostaria|quer|prefere|se|caso|assim que|quando|nao|ainda nao|sem|talvez|depende|preciso|precisa)\b/;
/** Última frase pede a confirmação do cliente: a anterior é um read-back, não um fechamento. */
const CONFIRM_QUESTION = /\b(?:posso (?:registrar|reservar|marcar|seguir|confirmar|anotar|fechar|prosseguir)|podemos (?:registrar|reservar|marcar|seguir|fechar)|confirma\b|esta certo|certo\b|correto\b|pode ser\b|ok\b|fechamos|e isso|e esse|e essa|quer que eu (?:registre|reserve|marque|anote)|devo (?:registrar|reservar|marcar|seguir))/;
/** "…, tá?", "…, certo?": pergunta-eco; o que vem antes continua sendo afirmação. */
const TAG_QUESTION = /,\s*(?:ta|tá|ne|né|certo|ok|combinado|beleza|tudo bem|viu|fechou|fechado|blz|entendeu|pode ser)\s*\?\s*$/i;

type Hit = { level: Level; needsMention: boolean; readback: boolean; domain: boolean };

/** "Se der certo, fica marcado": a frase ABRE com a condição (no começo da oração, "se" não reflexivo) e o marcador está nela ou na oração seguinte. */
const REFLEXIVE_SE = /^se\s+(?:preocup|esqueca|apresse|incomod|sinta|lembre|atras|assust|canse|confund)/;
function conditionCovers(before: string): boolean {
  const clauses = before.split(/[,;:()—]/).map((c) => c.trim());
  const first = clauses[0] ?? "";
  if (!CONDITION_OPENER_AT_START.test(first) || REFLEXIVE_SE.test(first)) return false;
  return clauses.length - 1 <= 1;
}

function isHedged(sentence: string, at: number): boolean {
  const before = sentence.slice(0, at);
  if (conditionCovers(before)) return true;
  const clause = before.split(/[,;:()—]/).pop() ?? "";
  return HEDGE_BEFORE.test(clause.trim().split(/\s+/).slice(-6).join(" ")) || HEDGE_RIGHT_BEFORE.test(`${clause.trimEnd()} `);
}

function markersIn(n: string): Hit[] {
  const out: Hit[] = [];
  for (const m of MARKERS) {
    m.re.lastIndex = 0;
    for (const found of n.matchAll(m.re)) {
      if (!m.noHedge && isHedged(n, found.index ?? 0)) continue;
      // "cadastro confirmado", "pagamento confirmado": o assunto do marcador não é horário.
      const near = (n.slice(0, found.index ?? 0).split(/[,;:()—]/).pop() ?? "").trim().split(/\s+/).slice(-5).join(" ");
      if (PAYMENT_CUE.test(near)) continue;
      if (m.notAfter && m.notAfter.test((n.slice(0, found.index ?? 0).split(/[,;:()—]/).pop() ?? "").trim()) && !(m.exemptOnlyWithoutTime && extractAiTimes(n).length > 0)) continue;
      out.push({ level: m.level, needsMention: m.needsMention === true, readback: m.readback === true, domain: m.domain === true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remarcação / cancelamento afirmados (a IA ainda NÃO tem tool para isso: sempre barrado)
// ---------------------------------------------------------------------------

const CHANGE_CLAIM =
  /\b(?:remarc(?:ad[oa]\w*|amos)|remarquei|reagend(?:ad[oa]\w*|ei|amos)|troquei|trocad[oa]\w*|trocamos|mudei|mudad[oa]\w*|mudamos|(?<!que )passei (?:o|seu|sua|a|para|pra)|passou (?:para|pra)|transferid[oa]\w*|transferi|transferimos|adiei|adiad[oa]\w*|adiamos|antecipei|antecipad[oa]\w*)\b/g;
const CANCEL_CLAIM = /\b(?:cancelei|cancelad[oa]\w*|cancelamos|desmarquei|desmarcad[oa]\w*|desmarcamos)\b/g;
const SUBJECT_FICA = /\b(?:horario|consulta|sessao|atendimento|agendamento)\b[^.!?]*\b(?:fica|ficou) (?:para|pra)\b/;
const INSTEAD_OF = /\b(?:em vez de|ao inves de)\b/;

/** A frase AFIRMA mudança ou cancelamento de um agendamento (nunca passa: a IA não remarca nem cancela neste bloco). */
function claimsChange(n: string, hasMention: boolean, hasOfferVerb: boolean, handoff: boolean): boolean {
  const nounOrTime = SCHEDULE_NOUN.test(n) || hasMention;
  // "Já passei seu pedido para a equipe" com o repasse criado é verdade: o alvo de "passei/transferi" é a equipe, não outro horário.
  const handoffMatch = handoff ? HANDOFF_PASS.exec(n) : null;
  const handoffAt = handoffMatch ? handoffMatch.index : -1;
  const handoffEnd = handoffMatch ? handoffMatch.index + handoffMatch[0].length : -1;
  for (const re of [CHANGE_CLAIM, CANCEL_CLAIM]) {
    re.lastIndex = 0;
    for (const m of n.matchAll(re)) {
      if (isHedged(n, m.index ?? 0)) continue;
      if (
        handoffAt >= 0 &&
        re === CHANGE_CLAIM &&
        /^(?:passei|passou|transferi|transferimos|transferid)/.test(m[0]) &&
        (m.index ?? 0) >= handoffAt - 1 &&
        (m.index ?? 0) <= handoffAt + 20 &&
        // "passei seu horário para quarta às 9h30 com eles": o alvo de "para" é um dia, então é remarcação, não repasse.
        !MOVE_TARGET.test(n.slice(m.index ?? 0, handoffEnd))
      ) {
        continue;
      }
      if (nounOrTime) return true;
    }
  }
  if (SUBJECT_FICA.test(n) && !isHedged(n, n.search(/\b(?:fica|ficou) (?:para|pra)\b/))) return true;
  return INSTEAD_OF.test(n) && hasMention && !hasOfferVerb;
}

// ---------------------------------------------------------------------------
// Horários citados × horários conhecidos
// ---------------------------------------------------------------------------

type Match = "inventado" | "oferta" | "pendente" | "marcado" | "conhecimento";

function sameTime(k: KnownTime, m: TimeMention, today: string): boolean {
  return k.timeMin === m.timeMin && (m.day === undefined || dayMatches(m.day, k.localDate, today));
}

/** Prioridade: reserva desta rodada > agendamento existente > oferta. Hora sem dia compara só a hora. */
function classify(m: TimeMention, st: ClaimState, today: string, n: string, closing = false): Match {
  const r = st.booked.filter((k) => sameTime(k, m, today));
  const e = st.existing.filter((k) => sameTime(k, m, today));
  const hit = r.length > 0 ? r : e;
  if (hit.length > 0) return hit.some((k) => k.status === "scheduled") ? "marcado" : "pendente";
  if (st.offered.some((k) => sameTime(k, m, today))) return "oferta";
  // Hora fixa do CONHECIMENTO da org (turmas, funcionamento): descrevê-la não é oferecer vaga; "tenho 18h" continua barrado.
  // Só DESCREVE quando a frase não fecha nem afirma nada: com marcador de fechamento a hora do conhecimento vale como inventada.
  if (!closing && st.knowledgeTimes?.includes(m.timeMin) && !ASSERT_AVAIL.test(n)) return "conhecimento";
  return "inventado";
}

// ---------------------------------------------------------------------------
// Profissional/sala citado junto do horário
// ---------------------------------------------------------------------------

/** Oração que cita o profissional para dizer que ele NÃO atende ("o Tato está de folga", "com o Léo não tenho"). */
const NEGATES_RESOURCE = /\b(?:nao|nem|sem|ninguem|folga|ferias|ausente|ausentes|indisponivel|indisponiveis|ocupad[oa]s?|lotad[oa]s?|exceto|menos)\b/;

const TITLES = new Set(["dr", "dra", "doutor", "doutora", "sr", "sra", "prof", "profa", "professor", "professora"]);
const GENERIC_FIRST = new Set(["sala", "consultorio", "cadeira", "box", "maca", "studio", "estudio", "room", "mesa", "equipamento", "quadra", "salao", "espaco", "unidade"]);

const wordsOf = (name: string) => norm(name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

/**
 * Formas pelas quais o cliente/IA cita cada recurso: o nome inteiro, o nome sem título e cada PALAVRA do nome que seja só dele
 * (≥ 3 letras, não genérica e que não apareça no nome de outro recurso). "Terapeuta Carla" vira "terapeuta carla" e "carla", nunca
 * "terapeuta" (que serve a todas as terapeutas); "Léo Silva" e "Léo Souza" ficam com "silva" e "souza" (o "léo" sozinho é ambíguo).
 */
export function buildAliasIndex(names: readonly string[], serviceNames: readonly string[] = []): Array<{ key: string; aliases: string[] }> {
  // Palavra de NOME DE SERVIÇO não é apelido de recurso ("Sala de pilates" × "aula de pilates em grupo").
  const serviceWords = new Set(serviceNames.flatMap((sv) => wordsOf(sv)));
  const count = new Map<string, number>();
  for (const name of names) for (const w of new Set(wordsOf(name))) count.set(w, (count.get(w) ?? 0) + 1);
  return names.map((name) => {
    const words = wordsOf(name);
    const rest = words.filter((w) => !TITLES.has(w));
    const out = new Set<string>();
    if (words.length > 0) out.add(words.join(" "));
    if (rest.length > 0) out.add(rest.join(" "));
    for (const w of rest) if (w.length >= 3 && !GENERIC_FIRST.has(w) && !serviceWords.has(w) && !/^\d+$/.test(w) && count.get(w) === 1) out.add(w);
    return { key: resourceKey(name), aliases: [...out] };
  });
}

/** Chave estável do recurso (nome normalizado inteiro): é o que a oferta nomeada carrega em `KnownTime.resource`. */
export const resourceKey = (name: string): string => norm(name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).join(" ");

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Recursos citados na frase (normalizada). */
function citedResources(n: string, index: ReturnType<typeof buildAliasIndex>): string[] {
  const out: string[] = [];
  for (const { key, aliases } of index) {
    if (aliases.some((a) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(a)}(?![a-z0-9])`).test(n))) out.push(key);
  }
  return out;
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
  /** O horário citado só DESCREVE (funcionamento, turma fixa, "vou verificar", pergunta de dia): não é oferta inventada. */
  noInvent: boolean;
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
    const question = p.term.includes("?");
    const skip = CUSTOMER_CITATION.test(norm(body.replace(VOCATIVE, ""))) || UNAVAILABLE_CUE.test(n) || BUSINESS_CUE.test(n);
    const verifyAt = n.search(VERIFY_PROMISE);
    const noInvent =
      (INFO_CUE.test(n) && !ASSERT_AVAIL.test(n)) ||
      (verifyAt >= 0 && !ASSERT_AVAIL.test(n.slice(0, verifyAt))) ||
      (question && DAY_QUESTION.test(n) && !ASSERT_AVAIL.test(n)) ||
      (st.handoff === true && CHANGE_TOPIC.test(n) && TEAM_WORD.test(n) && !ASSERT_AVAIL.test(n));
    return {
      raw: p.raw.trim(),
      n,
      question,
      tagQuestion: tag,
      skip,
      noInvent,
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

  const messageMatches = live.flatMap((s) => s.mentions.map((m) => classify(m, st, today, s.n, true)));

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
    (hits.length > 0 && /\b(?:seu|sua|seus|suas|voce|voces|vcs|pra voce|para voce|no seu nome)\b/.test(s.n));
  const lastIsRealQuestion = !!last && last.question && !last.tagQuestion;

  // Uma afirmação de agenda em qualquer frase ("Marcado!") vale para o dia e hora citados nas outras ("Quinta às 15h.").
  const messageClaim = live.some((s) => !s.skip && hitsOf(s).some((h) => h.domain || messageNoun));

  // 0. Remarcação ou cancelamento AFIRMADOS: sempre barrado (a IA não tem tool de remarcar/cancelar; é repasse para humano).
  for (const s of live) {
    if (s.skip || (s.question && !s.tagQuestion)) continue;
    if (claimsChange(s.n, s.mentions.length > 0 || mentionsAnyTime(s.raw), OFFER_VERB.test(s.n), st.handoff === true)) return { kind: "reschedule_claim", evidence: s.raw.slice(0, EVIDENCE_MAX) };
  }

  // 0a. "Já passei seu pedido para a equipe" SEM repasse (nem neste turno nem pendente na conversa): a IA afirma uma ação que não fez.
  if (st.handoff !== true) {
    for (const s of live) {
      if (s.skip || (s.question && !s.tagQuestion)) continue;
      if (HANDOFF_PASS.test(s.n)) return { kind: "handoff_claim", evidence: s.raw.slice(0, EVIDENCE_MAX) };
    }
  }

  // 0b. Profissional/sala citado junto de um horário: só vale se a OFERTA (ou o agendamento) nomeou esse recurso. O motor
  // escolhe quem atende; sem a oferta nomear, "terça às 14h com o Léo" é promessa que ninguém verificou.
  const resourceNames = st.resourceNames ?? [];
  const aliasIndex = buildAliasIndex(resourceNames, st.serviceNames ?? []);
  if (resourceNames.length > 0) {
    for (const s of live) {
      if (s.skip || s.mentions.length === 0) continue;
      for (const cited of citedResources(s.n, aliasIndex)) {
        // "…com outro barbeiro, já que o Tato está de folga": a oração que cita o nome NEGA o vínculo (não, folga, indisponível…).
        const clausesOfCited = s.n.split(/[,;()—:]/).filter((c) => citedResources(c, aliasIndex).includes(cited));
        if (clausesOfCited.length > 0 && clausesOfCited.every((c) => NEGATES_RESOURCE.test(c))) continue;
        const backed = s.mentions.some((m) => [...st.booked, ...st.existing, ...st.offered].some((k) => k.resources?.includes(cited) === true && sameTime(k, m, today)));
        if (!backed) return { kind: "resource_not_offered", evidence: s.raw.slice(0, EVIDENCE_MAX) };
      }
    }
  }

  // 1. Horário inventado em frase DE AGENDA.
  for (const s of live) {
    if (s.skip || s.mentions.length === 0 || s.noInvent) continue;
    const hits = hitsOf(s);
    const agenda = isAgendaSentence(s, hits) || messageClaim;
    if (!agenda) continue;
    if (s.mentions.some((m) => classify(m, st, today, s.n, hits.length > 0 || messageClaim) === "inventado")) return { kind: "time_not_offered", evidence: s.raw.slice(0, EVIDENCE_MAX) };
  }

  // 2. Por frase: fechamento (léxico), lista de permissão para horário só ofertado e para pedido pendente.
  for (const s of live) {
    if (s.skip) continue;
    if (GENERIC_PLURAL.test(s.n)) continue;
    const evidence = s.raw.slice(0, EVIDENCE_MAX);
    const rawHits = hitsOf(s);
    // Hora SEM dia em frase que não é de agenda ("Chego na clínica às nove") não é horário de atendimento.
    const agendaS = isAgendaSentence(s, rawHits);
    // "Deixo essa dúvida registrada": marcador fraco, sem horário nem substantivo de agenda na frase, não fala de horário.
    const aboutBooking = agendaS || /\bpedido\b/.test(s.n) || s.mentions.length > 0;
    const hits = rawHits.filter((h) => !(h.level === "soft" && !h.domain && !aboutBooking));
    const own = s.mentions.filter((m) => m.day !== undefined || agendaS).map((m) => classify(m, st, today, s.n, rawHits.length > 0));
    // Repasse criado neste turno: "já avisei a equipe", "eles cuidam disso" descrevem o repasse, não afirmam horário.
    const handoffTalk = st.handoff === true && (HANDOFF_PASS.test(s.n) || HANDOFF_TEAM_ACTS.test(s.n));
    const definitive = (hs: Hit[]) => hs.some((h) => h.level === "strong") || (hs.some((h) => h.level === "closer") && !pendingQualified);

    // Qualquer marcador (fechamento, "combinado", "registrado") com hora que o servidor não devolveu: "Combinado, quarta às 15h então!" também é afirmação.
    if (hits.some((h) => h.domain || h.level === "closer") && own.includes("inventado") && !s.noInvent) return { kind: "time_not_offered", evidence };
    // "Já deixei seu pedido registrado e eles te respondem por aqui" com o repasse criado: o "registrado" é o repasse. Só vale sem horário
    // citado e só para marcador fraco (soft/closer): "Marcado!" continua barrado.
    if (handoffTalk && own.length === 0 && hits.every((h) => h.level !== "strong")) continue;
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
        (OFFER_VERB.test(s.n) && !POSSESSIVE_SLOT.test(s.n)) ||
        OFFER_HEDGE.test(s.n) ||
        isBareTimeSentence(s.n) ||
        handoffTalk ||
        endsWithConfirmQuestion;
      if (!allowed) return { kind: "claim_without_booking", evidence };
    }
    if (own.includes("pendente")) {
      const allowed = s.question || PENDING_OK.test(s.n) || OFFER_HEDGE.test(s.n) || isBareTimeSentence(s.n) || handoffTalk;
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
    case "handoff_claim":
      return "Sua resposta anterior foi DESCARTADA: ela dizia que o pedido foi passado para a equipe, mas nenhum repasse foi criado. Chame requestHandoff (com o motivo) NESTA rodada, junto da resposta, ou não diga que passou para a equipe.";
    case "resource_not_offered":
      return "Sua resposta anterior foi DESCARTADA: ela ligava um horário a um profissional (ou sala) que o sistema NÃO confirmou para esse horário. Só diga que o horário é com alguém se a oferta trouxe essa pessoa (consulte de novo com o campo profissional); senão ofereça o horário sem nome e diga que a equipe confirma quem atende.";
  }
}

/** Texto FIXO enviado quando o guard barra duas vezes: nunca falha o turno nem deixa o cliente sem resposta. */
export const SCHED_SAFE_TEXT = "Vou confirmar os horários com a equipe e já te retorno.";
