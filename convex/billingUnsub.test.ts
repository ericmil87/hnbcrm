/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { signUnsubToken } from "./lib/billingUnsub";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// Fixtures curtas e obviamente falsas (secretScan).
const SECRET = "fake-unsub-secret-0123456789abcdef0123456789abcdef";
const APP_URL = "https://app.example.test";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NOTIFICATION_UNSUB_SECRET", SECRET);
  vi.stubEnv("APP_URL", APP_URL);
  vi.stubEnv("CONVEX_SITE_URL", "https://fake-site.example.test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Seeded = {
  orgA: Id<"organizations">;
  orgB: Id<"organizations">;
  alice: Id<"teamMembers">;
  bob: Id<"teamMembers">;
  carol: Id<"teamMembers">; // orgB
  removed: Id<"teamMembers">;
  legacyInactive: Id<"teamMembers">;
  ai: Id<"teamMembers">;
};

async function seed(t: TestConvex<typeof schema>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const org = (name: string, slug: string) =>
      ctx.db.insert("organizations", {
        name,
        slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
    const orgA = await org("Org Alfa", "org-alfa");
    const orgB = await org("Org Beta", "org-beta");
    const human = async (
      organizationId: Id<"organizations">,
      email: string,
      extra: { removedAt?: number; status?: "active" | "inactive" } = {},
    ) => {
      const userId = await ctx.db.insert("users", { email });
      return await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name: email,
        role: "admin",
        type: "human",
        status: extra.status ?? "active",
        ...(extra.removedAt ? { removedAt: extra.removedAt } : {}),
        createdAt: now,
        updatedAt: now,
      });
    };
    const alice = await human(orgA, "alice@teste.example");
    const bob = await human(orgA, "bob@teste.example");
    const carol = await human(orgB, "carol@teste.example");
    const removed = await human(orgA, "removido@teste.example", { removedAt: now });
    const legacyInactive = await human(orgA, "inativo@teste.example", { status: "inactive" });
    const ai = await ctx.db.insert("teamMembers", {
      organizationId: orgA,
      name: "IA",
      role: "ai",
      type: "ai",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { orgA, orgB, alice, bob, carol, removed, legacyInactive, ai };
  });
}

const tokenFor = (organizationId: string, memberId: string) => signUnsubToken(SECRET, { organizationId, memberId });

async function emailFlag(t: TestConvex<typeof schema>, orgId: Id<"organizations">, memberId: Id<"teamMembers">) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) => q.eq("organizationId", orgId).eq("teamMemberId", memberId))
      .first();
    return row ? (row.channels?.email?.billingNotices ?? "unset") : "no-row";
  });
}

async function unsubAudits(t: TestConvex<typeof schema>, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
        .take(50)
    ).filter((a) => a.metadata?.kind === "billing_unsub"),
  );
}

describe("previewUnsubscribe / setUnsubscribe", () => {
  test("desativa e reativa, idempotente; outra org e outro membro intocados", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const token = await tokenFor(s.orgA, s.alice);

    expect(await t.query(api.billingUnsub.previewUnsubscribe, { token })).toEqual({
      valid: true,
      orgName: "Org Alfa",
      enabled: true,
    });
    // Preview não escreve nada.
    expect(await emailFlag(t, s.orgA, s.alice)).toBe("no-row");

    const off = { valid: true, orgName: "Org Alfa", enabled: false };
    expect(await t.mutation(api.billingUnsub.setUnsubscribe, { token, enabled: false })).toEqual(off);
    expect(await t.mutation(api.billingUnsub.setUnsubscribe, { token, enabled: false })).toEqual(off);
    expect(await emailFlag(t, s.orgA, s.alice)).toBe(false);
    expect(await t.query(api.billingUnsub.previewUnsubscribe, { token })).toEqual(off);

    const on = { valid: true, orgName: "Org Alfa", enabled: true };
    expect(await t.mutation(api.billingUnsub.setUnsubscribe, { token, enabled: true })).toEqual(on);
    expect(await t.mutation(api.billingUnsub.setUnsubscribe, { token, enabled: true })).toEqual(on);
    expect(await emailFlag(t, s.orgA, s.alice)).toBe(true);

    // Um audit por MUDANÇA (repetir o mesmo valor não audita).
    const audits = await unsubAudits(t, s.orgA);
    expect(audits.map((a) => a.metadata?.on)).toEqual([false, true]);

    expect(await emailFlag(t, s.orgA, s.bob)).toBe("no-row");
    expect(await emailFlag(t, s.orgB, s.carol)).toBe("no-row");
  });

  test("preserva o resto de `channels` ao gravar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("notificationPreferences", {
        organizationId: s.orgA,
        teamMemberId: s.alice,
        invite: true,
        handoffRequested: true,
        handoffResolved: true,
        taskOverdue: true,
        taskAssigned: true,
        leadAssigned: true,
        newMessage: true,
        dailyDigest: true,
        channels: { email: { taskAssigned: false }, telegram: { newMessage: false } },
        createdAt: now,
        updatedAt: now,
      });
    });
    const token = await tokenFor(s.orgA, s.alice);
    await t.mutation(api.billingUnsub.setUnsubscribe, { token, enabled: false });
    const channels = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("notificationPreferences")
        .withIndex("by_organization_and_member", (q) => q.eq("organizationId", s.orgA).eq("teamMemberId", s.alice))
        .first();
      return row?.channels;
    });
    expect(channels).toEqual({
      email: { taskAssigned: false, billingNotices: false },
      telegram: { newMessage: false },
    });
  });

  test("audit gravado sem e-mail, sem token, ator = o próprio membro", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const token = await tokenFor(s.orgA, s.alice);
    await t.mutation(api.billingUnsub.setUnsubscribe, { token, enabled: false });
    const [audit] = await unsubAudits(t, s.orgA);
    expect(audit).toMatchObject({
      entityType: "teamMember",
      entityId: s.alice,
      action: "update",
      actorId: s.alice,
      actorType: "human",
      severity: "low",
      metadata: { kind: "billing_unsub", on: false },
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain(token);
    expect(audit.ipAddress).toBeUndefined();
  });

  test("toda falha devolve o MESMO {valid:false} e não escreve", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const good = await tokenFor(s.orgA, s.alice);
    const [ver, payload, sig] = good.split(".");
    const missingOrg = await t.run(async (ctx) => {
      const id = await ctx.db.insert("organizations", {
        name: "Some",
        slug: "some",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: 0,
        updatedAt: 0,
      });
      await ctx.db.delete(id);
      return id;
    });
    const bad: Record<string, string> = {
      lixo: "isso-nao-e-token",
      vazio: "",
      longo: "v1." + "A".repeat(600),
      adulterado: `${ver}.${payload}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`,
      outroSegredo: await signUnsubToken("fake-unsub-secret-other-0123456789abcdef0123456", {
        organizationId: s.orgA,
        memberId: s.alice,
      }),
      membroRemovido: await tokenFor(s.orgA, s.removed),
      membroInativoLegado: await tokenFor(s.orgA, s.legacyInactive),
      membroDeOutraOrg: await tokenFor(s.orgA, s.carol),
      orgInexistente: await tokenFor(missingOrg, s.alice),
      idQueNaoEhId: await tokenFor("nao-e-id", "tambem-nao"),
      idDeOutraTabela: await tokenFor(s.alice, s.orgA),
      membroIa: await tokenFor(s.orgA, s.ai),
    };
    const reference = await t.query(api.billingUnsub.previewUnsubscribe, { token: bad.lixo });
    expect(reference).toEqual({ valid: false });
    for (const [name, token] of Object.entries(bad)) {
      const preview = await t.query(api.billingUnsub.previewUnsubscribe, { token });
      const set = await t.mutation(api.billingUnsub.setUnsubscribe, { token, enabled: false });
      expect(preview, name).toStrictEqual(reference);
      expect(set, name).toStrictEqual(reference);
    }
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("notificationPreferences").withIndex("by_organization", (q) => q.eq("organizationId", s.orgA)).take(10)).length,
    );
    expect(rows).toBe(0);
    expect(await unsubAudits(t, s.orgA)).toEqual([]);
  });

  test("sem segredo configurado: token antes válido vira {valid:false}", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const token = await tokenFor(s.orgA, s.alice);
    vi.stubEnv("NOTIFICATION_UNSUB_SECRET", "");
    expect(await t.query(api.billingUnsub.previewUnsubscribe, { token })).toStrictEqual({ valid: false });
  });

  test("rotação: token do segredo anterior vale com NOTIFICATION_UNSUB_SECRET_PREV", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const token = await tokenFor(s.orgA, s.alice);
    vi.stubEnv("NOTIFICATION_UNSUB_SECRET", "fake-unsub-secret-next-0123456789abcdef01234567");
    expect(await t.query(api.billingUnsub.previewUnsubscribe, { token })).toStrictEqual({ valid: false });
    vi.stubEnv("NOTIFICATION_UNSUB_SECRET_PREV", SECRET);
    expect(await t.query(api.billingUnsub.previewUnsubscribe, { token })).toMatchObject({ valid: true });
  });
});

describe("rota /notifications/unsubscribe", () => {
  const SECURITY_HEADERS = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex",
  };
  const expectSecurityHeaders = (res: Response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
  };
  const post = (t: TestConvex<typeof schema>, token: string, ip = "203.0.113.10") =>
    t.fetch(`/notifications/unsubscribe?t=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
      body: "List-Unsubscribe=One-Click",
    });

  test("GET = 302 para a página, sem efeito no banco", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const token = await tokenFor(s.orgA, s.alice);
    const res = await t.fetch(`/notifications/unsubscribe?t=${encodeURIComponent(token)}`, { method: "GET" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/notificacoes/desativar?t=${token}`);
    expectSecurityHeaders(res);
    expect(await emailFlag(t, s.orgA, s.alice)).toBe("no-row");
    const throttles = await t.run(async (ctx) => (await ctx.db.query("authEmailThrottle").take(10)).length);
    expect(throttles).toBe(0);
  });

  test("POST one-click desativa (200) e é idempotente", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const token = await tokenFor(s.orgA, s.alice);
    const res = await post(t, token);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(await emailFlag(t, s.orgA, s.alice)).toBe(false);
    expect((await post(t, token)).status).toBe(200);
    expect(await emailFlag(t, s.orgA, s.alice)).toBe(false);
    expect(await unsubAudits(t, s.orgA)).toHaveLength(1);
    expect(await emailFlag(t, s.orgA, s.bob)).toBe("no-row");
  });

  test("POST sem corpo também funciona (o token vem da query)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const token = await tokenFor(s.orgA, s.alice);
    const res = await t.fetch(`/notifications/unsubscribe?t=${encodeURIComponent(token)}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await emailFlag(t, s.orgA, s.alice)).toBe(false);
  });

  test("POST com token inválido, removido ou ausente = 400 sem tocar prefs", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (const token of ["lixo", "", await tokenFor(s.orgA, s.removed), "v1." + "A".repeat(700)]) {
      const res = await post(t, token);
      expect(res.status).toBe(400);
      expectSecurityHeaders(res);
    }
    const noToken = await t.fetch("/notifications/unsubscribe", { method: "POST" });
    expect(noToken.status).toBe(400);
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("notificationPreferences").withIndex("by_organization", (q) => q.eq("organizationId", s.orgA)).take(10)).length,
    );
    expect(rows).toBe(0);
  });

  test("POST com token inválido não escreve NADA: nem teto por IP, nem prefs, nem audit; corpo idêntico", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const good = await tokenFor(s.orgA, s.alice);
    const [ver, payload, sig] = good.split(".");
    const forged: Record<string, string> = {
      lixo: "lixo",
      vazio: "",
      longo: "v1." + "A".repeat(700),
      adulterado: `${ver}.${payload}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`,
      outroSegredo: await signUnsubToken("fake-unsub-secret-other-0123456789abcdef0123456", {
        organizationId: s.orgA,
        memberId: s.alice,
      }),
    };
    const bodies = new Set<string>();
    for (const [name, token] of Object.entries(forged)) {
      // Com IP, com IP forjável no XFF e sem IP nenhum (balde `unsub ip:unknown`).
      for (const headers of [{ "cf-connecting-ip": "198.51.100.7" }, { "x-forwarded-for": "10.0.0.1, 198.51.100.8" }, {}] as Record<string, string>[]) {
        const res = await t.fetch(`/notifications/unsubscribe?t=${encodeURIComponent(token)}`, { method: "POST", headers });
        expect(res.status, name).toBe(400);
        expectSecurityHeaders(res);
        bodies.add(await res.text());
      }
    }
    expect([...bodies]).toEqual(["Link inválido."]);
    const throttles = await t.run(async (ctx) => (await ctx.db.query("authEmailThrottle").take(10)).length);
    expect(throttles).toBe(0);
    expect(await emailFlag(t, s.orgA, s.alice)).toBe("no-row");
    expect(await unsubAudits(t, s.orgA)).toEqual([]);
  });

  test("lixo em massa (com ou sem IP) não esgota o teto: o link legítimo segue 200", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (let i = 0; i < 70; i++) {
      expect((await post(t, "lixo", "198.51.100.1")).status).toBe(400);
      expect((await t.fetch("/notifications/unsubscribe?t=lixo", { method: "POST" })).status).toBe(400);
    }
    const token = await tokenFor(s.orgA, s.alice);
    expect((await post(t, token, "198.51.100.1")).status).toBe(200);
    expect((await t.fetch(`/notifications/unsubscribe?t=${encodeURIComponent(token)}`, { method: "POST" })).status).toBe(200);
    expect(await emailFlag(t, s.orgA, s.alice)).toBe(false);
  });

  test("teto por IP (só tokens autênticos): a 61ª no mesmo IP = 429 sem tocar prefs; outro IP passa; IP cru nunca é gravado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const alice = await tokenFor(s.orgA, s.alice);
    for (let i = 0; i < 60; i++) expect((await post(t, alice, "198.51.100.1")).status).toBe(200);
    const bob = await tokenFor(s.orgA, s.bob);
    const limited = await post(t, bob, "198.51.100.1");
    expect(limited.status).toBe(429);
    expectSecurityHeaders(limited);
    expect(await emailFlag(t, s.orgA, s.bob)).toBe("no-row");

    expect((await post(t, bob, "198.51.100.2")).status).toBe(200);
    expect(await emailFlag(t, s.orgA, s.bob)).toBe(false);

    const keys = await t.run(async (ctx) => (await ctx.db.query("authEmailThrottle").take(10)).map((r) => r.email));
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(/^unsub ip:[0-9a-f]{16}$/);
      expect(key).not.toContain("198.51.100");
    }

    // A janela vira depois de 1 h.
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect((await post(t, bob, "198.51.100.1")).status).toBe(200);
  });

  test("token autêntico de membro removido conta no teto e responde igual ao lixo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await post(t, await tokenFor(s.orgA, s.removed));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Link inválido.");
    const throttles = await t.run(async (ctx) => (await ctx.db.query("authEmailThrottle").take(10)).length);
    expect(throttles).toBe(1);
    expect(await unsubAudits(t, s.orgA)).toEqual([]);
  });

  test("x-forwarded-for: vale a entrada mais à direita (a da borda), não a forjável", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const token = await tokenFor(s.orgA, s.alice);
    const viaXff = (xff: string) =>
      t.fetch(`/notifications/unsubscribe?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "x-forwarded-for": xff },
      });
    for (let i = 0; i < 60; i++) expect((await viaXff(`10.0.0.${i}, 198.51.100.9`)).status).toBe(200);
    // Trocar a entrada da esquerda não escapa do teto.
    expect((await viaXff("10.9.9.9, 198.51.100.9")).status).toBe(429);
  });
});
