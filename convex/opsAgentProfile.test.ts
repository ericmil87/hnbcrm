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
