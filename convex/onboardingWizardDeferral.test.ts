/// <reference types="vite/client" />
/**
 * Quem montou a operação pela conversa de configuração (`/comecar`) não cai no
 * assistente de formulário em tela cheia: a aplicação do rascunho grava o
 * adiamento (`lib/wizardDeferral.ts`, mesmo campo do "Continuar depois") e,
 * para quem aplicou antes desta correção, `computeShouldShowWizard` deriva da
 * sessão aplicada na leitura.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { OnboardingDraft } from "./lib/onboardingDraft";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type T = TestConvex<typeof schema>;
const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

function draft(): OnboardingDraft {
  return {
    version: 1,
    business: {
      name: "Clínica Bom Jesus Teste",
      segment: "saude",
      description: "Clínica que atende pacientes pelo WhatsApp.",
      suspicious: false,
    },
    funnel: {
      name: "Funil Clínica",
      stages: [
        { name: "Novo contato", order: 0 },
        { name: "Avaliação marcada", order: 1 },
        { name: "Tratamento fechado", order: 2, outcome: "won" },
        { name: "Perdido", order: 3, outcome: "lost" },
      ],
    },
    customFields: [],
    persona: { attendantName: "Anis", tone: "amigavel", addressAs: "voce", languages: ["pt-BR"], presentsAsAi: true },
    knowledge: [{ text: "Apenas aplicação de botox.", origin: { kind: "usuario" }, suspicious: false }],
    quickReplies: [],
    handoffRules: [],
    features: { vision: false, transcription: false, dateTime: false, translation: false, voice: false },
  };
}

type Meta = { wizardCompletedAt?: number; wizardVersion?: number };

async function seed(t: T, opts: { aiActive?: boolean; meta?: Meta } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", {
      name: "Clínica",
      slug: "clinica-wizard",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 },
      },
      ...(opts.meta ? { onboardingMeta: opts.meta } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("boards", {
      organizationId: orgId, name: "Funil de Vendas", color: "#3B82F6", isDefault: true,
      order: 0, createdAt: now, updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "admin-wizard@teste.com" });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId: orgId, userId, name: "Admin", role: "admin", type: "human", status: "active",
      createdAt: now, updatedAt: now,
    });
    if (opts.aiActive) {
      const org = (await ctx.db.get(orgId))!;
      await ctx.db.patch(orgId, {
        settings: {
          ...org.settings,
          aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, lgpdAck: { acceptedAt: now, acceptedBy: memberId } },
        },
      });
    }
    return { orgId, userId, memberId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function applyThroughConversation(t: T, s: Seed) {
  const session = await as(t, s.userId).mutation(api.onboardingSessions.getOrCreateSession, { organizationId: s.orgId });
  await as(t, s.userId).mutation(api.onboardingSessions.saveDraft, {
    organizationId: s.orgId,
    sessionId: session._id,
    draft: draft(),
    expectedVersion: session.draftVersion,
  });
  const view = await as(t, s.userId).query(api.onboardingSessions.getSession, { organizationId: s.orgId });
  return await as(t, s.userId).mutation(api.onboardingSessions.applyOnboardingDraft, {
    organizationId: s.orgId,
    sessionId: session._id,
    expectedDraftHash: view!.draftHash!,
  });
}

const progress = (t: T, s: Seed) =>
  as(t, s.userId).query(api.onboarding.getOnboardingProgress, { organizationId: s.orgId });
const orgMeta = (t: T, s: Seed) => t.run(async (ctx) => (await ctx.db.get(s.orgId))!.onboardingMeta);

describe("assistente de formulário depois da conversa de configuração", () => {
  test("org nova sem conversa: comportamento atual (assistente aparece)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    expect((await progress(t, s)).shouldShowWizard).toBe(true);
  });

  test("rascunho aplicado: assistente não abre sozinho, adiamento gravado e passos da conversa feitos no checklist", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true });
    expect((await progress(t, s)).shouldShowWizard).toBe(true);
    const res = await applyThroughConversation(t, s);
    expect(res.attendant).toBe("created");

    expect((await progress(t, s)).shouldShowWizard).toBe(false);
    const meta = await orgMeta(t, s);
    expect(meta?.wizardDeferredAt).toBeTypeOf("number");
    expect(meta?.wizardCompletedAt).toBeUndefined();
    const status = await as(t, s.userId).query(api.onboarding.getOnboardingStatus, { organizationId: s.orgId });
    expect(status).toMatchObject({ shouldShowWizard: false, wizardDeferred: true });
    expect(status.steps).toMatchObject({ business: "done", funnel: "done", attendant: "done", whatsapp: "pending", team: "pending" });

    const checklist = await as(t, s.userId).query(api.onboarding.getOnboardingChecklist, { organizationId: s.orgId });
    const byId = Object.fromEntries(checklist.items.map((i: { id: string; completed: boolean }) => [i.id, i.completed]));
    expect(byId).toMatchObject({ business: true, pipelineCustomized: true, attendant: true, whatsapp: false, teamMemberInvited: false });
  });

  test("aplicado antes da correção (sessão aplicada, sem adiamento gravado): derivado na leitura, sem migração", async () => {
    for (const field of ["appliedAt", "priorAppliedAt"] as const) {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      await t.run(async (ctx) => {
        const now = Date.now();
        await ctx.db.insert("onboardingSessions", {
          organizationId: s.orgId, createdBy: s.memberId, stage: "applied", draftVersion: 1,
          messageCount: 0, spentUsdMicros: 0, [field]: now, createdAt: now, updatedAt: now,
        });
      });
      expect((await progress(t, s)).shouldShowWizard).toBe(false);
      expect((await orgMeta(t, s))?.wizardDeferredAt).toBeUndefined();
      // Registro do membro criado depois também nasce concluído.
      await as(t, s.userId).mutation(api.onboarding.initOnboardingProgress, { organizationId: s.orgId });
      expect((await progress(t, s)).shouldShowWizard).toBe(false);
    }
  });

  test("sessão aberta mas ainda não aplicada: o assistente continua aparecendo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await as(t, s.userId).mutation(api.onboardingSessions.getOrCreateSession, { organizationId: s.orgId });
    expect((await progress(t, s)).shouldShowWizard).toBe(true);
  });

  test("org legada (concluiu o assistente): aplicar não muda o onboardingMeta de conclusão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true, meta: { wizardCompletedAt: 1 } });
    expect((await progress(t, s)).shouldShowWizard).toBe(false);
    await applyThroughConversation(t, s);
    const meta = await orgMeta(t, s);
    expect(meta?.wizardCompletedAt).toBe(1);
    expect(meta?.wizardDeferredAt).toBeUndefined();
    expect((await progress(t, s)).shouldShowWizard).toBe(false);
  });
});
