/// <reference types="vite/client" />
/**
 * "Recomeçar a conversa" do `/comecar` (`onboardingSessions.restartConversation`)
 * e o resumo de entrada de quem já tem empresa (`getEntryOverview`). Prova:
 * escopo por org, não administrador recusado, idempotência, limites de custo
 * que NÃO zeram, nada do CRM apagado, arquivos da conversa limpos pela porta,
 * sessão arquivada recusada nas portas, reaplicação sem funil duplicado.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { OnboardingDraft } from "./lib/onboardingDraft";
import { evaluateRestartRate, entryConversationState, newOrgTrialFor, RESTART_LIMITS } from "./lib/onboardingRestart";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type T = TestConvex<typeof schema>;
const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

function draft(): OnboardingDraft {
  return {
    version: 1,
    business: { name: "Clínica Teste", segment: "saude", description: "Clínica de bairro.", city: "Campinas", suspicious: false },
    funnel: {
      name: "Funil Clínica",
      stages: [
        { name: "Novo contato", order: 0 },
        { name: "Avaliação marcada", order: 1 },
        { name: "Tratamento fechado", order: 2, outcome: "won" },
        { name: "Perdido", order: 3, outcome: "lost" },
      ],
    },
    customFields: [{ name: "Convênio", type: "text" }],
    persona: { attendantName: "Bia", tone: "amigavel", addressAs: "voce", languages: ["pt-BR"], presentsAsAi: true },
    greeting: { text: "Olá! Aqui é a Bia da clínica.", suspicious: false },
    knowledge: [{ text: "Avaliação gratuita às terças.", origin: { kind: "usuario" }, suspicious: false }],
    quickReplies: [{ shortcut: "endereco", text: "Rua das Flores, 100.", suspicious: false }],
    handoffRules: [{ kind: "pagamento", suspicious: false }],
    features: { vision: false, transcription: false, dateTime: false, translation: false, voice: false },
  };
}

async function seed(t: T, opts: { aiActive?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = async (slug: string) => {
      const orgId = await ctx.db.insert("organizations", {
        name: `Org ${slug}`,
        slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL", aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 } },
        createdAt: now,
        updatedAt: now,
      });
      const boardId = await ctx.db.insert("boards", {
        organizationId: orgId, name: "Funil de Vendas", color: "#3B82F6", isDefault: true, order: 0, createdAt: now, updatedAt: now,
      });
      for (const [i, name] of ["Novo lead", "Qualificado", "Proposta"].entries()) {
        await ctx.db.insert("stages", {
          organizationId: orgId, boardId, name, color: "#111111", order: i, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
        });
      }
      return { orgId, boardId };
    };
    const a = await mkOrg("org-a");
    const b = await mkOrg("org-b");
    const member = async (orgId: Id<"organizations">, email: string, role: "admin" | "manager" | "agent", userId?: Id<"users">) => {
      const uid = userId ?? (await ctx.db.insert("users", { email, emailVerificationTime: now }));
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId: orgId, userId: uid, name: email, role, type: "human", status: "active", createdAt: now, updatedAt: now,
      });
      return { userId: uid, memberId };
    };
    const adminA = await member(a.orgId, "admin-a@teste.com", "admin");
    const managerA = await member(a.orgId, "gerente-a@teste.com", "manager");
    const adminB = await member(b.orgId, "admin-b@teste.com", "admin");
    if (opts.aiActive) {
      const org = (await ctx.db.get(a.orgId))!;
      await ctx.db.patch(a.orgId, {
        settings: {
          ...org.settings,
          aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, lgpdAck: { acceptedAt: now, acceptedBy: adminA.memberId } },
        },
      });
    }
    return { a, b, adminA, managerA, adminB };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

/** Sessão da org A com rascunho, duas mensagens, gasto, ciência do aviso e progresso do roteiro. */
async function sessionWithProgress(t: T, s: Seed) {
  const session = await as(t, s.adminA.userId).mutation(api.onboardingSessions.getOrCreateSession, { organizationId: s.a.orgId });
  await as(t, s.adminA.userId).mutation(api.onboardingSessions.saveDraft, {
    organizationId: s.a.orgId, sessionId: session._id, draft: draft(), expectedVersion: session.draftVersion,
  });
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(session._id, {
      messageCount: 2,
      spentUsdMicros: 420_000,
      materialsNoticeAckAt: now,
      materialsNoticeAckBy: s.adminA.memberId,
      emailCodeAutoSentAt: now,
      reachedStep: 3,
      approvals: { funnel: "sig-f" },
      shownCards: { funilPreview: "sig-f" },
      testedAt: now,
      pendingMaterials: [{ kind: "url", url: "https://exemplo.com.br", label: "exemplo.com.br", createdAt: now }],
      summary: "Clínica de bairro",
    });
    await ctx.db.insert("onboardingMessages", { organizationId: s.a.orgId, sessionId: session._id, role: "user", text: "tenho uma clínica", createdAt: now });
    await ctx.db.insert("onboardingMessages", { organizationId: s.a.orgId, sessionId: session._id, role: "assistant", text: "Que legal!", createdAt: now + 1 });
  });
  return session._id;
}

const restart = (t: T, userId: Id<"users">, organizationId: Id<"organizations">, sessionId: Id<"onboardingSessions">) =>
  as(t, userId).mutation(api.onboardingSessions.restartConversation, { organizationId, sessionId });

async function sessionsOf(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("onboardingSessions").withIndex("by_organization", (q) => q.eq("organizationId", orgId)).collect());
}

describe("restartConversation", () => {
  test("arquiva a sessão, abre outra limpa e herda só o que não pode zerar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const oldId = await sessionWithProgress(t, s);

    const r = await restart(t, s.adminA.userId, s.a.orgId, oldId);
    expect(r.restarted).toBe(true);
    expect(r.sessionId).not.toBe(oldId);

    const [old, fresh] = await t.run(async (ctx) => [await ctx.db.get(oldId), await ctx.db.get(r.sessionId)]);
    expect(old!.archivedAt).toBeDefined();
    expect(old!.archivedBy).toBe(s.adminA.memberId);
    // A nova: sem conversa, rascunho, aprovações, progresso, links nem resumo.
    expect(fresh!.archivedAt).toBeUndefined();
    expect(fresh!.draft).toBeUndefined();
    expect(fresh!.draftVersion).toBe(0);
    expect(fresh!.messageCount).toBe(0);
    expect(fresh!.approvals).toBeUndefined();
    expect(fresh!.shownCards).toBeUndefined();
    expect(fresh!.reachedStep).toBeUndefined();
    expect(fresh!.testedAt).toBeUndefined();
    expect(fresh!.pendingMaterials).toBeUndefined();
    expect(fresh!.summary).toBeUndefined();
    expect(fresh!.stage).toBe("interview");
    // Herda: gasto (orçamento não zera), ciência do aviso, envio do código, origem.
    expect(fresh!.spentUsdMicros).toBe(420_000);
    expect(fresh!.materialsNoticeAckAt).toBe(old!.materialsNoticeAckAt);
    expect(fresh!.emailCodeAutoSentAt).toBe(old!.emailCodeAutoSentAt);
    expect(fresh!.restartedFrom).toBe(oldId);

    // A conversa visível é a nova (vazia); o histórico antigo continua na sessão arquivada.
    const state = await as(t, s.adminA.userId).query(api.onboardingChat.getChatState, { organizationId: s.a.orgId });
    expect(state!.sessionId).toBe(r.sessionId);
    expect(state!.reachedStep).toBe(0);
    expect(state!.materialsNoticeAcknowledged).toBe(true);
    const page = await as(t, s.adminA.userId).query(api.onboardingChat.listMessages, {
      organizationId: s.a.orgId, sessionId: r.sessionId, paginationOpts: { numItems: 30, cursor: null },
    });
    expect(page.page).toHaveLength(0);
    const oldMessages = await t.run((ctx) => ctx.db.query("onboardingMessages").withIndex("by_session", (q) => q.eq("sessionId", oldId)).collect());
    expect(oldMessages).toHaveLength(2);

    const audits = await t.run((ctx) =>
      ctx.db.query("auditLogs").withIndex("by_organization_and_created", (q) => q.eq("organizationId", s.a.orgId)).collect(),
    );
    const audit = audits.find((x) => (x.metadata as { action?: string } | undefined)?.action === "onboarding_conversation_restarted");
    expect(audit?.severity).toBe("medium");
    expect(audit?.actorId).toBe(s.adminA.memberId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("idempotente: clique duplo devolve a mesma sessão nova; sessão vazia não arquiva", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const oldId = await sessionWithProgress(t, s);
    const first = await restart(t, s.adminA.userId, s.a.orgId, oldId);
    const again = await restart(t, s.adminA.userId, s.a.orgId, oldId);
    expect(again).toEqual({ sessionId: first.sessionId, restarted: false });
    // A nova ainda está vazia: recomeçar de novo não cria outra nem gasta cota.
    const empty = await restart(t, s.adminA.userId, s.a.orgId, first.sessionId);
    expect(empty).toEqual({ sessionId: first.sessionId, restarted: false });
    expect(await sessionsOf(t, s.a.orgId)).toHaveLength(2);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("escopo: não administrador recusado; sessão de outra org recusada; não membro recusado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const oldId = await sessionWithProgress(t, s);
    await expect(restart(t, s.managerA.userId, s.a.orgId, oldId)).rejects.toThrow(/Permissão insuficiente/);
    await expect(restart(t, s.adminB.userId, s.a.orgId, oldId)).rejects.toThrow();
    // Admin da org B passando a própria org com a sessão da org A: "não encontrada".
    await expect(restart(t, s.adminB.userId, s.b.orgId, oldId)).rejects.toThrow(/não encontrada/);
    const sessions = await sessionsOf(t, s.a.orgId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].archivedAt).toBeUndefined();
  });

  test("limite de frequência: no máximo 3 recomeços por hora por organização", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    let current = await sessionWithProgress(t, s);
    const markProgress = (id: Id<"onboardingSessions">) => t.run((ctx) => ctx.db.patch(id, { messageCount: 1 }));
    for (let i = 0; i < RESTART_LIMITS.perHour; i++) {
      const r = await restart(t, s.adminA.userId, s.a.orgId, current);
      expect(r.restarted).toBe(true);
      current = r.sessionId;
      await markProgress(current);
      vi.advanceTimersByTime(60_000);
    }
    await expect(restart(t, s.adminA.userId, s.a.orgId, current)).rejects.toThrow(/várias vezes/);
    // Passada a hora, volta a poder.
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect((await restart(t, s.adminA.userId, s.a.orgId, current)).restarted).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("limites de custo e de uso NÃO zeram: gasto da sessão herdado, contadores de usuário/org/IP e medidor mensal intactos", async () => {
    vi.stubEnv("ONBOARDING_SESSION_BUDGET_USD_MICROS", "400000"); // US$ 0,40 (a sessão já gastou 0,42)
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const oldId = await sessionWithProgress(t, s);
    const month = new Date(Date.now()).toISOString().slice(0, 7);
    await t.run(async (ctx) => {
      await ctx.db.insert("onboardingRateLimits", { key: `user:${s.adminA.userId}:1d`, windowStart: Date.now(), count: 7 } as never);
    });
    const before = await t.run(async (ctx) => ({
      limits: await ctx.db.query("onboardingRateLimits").collect(),
      usage: await ctx.db.query("aiUsageMonthly").collect(),
    }));

    const before0 = await t.mutation(internal.onboardingBudget.internalReserveOnboardingSpend, {
      organizationId: s.a.orgId, sessionId: oldId, estimateUsdMicros: 1,
    });
    expect(before0.ok).toBe(false);

    const r = await restart(t, s.adminA.userId, s.a.orgId, oldId);
    const after = await t.run(async (ctx) => ({
      limits: await ctx.db.query("onboardingRateLimits").collect(),
      usage: await ctx.db.query("aiUsageMonthly").collect(),
    }));
    expect(after.limits).toEqual(before.limits);
    expect(after.usage).toEqual(before.usage);
    void month;

    // A sessão nova continua sem orçamento: recomeçar não é drible do teto.
    const decision = await t.mutation(internal.onboardingBudget.internalReserveOnboardingSpend, {
      organizationId: s.a.orgId, sessionId: r.sessionId, estimateUsdMicros: 1,
    });
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("session_budget");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("nada do CRM é apagado nem desfeito: funil, campos, respostas rápidas, atendente, aceite de IA e e-mail confirmado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true });
    const oldId = await sessionWithProgress(t, s);
    const view = await as(t, s.adminA.userId).query(api.onboardingSessions.getSession, { organizationId: s.a.orgId });
    const applied = await as(t, s.adminA.userId).mutation(api.onboardingSessions.applyOnboardingDraft, {
      organizationId: s.a.orgId, sessionId: oldId, expectedDraftHash: view!.draftHash!,
    });
    expect(applied.attendant).toBe("created");

    const snap = () =>
      t.run(async (ctx) => ({
        boards: await ctx.db.query("boards").withIndex("by_organization", (q) => q.eq("organizationId", s.a.orgId)).collect(),
        stages: await ctx.db.query("stages").collect(),
        fields: await ctx.db.query("fieldDefinitions").withIndex("by_organization", (q) => q.eq("organizationId", s.a.orgId)).collect(),
        quickReplies: await ctx.db.query("quickReplies").withIndex("by_organization", (q) => q.eq("organizationId", s.a.orgId)).collect(),
        ai: await ctx.db.query("teamMembers").withIndex("by_organization_and_type", (q) => q.eq("organizationId", s.a.orgId).eq("type", "ai")).collect(),
        aiConfig: (await ctx.db.get(s.a.orgId))!.settings.aiConfig,
        user: await ctx.db.get(s.adminA.userId),
      }));
    const before = await snap();
    const r = await restart(t, s.adminA.userId, s.a.orgId, oldId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await snap();
    expect(after).toEqual(before);
    expect(after.aiConfig?.lgpdAck).toBeDefined();
    expect(after.user?.emailVerificationTime).toBeDefined();

    // A nova sessão sabe que a operação já foi montada antes (estado da entrada e do aviso de reaplicar).
    const state = await as(t, s.adminA.userId).query(api.onboardingChat.getChatState, { organizationId: s.a.orgId });
    expect(state!.applied).toBe(false);
    expect(state!.priorApplied).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(r.sessionId)))!.attendantId).toBeUndefined();
  });

  test("reaplicar depois de recomeçar: atendente existente protegido e funil idêntico com leads não duplica", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true });
    const oldId = await sessionWithProgress(t, s);
    const v1 = await as(t, s.adminA.userId).query(api.onboardingSessions.getSession, { organizationId: s.a.orgId });
    const first = await as(t, s.adminA.userId).mutation(api.onboardingSessions.applyOnboardingDraft, {
      organizationId: s.a.orgId, sessionId: oldId, expectedDraftHash: v1!.draftHash!,
    });
    expect(first.funnelMode).toBe("replaced");
    // A operação passa a ter um lead no funil montado.
    await t.run(async (ctx) => {
      const stage = await ctx.db.query("stages").withIndex("by_board_and_order", (q) => q.eq("boardId", first.boardId!)).first();
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId: s.a.orgId, firstName: "Cliente", tags: [], createdAt: now, updatedAt: now } as never);
      await ctx.db.insert("leads", {
        organizationId: s.a.orgId, title: "Lead real", contactId, boardId: first.boardId!, stageId: stage!._id,
        value: 0, currency: "BRL", priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active", createdAt: now, updatedAt: now, lastActivityAt: now,
      } as never);
    });
    const r = await restart(t, s.adminA.userId, s.a.orgId, oldId);
    await as(t, s.adminA.userId).mutation(api.onboardingSessions.saveDraft, {
      organizationId: s.a.orgId, sessionId: r.sessionId, draft: draft(), expectedVersion: 0,
    });
    const v2 = await as(t, s.adminA.userId).query(api.onboardingSessions.getSession, { organizationId: s.a.orgId });
    const second = await as(t, s.adminA.userId).mutation(api.onboardingSessions.applyOnboardingDraft, {
      organizationId: s.a.orgId, sessionId: r.sessionId, expectedDraftHash: v2!.draftHash!,
    });
    expect(second.attendant).toBe("skipped_existing");
    expect(second.boardId).toBe(first.boardId);
    const boards = await t.run((ctx) => ctx.db.query("boards").withIndex("by_organization", (q) => q.eq("organizationId", s.a.orgId)).collect());
    expect(boards).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("sessão arquivada é recusada pelas portas (aplicar, gravar rascunho, abrir turno)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true });
    const oldId = await sessionWithProgress(t, s);
    const v1 = await as(t, s.adminA.userId).query(api.onboardingSessions.getSession, { organizationId: s.a.orgId });
    await restart(t, s.adminA.userId, s.a.orgId, oldId);
    await expect(
      as(t, s.adminA.userId).mutation(api.onboardingSessions.applyOnboardingDraft, {
        organizationId: s.a.orgId, sessionId: oldId, expectedDraftHash: v1!.draftHash!,
      }),
    ).rejects.toThrow(/recomeçada/);
    await expect(
      as(t, s.adminA.userId).mutation(api.onboardingSessions.saveDraft, {
        organizationId: s.a.orgId, sessionId: oldId, draft: draft(), expectedVersion: v1!.draftVersion,
      }),
    ).rejects.toThrow(/recomeçada/);
    await expect(
      as(t, s.adminA.userId).mutation(internal.onboardingChat.internalPrepareTurn, { organizationId: s.a.orgId, sessionId: oldId }),
    ).rejects.toThrow(/recomeçada/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("arquivos da conversa antiga saem pela porta (anexo e áudio); arquivo com vínculo fica", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const oldId = await sessionWithProgress(t, s);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const pdf = await ctx.storage.store(new Blob(["%PDF-1.4 teste"], { type: "application/pdf" }));
      const wav = await ctx.storage.store(new Blob(["RIFF"], { type: "audio/wav" }));
      const linked = await ctx.storage.store(new Blob(["foto"], { type: "image/png" }));
      const pdfFile = await ctx.db.insert("files", {
        organizationId: s.a.orgId, storageId: pdf, name: "tabela.pdf", mimeType: "application/pdf", size: 14, fileType: "message_attachment",
        uploadedBy: s.adminA.memberId, createdAt: now,
      });
      const wavFile = await ctx.db.insert("files", {
        organizationId: s.a.orgId, storageId: wav, name: "resposta-em-audio.wav", mimeType: "audio/wav", size: 4, fileType: "other",
        uploadedBy: s.adminA.memberId, metadata: { kind: "onboarding_voice_reply" }, createdAt: now,
      });
      // Arquivo do CRM (vinculado a um membro) citado numa mensagem da conversa: não é da conversa, fica.
      const linkedFile = await ctx.db.insert("files", {
        organizationId: s.a.orgId, storageId: linked, name: "avatar.png", mimeType: "image/png", size: 4, fileType: "message_attachment",
        teamMemberId: s.adminA.memberId, createdAt: now,
      });
      await ctx.db.insert("onboardingMessages", {
        organizationId: s.a.orgId, sessionId: oldId, role: "user", text: "", attachment: { kind: "pdf", label: "tabela.pdf", storageId: pdf }, createdAt: now + 2,
      });
      await ctx.db.insert("onboardingMessages", {
        organizationId: s.a.orgId, sessionId: oldId, role: "user", text: "", attachment: { kind: "imagem", label: "avatar.png", storageId: linked }, createdAt: now + 3,
      });
      await ctx.db.insert("onboardingMessages", {
        organizationId: s.a.orgId, sessionId: oldId, role: "assistant", text: "Ouvi!",
        audio: { fileId: wavFile, storageId: wav, durationSec: 1, mimeType: "audio/wav" }, audioExpiresAt: now + 1000, createdAt: now + 4,
      });
      return { pdf, wav, linked, pdfFile, wavFile, linkedFile };
    });

    await restart(t, s.adminA.userId, s.a.orgId, oldId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const after = await t.run(async (ctx) => ({
      pdfFile: await ctx.db.get(ids.pdfFile),
      wavFile: await ctx.db.get(ids.wavFile),
      linkedFile: await ctx.db.get(ids.linkedFile),
      pdfBlob: (await ctx.storage.get(ids.pdf)) !== null,
      wavBlob: (await ctx.storage.get(ids.wav)) !== null,
      linkedBlob: (await ctx.storage.get(ids.linked)) !== null,
      messages: await ctx.db.query("onboardingMessages").withIndex("by_session", (q) => q.eq("sessionId", oldId)).collect(),
    }));
    expect(after.pdfFile).toBeNull();
    expect(after.wavFile).toBeNull();
    expect(after.pdfBlob).toBe(false);
    expect(after.wavBlob).toBe(false);
    expect(after.linkedFile).not.toBeNull();
    expect(after.linkedBlob).toBe(true);
    // Texto fica (histórico arquivado); nenhuma referência a blob sobra.
    expect(after.messages).toHaveLength(5);
    expect(after.messages.some((m) => m.audio !== undefined || m.attachment?.storageId !== undefined)).toBe(false);
  });

  test("purga de arquivos só age em sessão arquivada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await sessionWithProgress(t, s);
    const r = await t.mutation(internal.onboardingSessions.internalPurgeArchivedSessionFiles, { organizationId: s.a.orgId, sessionId: id, cursor: null });
    expect(r).toEqual({ processed: 0, filesDeleted: 0, done: true });
  });
});

describe("getEntryOverview", () => {
  test("só as orgs do usuário, com permissão, estado da conversa, operação existente e teste da empresa nova", async () => {
    vi.stubEnv("BILLING_TRIAL_ON_SIGNUP", "true");
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true });
    const now = Date.now();
    // O admin da A também é gerente (sem settings:manage) da B.
    await t.run(async (ctx) => {
      await ctx.db.insert("teamMembers", {
        organizationId: s.b.orgId, userId: s.adminA.userId, name: "admin-a", role: "manager", type: "human", status: "active", createdAt: now, updatedAt: now,
      });
    });
    let o = await as(t, s.adminA.userId).query(api.onboardingSessions.getEntryOverview, { now });
    const orgA = () => o!.orgs.find((x) => x.organizationId === s.a.orgId)!;
    expect(o!.orgs).toHaveLength(2);
    expect(orgA()).toMatchObject({ canManage: true, configured: false, conversation: "none", readOnly: false, spendCapReached: false });
    expect(o!.orgs.find((x) => x.organizationId === s.b.orgId)).toMatchObject({ canManage: false, conversation: "none", configured: false });
    expect(o!.newOrgTrial).toBe("fresh");

    const sessionId = await sessionWithProgress(t, s);
    o = await as(t, s.adminA.userId).query(api.onboardingSessions.getEntryOverview, { now });
    expect(orgA()).toMatchObject({ conversation: "in_progress", reachedStep: 3, configured: false });

    const view = await as(t, s.adminA.userId).query(api.onboardingSessions.getSession, { organizationId: s.a.orgId });
    await as(t, s.adminA.userId).mutation(api.onboardingSessions.applyOnboardingDraft, {
      organizationId: s.a.orgId, sessionId, expectedDraftHash: view!.draftHash!,
    });
    o = await as(t, s.adminA.userId).query(api.onboardingSessions.getEntryOverview, { now });
    expect(orgA()).toMatchObject({ conversation: "applied", configured: true });

    // Recomeçada e vazia: continua "aplicada" para a entrada.
    await restart(t, s.adminA.userId, s.a.orgId, sessionId);
    o = await as(t, s.adminA.userId).query(api.onboardingSessions.getEntryOverview, { now });
    expect(orgA()).toMatchObject({ conversation: "applied", configured: true, reachedStep: 0 });

    // Teste já usado e vencido: a empresa nova nasce em modo leitura.
    await t.run((ctx) => ctx.db.insert("trialGrants", { userId: s.adminA.userId, organizationId: s.a.orgId, startedAt: now - 40 * 864e5, endsAt: now - 864e5 }));
    o = await as(t, s.adminA.userId).query(api.onboardingSessions.getEntryOverview, { now });
    expect(o!.newOrgTrial).toBe("shared_expired");
    expect(o!.newOrgTrialEndsAt).toBe(now - 864e5);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test("org legada configurada à mão (atendente + leads), modo leitura e sem login", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("teamMembers", {
        organizationId: s.a.orgId, name: "Atendente", role: "ai", type: "ai", status: "active", createdAt: now, updatedAt: now,
        agentProfile: { kind: "attendant", mode: "suggest" },
      } as never);
      await ctx.db.patch(s.b.orgId, { billing: { status: "read_only", plan: "profissional", updatedAt: now } });
      await ctx.db.insert("teamMembers", {
        organizationId: s.b.orgId, userId: s.adminA.userId, name: "admin-a", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
      });
    });
    const o = await as(t, s.adminA.userId).query(api.onboardingSessions.getEntryOverview, { now });
    expect(o!.orgs.find((x) => x.organizationId === s.a.orgId)).toMatchObject({ configured: true, conversation: "none" });
    expect(o!.orgs.find((x) => x.organizationId === s.b.orgId)).toMatchObject({ canManage: true, readOnly: true });
    expect(o!.newOrgTrial).toBe("none");
    expect(await t.query(api.onboardingSessions.getEntryOverview, { now })).toBeNull();
  });
});

describe("regras puras do recomeço", () => {
  test("janela deslizante por hora e por dia", () => {
    const now = 10 * 864e5;
    expect(evaluateRestartRate([], now)).toEqual({ allowed: true });
    const hour = [now - 10 * 60e3, now - 20 * 60e3, now - 30 * 60e3];
    const r = evaluateRestartRate(hour, now);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfterMs).toBe(30 * 60e3);
    const day = Array.from({ length: 10 }, (_, i) => now - (2 + i) * 3600e3);
    expect(evaluateRestartRate(day, now).allowed).toBe(false);
    expect(evaluateRestartRate(day.slice(0, 9), now).allowed).toBe(true);
    // Fora da janela de 24 h não conta.
    expect(evaluateRestartRate(Array.from({ length: 10 }, () => now - 25 * 3600e3), now).allowed).toBe(true);
  });

  test("estado da conversa e teste da empresa nova", () => {
    expect(entryConversationState(null)).toBe("none");
    expect(entryConversationState({ messageCount: 0, draftVersion: 0 } as never)).toBe("none");
    expect(entryConversationState({ messageCount: 3, draftVersion: 0 } as never)).toBe("in_progress");
    expect(entryConversationState({ messageCount: 3, draftVersion: 2, appliedAt: 1 } as never)).toBe("applied");
    expect(entryConversationState({ messageCount: 0, draftVersion: 0, priorAppliedAt: 1 } as never)).toBe("applied");
    expect(entryConversationState({ messageCount: 1, draftVersion: 0, priorAppliedAt: 1 } as never)).toBe("in_progress");
    expect(newOrgTrialFor(false, null, 5)).toBe("none");
    expect(newOrgTrialFor(true, null, 5)).toBe("fresh");
    expect(newOrgTrialFor(true, 10, 5)).toBe("shared_active");
    expect(newOrgTrialFor(true, 4, 5)).toBe("shared_expired");
  });
});
