import { describe, expect, it, vi } from "vitest";
import { selectReadNotifications } from "./readOnDevice";

const n = (notificationId: string, organizationId = "o1") => ({ data: { notificationId, organizationId }, close: vi.fn() });

describe("selectReadNotifications", () => {
  it("fecha só as que não estão mais entre as não lidas (lista completa)", () => {
    const shown = [n("a"), n("b"), n("c")];
    const out = selectReadNotifications(shown, { organizationId: "o1", unreadIds: ["b"], unreadTotal: 1 });
    expect(out).toEqual([shown[0], shown[2]]);
  });

  it("não conclui nada quando há mais não lidas do que a janela mostra", () => {
    const out = selectReadNotifications([n("a")], { organizationId: "o1", unreadIds: ["x"], unreadTotal: 30 });
    expect(out).toEqual([]);
  });

  it("ignora outra organização e notificações sem identidade", () => {
    const shown = [n("a", "o2"), { data: {}, close: vi.fn() }, { data: undefined, close: vi.fn() }];
    expect(selectReadNotifications(shown, { organizationId: "o1", unreadIds: [], unreadTotal: 0 })).toEqual([]);
  });

  it("aceita a identidade dentro de data.hnb", () => {
    const shown = [{ data: { hnb: { notificationId: "z", organizationId: "o1" } }, close: vi.fn() }];
    expect(selectReadNotifications(shown, { organizationId: "o1", unreadIds: [], unreadTotal: 0 })).toHaveLength(1);
  });
});
