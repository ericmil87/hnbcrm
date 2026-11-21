/**
 * Agenda v2 (D1) — quais ofertas uma mensagem ENVIADA ao cliente mostrou (puro).
 *
 * Uma oferta (`h1`…) só vale depois que o cliente a VIU: `shownAt` é gravado quando a mensagem que contém o horário
 * sai de fato (commit do atendente em autopilot, aprovação do rascunho), nunca na emissão. O texto é lido com o mesmo
 * extrator de dia/hora do parser de confirmação (`extractDateTimeMentions`): a oferta conta como mostrada quando o
 * texto cita o DIA e a HORA dela. "segunda 15/06 às 08:00 ou às 09:00" vale para as duas (a hora sem dia herda o dia
 * da menção anterior); só hora, sem nenhum dia antes, não mostra nada.
 */
import { neutralizeForMentions } from "./schedClaimGuard";
import { extractDateTimeMentions } from "./schedConfirmParser";
import type { OffersState } from "./schedOffers";
import { localDateOf, minutesOfDay } from "./schedTime";

export function offersShownInText(state: OffersState, text: string, ctx: { now: number; tz: string }): Set<string> {
  const out = new Set<string>();
  if (!text.trim() || state.offers.length === 0) return out;
  // As menções são lidas frase a frase: o extrator descarta a frase com negação/faixa/pergunta de funcionamento.
  const pairs = new Set<string>();
  for (const sentence of text.match(/[^.!?\n]+[.!?]*/g) ?? []) {
    let lastDate: string | undefined;
    for (const m of extractDateTimeMentions(neutralizeForMentions(sentence), ctx)) {
      if (m.localDate !== undefined) lastDate = m.localDate;
      const date = m.localDate ?? lastDate;
      if (date !== undefined && m.timeMin !== undefined) pairs.add(`${date}|${m.timeMin}`);
    }
  }
  for (const o of state.offers) {
    if (pairs.has(`${localDateOf(o.startTime, ctx.tz)}|${minutesOfDay(o.startTime, ctx.tz)}`)) out.add(o.code);
  }
  return out;
}
