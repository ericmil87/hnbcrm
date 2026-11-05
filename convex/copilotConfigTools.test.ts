/// <reference types="vite/client" />
/**
 * fv2-16: tools do Copiloto para ler e propor mudanças no Atendente IA.
 * Fase 1 só grava `pendingActions`; a confirmação executa pelos cores de
 * `attendantConfigOps` com re-checagem de permissão, e-mail e `beforeHash`.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { readAgentTexts } from "./lib/agentProfileTexts";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("WHISPER_SERVICE_URL", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type T = TestConvex<typeof schema>;
const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function seed(t: T, opts: { aiActive?: boolean; secondAttendant?: boolean } = {}) {
  const aiActive = opts.aiActive ?? true;
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", { email: "admin@teste.com" });
    const noEmailUserId = await ctx.db.insert("users", {});
    const agentUserId = await ctx.db.insert("users", { email: "agente@teste.com" });
    const managerUserId = await ctx.db.insert("users", { email: "gerente@teste.com" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Config",
      slug: "org-config",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const human = (userId: Id<"users">, name: string, role: "admin" | "manager" | "agent") =>
      ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active", createdAt: now, updatedAt: now,
      });
    const adminId = await human(adminUserId, "Admin", "admin");
    const noEmailAdminId = await human(noEmailUserId, "Sem e-mail", "admin");
    const agentId = await human(agentUserId, "Vendedor", "agent");
    const managerId = await human(managerUserId, "Gerente", "manager");
    if (aiActive) {
      await ctx.db.patch(organizationId, {
        settings: {
          timezone: "America/Sao_Paulo",
          currency: "BRL",
          aiConfig: {
            enabled: true, autoAssign: false, handoffThreshold: 0.8,
            lgpdAck: { acceptedAt: now, acceptedBy: adminId },
          },
        },
      });
    }
    const attendantId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Sofia", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest", language: "pt-BR" },
      createdAt: now, updatedAt: now,
    });
    const secondId = opts.secondAttendant
      ? await ctx.db.insert("teamMembers", {
          organizationId, name: "Bia", role: "ai", type: "ai", status: "active",
          agentProfile: { kind: "attendant", mode: "suggest" },
          createdAt: now, updatedAt: now,
        })
      : undefined;
    const channelId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Número principal",
      phoneNumberId: "555000111", status: "active", createdAt: now, updatedAt: now,
    });
    return {
      organizationId, adminUserId, noEmailUserId, adminId, noEmailAdminId, agentId, managerId,
      attendantId, secondId, channelId,
    };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = any;
const propose = (t: T, s: Seed, name: string, args: Record<string, unknown>, memberId?: Id<"teamMembers">, via?: "telegram_auto"): Promise<Out> =>
  t.mutation(internal.copilot.internalRunCopilotWriteTool, {
    name,
    argsJson: JSON.stringify(args),
    organizationId: s.organizationId,
    memberId: memberId ?? s.adminId,
    ...(via ? { via } : {}),
  });

const read = (t: T, s: Seed, name: string, args: Record<string, unknown> = {}, memberId?: Id<"teamMembers">): Promise<Out> =>
  t.query(internal.copilot.internalRunCopilotReadTool, {
    name,
    argsJson: JSON.stringify(args),
    organizationId: s.organizationId,
    memberId: memberId ?? s.adminId,
  });

const pendings = (t: T) => t.run((ctx) => ctx.db.query("pendingActions").collect());
const attendant = (t: T, s: Seed) => t.run((ctx) => ctx.db.get(s.attendantId));

/** 10 rascunhos enviados = gate do autopilot aberto. */
async function openAutopilotGate(t: T, s: Seed) {
  await t.run(async (ctx) => {
    const now = Date.now();
    const boardId = await ctx.db.insert("boards", {
      organizationId: s.organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId: s.organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId: s.organizationId, title: "Lead", boardId, stageId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: s.organizationId, leadId, channel: "whatsapp", channelConfigId: s.channelId,
      status: "active", messageCount: 0, createdAt: now, updatedAt: now,
    });
    for (let i = 0; i < 10; i++) {
      const messageId = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId, leadId, direction: "internal", senderId: s.attendantId,
        senderType: "ai", content: `draft ${i}`, contentType: "text", isInternal: true,
        metadata: { aiDraft: { status: "sent" } }, createdAt: now,
      });
      await ctx.db.insert("agentRuns", {
        organizationId: s.organizationId, memberId: s.attendantId, kind: "attendant", status: "done",
        conversationId, requestCount: 1, resultMessageId: messageId, startedAt: now, finishedAt: now,
      });
    }
  });
}

describe("copilotConfigTools: leitura", () => {
  test("getAttendantConfig não devolve ids", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const big = "linha de persona\n".repeat(1000);
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(s.attendantId))!;
      const { writeAgentTexts } = await import("./lib/agentProfileTexts");
      await writeAgentTexts(ctx, a, { systemPrompt: big, knowledge: "Preço: 10" }, { profile: a.agentProfile!, now: Date.now() });
    });
    const result = await read(t, s, "getAttendantConfig");
    const json = JSON.stringify(result);
    for (const id of [s.organizationId, s.attendantId, s.channelId, s.adminId]) expect(json).not.toContain(id);
    expect(json).not.toContain("_id");
    expect(result.name).toBe("Sofia");
    expect(result.persona.length).toBe(6000);
    expect(result.warning).toContain("persona");
    expect(result.bridgeAiAckDone).toBe(false);
    expect(result.autopilotEligible).toBe(false);
    expect(result.channels[0].label).toBe("Número principal");
  });

  test("getAttendantSetupGuide devolve modelo do segmento e passos pendentes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const result = await read(t, s, "getAttendantSetupGuide", { segment: "imobiliaria" });
    expect(result.segment).toBe("imobiliaria");
    expect(result.personaSeed.length).toBeGreaterThan(20);
    expect(result.handoffSeed).toContain("falar com atendente");
    expect(Array.isArray(result.missingSteps)).toBe(true);
  });

  test("vários atendentes sem nome devolve lista de nomes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { secondAttendant: true });
    const result = await read(t, s, "getAttendantConfig");
    expect(result.error).toBeTruthy();
    expect(result.attendants.sort()).toEqual(["Bia", "Sofia"]);
    const byName = await read(t, s, "getAttendantConfig", { attendantName: "bia" });
    expect(byName.name).toBe("Bia");
    const wrong = await propose(t, s, "setAttendantMode", { mode: "suggest", attendantName: "Zé" });
    expect(wrong.attendants.sort()).toEqual(["Bia", "Sofia"]);
  });

  test("agent sem settings:manage não vê as tools de escrita", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(propose(t, s, "updateAttendantPersona", { persona: "x" }, s.agentId)).rejects.toThrow(/Permissão insuficiente/);
    // Gerente (settings:view) lê, mas não propõe.
    const cfg = await read(t, s, "getAttendantConfig", {}, s.managerId);
    expect(cfg.name).toBe("Sofia");
    await expect(propose(t, s, "setAttendantMode", { mode: "suggest" }, s.managerId)).rejects.toThrow(/Permissão insuficiente/);
    await expect(read(t, s, "getAttendantConfig", {}, s.agentId)).rejects.toThrow(/Permissão insuficiente/);
    expect(await pendings(t)).toHaveLength(0);
  });
});

describe("copilotConfigTools: proposta e confirmação", () => {
  test("updateAttendantPersona cria pendingAction com Antes/Depois e não muda nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const result = await propose(t, s, "updateAttendantPersona", { persona: "Você é a Sofia.\nSeja breve.", newName: "Sofia Silva" });
    expect(result.status).toBe("confirmacao_necessaria");
    expect(result.preview).toContain("Antes:");
    expect(result.preview).toContain("Depois:");
    expect(result.preview).toContain("+ Você é a Sofia.");
    const list = await pendings(t);
    expect(list).toHaveLength(1);
    expect(list[0]!.tool).toBe("updateAttendantPersona");
    expect(list[0]!.args.agentMemberId).toBe(s.attendantId);
    expect(typeof list[0]!.args.beforeHash).toBe("string");
    const after = await t.run(async (ctx) => {
      const a = (await ctx.db.get(s.attendantId))!;
      return { name: a.name, texts: await readAgentTexts(ctx, a), audits: await ctx.db.query("auditLogs").collect() };
    });
    expect(after.name).toBe("Sofia");
    expect(after.texts.systemPrompt).toBeNull();
    expect(after.audits).toHaveLength(0);
  });

  test("confirmar aplica persona via core e audita via copilot", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await propose(t, s, "updateAttendantPersona", { persona: "Você é a Sofia.", newName: "Sofia Silva" });
    await as(t, s.adminUserId).mutation(api.copilot.confirmPendingAction, { pendingActionId: r.pendingActionId });
    const state = await t.run(async (ctx) => {
      const a = (await ctx.db.get(s.attendantId))!;
      return {
        name: a.name,
        texts: await readAgentTexts(ctx, a),
        audit: (await ctx.db.query("auditLogs").collect()).find((l) => l.metadata?.agentConfig),
        pending: await ctx.db.get(r.pendingActionId as Id<"pendingActions">),
      };
    });
    expect(state.name).toBe("Sofia Silva");
    expect(state.texts.systemPrompt).toBe("Você é a Sofia.");
    expect(state.audit?.metadata?.via).toBe("copilot");
    expect(state.pending?.status).toBe("executed");
  });

  test("confirmar pelo Telegram audita via telegram", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await propose(t, s, "updateAttendantKnowledge", { text: "Atendemos de seg a sex.", mode: "replace" });
    await t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: r.pendingActionId, memberId: s.adminId });
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).find((l) => l.metadata?.agentConfig));
    expect(audit?.metadata?.via).toBe("telegram");
  });

  test("updateAttendantKnowledge append concatena no servidor", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const first = await propose(t, s, "updateAttendantKnowledge", { text: "Parte A", mode: "append" });
    await t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: first.pendingActionId, memberId: s.adminId });
    const second = await propose(t, s, "updateAttendantKnowledge", { text: "Parte B", mode: "append" });
    await t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: second.pendingActionId, memberId: s.adminId });
    const texts = await t.run(async (ctx) => readAgentTexts(ctx, (await ctx.db.get(s.attendantId))!));
    expect(texts.knowledge).toBe("Parte A\n\nParte B");
  });

  test("confirmar recusa se a config mudou desde a proposta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await propose(t, s, "setAttendantHours", { startHour: 8, endHour: 18, days: ["seg", "ter", "qua", "qui", "sex"] });
    expect(r.preview).toContain("seg a sex, 8h às 18h (America/Sao_Paulo)");
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(s.attendantId))!;
      await ctx.db.patch(s.attendantId, { agentProfile: { ...a.agentProfile!, schedule: { timezone: "America/Sao_Paulo", startHour: 9, endHour: 12 } } });
    });
    await expect(
      as(t, s.adminUserId).mutation(api.copilot.confirmPendingAction, { pendingActionId: r.pendingActionId })
    ).rejects.toThrow(/A configuração mudou desde a proposta/);
    const a = await attendant(t, s);
    expect(a?.agentProfile?.schedule?.startHour).toBe(9);
  });

  test("confirmar recusa membro que perdeu settings:manage", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await propose(t, s, "setAttendantMode", { mode: "suggest" }).then(() =>
      propose(t, s, "setFollowUpSettings", { mode: "off" })
    );
    await t.run((ctx) => ctx.db.patch(s.adminId, { role: "agent" }));
    await expect(
      t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: r.pendingActionId, memberId: s.adminId })
    ).rejects.toThrow(/permissão/);
    expect((await attendant(t, s))?.agentProfile?.followUps).toBeUndefined();
  });

  test("confirmar recusa conta sem e-mail", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await propose(t, s, "setFollowUpSettings", { mode: "off" }, s.noEmailAdminId);
    expect(r.status).toBe("confirmacao_necessaria");
    await expect(
      t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: r.pendingActionId, memberId: s.noEmailAdminId })
    ).rejects.toThrow(/e-mail/);
    expect((await attendant(t, s))?.agentProfile?.followUps).toBeUndefined();
  });

  test("setAttendantMode autopilot sem gate devolve requer_acao_humana", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await propose(t, s, "setAttendantMode", { mode: "autopilot" });
    expect(r.status).toBe("requer_acao_humana");
    expect(r.instruction).toContain("autopilot");
    expect(r.url).toContain("secao=ai");
    expect(await pendings(t)).toHaveLength(0);
  });

  test("setAttendantMode autopilot com gate cria proposta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await openAutopilotGate(t, s);
    const r = await propose(t, s, "setAttendantMode", { mode: "autopilot" });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.preview).toContain("A IA vai responder sozinha aos clientes, sem aprovação");
    expect((await attendant(t, s))?.agentProfile?.mode).toBe("suggest");
    await t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: r.pendingActionId, memberId: s.adminId });
    const a = await attendant(t, s);
    expect(a?.agentProfile?.mode).toBe("autopilot");
    expect(a?.agentProfile?.autopilotEarlyAck).toBeUndefined();
  });

  test("setHandoffRules mantém as frases padrão e soma as novas", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await propose(t, s, "setHandoffRules", { keywords: ["reclamação", "falar com atendente"], mode: "append" });
    await t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: r.pendingActionId, memberId: s.adminId });
    const kw = (await attendant(t, s))?.agentProfile?.handoffKeywords ?? [];
    expect(kw).toContain("reclamação");
    expect(kw).toContain("atendente humano");
    expect(kw.filter((k) => k === "falar com atendente")).toHaveLength(1);
  });

  test("setAttendantHours always:true grava schedule nulo e sem mudança não propõe", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const same = await propose(t, s, "setAttendantHours", { always: true });
    expect(same.status).toBe("sem_mudanca");
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(s.attendantId))!;
      await ctx.db.patch(s.attendantId, { agentProfile: { ...a.agentProfile!, schedule: { timezone: "America/Sao_Paulo", startHour: 9, endHour: 12 } } });
    });
    const r = await propose(t, s, "setAttendantHours", { always: true });
    expect(r.preview).toContain("Depois: sempre (24 h)");
    await t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: r.pendingActionId, memberId: s.adminId });
    expect((await attendant(t, s))?.agentProfile?.schedule).toBeUndefined();
  });

  test("setFollowUpSettings valida faixas e faz merge com o atual", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const bad = await propose(t, s, "setFollowUpSettings", { maxChain: 99 });
    expect(bad.error).toBeTruthy();
    const r = await propose(t, s, "setFollowUpSettings", { mode: "send", dailyCap: 30 });
    expect(r.preview).toContain("enviar sozinha");
    await t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: r.pendingActionId, memberId: s.adminId });
    expect((await attendant(t, s))?.agentProfile?.followUps).toMatchObject({ mode: "send", dailyCap: 30 });
  });
});

describe("copilotConfigTools: recursos de IA", () => {
  test("setAiFeatures visão exige IA ativa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: false });
    const r = await propose(t, s, "setAiFeatures", { vision: true });
    expect(r.status).toBe("requer_acao_humana");
    expect(r.url).toContain("secao=ai");
    expect(await pendings(t)).toHaveLength(0);
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2);
    const ok = await propose(t2, s2, "setAiFeatures", { vision: true });
    expect(ok.status).toBe("confirmacao_necessaria");
    await t2.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: ok.pendingActionId, memberId: s2.adminId });
    const org = await t2.run((ctx) => ctx.db.get(s2.organizationId));
    expect(org?.settings.aiConfig?.visionEnabled).toBe(true);
    expect(org?.settings.aiConfig?.enabled).toBe(true);
  });

  test("setAiFeatures transcrição por apelido de canal", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const miss = await propose(t, s, "setAiFeatures", { transcription: { channelLabel: "Outro", enabled: true } });
    expect(miss.error).toBeTruthy();
    expect(miss.channels).toEqual(["Número principal"]);
    const r = await propose(t, s, "setAiFeatures", { transcription: { channelLabel: "número PRINCIPAL", enabled: true } });
    expect(r.status).toBe("confirmacao_necessaria");
    expect(r.warnings[0]).toContain("WHISPER_SERVICE_URL");
    expect(r.preview).toContain("Número principal");
    expect(r.pendingActionId).toBeTruthy();
    await t.mutation(internal.copilot.internalConfirmPendingAction, { pendingActionId: r.pendingActionId, memberId: s.adminId });
    const cfg = await t.run((ctx) => ctx.db.get(s.channelId));
    expect(cfg?.autoTranscribeAudio).toBe(true);
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).find((l) => l.entityType === "channelConfig"));
    expect(audit?.metadata?.via).toBe("telegram");
  });
});

describe("copilotConfigTools: Telegram automático", () => {
  test("telegram_auto é recusado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const r = await propose(t, s, "updateAttendantPersona", { persona: "x" }, undefined, "telegram_auto");
    expect(r.error).toBe("Mudanças de configuração só com sua confirmação");
    expect(await pendings(t)).toHaveLength(0);
  });
});
