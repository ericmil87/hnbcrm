/// <reference types="vite/client" />
/**
 * Perf Convex I/O, onda 2 — persona/conhecimento do atendente IA fora do doc do
 * membro (`agentProfileTexts`, lib/agentProfileTexts.ts).
 *
 * Prova: dual-read por membro (legado lê do doc, migrado da tabela); a 1ª
 * escrita de texto migra; patch só de metadado num membro migrado não recria os
 * textos no doc; claim 1 a 1 e simulador montam o prompt com o texto da tabela;
 * `listAttendants` não carrega texto e `getAttendantTexts` carrega com gate;
 * migração dryRun/real/idempotente e rollback.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { readAgentTexts, writeAgentTexts } from "./lib/agentProfileTexts";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const PERSONA = "Você é a Ana, atendente da Loja Teste. Sempre gentil.";
const KNOWLEDGE = "Funcionamos de segunda a sábado, das 9h às 18h.";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubLlm(reply: string) {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function systemPromptOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}").messages?.[0]?.content ?? "";
}

async function seedOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", {});
    const managerUserId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Textos",
      slug: "org-textos",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      organizationId, userId: managerUserId, name: "Gerente", role: "manager",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } },
      },
    });
    // Membro LEGADO: texto no doc, sem textsMigratedAt.
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: {
        kind: "attendant", mode: "suggest", systemPrompt: PERSONA, knowledge: KNOWLEDGE,
        disclosure: "Sou a assistente virtual.",
      },
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta",
      displayName: "Número principal", phoneNumberId: "555000111",
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", phone: "5511988887777", tags: [],
      createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente WhatsApp", contactId, boardId, stageId,
      assignedTo: agentId, value: 0, currency: "BRL", priority: "medium",
      temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId,
      status: "active", lastInboundAt: now, messageCount: 1,
      createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("messages", {
      organizationId, conversationId, leadId,
      direction: "inbound", senderType: "contact",
      content: "Que horas vocês abrem?", contentType: "text",
      isInternal: false, createdAt: now,
    });
    return { organizationId, adminUserId, managerUserId, agentId, conversationId };
  });
}

type Seed = Awaited<ReturnType<typeof seedOrg>>;

const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

async function setup() {
  const t = convexTest(schema, modules);
  return { t, seed: await seedOrg(t) };
}

const member = (t: TestConvex<typeof schema>, id: Id<"teamMembers">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"teamMembers">);
const textRows = (t: TestConvex<typeof schema>) =>
  t.run(async (ctx) => await ctx.db.query("agentProfileTexts").collect());
const migrate = (t: TestConvex<typeof schema>, dryRun = false) =>
  t.mutation(internal.opsAgentProfile.internalMigrateAgentTexts, { dryRun });

describe("dual-read e escrita", () => {
  test("legado lê do doc; migrado lê da tabela", async () => {
    const { t, seed } = await setup();
    await t.run(async (ctx) => {
      const m = (await ctx.db.get(seed.agentId))!;
      expect(await readAgentTexts(ctx, m)).toEqual({ systemPrompt: PERSONA, knowledge: KNOWLEDGE });
    });
    await migrate(t);
    const migrated = await member(t, seed.agentId);
    expect(migrated.agentProfile?.textsMigratedAt).toBeDefined();
    expect(migrated.agentProfile).not.toHaveProperty("systemPrompt");
    expect(migrated.agentProfile).not.toHaveProperty("knowledge");
    // disclosure FICA no doc.
    expect(migrated.agentProfile?.disclosure).toBe("Sou a assistente virtual.");
    await t.run(async (ctx) => {
      expect(await readAgentTexts(ctx, migrated)).toEqual({ systemPrompt: PERSONA, knowledge: KNOWLEDGE });
    });
  });

  test("writeAgentTexts migra na 1ª escrita e depois só mexe na linha", async () => {
    const { t, seed } = await setup();
    await t.run(async (ctx) => {
      const m = (await ctx.db.get(seed.agentId))!;
      await writeAgentTexts(ctx, m, { knowledge: "FAQ nova" });
    });
    const after = await member(t, seed.agentId);
    expect(after.agentProfile?.textsMigratedAt).toBeDefined();
    expect(after.agentProfile).not.toHaveProperty("systemPrompt");
    const rows = await textRows(t);
    expect(rows).toHaveLength(1);
    // o campo que o patch não trouxe veio do doc legado.
    expect(rows[0]).toMatchObject({ systemPrompt: PERSONA, knowledge: "FAQ nova", organizationId: seed.organizationId });

    await t.run(async (ctx) => {
      const m = (await ctx.db.get(seed.agentId))!;
      await writeAgentTexts(ctx, m, { systemPrompt: "Persona 2" });
    });
    expect(await member(t, seed.agentId)).toEqual(after); // doc intocado
    expect((await textRows(t))[0]).toMatchObject({ systemPrompt: "Persona 2", knowledge: "FAQ nova" });
  });

  test("updateAgentProfile só com metadado num migrado não recria os textos no doc", async () => {
    const { t, seed } = await setup();
    await migrate(t);
    const before = await member(t, seed.agentId);
    vi.setSystemTime(Date.now() + 1000);
    await asUser(t, seed.adminUserId).mutation(api.aiSettings.updateAgentProfile, {
      agentMemberId: seed.agentId,
      patch: { botGuard: { enabled: false } },
    });
    const after = await member(t, seed.agentId);
    expect(after.agentProfile).not.toHaveProperty("systemPrompt");
    expect(after.agentProfile).not.toHaveProperty("knowledge");
    const { botGuard: _b, ...restAfter } = after.agentProfile!;
    expect(restAfter).toEqual(before.agentProfile);
    expect(after.agentProfile?.botGuard).toEqual({ enabled: false });
    expect({ ...after, agentProfile: undefined, updatedAt: 0 }).toEqual({
      ...before, agentProfile: undefined, updatedAt: 0,
    });
    expect((await textRows(t))[0]).toMatchObject({ systemPrompt: PERSONA, knowledge: KNOWLEDGE });
  });

  test("updateAgentProfile com texto num legado migra e audita só o texto que mudou", async () => {
    const { t, seed } = await setup();
    await asUser(t, seed.adminUserId).mutation(api.aiSettings.updateAgentProfile, {
      agentMemberId: seed.agentId,
      patch: { systemPrompt: PERSONA, knowledge: "FAQ editada", mode: "suggest" },
    });
    const after = await member(t, seed.agentId);
    expect(after.agentProfile?.textsMigratedAt).toBeDefined();
    expect(after.agentProfile).not.toHaveProperty("knowledge");
    expect((await textRows(t))[0]).toMatchObject({ systemPrompt: PERSONA, knowledge: "FAQ editada" });
    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).find((a) => a.entityId === seed.agentId)
    );
    expect(audit?.changes?.before).toMatchObject({ knowledge: KNOWLEDGE });
    expect(audit?.changes?.after).toMatchObject({ knowledge: "FAQ editada" });
    expect(audit?.changes?.after).not.toHaveProperty("systemPrompt"); // não mudou
    expect((audit?.changes?.before as any).agentProfile).not.toHaveProperty("systemPrompt");
  });

  test("updateAgentProfile só com metadado num legado não leva o texto ao audit", async () => {
    const { t, seed } = await setup();
    await asUser(t, seed.adminUserId).mutation(api.aiSettings.updateAgentProfile, {
      agentMemberId: seed.agentId,
      patch: { botGuard: { enabled: false } },
    });
    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).find((a) => a.entityId === seed.agentId)
    );
    for (const side of ["before", "after"] as const) {
      const changes = audit?.changes?.[side] as any;
      expect(changes).not.toHaveProperty("systemPrompt");
      expect(changes).not.toHaveProperty("knowledge");
      expect(changes.agentProfile).not.toHaveProperty("systemPrompt");
      expect(changes.agentProfile).not.toHaveProperty("knowledge");
    }
    expect((audit?.changes?.after as any).agentProfile.botGuard).toEqual({ enabled: false });
    // o doc legado segue com os textos (metadado não migra)
    expect((await member(t, seed.agentId)).agentProfile).toMatchObject({ knowledge: KNOWLEDGE });
  });

  test("ativação em 1 toque cria o atendente já migrado", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId } = await t.run(async (ctx) => {
      const now = Date.now();
      const adminUserId = await ctx.db.insert("users", { email: "admin@loja.com.br" });
      const organizationId = await ctx.db.insert("organizations", {
        name: "Org Nova", slug: "org-nova",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now, updatedAt: now,
      });
      const adminId = await ctx.db.insert("teamMembers", {
        organizationId, userId: adminUserId, name: "Admin", role: "admin",
        type: "human", status: "active", createdAt: now, updatedAt: now,
      });
      await ctx.db.patch(organizationId, {
        settings: {
          timezone: "America/Sao_Paulo", currency: "BRL",
          aiConfig: {
            enabled: true, autoAssign: false, handoffThreshold: 0.8,
            lgpdAck: { acceptedAt: now, acceptedBy: adminId },
          },
        },
      });
      return { organizationId, adminUserId };
    });
    await asUser(t, adminUserId).mutation(api.aiSettings.createAttendantOneClick, { organizationId });
    const ai = await t.run(async (ctx) =>
      (await ctx.db.query("teamMembers").collect()).find((m) => m.type === "ai")
    );
    expect(ai?.agentProfile?.textsMigratedAt).toBeDefined();
    expect(ai?.agentProfile).not.toHaveProperty("systemPrompt");
    const rows = await textRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].teamMemberId).toBe(ai!._id);
    expect(rows[0].systemPrompt?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("prompt do atendente com o texto da tabela", () => {
  test("claim 1 a 1 usa persona e conhecimento migrados", async () => {
    const { t, seed } = await setup();
    await migrate(t);
    await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
      conversationId: seed.conversationId,
    });
    const item = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect())[0]);
    vi.useRealTimers();
    const fetchMock = stubLlm("Abrimos às 9h!");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });
    const prompt = systemPromptOf(fetchMock);
    expect(prompt).toContain(PERSONA);
    expect(prompt).toContain(KNOWLEDGE);
  });

  test("simulador usa persona e conhecimento migrados", async () => {
    const { t, seed } = await setup();
    await migrate(t);
    vi.useRealTimers();
    const fetchMock = stubLlm("Abrimos às 9h!");
    const result = await asUser(t, seed.adminUserId).action(api.attendant.simulateAttendant, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      transcript: [{ role: "customer" as const, content: "Que horas abrem?" }],
    });
    expect(result.error).toBeNull();
    const prompt = systemPromptOf(fetchMock);
    expect(prompt).toContain(PERSONA);
    expect(prompt).toContain(KNOWLEDGE);
  });
});

describe("editor da UI", () => {
  test("listAttendants sem texto; getAttendantTexts com texto e gate settings:manage", async () => {
    const { t, seed } = await setup();
    for (const migrated of [false, true]) {
      if (migrated) await migrate(t);
      const list = await asUser(t, seed.adminUserId).query(api.aiSettings.listAttendants, {
        organizationId: seed.organizationId,
      });
      expect(list).toHaveLength(1);
      expect(list[0].agentProfile).not.toHaveProperty("systemPrompt");
      expect(list[0].agentProfile).not.toHaveProperty("knowledge");
      expect(list[0].agentProfile.kind).toBe("attendant");
      const texts = await asUser(t, seed.adminUserId).query(api.aiSettings.getAttendantTexts, {
        agentMemberId: seed.agentId,
      });
      expect(texts).toEqual({ systemPrompt: PERSONA, knowledge: KNOWLEDGE });
    }
    // gerente vê a lista (settings:view) mas não o texto (settings:manage).
    await asUser(t, seed.managerUserId).query(api.aiSettings.listAttendants, {
      organizationId: seed.organizationId,
    });
    await expect(
      asUser(t, seed.managerUserId).query(api.aiSettings.getAttendantTexts, { agentMemberId: seed.agentId })
    ).rejects.toThrow();
  });

  test("REST de equipe não devolve o texto, nem de membro legado", async () => {
    const { t, seed } = await setup();
    const members = await t.query(internal.teamMembers.internalGetTeamMembers, {
      organizationId: seed.organizationId,
    });
    const ai = members.find((m: any) => m._id === seed.agentId)!;
    expect(ai.agentProfile).not.toHaveProperty("systemPrompt");
    expect(ai.agentProfile).not.toHaveProperty("knowledge");
  });
});

describe("migração e rollback", () => {
  test("dryRun relata sem escrever; real migra; repetir é idempotente", async () => {
    const { t, seed } = await setup();
    const docBefore = await member(t, seed.agentId);
    const dry = await migrate(t, true);
    expect(dry).toMatchObject({ dryRun: true, pending: 1, applied: 0, isDone: true });
    expect(dry.members[0]).toMatchObject({
      memberId: seed.agentId,
      systemPromptLength: PERSONA.length,
      knowledgeLength: KNOWLEDGE.length,
    });
    expect(await member(t, seed.agentId)).toEqual(docBefore);
    expect(await textRows(t)).toHaveLength(0);

    const real = await migrate(t);
    expect(real).toMatchObject({ dryRun: false, pending: 1, applied: 1, skipped: 0 });
    expect(await textRows(t)).toHaveLength(1);

    const again = await migrate(t);
    expect(again).toMatchObject({ pending: 0, applied: 0, skipped: 1 });
    expect(await textRows(t)).toHaveLength(1);

    // filtro por org (o único membro já migrou): nada pendente.
    const scoped = await t.mutation(internal.opsAgentProfile.internalMigrateAgentTexts, {
      organizationId: seed.organizationId,
      dryRun: true,
    });
    expect(scoped.pending).toBe(0);
  });

  test("rollback devolve o texto ao doc e apaga a linha", async () => {
    const { t, seed } = await setup();
    const docBefore = await member(t, seed.agentId);
    await migrate(t);
    const dry = await t.mutation(internal.opsAgentProfile.internalRestoreAgentTextsToDoc, {});
    expect(dry).toMatchObject({ dryRun: true, pending: 1, applied: 0 });
    expect(await textRows(t)).toHaveLength(1);

    const real = await t.mutation(internal.opsAgentProfile.internalRestoreAgentTextsToDoc, { dryRun: false });
    expect(real.applied).toBe(1);
    const restored = await member(t, seed.agentId);
    expect(restored.agentProfile).toEqual(docBefore.agentProfile);
    expect(await textRows(t)).toHaveLength(0);
  });

  test("internalSetAgentProfileText em migrado escreve na tabela e audita o texto", async () => {
    const { t, seed } = await setup();
    await migrate(t);
    const res = await t.mutation(internal.opsAgentProfile.internalSetAgentProfileText, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      field: "knowledge",
      text: "FAQ v2",
      expectedCurrentLength: KNOWLEDGE.length,
      dryRun: false,
    });
    expect(res).toMatchObject({ applied: true, beforeLength: KNOWLEDGE.length });
    expect((await textRows(t))[0].knowledge).toBe("FAQ v2");
    expect((await member(t, seed.agentId)).agentProfile).not.toHaveProperty("knowledge");
    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).find(
        (a) => (a.metadata as any)?.op === "internalSetAgentProfileText"
      )
    );
    expect(audit?.changes?.before).toEqual({ knowledge: KNOWLEDGE });
    expect(audit?.changes?.after).toEqual({ knowledge: "FAQ v2" });
  });
});
