/**
 * Agenda v2 — ofertas curtas por conversa (puro; relatório 10 §1.1 #2 e #4).
 *
 * A IA recebe códigos curtos sequenciais (`h1`, `h2`…); o mapa fica no servidor
 * (`schedConversationState.offers`). Validade 30 min, só as 9 últimas valem, e
 * uma oferta só é aceita se foi emitida ANTES da última mensagem do cliente
 * (prova de que ele viu e respondeu). Funções devolvem estado NOVO (sem mutar).
 *
 * `batch` = número do primeiro código do lote (monótono, nunca reaproveitado
 * mesmo se todas as ofertas forem invalidadas).
 */

import { OFFER_TTL_MS, OFFERS_KEPT } from "./schedConstants";
import type { SchedId } from "./schedAvailability";

export type OfferRecord = {
  code: string;
  batch: number;
  serviceId: SchedId;
  variantKey?: string;
  startTime: number;
  resourceIds: SchedId[];
  rescheduleOfId?: SchedId;
  issuedAt: number;
  expiresAt: number;
  /**
   * Instante em que a mensagem que CONTÉM este horário foi de fato ENVIADA ao cliente (commit do atendente em
   * autopilot ou aprovação do rascunho). Ausente = o cliente nunca viu: a oferta não vale (nem aparece no prompt).
   */
  shownAt?: number;
  /** Busca para 2–4 pessoas: a oferta lembra o tamanho do grupo e a reserva o usa (a IA nunca o informa na escrita). */
  people?: number;
  /** Profissional/sala que o cliente pediu e a busca honrou (nome para exibir; a reserva fixa o recurso do plano, sem troca). */
  professional?: string;
};
export type OffersState = { offerSeq: number; offers: OfferRecord[] };
export type OfferPick = {
  serviceId: SchedId;
  variantKey?: string;
  startTime: number;
  resourceIds: SchedId[];
  rescheduleOfId?: SchedId;
  people?: number;
  professional?: string;
};

/** `OFFER_TTL_MS` e `OFFERS_KEPT` do plano (A1). UNIFICAR com `schedConstants`. */

export type OfferError = "desconhecida" | "expirada" | "sem_resposta_do_cliente";

/** Numera a partir de `offerSeq + 1` e mantém só as `keep` últimas (por padrão 9). */
export function issueOffers(
  state: OffersState,
  picks: OfferPick[],
  now: number,
  opts?: { ttlMs?: number; keep?: number }
): { state: OffersState; issued: OfferRecord[]; batch: number } {
  const ttl = opts?.ttlMs ?? OFFER_TTL_MS;
  const keep = opts?.keep ?? OFFERS_KEPT;
  if (!Number.isInteger(keep) || keep < 1) throw new Error("`keep` deve ser um inteiro maior ou igual a 1.");
  if (!Number.isInteger(ttl) || ttl < 1) throw new Error("`ttlMs` deve ser um inteiro positivo.");
  if (picks.length > keep) throw new Error(`Um lote não pode ter mais ofertas (${picks.length}) que o teto de ${keep} códigos.`);
  const batch = state.offerSeq + 1;
  let seq = state.offerSeq;
  const issued: OfferRecord[] = picks.map((p) => {
    seq += 1;
    const rec: OfferRecord = {
      code: `h${seq}`,
      batch,
      serviceId: p.serviceId,
      startTime: p.startTime,
      resourceIds: [...p.resourceIds],
      issuedAt: now,
      expiresAt: now + ttl,
    };
    if (p.variantKey !== undefined) rec.variantKey = p.variantKey;
    if (p.rescheduleOfId !== undefined) rec.rescheduleOfId = p.rescheduleOfId;
    if (p.people !== undefined && p.people > 1) rec.people = p.people;
    if (p.professional !== undefined) rec.professional = p.professional;
    return rec;
  });
  const offers = [...state.offers, ...issued].slice(-keep);
  return { state: { offerSeq: seq, offers }, issued, batch };
}

/**
 * Procura a oferta. A oferta só vale se foi MOSTRADA ao cliente (`shownAt`: a mensagem que a contém saiu) ANTES da
 * última mensagem dele: emitir antes da mensagem do cliente não prova nada (o turno pode ter falhado no guard ou o
 * rascunho nunca ter sido aprovado). NÃO consome: chamar duas vezes devolve a mesma oferta. A
 * porta chama `consumeOffer` na mesma mutation que reserva, para o código usado
 * não valer de novo.
 *
 * Erros: `desconhecida` | `expirada` | `sem_resposta_do_cliente` (emitida depois da última mensagem do cliente, ou cliente nunca respondeu). */
export function resolveOffer(
  state: OffersState,
  code: string,
  now: number,
  lastInboundAt: number | null | undefined
): { ok: true; offer: OfferRecord } | { ok: false; error: OfferError } {
  const normalized = typeof code === "string" ? code.trim().toLowerCase() : "";
  const offer = state.offers.find((o) => o.code === normalized);
  if (!offer) return { ok: false, error: "desconhecida" };
  if (now >= offer.expiresAt) return { ok: false, error: "expirada" };
  if (
    lastInboundAt === null ||
    lastInboundAt === undefined ||
    offer.shownAt === undefined ||
    offer.shownAt >= lastInboundAt
  ) {
    return { ok: false, error: "sem_resposta_do_cliente" };
  }
  return { ok: true, offer };
}

/** Oferta vigente = ainda não venceu e já foi mostrada ao cliente. */
export function currentOffers(state: OffersState, now: number): OfferRecord[] {
  return state.offers.filter((o) => now < o.expiresAt && o.shownAt !== undefined);
}

/** Marca como mostradas (no instante `now`) as ofertas de `codes` que ainda não tinham `shownAt`. */
export function markShown(state: OffersState, codes: ReadonlySet<string>, now: number): OffersState {
  if (codes.size === 0) return state;
  return {
    offerSeq: state.offerSeq,
    offers: state.offers.map((o) => (codes.has(o.code) && o.shownAt === undefined ? { ...o, shownAt: now } : o)),
  };
}

/** Remove o código usado (depois de reservar). Código ausente devolve o estado igual. `offerSeq` nunca recua. */
export function consumeOffer(state: OffersState, code: string): OffersState {
  const normalized = typeof code === "string" ? code.trim().toLowerCase() : "";
  return { offerSeq: state.offerSeq, offers: state.offers.filter((o) => o.code !== normalized) };
}

/** `horario_tomado`: descarta todas as ofertas, exceto as do lote `keepBatch` (se informado). `offerSeq` nunca recua. */
export function invalidateOffers(state: OffersState, keepBatch?: number): OffersState {
  return {
    offerSeq: state.offerSeq,
    offers: keepBatch === undefined ? [] : state.offers.filter((o) => o.batch === keepBatch),
  };
}
