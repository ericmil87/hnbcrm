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
};
export type OffersState = { offerSeq: number; offers: OfferRecord[] };
export type OfferPick = {
  serviceId: SchedId;
  variantKey?: string;
  startTime: number;
  resourceIds: SchedId[];
  rescheduleOfId?: SchedId;
};

/** `OFFER_TTL_MS` e `OFFERS_KEPT` do plano (A1). UNIFICAR com `schedConstants`. */
const OFFER_TTL_MS = 30 * 60 * 1000;
const OFFERS_KEPT = 9;

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
    return rec;
  });
  const offers = [...state.offers, ...issued].slice(-keep);
  return { state: { offerSeq: seq, offers }, issued, batch };
}

/** Procura a oferta: `desconhecida` | `expirada` | `sem_resposta_do_cliente` (emitida depois da última mensagem do cliente, ou cliente nunca respondeu). */
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
  if (lastInboundAt === null || lastInboundAt === undefined || offer.issuedAt >= lastInboundAt) {
    return { ok: false, error: "sem_resposta_do_cliente" };
  }
  return { ok: true, offer };
}

/** `horario_tomado`: descarta todas as ofertas, exceto as do lote `keepBatch` (se informado). `offerSeq` nunca recua. */
export function invalidateOffers(state: OffersState, keepBatch?: number): OffersState {
  return {
    offerSeq: state.offerSeq,
    offers: keepBatch === undefined ? [] : state.offers.filter((o) => o.batch === keepBatch),
  };
}
