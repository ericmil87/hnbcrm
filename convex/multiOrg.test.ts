/// <reference types="vite/client" />
/**
 * Usuário ↔ organização N:N: remoção corta o acesso, convite não duplica nem
 * sequestra conta, e-mail sem caixa, API key presa à org, settings em merge,
 * assistente de onboarding decidido pela org.
 *
 * O componente Resend não é registrado aqui (ver authEmails.test.ts): o envio
 * de e-mail "falha" dentro de `sendTransactionalEmail`, que nunca lança — o
 * teste confere a TENTATIVA pelo log de erro com o `kind` do e-mail.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  t = convexTest(schema, modules);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
});

type Role = "admin" | "manager" | "agent";

async function makeUser(email: string, name = email.split("@")[0]) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email, name });
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: email,
      secret: "hash-original",
    });
    return userId;
  });
}

async function makeOrg(name: string, slug: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("organizations", {
      name,
      slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
}

async function addMember(
  organizationId: Id<"organizations">,
  userId: Id<"users"> | undefined,
  role: Role,
  email: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: email.split("@")[0],
      email,
      role,
      type: "human",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
}

function as(userId: Id<"users">) {
  return t.withIdentity({ subject: `${userId}|s1` });
}

async function setup() {
  const adminUser = await makeUser("admin@acme.com.br");
  const orgA = await makeOrg("Acme", "acme");
  const adminA = await addMember(orgA, adminUser, "admin", "admin@acme.com.br");
  return { adminUser, orgA, adminA };
}

describe("remoção corta o acesso", () => {
  test("removido perde requireAuth, some do seletor e não se reativa sozinho", async () => {
    const { adminUser, orgA } = await setup();
    const joao = await makeUser("joao@acme.com.br");
    const joaoMember = await addMember(orgA, joao, "agent", "joao@acme.com.br");

    // Antes: vê a org.
    expect(await as(joao).query(api.organizations.getUserOrganizations, {})).toHaveLength(1);

    await as(adminUser).mutation(api.teamMembers.removeTeamMember, { teamMemberId: joaoMember });

    const row = await t.run((ctx) => ctx.db.get(joaoMember));
    expect(row?.removedAt).toBeTypeOf("number");
    expect(row?.status).toBe("inactive");

    await expect(
      as(joao).query(api.teamMembers.getTeamMembers, { organizationId: orgA })
    ).rejects.toThrow("Not authorized");
    // Lookup manual (fora de requireAuth) também recusa.
    await expect(
      as(joao).query(api.leadSources.getLeadSources, { organizationId: orgA })
    ).rejects.toThrow("Not authorized");
    expect(await as(joao).query(api.organizations.getUserOrganizations, {})).toHaveLength(0);
    expect(
      await as(joao).query(api.teamMembers.getCurrentTeamMember, { organizationId: orgA })
    ).toBeNull();

    // Não consegue se pôr de volta em "active".
    await expect(
      as(joao).mutation(api.teamMembers.updateTeamMemberStatus, {
        teamMemberId: joaoMember,
        status: "active",
      })
    ).rejects.toThrow();

    // A lista da equipe marca o removido (histórico fica).
    const team = await as(adminUser).query(api.teamMembers.getTeamMembers, { organizationId: orgA });
    expect(team.find((m: any) => m._id === joaoMember)?.removed).toBe(true);
  });

  test("status 'inactive' legado também conta como removido", async () => {
    const { orgA } = await setup();
    const ana = await makeUser("ana@acme.com.br");
    const anaMember = await addMember(orgA, ana, "agent", "ana@acme.com.br");
    await t.run((ctx) => ctx.db.patch(anaMember, { status: "inactive" }));
    await expect(
      as(ana).query(api.teamMembers.getTeamMembers, { organizationId: orgA })
    ).rejects.toThrow("Not authorized");
  });

  test("ninguém se marca 'inactive' por updateTeamMemberStatus (contornaria último admin)", async () => {
    const { adminUser, adminA } = await setup();
    await expect(
      as(adminUser).mutation(api.teamMembers.updateTeamMemberStatus, {
        teamMemberId: adminA,
        status: "inactive",
      })
    ).rejects.toThrow("Remover membro");
    // Presença segue funcionando.
    await as(adminUser).mutation(api.teamMembers.updateTeamMemberStatus, {
      teamMemberId: adminA,
      status: "busy",
    });
  });

  test("admin 'busy' conta na guarda de último admin", async () => {
    const { adminUser, orgA, adminA } = await setup();
    const bia = await makeUser("bia@acme.com.br");
    const biaMember = await addMember(orgA, bia, "admin", "bia@acme.com.br");
    await t.run((ctx) => ctx.db.patch(biaMember, { status: "busy" }));
    // Com a Bia (busy) como outra admin, rebaixar o admin original é permitido.
    await as(bia).mutation(api.teamMembers.updateTeamMember, {
      teamMemberId: adminA,
      role: "manager",
    });
    expect((await t.run((ctx) => ctx.db.get(adminA)))?.role).toBe("manager");
    void adminUser;
  });

  test("API key de membro removido deixa de valer", async () => {
    const { adminUser, orgA, adminA } = await setup();
    const bot = await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        organizationId: orgA,
        name: "Bot",
        role: "ai",
        type: "ai",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await t.mutation(internal.apiKeys.insertApiKey, {
      organizationId: orgA,
      teamMemberId: bot,
      name: "k",
      keyHash: "hash-bot",
      actorId: adminA,
    });
    expect(await t.query(internal.apiKeys.getByKeyHash, { keyHash: "hash-bot" })).not.toBeNull();

    await as(adminUser).mutation(api.teamMembers.removeTeamMember, { teamMemberId: bot });
    expect(await t.query(internal.apiKeys.getByKeyHash, { keyHash: "hash-bot" })).toBeNull();
  });
});

describe("API key presa à org", () => {
  test("insertApiKey recusa membro de outra org; getByKeyHash recusa incoerência", async () => {
    const { orgA, adminA } = await setup();
    const orgB = await makeOrg("Beta", "beta");
    const outsider = await makeUser("x@beta.com.br");
    const outsiderMember = await addMember(orgB, outsider, "admin", "x@beta.com.br");

    await expect(
      t.mutation(internal.apiKeys.insertApiKey, {
        organizationId: orgA,
        teamMemberId: outsiderMember,
        name: "cross",
        keyHash: "hash-cross",
        actorId: adminA,
      })
    ).rejects.toThrow("não pertence");

    // Dado legado já cruzado: a chave não autentica.
    await t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        organizationId: orgA,
        teamMemberId: outsiderMember,
        name: "legado",
        keyHash: "hash-legado",
        isActive: true,
        createdAt: Date.now(),
      })
    );
    expect(await t.query(internal.apiKeys.getByKeyHash, { keyHash: "hash-legado" })).toBeNull();
  });
});

describe("convite", () => {
  test("usuário existente entra na 2ª org: senha intacta, vínculo, aviso por e-mail", async () => {
    const { adminUser, orgA } = await setup();
    const orgB = await makeOrg("Beta", "beta");
    await addMember(orgB, adminUser, "admin", "admin@acme.com.br");
    const maria = await makeUser("maria@acme.com.br");
    await addMember(orgA, maria, "agent", "maria@acme.com.br");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await as(adminUser).action(api.nodeActions.inviteHumanMember, {
      organizationId: orgB,
      name: "Maria",
      email: "  Maria@ACME.com.br ",
      role: "agent",
    });

    expect(result.isNewUser).toBe(false);
    expect(result.existingUser).toBe(true);
    expect(result.reactivated).toBe(false);
    expect(result.tempPassword).toBeUndefined();

    const account = await t.run((ctx) =>
      ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "password").eq("providerAccountId", "maria@acme.com.br")
        )
        .first()
    );
    expect(account?.secret).toBe("hash-original");
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users.filter((u) => u.email?.toLowerCase() === "maria@acme.com.br")).toHaveLength(1);

    const member = await t.run((ctx) => ctx.db.get(result.teamMemberId));
    expect(member?.userId).toBe(maria);
    expect(member?.mustChangePassword).toBe(false);
    const mariaOrgs = await as(maria).query(api.organizations.getUserOrganizations, {});
    expect(mariaOrgs).toHaveLength(2);
    expect(mariaOrgs.find((o: any) => o._id === orgB)?.invited).toBe(true);
    expect(mariaOrgs.find((o: any) => o._id === orgA)?.invited).toBe(false);

    // Tentou o e-mail "você foi adicionado" pela porta única.
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("addedToOrg"))).toBe(true);
  });

  test("usuário novo: e-mail normalizado, conta criada uma vez, reconvite ativo é recusado", async () => {
    const { adminUser, orgA } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await as(adminUser).action(api.nodeActions.inviteHumanMember, {
      organizationId: orgA,
      name: "Caio",
      email: "Caio@Acme.com.br",
      role: "agent",
    });
    expect(first.isNewUser).toBe(true);
    expect(first.tempPassword).toBeTruthy();

    const user = await t.query(internal.authHelpers.queryUserByEmail, { email: "CAIO@acme.com.br" });
    expect(user?.email).toBe("caio@acme.com.br");

    await expect(
      as(adminUser).action(api.nodeActions.inviteHumanMember, {
        organizationId: orgA,
        name: "Caio",
        email: "caio@acme.com.br",
        role: "agent",
      })
    ).rejects.toThrow("já é membro");

    const members = await t.run((ctx) =>
      ctx.db.query("teamMembers").withIndex("by_organization", (q) => q.eq("organizationId", orgA)).collect()
    );
    expect(members.filter((m) => m.email === "caio@acme.com.br")).toHaveLength(1);
  });

  test("reconvidar removido reativa a MESMA linha", async () => {
    const { adminUser, orgA } = await setup();
    const joao = await makeUser("joao@acme.com.br");
    const joaoMember = await addMember(orgA, joao, "agent", "joao@acme.com.br");
    await as(adminUser).mutation(api.teamMembers.removeTeamMember, { teamMemberId: joaoMember });

    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await as(adminUser).action(api.nodeActions.inviteHumanMember, {
      organizationId: orgA,
      name: "João",
      email: "joao@acme.com.br",
      role: "manager",
    });
    expect(result.teamMemberId).toBe(joaoMember);
    expect(result.reactivated).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(joaoMember));
    expect(row?.removedAt).toBeUndefined();
    expect(row?.status).toBe("active");
    expect(row?.role).toBe("manager");
    expect(await as(joao).query(api.organizations.getUserOrganizations, {})).toHaveLength(1);
  });

  test("pendente legado sem conta é adotado, não duplicado", async () => {
    const { adminUser, orgA } = await setup();
    const pending = await addMember(orgA, undefined, "agent", "lia@acme.com.br");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await as(adminUser).action(api.nodeActions.inviteHumanMember, {
      organizationId: orgA,
      name: "Lia",
      email: "lia@acme.com.br",
      role: "agent",
    });
    expect(result.teamMemberId).toBe(pending);
    expect((await t.run((ctx) => ctx.db.get(pending)))?.userId).toBeDefined();
  });

  test("não convida acima do próprio cargo nem com permissão maior que a sua", async () => {
    const { orgA } = await setup();
    const gerente = await makeUser("gerente@acme.com.br");
    await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        organizationId: orgA,
        userId: gerente,
        name: "Gerente",
        email: "gerente@acme.com.br",
        role: "manager",
        type: "human",
        status: "active",
        permissions: {
          leads: "full", contacts: "full", inbox: "full", tasks: "full", reports: "view",
          team: "manage", settings: "view", auditLogs: "none", apiKeys: "none",
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await expect(
      as(gerente).action(api.nodeActions.inviteHumanMember, {
        organizationId: orgA,
        name: "X",
        email: "x@acme.com.br",
        role: "admin",
      })
    ).rejects.toThrow("cargo superior");
    await expect(
      as(gerente).action(api.nodeActions.inviteHumanMember, {
        organizationId: orgA,
        name: "X",
        email: "x@acme.com.br",
        role: "agent",
        permissions: {
          leads: "full", contacts: "full", inbox: "full", tasks: "full", reports: "full",
          team: "manage", settings: "manage", auditLogs: "view", apiKeys: "manage",
        },
      })
    ).rejects.toThrow("permissões acima");
    await expect(
      as(gerente).mutation(api.teamMembers.createTeamMember, {
        organizationId: orgA,
        name: "Robo",
        role: "admin",
        type: "ai",
      })
    ).rejects.toThrow("cargo superior");
    // Nada foi criado pela tentativa recusada.
    expect(await t.query(internal.authHelpers.queryUserByEmail, { email: "x@acme.com.br" })).toBeNull();
  });

  test("createTeamMember não cria mais pessoa pendente", async () => {
    const { adminUser, orgA } = await setup();
    await expect(
      as(adminUser).mutation(api.teamMembers.createTeamMember, {
        organizationId: orgA,
        name: "Fin",
        email: "financeiro@acme.com.br",
        role: "admin",
        type: "human",
      })
    ).rejects.toThrow("convite");
  });
});

describe("e-mail sem caixa", () => {
  test("resolvePasswordAccountEmail: minúsculo por padrão, legado exato preservado", async () => {
    await makeUser("Legado@Acme.com.br");
    expect(
      await t.query(internal.authHelpers.resolvePasswordAccountEmail, { email: "Legado@Acme.com.br" })
    ).toEqual({ email: "Legado@Acme.com.br", exists: true });
    expect(
      await t.query(internal.authHelpers.resolvePasswordAccountEmail, { email: " NOVO@acme.com.br" })
    ).toEqual({ email: "novo@acme.com.br", exists: false });
  });

  test("insertUserAndAuthAccount é idempotente por e-mail normalizado", async () => {
    const a = await t.mutation(internal.authHelpers.insertUserAndAuthAccount, {
      email: "Duda@Acme.com.br", name: "Duda", passwordHash: "h1",
    });
    const b = await t.mutation(internal.authHelpers.insertUserAndAuthAccount, {
      email: "duda@acme.com.br", name: "Duda", passwordHash: "h2",
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.userId).toBe(a.userId);
  });

  test("withCanonicalEmail troca o e-mail antes do authorize do pacote", async () => {
    const { withCanonicalEmail } = await import("./auth");
    const seen: unknown[] = [];
    const fake = { options: { authorize: async (params: Record<string, unknown>, _ctx?: unknown) => { seen.push(params.email); return null; } } };
    withCanonicalEmail(fake);
    const existing = new Set(["velho@x.com"]);
    const ctx = {
      runQuery: async (_fn: unknown, args: { email: string }) => {
        const email = args.email.trim().toLowerCase();
        return { email, exists: existing.has(email) };
      },
    };
    await fake.options.authorize({ email: " Eric@X.com ", flow: "signIn" }, ctx as never);
    expect(seen).toEqual(["eric@x.com"]);
    // Cadastro com variante de conta existente é recusado antes do pacote.
    await expect(
      fake.options.authorize({ email: "VELHO@x.com", flow: "signUp" }, ctx as never)
    ).rejects.toThrow("Já existe uma conta");
    expect(seen).toEqual(["eric@x.com"]);
    expect(() => withCanonicalEmail({})).toThrow("options.authorize");
  });
});

describe("organização", () => {
  test("updateOrganization faz merge de settings (não apaga optOutKeywords)", async () => {
    const { adminUser, orgA } = await setup();
    await t.run((ctx) =>
      ctx.db.patch(orgA, {
        settings: {
          timezone: "America/Sao_Paulo",
          currency: "BRL",
          optOutKeywords: ["SAIR", "PARE"],
        } as any,
      })
    );
    await as(adminUser).mutation(api.organizations.updateOrganization, {
      organizationId: orgA,
      settings: { timezone: "America/Recife", currency: "BRL" },
    });
    const org = await t.run((ctx) => ctx.db.get(orgA));
    expect(org?.settings.timezone).toBe("America/Recife");
    expect((org?.settings as any).optOutKeywords).toEqual(["SAIR", "PARE"]);
  });

  test("getOrganizationBySlug só resolve para membros", async () => {
    await setup();
    const stranger = await makeUser("s@x.com.br");
    expect(await as(stranger).query(api.organizations.getOrganizationBySlug, { slug: "acme" })).toBeNull();
  });
});

describe("assistente de onboarding", () => {
  test("admin de org nova vê; agente não vê; org concluída ninguém vê", async () => {
    const { adminUser, orgA } = await setup();
    const agente = await makeUser("agente@acme.com.br");
    await addMember(orgA, agente, "agent", "agente@acme.com.br");

    const adminView = await as(adminUser).query(api.onboarding.getOnboardingProgress, { organizationId: orgA });
    expect(adminView.shouldShowWizard).toBe(true);
    const agentView = await as(agente).query(api.onboarding.getOnboardingProgress, { organizationId: orgA });
    expect(agentView.shouldShowWizard).toBe(false);
    expect(agentView.wizardCompleted).toBe(true);

    // Registro do agente preso em andamento (bug antigo) não o prende mais.
    await as(agente).mutation(api.onboarding.initOnboardingProgress, { organizationId: orgA });
    expect(
      (await as(agente).query(api.onboarding.getOnboardingProgress, { organizationId: orgA })).shouldShowWizard
    ).toBe(false);

    await as(adminUser).mutation(api.onboarding.initOnboardingProgress, { organizationId: orgA });
    await as(adminUser).mutation(api.onboarding.completeWizard, { organizationId: orgA });
    const org = await t.run((ctx) => ctx.db.get(orgA));
    expect(org?.onboardingMeta?.wizardCompletedAt).toBeTypeOf("number");

    // Segundo admin: não vê o assistente nem consegue recriar o funil.
    const admin2 = await makeUser("admin2@acme.com.br");
    await addMember(orgA, admin2, "admin", "admin2@acme.com.br");
    expect(
      (await as(admin2).query(api.onboarding.getOnboardingProgress, { organizationId: orgA })).shouldShowWizard
    ).toBe(false);
    await expect(
      as(admin2).mutation(api.onboarding.setupPipelineFromWizard, {
        organizationId: orgA,
        boardName: "Outro",
        stages: [{ name: "Novo", color: "#fff" }],
      })
    ).rejects.toThrow("já foi concluído");
  });
});

describe("assistente de onboarding — DDI padrão (v0.67)", () => {
  test("completeWizard copia defaultCountryCode válido sem apagar o resto de settings", async () => {
    const { adminUser, orgA } = await setup();
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(orgA))!;
      await ctx.db.patch(orgA, { settings: { ...org.settings, optOutKeywords: ["SAIR"] } });
    });
    await as(adminUser).mutation(api.onboarding.initOnboardingProgress, { organizationId: orgA });
    await as(adminUser).mutation(api.onboarding.updateWizardStep, {
      organizationId: orgA, step: 2, wizardData: { timezone: "America/New_York", currency: "USD", defaultCountryCode: "1" },
    });
    await as(adminUser).mutation(api.onboarding.completeWizard, { organizationId: orgA });
    const org = await t.run((ctx) => ctx.db.get(orgA));
    expect(org?.settings).toMatchObject({
      timezone: "America/New_York", currency: "USD", defaultCountryCode: "1", optOutKeywords: ["SAIR"],
    });
  });

  test("código inválido é ignorado e o que a org tinha fica", async () => {
    const { adminUser, orgA } = await setup();
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(orgA))!;
      await ctx.db.patch(orgA, { settings: { ...org.settings, defaultCountryCode: "351" } });
    });
    await as(adminUser).mutation(api.onboarding.initOnboardingProgress, { organizationId: orgA });
    await as(adminUser).mutation(api.onboarding.updateWizardStep, {
      organizationId: orgA, step: 2, wizardData: { defaultCountryCode: "+44" },
    });
    await as(adminUser).mutation(api.onboarding.completeWizard, { organizationId: orgA });
    const org = await t.run((ctx) => ctx.db.get(orgA));
    expect(org?.settings.defaultCountryCode).toBe("351");
  });
});

describe("deep-link de outra org", () => {
  test("queries de detalhe devolvem null (não lançam) para quem não é membro", async () => {
    const { adminUser, orgA, adminA } = await setup();
    const outsider = await makeUser("fora@beta.com.br");
    const orgB = await makeOrg("Beta", "beta");
    await addMember(orgB, outsider, "admin", "fora@beta.com.br");

    const { taskId, contactId } = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", {
        organizationId: orgA, firstName: "Zé", tags: [], createdAt: now, updatedAt: now,
      } as any);
      const taskId = await ctx.db.insert("tasks", {
        organizationId: orgA, title: "Ligar", type: "task", status: "pending",
        priority: "medium", createdBy: adminA, createdAt: now, updatedAt: now,
      } as any);
      return { taskId, contactId };
    });

    expect(await as(outsider).query(api.tasks.getTask, { taskId })).toBeNull();
    expect(await as(outsider).query(api.contacts.getContactWithLeads, { contactId })).toBeNull();

    // Membro continua vendo, com organizationId para o front conferir a org.
    const task = await as(adminUser).query(api.tasks.getTask, { taskId });
    expect(task?.organizationId).toBe(orgA);
  });
});

describe("resolveEntityOrg", () => {
  test("devolve a org só para membro ativo; null para estranho, id inválido e deslogado", async () => {
    const { adminUser, orgA, adminA } = await setup();
    const outsider = await makeUser("fora2@beta.com.br");
    const taskId = await t.run((ctx) =>
      ctx.db.insert("tasks", {
        organizationId: orgA, title: "T", type: "task", status: "pending",
        priority: "low", createdBy: adminA, createdAt: Date.now(), updatedAt: Date.now(),
      } as any)
    );
    expect(await as(adminUser).query(api.organizations.resolveEntityOrg, { kind: "task", id: taskId }))
      .toEqual({ organizationId: orgA });
    expect(await as(outsider).query(api.organizations.resolveEntityOrg, { kind: "task", id: taskId })).toBeNull();
    expect(await as(adminUser).query(api.organizations.resolveEntityOrg, { kind: "lead", id: taskId })).toBeNull();
    expect(await as(adminUser).query(api.organizations.resolveEntityOrg, { kind: "task", id: "lixo" })).toBeNull();
    expect(await t.query(api.organizations.resolveEntityOrg, { kind: "task", id: taskId })).toBeNull();
  });
});

describe("atribuição a membro removido", () => {
  test("lead, tarefa e evento recusam removido; responsável antigo reenviado não quebra a edição", async () => {
    const { adminUser, orgA, adminA } = await setup();
    const joao = await makeUser("joao3@acme.com.br");
    const joaoMember = await addMember(orgA, joao, "agent", "joao3@acme.com.br");

    const { leadId, taskId } = await t.run(async (ctx) => {
      const now = Date.now();
      const boardId = await ctx.db.insert("boards", {
        organizationId: orgA, name: "Funil", color: "#000", isDefault: true, order: 0,
        createdAt: now, updatedAt: now,
      } as any);
      const stageId = await ctx.db.insert("stages", {
        organizationId: orgA, boardId, name: "Novo", color: "#000", order: 0,
        isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
      } as any);
      const leadId = await ctx.db.insert("leads", {
        organizationId: orgA, title: "L", boardId, stageId, value: 0, currency: "BRL",
        priority: "low", temperature: "cold", tags: [], customFields: {},
        conversationStatus: "new", lastActivityAt: now, createdAt: now, updatedAt: now,
      } as any);
      const taskId = await ctx.db.insert("tasks", {
        organizationId: orgA, title: "T", type: "task", status: "pending", priority: "low",
        createdBy: adminA, assignedTo: joaoMember, assigneeIds: [joaoMember],
        createdAt: now, updatedAt: now,
      } as any);
      return { leadId, taskId };
    });

    await as(adminUser).mutation(api.teamMembers.removeTeamMember, { teamMemberId: joaoMember });

    await expect(
      as(adminUser).mutation(api.leads.assignLead, { leadId, assignedTo: joaoMember })
    ).rejects.toThrow("removido");
    await expect(
      t.mutation(internal.leads.internalAssignLead, { leadId, assignedTo: joaoMember, teamMemberId: adminA })
    ).rejects.toThrow("removido");
    await expect(
      as(adminUser).mutation(api.leads.bulkAssignLeads, { organizationId: orgA, leadIds: [leadId], assignedTo: joaoMember })
    ).rejects.toThrow("removido");

    // Tarefa que JÁ era dele: reenviar a lista numa edição passa…
    await as(adminUser).mutation(api.tasks.setAssignees, { taskId, memberIds: [joaoMember, adminA] });
    // …mas atribuir como NOVO responsável, não.
    await as(adminUser).mutation(api.tasks.setAssignees, { taskId, memberIds: [adminA] });
    await expect(
      as(adminUser).mutation(api.tasks.setAssignees, { taskId, memberIds: [adminA, joaoMember] })
    ).rejects.toThrow("removido");
  });
});

describe("rodada 2 — e-mail legado, pendentes, edições", () => {
  test("conta antiga 'Eric@X.com' é achada em qualquer caixa; convite não cria 2ª conta", async () => {
    const { adminUser, orgA } = await setup();
    const legacy = await makeUser("Eric@Acme.com.br");

    for (const typed of ["eric@acme.com.br", "ERIC@ACME.COM.BR", "Eric@Acme.com.br"]) {
      expect(
        await t.query(internal.authHelpers.resolvePasswordAccountEmail, { email: typed })
      ).toEqual({ email: "Eric@Acme.com.br", exists: true });
    }
    expect(
      await t.query(internal.authHelpers.resolvePasswordAccountEmail, { email: "Novo@Acme.com.br" })
    ).toEqual({ email: "novo@acme.com.br", exists: false });

    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await as(adminUser).action(api.nodeActions.inviteHumanMember, {
      organizationId: orgA,
      name: "Eric",
      email: "eric@acme.com.br",
      role: "agent",
    });
    expect(result.existingUser).toBe(true);
    const member = await t.run((ctx) => ctx.db.get(result.teamMemberId));
    expect(member?.userId).toBe(legacy);
    const accounts = await t.run((ctx) => ctx.db.query("authAccounts").collect());
    expect(accounts.filter((a) => a.providerAccountId.toLowerCase() === "eric@acme.com.br")).toHaveLength(1);
  });

  test("com 2 variantes, a forma digitada exata vence", async () => {
    const upper = await makeUser("Duo@Acme.com.br");
    await makeUser("duo@acme.com.br");
    expect(
      (await t.query(internal.authHelpers.resolvePasswordAccountEmail, { email: "Duo@Acme.com.br" })).email
    ).toBe("Duo@Acme.com.br");
    expect((await t.query(internal.authHelpers.queryUserByEmail, { email: "Duo@Acme.com.br" }))?._id).toBe(upper);
  });

  test("backfill: dryRun por padrão, normaliza o que não colide e só reporta colisão", async () => {
    await makeUser("Solo@Acme.com.br");
    await makeUser("Dup@Acme.com.br");
    await makeUser("dup@acme.com.br");

    const dry = await t.mutation(internal.authHelpers.internalNormalizeLegacyEmails, { table: "authAccounts" });
    expect(dry.dryRun).toBe(true);
    expect(dry.changed).toBe(1);
    expect(dry.collisions.map((c) => c.email)).toEqual(["Dup@Acme.com.br"]);
    const untouched = await t.run((ctx) => ctx.db.query("authAccounts").collect());
    expect(untouched.some((a) => a.providerAccountId === "Solo@Acme.com.br")).toBe(true);

    await t.mutation(internal.authHelpers.internalNormalizeLegacyEmails, { table: "authAccounts", dryRun: false });
    await t.mutation(internal.authHelpers.internalNormalizeLegacyEmails, { table: "users", dryRun: false });
    const after = await t.run(async (ctx) => ({
      accounts: await ctx.db.query("authAccounts").collect(),
      users: await ctx.db.query("users").collect(),
    }));
    expect(after.accounts.map((a) => a.providerAccountId).sort()).toEqual(
      ["Dup@Acme.com.br", "dup@acme.com.br", "solo@acme.com.br"].sort()
    );
    expect(after.users.some((u) => u.email === "solo@acme.com.br")).toBe(true);
    expect(after.users.some((u) => u.email === "Dup@Acme.com.br")).toBe(true);
  });

  test("pendente sem conta: marcado na lista e NÃO conta como admin", async () => {
    const { adminUser, orgA, adminA } = await setup();
    const pending = await addMember(orgA, undefined, "admin", "velho@acme.com.br");
    const team = await as(adminUser).query(api.teamMembers.getTeamMembers, { organizationId: orgA });
    expect(team.find((m: any) => m._id === pending)).toMatchObject({ pending: true, removed: false });
    expect(team.find((m: any) => m._id === adminA)).toMatchObject({ pending: false });

    // O único admin com conta não pode ser rebaixado só porque existe o pendente.
    await expect(
      as(adminUser).mutation(api.teamMembers.updateTeamMember, { teamMemberId: adminA, role: "manager" })
    ).rejects.toThrow("último administrador");
  });

  test("reatribuir lead ao MESMO responsável removido é no-op, não erro", async () => {
    const { adminUser, orgA } = await setup();
    const ex = await makeUser("ex@acme.com.br");
    const exMember = await addMember(orgA, ex, "agent", "ex@acme.com.br");
    const leadId = await t.run(async (ctx) => {
      const now = Date.now();
      const boardId = await ctx.db.insert("boards", {
        organizationId: orgA, name: "F", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now,
      } as any);
      const stageId = await ctx.db.insert("stages", {
        organizationId: orgA, boardId, name: "N", color: "#000", order: 0,
        isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
      } as any);
      return await ctx.db.insert("leads", {
        organizationId: orgA, title: "L", boardId, stageId, assignedTo: exMember, value: 0, currency: "BRL",
        priority: "low", temperature: "cold", tags: [], customFields: {},
        conversationStatus: "new", lastActivityAt: now, createdAt: now, updatedAt: now,
      } as any);
    });
    await as(adminUser).mutation(api.teamMembers.removeTeamMember, { teamMemberId: exMember });
    await as(adminUser).mutation(api.leads.assignLead, { leadId, assignedTo: exMember });
  });

  test("editar membro cujas permissões superam as do editor: só o que MUDA é checado", async () => {
    const { orgA } = await setup();
    const gerente = await makeUser("g2@acme.com.br");
    const base = {
      leads: "full", contacts: "full", inbox: "full", tasks: "full", reports: "view",
      team: "manage", settings: "view", auditLogs: "none", apiKeys: "none",
    } as const;
    await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        organizationId: orgA, userId: gerente, name: "G", email: "g2@acme.com.br", role: "manager",
        type: "human", status: "active", permissions: base, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const alta = { ...base, settings: "manage", reports: "full" } as const;
    const alvo = await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        organizationId: orgA, name: "Alvo", role: "agent", type: "ai", status: "active",
        permissions: alta, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    // Reenvia o objeto inteiro (como o painel faz) só renomeando: passa.
    await as(gerente).mutation(api.teamMembers.updateTeamMember, { teamMemberId: alvo, name: "Alvo 2", permissions: alta });
    // Subir algo acima das próprias: recusa.
    await expect(
      as(gerente).mutation(api.teamMembers.updateTeamMember, {
        teamMemberId: alvo, permissions: { ...alta, auditLogs: "view" },
      })
    ).rejects.toThrow("permissões acima");
  });
});

describe("rodada 3 — senha temporária é da conta, nome e funil PT-BR", () => {
  test("conta com senha temporária convidada para 2ª org herda o flag; troca limpa todas", async () => {
    const { adminUser, orgA } = await setup();
    const orgB = await makeOrg("Beta", "beta");
    await addMember(orgB, adminUser, "admin", "admin@acme.com.br");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await as(adminUser).action(api.nodeActions.inviteHumanMember, {
      organizationId: orgA, name: "Eva", email: "eva@acme.com.br", role: "agent",
    });
    expect(first.pendingPasswordChange).toBe(true);
    const evaUser = (await t.run((ctx) => ctx.db.get(first.teamMemberId)))!.userId!;
    expect(await as(evaUser).query(api.teamMembers.getMustChangePassword, {})).toBe(true);

    const second = await as(adminUser).action(api.nodeActions.inviteHumanMember, {
      organizationId: orgB, name: "eva@acme.com.br", email: "eva@acme.com.br", role: "agent",
    });
    expect(second.existingUser).toBe(true);
    expect(second.pendingPasswordChange).toBe(true);
    const secondRow = await t.run((ctx) => ctx.db.get(second.teamMemberId));
    expect(secondRow?.mustChangePassword).toBe(true);
    // Nome vem da conta, não do e-mail que o assistente mandou.
    expect(secondRow?.name).toBe("Eva");

    // Trocar a senha (numa org só) libera a conta inteira.
    await t.mutation(internal.teamMembers.internalClearMustChangePasswordForUser, { userId: evaUser });
    expect(await as(evaUser).query(api.teamMembers.getMustChangePassword, {})).toBe(false);
    const rows = await t.run((ctx) =>
      ctx.db.query("teamMembers").withIndex("by_user", (q) => q.eq("userId", evaUser)).collect()
    );
    expect(rows.every((r) => !r.mustChangePassword)).toBe(true);

    // Conta sem pendência convidada: false.
    const maria = await makeUser("maria2@acme.com.br", "Maria");
    await addMember(orgA, maria, "agent", "maria2@acme.com.br");
    const third = await as(adminUser).action(api.nodeActions.inviteHumanMember, {
      organizationId: orgB, name: "M", email: "maria2@acme.com.br", role: "agent",
    });
    expect(third.pendingPasswordChange).toBe(false);
  });

  test("createOrganization nasce com funil, origens e padrões em PT-BR", async () => {
    const user = await makeUser("nova@acme.com.br");
    const orgId = await as(user).mutation(api.organizations.createOrganization, { name: "Nova", slug: "nova" });
    const { org, stages, board } = await t.run(async (ctx) => ({
      org: await ctx.db.get(orgId),
      board: await ctx.db.query("boards").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).first(),
      stages: await ctx.db.query("stages").collect(),
    }));
    expect(org?.settings.currency).toBe("BRL");
    expect(org?.settings.timezone).toBe("America/Sao_Paulo");
    expect(board?.name).toBe("Funil de Vendas");
    expect(stages.map((s) => s.name)).toContain("Novo lead");
  });
});
