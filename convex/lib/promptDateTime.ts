/**
 * DATA E HORA no prompt dos agentes de IA.
 *
 * Um LLM não tem relógio: sem este bloco ele não sabe se é madrugada, não
 * consegue aplicar regra do CONHECIMENTO que depende de data ("R$67 até 06/10,
 * R$97 nos dias 07 e 08"), não marca "quinta que vem" e não valida "cupom vale
 * 7 dias". Pior: quando perguntado, ele CHUTA uma data — e a do treino.
 *
 * O bloco entra no FIM do system prompt, nunca no topo: provider faz cache de
 * PREFIXO, e um carimbo com minuto no começo invalidaria o prompt inteiro a
 * cada turno. No fim, tudo que vem antes continua cacheável.
 *
 * Módulo PURO (sem ctx, sem Date.now()) — o `now` vem de quem pode lê-lo
 * (action/mutation), o que também torna o simulador testável em qualquer data.
 */

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/** Quantos dias à frente entram na régua (LLM erra aritmética de dia da semana). */
const NEXT_DAYS = 7;

/**
 * O construtor é o único validador de IANA que existe: ele lança RangeError em
 * fuso desconhecido. Mesmo truque de `lib/groupPostSchedule.ts` e
 * `lib/campaignPacing.ts`.
 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fuso utilizável. Timezone inválida NUNCA pode lançar aqui — o campo é texto
 * livre vindo da config da org/do perfil, e derrubar o turno do atendente por
 * causa de um "America/Sao_Pualo" seria desproporcional.
 */
export function safeTimezone(timezone: string | null | undefined): string {
  const tz = timezone?.trim();
  if (!tz) return DEFAULT_TIMEZONE;
  return isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

/**
 * Fuso efetivo do agente: o do horário de atendimento (mais específico) vence o
 * da organização; nenhum dos dois, o default do produto.
 *
 * Fuso da agenda preenchido mas INVÁLIDO cai para o da ORG, não direto para o
 * default: um erro de digitação no horário de atendimento não pode fazer uma
 * org de Manaus passar a ver hora de São Paulo.
 */
export function resolveAgentTimezone(
  scheduleTimezone: string | null | undefined,
  orgTimezone: string | null | undefined
): string {
  const schedule = scheduleTimezone?.trim();
  if (schedule && isValidTimezone(schedule)) return schedule;
  return safeTimezone(orgTimezone);
}

/**
 * Semântica do opt-out: ausente/undefined = LIGADO. Só `false` explícito
 * desliga (o contrário de `aiConfig.visionEnabled`, que é opt-in).
 */
export function shouldIncludeCurrentDateTime(
  profile: { includeCurrentDateTime?: boolean } | null | undefined
): boolean {
  return profile?.includeCurrentDateTime !== false;
}

function partsOf(fmt: Intl.DateTimeFormat, date: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

/** "sáb." → "sáb" (o pt-BR abrevia com ponto; numa lista fica ruído). */
function shortWeekday(value: string): string {
  return value.replace(/\.$/, "");
}

/**
 * Bloco em PT-BR com o agora e a régua dos próximos dias. Exemplo:
 *
 *   DATA E HORA ATUAIS: sexta-feira, 18/09/2026, 14:32 (fuso America/Sao_Paulo).
 *   Próximos dias: sáb 19/09, dom 20/09, seg 21/09, ter 22/09, qua 23/09, qui 24/09, sex 25/09.
 *   Esta é a sua ÚNICA fonte de data e hora: use-a para "hoje", "amanhã", ...
 */
export function buildCurrentDateTimeBlock(now: number, timezone?: string | null): string {
  const tz = safeTimezone(timezone);

  const nowParts = partsOf(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23", // sem isso a meia-noite sai como "24:00" em parte dos ICUs
    }),
    new Date(now)
  );

  // A régua dos próximos dias caminha pelo CALENDÁRIO (Date.UTC ao meio-dia),
  // não somando 24h ao epoch: num fuso com horário de verão, +24h no dia da
  // virada repetiria ou pularia uma data.
  const year = Number(nowParts.year);
  const month = Number(nowParts.month);
  const day = Number(nowParts.day);
  const dayFmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
  const upcoming: string[] = [];
  for (let i = 1; i <= NEXT_DAYS; i++) {
    const p = partsOf(dayFmt, new Date(Date.UTC(year, month - 1, day + i, 12)));
    upcoming.push(`${shortWeekday(p.weekday)} ${p.day}/${p.month}`);
  }

  return [
    `DATA E HORA ATUAIS: ${nowParts.weekday}, ${nowParts.day}/${nowParts.month}/${nowParts.year}, ${nowParts.hour}:${nowParts.minute} (fuso ${tz}).`,
    `Próximos dias: ${upcoming.join(", ")}.`,
    'Esta é a sua ÚNICA fonte de data e hora: use-a para "hoje", "amanhã", dia da semana e qualquer cálculo de data relativa, e para aplicar as regras do CONHECIMENTO que dependem de data (lotes de preço, prazos de promoção, validade de cupom, horário de atendimento). Nunca chute a data nem invente o dia da semana.',
  ].join("\n");
}
