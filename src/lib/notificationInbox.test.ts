import { describe, expect, it, vi } from "vitest";
import {
  bellAriaLabel,
  bellBadgeLabel,
  detectArrivals,
  isResolved,
  itemActions,
  notificationHref,
  orgNewsSentence,
  otherOrgNews,
  RESOLVED_CANNOT_REOPEN,
  resolvedLabel,
  shouldFillPage,
  toggleRead,
  withCountPrefix,
  type InboxNotification,
} from "./notificationInbox";
import type { ArrivalItem } from "./notificationInbox";

const n = (over: Record<string, unknown>) =>
  ({ _id: "n1", type: "new_message", createdAt: 1, title: "t", ...over }) as unknown as InboxNotification;

describe("badges", () => {
  it("99+ no teto do servidor e nada quando zero", () => {
    expect(bellBadgeLabel(0)).toBeNull();
    expect(bellBadgeLabel(7)).toBe("7");
    expect(bellBadgeLabel(100)).toBe("99+");
  });
  it("aria-label do sino diz o estado", () => {
    expect(bellAriaLabel(0, 0)).toBe("Notificações");
    expect(bellAriaLabel(1, 4)).toBe("Notificações, 1 nova");
    expect(bellAriaLabel(3, 4)).toBe("Notificações, 3 novas");
    expect(bellAriaLabel(0, 4)).toBe("Notificações, 4 não lidas");
  });
});

describe("multi-org", () => {
  const list = [
    { organizationId: "a", organizationName: "Alfa", unread: 3, unseen: 2 },
    { organizationId: "b", organizationName: "Beta", unread: 5, unseen: 0 },
    { organizationId: "c", organizationName: "Gama", unread: 20, unseen: 20 },
  ];
  it("ignora a org ativa e as sem novidade", () => {
    expect(otherOrgNews(list, "a").map((o) => o.organizationId)).toEqual(["c"]);
    expect(otherOrgNews(list, null).map((o) => o.organizationId)).toEqual(["a", "c"]);
    expect(otherOrgNews(undefined, "a")).toEqual([]);
  });
  it("frase com singular, plural e 20+", () => {
    expect(orgNewsSentence({ ...list[0], unseen: 1 })).toBe("Você tem 1 novidade em Alfa");
    expect(orgNewsSentence(list[0])).toBe("Você tem 2 novidades em Alfa");
    expect(orgNewsSentence(list[2])).toBe("Você tem 20+ novidades em Gama");
  });
});

describe("resolvido", () => {
  it("Assumido por {nome} no pedido de ajuda", () => {
    const item = n({ type: "handoff_requested", readAt: 5, data: { resolvedBy: "m1", resolvedReason: "accepted" }, resolvedByName: "Ana" });
    expect(isResolved(item)).toBe(true);
    expect(resolvedLabel(item)).toBe("Assumido por Ana");
  });
  it("expirado por tempo não conta como resolvido", () => {
    expect(isResolved(n({ data: { resolvedReason: "expired_unread" } }))).toBe(false);
  });
  it("sem marca de resolução devolve null", () => {
    expect(resolvedLabel(n({}))).toBeNull();
  });
});

describe("notificationHref", () => {
  it("lead_assigned abre o lead", () => {
    expect(notificationHref(n({ type: "lead_assigned", leadId: "L1" }))).toBe("/app/pipeline?lead=L1");
    expect(notificationHref(n({ type: "lead_assigned", leadId: null, data: { leadId: "L2" } }))).toBe("/app/pipeline?lead=L2");
    expect(notificationHref(n({ type: "lead_assigned", leadId: null }))).toBeNull();
  });
  it("rotas existentes continuam", () => {
    expect(notificationHref(n({ type: "handoff_requested", handoffId: "h1" }))).toBe("/app/repasses?handoff=h1");
    expect(notificationHref(n({ type: "new_message", conversationId: "c1" }))).toBe("/app/entrada?conversation=c1");
    expect(notificationHref(n({ type: "task_assigned", taskId: "t1" }))).toBe("/app/tarefas?task=t1");
  });
});

describe("itemActions", () => {
  it("assumir, revisar e adiar por tipo; nenhuma se resolvido", () => {
    expect(itemActions(n({ type: "handoff_requested", handoffId: "h" }))).toEqual(["assume"]);
    expect(itemActions(n({ type: "ai_draft_pending", conversationId: "c" }))).toEqual(["review"]);
    expect(itemActions(n({ type: "task_due_soon", taskId: "t" }))).toEqual(["snooze"]);
    expect(itemActions(n({ type: "task_assigned", taskId: "t" }))).toEqual([]);
    expect(itemActions(n({ type: "handoff_requested", handoffId: "h", data: { resolvedBy: "m" } }))).toEqual([]);
  });
});

describe("shouldFillPage", () => {
  const base = { group: "tarefas", status: "CanLoadMore", visibleCount: 3, pageSize: 15, loads: 0 };
  it("continua pedindo com grupo e página curta, com teto", () => {
    expect(shouldFillPage(base)).toBe(true);
    expect(shouldFillPage({ ...base, loads: 12 })).toBe(false);
    expect(shouldFillPage({ ...base, visibleCount: 15 })).toBe(false);
    expect(shouldFillPage({ ...base, group: null })).toBe(false);
    expect(shouldFillPage({ ...base, status: "Exhausted" })).toBe(false);
  });
});

describe("toggleRead", () => {
  it("marca como lida quando não lida", async () => {
    const markRead = vi.fn().mockResolvedValue(null);
    const markUnread = vi.fn();
    expect((await toggleRead({ readAt: undefined }, { markRead, markUnread })).kind).toBe("read");
    expect(markRead).toHaveBeenCalled();
    expect(markUnread).not.toHaveBeenCalled();
  });
  it("markUnread false vira recusa explicada", async () => {
    const res = await toggleRead({ readAt: 3 }, { markRead: vi.fn(), markUnread: vi.fn().mockResolvedValue(false) });
    expect(res).toEqual({ kind: "refused", message: RESOLVED_CANNOT_REOPEN });
  });
  it("markUnread true reabre", async () => {
    const res = await toggleRead({ readAt: 3 }, { markRead: vi.fn(), markUnread: vi.fn().mockResolvedValue(true) });
    expect(res.kind).toBe("unread");
  });
});

describe("detectArrivals", () => {
  const item = (over: Partial<ArrivalItem>): ArrivalItem => ({ _id: "a", type: "new_message", createdAt: 1, ...over });

  it("carga inicial só semeia", () => {
    const r = detectArrivals(null, [item({})], null);
    expect(r.arrivals).toEqual([]);
    expect(r.nextSeen.has("a:1")).toBe(true);
  });
  it("avisa o novo acionável uma vez só", () => {
    const first = detectArrivals(null, [item({})], null);
    const second = detectArrivals(first.nextSeen, [item({ _id: "b", type: "handoff_requested" }), item({})], null);
    expect(second.arrivals.map((a) => a._id)).toEqual(["b"]);
    const third = detectArrivals(second.nextSeen, [item({ _id: "b", type: "handoff_requested" }), item({})], null);
    expect(third.arrivals).toEqual([]);
  });
  it("aviso agrupado renovado (novo createdAt) avisa de novo", () => {
    const seeded = detectArrivals(null, [item({})], null);
    const r = detectArrivals(seeded.nextSeen, [item({ createdAt: 9 })], null);
    expect(r.arrivals).toHaveLength(1);
  });
  it("não avisa a conversa que está aberta, mas avisa outra", () => {
    const seeded = detectArrivals(null, [], null);
    const r = detectArrivals(
      seeded.nextSeen,
      [item({ _id: "x", conversationId: "c1" }), item({ _id: "y", conversationId: "c2" })],
      "c1",
    );
    expect(r.arrivals.map((a) => a._id)).toEqual(["y"]);
  });
  it("ignora informativos e já lidos", () => {
    const seeded = detectArrivals(null, [], null);
    const r = detectArrivals(
      seeded.nextSeen,
      [item({ _id: "m", type: "campaign_completed" }), item({ _id: "r", readAt: 5 }), item({ _id: "l", type: "lead_assigned" })],
      null,
    );
    expect(r.arrivals).toEqual([]);
  });
});

describe("withCountPrefix", () => {
  it("prefixa, troca e remove", () => {
    expect(withCountPrefix("Conversas · HNBCRM", 3)).toBe("(3) Conversas · HNBCRM");
    expect(withCountPrefix("(3) Conversas · HNBCRM", 5)).toBe("(5) Conversas · HNBCRM");
    expect(withCountPrefix("(3) Conversas · HNBCRM", 0)).toBe("Conversas · HNBCRM");
    expect(withCountPrefix("Painel", 250)).toBe("(99+) Painel");
  });
});
