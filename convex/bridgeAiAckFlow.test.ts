/// <reference types="vite/client" />
/**
 * IA no WhatsApp por QR code (`aiConfig.bridgeAiAck`) e o pacote recomendado
 * da conversa de configuração no primeiro número:
 *  - o aceite só é gravado com o clique (`riskAck`), por conta com e-mail, com
 *    auditoria `high`; nada liga sozinho;
 *  - `getAiStatus.hasConnectedBridgeChannel` alimenta o aviso de "IA muda";
 *  - o primeiro número conectado depois da conversa aplicada com transcrição
 *    nasce com a transcrição ligada (`lib/onboardingChannelDefaults.ts`); org
 *    sem conversa aplicada, segundo número ou sem infraestrutura não mudam.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { OnboardingDraft } from "./lib/onboardingDraft";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const ENV = "WHISPER_SERVICE_URL";
let savedEnv: string | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  savedEnv = process.env[ENV];
  process.env[ENV] = "https://whisper.exemplo.test";
});
afterEach(() => {
  vi.useRealTimers();
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

type T = TestConvex<typeof schema>;
const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

function draft(transcription: boolean): OnboardingDraft {
  return {
    version: 1,
    business: { name: "Clínica Teste", segment: "saude", description: "Clínica.", suspicious: false },
    funnel: {
      name: "Funil",
      stages: [
        { name: "Novo", order: 0 },
        { name: "Fechou", order: 1, outcome: "won" },
        { name: "Perdido", order: 2, outcome: "lost" },
      ],
    },
    customFields: [],
    persona: { attendantName: "Anis", tone: "amigavel", addressAs: "voce", languages: ["pt-BR"], presentsAsAi: true },
    knowledge: [],
    quickReplies: [],
    handoffRules: [],
    features: { vision: false, transcription, dateTime: true, translation: false, voice: false },
  };
}

async function seed(
  t: T,
  opts: { aiActive?: boolean; session?: "transcription" | "no_transcription" | "unapplied"; existingChannel?: boolean; email?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", {
      name: "Clínica",
      slug: `clinica-${Math.random().toString(36).slice(2, 8)}`,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: false, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", opts.email === false ? {} : { email: "admin-qr@teste.com" });
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
    if (opts.session) {
      await ctx.db.insert("onboardingSessions", {
        organizationId: orgId, createdBy: memberId, stage: opts.session === "unapplied" ? "draft" : "applied",
        draft: draft(opts.session !== "no_transcription"), draftVersion: 1, messageCount: 0, spentUsdMicros: 0,
        ...(opts.session === "unapplied" ? {} : { appliedAt: now }),
        createdAt: now, updatedAt: now,
      });
    }
    if (opts.existingChannel) {
      await ctx.db.insert("channelConfigs", {
        organizationId: orgId, channel: "whatsapp", provider: "meta", displayName: "Oficial",
        phoneNumberId: "555000999", status: "active", createdAt: now, updatedAt: now,
      });
    }
    return { orgId, userId, memberId };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function insertBridge(t: T, s: Seed, instance = "inst-1") {
  return await as(t, s.userId).mutation(internal.channelConfigs.internalInsertConfig, {
    organizationId: s.orgId,
    channel: "whatsapp",
    provider: "bridge",
    displayName: "WhatsApp (QR code)",
    bridgeBaseUrl: "https://gw.exemplo.test",
    bridgeInstanceId: instance,
    bridgeTokenEncrypted: "enc-fake",
    bridgeTokenLast4: "abcd",
  });
}

const channel = (t: T, id: Id<"channelConfigs">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const audits = (t: T, orgId: Id<"organizations">) =>
  t.run(async (ctx) =>
    ctx.db.query("auditLogs").withIndex("by_organization_and_created", (q) => q.eq("organizationId", orgId)).collect(),
  );

describe("aceite da IA no WhatsApp por QR code", () => {
  test("só com o clique (riskAck), por conta com e-mail, com auditoria high", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true });
    await expect(
      as(t, s.userId).mutation(api.aiSettings.setBridgeAiAck, { organizationId: s.orgId, accept: true }),
    ).rejects.toThrow(/risco de banimento/);
    let org = await t.run(async (ctx) => (await ctx.db.get(s.orgId))!);
    expect(org.settings.aiConfig?.bridgeAiAck).toBeUndefined();

    await as(t, s.userId).mutation(api.aiSettings.setBridgeAiAck, { organizationId: s.orgId, accept: true, riskAck: true });
    org = await t.run(async (ctx) => (await ctx.db.get(s.orgId))!);
    expect(org.settings.aiConfig?.bridgeAiAck?.acceptedBy).toBe(s.memberId);
    const ack = (await audits(t, s.orgId)).filter((a) => a.metadata?.bridgeRisk === true);
    expect(ack).toHaveLength(1);
    expect(ack[0]).toMatchObject({ severity: "high", actorId: s.memberId, changes: { after: { bridgeAiAck: true } } });

    const noEmail = await seed(t, { aiActive: true, email: false });
    await expect(
      as(t, noEmail.userId).mutation(api.aiSettings.setBridgeAiAck, { organizationId: noEmail.orgId, accept: true, riskAck: true }),
    ).rejects.toThrow();
  });

  test("conectar um número por QR code não grava o aceite da IA sozinho", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true });
    await insertBridge(t, s);
    const org = await t.run(async (ctx) => (await ctx.db.get(s.orgId))!);
    expect(org.settings.aiConfig?.bridgeAiAck).toBeUndefined();
  });

  test("getAiStatus.hasConnectedBridgeChannel só com a sessão do número conectada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true });
    const id = await insertBridge(t, s);
    const status = () => as(t, s.userId).query(api.aiSettings.getAiStatus, { organizationId: s.orgId });
    expect(await status()).toMatchObject({ hasBridgeChannel: true, hasConnectedBridgeChannel: false, bridgeAiAckDone: false });
    await t.run(async (ctx) => ctx.db.patch(id, { bridgeSessionState: "connected" }));
    expect(await status()).toMatchObject({ hasConnectedBridgeChannel: true });
  });
});

describe("primeiro número depois da conversa aplicada com o pacote recomendado", () => {
  test("nasce com a transcrição ligada, pela porta auditada (via onboarding)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { aiActive: true, session: "transcription" });
    const id = await insertBridge(t, s);
    expect((await channel(t, id)).autoTranscribeAudio).toBe(true);
    const log = (await audits(t, s.orgId)).find(
      (a) => a.entityType === "channelConfig" && a.metadata?.changedFields?.includes?.("autoTranscribeAudio"),
    );
    expect(log).toMatchObject({ entityId: id, metadata: { via: "onboarding" }, changes: { after: { autoTranscribeAudio: true } } });
  });

  test("não muda nada: org sem conversa, conversa não aplicada, sem transcrição no pacote, IA desligada, segundo número ou sem infraestrutura", async () => {
    const cases: Array<{ name: string; opts: Parameters<typeof seed>[1]; noInfra?: boolean }> = [
      { name: "sem conversa", opts: { aiActive: true } },
      { name: "não aplicada", opts: { aiActive: true, session: "unapplied" } },
      { name: "sem transcrição", opts: { aiActive: true, session: "no_transcription" } },
      { name: "IA desligada", opts: { session: "transcription" } },
      { name: "segundo número", opts: { aiActive: true, session: "transcription", existingChannel: true } },
      { name: "sem infraestrutura", opts: { aiActive: true, session: "transcription" }, noInfra: true },
    ];
    for (const c of cases) {
      const t = convexTest(schema, modules);
      if (c.noInfra) delete process.env[ENV];
      else process.env[ENV] = "https://whisper.exemplo.test";
      const s = await seed(t, c.opts);
      const id = await insertBridge(t, s);
      expect({ case: c.name, on: (await channel(t, id)).autoTranscribeAudio ?? false }).toEqual({ case: c.name, on: false });
    }
  });
});
