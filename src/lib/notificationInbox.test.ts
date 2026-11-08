import { describe, expect, it, vi } from "vitest";
import { ACTIONABLE_TYPES } from "../../convex/lib/notificationPolicy";
import { notificationTargetPath } from "../../convex/lib/notificationTargets";
import {
  TOAST_TYPES,
  appBadgeCount,
  bellAriaLabel,
  bellBadgeLabel,
  detectArrivals,
  seedWatermark,
  isResolved,
  itemActions,
  notificationHref,
  orgNewsParts,
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
    expect(orgNewsParts({ ...list[0], unseen: 1 })).toEqual({ prefix: "Você tem 1 novidade em", name: "Alfa" });
    expect(orgNewsParts(list[0])).toEqual({ prefix: "Você tem 2 novidades em", name: "Alfa" });
    expect(orgNewsParts(list[2])).toEqual({ prefix: "Você tem 20+ novidades em", name: "Gama" });
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

describe("detectArrivals (marca d'água por createdAt)", () => {
  const item = (over: Partial<ArrivalItem>): ArrivalItem => ({ _id: "a", type: "new_message", createdAt: 100, ...over });

  it("seedWatermark: máximo da janela; janela vazia semeia com 0", () => {
    expect(seedWatermark([item({ createdAt: 5 }), item({ createdAt: 9 })])).toBe(9);
    expect(seedWatermark([])).toBe(0);
  });

  it("avisa só o que é mais novo que a marca, uma vez", () => {
    const first = detectArrivals(100, [item({ _id: "b", type: "handoff_requested", createdAt: 150 }), item({})], null);
    expect(first.arrivals.map((a) => a._id)).toEqual(["b"]);
    expect(first.nextWatermark).toBe(150);
    const again = detectArrivals(first.nextWatermark, [item({ _id: "b", type: "handoff_requested", createdAt: 150 }), item({})], null);
    expect(again.arrivals).toEqual([]);
  });

  it("janela que desliza: item antigo que entra depois de ler/marcar tudo não avisa", () => {
    const r = detectArrivals(500, [item({ _id: "old1", createdAt: 200 }), item({ _id: "old2", createdAt: 100 })], null);
    expect(r.arrivals).toEqual([]);
    expect(r.nextWatermark).toBe(500);
  });

  it("markUnread pela própria pessoa: item antigo volta não lido e não avisa", () => {
    const r = detectArrivals(500, [item({ _id: "x", createdAt: 120, readAt: undefined })], null);
    expect(r.arrivals).toEqual([]);
  });

  it("aviso agrupado renovado (createdAt novo) avisa de novo", () => {
    const r = detectArrivals(100, [item({ createdAt: 300 })], null);
    expect(r.arrivals).toHaveLength(1);
    expect(r.nextWatermark).toBe(300);
  });

  it("não avisa a conversa aberta, mas avisa outra; a marca sobe mesmo assim", () => {
    const r = detectArrivals(
      0,
      [item({ _id: "x", conversationId: "c1", createdAt: 10 }), item({ _id: "y", conversationId: "c2", createdAt: 20 })],
      "c1",
    );
    expect(r.arrivals.map((a) => a._id)).toEqual(["y"]);
    expect(r.nextWatermark).toBe(20);
  });

  it("ignora informativos e já lidos; canal desconectado é acionável", () => {
    const r = detectArrivals(
      0,
      [
        item({ _id: "m", type: "campaign_completed", createdAt: 5 }),
        item({ _id: "r", readAt: 5, createdAt: 6 }),
        item({ _id: "l", type: "lead_assigned", createdAt: 7 }),
        item({ _id: "c", type: "channel_session_lost", createdAt: 8, conversationId: "c1" }),
      ],
      "c1",
    );
    expect(r.arrivals.map((a) => a._id)).toEqual(["c"]);
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

describe("appBadgeCount", () => {
  it("limita ao teto do push (20) e nunca fica negativo", () => {
    expect(appBadgeCount(3)).toBe(3);
    expect(appBadgeCount(57)).toBe(20);
    expect(appBadgeCount(-1)).toBe(0);
  });
});

describe("TOAST_TYPES", () => {
  it("deriva dos acionáveis do backend, sem lead_assigned, com ai_followup_needs_human", () => {
    expect(TOAST_TYPES.has("ai_followup_needs_human")).toBe(true);
    expect(TOAST_TYPES.has("lead_assigned")).toBe(false);
    expect(TOAST_TYPES.has("campaign_completed")).toBe(false);
    for (const t of ACTIONABLE_TYPES) if (t !== "lead_assigned") expect(TOAST_TYPES.has(t), t).toBe(true);
  });
});

describe("notificationHref usa o destino único do backend", () => {
  it("igual a notificationTargetPath para os tipos com push", () => {
    const cases = [
      n({ type: "ai_draft_pending" }),
      n({ type: "group_mention", conversationId: "c1" }),
      n({ type: "channel_session_lost", data: { metaConnectionId: "m1" } }),
      n({ type: "ai_followup_needs_human", taskId: "t9" }),
      n({ type: "task_overdue" }),
    ];
    for (const c of cases) {
      expect(notificationHref(c), c.type).toBe(
        notificationTargetPath(c.type, { conversationId: c.conversationId, handoffId: c.handoffId, taskId: c.taskId, data: c.data as Record<string, unknown> | undefined }),
      );
    }
    expect(notificationHref(n({ type: "ai_draft_pending" }))).toBe("/app/entrada");
  });
});

describe("resolvedLabel por motivo", () => {
  const r = (reason: string) => resolvedLabel(n({ type: "task_assigned", data: { resolvedReason: reason, resolvedAt: 1 } }));
  it.each([
    ["task_completed", "Tarefa concluída"],
    ["task_cancelled", "Tarefa cancelada"],
    ["task_deleted", "Tarefa excluída"],
    ["lead_deleted", "Lead excluído"],
    ["conversation_deleted", "Conversa excluída"],
    ["replied", "Você respondeu"],
    ["channel_reconnected", "Canal reconectado"],
  ])("%s -> %s", (reason, label) => {
    expect(r(reason)).toBe(label);
  });
  it("motivo desconhecido cai em Resolvido", () => {
    expect(r("outro")).toBe("Resolvido");
  });
});
