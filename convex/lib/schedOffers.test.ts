import { describe, expect, it } from "vitest";
import { consumeOffer, currentOffers, invalidateOffers, issueOffers, markShown, type OfferPick, type OffersState, resolveOffer } from "./schedOffers";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const empty: OffersState = { offerSeq: 0, offers: [] };
/** Marca todas as ofertas como mostradas ao cliente em `at`. */
const shown = (s: OffersState, at: number): OffersState => ({ ...s, offers: s.offers.map((o) => ({ ...o, shownAt: at })) });
const pick = (n: number, over: Partial<OfferPick> = {}): OfferPick => ({
  serviceId: "s1", startTime: T0 + n * 60 * MIN, resourceIds: ["r1"], ...over,
});

describe("issueOffers", () => {
  it("numera h1, h2, h3 a partir de offerSeq + 1, com validade de 30 min", () => {
    const { state, issued, batch } = issueOffers(empty, [pick(1), pick(2), pick(3)], T0);
    expect(issued.map((o) => o.code)).toEqual(["h1", "h2", "h3"]);
    expect(state.offerSeq).toBe(3);
    expect(batch).toBe(1);
    expect(issued.every((o) => o.batch === 1 && o.issuedAt === T0 && o.expiresAt === T0 + 30 * MIN)).toBe(true);
  });
  it("numeração contínua entre lotes; lote = número do primeiro código", () => {
    const a = issueOffers(empty, [pick(1), pick(2), pick(3)], T0);
    const b = issueOffers(a.state, [pick(4), pick(5)], T0 + MIN);
    expect(b.issued.map((o) => o.code)).toEqual(["h4", "h5"]);
    expect(b.batch).toBe(4);
    expect(b.state.offerSeq).toBe(5);
    expect(b.state.offers.map((o) => o.code)).toEqual(["h1", "h2", "h3", "h4", "h5"]);
  });
  it("mantém só as 9 últimas", () => {
    let s = empty;
    for (let i = 0; i < 4; i++) s = issueOffers(s, [pick(i), pick(i + 10), pick(i + 20)], T0).state;
    expect(s.offerSeq).toBe(12);
    expect(s.offers.map((o) => o.code)).toEqual(["h4", "h5", "h6", "h7", "h8", "h9", "h10", "h11", "h12"]);
  });
  it("copia variante e remarcação; não muta o estado de entrada", () => {
    const input: OffersState = { offerSeq: 2, offers: [] };
    const { issued } = issueOffers(input, [pick(1, { variantKey: "longa", rescheduleOfId: "ap9", resourceIds: ["r1", "p1"] })], T0);
    expect(issued[0]).toMatchObject({ code: "h3", variantKey: "longa", rescheduleOfId: "ap9", resourceIds: ["r1", "p1"] });
    expect(input).toEqual({ offerSeq: 2, offers: [] });
  });
  it("sem picks não gasta número", () => {
    expect(issueOffers({ offerSeq: 4, offers: [] }, [], T0).state.offerSeq).toBe(4);
  });
});

describe("resolveOffer", () => {
  const state = shown(issueOffers(empty, [pick(1), pick(2)], T0).state, T0);
  const reply = T0 + MIN; // cliente respondeu depois da emissão

  it("aceita oferta emitida antes da última mensagem do cliente e ainda válida", () => {
    const r = resolveOffer(state, "h2", T0 + 2 * MIN, reply);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.offer.code).toBe("h2");
  });
  it("aceita o código com caixa e espaços diferentes", () => {
    expect(resolveOffer(state, " H1 ", T0 + 2 * MIN, reply).ok).toBe(true);
  });
  it("desconhecida (nunca emitida ou já descartada pela janela de 9)", () => {
    expect(resolveOffer(state, "h9", T0 + 2 * MIN, reply)).toEqual({ ok: false, error: "desconhecida" });
    expect(resolveOffer(state, "", T0 + 2 * MIN, reply)).toEqual({ ok: false, error: "desconhecida" });
    expect(resolveOffer(state, "x1", T0 + 2 * MIN, reply)).toEqual({ ok: false, error: "desconhecida" });
  });
  it("expirada a partir de 30 min (limite exato já expira)", () => {
    expect(resolveOffer(state, "h1", T0 + 30 * MIN - 1, T0 + 29 * MIN).ok).toBe(true);
    expect(resolveOffer(state, "h1", T0 + 30 * MIN, T0 + 29 * MIN)).toEqual({ ok: false, error: "expirada" });
  });
  it("oferta posterior à última mensagem do cliente é recusada (read-back)", () => {
    expect(resolveOffer(state, "h1", T0 + 2 * MIN, T0 - MIN)).toEqual({ ok: false, error: "sem_resposta_do_cliente" });
    expect(resolveOffer(state, "h1", T0 + 2 * MIN, T0)).toEqual({ ok: false, error: "sem_resposta_do_cliente" }); // mesmo instante não prova nada
    expect(resolveOffer(state, "h1", T0 + 2 * MIN, null)).toEqual({ ok: false, error: "sem_resposta_do_cliente" });
    expect(resolveOffer(state, "h1", T0 + 2 * MIN, undefined)).toEqual({ ok: false, error: "sem_resposta_do_cliente" });
  });
  it("lote novo emitido depois da resposta do cliente exige nova resposta", () => {
    const second = shown(issueOffers(state, [pick(3)], T0 + 5 * MIN).state, T0 + 5 * MIN);
    expect(resolveOffer(second, "h3", T0 + 6 * MIN, T0 + 4 * MIN)).toEqual({ ok: false, error: "sem_resposta_do_cliente" });
    expect(resolveOffer(second, "h3", T0 + 7 * MIN, T0 + 6 * MIN).ok).toBe(true);
    expect(resolveOffer(second, "h1", T0 + 7 * MIN, T0 + 6 * MIN).ok).toBe(true); // lote antigo ainda vale até ser invalidado
  });
});

describe("oferta MOSTRADA (shownAt)", () => {
  const issued = issueOffers(empty, [pick(1), pick(2)], T0).state;
  it("sem shownAt a oferta nunca vale, mesmo com o cliente falando depois (turno falho, rascunho não aprovado)", () => {
    expect(resolveOffer(issued, "h1", T0 + 9 * MIN, T0 + 5 * MIN)).toEqual({ ok: false, error: "sem_resposta_do_cliente" });
  });
  it("shownAt precisa ser ANTES da última mensagem do cliente", () => {
    const s = shown(issued, T0 + 3 * MIN);
    expect(resolveOffer(s, "h1", T0 + 9 * MIN, T0 + 3 * MIN).ok).toBe(false);
    expect(resolveOffer(s, "h1", T0 + 9 * MIN, T0 + 4 * MIN).ok).toBe(true);
  });
  it("markShown marca só os códigos pedidos, uma vez (não regrava) e não muta", () => {
    const a = markShown(issued, new Set(["h2"]), T0 + MIN);
    expect(a.offers.map((o) => o.shownAt)).toEqual([undefined, T0 + MIN]);
    const b = markShown(a, new Set(["h1", "h2"]), T0 + 5 * MIN);
    expect(b.offers.map((o) => o.shownAt)).toEqual([T0 + 5 * MIN, T0 + MIN]);
    expect(issued.offers.every((o) => o.shownAt === undefined)).toBe(true);
    expect(markShown(issued, new Set(), T0)).toBe(issued);
  });
  it("currentOffers: só as mostradas e não vencidas", () => {
    const s = markShown(issued, new Set(["h1"]), T0 + MIN);
    expect(currentOffers(s, T0 + 2 * MIN).map((o) => o.code)).toEqual(["h1"]);
    expect(currentOffers(s, T0 + 31 * MIN)).toEqual([]);
  });
});

describe("invalidateOffers (horario_tomado)", () => {
  const a = issueOffers(empty, [pick(1), pick(2)], T0);
  const b = issueOffers(a.state, [pick(3), pick(4)], T0 + MIN);
  it("sem keepBatch descarta tudo mas o contador nunca recua", () => {
    const s = invalidateOffers(b.state);
    expect(s).toEqual({ offerSeq: 4, offers: [] });
    expect(issueOffers(s, [pick(5)], T0 + 2 * MIN).issued[0].code).toBe("h5");
  });
  it("com keepBatch descarta os lotes antigos e mantém o indicado", () => {
    const s = invalidateOffers(b.state, b.batch);
    expect(s.offers.map((o) => o.code)).toEqual(["h3", "h4"]);
    expect(s.offerSeq).toBe(4);
    expect(resolveOffer(s, "h1", T0 + 3 * MIN, T0 + 2 * MIN)).toEqual({ ok: false, error: "desconhecida" });
  });
  it("lote novo depois de invalidar tudo não reaproveita o número de lote", () => {
    const cleared = invalidateOffers(b.state);
    const c = issueOffers(cleared, [pick(5)], T0 + 3 * MIN);
    expect(c.batch).toBe(5);
    expect(c.batch).not.toBe(a.batch);
    expect(c.batch).not.toBe(b.batch);
  });
  it("não muta a entrada", () => {
    const before = JSON.stringify(b.state);
    invalidateOffers(b.state, 1);
    expect(JSON.stringify(b.state)).toBe(before);
  });
});

describe("teto, consumo e validação (regressão da revisão)", () => {
  it("keep 0, negativo ou fracionário lança; lote maior que o teto lança", () => {
    for (const keep of [0, -1, 1.5]) expect(() => issueOffers(empty, [pick(1)], T0, { keep })).toThrow(/keep/);
    expect(() => issueOffers(empty, [pick(1), pick(2), pick(3)], T0, { keep: 2 })).toThrow(/teto/);
    expect(() => issueOffers(empty, Array.from({ length: 10 }, (_, i) => pick(i)), T0)).toThrow(/teto de 9/);
    expect(issueOffers(empty, [pick(1), pick(2)], T0, { keep: 2 }).state.offers).toHaveLength(2);
    expect(() => issueOffers(empty, [pick(1)], T0, { ttlMs: 0 })).toThrow();
  });
  it("resolveOffer não consome; consumeOffer remove só o código usado e preserva offerSeq", () => {
    const state = shown(issueOffers(empty, [pick(1), pick(2), pick(3)], T0).state, T0);
    const reply = T0 + MIN;
    expect(resolveOffer(state, "h2", T0 + 2 * MIN, reply).ok).toBe(true);
    expect(resolveOffer(state, "h2", T0 + 2 * MIN, reply).ok).toBe(true); // ainda vale
    const after = consumeOffer(state, " H2 ");
    expect(after.offers.map((o) => o.code)).toEqual(["h1", "h3"]);
    expect(after.offerSeq).toBe(3);
    expect(resolveOffer(after, "h2", T0 + 2 * MIN, reply)).toEqual({ ok: false, error: "desconhecida" });
    expect(consumeOffer(after, "h9")).toEqual(after);
    expect(state.offers).toHaveLength(3); // não muta
  });
});
