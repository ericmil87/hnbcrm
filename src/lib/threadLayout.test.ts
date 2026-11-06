import { describe, expect, it } from "vitest";
import { layoutThread, RUN_GAP_MS, senderKey, senderLabelKind, type LayoutMessage } from "./threadLayout";

const T0 = new Date(2026, 10, 6, 10, 0).getTime();
let seq = 0;
const msg = (over: Partial<LayoutMessage>): LayoutMessage => ({
  _id: `m${++seq}`,
  direction: "inbound",
  senderType: "contact",
  isInternal: false,
  createdAt: T0,
  ...over,
});
const inbound = (at: number, over: Partial<LayoutMessage> = {}) => msg({ createdAt: at, ...over });
const mine = (at: number) => msg({ direction: "outbound", senderType: "user", senderId: "me", createdAt: at });
const other = (at: number) => msg({ direction: "outbound", senderType: "user", senderId: "ana", createdAt: at });
const ai = (at: number) => msg({ direction: "outbound", senderType: "ai", senderId: "bot", createdAt: at });
const ctx = { isGroup: false, currentMemberId: "me" };

describe("senderLabelKind", () => {
  it("1 a 1: contato e o próprio operador sem rótulo; IA, colega e nota com rótulo", () => {
    expect(senderLabelKind(inbound(T0), ctx)).toBeNull();
    expect(senderLabelKind(mine(T0), ctx)).toBeNull();
    expect(senderLabelKind(other(T0), ctx)).toBe("team");
    expect(senderLabelKind(ai(T0), ctx)).toBe("ai");
    expect(senderLabelKind(msg({ isInternal: true, direction: "outbound", senderType: "user", senderId: "me" }), ctx)).toBe("note");
  });
  it("grupo: membro da sala leva nome; aparelho e envio sem autor não", () => {
    expect(senderLabelKind(inbound(T0, { senderLid: "1@lid" }), { ...ctx, isGroup: true })).toBe("group");
    expect(senderLabelKind(msg({ direction: "outbound", senderType: "user", metadata: { via: "device" } }), ctx)).toBeNull();
    expect(senderLabelKind(msg({ direction: "outbound", senderType: "user" }), ctx)).toBeNull();
  });
});

describe("layoutThread", () => {
  it("agrupa o mesmo remetente dentro de 5 min e quebra no intervalo maior", () => {
    const list = [inbound(T0), inbound(T0 + 60_000), inbound(T0 + 60_000 + RUN_GAP_MS + 1), mine(T0 + 10 * 60_000)];
    const l = layoutThread(list, ctx);
    expect(l.map((x) => [x.first, x.last])).toEqual([
      [true, false],
      [false, true],
      [true, true],
      [true, true],
    ]);
    expect(l.every((x) => !x.showSender)).toBe(true);
    expect(l.map((x) => x.daySeparator)).toEqual([true, false, false, false]);
  });

  it("rótulo só na primeira do bloco; troca de remetente abre bloco", () => {
    const list = [ai(T0), ai(T0 + 1000), other(T0 + 2000), other(T0 + 3000), mine(T0 + 4000)];
    expect(layoutThread(list, ctx).map((x) => x.showSender)).toEqual([true, false, true, false, false]);
  });

  it("grupo: membros diferentes são blocos diferentes", () => {
    const list = [inbound(T0, { senderLid: "a" }), inbound(T0 + 1, { senderLid: "a" }), inbound(T0 + 2, { senderLid: "b" })];
    expect(layoutThread(list, { ...ctx, isGroup: true }).map((x) => x.showSender)).toEqual([true, false, true]);
  });

  it("evento no meio quebra o bloco e não leva rótulo", () => {
    const event = inbound(T0 + 2, { _id: "event" });
    const list = [inbound(T0), event, inbound(T0 + 3)];
    const l = layoutThread(list, { ...ctx, isBubble: (m) => m._id !== "event" });
    expect(l.map((x) => x.first)).toEqual([true, true, true]);
    expect(l[0].last).toBe(true);
  });

  it("separador de dia na virada", () => {
    const tomorrow = new Date(2026, 10, 7, 0, 1).getTime();
    const list = [inbound(new Date(2026, 10, 6, 23, 58).getTime()), inbound(tomorrow)];
    const l = layoutThread(list, ctx);
    expect(l.map((x) => x.daySeparator)).toEqual([true, true]);
    expect(l[1].first).toBe(true);
  });

  it("nota interna não se mistura com a mensagem do mesmo operador", () => {
    const note = msg({ isInternal: true, direction: "outbound", senderType: "user", senderId: "me", createdAt: T0 + 1 });
    expect(senderKey(note)).not.toBe(senderKey(mine(T0)));
  });
});
