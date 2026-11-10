/// <reference types="vite/client" />
/**
 * Billing B4: avisos de uso (80% e 100% da franquia de IA e de envios, teto do excedente).
 * 1x por limiar por mes (carimbo antes de notificar), nunca para org legacy, so para quem
 * tem `settings:manage`; `billing.usageAlert` -> `usageLevel` em `getMyEntitlements`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { recordAttendance } from "./lib/attendanceLedger";
import { maybeNotifyPlanUsage, notifyBillingAdmins } from "./lib/billingNotify";
import { bumpCampaignSends } from "./lib/usageMeter";
import { applySubscriptionChange } from "./lib/entitlementsOps";
import { attendancesUsedInPeriod } from "./lib/attendanceUsage";
import { attendancePeriodStart } from "./lib/entitlements";

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

async function seed(billing: Billing) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Avisos",
      slug: "org-avisos",
      settings: { timezone: "UTC", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const mkMember = async (name: string, role: "admin" | "manager" | "agent") => {
      const userId = await ctx.db.insert("users", { name, email: `${name}@example.com` });
      return await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name,
        role,
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    };
    const adminId = await mkMember("admin", "admin");
    const agentId = await mkMember("agente", "agent");
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      channel: "whatsapp",
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    } as never);
    return { organizationId, adminId, agentId, conversationId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

const paid = (extra: Partial<NonNullable<Billing>> = {}): NonNullable<Billing> => ({
  plan: "profissional",
  status: "active",
  overrides: { aiAttendances: 10, campaignSends: 10 },
  updatedAt: 1,
  ...extra,
});

/** Atendimentos `included` ate `n` contatos no total, avisando como o commit faz. */
async function attendUpTo(s: Seed, from: number, to: number) {
  for (let i = from; i <= to; i++) {
    await t.run(async (ctx) => {
      await recordAttendance(ctx, {
        organizationId: s.organizationId,
        month: MONTH,
        contactKey: `c-${i}`,
        conversationId: s.conversationId,
        firstAt: Date.now(),
        billing: "included",
        mode: "live",
      });
      await maybeNotifyPlanUsage(ctx, { organizationId: s.organizationId, now: Date.now() });
    });
  }
}

const notes = (memberId: Id<"teamMembers">) =>
  t.run((ctx) => ctx.db.query("notifications").withIndex("by_member_and_created", (q) => q.eq("memberId", memberId)).collect());
const orgOf = (id: Id<"organizations">) => t.run((ctx) => ctx.db.get(id));

describe("avisos de franquia de IA", () => {
  test("80% e 100% avisam uma vez so; depois nada", async () => {
    const s = await seed(paid());
    await attendUpTo(s, 1, 7);
    expect(await notes(s.adminId)).toHaveLength(0);
    await attendUpTo(s, 8, 9); // 80% e 90%
    let list = await notes(s.adminId);
    expect(list.map((n) => n.type)).toEqual(["plan_usage_warning"]);
    expect(list[0].data).toMatchObject({ meter: "ai", month: MONTH });
    await attendUpTo(s, 10, 14); // cruza 100% e passa
    list = await notes(s.adminId);
    expect(list.map((n) => n.type).sort()).toEqual(["plan_usage_reached", "plan_usage_warning"]);
    const meter = await t.run((ctx) =>
      ctx.db.query("orgUsageMonthly").withIndex("by_organization_and_month", (q) => q.eq("organizationId", s.organizationId).eq("month", MONTH)).unique()
    );
    expect(meter?.planWarnedAt).toBeDefined();
    expect(meter?.planReachedAt).toBeDefined();
    expect((await orgOf(s.organizationId))?.billing?.usageAlert).toEqual({ month: MONTH, ai: "limit100" });
  });

  test("cruzar 100% de uma vez manda so o de 100% e carimba os dois", async () => {
    const s = await seed(paid());
    // 9 contatos entram sem avisar (ex.: varios commits no mesmo instante), o 10o cruza direto.
    await t.run(async (ctx) => {
      for (let i = 1; i <= 9; i++) {
        await recordAttendance(ctx, {
          organizationId: s.organizationId,
          month: MONTH,
          contactKey: `c-${i}`,
          conversationId: s.conversationId,
          firstAt: Date.now(),
          billing: "included",
          mode: "live",
        });
      }
    });
    await attendUpTo(s, 10, 10);
    expect((await notes(s.adminId)).map((n) => n.type)).toEqual(["plan_usage_reached"]);
    const meter = await t.run((ctx) =>
      ctx.db.query("orgUsageMonthly").withIndex("by_organization_and_month", (q) => q.eq("organizationId", s.organizationId).eq("month", MONTH)).unique()
    );
    expect(meter?.planWarnedAt).toBeDefined();
  });

  test("destinatarios: so quem tem settings:manage", async () => {
    const s = await seed(paid());
    await attendUpTo(s, 1, 10);
    expect((await notes(s.adminId)).length).toBeGreaterThan(0);
    expect(await notes(s.agentId)).toHaveLength(0);
  });

  test("org legacy e org sem plano: nenhum aviso e nenhum nivel de uso", async () => {
    for (const billing of [{ status: "legacy" as const, updatedAt: 1 }, undefined]) {
      t = convexTest(schema, modules);
      const s = await seed(billing);
      await attendUpTo(s, 1, 12);
      expect(await notes(s.adminId)).toHaveLength(0);
      expect((await orgOf(s.organizationId))?.billing?.usageAlert).toBeUndefined();
    }
  });

  test("teto do excedente atingido avisa uma vez", async () => {
    const s = await seed(paid({ overage: { enabled: true, capBrl: 1, updatedAt: 1 }, overrides: { aiAttendances: 0 } }));
    // Profissional: R$ 0,49 por atendimento; teto R$ 1 = 100c: 2 cabem (98c), o 3o nao.
    for (let i = 1; i <= 2; i++) {
      await t.run(async (ctx) => {
        await recordAttendance(ctx, {
          organizationId: s.organizationId,
          month: MONTH,
          contactKey: `o-${i}`,
          conversationId: s.conversationId,
          firstAt: Date.now(),
          billing: "overage",
          unitPriceBrlCents: 49,
          mode: "live",
        });
        await maybeNotifyPlanUsage(ctx, { organizationId: s.organizationId, now: Date.now() });
      });
    }
    const types = (await notes(s.adminId)).map((n) => n.type);
    expect(types.filter((x) => x === "plan_overage_cap_reached")).toHaveLength(1);
  });
});

describe("avisos de envios de campanha e nivel de uso", () => {
  test("80% e 100% dos envios avisam uma vez; getMyEntitlements expoe usageLevel e o mes", async () => {
    const s = await seed(paid());
    const recipients = await t.run(async (ctx) => {
      const out: Id<"campaignRecipients">[] = [];
      const adminId = s.adminId;
      const configId = await ctx.db.insert("channelConfigs", {
        organizationId: s.organizationId,
        channel: "whatsapp",
        provider: "meta",
        displayName: "Meta",
        phoneNumberId: "1",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      const campaignId = await ctx.db.insert("campaigns", {
        organizationId: s.organizationId,
        name: "C",
        status: "running",
        channelConfigId: configId,
        provider: "meta",
        content: { kind: "text", variants: [{ text: "Oi" }] },
        audience: { source: "manual" },
        schedule: { timezone: "UTC", windowStartHour: 0, windowEndHour: 24, days: [0, 1, 2, 3, 4, 5, 6] },
        pacing: { minDelaySec: 1, maxDelaySec: 2, batchSize: 0, batchPauseMin: 0, maxPerHour: 100, maxPerDay: 1000 },
        safeMode: true,
        safety: { checkNumbersFirst: false },
        stats: { total: 0, pending: 0, queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0, optedOut: 0, consecutiveFailures: 0 },
        createdBy: adminId,
        createdAt: 1,
        updatedAt: 1,
      } as never);
      for (let i = 0; i < 12; i++) {
        out.push(
          await ctx.db.insert("campaignRecipients", {
            organizationId: s.organizationId,
            campaignId,
            phone: `55119999900${String(i).padStart(2, "0")}`,
            status: "pending",
            attempts: 0,
            createdAt: 1,
          } as never)
        );
      }
      return out;
    });
    const bump = (i: number) =>
      t.run((ctx) => bumpCampaignSends(ctx, { organizationId: s.organizationId, recipientId: recipients[i], now: Date.now() }));
    for (let i = 0; i < 8; i++) await bump(i);
    expect((await notes(s.adminId)).map((n) => n.type)).toEqual(["plan_usage_warning"]);
    for (let i = 8; i < 12; i++) await bump(i);
    const types = (await notes(s.adminId)).map((n) => n.type).sort();
    expect(types).toEqual(["plan_usage_reached", "plan_usage_warning"]);
    expect((await notes(s.adminId)).every((n) => (n.data as { meter: string }).meter === "campaign")).toBe(true);

    const userId = await t.run(async (ctx) => (await ctx.db.get(s.adminId))!.userId!);
    const mine = await t.withIdentity({ subject: `${userId}|s1` }).query(api.billing.getMyEntitlements, {
      organizationId: s.organizationId,
    });
    expect(mine).toMatchObject({ usageLevel: "limit100", usageAlertMonth: MONTH });
  });

  test("sem cruzamento: usageLevel ok e sem mes", async () => {
    const s = await seed(paid());
    const userId = await t.run(async (ctx) => (await ctx.db.get(s.adminId))!.userId!);
    const mine = await t.withIdentity({ subject: `${userId}|s1` }).query(api.billing.getMyEntitlements, {
      organizationId: s.organizationId,
    });
    expect(mine?.usageLevel).toBe("ok");
    expect(mine?.usageAlertMonth).toBeUndefined();
  });
});

describe("periodo do plano: baseline na ativacao e avisos do teste por periodo", () => {
  const live = (s: Seed, month: string, key: string, notify = true) =>
    t.run(async (ctx) => {
      await recordAttendance(ctx, {
        organizationId: s.organizationId,
        month,
        contactKey: key,
        conversationId: s.conversationId,
        firstAt: Date.now(),
        billing: "included",
        mode: "live",
      });
      if (notify) await maybeNotifyPlanUsage(ctx, { organizationId: s.organizationId, now: Date.now() });
    });
  const change = (s: Seed, billing: NonNullable<Billing>) =>
    t.run(async (ctx) => {
      const cur = (await ctx.db.get(s.organizationId))?.billing;
      const { updatedAt: _c, ...curInput } = cur ?? { updatedAt: 0 };
      void _c;
      const { updatedAt: _u, ...rest } = billing;
      const input = { ...curInput, ...rest };
      void _u;
      await applySubscriptionChange(ctx, {
        organizationId: s.organizationId,
        patch: { billing: input },
        source: "ops",
        reason: "teste",
      });
    });
  const used = (s: Seed) =>
    t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      return await attendancesUsedInPeriod(ctx, {
        organizationId: s.organizationId,
        now: Date.now(),
        periodStart: attendancePeriodStart(org.billing),
        acrossMonths: org.billing?.status === "trial",
        baseline: org.billing?.periodBaseline,
        scanCap: 10_000,
      });
    });

  test("teste com 250 usados, ativa o Essencial no meio do mes: a franquia de 300 comeca do zero", async () => {
    const s = await seed({ status: "legacy", updatedAt: 1 });
    await change(s, { plan: "profissional", status: "trial", trialEndsAt: Date.now() + 30 * 86_400_000, updatedAt: 1 });
    expect((await orgOf(s.organizationId))?.billing?.periodBaseline).toEqual({ month: MONTH, total: 0 });
    for (let i = 1; i <= 250; i++) await live(s, MONTH, `c-${i}`, false);
    expect(await used(s)).toBe(250);

    vi.setSystemTime(new Date("2026-10-20T15:00:00Z"));
    await change(s, { plan: "essencial", status: "active", updatedAt: 1 });
    const billing = (await orgOf(s.organizationId))?.billing;
    expect(billing?.periodStart).toBe(Date.now());
    expect(billing?.periodBaseline).toEqual({ month: MONTH, total: 250 });
    expect(await used(s)).toBe(0);
    await live(s, MONTH, "novo-1", false);
    await live(s, MONTH, "novo-2", false);
    expect(await used(s)).toBe(2);
  });

  test("active <-> past_due nao reabre o periodo; trocar de plano reabre", async () => {
    const s = await seed({ status: "legacy", updatedAt: 1 });
    await change(s, { plan: "essencial", status: "active", updatedAt: 1 });
    const first = (await orgOf(s.organizationId))?.billing;
    vi.setSystemTime(new Date("2026-10-20T15:00:00Z"));
    await change(s, { plan: "essencial", status: "past_due", updatedAt: 1 });
    expect((await orgOf(s.organizationId))?.billing?.periodStart).toBe(first?.periodStart);
    await change(s, { plan: "profissional", status: "past_due", updatedAt: 1 });
    expect((await orgOf(s.organizationId))?.billing?.periodStart).toBe(Date.now());
  });

  test("teste que cruza a virada do mes nao reavisa 80% nem 100%", async () => {
    const s = await seed({ status: "legacy", updatedAt: 1 });
    await change(s, {
      plan: "profissional",
      status: "trial",
      trialEndsAt: Date.now() + 30 * 86_400_000,
      overrides: { aiAttendances: 10 },
      updatedAt: 1,
    });
    for (let i = 1; i <= 8; i++) await live(s, MONTH, `a-${i}`);
    expect((await notes(s.adminId)).map((n) => n.type)).toEqual(["plan_usage_warning"]);

    vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
    await live(s, "2026-11", "b-1"); // 9 de 10 no periodo: segue sem reavisar o 80%
    expect((await notes(s.adminId)).map((n) => n.type)).toEqual(["plan_usage_warning"]);
    await live(s, "2026-11", "b-2"); // 10: cruza 100% uma vez
    await live(s, "2026-11", "b-3");
    expect((await notes(s.adminId)).map((n) => n.type).sort()).toEqual(["plan_usage_reached", "plan_usage_warning"]);
  });
});

describe("billing.quiet: org silenciada", () => {
  test("active com quiet nao recebe aviso de 80/100 nem de teto, nem grava usageAlert", async () => {
    const s = await seed(paid({ quiet: true, overage: { enabled: true, capBrl: 1, updatedAt: 1 } }));
    for (let i = 1; i <= 12; i++) {
      await t.run(async (ctx) => {
        await recordAttendance(ctx, {
          organizationId: s.organizationId,
          month: MONTH,
          contactKey: `q-${i}`,
          conversationId: s.conversationId,
          firstAt: Date.now(),
          billing: i <= 10 ? "included" : "overage",
          unitPriceBrlCents: 49,
          mode: "live",
        });
        await maybeNotifyPlanUsage(ctx, { organizationId: s.organizationId, now: Date.now() });
      });
    }
    expect(await notes(s.adminId)).toHaveLength(0);
    expect((await orgOf(s.organizationId))?.billing?.usageAlert).toBeUndefined();
    const sent = await t.run(async (ctx) =>
      notifyBillingAdmins(ctx, { organizationId: s.organizationId, type: "trial_ending", data: { daysLeft: 1, endsAt: "x" }, dedupeKey: "k" })
    );
    expect(sent).toBe(0);
    expect(await notes(s.adminId)).toHaveLength(0);
  });
});
