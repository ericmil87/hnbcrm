/// <reference types="vite/client" />
import { expect, test, describe } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { AUDIT_TEXT_MAX_CHARS, sha256Hex } from "./lib/auditText";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

async function seed(t: ReturnType<typeof convexTest>, systemPrompt: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org-ops",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const agentMemberId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Guardião",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: { kind: "attendant", mode: "suggest", systemPrompt },
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, agentMemberId };
  });
}

async function lastAudit(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("auditLogs").collect();
    return rows[rows.length - 1];
  });
}

describe("internalSetAgentProfileText — audit com o texto anterior", () => {
  test("grava before/after com o texto e os tamanhos no metadata", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, agentMemberId } = await seed(t, "persona antiga");
    const r = await t.mutation(internal.opsAgentProfile.internalSetAgentProfileText, {
      organizationId,
      agentMemberId,
      field: "systemPrompt",
      text: "persona nova",
      dryRun: false,
      version: "v-teste",
    });
    expect(r.applied).toBe(true);
    const log = await lastAudit(t);
    expect(log.changes.before).toEqual({ systemPrompt: "persona antiga" });
    expect(log.changes.after).toEqual({ systemPrompt: "persona nova" });
    expect(log.metadata.beforeLength).toBe("persona antiga".length);
    expect(log.metadata.afterLength).toBe("persona nova".length);
  });

  test("dryRun não grava audit", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, agentMemberId } = await seed(t, "a");
    await t.mutation(internal.opsAgentProfile.internalSetAgentProfileText, {
      organizationId,
      agentMemberId,
      field: "systemPrompt",
      text: "b",
    });
    expect(await lastAudit(t) ?? null).toBeNull();
  });

  test("texto acima do teto é truncado com marcador e sha256 do completo", async () => {
    const t = convexTest(schema, modules);
    const big = "x".repeat(AUDIT_TEXT_MAX_CHARS + 500);
    const { organizationId, agentMemberId } = await seed(t, big);
    await t.mutation(internal.opsAgentProfile.internalSetAgentProfileText, {
      organizationId,
      agentMemberId,
      field: "systemPrompt",
      text: "curto",
      dryRun: false,
    });
    const log = await lastAudit(t);
    const hash = await sha256Hex(big);
    const before = log.changes.before.systemPrompt as string;
    expect(before.startsWith("x".repeat(AUDIT_TEXT_MAX_CHARS))).toBe(true);
    expect(before).toContain(`…[truncado: ${big.length} chars, sha256 ${hash}]`);
    expect(log.changes.after.systemPrompt).toBe("curto");
  });
});

describe("internalSetDisclosureMode", () => {
  test("dryRun é o default: relata e não grava", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, agentMemberId } = await seed(t, "p");
    const r = await t.mutation(internal.opsAgentProfile.internalSetDisclosureMode, {
      organizationId,
      agentMemberId,
      mode: "on_demand",
    });
    expect(r).toEqual({ applied: false, before: "first_reply", after: "on_demand", changed: true });
    const member = await t.run(async (ctx) => ctx.db.get(agentMemberId));
    expect(member!.agentProfile!.disclosureMode).toBeUndefined();
  });

  test("aplica, preserva o resto do perfil e audita", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, agentMemberId } = await seed(t, "persona");
    const r = await t.mutation(internal.opsAgentProfile.internalSetDisclosureMode, {
      organizationId,
      agentMemberId,
      mode: "on_demand",
      version: "v-teste",
      dryRun: false,
    });
    expect(r.applied).toBe(true);
    const member = await t.run(async (ctx) => ctx.db.get(agentMemberId));
    expect(member!.agentProfile!.disclosureMode).toBe("on_demand");
    expect(member!.agentProfile!.systemPrompt).toBe("persona");
    const log = await lastAudit(t);
    expect(log.metadata.op).toBe("internalSetDisclosureMode");
    expect(log.changes.before).toEqual({ disclosureMode: "first_reply" });
    expect(log.changes.after).toEqual({ disclosureMode: "on_demand" });
  });

  test("recusa agente de outra organização", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, "a");
    const otherOrg = await t.run(async (ctx) =>
      ctx.db.insert("organizations", {
        name: "Outra",
        slug: "outra",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(
      t.mutation(internal.opsAgentProfile.internalSetDisclosureMode, {
        organizationId: otherOrg,
        agentMemberId: a.agentMemberId,
        mode: "on_demand",
        dryRun: false,
      })
    ).rejects.toThrow("Membro não pertence à organização");
  });
});

describe("internalSetPipelineRules", () => {
  async function seedPipeline(t: ReturnType<typeof convexTest>) {
    const { organizationId, agentMemberId } = await seed(t, "p");
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("fieldDefinitions", {
        organizationId,
        name: "Canal",
        key: "canal",
        type: "text",
        entityType: "lead",
        isRequired: false,
        order: 0,
        createdAt: now,
      });
      const m = await ctx.db.get(agentMemberId);
      await ctx.db.patch(agentMemberId, {
        agentProfile: {
          ...m!.agentProfile!,
          pipelineConfig: { qualifyThreshold: 2, advanceRules: "antigas", captureFields: [] },
        },
      });
    });
    return { organizationId, agentMemberId };
  }

  test("dryRun é o default: relata e não grava", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, agentMemberId } = await seedPipeline(t);
    const r = await t.mutation(internal.opsAgentProfile.internalSetPipelineRules, {
      organizationId,
      agentMemberId,
      advanceRules: "novas regras",
      captureFields: ["canal"],
    });
    expect(r.applied).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.advanceRules).toEqual({ beforeLength: 7, afterLength: 12, changed: true });
    const member = await t.run(async (ctx) => ctx.db.get(agentMemberId));
    expect(member!.agentProfile!.pipelineConfig!.advanceRules).toBe("antigas");
  });

  test("aplica, preserva o resto do pipelineConfig e audita", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, agentMemberId } = await seedPipeline(t);
    const r = await t.mutation(internal.opsAgentProfile.internalSetPipelineRules, {
      organizationId,
      agentMemberId,
      advanceRules: "novas regras",
      captureFields: ["canal"],
      version: "v-teste",
      dryRun: false,
    });
    expect(r.applied).toBe(true);
    const member = await t.run(async (ctx) => ctx.db.get(agentMemberId));
    expect(member!.agentProfile!.pipelineConfig).toEqual({
      qualifyThreshold: 2,
      advanceRules: "novas regras",
      captureFields: ["canal"],
    });
    expect(member!.agentProfile!.systemPrompt).toBe("p");
    const log = await lastAudit(t);
    expect(log.metadata.op).toBe("internalSetPipelineRules");
    expect(log.changes.after.captureFields).toEqual(["canal"]);
  });

  test("recusa captureFields fora de fieldDefinitions", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, agentMemberId } = await seedPipeline(t);
    await expect(
      t.mutation(internal.opsAgentProfile.internalSetPipelineRules, {
        organizationId,
        agentMemberId,
        captureFields: ["canal", "inexistente"],
        dryRun: false,
      }),
    ).rejects.toThrow(/inexistente/);
  });
});
