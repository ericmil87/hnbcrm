/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
type T = TestConvex<typeof schema>;
const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const MONTH = "2026-11";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function seed(
  t: T,
  opts: { ai?: boolean; spendCap?: Record<string, unknown>; noEmail?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", opts.noEmail ? {} : { email: "admin@teste.com" });
    const agentUserId = await ctx.db.insert("users", { email: "agente@teste.com" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Draft",
      slug: "org-draft",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        ...(opts.ai === false
          ? {}
          : {
              aiConfig: {
                enabled: true,
                autoAssign: false,
                handoffThreshold: 0.8,
                ...(opts.spendCap ? { spendCap: opts.spendCap } : {}),
              },
            }),
      } as never,
      onboardingMeta: {
        industry: "servicos",
        business: { displayName: "Studio Aurora", offer: "Consultoria de design", tone: "amigavel" },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human",
      status: "active", createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    if (org.settings.aiConfig) {
      await ctx.db.patch(organizationId, {
        settings: {
          ...org.settings,
          aiConfig: { ...org.settings.aiConfig, lgpdAck: { acceptedAt: now, acceptedBy: adminId } },
        },
      });
    }
    await ctx.db.insert("teamMembers", {
      organizationId, userId: agentUserId, name: "Agente", role: "agent", type: "human",
      status: "active", createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, agentUserId };
  });
}

describe("attendantDraft", () => {
  test("internalGetDraftSetup exige settings:manage e e-mail", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const args = { organizationId: s.organizationId, month: MONTH };
    await expect(
      as(t, s.agentUserId).query(internal.attendantDraft.internalGetDraftSetup, args),
    ).rejects.toThrow(/Permissão insuficiente/);
    const ok = await as(t, s.adminUserId).query(internal.attendantDraft.internalGetDraftSetup, args);
    expect(ok.segment).toBe("servicos");
    expect(ok.business.offer).toBe("Consultoria de design");

    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2, { noEmail: true });
    await expect(
      as(t2, s2.adminUserId).query(internal.attendantDraft.internalGetDraftSetup, {
        organizationId: s2.organizationId,
        month: MONTH,
      }),
    ).rejects.toThrow(/e-mail/);
  });

  test("setup recusa org sem IA ativa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { ai: false });
    await expect(
      as(t, s.adminUserId).query(internal.attendantDraft.internalGetDraftSetup, {
        organizationId: s.organizationId,
        month: MONTH,
      }),
    ).rejects.toThrow("Ative a IA primeiro");
    await expect(
      as(t, s.adminUserId).action(api.attendantDraft.generateAttendantDraft, {
        organizationId: s.organizationId,
      }),
    ).rejects.toThrow("Ative a IA primeiro");
  });

  test("setup recusa com teto em block", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { spendCap: { mode: "block", monthlyBrl: 55, usdBrlRate: 5.5 } });
    await t.run(async (ctx) => {
      await ctx.db.insert("aiUsageMonthly", {
        organizationId: s.organizationId, month: MONTH, costUsdMicros: 10_000_000,
        runs: 1, byKind: {}, updatedAt: Date.now(),
      });
    });
    await expect(
      as(t, s.adminUserId).action(api.attendantDraft.generateAttendantDraft, {
        organizationId: s.organizationId,
      }),
    ).rejects.toThrow(/teto/i);
  });

  test("action devolve fallback do template quando o modelo falha", async () => {
    vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 400 })));
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const draft = await as(t, s.adminUserId).action(api.attendantDraft.generateAttendantDraft, {
      organizationId: s.organizationId,
    });
    expect(draft.persona.length).toBeGreaterThan(0);
    expect(draft.knowledge).toContain("P:");
    expect(draft.warnings.length).toBeGreaterThan(0);
    const runs = await t.run(async (ctx) => ctx.db.query("agentRuns").collect());
    expect(runs[0].status).toBe("error");
  });

  test("action registra agentRuns attendant_draft", async () => {
    vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
    const payload = {
      name: "Aurora",
      persona: "Você é a Aurora.",
      greeting: "Oi!",
      knowledge: "Fazemos design.",
      handoffKeywords: ["humano"],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const draft = await as(t, s.adminUserId).action(api.attendantDraft.generateAttendantDraft, {
      organizationId: s.organizationId,
    });
    expect(draft.name).toBe("Aurora");
    expect(draft.greeting).toBe("Oi!");
    expect(draft.persona).toBe("Você é a Aurora.\n\nPrimeira mensagem ao cliente: Oi!");
    expect(draft.warnings).toEqual([]);
    const { runs, profiles } = await t.run(async (ctx) => ({
      runs: await ctx.db.query("agentRuns").collect(),
      profiles: await ctx.db.query("agentProfileTexts").collect(),
    }));
    expect(runs).toHaveLength(1);
    expect(runs[0].kind).toBe("attendant_draft");
    expect(runs[0].status).toBe("done");
    expect(runs[0].promptTokens).toBe(100);
    expect(profiles).toHaveLength(0);
  });
});
