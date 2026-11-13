import { describe, expect, it } from "vitest";
import { computeUnreadMarker, stepUnreadMarker, unreadDividerLabel } from "./unreadDivider";

const m = (id: string, direction = "inbound", extra = {}) => ({ _id: id, conversationId: "c1", direction, ...extra });

describe("computeUnreadMarker", () => {
  it("a primeira não lida são as últimas N recebidas", () => {
    const msgs = [m("a"), m("b", "outbound"), m("c"), m("d", "outbound"), m("e"), m("f")];
    expect(computeUnreadMarker(msgs, 2)).toEqual({ firstUnreadId: "e", count: 2 });
    expect(computeUnreadMarker(msgs, 3)).toEqual({ firstUnreadId: "c", count: 3 });
  });
  it("ignora nota interna", () => {
    const msgs = [m("a"), m("n", "inbound", { isInternal: true }), m("b")];
    expect(computeUnreadMarker(msgs, 1)?.firstUnreadId).toBe("b");
  });
  it("fora da página carregada: topo do que está carregado", () => {
    const msgs = [m("a", "outbound"), m("b"), m("c")];
    expect(computeUnreadMarker(msgs, 40)).toEqual({ firstUnreadId: "a", count: 40 });
  });
  it("nada não lido ou sem recebidas: sem divisor", () => {
    expect(computeUnreadMarker([m("a")], 0)).toBeNull();
    expect(computeUnreadMarker([m("a", "outbound")], 2)).toBeNull();
    expect(computeUnreadMarker([], 2)).toBeNull();
  });
});

describe("stepUnreadMarker", () => {
  const doc = { _id: "c1", unreadCount: 2 };
  it("espera o doc da conversa", () => {
    expect(stepUnreadMarker(null, { conversationId: "c1", doc: undefined, messages: [m("a")] })).toBeNull();
    expect(stepUnreadMarker(null, { conversationId: "c1", doc: { _id: "c0", unreadCount: 3 }, messages: [m("a")] })).toBeNull();
  });
  it("captura o contador e espera as mensagens", () => {
    const s = stepUnreadMarker(null, { conversationId: "c1", doc, messages: undefined });
    expect(s).toMatchObject({ resolved: false, unreadCount: 2 });
  });
  it("resolve com as mensagens e fica fixo mesmo se o contador zerar ou chegar mensagem", () => {
    const s1 = stepUnreadMarker(null, { conversationId: "c1", doc, messages: [m("a"), m("b"), m("c")] })!;
    expect(s1.marker).toEqual({ firstUnreadId: "b", count: 2 });
    const s2 = stepUnreadMarker(s1, {
      conversationId: "c1",
      doc: { _id: "c1", unreadCount: 0 },
      messages: [m("a"), m("b"), m("c"), m("d")],
    })!;
    expect(s2).toBe(s1);
  });
  it("tudo lido: resolvido sem divisor, sem esperar mensagens", () => {
    const s = stepUnreadMarker(null, { conversationId: "c1", doc: { _id: "c1", unreadCount: 0 }, messages: undefined })!;
    expect(s).toMatchObject({ resolved: true, marker: null });
  });
  it("trocar de conversa descarta o estado anterior", () => {
    const s1 = stepUnreadMarker(null, { conversationId: "c1", doc, messages: [m("a"), m("b")] })!;
    expect(stepUnreadMarker(s1, { conversationId: "c2", doc: undefined, messages: [] })).toBeNull();
  });
  it("ignora lote de outra conversa", () => {
    const s = stepUnreadMarker(null, {
      conversationId: "c1",
      doc,
      messages: [{ _id: "x", conversationId: "c0", direction: "inbound" }],
    })!;
    expect(s.resolved).toBe(false);
  });
});

describe("unreadDividerLabel", () => {
  it("singular e plural", () => {
    expect(unreadDividerLabel(1)).toBe("1 mensagem não lida");
    expect(unreadDividerLabel(5)).toBe("5 mensagens não lidas");
    expect(unreadDividerLabel(0)).toBe("Mensagens não lidas");
  });
});
