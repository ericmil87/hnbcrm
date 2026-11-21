/**
 * Agenda v2 (D1) — quais ofertas uma mensagem ENVIADA ao cliente mostrou (puro).
 *
 * Uma oferta (`h1`…) só vale depois que o cliente a VIU: `shownAt` é gravado quando a mensagem que contém o horário
 * sai de fato (commit do atendente em autopilot, aprovação do rascunho), nunca na emissão. O casador é PRÓPRIO para
 * texto da IA (`schedTimeText`) e restrito às ofertas emitidas (conjunto pequeno e conhecido): uma oferta ainda não
 * mostrada vira "mostrada" se a HORA dela aparece no texto em qualquer forma comum (`08:00`, `8h`, "às 8", "às oito",
 * "cinco da tarde", "meio-dia") E o DIA dela é compatível com o último dia citado antes da hora (dia da semana, data,
 * "dia 15", hoje/amanhã; o dia atravessa frases e linhas). Mensagem sem nenhum dia só vale quando todas as ofertas
 * emitidas são do mesmo dia. Nunca marca oferta cuja hora não aparece, nem a de dia diferente do citado. Condicional
 * ("se quiser, tenho…") não esconde a oferta; frase de indisponibilidade ("não tenho mais às 10h") não a mostra.
 */
import type { OffersState } from "./schedOffers";
import { localDateOf, minutesOfDay } from "./schedTime";
import { dayMatches, extractAiTimes, norm, todayOf } from "./schedTimeText";

const NOT_AN_OFFER = /\b(?:nao tenho|nao temos|nao ha|indisponivel|indisponiveis|ocupad[oa]s?|lotad[oa]s?|sem vaga|nao consigo|nao esta livre|nao esta disponivel|ja passou)\b/;

/** Funcionamento da casa ("atendemos das 8 às 18h"): a faixa não é oferta, mesmo com o início sendo lido. */
const BUSINESS = /\b(?:atendemos|funcionamos|funcionamento|expediente|abrimos|abre|fecha|fechamos|aberto|abertos|horario de atendimento)\b/;

export function offersShownInText(state: OffersState, text: string, ctx: { now: number; tz: string }): Set<string> {
  const out = new Set<string>();
  if (!text.trim() || state.offers.length === 0) return out;
  const today = todayOf(ctx.now, ctx.tz);
  // A negação recorta só a ORAÇÃO ("oito e meia não tenho, mas tenho 8h…" mostra 8h); o dia carregado continua valendo.
  const clauses = norm(text).split(/[.!?;\n]+|\b(?:mas|porem|so que)\b/);
  const dropped = new Set(clauses.map((c, i) => (NOT_AN_OFFER.test(c) || BUSINESS.test(c) ? i : -1)).filter((i) => i >= 0));
  const mentions = extractAiTimes(text, { keepRangeStart: true }).filter((m) => !dropped.has(m.clause));
  const allSameDay = new Set(state.offers.map((o) => localDateOf(o.startTime, ctx.tz))).size === 1;
  for (const o of state.offers) {
    if (o.shownAt !== undefined) continue;
    const date = localDateOf(o.startTime, ctx.tz);
    const timeMin = minutesOfDay(o.startTime, ctx.tz);
    const hit = mentions.some((m) => m.timeMin === timeMin && (m.day === undefined ? allSameDay : dayMatches(m.day, date, today)));
    if (hit) out.add(o.code);
  }
  return out;
}
