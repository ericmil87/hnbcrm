/// <reference types="vite/client" />
/**
 * Data legível no agente de grupo e no resumo de grupo.
 *
 * Incidente (Kenji, 23/11/2026): o histórico ia ao modelo com `em` = epoch em
 * ms (1795447560734), ilegível, e um "amanhã" escrito na véspera parecia atual.
 * O PR #207 corrigiu o atendente 1:1; o agente de grupo e o resumo tinham o
 * MESMO defeito. Aqui o corpo da requisição é capturado (fetch stubado) e se
 * prova que:
 *  - o turno de grupo manda `em` = "dom 22/11 21:29" no fuso do AGENTE (que
 *    pode diferir do da org), e nenhum epoch no histórico;
 *  - o resumo manda o mesmo carimbo e o bloco DATA E HORA no FIM do system
 *    prompt, que some com `includeCurrentDateTime:false`;
 *  - as notas da equipe levam a data em que foram escritas.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";
const MEMBER_LID = "180002129735765@lid";
const MEMBER_PHONE = "558181392929";
const GROUP_JID = "120363431849092219@g.us";

/** Segunda 23/11/2026 12:25 em São Paulo (15:25 UTC). */
const NOW = Date.UTC(2026, 10, 23, 15, 25);
/** Dom 22/11 22:29 em São Paulo = 21:29 em Manaus (01:29 UTC de segunda). */
const DOM_2229_SP = Date.UTC(2026, 10, 23, 1, 29);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type SeedOpts = {
  /** Fuso do horário de atendimento do agente (vence o da org). */
  agentTimezone?: string;
  includeCurrentDateTime?: boolean;
  teamNote?: { text: string; at: number };
  /** Org sem nenhum atendente IA (o resumo não pode quebrar). */
  noAgent?: boolean;
  /**
   * Um atendente ANTERIOR, restrito a outro canal e com outro fuso: não é o da
   * sala, e o resumo não pode usar o fuso dele.
   */
  otherChannelAgentTimezone?: string;
};

async function seedGroupOrg(t: TestConvex<typeof schema>, opts: SeedOpts = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Grupos",
      slug: "org-grupos",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(organizationId, {
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          lgpdAck: { acceptedAt: now, acceptedBy: adminId },
          groupAgentEnabled: true,
          bridgeAiAck: { acceptedAt: now, acceptedBy: adminId },
        },
      },
    });
    if (opts.otherChannelAgentTimezone) {
      const otherConfigId = await ctx.db.insert("channelConfigs", {
        organizationId, channel: "whatsapp", provider: "meta",
        displayName: "Outro número", phoneNumberId: "555000999",
        status: "active", createdAt: now, updatedAt: now,
      });
      // Inserido ANTES do atendente da sala: é o primeiro que um `find` ingênuo acharia.
      await ctx.db.insert("teamMembers", {
        organizationId, name: "Outra (IA)", role: "ai", type: "ai", status: "active",
        agentProfile: {
          kind: "attendant",
          mode: "suggest",
          channelConfigIds: [otherConfigId],
          language: "en",
          schedule: { timezone: opts.otherChannelAgentTimezone, startHour: 0, endHour: 24 },
        },
        createdAt: now, updatedAt: now,
      });
    }
    if (!opts.noAgent) {
      await ctx.db.insert("teamMembers", {
        organizationId, name: "Guia (IA)", role: "ai", type: "ai", status: "active",
        agentProfile: {
          kind: "attendant",
          mode: "suggest",
          systemPrompt: "Você é o Guia, atendente da loja.",
          knowledge: "Entregamos às terças.",
          ...(opts.agentTimezone
            ? { schedule: { timezone: opts.agentTimezone, startHour: 0, endHour: 24 } }
            : {}),
          ...(opts.includeCurrentDateTime !== undefined
            ? { includeCurrentDateTime: opts.includeCurrentDateTime }
            : {}),
        },
        createdAt: now, updatedAt: now,
      });
    }
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge",
      displayName: "Número bridge", status: "active",
      bridgeBaseUrl: "https://wuzapi.example.com",
      bridgeInstanceId: "inst_1",
      bridgeLid: OUR_LID,
      bridgePhone: OUR_PHONE,
      bridgeGroupsEnabled: true,
      bridgeGroupsAck: { acceptedAt: now, acceptedBy: adminId },
      createdAt: now, updatedAt: now,
    });
    const groupChatId = await ctx.db.insert("groupChats", {
      organizationId,
      channelConfigId: configId,
      jid: GROUP_JID,
      subject: "Grupo-Teste",
      monitored: true,
      participantsCount: 2,
      participants: [
        { lid: OUR_LID, phone: OUR_PHONE, name: "Cláudio", isAdmin: false, isSuperAdmin: false },
        { lid: MEMBER_LID, phone: MEMBER_PHONE, name: "Eric", isAdmin: true, isSuperAdmin: true },
      ],
      ai: { mode: "mention", replyMode: "suggest" },
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      kind: "group",
      externalChatId: GROUP_JID,
      groupChatId,
      channel: "whatsapp",
      channelConfigId: configId,
      status: "active",
      messageCount: 0,
      ...(opts.teamNote ? { aiTeamNotes: [opts.teamNote] } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(groupChatId, { conversationId });
    return { organizationId, adminUserId, groupChatId, conversationId };
  });
}

type Seed = Awaited<ReturnType<typeof seedGroupOrg>>;

async function memberMessage(
  t: TestConvex<typeof schema>,
  seed: Seed,
  content: string,
  createdAt: number,
  mentions?: string[]
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      direction: "inbound",
      senderType: "contact",
      senderLid: MEMBER_LID,
      senderPhone: MEMBER_PHONE,
      senderName: "Eric",
      content,
      contentType: "text",
      isInternal: false,
      ...(mentions ? { mentions } : {}),
      createdAt,
    })
  );
}

function stubLlm(content: string) {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}");
}

/** Turno real do agente de grupo (menção às 12:25 de segunda, "amanhã" dito domingo à noite). */
async function runGroupTurn(t: TestConvex<typeof schema>, seed: Seed) {
  await memberMessage(t, seed, "amanhã às 10h tem a roda de conversa", DOM_2229_SP);
  const messageId = await memberMessage(t, seed, "@Cláudio já começou?", NOW, [OUR_LID]);
  await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
  const item = (await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect()))[0];
  await t.run(async (ctx) => {
    await ctx.db.patch(item._id, { nextAttemptAt: 0 });
  });
  const fetchMock = stubLlm("ok");
  await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });
  const body = bodyOf(fetchMock);
  return { system: body.messages[0].content as string, user: body.messages[1].content as string };
}

/** Só o campo `historico` do envelope (os membros levam telefone/LID de propósito). */
function historyOf(user: string): string {
  const start = user.indexOf('"historico"');
  const end = user.indexOf('"membros"'); // o envelope serializa as chaves em ordem alfabética
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return user.slice(start, end);
}

describe("agente de grupo: histórico com data legível", () => {
  test("cada mensagem leva dia, data e hora no fuso da org, nunca epoch", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t);

    const { user } = await runGroupTurn(t, seed);
    const historico = historyOf(user);
    expect(historico).toContain("dom 22/11 22:29");
    expect(historico).toContain("seg 23/11 12:25");
    expect(historico).not.toMatch(/\d{12,}/); // nenhum epoch em ms no histórico
  });

  test("o carimbo usa o fuso do agente quando difere do da org (Manaus)", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, { agentTimezone: "America/Manaus" });

    const { system, user } = await runGroupTurn(t, seed);
    const historico = historyOf(user);
    expect(historico).toContain("dom 22/11 21:29");
    expect(historico).toContain("seg 23/11 11:25");
    expect(historico).not.toContain("22:29");
    expect(historico).not.toMatch(/\d{12,}/);
    // O mesmo fuso do bloco DATA E HORA.
    expect(system).toContain("(fuso America/Manaus)");
  });

  test("notas da equipe levam a data em que foram escritas, no fuso do agente", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, {
      agentTimezone: "America/Manaus",
      teamNote: { text: "o encontro é amanhã às 10h", at: DOM_2229_SP },
    });

    const { system } = await runGroupTurn(t, seed);
    expect(system).toContain("- [dom 22/11 21:29] o encontro é amanhã às 10h");
  });
});

describe("agente de grupo: includeCurrentDateTime:false", () => {
  test("remove só o bloco: os carimbos por mensagem e as datas das notas continuam", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, {
      includeCurrentDateTime: false,
      teamNote: { text: "o encontro é amanhã às 10h", at: DOM_2229_SP },
    });

    const { system, user } = await runGroupTurn(t, seed);
    expect(system).not.toContain("DATA E HORA ATUAIS");
    expect(system).toContain("- [dom 22/11 22:29] o encontro é amanhã às 10h");
    const historico = historyOf(user);
    expect(historico).toContain("dom 22/11 22:29");
    expect(historico).not.toMatch(/\d{12,}/);
  });
});

describe("resumo de grupo: data legível e bloco DATA E HORA", () => {
  async function runSummary(t: TestConvex<typeof schema>, seed: Seed) {
    await memberMessage(t, seed, "amanhã às 10h tem a roda de conversa", DOM_2229_SP);
    await memberMessage(t, seed, "combinado, eu levo o café", NOW - 60_000);
    const fetchMock = stubLlm("Assuntos: roda de conversa em dom 22/11.");
    const result = await t.action(internal.groupAgent.internalGenerateSummary, {
      groupChatId: seed.groupChatId,
      hours: 24,
    });
    expect(result.error).toBeNull();
    const body = bodyOf(fetchMock);
    return { system: body.messages[0].content as string, user: body.messages[1].content as string };
  }

  test("o histórico do resumo leva o carimbo no fuso do agente, nunca epoch", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, { agentTimezone: "America/Manaus" });

    const { user } = await runSummary(t, seed);
    expect(user).toContain("dom 22/11 21:29");
    expect(user).not.toContain("22:29");
    expect(user).not.toMatch(/\d{12,}/);
  });

  test("o bloco DATA E HORA fecha o system prompt e há a regra de citar data real", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, { agentTimezone: "America/Manaus" });

    const { system } = await runSummary(t, seed);
    expect(system).toContain(
      "DATA E HORA ATUAIS: segunda-feira, 23/11/2026, 11:25 (fuso America/Manaus)."
    );
    expect(system.trimEnd().endsWith("Nunca chute a data nem invente o dia da semana.")).toBe(true);
    expect(system.indexOf("DATA E HORA ATUAIS")).toBeGreaterThan(system.indexOf("REGRAS:"));
    expect(system).toContain("use a data real");
  });

  test("includeCurrentDateTime:false remove o bloco do resumo (o carimbo por mensagem fica)", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, { includeCurrentDateTime: false });

    const { system, user } = await runSummary(t, seed);
    expect(system).not.toContain("DATA E HORA ATUAIS");
    expect(system).not.toContain("Próximos dias:");
    expect(user).toContain("dom 22/11 22:29");
  });
  test("sem atendente: usa o fuso da org, bloco ligado, sem run e sem exceção", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, { noAgent: true });

    const { system, user } = await runSummary(t, seed);
    expect(system).toContain(
      "DATA E HORA ATUAIS: segunda-feira, 23/11/2026, 12:25 (fuso America/Sao_Paulo)."
    );
    expect(user).toContain("dom 22/11 22:29");
    // Sem atendente não há dono para a run: nada é registrado (comportamento anterior).
    expect(await t.run(async (ctx) => ctx.db.query("agentRuns").collect())).toHaveLength(0);
  });

  test("escolhe o atendente pela MESMA regra do turno: o do canal da sala, não o primeiro da org", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedGroupOrg(t, {
      agentTimezone: "America/Manaus",
      otherChannelAgentTimezone: "Europe/Lisbon",
    });

    const { system, user } = await runSummary(t, seed);
    expect(system).toContain("(fuso America/Manaus)");
    expect(system).not.toContain("Europe/Lisbon");
    expect(user).toContain("dom 22/11 21:29");
    // A run pertence ao atendente da sala e o idioma também (não o "en" do outro canal).
    const runs = await t.run(async (ctx) => ctx.db.query("agentRuns").collect());
    expect(runs).toHaveLength(1);
    const owner = await t.run(async (ctx) => ctx.db.get(runs[0].memberId!));
    expect(owner).toMatchObject({ name: "Guia (IA)" });
    expect(system).toContain("pt-BR");
  });
});

describe("Copiloto no Telegram: contexto de ponta a ponta", () => {
  async function seedFocus(timezone: string) {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Org Telegram",
        slug: "org-telegram",
        settings: { timezone, currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId,
        channel: "whatsapp",
        status: "active",
        messageCount: 2,
        createdAt: now,
        updatedAt: now,
      });
      const msg = (content: string, createdAt: number) =>
        ctx.db.insert("messages", {
          organizationId, conversationId, direction: "inbound", senderType: "contact",
          content, contentType: "text", isInternal: false, createdAt,
        });
      await msg("mensagem muito antiga", NOW - 200 * 24 * 60 * 60 * 1000);
      await msg("amanhã às 10h está bom", DOM_2229_SP);
      return { organizationId, conversationId };
    });
    return { t, ...ids };
  }

  test("org em Manaus: 22:29 de São Paulo aparece como 21:29, sem ISO nem epoch", async () => {
    const { t, organizationId, conversationId } = await seedFocus("America/Manaus");
    const block = await t.query(internal.telegramCopilot.internalBuildFocusContext, {
      organizationId, conversationId, now: NOW,
    });
    expect(block).toContain("dom 22/11 21:29");
    expect(block).not.toContain("2026-11-23T");
    expect(block).not.toMatch(/\d{12,}/);
    // `now` do chamador: a mensagem de 200 dias atrás leva o ano.
    expect(block).toMatch(/\d{2}:\d{2} 2026/);
  });

  test("fuso inválido na org cai no padrão (São Paulo) sem lançar", async () => {
    const { t, organizationId, conversationId } = await seedFocus("Nao/Existe");
    const block = await t.query(internal.telegramCopilot.internalBuildFocusContext, {
      organizationId, conversationId, now: NOW,
    });
    expect(block).toContain("dom 22/11 22:29");
  });
});
