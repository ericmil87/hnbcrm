/// <reference types="vite/client" />
/**
 * Backend de "redefinir senha por e-mail" e "e-mail de boas-vindas".
 *
 * O componente Resend NÃO está registrado nos testes (convex.config.ts não
 * é montado por convex-test), então nenhum destes testes drena a fila do
 * scheduler — `sendWelcomeEmail`/`sendPasswordResetCode` são internalMutations
 * agendadas com runAfter(0) e ficam "pending" até o afterEach cancelar.
 */
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildPasswordResetTemplate, buildWelcomeTemplate } from "./authEmailTemplates";
import { generateResetCode } from "./passwordReset";
import { RESET_EMAILS_PER_WINDOW } from "./authEmails";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  t = convexTest(schema, modules);
});

afterEach(async () => {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
});

// ===== (a) Templates =====

describe("templates de e-mail de auth", () => {
  test("buildPasswordResetTemplate mostra o código e a validade", () => {
    const { subject, html } = buildPasswordResetTemplate({
      code: "12345678",
      expiresMinutes: 15,
    });

    expect(subject.length).toBeGreaterThan(0);
    expect(html).toContain("12345678");
    expect(html).toContain("15 minutos");
    // Não é um link de ação — é um código para digitar na tela de reset.
    expect(html).not.toContain("<a href=\"\"");
  });

  test("buildWelcomeTemplate escapa nome e nome de organização", () => {
    const { html } = buildWelcomeTemplate({
      memberName: "Ana <b>Admin</b>",
      orgName: "<script>alert(1)</script>",
      appUrl: "https://hnbcrm.com",
    });

    // O HTML malicioso nunca aparece cru...
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>Admin</b>");
    // ...mas o texto escapado está presente.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;Admin&lt;/b&gt;");
    // CTA aponta para /app do appUrl passado.
    expect(html).toContain("https://hnbcrm.com/app\"");
  });
});

// ===== (b) Gerador do código de reset =====

describe("generateResetCode", () => {
  test("gera 8 dígitos numéricos, sem viés visível de tamanho", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateResetCode();
      expect(code).toMatch(/^\d{8}$/);
    }
  });

  test("dois códigos seguidos não são idênticos (checagem de sanidade, não estatística)", () => {
    const a = generateResetCode();
    const b = generateResetCode();
    // Chance de colisão de 2 códigos de 8 dígitos é 1 em 100 milhões —
    // um teste flaky aqui seria sinal de o RNG estar quebrado, não sorte.
    expect(a).not.toBe(b);
  });
});

// ===== (c) createOrganization agenda sendWelcomeEmail =====

describe("createOrganization → e-mail de boas-vindas", () => {
  test("agenda authEmails.sendWelcomeEmail com organizationId + teamMemberId corretos", async () => {
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", { name: "Nova Admin", email: "nova-admin@example.com" });
    });

    const asUser = t.withIdentity({ subject: `${userId}|s1` });
    const organizationId = await asUser.mutation(api.organizations.createOrganization, {
      name: "Empresa Boas-Vindas",
      slug: "empresa-boas-vindas-test",
    });

    const teamMemberId: Id<"teamMembers"> = await t.run(async (ctx) => {
      const member = await ctx.db
        .query("teamMembers")
        .withIndex("by_organization_and_user", (q) =>
          q.eq("organizationId", organizationId).eq("userId", userId)
        )
        .first();
      if (!member) throw new Error("teamMember admin não foi criado");
      return member._id;
    });

    const scheduled = await t.run(async (ctx) => {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      return jobs.filter((j) => j.name.includes("authEmails") && j.name.includes("sendWelcomeEmail"));
    });

    expect(scheduled.length).toBe(1);
    expect(scheduled[0].state.kind).toBe("pending");
    const args = scheduled[0].args?.[0] as any;
    expect(args.organizationId).toBe(organizationId);
    expect(args.teamMemberId).toBe(teamMemberId);
  });
});

// ===== (d) clearMustChangePasswordAfterReset =====

describe("clearMustChangePasswordAfterReset", () => {
  async function seedTwoUsersWithFlag(t: TestConvex<typeof schema>) {
    return await t.run(async (ctx) => {
      const now = Date.now();

      const orgA = await ctx.db.insert("organizations", {
        name: "Org A", slug: "org-a-reset-flag",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now, updatedAt: now,
      });
      const orgB = await ctx.db.insert("organizations", {
        name: "Org B", slug: "org-b-reset-flag",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now, updatedAt: now,
      });

      const userAId = await ctx.db.insert("users", { name: "User A", email: "a@example.com" });
      const userBId = await ctx.db.insert("users", { name: "User B", email: "b@example.com" });

      // User A é membro de DUAS orgs, ambas com a flag ligada — prova que
      // o clear não é escopado a uma única organização.
      const memberA1 = await ctx.db.insert("teamMembers", {
        organizationId: orgA, userId: userAId, name: "User A", role: "admin", type: "human",
        status: "active", mustChangePassword: true, createdAt: now, updatedAt: now,
      });
      const memberA2 = await ctx.db.insert("teamMembers", {
        organizationId: orgB, userId: userAId, name: "User A", role: "agent", type: "human",
        status: "active", mustChangePassword: true, createdAt: now, updatedAt: now,
      });
      // User B tem a flag ligada também — não deve ser tocado quando A roda a mutation.
      const memberB = await ctx.db.insert("teamMembers", {
        organizationId: orgA, userId: userBId, name: "User B", role: "agent", type: "human",
        status: "active", mustChangePassword: true, createdAt: now, updatedAt: now,
      });

      return { userAId, userBId, memberA1, memberA2, memberB };
    });
  }

  test("limpa a flag em TODOS os memberships do próprio usuário, e só dele", async () => {
    const { userAId, memberA1, memberA2, memberB } = await seedTwoUsersWithFlag(t);

    const asUserA = t.withIdentity({ subject: `${userAId}|s1` });
    await asUserA.mutation(api.teamMembers.clearMustChangePasswordAfterReset, {});

    const [a1, a2, b] = await t.run(async (ctx) => {
      return await Promise.all([
        ctx.db.get(memberA1),
        ctx.db.get(memberA2),
        ctx.db.get(memberB),
      ]);
    });

    expect(a1?.mustChangePassword).toBe(false);
    expect(a2?.mustChangePassword).toBe(false);
    // Membro de outro usuário permanece intocado.
    expect(b?.mustChangePassword).toBe(true);
  });

  test("sem sessão autenticada, não lança e não muda nada", async () => {
    const { memberA1, memberB } = await seedTwoUsersWithFlag(t);

    await expect(t.mutation(api.teamMembers.clearMustChangePasswordAfterReset, {})).resolves.toBeNull();

    const [a1, b] = await t.run(async (ctx) => {
      return await Promise.all([ctx.db.get(memberA1), ctx.db.get(memberB)]);
    });
    expect(a1?.mustChangePassword).toBe(true);
    expect(b?.mustChangePassword).toBe(true);
  });
});

describe("sendPasswordResetCode — teto de pedidos por endereço", () => {
  test("conta por endereço NORMALIZADO, para no teto e nunca lança", async () => {
    // O componente Resend não está registrado: o envio falha e é engolido pela
    // porta de saída — o que interessa aqui é o contador.
    for (let i = 0; i < RESET_EMAILS_PER_WINDOW + 3; i++) {
      await t.mutation(internal.authEmails.sendPasswordResetCode, {
        email: i % 2 ? "Alvo@Empresa.com.br " : "alvo@empresa.com.br",
        code: "12345678",
      });
    }
    await t.mutation(internal.authEmails.sendPasswordResetCode, { email: "outra@empresa.com.br", code: "12345678" });

    const rows = await t.run(async (ctx) => await ctx.db.query("authEmailThrottle").collect());
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.email === "alvo@empresa.com.br")?.count).toBe(RESET_EMAILS_PER_WINDOW);
    expect(rows.find((r) => r.email === "outra@empresa.com.br")?.count).toBe(1);
  });
});
