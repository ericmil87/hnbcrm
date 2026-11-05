import { describe, expect, it } from "vitest";
import { NAV_ITEMS, visibleNavItems } from "@/lib/nav";
import { badgeQueriesFor } from "./useNavBadges";

const byId = (...ids: string[]) => NAV_ITEMS.filter((i) => ids.includes(i.id));

describe("badgeQueriesFor", () => {
  it("pula tudo quando nenhum item com badge está visível", () => {
    expect(badgeQueriesFor(byId("dashboard", "tasks"))).toEqual({
      inboxUnread: false,
      pendingAttention: false,
      pausedCampaigns: false,
    });
  });

  it("liga só a consulta do item visível", () => {
    expect(badgeQueriesFor(byId("inbox"))).toEqual({
      inboxUnread: true,
      pendingAttention: false,
      pausedCampaigns: false,
    });
    expect(badgeQueriesFor(byId("campaigns")).pausedCampaigns).toBe(true);
  });

  it("liga as três com acesso total", () => {
    const all = visibleNavItems(() => true, { central: true });
    expect(badgeQueriesFor(all)).toEqual({ inboxUnread: true, pendingAttention: true, pausedCampaigns: true });
  });

  it("sem permissão nenhuma só o Painel fica visível e tudo é pulado", () => {
    const items = visibleNavItems(() => false, {});
    expect(items.map((i) => i.id)).toEqual(["dashboard"]);
    expect(Object.values(badgeQueriesFor(items))).toEqual([false, false, false]);
  });
});
