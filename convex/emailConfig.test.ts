/// <reference types="vite/client" />
/**
 * Guarda do pipeline de e-mail transacional. Nasceu de um incidente: o
 * componente `@convex-dev/resend` tem `testMode: true` por DEFAULT e o código
 * nunca desligou — nenhum e-mail saiu por meses, e a suíte inteira passava verde
 * porque nenhum teste chegava perto do envio. Prova que:
 *  - o envio real é o padrão, e o sandbox é opt-in por env;
 *  - `dispatchNotification` NUNCA lança e barra: outra org, membro sem conta,
 *    endereço impossível, eventType desconhecido;
 *  - hard bounce e denúncia de spam suprimem o endereço (transitório não);
 *  - entrada de formulário público sai escapada no HTML;
 *  - lead não pode ser atribuído a membro de outra organização.
 *
 * O componente Resend NÃO é registrado aqui: `resend.sendEmail` lança por
 * componente ausente, e é exatamente isso que exercita o "nunca lança" da porta
 * de saída.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { resend, resendTestMode } from "./email";
import { buildTemplate } from "./emailTemplates";
import { appUrl } from "./lib/appUrl";
import { hasEmailShape, isDeliverableEmail, maskEmailForLog } from "./lib/emailAddress";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  t = convexTest(schema, modules);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("configuração do Resend", () => {
  test("envio REAL é o padrão — o default do componente (testMode: true) não pode voltar", () => {
    vi.stubEnv("RESEND_TEST_MODE", "");
    expect(resendTestMode()).toBe(false);
    expect(resend.config.testMode).toBe(false);
  });

  test("sandbox só com opt-in explícito", () => {
    vi.stubEnv("RESEND_TEST_MODE", "true");
    expect(resendTestMode()).toBe(true);
    vi.stubEnv("RESEND_TEST_MODE", "1");
    expect(resendTestMode()).toBe(false);
  });

  test("appUrl: fallback no domínio real e sem barra final", () => {
    vi.stubEnv("APP_URL", "");
    expect(appUrl()).toBe("https://hnbcrm.com");
    vi.stubEnv("APP_URL", "https://crm.exemplo.com.br//");
    expect(appUrl()).toBe("https://crm.exemplo.com.br");
  });
});

describe("endereços", () => {
  test("barra o lixo que já está gravado no banco", () => {
    for (const bad of ["toni", "fdgfdg@gdffdgf", "oli@milfont.netdd1", "a@b", "", "  ", "dois @x.com", "x@y..com"]) {
      expect(isDeliverableEmail(bad), bad).toBe(false);
    }
  });

  test("barra domínio de seed/reservado, mas o formato em si é válido", () => {
    expect(isDeliverableEmail("maria@demo.com")).toBe(false);
    expect(isDeliverableEmail("x@example.com")).toBe(false);
    expect(isDeliverableEmail("x@empresa.test")).toBe(false);
    expect(hasEmailShape("maria@demo.com")).toBe(true);
  });

  test("aceita endereço real e o de teste do Resend, normalizando", () => {
    expect(isDeliverableEmail("  Eric@Milfont.NET ")).toBe(true);
    expect(isDeliverableEmail("delivered+x@resend.dev")).toBe(true);
    expect(isDeliverableEmail("joao.silva@sindicato.org.br")).toBe(true);
  });

  test("log nunca leva o endereço inteiro", () => {
    expect(maskEmailForLog("eric@milfont.net")).toBe("***@milfont.net");
    expect(maskEmailForLog("toni")).toBe("***");
  });
});

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = async (slug: string) =>
      await ctx.db.insert("organizations", {
        name: slug,
        slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
    const orgA = await mkOrg("org-a");
    const orgB = await mkOrg("org-b");

    const mkMember = async (
      organizationId: typeof orgA,
      email: string | undefined,
      opts: { linked?: boolean; type?: "human" | "ai" } = {},
    ) => {
      const userId = opts.linked === false ? undefined : await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name: email ?? "sem-email",
        email,
        role: opts.type === "ai" ? "ai" : "admin",
        type: opts.type ?? "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };

    return {
      orgA,
      orgB,
      adminA: await mkMember(orgA, "admin@empresa-a.com.br"),
      memberB: await mkMember(orgB, "alguem@empresa-b.com.br"),
      seedMember: await mkMember(orgA, "maria@demo.com", { linked: false }),
      brokenEmail: await mkMember(orgA, "toni"),
      ai: await mkMember(orgA, undefined, { linked: false, type: "ai" }),
    };
  });
}

const leadAssigned = {
  eventType: "leadAssigned",
  templateData: { leadTitle: "Lead secreto", assignedByName: "Admin", leadUrl: "https://hnbcrm.com/app/pipeline" },
};

describe("dispatchNotification — gates e 'nunca lança'", () => {
  test("membro de OUTRA organização não recebe (defesa multi-tenant)", async () => {
    const s = await seed(t);
    const sent = await t.mutation(internal.email.dispatchNotification, {
      organizationId: s.orgA,
      recipientMemberId: s.memberB.memberId,
      ...leadAssigned,
    });
    expect(sent).toBe(false);
  });

  test("membro sem conta vinculada (seed), IA e endereço impossível: false, sem lançar", async () => {
    const s = await seed(t);
    for (const m of [s.seedMember, s.ai, s.brokenEmail]) {
      const sent = await t.mutation(internal.email.dispatchNotification, {
        organizationId: s.orgA,
        recipientMemberId: m.memberId,
        ...leadAssigned,
      });
      expect(sent).toBe(false);
    }
  });

  test("eventType desconhecido não vira e-mail vazio nem derruba quem chamou", async () => {
    const s = await seed(t);
    const sent = await t.mutation(internal.email.dispatchNotification, {
      organizationId: s.orgA,
      recipientMemberId: s.adminA.memberId,
      eventType: "leadAsigned", // typo de propósito
      templateData: {},
    });
    expect(sent).toBe(false);
    expect(() => buildTemplate("leadAsigned", {})).toThrow(/desconhecido/);
  });

  test("falha do provedor (aqui: componente ausente) é engolida — devolve false", async () => {
    const s = await seed(t);
    const sent = await t.mutation(internal.email.dispatchNotification, {
      organizationId: s.orgA,
      recipientMemberId: s.adminA.memberId,
      ...leadAssigned,
    });
    expect(sent).toBe(false);
  });

  test("endereço suprimido não chega nem a tentar o envio", async () => {
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("emailSuppressions", {
        email: "admin@empresa-a.com.br",
        reason: "bounced",
        createdAt: Date.now(),
      });
    });
    const sent = await t.mutation(internal.email.dispatchNotification, {
      organizationId: s.orgA,
      recipientMemberId: s.adminA.memberId,
      ...leadAssigned,
    });
    expect(sent).toBe(false);
    expect(console.error).not.toHaveBeenCalled(); // parou na supressão, não no provedor
  });
});

describe("webhook do Resend → supressão", () => {
  const common = {
    created_at: "2026-09-18T11:00:00.000Z",
    email_id: "re_1",
    from: "HNBCRM <noreply@mail.hnbcrm.com>",
    subject: "x",
  };
  const suppressions = () => t.run(async (ctx) => await ctx.db.query("emailSuppressions").collect());

  test("hard bounce suprime (normalizado, idempotente); transitório não", async () => {
    const bounce = (to: string, type: string) => ({
      id: "email_1" as any,
      event: {
        type: "email.bounced" as const,
        created_at: common.created_at,
        data: { ...common, to: [to], bounce: { type, subType: "General", message: "mailbox does not exist" } },
      },
    });
    await t.mutation(internal.email.handleEmailEvent, bounce("cheia@empresa.com.br", "Transient"));
    expect(await suppressions()).toHaveLength(0);

    await t.mutation(internal.email.handleEmailEvent, bounce(" Morto@Empresa.com.br", "Permanent"));
    await t.mutation(internal.email.handleEmailEvent, bounce("morto@empresa.com.br", "Permanent"));
    const rows = await suppressions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "morto@empresa.com.br", reason: "bounced" });
  });

  test("denúncia de spam suprime; sent/delivered não", async () => {
    const ev = (type: "email.complained" | "email.delivered") => ({
      id: "email_2" as any,
      event: { type, created_at: common.created_at, data: { ...common, to: "bravo@empresa.com.br" } },
    });
    await t.mutation(internal.email.handleEmailEvent, ev("email.delivered"));
    expect(await suppressions()).toHaveLength(0);
    await t.mutation(internal.email.handleEmailEvent, ev("email.complained"));
    expect(await suppressions()).toMatchObject([{ email: "bravo@empresa.com.br", reason: "complained" }]);
  });
});

describe("templates com entrada pública", () => {
  test("formSubmission escapa nome/e-mail vindos do formulário anônimo", () => {
    const { html } = buildTemplate("formSubmission", {
      formName: "Contato",
      contactName: `<a href="https://phish.example">clique</a>`,
      contactEmail: `x@y.com"><img src=x>`,
      leadUrl: "https://hnbcrm.com/app/pipeline",
    });
    expect(html).not.toContain("<a href=\"https://phish.example\">");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;a href=");
  });

  test("formConfirmation escapa os valores submetidos (no resumo e nos {placeholders})", () => {
    const { html } = buildTemplate("formConfirmation", {
      formName: "Contato",
      body: "Olá {Nome}, recebemos.",
      submittedData: { f1: "<script>alert(1)</script>", "f.2": "$& ok" },
      fieldLabels: { f1: "Nome", "f.2": "Obs (livre)" },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Olá &lt;script&gt;");
    expect(html).toContain("$&amp; ok");
  });
});

describe("assignLead — responsável tem que ser da mesma org", () => {
  test("id de membro de outra organização é recusado e nada é agendado", async () => {
    const s = await seed(t);
    const leadId = await t.run(async (ctx) => {
      const now = Date.now();
      const boardId = await ctx.db.insert("boards", {
        organizationId: s.orgA, name: "Funil", color: "#3b82f6", isDefault: true, order: 0, createdAt: now, updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId: s.orgA, boardId, name: "Novo", color: "#6366f1", order: 0,
        isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
      });
      return await ctx.db.insert("leads", {
        organizationId: s.orgA, title: "Lead secreto", boardId, stageId, value: 0, currency: "BRL",
        priority: "high", temperature: "hot", tags: [], customFields: {}, conversationStatus: "active",
        lastActivityAt: now, createdAt: now, updatedAt: now,
      });
    });

    const asAdminA = t.withIdentity({ subject: `${s.adminA.userId}|s1` });
    await expect(
      asAdminA.mutation(api.leads.assignLead, { leadId, assignedTo: s.memberB.memberId }),
    ).rejects.toThrow(/nesta organização/);

    const scheduled = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name.includes("dispatchNotification"))).toHaveLength(0);
    const lead = await t.run(async (ctx) => await ctx.db.get(leadId));
    expect(lead?.assignedTo).toBeUndefined();
  });
});
