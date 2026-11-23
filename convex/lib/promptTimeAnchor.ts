/**
 * ÂNCORA DE TEMPO no fim da mensagem do usuário (atendente 1:1 e turno de grupo) + instrução final única.
 *
 * Por quê: o bloco DATA E HORA ATUAIS e o carimbo legível em cada mensagem do histórico (#207) NÃO bastaram.
 * No caso real (Kenji, 23/11/2026) a IA escreveu "Te espero amanhã às 10h" às 12h25, sobre uma sessão que era
 * às 10h do próprio dia: o modelo relê a própria despedida da véspera e a repete. O laboratório (414 respostas
 * reais pelo caminho de PROD) mediu: V0 (sem nada) 38 erros em 100 nos cenários difíceis; só uma frase de regra
 * no system prompt 17/100; ÂNCORA calculada no servidor, colada no FIM da mensagem do usuário, 1/100; controles 0.
 * Grupo (lab de grupo, 141 respostas, mesmo modelo): erros de tempo 5/33 sem âncora, 0/35 com ela.
 * A redação abaixo é a que foi MEDIDA: não a reescreva sem medir de novo.
 *
 * Fica depois do histórico (recência) e antes da instrução final; não toca o system prompt (cache de prefixo).
 *
 * Módulo PURO: sem ctx, sem `Date.now()` (o `now` vem de quem pode lê-lo — o claim do runtime ou o simulador,
 * o que também mantém runtime e simulador gerando o MESMO texto para o mesmo contexto).
 */
import { formatLocalShort } from "./agentSchedule";
import { safeTimezone } from "./promptDateTime";
import { addLocalDays, localDateOf } from "./schedTime";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** "35 min", "2 h 25", "14 h", "3 dias" (sem o "há"). */
function formatSpan(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MIN) return "instantes";
  if (abs < HOUR) return `${Math.round(abs / MIN)} min`;
  if (abs < 6 * HOUR) {
    const h = Math.floor(abs / HOUR);
    const m = Math.round((abs - h * HOUR) / MIN);
    if (m === 60) return `${h + 1} h`;
    return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
  }
  if (abs < 48 * HOUR) return `${Math.round(abs / HOUR)} h`;
  return `${Math.floor(abs / (24 * HOUR))} dias`;
}

/** "há 35 min", "há 2 h 25", "há 14 h", "há 3 dias". */
export function formatAgo(ms: number): string {
  const s = formatSpan(ms);
  return s === "instantes" ? "há instantes" : `há ${s}`;
}

function partsOf(fmt: Intl.DateTimeFormat, date: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

/** "segunda-feira, 23/11/2026, 12:25" (mesmo formato do bloco DATA E HORA ATUAIS). */
function formatNowLong(now: number, tz: string): string {
  const p = partsOf(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }),
    new Date(now)
  );
  return `${p.weekday}, ${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute}`;
}

/** "hoje"/"ontem"/null conforme o dia LOCAL de `at` em relação a `now`. */
function dayWord(at: number, now: number, tz: string): "hoje" | "ontem" | null {
  const today = localDateOf(now, tz);
  const d = localDateOf(at, tz);
  if (d === today) return "hoje";
  if (d === addLocalDays(today, -1)) return "ontem";
  return null;
}

/** Instante utilizável por `Intl`/`Date` (nunca lança). */
function usable(ms: number | null | undefined): ms is number {
  return typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
}

/** A regra da âncora (redação MEDIDA no laboratório, V1). */
const ANCHOR_RULE =
  '"Hoje", "amanhã" e dias da semana escritos numa mensagem valem para o dia em que ela foi escrita: antes de citar um dia ou horário combinado, compare com AGORA. O que já passou é passado: não diga "te espero", "até lá" nem "amanhã" para ele.';

/**
 * A âncora (uma linha), calculada no servidor. Exemplo:
 *
 *   AGORA: segunda-feira, 23/11/2026, 12:25. Última mensagem do cliente: seg 23/11 12:25. Última mensagem nossa:
 *   dom 22/11 22:29 (ontem, há 14 h). "Hoje", "amanhã" e dias da semana escritos numa mensagem valem para o dia
 *   em que ela foi escrita: antes de citar um dia ou horário combinado, compare com AGORA. O que já passou é
 *   passado: não diga "te espero", "até lá" nem "amanhã" para ele.
 *
 * "Nossa" = IA + equipe. Omite as partes que não existem (sem instante utilizável, a parte some; nunca inventa).
 * `null` só quando o próprio `now` é inutilizável.
 */
export function buildTimeAnchor(input: {
  now: number;
  timezone: string;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  /**
   * Quem escreve na ponta de lá: `cliente` (1:1, o padrão) ou `grupo` (turno de grupo, qualquer membro). Só troca
   * a palavra do rótulo da última mensagem recebida; o resto do texto é o mesmo e foi medido (lab de grupo).
   */
  audience?: "cliente" | "grupo";
}): string | null {
  if (!usable(input.now)) return null;
  const tz = safeTimezone(input.timezone);
  const parts = [`AGORA: ${formatNowLong(input.now, tz)}.`];
  if (usable(input.lastInboundAt)) {
    parts.push(`Última mensagem do ${input.audience ?? "cliente"}: ${formatLocalShort(input.lastInboundAt, tz)}.`);
  }
  if (usable(input.lastOutboundAt)) {
    const w = dayWord(input.lastOutboundAt, input.now, tz);
    const ago = formatAgo(input.now - input.lastOutboundAt);
    parts.push(
      `Última mensagem nossa: ${formatLocalShort(input.lastOutboundAt, tz)} (${w ? `${w}, ${ago}` : ago}).`
    );
  }
  parts.push(ANCHOR_RULE);
  return parts.join(" ");
}

const FOLLOW_UP_INSTRUCTION = [
  'Chegou a hora de um follow-up que VOCÊ agendou (campo "follow_up_de_agora").',
  "Releia o histórico acima ANTES de escrever: pode ser que o assunto já tenha se resolvido sozinho.",
  '- Já resolvido (o cliente mandou o comprovante, já comprou, já respondeu) → NÃO mande mensagem: chame resolveFollowUp com outcome "not_needed".',
  "- Ainda faz sentido → chame replyToCustomer com uma mensagem curta e leve, que retome o assunto sem cobrar.",
  '- O cliente pediu outra data → resolveFollowUp com outcome "reschedule".',
  "Nunca escreva nada fora de uma ferramenta: texto solto NÃO chega ao cliente.",
].join("\n");

const REPLY_INSTRUCTION = "Responda ao cliente agora (última mensagem do histórico acima).";

/**
 * Instrução final ÚNICA do atendente 1:1 (runtime e simulador): a âncora, quando houver, e depois a instrução.
 * Turno PROATIVO (follow-up): ninguém acabou de escrever, a instrução é "releia e decida", não "responda agora".
 */
export function buildAttendantFinalInstruction(input: {
  followUp: boolean;
  anchor: string | null;
}): string {
  const instruction = input.followUp ? FOLLOW_UP_INSTRUCTION : REPLY_INSTRUCTION;
  return input.anchor ? `${input.anchor}\n\n${instruction}` : instruction;
}
