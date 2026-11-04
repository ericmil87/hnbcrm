/// <reference types="vite/client" />
/**
 * v0.78.1 — Copilot read tools carry dates (ISO in the org tz + relative label)
 * and period filters ("quantos leads chegaram hoje e qual o valor?" in one call).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { localIso, relativeLabel, resolvePeriodBound, toolTime } from "./lib/copilotDates";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TZ = "America/Sao_Paulo";
// Tuesday 03/11/2026 15:00 local (18:00 UTC).
const NOW = Date.UTC(2026, 10, 3, 18, 0, 0);
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(() => vi.useRealTimers());

describe("lib/copilotDates", () => {
  test("ISO no fuso da org + rótulo relativo", () => {
    const at = Date.UTC(2026, 10, 3, 17, 20); // 14:20 local
    expect(localIso(at, TZ)).toBe("2026-11-03T14:20:00-03:00");
    expect(relativeLabel(at, NOW, TZ)).toBe("hoje 14:20");
    expect(relativeLabel(at - 24 * 3600_000, NOW, TZ)).toBe("ontem 14:20");
    expect(relativeLabel(NOW - 3 * 24 * 3600_000, NOW, TZ)).toBe("há 3 dias");
    expect(relativeLabel(NOW + 2 * 24 * 3600_000, NOW, TZ)).toBe("em 2 dias");
    expect(relativeLabel(Date.UTC(2026, 8, 12, 15), NOW, TZ)).toBe("12/09/2026");
    expect(toolTime(undefined, NOW, TZ)).toBeNull();
  });

  test("períodos resolvidos no fuso da org", () => {
    const midnight = Date.UTC(2026, 10, 3, 3, 0); // 00:00 local
    expect(resolvePeriodBound("hoje", "start", NOW, TZ)).toBe(midnight);
    expect(resolvePeriodBound("hoje", "end", NOW, TZ)).toBe(midnight + 24 * 3600_000);
    expect(resolvePeriodBound("ontem", "start", NOW, TZ)).toBe(midnight - 24 * 3600_000);
    expect(resolvePeriodBound("esta_semana", "start", NOW, TZ)).toBe(midnight - 24 * 3600_000); // Monday 02/11
    expect(resolvePeriodBound("este_mes", "start", NOW, TZ)).toBe(Date.UTC(2026, 10, 1, 3, 0));
    expect(resolvePeriodBound("2026-11-03", "start", NOW, TZ)).toBe(midnight);
    expect(resolvePeriodBound("2026-11-03T10:00", "start", NOW, TZ)).toBe(Date.UTC(2026, 10, 3, 13, 0));
    expect(resolvePeriodBound("2026-11-03T10:00:00Z", "start", NOW, TZ)).toBe(Date.UTC(2026, 10, 3, 10, 0));
    expect(resolvePeriodBound("semana que vem", "start", NOW, TZ)).toBeNull();
  });
});

async function seed() {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "eric@acme.test" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Acme", slug: "acme", settings: { timezone: TZ, currency: "BRL" }, createdAt: NOW, updatedAt: NOW,
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Eric Milfont", role: "admin", type: "human", status: "active", createdAt: NOW, updatedAt: NOW,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#000", isDefault: true, order: 0, createdAt: NOW, updatedAt: NOW });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#000", order: 0, isClosedWon: false, isClosedLost: false, createdAt: NOW, updatedAt: NOW,
    });
    const sourceId = await ctx.db.insert("leadSources", { organizationId, name: "Instagram", type: "social", isActive: true, createdAt: NOW });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Carla", lastName: "Dias", whatsappNumber: "5581999990000", tags: [], createdAt: NOW, updatedAt: NOW,
    });
    const lead = async (title: string, createdAt: number, value: number) =>
      await ctx.db.insert("leads", {
        organizationId, title, boardId, stageId, contactId, sourceId, assignedTo: memberId, value, currency: "BRL",
        priority: "medium", temperature: "warm", tags: ["passeio"], customFields: {}, conversationStatus: "active",
        lastActivityAt: createdAt, createdAt, updatedAt: createdAt,
      });
    const today1 = await lead("Carla Dias", Date.UTC(2026, 10, 3, 17, 20), 1000); // hoje 14:20
    await lead("Bruno", Date.UTC(2026, 10, 3, 12, 5), 500); // hoje 09:05
    await lead("Ontem", Date.UTC(2026, 10, 2, 20, 0), 300); // ontem
    return { organizationId, memberId, today1 };
  });
}
const read = (s: { organizationId: any; memberId: any }, name: string, args: Record<string, unknown>) =>
  t.query(internal.copilot.internalRunCopilotReadTool, {
    name, argsJson: JSON.stringify(args), organizationId: s.organizationId, memberId: s.memberId, now: NOW,
  });

describe("ferramentas de leitura do Copiloto com datas", () => {
  test("listLeads createdAfter:'hoje' → só os de hoje, count e totalValue numa chamada; datas ISO + rótulo", async () => {
    const s = await seed();
    const res: any = await read(s, "listLeads", { createdAfter: "hoje" });
    expect(res.count).toBe(2);
    expect(res.totalValue).toBe(1500);
    expect(res.currency).toBe("BRL");
    expect(res.capped).toBe(false);
    expect(res.period.from).toEqual({ iso: "2026-11-03T00:00:00-03:00", label: "hoje 00:00" });
    expect(res.leads.map((l: any) => l.title)).toEqual(["Carla Dias", "Bruno"]);
    expect(res.leads[0]).toMatchObject({
      createdAt: { iso: "2026-11-03T14:20:00-03:00", label: "hoje 14:20" },
      stageName: "Novo",
      boardName: "Vendas",
      assignedToName: "Eric Milfont",
      source: "Instagram",
      contactPhone: "5581999990000",
      tags: ["passeio"],
      closedAt: null,
      closedType: null,
    });
  });

  test("listLeads sem período: todos, ordem por createdAt desc; filtro inválido é ignorado e avisado", async () => {
    const s = await seed();
    const res: any = await read(s, "listLeads", { createdAfter: "semana que vem" });
    expect(res.count).toBe(3);
    expect(res.ignoredFilters).toEqual(["createdAfter"]);
    expect(res.leads[2].createdAt.label).toBe("ontem 17:00");
  });

  test("getLeadDetail traz createdAt no fuso da org e a timeline com {iso, label}", async () => {
    const s = await seed();
    const res: any = await read(s, "getLeadDetail", { leadId: s.today1 });
    expect(res.lead.createdAt).toEqual({ iso: "2026-11-03T14:20:00-03:00", label: "hoje 14:20" });
    expect(res.lead.source).toBe("Instagram");
  });

  test("listTasks dueBefore:'hoje' + leadTitle; datas formatadas", async () => {
    const s = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "Ligar", type: "task", status: "pending", priority: "medium",
        leadId: s.today1, assignedTo: s.memberId, createdBy: s.memberId, dueDate: Date.UTC(2026, 10, 3, 20, 0), createdAt: NOW, updatedAt: NOW,
      } as any);
      await ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "Semana que vem", type: "task", status: "pending", priority: "medium",
        createdBy: s.memberId, dueDate: Date.UTC(2026, 10, 10, 20, 0), createdAt: NOW, updatedAt: NOW,
      } as any);
    });
    const res: any = await read(s, "listTasks", { dueAfter: "hoje", dueBefore: "hoje" });
    expect(res.tasks.map((x: any) => x.title)).toEqual(["Ligar"]);
    expect(res.tasks[0]).toMatchObject({ dueDate: { label: "hoje 17:00" }, leadTitle: "Carla Dias" });
  });
});
