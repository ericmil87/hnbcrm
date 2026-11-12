/// <reference types="vite/client" />
/**
 * Confirmação de e-mail por código de 6 dígitos (onboarding v2, D2).
 * `sendTransactionalEmail` é mockado: o componente Resend não existe no
 * convex-test, e o código só viaja no HTML do e-mail.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_REQUESTS_PER_HOUR,
  EMAIL_CODE_REQUESTS_PER_DAY,
  EMAIL_CODE_MAX_FAILURES_PER_DAY,
  EMAIL_CODE_DAY_MS,
  hashEmailVerificationCode,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  EMAIL_CODE_TTL_MS,
  generateEmailVerificationCode,
  isEmailVerifiedForMaterials,
} from "./lib/emailVerification";

const sent: Array<{ to: string; html: string; kind: string }> = [];
let deliver = true;

vi.mock("./email", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./email")>();
  return {
    ...orig,
    sendTransactionalEmail: vi.fn(async (_ctx: unknown, args: { to: string; html: string; kind: string }) => {
      if (!deliver) return false;
      sent.push({ to: args.to, html: args.html, kind: args.kind });
      return true;
    }),
  };
});

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("JWT_PRIVATE_KEY", "fake-jwt-key-for-tests");
  sent.length = 0;
  deliver = true;
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function mkUser(email: string | undefined) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", email ? { name: "U", email } : { name: "U" }),
  );
  return { userId, as: t.withIdentity({ subject: `${userId}|s1` }) };
}

function lastCode(): string {
  const m = /Seu código de confirmação é (\d{6})\./.exec(sent[sent.length - 1].html);
  if (!m) throw new Error("código não encontrado no e-mail");
  return m[1];
}

const wait = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe("requestEmailVerificationCode", () => {
  test("envia e grava só o hash, nunca o código", async () => {
    const { userId, as } = await mkUser("a@example.com");
    const res = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(res.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("emailVerification");
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    const rows = await t.run(async (ctx) => ctx.db.query("emailVerificationCodes").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    expect(JSON.stringify(rows[0])).not.toContain(code);
    expect(rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].expiresAt - rows[0].createdAt).toBe(EMAIL_CODE_TTL_MS);
  });

  test("usuário sem e-mail é recusado e nada é enviado", async () => {
    const { as } = await mkUser(undefined);
    await expect(as.mutation(api.emailVerification.requestEmailVerificationCode, {})).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  test("sem login é recusado", async () => {
    await expect(t.mutation(api.emailVerification.requestEmailVerificationCode, {})).rejects.toThrow();
  });

  test("e-mail não entregável não grava código", async () => {
    const { as } = await mkUser("a@example.com");
    deliver = false;
    const res = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(res).toEqual({ sent: false, reason: "not_deliverable" });
    const rows = await t.run(async (ctx) => ctx.db.query("emailVerificationCodes").collect());
    expect(rows).toHaveLength(0);
  });

  test("cooldown de 60 s e reenvio invalida o código anterior", async () => {
    const { as } = await mkUser("a@example.com");
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const first = lastCode();
    const early = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(early.sent).toBe(false);
    expect(early.reason).toBe("cooldown");
    expect(sent).toHaveLength(1);

    wait(EMAIL_CODE_RESEND_COOLDOWN_MS + 1);
    const again = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(again.sent).toBe(true);
    const second = lastCode();
    const rows = await t.run(async (ctx) => ctx.db.query("emailVerificationCodes").collect());
    expect(rows).toHaveLength(1);
    if (first !== second) {
      const old = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: first });
      expect(old.verified).toBe(false);
    }
    const ok = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: second });
    expect(ok.verified).toBe(true);
  });

  test("teto de 5 pedidos por hora por usuário", async () => {
    const { as } = await mkUser("a@example.com");
    for (let i = 0; i < EMAIL_CODE_REQUESTS_PER_HOUR; i++) {
      const r = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
      expect(r.sent).toBe(true);
      wait(EMAIL_CODE_RESEND_COOLDOWN_MS + 1);
    }
    const blocked = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(blocked).toEqual({ sent: false, reason: "rate_limited" });
    expect(sent).toHaveLength(EMAIL_CODE_REQUESTS_PER_HOUR);
    wait(60 * 60 * 1000);
    const later = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(later.sent).toBe(true);
  });

  test("teto por e-mail vale entre usuários diferentes com o mesmo endereço", async () => {
    const a = await mkUser("dup@example.com");
    const b = await mkUser("dup@example.com");
    for (let i = 0; i < EMAIL_CODE_REQUESTS_PER_HOUR; i++) {
      const who = i % 2 === 0 ? a : b;
      const r = await who.as.mutation(api.emailVerification.requestEmailVerificationCode, {});
      expect(r.sent).toBe(true);
      wait(EMAIL_CODE_RESEND_COOLDOWN_MS + 1);
    }
    const blocked = await a.as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(blocked.reason).toBe("rate_limited");
  });
});

describe("confirmEmailVerificationCode", () => {
  test("sucesso grava emailVerificationTime, audita e apaga o código", async () => {
    const { userId, as } = await mkUser("a@example.com");
    const orgId = await t.run(async (ctx) => {
      const org = await ctx.db.insert("organizations", { name: "O", slug: "o-ver", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: 1, updatedAt: 1 } as never);
      await ctx.db.insert("teamMembers", {
        organizationId: org, userId, name: "U", role: "admin", type: "human", status: "active", createdAt: 1, updatedAt: 1,
      } as never);
      return org;
    });
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const res = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: lastCode() });
    expect(res).toEqual({ verified: true });
    const after = await t.run(async (ctx) => ({
      user: await ctx.db.get(userId),
      codes: await ctx.db.query("emailVerificationCodes").collect(),
      audits: await ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).collect(),
      ok: await isEmailVerifiedForMaterials(ctx, userId),
    }));
    expect(after.user?.emailVerificationTime).toBe(Date.now());
    expect(after.codes).toHaveLength(0);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0].severity).toBe("low");
    expect(after.ok).toBe(true);
    const status = await as.query(api.emailVerification.getEmailVerificationStatus, {});
    expect(status).toEqual({ verified: true });
  });

  test("idempotente: já verificado responde verified e não reenvia", async () => {
    const { as } = await mkUser("a@example.com");
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: lastCode() });
    const again = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: "000000" });
    expect(again).toEqual({ verified: true });
    const req = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(req).toEqual({ sent: false, reason: "already_verified" });
    expect(sent).toHaveLength(1);
  });

  test("código errado conta tentativa; 5 erros invalidam até o código certo", async () => {
    const { userId, as } = await mkUser("a@example.com");
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const right = lastCode();
    const wrong = right === "111111" ? "222222" : "111111";
    for (let i = 1; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
      const r = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: wrong });
      expect(r).toEqual({ verified: false, reason: "wrong", attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - i });
    }
    const last = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: wrong });
    expect(last.reason).toBe("locked");
    const after = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: right });
    expect(after).toEqual({ verified: false, reason: "none" });
    expect(await t.run(async (ctx) => isEmailVerifiedForMaterials(ctx, userId))).toBe(false);
  });

  test("código expira em 10 min", async () => {
    const { as } = await mkUser("a@example.com");
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const code = lastCode();
    wait(EMAIL_CODE_TTL_MS + 1);
    const r = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code });
    expect(r).toEqual({ verified: false, reason: "expired" });
  });

  test("sem pedido prévio devolve none", async () => {
    const { as } = await mkUser("a@example.com");
    const r = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: "123456" });
    expect(r).toEqual({ verified: false, reason: "none" });
  });

  test("multi-usuário: o código de A não confirma B", async () => {
    const a = await mkUser("a@example.com");
    const b = await mkUser("b@example.com");
    await a.as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const codeA = lastCode();
    await b.as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const codeB = lastCode();
    if (codeA !== codeB) {
      const r = await b.as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: codeA });
      expect(r.verified).toBe(false);
    }
    expect((await a.as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: codeA })).verified).toBe(true);
    expect(await t.run(async (ctx) => isEmailVerifiedForMaterials(ctx, b.userId))).toBe(false);
  });
});

describe("getEmailVerificationStatus e limpeza", () => {
  test("status mostra canResendAt após o pedido", async () => {
    const { as } = await mkUser("a@example.com");
    expect(await as.query(api.emailVerification.getEmailVerificationStatus, {})).toEqual({ verified: false, maskedEmail: "a…@example.com" });
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const s = await as.query(api.emailVerification.getEmailVerificationStatus, {});
    expect(s).toEqual({ verified: false, canResendAt: Date.now() + EMAIL_CODE_RESEND_COOLDOWN_MS, maskedEmail: "a…@example.com" });
    expect(await t.query(api.emailVerification.getEmailVerificationStatus, {})).toEqual({ verified: false });
  });

  test("usuário existente sem verificação continua não verificado (sem efeito colateral)", async () => {
    const { userId } = await mkUser("old@example.com");
    expect(await t.run(async (ctx) => isEmailVerifiedForMaterials(ctx, userId as Id<"users">))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("cron apaga só os vencidos", async () => {
    const { userId, as } = await mkUser("a@example.com");
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    await t.run(async (ctx) => {
      await ctx.db.insert("emailVerificationCodes", {
        userId, codeHash: "x", expiresAt: Date.now() - 1, attempts: 0, createdAt: 0,
      });
    });
    const n = await t.mutation(internal.emailVerification.internalPruneEmailVerificationCodes, {});
    expect(n).toBe(1);
    const rows = await t.run(async (ctx) => ctx.db.query("emailVerificationCodes").collect());
    expect(rows).toHaveLength(1);
  });

  test("gerador: 6 dígitos com zeros à esquerda preservados", () => {
    for (let i = 0; i < 200; i++) expect(generateEmailVerificationCode()).toMatch(/^\d{6}$/);
  });
});

describe("endurecimento (revisão P2.6)", () => {
  test("sem JWT_PRIVATE_KEY nem pepper o pedido é recusado e nada é enviado", async () => {
    vi.stubEnv("JWT_PRIVATE_KEY", "");
    vi.stubEnv("EMAIL_CODE_PEPPER", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { as } = await mkUser("a@example.com");
    await expect(as.mutation(api.emailVerification.requestEmailVerificationCode, {})).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  test("pepper muda o hash e o e-mail entra no HMAC", async () => {
    const base = await hashEmailVerificationCode("u1", "a@example.com", "123456");
    expect(await hashEmailVerificationCode("u1", "b@example.com", "123456")).not.toBe(base);
    vi.stubEnv("EMAIL_CODE_PEPPER", "fake-pepper");
    expect(await hashEmailVerificationCode("u1", "a@example.com", "123456")).not.toBe(base);
  });

  test("código trocado de e-mail (a conta mudou de endereço) não confirma", async () => {
    const { userId, as } = await mkUser("a@example.com");
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const code = lastCode();
    await t.run(async (ctx) => ctx.db.patch(userId, { email: "novo@example.com" }));
    const r = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code });
    expect(r.verified).toBe(false);
  });

  test("teto diário de 10 pedidos por usuário (janela de 24 h)", async () => {
    const { as } = await mkUser("a@example.com");
    for (let i = 0; i < EMAIL_CODE_REQUESTS_PER_DAY; i++) {
      const r = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
      expect(r.sent).toBe(true);
      wait(61 * 60 * 1000); // a janela horária reinicia, a diária não
    }
    const blocked = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(blocked).toEqual({ sent: false, reason: "rate_limited" });
    wait(EMAIL_CODE_DAY_MS);
    const later = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(later.sent).toBe(true);
  });

  test("formato inválido (após remover espaços) não gasta tentativa; com espaços válidos confirma", async () => {
    const { as } = await mkUser("a@example.com");
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const code = lastCode();
    for (const bad of ["12345", "abcdef", "1234567", ""]) {
      const r = await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: bad });
      expect(r).toEqual({ verified: false, reason: "wrong", attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS });
    }
    const rows = await t.run(async (ctx) => ctx.db.query("emailVerificationCodes").collect());
    expect(rows[0].attempts).toBe(0);
    const ok = await as.mutation(api.emailVerification.confirmEmailVerificationCode, {
      code: ` ${code.slice(0, 3)} ${code.slice(3)} `,
    });
    expect(ok.verified).toBe(true);
  });

  test("bloqueio após 5 erros grava audit medium", async () => {
    const { userId, as } = await mkUser("a@example.com");
    const orgId = await t.run(async (ctx) => {
      const org = await ctx.db.insert("organizations", {
        name: "O", slug: "o-lock", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: 1, updatedAt: 1,
      } as never);
      await ctx.db.insert("teamMembers", {
        organizationId: org, userId, name: "U", role: "admin", type: "human", status: "active", createdAt: 1, updatedAt: 1,
      } as never);
      return org;
    });
    await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    const wrong = lastCode() === "111111" ? "222222" : "111111";
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
      await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: wrong });
    }
    const audits = await t.run(async (ctx) =>
      ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).collect(),
    );
    expect(audits.map((a) => a.severity)).toEqual(["medium"]);
  });

  test("15 erros acumulados em 24 h bloqueiam novos pedidos até a janela fechar", async () => {
    const { as } = await mkUser("a@example.com");
    let failures = 0;
    while (failures < EMAIL_CODE_MAX_FAILURES_PER_DAY) {
      const req = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
      expect(req.sent).toBe(true);
      const wrong = lastCode() === "111111" ? "222222" : "111111";
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS && failures < EMAIL_CODE_MAX_FAILURES_PER_DAY; i++) {
        await as.mutation(api.emailVerification.confirmEmailVerificationCode, { code: wrong });
        failures++;
      }
      wait(EMAIL_CODE_RESEND_COOLDOWN_MS + 1);
    }
    const blocked = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(blocked).toEqual({ sent: false, reason: "rate_limited" });
    wait(EMAIL_CODE_DAY_MS);
    const later = await as.mutation(api.emailVerification.requestEmailVerificationCode, {});
    expect(later.sent).toBe(true);
  });

  test("cron também apaga contadores de janela vencidos e mantém os vivos", async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert("authEmailThrottle", { email: "verify-user-d:x", windowStart: Date.now() - EMAIL_CODE_DAY_MS - 1, count: 3 });
      await ctx.db.insert("authEmailThrottle", { email: "verify-user-d:y", windowStart: Date.now() - 1000, count: 3 });
    });
    await t.mutation(internal.emailVerification.internalPruneEmailVerificationCodes, {});
    const rows = await t.run(async (ctx) => ctx.db.query("authEmailThrottle").collect());
    expect(rows.map((r) => r.email)).toEqual(["verify-user-d:y"]);
  });
});
