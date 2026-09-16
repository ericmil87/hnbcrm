/// <reference types="vite/client" />
/**
 * Um número de WhatsApp pertence a UMA conta só.
 *
 * Não é higiene: o mesmo número pareado em duas orgs faz CADA mensagem do
 * contato ser entregue às duas instâncias e ingerida nas duas contas — dado de
 * um inquilino aparecendo no inbox de outro. Além disso cada pareamento gasta um
 * slot de aparelho vinculado da conta do WhatsApp (são poucos) e dobra o
 * tráfego que a plataforma lê como automação.
 *
 * A regra vale no momento em que o número finalmente se torna conhecido: o
 * pareamento. Quem conecta por último fica com o número; quem tinha é desativado.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const PHONE = "5511944998753";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seedOrgWithConfig(
  t: TestConvex<typeof schema>,
  opts: {
    slug: string;
    name: string;
    bridgePhone?: string;
    status?: "active" | "disabled" | "error";
    provider?: "meta" | "bridge";
  }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: opts.name,
      slug: opts.slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: opts.provider ?? "bridge",
      displayName: `WhatsApp ${opts.slug}`,
      bridgeBaseUrl: "https://wa-gw.example.test",
      bridgeInstanceId: `inst_${opts.slug}`,
      // Token cifrado de verdade não importa aqui: o logout é agendado, e o
      // agendamento é o que os testes observam.
      bridgeTokenEncrypted: "cifrado",
      bridgeTokenLast4: "aaaa",
      ...(opts.bridgePhone ? { bridgePhone: opts.bridgePhone } : {}),
      status: opts.status ?? "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, configId };
  });
}

async function connect(
  t: TestConvex<typeof schema>,
  configId: Id<"channelConfigs">,
  phone: string
) {
  return await t.mutation(internal.channelConfigs.internalRecordHealthCheck, {
    configId,
    ok: true,
    displayPhoneNumber: `+${phone}`,
    bridgePhone: phone,
    healthDetail: `Conectado como +${phone}`,
    bridgeSessionState: "connected",
  });
}

async function configOf(t: TestConvex<typeof schema>, configId: Id<"channelConfigs">) {
  return await t.run(async (ctx) => ctx.db.get(configId));
}

async function scheduledLogouts(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.name.includes("internalLogoutBridgeInstance"));
  });
}

describe("um número, uma conta", () => {
  test("conectar numa conta nova desativa o canal da conta antiga", async () => {
    const t = convexTest(schema, modules);
    const antiga = await seedOrgWithConfig(t, { slug: "antiga", name: "Conta Antiga", bridgePhone: PHONE });
    const nova = await seedOrgWithConfig(t, { slug: "nova", name: "Conta Nova" });

    const displaced = await connect(t, nova.configId, PHONE);

    expect(displaced).toEqual(["Conta Antiga"]);
    const old = await configOf(t, antiga.configId);
    expect(old?.status).toBe("disabled");
    expect(old?.bridgeSessionState).toBe("disconnected");
    // A org deslocada precisa conseguir entender o que houve só olhando o card.
    expect(old?.healthDetail).toContain("Conta Nova");

    const novo = await configOf(t, nova.configId);
    expect(novo?.status).toBe("active");
    expect(novo?.bridgePhone).toBe(PHONE);
  });

  test("o aparelho antigo é desvinculado no gateway, não só desativado no CRM", async () => {
    const t = convexTest(schema, modules);
    const antiga = await seedOrgWithConfig(t, { slug: "antiga", name: "Conta Antiga", bridgePhone: PHONE });
    const nova = await seedOrgWithConfig(t, { slug: "nova", name: "Conta Nova" });

    await connect(t, nova.configId, PHONE);

    // Só desativar no CRM deixaria o aparelho vinculado gastando slot e
    // recebendo eventos — o logout no gateway é o que encerra de verdade.
    const jobs = await scheduledLogouts(t);
    expect(jobs).toHaveLength(1);
    expect((jobs[0].args[0] as any).instanceId).toBe("inst_antiga");
  });

  test("deixa rastro na auditoria DA ORG DESLOCADA", async () => {
    const t = convexTest(schema, modules);
    const antiga = await seedOrgWithConfig(t, { slug: "antiga", name: "Conta Antiga", bridgePhone: PHONE });
    const nova = await seedOrgWithConfig(t, { slug: "nova", name: "Conta Nova" });

    await connect(t, nova.configId, PHONE);

    const logs = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", antiga.organizationId))
        .collect()
    );
    // Sem isto a org deslocada só veria o canal morto, sem explicação.
    expect(logs).toHaveLength(1);
    expect(logs[0].severity).toBe("high");
    expect(logs[0].description).toContain("Conta Nova");
  });

  test("reconectar o MESMO canal não desativa a si mesmo", async () => {
    const t = convexTest(schema, modules);
    const so = await seedOrgWithConfig(t, { slug: "unica", name: "Conta Única", bridgePhone: PHONE });

    const displaced = await connect(t, so.configId, PHONE);

    expect(displaced).toEqual([]);
    expect((await configOf(t, so.configId))?.status).toBe("active");
    expect(await scheduledLogouts(t)).toHaveLength(0);
  });

  test("número diferente não encosta em canal de outro número", async () => {
    const t = convexTest(schema, modules);
    const outro = await seedOrgWithConfig(t, {
      slug: "outro",
      name: "Outro Número",
      bridgePhone: "5581999990000",
    });
    const nova = await seedOrgWithConfig(t, { slug: "nova", name: "Conta Nova" });

    const displaced = await connect(t, nova.configId, PHONE);

    expect(displaced).toEqual([]);
    expect((await configOf(t, outro.configId))?.status).toBe("active");
  });

  test("canal já desativado não é mexido nem vira aviso", async () => {
    const t = convexTest(schema, modules);
    const desativada = await seedOrgWithConfig(t, {
      slug: "desativada",
      name: "Conta Desativada",
      bridgePhone: PHONE,
      status: "disabled",
    });
    const nova = await seedOrgWithConfig(t, { slug: "nova", name: "Conta Nova" });

    // Avisar "desconectamos X" quando X já estava fora do ar seria ruído.
    const displaced = await connect(t, nova.configId, PHONE);
    expect(displaced).toEqual([]);
    expect(await scheduledLogouts(t)).toHaveLength(0);
    expect((await configOf(t, desativada.configId))?.status).toBe("disabled");
  });

  test("sessão que NÃO está conectada não reivindica o número", async () => {
    const t = convexTest(schema, modules);
    const antiga = await seedOrgWithConfig(t, { slug: "antiga", name: "Conta Antiga", bridgePhone: PHONE });
    const nova = await seedOrgWithConfig(t, { slug: "nova", name: "Conta Nova" });

    // Um health check que só viu "connecting" não é pareamento concluído —
    // derrubar a conta antiga aqui seria desligar um canal bom por um estado
    // transitório.
    const displaced = await t.mutation(internal.channelConfigs.internalRecordHealthCheck, {
      configId: nova.configId,
      ok: false,
      bridgePhone: PHONE,
      healthDetail: "Sessão pareada — reconectando…",
      bridgeSessionState: "connecting",
    });

    expect(displaced).toEqual([]);
    expect((await configOf(t, antiga.configId))?.status).toBe("active");
  });

  test("canal Meta com o mesmo telefone não é afetado", async () => {
    const t = convexTest(schema, modules);
    const meta = await seedOrgWithConfig(t, {
      slug: "meta",
      name: "Conta Meta",
      bridgePhone: PHONE,
      provider: "meta",
    });
    const nova = await seedOrgWithConfig(t, { slug: "nova", name: "Conta Nova" });

    // A exclusividade é sobre o aparelho vinculado do protocolo não-oficial. A
    // Cloud API não usa aparelho e já tem unicidade própria por phoneNumberId.
    const displaced = await connect(t, nova.configId, PHONE);
    expect(displaced).toEqual([]);
    expect((await configOf(t, meta.configId))?.status).toBe("active");
  });

  test("campanha em andamento do canal deslocado é pausada", async () => {
    const t = convexTest(schema, modules);
    const antiga = await seedOrgWithConfig(t, { slug: "antiga", name: "Conta Antiga", bridgePhone: PHONE });
    const nova = await seedOrgWithConfig(t, { slug: "nova", name: "Conta Nova" });

    const campaignId = await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId: antiga.organizationId,
        userId,
        name: "Admin Antiga",
        role: "admin",
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert("campaigns", {
        organizationId: antiga.organizationId,
        name: "Disparo",
        status: "running",
        channelConfigId: antiga.configId,
        provider: "bridge",
        content: { kind: "text", variants: [{ text: "oi" }] },
        audience: { source: "manual" },
        schedule: { timezone: "America/Sao_Paulo", windowStartHour: 9, windowEndHour: 20, days: [1, 2, 3, 4, 5] },
        pacing: { minDelaySec: 1, maxDelaySec: 3, batchSize: 0, batchPauseMin: 0, maxPerHour: 100, maxPerDay: 200 },
        safeMode: true,
        safety: { checkNumbersFirst: false },
        stats: { total: 1, pending: 1, queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0, optedOut: 0, consecutiveFailures: 0 },
        createdBy: memberId,
        createdAt: now,
        updatedAt: now,
      });
    });

    await connect(t, nova.configId, PHONE);

    // O canal não envia mais; deixar a campanha "running" só acumularia falha.
    const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
    expect(campaign?.status).toBe("paused");
  });
});

describe("excluir canal encerra a sessão no gateway", () => {
  test("a exclusão agenda o logout da instância", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seedOrgWithConfig(t, {
      slug: "saindo",
      name: "Conta Saindo",
      bridgePhone: PHONE,
    });

    const adminUserId = await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name: "Admin",
        role: "admin",
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return userId;
    });

    const asAdmin = t.withIdentity({ subject: `${adminUserId}|session1` });
    await asAdmin.mutation(
      (await import("./_generated/api")).api.channelConfigs.deleteChannelConfig,
      { configId }
    );

    // Sem isto a instância fica logada para sempre: é assim que nascem as
    // órfãs que entregam webhook para um canal que não existe mais.
    const jobs = await scheduledLogouts(t);
    expect(jobs).toHaveLength(1);
    expect((jobs[0].args[0] as any).instanceId).toBe("inst_saindo");
  });
});
