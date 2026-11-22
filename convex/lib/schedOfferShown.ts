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
import { dayMatches, extractAiTimes, norm, type TimeMention, todayOf } from "./schedTimeText";

const NOT_AN_OFFER = /\b(?:nao tenho|nao temos|nao ha|indisponivel|indisponiveis|ocupad[oa]s?|lotad[oa]s?|sem vaga|nao consigo|nao esta livre|nao esta disponivel|ja passou)\b/;

/** Funcionamento da casa ("atendemos das 8 às 18h"): a faixa não é oferta, mesmo com o início sendo lido. */
const BUSINESS = /\b(?:atendemos|funcionamos|funcionamento|expediente|abrimos|abre|fecha|fechamos|aberto|abertos|horario de atendimento)\b/;

/** Oferta no texto: "tenho", "temos", "há", "livre", "disponível", "vaga", "posso"… (fora das negações: "não tenho" é negação, não oferta). */
const OFFER_CUE = /\b(?:tenho|temos|tem|ha|consigo|conseguimos|disponivel|disponiveis|livres?|vagas?|opcao|opcoes|posso|encaixo|sobrou|restou|so|apenas|somente)\b/g;
const NOT_CUE = new RegExp(NOT_AN_OFFER.source, "g");

/**
 * A hora de `m` está NEGADA ("o das 10h acabou de ser ocupado") ou OFERECIDA ("ainda tenho 11h e 15h")? A negação não pode apagar a frase
 * toda: "…acabou de ser ocupado aqui na agenda 😕 Para quarta, 25/11, ainda tenho 11h e 15h" é UMA oração para o corte por pontuação, e
 * apagá-la deixava as ofertas novas sem `shownAt` (4 de ~56 reofertas na simulação com modelo real). Vale a pista MAIS PERTO da hora, dentro
 * da mesma oração, antes ou depois dela (negação > oferta só quando está mais perto).
 */
function isNegatedMention(n: string, m: TimeMention, segmentOf: (pos: number) => number): boolean {
  const seg = segmentOf(m.at);
  type Cue = { negation: boolean; start: number; end: number };
  const cues: Cue[] = [];
  for (const c of n.matchAll(NOT_CUE)) cues.push({ negation: true, start: c.index ?? 0, end: (c.index ?? 0) + c[0].length });
  for (const c of n.matchAll(OFFER_CUE)) {
    const start = c.index ?? 0;
    // "não tenho": o "tenho" já está dentro da negação.
    if (cues.some((x) => x.negation && start >= x.start && start < x.end)) continue;
    cues.push({ negation: false, start, end: start + c[0].length });
  }
  let best: { negation: boolean; distance: number } | null = null;
  for (const c of cues) {
    if (segmentOf(c.start) !== seg) continue;
    const distance = c.end <= m.at ? m.at - c.end : c.start - m.at;
    if (distance < 0) continue;
    // empate: a pista que vem ANTES da hora ("não tenho 10h") vale mais que a que vem depois
    if (best === null || distance < best.distance || (distance === best.distance && c.end <= m.at)) best = { negation: c.negation, distance };
  }
  return best?.negation === true;
}

export function offersShownInText(state: OffersState, text: string, ctx: { now: number; tz: string }): Set<string> {
  const out = new Set<string>();
  if (!text.trim() || state.offers.length === 0) return out;
  const today = todayOf(ctx.now, ctx.tz);
  const n = norm(text);
  // Funcionamento da casa apaga a ORAÇÃO inteira; a negação de horário é por proximidade (`isNegatedMention`).
  const bounds = [...n.matchAll(/[.!?;\n]+|\b(?:mas|porem|so que)\b/g)].map((x) => x.index ?? 0);
  const segmentOf = (pos: number) => bounds.filter((b) => b < pos).length;
  const clauses = n.split(/[.!?;\n]+|\b(?:mas|porem|so que)\b/);
  const dropped = new Set(clauses.map((c, i) => (BUSINESS.test(c) ? i : -1)).filter((i) => i >= 0));
  const mentions = extractAiTimes(text, { keepRangeStart: true }).filter((m) => !dropped.has(m.clause) && !isNegatedMention(n, m, segmentOf));
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
