/// <reference types="vite/client" />
/**
 * Billing B3: queries de uso e `setOverage`. RBAC (agente não lê nada de
 * settings:view; vê só os entitlements sem preço), legacy (limits null),
 * multi-tenant, regras do excedente e extrato sem PII.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { resolvePermissions } from "./lib/permissions";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const MONTH = "2026-10";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

type Billing = Doc<"organizations">["billing"];

async function seedOrg(slug: string, billing?: Billing) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: { timezone: "UTC", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (role: "admin" | "manager" | "agent", email?: string) => {
      const userId = await ctx.db.insert("users", email ? { email } : {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name: role,
        role,
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await mk("admin", `adm-${slug}@acme.com.br`);
    const manager = await mk("manager", `mgr-${slug}@acme.com.br`);
    const agent = await mk("agent", `ag-${slug}@acme.com.br`);
    return { organizationId, admin, manager, agent };
  });
}
const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

const ACTIVE: Billing = {
  plan: "profissional",
  status: "active",
  units: undefined,
  priceLock: { kind: "frozen", monthlyBrl: 300 },
  updatedAt: 1,
};

describe("getMyEntitlements", () => {
  test("legacy: limits null, tudo liberado, sem plano", async () => {
    const s = await seedOrg("legacy-org");
    const e = await as(s.agent.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(e).toMatchObject({ mode: "legacy", planId: null, planLabel: null, limits: null, readOnly: false });
    expect(Object.values(e.features).every(Boolean)).toBe(true);
    expect(e.minPlanFor.central).toBe("empresa");
    expect(e.minPlanFor.api).toBe("profissional");
  });

  test("agente vê plano e limites, mas nunca preço, priceLock nem teto", async () => {
    const s = await seedOrg("paid-org", { ...ACTIVE, overage: { enabled: true, capBrl: 200, updatedAt: 1 } });
    const agent = await as(s.agent.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(agent).toMatchObject({
      mode: "active",
      planId: "profissional",
      planLabel: "Profissional",
      limits: { channels: 3, attendances: 1000, campaignSends: 5000, aiGroups: null },
      overage: { enabled: true, capBrl: null },
    });
    expect(agent).not.toHaveProperty("pricing");
    expect(JSON.stringify(agent)).not.toContain("priceLock");
    expect(agent.features).toMatchObject({ groups: true, central: false });

    const admin = await as(s.admin.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(admin.overage.capBrl).toBe(200);
    expect(admin.pricing).toEqual({ listMonthlyBrl: 497, priceLock: { kind: "frozen", monthlyBrl: 300 } });
  });

  test("teste, read_only e canceled", async () => {
    const trial = await seedOrg("trial-org", { plan: "essencial", status: "trial", trialEndsAt: 123, updatedAt: 1 });
    const e = await as(trial.admin.userId).query(api.billing.getMyEntitlements, { organizationId: trial.organizationId });
    expect(e).toMatchObject({ mode: "trial", planId: "profissional", trialEndsAt: 123, readOnly: false });
    expect(e.limits?.attendances).toBe(300);
    expect(e.pricing?.listMonthlyBrl).toBeNull();

    const ro = await seedOrg("ro-org", { plan: "escala", status: "read_only", updatedAt: 1 });
    const r = await as(ro.admin.userId).query(api.billing.getMyEntitlements, { organizationId: ro.organizationId });
    expect(r).toMatchObject({ mode: "read_only", readOnly: true, planId: "escala" });
    // O que o plano dá segue visível (read_only não "some" com os módulos).
    expect(r.features.groups).toBe(true);
  });

  test("não-membro e outra org não leem", async () => {
    const a = await seedOrg("org-a", ACTIVE);
    const b = await seedOrg("org-b", ACTIVE);
    await expect(as(b.admin.userId).query(api.billing.getMyEntitlements, { organizationId: a.organizationId })).rejects.toThrow();
  });
});

describe("RBAC das queries de settings:view", () => {
  test("agente recebe erro; gerente e admin leem", async () => {
    const s = await seedOrg("rbac-org", ACTIVE);
    const calls = (userId: Id<"users">) => [
      () => as(userId).query(api.billing.getUsageSummary, { organizationId: s.organizationId, month: MONTH }),
      () => as(userId).query(api.billing.getChannelAndGroupUsage, { organizationId: s.organizationId }),
      () => as(userId).query(api.billing.getUsageHistory, { organizationId: s.organizationId }),
      () =>
        as(userId).query(api.billing.listAttendances, {
          organizationId: s.organizationId,
          month: MONTH,
          paginationOpts: { numItems: 10, cursor: null },
        }),
    ];
    for (const call of calls(s.agent.userId)) await expect(call()).rejects.toThrow();
    for (const call of calls(s.admin.userId)) await expect(call()).resolves.toBeDefined();
  });

  test("multi-tenant: org B não lê o uso da org A", async () => {
    const a = await seedOrg("org-a2", ACTIVE);
    const b = await seedOrg("org-b2", ACTIVE);
    await expect(
      as(b.admin.userId).query(api.billing.getUsageSummary, { organizationId: a.organizationId, month: MONTH })
    ).rejects.toThrow();
    await expect(
      as(b.admin.userId).mutation(api.billing.setOverage, { organizationId: a.organizationId, enabled: true, capBrl: 100 })
    ).rejects.toThrow();
  });
});

describe("getUsageSummary", () => {
  test("uso do mês, créditos, limites e estimativa com priceLock", async () => {
    const s = await seedOrg("sum-org", { ...ACTIVE, priceLock: { kind: "frozen", monthlyBrl: 300 }, extraChannels: 1, updatedAt: 1 });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("aiUsageMonthly", {
        organizationId: s.organizationId,
        month: MONTH,
        costUsdMicros: 2_500_000,
        runs: 9,
        conversations: 2, // congelado (código antigo)
        byKind: { attendant: { runs: 9, costUsdMicros: 2_500_000 } },
        updatedAt: now,
      });
      await ctx.db.insert("orgUsageMonthly", {
        organizationId: s.organizationId,
        month: MONTH,
        campaignSends: 77,
        aiAttendances: 110,
        attendancesIncluded: 10,
        attendancesOverage: 100,
        attendancesSuggestOnly: 2,
        overageBrlCents: 4900,
        updatedAt: now,
      });
      await ctx.db.insert("usageCredits", {
        organizationId: s.organizationId,
        kind: "ai_attendances",
        granted: 1000,
        consumed: 400,
        expiresAt: Date.UTC(2027, 5, 1),
        source: "pack",
        createdAt: now,
      });
      // Pacote vencido antes do mês: fora.
      await ctx.db.insert("usageCredits", {
        organizationId: s.organizationId,
        kind: "ai_attendances",
        granted: 1000,
        consumed: 0,
        expiresAt: Date.UTC(2026, 8, 1),
        source: "pack",
        createdAt: now,
      });
    });
    const res = await as(s.admin.userId).query(api.billing.getUsageSummary, { organizationId: s.organizationId, month: MONTH });
    expect(res).toMatchObject({
      month: MONTH,
      mode: "active",
      planId: "profissional",
      attendances: { total: 112, included: 10, credit: 0, overage: 100, suggestOnly: 2, overageBrlCents: 4900, limit: 1000 },
      campaignSends: { used: 77, limit: 5000 },
      packBalance: 600,
      costUsdMicros: 2_500_000,
    });
    expect(res.credits).toHaveLength(1);
    expect(res.periodStart).toBe(Date.UTC(2026, 9, 1));
    expect(res.periodEnd).toBe(Date.UTC(2026, 10, 1));
    // base travada (300) + 1 canal extra (79) + 100 excedentes a R$ 0,49
    expect(res.estimate).toMatchObject({ recurringBrl: 379, overageBrl: 49, totalBrl: 428 });
    // Sem contagem de canais/grupos aqui (A7).
    expect(res).not.toHaveProperty("channels");
  });

  test("legacy: uso aparece, sem limites nem estimativa; mês inválido é recusado", async () => {
    const s = await seedOrg("legacy-sum");
    const res = await as(s.admin.userId).query(api.billing.getUsageSummary, { organizationId: s.organizationId, month: MONTH });
    expect(res).toMatchObject({ mode: "legacy", planId: null, estimate: null });
    expect(res.attendances.limit).toBeNull();
    await expect(
      as(s.admin.userId).query(api.billing.getUsageSummary, { organizationId: s.organizationId, month: "2026-13" })
    ).rejects.toThrow();
  });
});

describe("getChannelAndGroupUsage e getUsageHistory", () => {
  test("canais ativos (sem os desligados) e grupos com IA", async () => {
    const s = await seedOrg("chan-org", ACTIVE);
    await t.run(async (ctx) => {
      const now = Date.now();
      const base = { organizationId: s.organizationId, channel: "whatsapp" as const, provider: "meta" as const, createdAt: now, updatedAt: now };
      await ctx.db.insert("channelConfigs", { ...base, displayName: "A", phoneNumberId: "1", status: "active" });
      await ctx.db.insert("channelConfigs", { ...base, displayName: "B", phoneNumberId: "2", status: "disabled" });
      await ctx.db.insert("channelConfigs", { ...base, displayName: "C", phoneNumberId: "3", status: "error" });
    });
    const res = await as(s.admin.userId).query(api.billing.getChannelAndGroupUsage, { organizationId: s.organizationId });
    expect(res.channels).toEqual({ active: 2, limit: 3, truncated: false });
    expect(res.aiGroups).toEqual({ used: 0, limit: null, truncated: false });
  });

  test("histórico desc, limitado e com teto de meses", async () => {
    const s = await seedOrg("hist-org", ACTIVE);
    await t.run(async (ctx) => {
      for (const [m, n] of [["2026-08", 5], ["2026-09", 7], ["2026-10", 9]] as const) {
        await ctx.db.insert("aiUsageMonthly", { organizationId: s.organizationId, month: m, costUsdMicros: 0, runs: n, conversations: n, byKind: {}, updatedAt: 1 });
      }
      await ctx.db.insert("orgUsageMonthly", { organizationId: s.organizationId, month: "2026-09", campaignSends: 0, aiAttendances: 3, updatedAt: 1 });
      await ctx.db.insert("orgUsageMonthly", { organizationId: s.organizationId, month: "2026-07", campaignSends: 3, updatedAt: 1 });
      await ctx.db.insert("orgUsageMonthly", { organizationId: s.organizationId, month: "2026-10", campaignSends: 11, updatedAt: 1 });
    });
    const rows = await as(s.admin.userId).query(api.billing.getUsageHistory, { organizationId: s.organizationId, months: 3 });
    expect(rows.map((r) => r.month)).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(rows[0]).toMatchObject({ attendances: 9, campaignSends: 11 });
    // Congelado (7) + livro (3) no mês com os dois.
    expect(rows[1]).toMatchObject({ month: "2026-09", attendances: 10 });
    await expect(as(s.admin.userId).query(api.billing.getUsageHistory, { organizationId: s.organizationId, months: 13 })).rejects.toThrow();
  });
});

describe("listAttendances", () => {
  async function seedLedger(s: Awaited<ReturnType<typeof seedOrg>>) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", {
        organizationId: s.organizationId,
        firstName: "Maria",
        lastName: "Silva",
        email: "maria@exemplo.com.br",
        phone: "5585999990001",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        channel: "whatsapp",
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      } as never);
      await ctx.db.insert("aiAttendances", { organizationId: s.organizationId, month: MONTH, contactKey: String(contactId), conversationId, firstAt: now, billing: "overage", unitPriceBrlCents: 49 });
      await ctx.db.insert("aiAttendances", { organizationId: s.organizationId, month: MONTH, contactKey: "chave-solta", conversationId, firstAt: now, billing: "included" });
    });
  }

  test("sem PII; nome só com contacts:view, senão iniciais; filtro por classe", async () => {
    const s = await seedOrg("att-org", ACTIVE);
    await seedLedger(s);
    const opts = { numItems: 10, cursor: null };
    const admin = await as(s.admin.userId).query(api.billing.listAttendances, { organizationId: s.organizationId, month: MONTH, paginationOpts: opts });
    expect(admin.page).toHaveLength(2);
    const maria = admin.page.find((r) => r.billing === "overage")!;
    expect(maria).toMatchObject({ contactLabel: "Maria Silva", unitPriceBrlCents: 49 });
    const raw = JSON.stringify(admin);
    expect(raw).not.toMatch(/maria@|5585999990001|phone|email/i);

    // Gerente com contacts desligado: só iniciais.
    await t.run((ctx) =>
      ctx.db.patch(s.manager.memberId, { permissions: { ...resolvePermissions("manager"), contacts: "none" } as never })
    );
    const mgr = await as(s.manager.userId).query(api.billing.listAttendances, { organizationId: s.organizationId, month: MONTH, paginationOpts: opts });
    expect(mgr.page.find((r) => r.billing === "overage")?.contactLabel).toBe("M. S.");
    expect(JSON.stringify(mgr)).not.toContain("Maria");

    const only = await as(s.admin.userId).query(api.billing.listAttendances, { organizationId: s.organizationId, month: MONTH, billing: "included", paginationOpts: opts });
    expect(only.page).toHaveLength(1);
    await expect(
      as(s.admin.userId).query(api.billing.listAttendances, { organizationId: s.organizationId, month: MONTH, paginationOpts: { numItems: 500, cursor: null } })
    ).rejects.toThrow();
  });
});

describe("setOverage", () => {
  const audits = (id: Id<"organizations">) =>
    t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", id))
        .collect()
    );

  test("liga com teto, audita como high e o gate lê o teto", async () => {
    const s = await seedOrg("ov-org", ACTIVE);
    const res = await as(s.admin.userId).mutation(api.billing.setOverage, { organizationId: s.organizationId, enabled: true, capBrl: 250 });
    expect(res).toEqual({ enabled: true, capBrl: 250 });
    const org = await t.run((ctx) => ctx.db.get(s.organizationId));
    expect(org?.billing).toMatchObject({ status: "active", plan: "profissional", overage: { enabled: true, capBrl: 250, updatedBy: s.admin.memberId } });
    const log = (await audits(s.organizationId)).find((a) => a.metadata?.kind === "billing");
    expect(log).toMatchObject({ severity: "high", actorId: s.admin.memberId, metadata: { source: "customer" } });
    const ent = await as(s.admin.userId).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent.overage).toEqual({ enabled: true, capBrl: 250 });
    // Desligar sem informar o teto mantém o anterior.
    const off = await as(s.admin.userId).mutation(api.billing.setOverage, { organizationId: s.organizationId, enabled: false });
    expect(off).toEqual({ enabled: false, capBrl: 250 });
  });

  test("recusa teste, legacy, sem plano, só leitura e canceled com a mensagem 'Fale com a gente'", async () => {
    const cases: Array<[string, Billing | undefined]> = [
      ["ov-trial", { plan: "profissional", status: "trial", trialEndsAt: Date.now() + 1e9, updatedAt: 1 }],
      ["ov-legacy", { status: "legacy", updatedAt: 1 }],
      ["ov-none", undefined],
      ["ov-ro", { plan: "escala", status: "read_only", updatedAt: 1 }],
      ["ov-canceled", { plan: "escala", status: "canceled", updatedAt: 1 }],
    ];
    for (const [slug, billing] of cases) {
      const s = await seedOrg(slug, billing);
      await expect(
        as(s.admin.userId).mutation(api.billing.setOverage, { organizationId: s.organizationId, enabled: true, capBrl: 100 })
      ).rejects.toThrow(/Fale com a gente/);
      expect((await t.run((ctx) => ctx.db.get(s.organizationId)))?.billing?.overage).toBeUndefined();
    }
  });

  test("valida o teto (inteiro, 1 a 100.000) e a permissão", async () => {
    const s = await seedOrg("ov-val", ACTIVE);
    for (const capBrl of [0, -5, 12.5, 100_001, Number.NaN, Infinity]) {
      await expect(
        as(s.admin.userId).mutation(api.billing.setOverage, { organizationId: s.organizationId, enabled: true, capBrl })
      ).rejects.toThrow();
    }
    await expect(
      as(s.admin.userId).mutation(api.billing.setOverage, { organizationId: s.organizationId, enabled: true })
    ).rejects.toThrow(/teto/);
    for (const u of [s.manager.userId, s.agent.userId]) {
      await expect(
        as(u).mutation(api.billing.setOverage, { organizationId: s.organizationId, enabled: true, capBrl: 100 })
      ).rejects.toThrow();
    }
    expect((await t.run((ctx) => ctx.db.get(s.organizationId)))?.billing?.overage).toBeUndefined();
    await as(s.admin.userId).mutation(api.billing.setOverage, { organizationId: s.organizationId, enabled: true, capBrl: 100_000 });
  });

  test("conta sem e-mail não liga excedente (dinheiro)", async () => {
    const s = await seedOrg("ov-noemail", ACTIVE);
    await t.run(async (ctx) => {
      await ctx.db.replace(s.admin.userId, {});
    });
    await expect(
      as(s.admin.userId).mutation(api.billing.setOverage, { organizationId: s.organizationId, enabled: true, capBrl: 100 })
    ).rejects.toThrow();
  });
});
