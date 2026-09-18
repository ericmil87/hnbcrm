/// <reference types="vite/client" />
/**
 * DATA E HORA no prompt do atendente IA.
 *
 * Sem o bloco, o modelo não sabe que dia é hoje — chuta a data do treino e não
 * consegue aplicar regra do conhecimento que dependa de data ("R$67 até 06/10").
 * Prova que:
 *  - por DEFAULT (campo ausente no perfil) o bloco entra no system prompt do
 *    runtime, no FIM (o provider cacheia o prefixo — carimbo no topo o mataria);
 *  - `includeCurrentDateTime: false` remove o bloco por completo;
 *  - o fuso do horário de atendimento vence o da organização;
 *  - o simulador aceita `simulatedNow` ("e se hoje fosse 07/10?").
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

/** Sexta-feira, 18/09/2026, 14:32 em São Paulo (17:32 UTC). */
const SEXTA_1432_SP = Date.UTC(2026, 8, 18, 17, 32);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * Sai dos timers falsos (o `runAfter` agendado na mutation morre aqui, e a
 * action roda UMA vez, explícita, sem corrida com o scheduler de fundo) mas
 * CONGELA o relógio: o carimbo precisa de um "agora" conhecido, e `setTimeout`
 * precisa continuar real para a action terminar.
 */
function freezeClock(now: number) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}

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

type ProfilePatch = {
  includeCurrentDateTime?: boolean;
  schedule?: { timezone: string; startHour: number; endHour: number };
};

async function seedOrg(t: TestConvex<typeof schema>, profile?: ProfilePatch) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Relógio",
      slug: "org-relogio",
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
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } },
      },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest", ...profile },
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
      content: "Que dia é hoje mesmo?", contentType: "text",
      isInternal: false, createdAt: now,
    });
    return { organizationId, adminUserId, adminId, agentId, conversationId };
  });
}

const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) =>
  t.withIdentity({ subject: `${userId}|s1` });

type Seed = Awaited<ReturnType<typeof seedOrg>>;

/** Um turno real do atendente; devolve o system prompt que foi para o LLM. */
async function runOneTurn(t: TestConvex<typeof schema>, seed: Seed, now: number) {
  await asUser(t, seed.adminUserId).mutation(api.attendant.requestAiDraft, {
    conversationId: seed.conversationId,
  });
  const item = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect())[0]);
  freezeClock(now);
  const fetchMock = stubLlm("Hoje é sexta-feira, 18/09.");
  await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: item!._id });
  return systemPromptOf(fetchMock);
}

async function setupAt(now: number, profile?: ProfilePatch) {
  vi.setSystemTime(now);
  const t = convexTest(schema, modules);
  return { t, seed: await seedOrg(t, profile) };
}

describe("carimbo de data e hora no prompt do atendente", () => {
  test("entra por DEFAULT (campo ausente no perfil) e fica no FIM do prompt", async () => {
    const { t, seed } = await setupAt(SEXTA_1432_SP);

    const prompt = await runOneTurn(t, seed, SEXTA_1432_SP);
    expect(prompt).toContain(
      "DATA E HORA ATUAIS: sexta-feira, 18/09/2026, 14:32 (fuso America/Sao_Paulo)."
    );
    expect(prompt).toContain("Próximos dias: sáb 19/09,");
    // O bloco é a ÚNICA parte volátil: no fim, tudo antes dele continua sendo
    // prefixo cacheável para o provider.
    expect(prompt.indexOf("DATA E HORA ATUAIS")).toBeGreaterThan(
      prompt.indexOf("REGRAS OBRIGATÓRIAS")
    );
    expect(prompt.trimEnd().endsWith("Nunca chute a data nem invente o dia da semana.")).toBe(true);
  });

  test("includeCurrentDateTime:false remove o bloco", async () => {
    const { t, seed } = await setupAt(SEXTA_1432_SP, { includeCurrentDateTime: false });

    const prompt = await runOneTurn(t, seed, SEXTA_1432_SP);
    expect(prompt).not.toContain("DATA E HORA ATUAIS");
    expect(prompt).not.toContain("Próximos dias:");
    expect(prompt).toContain("REGRAS OBRIGATÓRIAS"); // o resto do prompt segue inteiro
  });

  test("o fuso do horário de atendimento vence o da organização", async () => {
    const { t, seed } = await setupAt(SEXTA_1432_SP, {
      schedule: { timezone: "Europe/Lisbon", startHour: 0, endHour: 24 },
    });

    const prompt = await runOneTurn(t, seed, SEXTA_1432_SP);
    expect(prompt).toContain("18/09/2026, 18:32 (fuso Europe/Lisbon)");
  });
});

describe("simulador", () => {
  test("simulatedNow substitui o agora — dá para testar o lote de 07/10", async () => {
    const { t, seed } = await setupAt(SEXTA_1432_SP);

    freezeClock(SEXTA_1432_SP);
    const fetchMock = stubLlm("Nesse dia o valor é R$ 97.");
    const result = await asUser(t, seed.adminUserId).action(api.attendant.simulateAttendant, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      transcript: [{ role: "customer" as const, content: "Quanto custa hoje?" }],
      simulatedNow: Date.UTC(2026, 9, 7, 13, 0), // quarta, 07/10, 10:00 em SP
    });
    expect(result.error).toBeNull();
    expect(systemPromptOf(fetchMock)).toContain(
      "DATA E HORA ATUAIS: quarta-feira, 07/10/2026, 10:00 (fuso America/Sao_Paulo)."
    );
  });

  test("simulatedNow impossível é ignorado em vez de estourar a action", async () => {
    // NaN e 1e20 fazem o Intl lançar RangeError ANTES do try da action: o
    // "Testar" mostraria um erro cru em vez de simular.
    for (const impossivel of [Number.NaN, 1e20, -1e20, Number.POSITIVE_INFINITY]) {
      const { t, seed } = await setupAt(SEXTA_1432_SP);
      freezeClock(SEXTA_1432_SP);
      const fetchMock = stubLlm("Bom dia!");
      const result = await asUser(t, seed.adminUserId).action(api.attendant.simulateAttendant, {
        organizationId: seed.organizationId,
        agentMemberId: seed.agentId,
        transcript: [{ role: "customer" as const, content: "Oi" }],
        simulatedNow: impossivel,
      });
      expect(result.error).toBeNull();
      // Caiu no relógio de verdade (congelado no teste), sem lançar.
      expect(systemPromptOf(fetchMock)).toContain("sexta-feira, 18/09/2026, 14:32");
    }
  });

  test("sem simulatedNow o simulador usa o relógio do servidor", async () => {
    const { t, seed } = await setupAt(SEXTA_1432_SP);

    freezeClock(SEXTA_1432_SP);
    const fetchMock = stubLlm("Bom dia!");
    await asUser(t, seed.adminUserId).action(api.attendant.simulateAttendant, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      transcript: [{ role: "customer" as const, content: "Oi" }],
    });
    expect(systemPromptOf(fetchMock)).toContain("sexta-feira, 18/09/2026, 14:32");
  });
});
