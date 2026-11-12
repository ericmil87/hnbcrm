/// <reference types="vite/client" />
/**
 * Leads do HNBCRM na org interna: gancho de cadastro, resumo do onboarding e
 * formulário público de contato/consultoria (`hnbcrmLeads.ts`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { OnboardingDraft } from "./lib/onboardingDraft";
import { parseContactRequest } from "./lib/hnbcrmLeads";
import { ROUTE_PERMISSIONS, PUBLIC_API_ROUTES } from "./router";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
type T = TestConvex<typeof schema>;
let t: T;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 12, 12));
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

/** Org interna com funil de 2 etapas, admin humano e um webhook ativo (para provar que nada dispara). */
async function seedInternal(opts: { fields?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", {
      name: "HNBCRM interno",
      slug: "hnbcrm-interno",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "dono@interno.test" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId: orgId, userId, name: "Dono", email: "dono@interno.test", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId: orgId, name: "Vendas HNBCRM", color: "#111111", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const first = await ctx.db.insert("stages", {
      organizationId: orgId, boardId, name: "Cadastrou e não usou", color: "#111111", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId: orgId, boardId, name: "Cliente", color: "#111111", order: 1,
      isClosedWon: true, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("webhooks", {
      organizationId: orgId, name: "Hook", url: "https://example.test/hook", events: ["*"],
      secret: "segredo-de-teste", isActive: true, createdAt: now,
    });
    if (opts.fields) {
      await ctx.db.insert("fieldDefinitions", {
        organizationId: orgId, name: "Segmento", key: "segmento", type: "text", entityType: "lead",
        isRequired: false, order: 0, createdAt: now,
      });
    }
    return { orgId, boardId, first };
  });
}

async function mkOwner(email: string, orgName = "Padaria Teste") {
  const userId = await t.run((ctx) => ctx.db.insert("users", { email, name: "Maria Teste" }));
  const orgId = await as(userId).mutation(api.organizations.createOrganization, {
    name: orgName,
    slug: orgName.toLowerCase().replace(/\s+/g, "-"),
  });
  return { userId, orgId };
}

const drain = async () => {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
};

async function internalLeads(orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.query("leads").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).collect(),
  );
}

async function scheduledNames() {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name),
  );
}

describe("gancho de cadastro", () => {
  test("org nova cria lead na interna (primeiro estágio, origem Cadastro, auditoria) sem webhook nem boas-vindas", async () => {
    const internalOrg = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    await mkOwner("maria@cliente.test");
    await drain();

    const leads = await internalLeads(internalOrg.orgId);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ stageId: internalOrg.first, boardId: internalOrg.boardId, tags: ["cadastro"] });
    const source = await t.run((ctx) => ctx.db.get(leads[0].sourceId!));
    expect(source?.name).toBe("Cadastro");
    const contact = await t.run((ctx) => ctx.db.get(leads[0].contactId!));
    expect(contact).toMatchObject({ email: "maria@cliente.test", firstName: "Maria Teste" });
    expect(contact?.phone).toBeUndefined();

    const { activities, audits } = await t.run(async (ctx) => ({
      activities: await ctx.db.query("activities").withIndex("by_organization", (q) => q.eq("organizationId", internalOrg.orgId)).collect(),
      audits: await ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", internalOrg.orgId)).collect(),
    }));
    expect(activities.some((a) => a.type === "created")).toBe(true);
    expect(audits.some((a) => a.entityType === "lead" && a.action === "create")).toBe(true);

    const names = await scheduledNames();
    expect(names.filter((n) => /triggerWebhooks|inboundLeadWelcome|dispatchNotification|sendTransactional/.test(n))).toEqual([]);
  });

  test("sem env, env inválida ou org inexistente: não faz nada e não lança", async () => {
    const internalOrg = await seedInternal();
    await mkOwner("a@cliente.test", "Org A");
    await drain();
    expect(await internalLeads(internalOrg.orgId)).toHaveLength(0);

    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", "isso-nao-e-um-id");
    await mkOwner("b@cliente.test", "Org B");
    await drain();
    // Id bem formado de uma org apagada.
    const gone = await t.run(async (ctx) => {
      const id = await ctx.db.insert("organizations", {
        name: "x", slug: "x-gone", settings: { timezone: "UTC", currency: "BRL" }, createdAt: 1, updatedAt: 1,
      });
      await ctx.db.delete(id);
      return id;
    });
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", gone);
    await mkOwner("c@cliente.test", "Org C");
    await drain();
    expect(await internalLeads(internalOrg.orgId)).toHaveLength(0);
  });

  test("idempotente: reexecutar não duplica; nunca roda para a própria org interna", async () => {
    const internalOrg = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    const { orgId } = await mkOwner("maria@cliente.test");
    await drain();
    const again = await t.mutation(internal.hnbcrmLeads.internalCaptureSignupLead, { organizationId: orgId });
    expect(again.status).toBe("exists");
    expect(await internalLeads(internalOrg.orgId)).toHaveLength(1);

    const self = await t.mutation(internal.hnbcrmLeads.internalCaptureSignupLead, { organizationId: internalOrg.orgId });
    expect(self.status).toBe("internal_org");
    expect(await internalLeads(internalOrg.orgId)).toHaveLength(1);
  });

  test("funil por env: usa HNBCRM_INTERNAL_BOARD_ID da org interna; board de outra org é ignorado", async () => {
    const internalOrg = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    vi.stubEnv("HNBCRM_INTERNAL_BOARD_ID", internalOrg.boardId);
    await mkOwner("maria@cliente.test");
    await drain();
    expect((await internalLeads(internalOrg.orgId))[0].boardId).toBe(internalOrg.boardId);
  });
});

function draft(): OnboardingDraft {
  return {
    version: 1,
    business: { name: "Padaria Teste", segment: "saude", description: "Padaria de bairro.", suspicious: false },
    funnel: {
      name: "Funil Padaria",
      stages: [
        { name: "Novo contato", order: 0 },
        { name: "Fechado", order: 1, outcome: "won" },
        { name: "Perdido", order: 2, outcome: "lost" },
      ],
    },
    customFields: [],
    persona: { attendantName: "Bia", tone: "amigavel", addressAs: "voce", languages: ["pt-BR"], presentsAsAi: true },
    knowledge: [],
    quickReplies: [],
    handoffRules: [],
    features: { vision: false, transcription: false, dateTime: false, translation: false, voice: false },
    planInterest: "profissional",
  };
}

async function applyFor(userId: Id<"users">, orgId: Id<"organizations">) {
  const session = await as(userId).mutation(api.onboardingSessions.getOrCreateSession, { organizationId: orgId });
  await as(userId).mutation(api.onboardingSessions.saveDraft, {
    organizationId: orgId, sessionId: session._id, draft: draft(), expectedVersion: session.draftVersion,
  });
  const view = await as(userId).query(api.onboardingSessions.getSession, { organizationId: orgId });
  return await as(userId).mutation(api.onboardingSessions.applyOnboardingDraft, {
    organizationId: orgId, sessionId: session._id, expectedDraftHash: view!.draftHash!,
  });
}

describe("resumo do onboarding", () => {
  test("aplicar o rascunho grava segmento/plano nos campos existentes e o restante em nota", async () => {
    const internalOrg = await seedInternal({ fields: true });
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    const { userId, orgId } = await mkOwner("maria@cliente.test");
    await drain();
    await applyFor(userId, orgId);
    await drain();

    const [lead] = await internalLeads(internalOrg.orgId);
    expect(lead.customFields.segmento).toBe("saude");
    expect(lead.customFields.plano_interesse).toBeUndefined();
    const notes = await t.run((ctx) =>
      ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", lead._id)).collect(),
    );
    const note = notes.find((a) => a.type === "note");
    expect(note?.content).toContain("Plano de interesse: profissional");
    // Nenhum campo criado automaticamente na org interna.
    const defs = await t.run((ctx) =>
      ctx.db.query("fieldDefinitions").withIndex("by_organization", (q) => q.eq("organizationId", internalOrg.orgId)).collect(),
    );
    expect(defs).toHaveLength(1);
  });

  test("sem env nada muda; reaplicar o mesmo resumo é no-op", async () => {
    const internalOrg = await seedInternal();
    const { userId, orgId } = await mkOwner("maria@cliente.test");
    await drain();
    await applyFor(userId, orgId);
    await drain();
    expect(await internalLeads(internalOrg.orgId)).toHaveLength(0);

    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    await t.mutation(internal.hnbcrmLeads.internalCaptureSignupLead, { organizationId: orgId });
    const session = await t.run((ctx) =>
      ctx.db.query("onboardingSessions").first(),
    );
    const first = await t.mutation(internal.hnbcrmLeads.internalApplySignupSummary, { organizationId: orgId, sessionId: session!._id });
    const second = await t.mutation(internal.hnbcrmLeads.internalApplySignupSummary, { organizationId: orgId, sessionId: session!._id });
    expect(first.status).toBe("updated");
    expect(second.status).toBe("unchanged");
  });
});

const VALID = {
  name: "João Teste",
  email: "joao@cliente.test",
  need: "Quero organizar o atendimento da equipe.",
  kind: "consultoria",
  business: "Loja Teste",
  teamSize: "5",
};

describe("contato/consultoria", () => {
  test("cria lead com a etiqueta do tipo e o texto como nota; sem env responde unavailable", async () => {
    const internalOrg = await seedInternal();
    const unavailable = await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, VALID);
    expect(unavailable).toMatchObject({ ok: false, code: "unavailable" });

    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    const ok = await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, { ...VALID, phone: "(11) 99999-0000" });
    expect(ok).toEqual({ ok: true });
    const [lead] = await internalLeads(internalOrg.orgId);
    expect(lead.tags).toEqual(["consultoria"]);
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", lead._id)).collect());
    expect(acts.find((a) => a.type === "note")?.content).toContain("Quero organizar o atendimento");
    const names = await scheduledNames();
    expect(names.filter((n) => /triggerWebhooks|inboundLeadWelcome/.test(n))).toEqual([]);

    // Mesmo pedido de novo: nota no lead aberto, sem lead novo.
    await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, VALID);
    expect(await internalLeads(internalOrg.orgId)).toHaveLength(1);
  });

  test("validação: tipo, e-mail, telefone e necessidade", async () => {
    const internalOrg = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    for (const bad of [
      { ...VALID, kind: "outro" },
      { ...VALID, email: "sem-arroba" },
      { ...VALID, phone: "abc" },
      { ...VALID, need: "" },
      { ...VALID, name: "" },
    ]) {
      const r = await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, bad);
      expect(r).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(await internalLeads(internalOrg.orgId)).toHaveLength(0);
    const long = parseContactRequest({ ...VALID, need: "a".repeat(5000), name: "n".repeat(500) });
    expect(long.ok && long.value.need.length).toBe(1000);
    expect(long.ok && long.value.name.length).toBe(80);
  });

  test("rate limit por e-mail e por IP", async () => {
    const internalOrg = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    for (let i = 0; i < 3; i++) {
      expect(await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, VALID)).toEqual({ ok: true });
    }
    expect(await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, VALID)).toMatchObject({ ok: false, code: "rate_limited" });

    for (let i = 0; i < 5; i++) {
      const r = await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, {
        ...VALID, email: `pessoa${i}@cliente.test`, ipKey: "203.0.113.9",
      });
      expect(r).toEqual({ ok: true });
    }
    expect(
      await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, { ...VALID, email: "outra@cliente.test", ipKey: "203.0.113.9" }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });

  test("rota HTTP: honeypot não cria nada, sem env 503 unavailable, com env 200", async () => {
    const internalOrg = await seedInternal();
    const post = (body: unknown) =>
      t.fetch("/api/v1/public/contact", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

    const none = await post(VALID);
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ ok: false, code: "unavailable" });

    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    const trap = await post({ ...VALID, _honeypot: "http://spam" });
    expect(trap.status).toBe(200);
    expect(await internalLeads(internalOrg.orgId)).toHaveLength(0);

    const ok = await post(VALID);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(await internalLeads(internalOrg.orgId)).toHaveLength(1);

    const bad = await t.fetch("/api/v1/public/contact", { method: "POST", body: "não é json" });
    expect(bad.status).toBe(400);
    const huge = await post({ ...VALID, need: "x".repeat(20_000) });
    expect(huge.status).toBe(413);
  });

  test("a rota é pública declarada (não usa API key)", () => {
    expect(PUBLIC_API_ROUTES).toContain("POST /api/v1/public/contact");
    expect(ROUTE_PERMISSIONS["POST /api/v1/public/contact"]).toBeUndefined();
  });
});
