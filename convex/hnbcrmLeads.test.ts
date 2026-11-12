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
import { parseContactRequest, parseNewsletterSignup } from "./lib/hnbcrmLeads";
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

  test("lead de outra org do mesmo titular: só nota com o nome da org, campos intactos", async () => {
    const internalOrg = await seedInternal({ fields: true });
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    const first = await mkOwner("maria@cliente.test", "Org Um");
    await drain();
    const second = await as(first.userId).mutation(api.organizations.createOrganization, { name: "Org Dois", slug: "org-dois" });
    await drain();
    await applyFor(first.userId, second);
    await drain();
    const leads = await internalLeads(internalOrg.orgId);
    expect(leads).toHaveLength(1);
    expect(leads[0].customFields.segmento).toBeUndefined();
    expect(leads[0].customFields.hnbcrmSignupOrgId).toBe(String(first.orgId));
    const notes = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", leads[0]._id)).collect());
    expect(notes.find((a) => a.type === "note")?.content).toContain("Org Dois");
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

  test("contato existente não é alterado: telefone informado vai só na nota; e-mail novo com telefone de existente cria contato novo", async () => {
    const internalOrg = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    const existingId = await t.run((ctx) =>
      ctx.db.insert("contacts", {
        organizationId: internalOrg.orgId, firstName: "Antigo", email: "joao@cliente.test", tags: [], createdAt: 1, updatedAt: 1,
      }),
    );
    const withPhone = await t.run((ctx) =>
      ctx.db.insert("contacts", {
        organizationId: internalOrg.orgId, firstName: "Dona do número", email: "dona@cliente.test",
        phone: "5511999990000", whatsappNumber: "5511999990000", tags: [], createdAt: 1, updatedAt: 1,
      }),
    );
    expect(await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, { ...VALID, phone: "(21) 98888-7777" })).toEqual({ ok: true });
    const kept = await t.run((ctx) => ctx.db.get(existingId));
    expect(kept?.phone).toBeUndefined();
    expect(kept?.whatsappNumber).toBeUndefined();
    expect(kept?.firstName).toBe("Antigo");
    const [lead] = await internalLeads(internalOrg.orgId);
    expect(lead.contactId).toBe(existingId);
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", lead._id)).collect());
    expect(acts.find((a) => a.type === "note")?.content).toContain("Telefone informado: (21) 98888-7777");

    // E-mail novo com o telefone de um contato existente: contato NOVO, o antigo fica intacto.
    expect(
      await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, { ...VALID, email: "novo@cliente.test", phone: "(11) 99999-0000" }),
    ).toEqual({ ok: true });
    const contacts = await t.run((ctx) =>
      ctx.db.query("contacts").withIndex("by_organization", (q) => q.eq("organizationId", internalOrg.orgId)).collect(),
    );
    expect(contacts).toHaveLength(3);
    const created = contacts.find((c) => c.email === "novo@cliente.test");
    expect(created?._id).not.toBe(withPhone);
    // Número já é de outro contato da org: não vai para o novo, fica só na nota.
    expect(created?.phone).toBeUndefined();
    expect(created?.whatsappNumber).toBeUndefined();
    const newLead = (await internalLeads(internalOrg.orgId)).find((l) => l.contactId === created?._id)!;
    const newActs = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", newLead._id)).collect());
    expect(newActs.find((a) => a.type === "note")?.content).toContain("Telefone informado: (11) 99999-0000");
    const contactAudit = await t.run((ctx) =>
      ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "contact").eq("entityId", created!._id)).first(),
    );
    expect(contactAudit?.actorType).toBe("system");

    // Telefone livre: contato novo guarda o número normalizado.
    expect(
      await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, { ...VALID, email: "livre@cliente.test", phone: "(31) 97777-1111" }),
    ).toEqual({ ok: true });
    const free = await t.run((ctx) =>
      ctx.db.query("contacts").withIndex("by_organization_and_email", (q) => q.eq("organizationId", internalOrg.orgId).eq("email", "livre@cliente.test")).first(),
    );
    expect(free?.phone).toBe("5531977771111");
    expect((await t.run((ctx) => ctx.db.get(withPhone)))?.firstName).toBe("Dona do número");
  });

  test("origem do formulário, auditoria medium, chave de e-mail em hash e balde sem IP", async () => {
    const internalOrg = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, VALID);
    const [lead] = await internalLeads(internalOrg.orgId);
    expect((await t.run((ctx) => ctx.db.get(lead.sourceId!)))?.name).toBe("Site – contato");
    const audits = await t.run((ctx) =>
      ctx.db.query("auditLogs").withIndex("by_entity", (q) => q.eq("entityType", "lead").eq("entityId", lead._id)).collect(),
    );
    expect(audits[0].severity).toBe("medium");
    const keys = (await t.run((ctx) => ctx.db.query("onboardingRateLimits").collect())).map((r) => r.key);
    expect(keys.some((k) => k.includes("joao@cliente.test"))).toBe(false);
    expect(keys).toContain("contact:ip:unknown");
    expect(keys.some((k) => /^contact:email:[0-9a-f]{32}$/.test(k))).toBe(true);

    // Sem IP o balde é compartilhado e baixo (10/h), mesmo com e-mails diferentes.
    for (let i = 0; i < 9; i++) {
      expect(await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, { ...VALID, email: `p${i}@cliente.test` })).toEqual({ ok: true });
    }
    expect(
      await t.mutation(internal.hnbcrmLeads.internalSubmitContactRequest, { ...VALID, email: "ultimo@cliente.test" }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });

  test("Content-Length acima do teto é recusado (413)", async () => {
    const internalOrg = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", internalOrg.orgId);
    const res = await t.fetch("/api/v1/public/contact", {
      method: "POST",
      body: JSON.stringify(VALID),
      headers: { "Content-Type": "application/json", "Content-Length": "50000" },
    });
    expect(res.status).toBe(413);
  });

  test("a rota é pública declarada (não usa API key)", () => {
    expect(PUBLIC_API_ROUTES).toContain("POST /api/v1/public/contact");
    expect(ROUTE_PERMISSIONS["POST /api/v1/public/contact"]).toBeUndefined();
  });
});

describe("newsletter", () => {
  const sub = (a: { email: string; name?: string; source?: string; ipKey?: string }) =>
    t.mutation(internal.hnbcrmLeads.internalSubscribeNewsletter, a);

  test("parser puro: e-mail obrigatório, nome saneado e limitado", () => {
    expect(parseNewsletterSignup({ email: "x" }).ok).toBe(false);
    expect(parseNewsletterSignup({}).ok).toBe(false);
    const r = parseNewsletterSignup({ email: "  Ana@Site.TEST ", name: "  Ana​   Maria " + "x".repeat(200) });
    expect(r.ok && r.value.email).toBe("ana@site.test");
    expect(r.ok && r.value.name.length).toBe(80);
    expect(r.ok && r.value.name.startsWith("Ana Maria")).toBe(true);
  });

  test("cria contato + lead com a etiqueta, origem e nota; segunda inscrição não duplica", async () => {
    const org = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", org.orgId);
    expect(await sub({ email: "Leitora@Site.test", name: "Leitora", source: "rodape" })).toEqual({ ok: true });
    const [lead] = await internalLeads(org.orgId);
    expect(lead.tags).toEqual(["newsletter"]);
    expect(lead.title).toBe("Newsletter: Leitora");
    expect((await t.run((ctx) => ctx.db.get(lead.sourceId!)))?.name).toBe("Site – newsletter");
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead", (q) => q.eq("leadId", lead._id)).collect());
    const note = acts.find((a) => a.type === "note")?.content;
    expect(note).toContain("(rodape)");
    expect(note).toContain("Consentimento registrado em 2026-11-12");
    expect(await sub({ email: "leitora@site.test" })).toEqual({ ok: true });
    expect(await internalLeads(org.orgId)).toHaveLength(1);
  });

  test("sem nome usa a parte local; contato existente não é alterado", async () => {
    const org = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", org.orgId);
    const existing = await t.run((ctx) =>
      ctx.db.insert("contacts", { organizationId: org.orgId, firstName: "Antigo", email: "velho@site.test", tags: [], createdAt: 1, updatedAt: 1 }),
    );
    await sub({ email: "velho@site.test", name: "Outro Nome" });
    await sub({ email: "semnome@site.test" });
    expect((await t.run((ctx) => ctx.db.get(existing)))?.firstName).toBe("Antigo");
    const titles = (await internalLeads(org.orgId)).map((l) => l.title).sort();
    expect(titles).toEqual(["Newsletter: Outro Nome", "Newsletter: semnome"]);
  });

  test("e-mail inválido = invalid; sem env = unavailable", async () => {
    expect(await sub({ email: "nao-e-email" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await sub({ email: "ok@site.test" })).toMatchObject({ ok: false, code: "unavailable" });
  });

  test("rate limit por e-mail (3/h) e chaves próprias", async () => {
    const org = await seedInternal();
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", org.orgId);
    for (let i = 0; i < 3; i++) expect(await sub({ email: "a@site.test", ipKey: `203.0.113.${i + 1}` })).toEqual({ ok: true });
    expect(await sub({ email: "a@site.test", ipKey: "203.0.113.50" })).toMatchObject({ ok: false, code: "rate_limited" });
    const keys = (await t.run((ctx) => ctx.db.query("onboardingRateLimits").collect())).map((r) => r.key);
    expect(keys).toContain("newsletter:global");
    expect(keys.some((k) => k.startsWith("contact:"))).toBe(false);
    expect(keys.some((k) => k.includes("a@site.test"))).toBe(false);
  });

  test("rota HTTP: honeypot não grava, sem env 503, com env 200, JSON inválido 400", async () => {
    const org = await seedInternal();
    const post = (body: unknown) =>
      t.fetch("/api/v1/public/newsletter", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    expect((await post({ email: "h@site.test" })).status).toBe(503);
    vi.stubEnv("HNBCRM_INTERNAL_ORG_ID", org.orgId);
    const trap = await post({ email: "h@site.test", _honeypot: "spam" });
    expect(trap.status).toBe(200);
    expect(await internalLeads(org.orgId)).toHaveLength(0);
    const ok = await post({ email: "h@site.test", name: "H" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(await internalLeads(org.orgId)).toHaveLength(1);
    expect((await post({ email: "ruim" })).status).toBe(400);
    expect((await t.fetch("/api/v1/public/newsletter", { method: "POST", body: "x{" })).status).toBe(400);
  });

  test("rota listada como pública", () => {
    expect(PUBLIC_API_ROUTES).toContain("POST /api/v1/public/newsletter");
    expect(ROUTE_PERMISSIONS["POST /api/v1/public/newsletter"]).toBeUndefined();
  });
});
