/// <reference types="vite/client" />
/**
 * Entrada unificada: `authEntry.checkEmailForSignIn` (decisão D16).
 * Responde só `{ next }`, normaliza como o login, conta por e-mail (sem teto global).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  SIGNIN_CHECK_PER_EMAIL,
  SIGNIN_CHECK_RATE_LIMITED_MESSAGE,
  SIGNIN_CHECK_WINDOW_MS,
  signInCheckEmailKey,
} from "./lib/signInCheck";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.useRealTimers();
});

async function makeAccount(providerAccountId: string) {
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: providerAccountId, name: "Pessoa Teste" });
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId,
      secret: "hash-de-teste",
    });
  });
}

async function check(email: string) {
  return await t.mutation(api.authEntry.checkEmailForSignIn, { email });
}

async function expectRateLimited(email: string) {
  const err = await check(email).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConvexError);
  // convex-test entrega `data` serializado; o cliente real recebe o objeto.
  const raw: unknown = (err as ConvexError<string>).data;
  expect(typeof raw === "string" ? JSON.parse(raw) : raw).toEqual({
    code: "rate_limited",
    message: SIGNIN_CHECK_RATE_LIMITED_MESSAGE,
  });
}

describe("checkEmailForSignIn", () => {
  test("conta existente pede senha; inexistente vai para o cadastro", async () => {
    await makeAccount("ana@empresa-teste.com");
    expect(await check("ana@empresa-teste.com")).toEqual({ next: "password" });
    expect(await check("bruno@empresa-teste.com")).toEqual({ next: "signup" });
  });

  test("devolve só `next`, sem nenhum outro campo", async () => {
    await makeAccount("ana@empresa-teste.com");
    for (const email of ["ana@empresa-teste.com", "ninguem@empresa-teste.com"]) {
      const result = await check(email);
      expect(Object.keys(result)).toEqual(["next"]);
    }
  });

  test("normaliza maiúsculas e espaços como o login", async () => {
    await makeAccount("ana@empresa-teste.com");
    expect(await check("  ANA@Empresa-Teste.COM  ")).toEqual({ next: "password" });
  });

  test("acha conta legada gravada com maiúsculas", async () => {
    await makeAccount("Carla@Empresa-Teste.com");
    expect(await check("carla@empresa-teste.com")).toEqual({ next: "password" });
  });

  test("e-mail vazio é recusado com mensagem legível", async () => {
    await expect(check("   ")).rejects.toThrow();
  });

  test("rate limit por e-mail: estoura no teto, conta variantes de caixa juntas e volta na janela seguinte", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < SIGNIN_CHECK_PER_EMAIL; i++) {
        await check(i % 2 ? "Alvo@Empresa-Teste.com" : "alvo@empresa-teste.com");
      }
      await expectRateLimited("ALVO@empresa-teste.com");
      // Outro e-mail segue livre.
      expect(await check("outro@empresa-teste.com")).toEqual({ next: "signup" });
      // A recusa não consome cota.
      const row = await t.run((ctx) =>
        ctx.db
          .query("authEmailThrottle")
          .withIndex("by_email", (q) => q.eq("email", signInCheckEmailKey("alvo@empresa-teste.com")))
          .first(),
      );
      expect(row?.count).toBe(SIGNIN_CHECK_PER_EMAIL);

      vi.advanceTimersByTime(SIGNIN_CHECK_WINDOW_MS);
      expect(await check("alvo@empresa-teste.com")).toEqual({ next: "signup" });
    } finally {
      warn.mockRestore();
    }
  });

  test("sem teto global: muitos e-mails diferentes não gravam documento compartilhado", async () => {
    for (let i = 0; i < 15; i++) await check(`pessoa${i}@empresa-teste.com`);
    const rows = await t.run((ctx) => ctx.db.query("authEmailThrottle").take(50));
    expect(rows).toHaveLength(15);
    expect(new Set(rows.map((r) => r.email)).size).toBe(15);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  test("chave do contador tem espaço (nunca coincide com a chave do reset) e e-mail com espaço no meio é recusado", async () => {
    await check("ana@empresa-teste.com");
    const rows = await t.run((ctx) => ctx.db.query("authEmailThrottle").take(5));
    expect(rows.map((r) => r.email)).toEqual([signInCheckEmailKey("ana@empresa-teste.com")]);
    expect(rows[0].email).toContain(" ");
    await expect(check("ana silva@empresa-teste.com")).rejects.toThrow();
  });

  test("não mexe no contador do reset de senha do mesmo endereço", async () => {
    await check("ana@empresa-teste.com");
    const resetRow = await t.run((ctx) =>
      ctx.db
        .query("authEmailThrottle")
        .withIndex("by_email", (q) => q.eq("email", "ana@empresa-teste.com"))
        .first(),
    );
    expect(resetRow).toBeNull();
  });

  test("não cria usuário nem conta", async () => {
    await check("novo@empresa-teste.com");
    const [users, accounts] = await t.run(async (ctx) => [
      await ctx.db.query("users").take(5),
      await ctx.db.query("authAccounts").take(5),
    ]);
    expect(users).toHaveLength(0);
    expect(accounts).toHaveLength(0);
  });
});
