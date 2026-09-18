/// <reference types="vite/client" />
/**
 * Agente de IA em grupos (F4) — runtime.
 *
 * Quatro coisas que estes testes existem para impedir, em ordem de gravidade:
 *
 *  1. **A IA falando sem ser chamada.** Mensagem comum de membro não pode
 *     enfileirar turno. Num grupo de 200 pessoas isso é o CRM respondendo a
 *     tudo na frente de clientes.
 *  2. **A IA respondendo com o gate fechado.** Cada aceite (grupos no número,
 *     IA no bridge, interruptor da org) é re-checado no COMMIT, não só no
 *     enqueue: desligar durante a geração tem de abortar o envio.
 *  3. **Tool de lead dentro de um grupo.** A conversa não tem lead; o registry
 *     do grupo tem três tools e nada mais.
 *  4. **Autopilot sem o gate vencido.** A política do grupo não é atalho para
 *     publicar sem revisão humana.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";
const MEMBER_LID = "180002129735765@lid";
const MEMBER_PHONE = "558181392929";
const GROUP_JID = "120363431849092219@g.us";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}

type SeedOpts = {
  groupAgentEnabled?: boolean;
  bridgeAiAck?: boolean;
  bridgeGroupsAck?: boolean;
  bridgeGroupsEnabled?: boolean;
  monitored?: boolean;
  aiMode?: "off" | "mention";
  replyMode?: "inherit" | "suggest" | "autopilot";
  attendantMode?: "suggest" | "autopilot";
  autopilotEarlyAck?: boolean;
  /** Aceite PRÓPRIO do autopilot em grupo (review de segurança nº 5). */
  groupAutopilotAck?: boolean;
  maxPerHour?: number;
  maxPerDay?: number;
  keywords?: string[];
  opportunityRadar?: boolean;
  /** Carimbo de data/hora do prompt (ausente = ligado, como em produção). */
  includeCurrentDateTime?: boolean;
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
          ...(opts.groupAgentEnabled !== false ? { groupAgentEnabled: true } : {}),
          ...(opts.bridgeAiAck !== false
            ? { bridgeAiAck: { acceptedAt: now, acceptedBy: adminId } }
            : {}),
          ...(opts.groupAutopilotAck
            ? { groupAutopilotAck: { acceptedAt: now, acceptedBy: adminId } }
            : {}),
        },
      },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Guardião (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: {
        kind: "attendant",
        mode: opts.attendantMode ?? "suggest",
        systemPrompt: "Você é o Guardião, atendente da loja.",
        knowledge: "Entregamos às terças.",
        ...(opts.autopilotEarlyAck
          ? { autopilotEarlyAck: { acceptedAt: now, acceptedBy: adminId } }
          : {}),
        ...(opts.includeCurrentDateTime !== undefined
          ? { includeCurrentDateTime: opts.includeCurrentDateTime }
          : {}),
      },
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge",
      displayName: "Número bridge", status: "active",
      bridgeBaseUrl: "https://wuzapi.example.com",
      bridgeInstanceId: "inst_1",
      bridgeLid: OUR_LID,
      bridgePhone: OUR_PHONE,
      ...(opts.bridgeGroupsEnabled !== false ? { bridgeGroupsEnabled: true } : {}),
      ...(opts.bridgeGroupsAck !== false
        ? { bridgeGroupsAck: { acceptedAt: now, acceptedBy: adminId } }
        : {}),
      createdAt: now, updatedAt: now,
    });
    const groupChatId = await ctx.db.insert("groupChats", {
      organizationId,
      channelConfigId: configId,
      jid: GROUP_JID,
      subject: "Grupo-Teste-Eric",
      monitored: opts.monitored !== false,
      participantsCount: 2,
      participants: [
        { lid: OUR_LID, phone: OUR_PHONE, name: "Cláudio", isAdmin: false, isSuperAdmin: false },
        { lid: MEMBER_LID, phone: MEMBER_PHONE, name: "Eric", isAdmin: true, isSuperAdmin: true },
      ],
      ai: {
        mode: opts.aiMode ?? "mention",
        replyMode: opts.replyMode ?? "inherit",
        ...(opts.maxPerHour !== undefined ? { maxPerHour: opts.maxPerHour } : {}),
        ...(opts.maxPerDay !== undefined ? { maxPerDay: opts.maxPerDay } : {}),
        ...(opts.keywords ? { keywords: opts.keywords } : {}),
        ...(opts.opportunityRadar ? { opportunityRadar: true } : {}),
      },
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
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(groupChatId, { conversationId });
    return { organizationId, adminUserId, adminId, agentId, configId, groupChatId, conversationId };
  });
}

type Seed = Awaited<ReturnType<typeof seedGroupOrg>>;

/** Insere uma mensagem de membro na sala e devolve o id (sem passar pelo ingest). */
async function memberMessage(
  t: TestConvex<typeof schema>,
  seed: Seed,
  args: {
    content: string;
    mentions?: string[];
    quotedParticipantJid?: string;
    name?: string;
  }
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      direction: "inbound",
      senderType: "contact",
      senderLid: MEMBER_LID,
      senderPhone: MEMBER_PHONE,
      senderName: args.name ?? "Eric",
      content: args.content,
      contentType: "text",
      isInternal: false,
      ...(args.mentions ? { mentions: args.mentions } : {}),
      ...(args.quotedParticipantJid
        ? { quotedParticipantJid: args.quotedParticipantJid }
        : {}),
      createdAt: Date.now(),
    })
  );
}

async function queueItems(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect());
}

/**
 * O enqueue marca `nextAttemptAt = agora + debounce` (5 s) e o claim DEFERE
 * enquanto esse slot não chega. Nos testes rodamos a action explicitamente (sem
 * o scheduler de fundo), então o slot é adiantado à mão — é a janela de
 * agrupamento, não o comportamento sob teste.
 */
async function releaseDebounce(t: TestConvex<typeof schema>, itemId: Id<"aiReplyQueue">) {
  await t.run(async (ctx) => {
    await ctx.db.patch(itemId, { nextAttemptAt: 0 });
  });
}

async function messagesOf(t: TestConvex<typeof schema>, seed: Seed) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) =>
        q.eq("conversationId", seed.conversationId)
      )
      .collect()
  );
}

/**
 * Stub do LLM. `toolCalls` presente = a resposta vem com tool_calls; senão vem
 * texto puro. Devolve o mock para inspecionar o body (prompt e tools).
 */
function stubLlm(
  responses: { content?: string; toolCalls?: { name: string; args: unknown }[] }[]
) {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: r.content ?? null,
              ...(r.toolCalls
                ? {
                    tool_calls: r.toolCalls.map((tc, i) => ({
                      id: `call_${i}`,
                      type: "function",
                      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                    })),
                  }
                : {}),
            },
            finish_reason: r.toolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const init = fetchMock.mock.calls[call]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}");
}

// ─────────────────────────────────────────────────────────────────────────────

describe("gatilho e fila", () => {
  test("menção a nós enfileira um turno com origin group_mention", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const messageId = await memberMessage(t, seed, {
      content: "@Cláudio qual o horário de sábado?",
      mentions: [OUR_LID],
    });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });

    const items = await queueItems(t);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      origin: "group_mention",
      status: "pending",
      conversationId: seed.conversationId,
      agentMemberId: seed.agentId,
    });
  });

  test("responder a uma mensagem nossa enfileira", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const messageId = await memberMessage(t, seed, {
      content: "e no domingo?",
      quotedParticipantJid: OUR_LID,
    });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    expect(await queueItems(t)).toHaveLength(1);
  });

  test("nosso número digitado no texto enfileira", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const messageId = await memberMessage(t, seed, { content: `@${OUR_PHONE} tem aula hoje?` });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    expect(await queueItems(t)).toHaveLength(1);
  });

  test("mensagem comum de membro NÃO enfileira nada — nem item de skip", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const messageId = await memberMessage(t, seed, { content: "bom dia pessoal" });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    expect(await queueItems(t)).toHaveLength(0);
  });

  test("palavra-chave do grupo enfileira; sem ela configurada, não", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { keywords: ["orçamento"] });
    const hit = await memberMessage(t, seed, { content: "queria um ORCAMENTO de 3 cestas" });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId: hit });
    expect(await queueItems(t)).toHaveLength(1);

    const t2 = setup();
    const seed2 = await seedGroupOrg(t2);
    const miss = await memberMessage(t2, seed2, { content: "queria um orçamento de 3 cestas" });
    await t2.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId: miss });
    expect(await queueItems(t2)).toHaveLength(0);
  });

  test("duas menções na rajada viram UM item (coalescing)", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const first = await memberMessage(t, seed, { content: "@nós oi", mentions: [OUR_LID] });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId: first });
    const second = await memberMessage(t, seed, { content: "@nós ainda aí?", mentions: [OUR_LID] });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId: second });

    const items = await queueItems(t);
    expect(items).toHaveLength(1);
    expect(items[0].triggerMessageId).toEqual(second);
  });

  test("mensagem do próprio aparelho (outbound) nunca dispara a IA", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const messageId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        direction: "outbound",
        senderType: "human",
        content: `@${OUR_PHONE} teste`,
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      })
    );
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    expect(await queueItems(t)).toHaveLength(0);
  });
});

describe("elegibilidade no enqueue (deixa rastro, não silêncio)", () => {
  test("IA de grupos desligada na org é no-op SILENCIOSO (nem item de skip)", async () => {
    // Mesma regra do atendente 1:1 com `orgAiActive` falso: o produto inteiro
    // está desligado, então não há "espera" a explicar para ninguém — e escrever
    // uma linha por menção numa org que não usa IA é custo puro.
    const t = setup();
    const seed = await seedGroupOrg(t, { groupAgentEnabled: false });
    const messageId = await memberMessage(t, seed, { content: "@nós oi", mentions: [OUR_LID] });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    expect(await queueItems(t)).toHaveLength(0);
  });

  test.each([
    ["grupos_sem_aceite", { bridgeGroupsAck: false } as SeedOpts],
    ["grupos_desligados_no_numero", { bridgeGroupsEnabled: false } as SeedOpts],
    ["bridge_sem_aceite", { bridgeAiAck: false } as SeedOpts],
  ])("chamar a IA com %s grava item skipped com o motivo", async (reason, opts) => {
    const t = setup();
    const seed = await seedGroupOrg(t, opts);
    const messageId = await memberMessage(t, seed, { content: "@nós oi", mentions: [OUR_LID] });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });

    const items = await queueItems(t);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "skipped", error: reason });
  });

  test("teto por hora do grupo bloqueia o turno", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { maxPerHour: 1 });
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        direction: "outbound",
        senderType: "ai",
        senderId: seed.agentId,
        content: "já respondi uma vez",
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      });
    });
    const messageId = await memberMessage(t, seed, { content: "@nós de novo", mentions: [OUR_LID] });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });

    const items = await queueItems(t);
    expect(items[0]).toMatchObject({ status: "skipped", error: "teto_hora" });
  });

  test("repasse pendente na conversa segura a IA", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("handoffs", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        fromMemberId: seed.agentId,
        reason: "Cliente irritado",
        suggestedActions: [],
        status: "pending",
        createdAt: Date.now(),
      });
    });
    const messageId = await memberMessage(t, seed, { content: "@nós oi", mentions: [OUR_LID] });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    expect((await queueItems(t))[0]).toMatchObject({ error: "handoff_pendente" });
  });
});

describe("turno: prompt, tools e commit", () => {
  async function runTurn(t: TestConvex<typeof schema>, seed: Seed) {
    const messageId = await memberMessage(t, seed, {
      content: "@Cláudio qual o horário de sábado?",
      mentions: [OUR_LID],
    });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    const item = (await queueItems(t))[0];
    await releaseDebounce(t, item._id);
    return item;
  }

  test("modo sugestão cria RASCUNHO (nada sai para o grupo) e notifica quem revisa", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { replyMode: "suggest" });
    const item = await runTurn(t, seed);
    stubLlm([{ toolCalls: [{ name: "replyToGroup", args: { text: "Sábado abrimos das 9h às 13h!" } }] }]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    const msgs = await messagesOf(t, seed);
    const draft = msgs.find((m) => m.isInternal && m.metadata?.aiDraft);
    expect(draft).toBeTruthy();
    expect(draft!.content).toBe("Sábado abrimos das 9h às 13h!");
    expect((draft!.metadata!.aiDraft as { status: string }).status).toBe("pending");
    // NENHUM outbound: o grupo não recebeu nada.
    expect(msgs.filter((m) => m.direction === "outbound")).toHaveLength(0);

    const notifications = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(notifications.some((n) => n.type === "ai_draft_pending")).toBe(true);
  });

  test("o prompt é o do GRUPO e as tools são só as três (nenhuma de lead)", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const item = await runTurn(t, seed);
    const fetchMock = stubLlm([{ content: "ok" }]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    const body = bodyOf(fetchMock);
    const system = body.messages[0].content as string;
    expect(system).toContain("VOCÊ ESTÁ NUM GRUPO");
    expect(system).toContain("Você é o Guardião");
    const toolNames = (body.tools ?? []).map((x: { function: { name: string } }) => x.function.name);
    expect(toolNames).toEqual(["replyToGroup", "requestGroupHandoff"]);
    expect(toolNames).not.toContain("moveThisLead");
    expect(toolNames).not.toContain("updateThisContact");
    expect(toolNames).not.toContain("replyToCustomer");
    // O histórico viaja no envelope não-confiável, com quem falou.
    const user = body.messages[1].content as string;
    expect(user).toContain('<crm_data untrusted="true">');
    expect(user).toContain("membro:Eric");
  });

  test("o carimbo de data/hora chega ao prompt do grupo, e some com a flag off", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const item = await runTurn(t, seed);
    const fetchMock = stubLlm([{ content: "ok" }]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });
    const system = bodyOf(fetchMock).messages[0].content as string;
    expect(system).toContain("DATA E HORA ATUAIS");
    expect(system).toContain("(fuso America/Sao_Paulo)");
    expect(system).toContain("Próximos dias:");

    // A MESMA flag do perfil do atendente 1:1 governa a sala.
    const t2 = setup();
    const seed2 = await seedGroupOrg(t2, { includeCurrentDateTime: false });
    const item2 = await runTurn(t2, seed2);
    const fetchMock2 = stubLlm([{ content: "ok" }]);
    await t2.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item2._id });
    expect(bodyOf(fetchMock2).messages[0].content as string).not.toContain("DATA E HORA ATUAIS");
  });

  test("flagOpportunity só existe com o radar ligado", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { opportunityRadar: true });
    const item = await runTurn(t, seed);
    const fetchMock = stubLlm([{ content: "ok" }]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });
    const toolNames = (bodyOf(fetchMock).tools ?? []).map(
      (x: { function: { name: string } }) => x.function.name
    );
    expect(toolNames).toContain("flagOpportunity");
  });

  test("texto puro SEM tool não publica nada no grupo", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const item = await runTurn(t, seed);
    stubLlm([{ content: "acho que não é comigo" }]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    const msgs = await messagesOf(t, seed);
    expect(msgs.filter((m) => m.direction !== "inbound")).toHaveLength(0);
    const items = await queueItems(t);
    expect(items[0]).toMatchObject({ status: "skipped", error: "sem_resposta" });
  });

  test("tool de lead pedida pelo modelo é RECUSADA pelo executor", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const item = await runTurn(t, seed);
    const fetchMock = stubLlm([
      { toolCalls: [{ name: "moveThisLead", args: { stageName: "Ganhou" } }] },
      { content: "" },
    ]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    // A 2ª chamada carrega o resultado da tool: recusa explícita.
    const second = bodyOf(fetchMock, 1);
    const toolResult = second.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolResult.content).toContain("Ferramenta indisponível neste grupo");
    // E nenhum lead foi tocado (não existe lead nesta conversa).
    const leads = await t.run(async (ctx) => ctx.db.query("leads").collect());
    expect(leads).toHaveLength(0);
  });

  test("autopilot publica no grupo quando o atendente já está em autopilot", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { replyMode: "autopilot", attendantMode: "autopilot" });
    const item = await runTurn(t, seed);
    stubLlm([
      {
        toolCalls: [
          { name: "replyToGroup", args: { text: "Sábado das 9h às 13h!", mentionKeys: [MEMBER_LID] } },
        ],
      },
    ]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    const outbound = (await messagesOf(t, seed)).filter(
      (m) => m.direction === "outbound" && !m.isInternal
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0].senderType).toBe("ai");
    // A menção resolvida entra na linha — é o que faz o WhatsApp notificar.
    expect(outbound[0].mentions).toEqual([MEMBER_LID]);
  });

  test("autopilot SEM o gate vencido cai para sugestão", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { replyMode: "autopilot", attendantMode: "suggest" });
    const item = await runTurn(t, seed);
    stubLlm([{ toolCalls: [{ name: "replyToGroup", args: { text: "Sábado das 9h às 13h!" } }] }]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    const msgs = await messagesOf(t, seed);
    expect(msgs.filter((m) => m.direction === "outbound" && !m.isInternal)).toHaveLength(0);
    expect(msgs.some((m) => m.isInternal && m.metadata?.aiDraft)).toBe(true);
  });

  test("autopilotEarlyAck do atendente 1 a 1 NÃO libera o grupo", async () => {
    // Review de segurança nº 5: aquele aceite foi assinado para a IA responder
    // sozinha a UMA pessoa que escreveu para a empresa. Publicar sem revisão
    // numa sala de terceiros é risco maior e pede aceite próprio.
    const t = setup();
    const seed = await seedGroupOrg(t, {
      replyMode: "autopilot",
      attendantMode: "suggest",
      autopilotEarlyAck: true,
    });
    const item = await runTurn(t, seed);
    stubLlm([{ toolCalls: [{ name: "replyToGroup", args: { text: "Sábado das 9h!" } }] }]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });
    const msgs = await messagesOf(t, seed);
    expect(msgs.filter((m) => m.direction === "outbound" && !m.isInternal)).toHaveLength(0);
    expect(msgs.some((m) => m.isInternal && m.metadata?.aiDraft)).toBe(true);
  });

  test("autopilot com o aceite PRÓPRIO de grupo publica", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, {
      replyMode: "autopilot",
      attendantMode: "suggest",
      groupAutopilotAck: true,
    });
    const item = await runTurn(t, seed);
    stubLlm([{ toolCalls: [{ name: "replyToGroup", args: { text: "Sábado das 9h!" } }] }]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });
    expect(
      (await messagesOf(t, seed)).filter((m) => m.direction === "outbound" && !m.isInternal)
    ).toHaveLength(1);
  });

  test("commit aborta quando um humano respondeu no grupo durante a geração", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { replyMode: "autopilot", attendantMode: "autopilot" });
    const item = await runTurn(t, seed);
    stubLlm([{ toolCalls: [{ name: "replyToGroup", args: { text: "resposta da IA" } }] }]);

    // O humano responde DEPOIS do início da run: o carimbo do outbound humano é
    // posterior ao `runStartedAt` que o claim registrou.
    const original = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => original() + 60_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        direction: "outbound",
        senderType: "human",
        senderId: seed.adminId,
        content: "eu respondo",
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      });
    });
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });
    vi.restoreAllMocks();

    const aiOutbound = (await messagesOf(t, seed)).filter((m) => m.senderType === "ai");
    expect(aiOutbound).toHaveLength(0);
    expect((await queueItems(t))[0]).toMatchObject({ error: "humano_respondeu" });
  });

  test("commit aborta se a IA de grupos for desligada durante a geração", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { replyMode: "autopilot", attendantMode: "autopilot" });
    const item = await runTurn(t, seed);
    stubLlm([{ toolCalls: [{ name: "replyToGroup", args: { text: "resposta" } }] }]);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(seed.organizationId))!;
      await ctx.db.patch(seed.organizationId, {
        settings: {
          ...org.settings,
          aiConfig: { ...org.settings.aiConfig!, groupAgentEnabled: false },
        },
      });
    });
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    expect((await messagesOf(t, seed)).filter((m) => m.senderType === "ai")).toHaveLength(0);
  });

  test("a run fica em agentRuns com kind group_reply e SEM conteúdo da conversa", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const item = await runTurn(t, seed);
    stubLlm([{ toolCalls: [{ name: "replyToGroup", args: { text: "Sábado das 9h!" } }] }]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    const runs = await t.run(async (ctx) => ctx.db.query("agentRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: "group_reply",
      status: "done",
      conversationId: seed.conversationId,
    });
    expect(runs[0].leadId).toBeUndefined();
    expect(runs[0].toolCallNames).toEqual(["replyToGroup"]);
    // Nada de transcrição/PII: o texto da resposta não está na run.
    expect(JSON.stringify(runs[0])).not.toContain("Sábado");
  });
});

describe("tools do grupo", () => {
  test("requestGroupHandoff cria repasse SEM lead e notifica o time", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const messageId = await memberMessage(t, seed, {
      content: "@nós isso é um absurdo, vou processar",
      mentions: [OUR_LID],
    });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    const item = (await queueItems(t))[0];
    await releaseDebounce(t, item._id);
    stubLlm([
      {
        toolCalls: [
          { name: "requestGroupHandoff", args: { reason: "Ameaça de ação judicial", summary: "Cliente irritado" } },
          { name: "replyToGroup", args: { text: "Já chamei alguém do time aqui." } },
        ],
      },
    ]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    const handoffs = await t.run(async (ctx) => ctx.db.query("handoffs").collect());
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].leadId).toBeUndefined();
    expect(handoffs[0].conversationId).toEqual(seed.conversationId);
    expect(handoffs[0].reason).toBe("Ameaça de ação judicial");

    const notifications = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(notifications.some((n) => n.type === "handoff_requested")).toBe(true);
  });

  test("dois repasses seguidos na mesma sala viram UM (sem handoffState para segurar)", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.groupAgent.internalCreateGroupHandoff, {
        organizationId: seed.organizationId,
        groupChatId: seed.groupChatId,
        conversationId: seed.conversationId,
        agentMemberId: seed.agentId,
        reason: "Assunto sensível",
      });
    }
    expect(await t.run(async (ctx) => ctx.db.query("handoffs").collect())).toHaveLength(1);
  });

  test("flagOpportunity notifica com a chave do membro e o rascunho de DM", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { opportunityRadar: true });
    const result = await t.mutation(internal.groupAgent.internalFlagOpportunity, {
      organizationId: seed.organizationId,
      groupChatId: seed.groupChatId,
      conversationId: seed.conversationId,
      agentMemberId: seed.agentId,
      participantKey: MEMBER_LID,
      summary: "quer orçamento de 3 cestas",
      tipo: "orcamento",
    });
    expect(result).toBe("notificado");

    const notifications = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    const opp = notifications.find((n) => n.type === "group_opportunity");
    expect(opp).toBeTruthy();
    expect(opp!.groupChatId).toEqual(seed.groupChatId);
    expect(opp!.data).toMatchObject({ participantKey: MEMBER_LID, hasPhone: true });
    expect(String(opp!.data!.suggestedDm)).toContain("Eric");
    // A IA NÃO manda DM: nenhuma mensagem nova em lugar nenhum.
    const all = await t.run(async (ctx) => ctx.db.query("messages").collect());
    expect(all).toHaveLength(0);
  });

  test("flagOpportunity com chave desconhecida é ignorada (não inventa membro)", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { opportunityRadar: true });
    const result = await t.mutation(internal.groupAgent.internalFlagOpportunity, {
      organizationId: seed.organizationId,
      groupChatId: seed.groupChatId,
      conversationId: seed.conversationId,
      agentMemberId: seed.agentId,
      participantKey: "999@lid",
      summary: "?",
    });
    expect(result).toBe("ignorado");
    expect(await t.run(async (ctx) => ctx.db.query("notifications").collect())).toHaveLength(0);
  });
});

describe("aceitar o rascunho do grupo", () => {
  test("aprovar envia com as menções que a IA escolheu", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { replyMode: "suggest" });
    const messageId = await memberMessage(t, seed, { content: "@nós oi", mentions: [OUR_LID] });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    const item = (await queueItems(t))[0];
    await releaseDebounce(t, item._id);
    stubLlm([
      {
        toolCalls: [
          { name: "replyToGroup", args: { text: "@Eric já respondo!", mentionKeys: [MEMBER_LID] } },
        ],
      },
    ]);
    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });

    const draft = (await messagesOf(t, seed)).find((m) => m.isInternal && m.metadata?.aiDraft)!;
    expect(draft.mentions).toEqual([MEMBER_LID]);

    const asAdmin = t.withIdentity({ subject: `${seed.adminUserId}|s1` });
    const sentId = await asAdmin.mutation(api.attendant.acceptAiDraft, {
      draftMessageId: draft._id,
    });
    const sent = await t.run(async (ctx) => ctx.db.get(sentId));
    expect(sent!.direction).toBe("outbound");
    expect(sent!.mentions).toEqual([MEMBER_LID]);
    expect(sent!.leadId).toBeUndefined();
  });
});

describe("resumo por IA (§9.2)", () => {
  test("gera, grava em groupChats.summary e registra a run", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    await memberMessage(t, seed, { content: "alguém sabe o horário de sábado?" });
    await memberMessage(t, seed, { content: "acho que 9h", name: "Maria" });
    stubLlm([{ content: "Assuntos: horário de sábado.\nPerguntas sem resposta: nenhuma." }]);

    const asAdmin = t.withIdentity({ subject: `${seed.adminUserId}|s1` });
    const result = await asAdmin.action(api.groupChats.summarizeGroup, {
      groupChatId: seed.groupChatId,
      hours: 24,
    });
    expect(result.error).toBeNull();
    expect(result.text).toContain("horário de sábado");

    const group = await t.run(async (ctx) => ctx.db.get(seed.groupChatId));
    expect(group!.summary!.hours).toBe(24);
    const runs = await t.run(async (ctx) => ctx.db.query("agentRuns").collect());
    expect(runs[0].kind).toBe("group_summary");
  });

  test("com a IA de grupos desligada, o resumo é recusado", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { groupAgentEnabled: false });
    const asAdmin = t.withIdentity({ subject: `${seed.adminUserId}|s1` });
    await expect(
      asAdmin.action(api.groupChats.summarizeGroup, { groupChatId: seed.groupChatId })
    ).rejects.toThrow(/IA em grupos/i);
  });

  test("sem mensagens no período devolve erro em vez de inventar resumo", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    const fetchMock = stubLlm([{ content: "nada" }]);
    const asAdmin = t.withIdentity({ subject: `${seed.adminUserId}|s1` });
    const result = await asAdmin.action(api.groupChats.summarizeGroup, {
      groupChatId: seed.groupChatId,
    });
    expect(result.error).toBe("sem_mensagens_no_periodo");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("radar de oportunidade (§9.3)", () => {
  test("coalescing: duas mensagens na janela agendam UM lote", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { opportunityRadar: true });
    await t.mutation(internal.groupAgent.internalScheduleRadar, { groupChatId: seed.groupChatId });
    const after = await t.run(async (ctx) => ctx.db.get(seed.groupChatId));
    const firstSchedule = after!.radar!.scheduledFor;
    expect(firstSchedule).toBeGreaterThan(Date.now());

    await t.mutation(internal.groupAgent.internalScheduleRadar, { groupChatId: seed.groupChatId });
    const again = await t.run(async (ctx) => ctx.db.get(seed.groupChatId));
    expect(again!.radar!.scheduledFor).toBe(firstSchedule);
  });

  test("radar desligado não agenda nada", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    await t.mutation(internal.groupAgent.internalScheduleRadar, { groupChatId: seed.groupChatId });
    const group = await t.run(async (ctx) => ctx.db.get(seed.groupChatId));
    expect(group!.radar).toBeUndefined();
  });

  test("lote positivo vira notificação de oportunidade; o negativo não vira nada", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t, { opportunityRadar: true });
    const wanted = await memberMessage(t, seed, {
      content: "vocês fazem orçamento para 50 cestas de natal?",
    });
    await memberMessage(t, seed, { content: "bom dia a todos, tenham uma boa semana" });
    stubLlm([
      {
        content: JSON.stringify({
          itens: [
            { id: wanted, oportunidade: true, tipo: "orcamento", resumo: "50 cestas de natal" },
          ],
        }),
      },
    ]);
    await t.action(internal.groupAgent.internalRadar, { groupChatId: seed.groupChatId });

    const notifications = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    const opp = notifications.filter((n) => n.type === "group_opportunity");
    expect(opp).toHaveLength(1);
    expect(opp[0].body).toContain("50 cestas");

    const runs = await t.run(async (ctx) => ctx.db.query("agentRuns").collect());
    expect(runs[0].kind).toBe("group_radar");
    // O coalescing é liberado no fim, senão o radar do grupo congelaria.
    const group = await t.run(async (ctx) => ctx.db.get(seed.groupChatId));
    expect(group!.radar!.scheduledFor).toBeUndefined();
    expect(group!.radar!.lastRunAt).toBeGreaterThan(0);
  });
});

describe("fio do ingest até a fila (o ponto de extensão da F4)", () => {
  test("mensagem de grupo com menção entra no ingest e sai como turno na fila", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    await t.mutation(internal.conversations.internalReceiveGroupMessage, {
      organizationId: seed.organizationId,
      groupChatId: seed.groupChatId,
      channelConfigId: seed.configId,
      externalId: "WA_MSG_1",
      content: "@Cláudio tem aula amanhã?",
      mentions: [OUR_LID],
      senderLid: MEMBER_LID,
      senderPhone: MEMBER_PHONE,
      senderName: "Eric",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const items = await queueItems(t);
    expect(items).toHaveLength(1);
    expect(items[0].origin).toBe("group_mention");
  });

  test("mensagem comum no ingest não acorda a IA", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    await t.mutation(internal.conversations.internalReceiveGroupMessage, {
      organizationId: seed.organizationId,
      groupChatId: seed.groupChatId,
      channelConfigId: seed.configId,
      externalId: "WA_MSG_2",
      content: "bom dia pessoal",
      senderLid: MEMBER_LID,
      senderPhone: MEMBER_PHONE,
      senderName: "Eric",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await queueItems(t)).toHaveLength(0);
  });

  test("palavra de ALERTA notifica o time sem usar IA nenhuma", async () => {
    const t = setup();
    const seed = await seedGroupOrg(t);
    await t.run(async (ctx) => {
      const group = (await ctx.db.get(seed.groupChatId))!;
      await ctx.db.patch(seed.groupChatId, {
        ai: { ...group.ai!, alertKeywords: ["reclamação"] },
      });
    });
    await t.mutation(internal.conversations.internalReceiveGroupMessage, {
      organizationId: seed.organizationId,
      groupChatId: seed.groupChatId,
      channelConfigId: seed.configId,
      externalId: "WA_MSG_3",
      content: "quero registrar uma RECLAMACAO sobre o atendimento",
      senderLid: MEMBER_LID,
      senderPhone: MEMBER_PHONE,
      senderName: "Eric",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const notifications = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    const alert = notifications.find((n) => n.type === "group_mention");
    expect(alert).toBeTruthy();
    expect(alert!.title).toContain("reclamação");
    expect(alert!.groupChatId).toEqual(seed.groupChatId);
    // Alerta não é gatilho de IA: nenhum turno foi enfileirado.
    expect(await queueItems(t)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F8 — correções do review
// ─────────────────────────────────────────────────────────────────────────────

describe("F8 — tetos, repasse e menção perdida", () => {
  test("o teto por hora vale mesmo numa sala com mais de 300 mensagens/dia", async () => {
    // Review de correção nº 5: `countGroupAiReplies` lia em ordem ASCENDENTE,
    // então o `.take(300)` pegava as mensagens mais ANTIGAS das últimas 24 h.
    // Numa sala movimentada — qualquer grupo ativo — as respostas recentes da
    // IA ficavam fora da janela lida e o teto nunca disparava. Justamente onde
    // ele mais importa.
    const t = setup();
    const seed = await seedGroupOrg(t, { maxPerHour: 1 });
    const now = Date.now();
    await t.run(async (ctx) => {
      // 320 mensagens de membro, todas ANTES da resposta da IA.
      for (let i = 0; i < 320; i++) {
        await ctx.db.insert("messages", {
          organizationId: seed.organizationId,
          conversationId: seed.conversationId,
          direction: "inbound",
          senderType: "contact",
          content: `ruído ${i}`,
          contentType: "text",
          isInternal: false,
          createdAt: now - 60 * 60 * 1000 + i,
        });
      }
      await ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        direction: "outbound",
        senderType: "ai",
        senderId: seed.agentId,
        content: "já respondi uma vez",
        contentType: "text",
        isInternal: false,
        createdAt: now - 60_000,
      });
    });

    const messageId = await memberMessage(t, seed, { content: "@nós de novo", mentions: [OUR_LID] });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });

    const items = await queueItems(t);
    expect(items[0]).toMatchObject({ status: "skipped", error: "teto_hora" });
  });

  test("o repasse da sala segura a IA mesmo com mais de 100 pendentes na org", async () => {
    // Review de segurança nº 6: a guarda varria `by_organization_and_status`
    // com `.take(100)` em ordem ascendente — o repasse novo da sala ficava
    // fora da leitura e a IA voltava a responder numa conversa já escalada.
    const t = setup();
    const seed = await seedGroupOrg(t);
    await t.run(async (ctx) => {
      const base = Date.now() - 10 * 60 * 60 * 1000;
      const otherConversation = await ctx.db.insert("conversations", {
        organizationId: seed.organizationId,
        channel: "whatsapp",
        status: "active",
        messageCount: 0,
        createdAt: base,
        updatedAt: base,
      });
      for (let i = 0; i < 120; i++) {
        await ctx.db.insert("handoffs", {
          organizationId: seed.organizationId,
          conversationId: otherConversation,
          fromMemberId: seed.agentId,
          reason: `antigo ${i}`,
          suggestedActions: [],
          status: "pending",
          createdAt: base + i,
        });
      }
      // O repasse DESTA sala é o mais novo — ficava fora dos 100 primeiros.
      await ctx.db.insert("handoffs", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        fromMemberId: seed.agentId,
        reason: "precisa de humano",
        suggestedActions: [],
        status: "pending",
        createdAt: Date.now(),
      });
    });

    const messageId = await memberMessage(t, seed, { content: "@nós oi", mentions: [OUR_LID] });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });

    const items = await queueItems(t);
    expect(items[0]).toMatchObject({ status: "skipped", error: "handoff_pendente" });
  });

  test("menção que chega durante a geração é re-enfileirada", async () => {
    // Review de correção nº 15: o guard `if (processing) return null` veio do
    // atendente 1 a 1, mas a compensação do pós-commit não — a segunda pergunta
    // ficava sem resposta e sem nem rastro `skipped`.
    const t = setup();
    const seed = await seedGroupOrg(t, { replyMode: "suggest" });
    const item = await runTurnForMissed(t, seed);
    stubLlm([{ toolCalls: [{ name: "replyToGroup", args: { text: "Das 9h às 13h!" } }] }]);

    // Chega DURANTE a geração (createdAt posterior ao início da run).
    const missedId = await t.run(async (ctx) => {
      return await ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        direction: "inbound",
        senderType: "contact",
        senderLid: MEMBER_LID,
        senderName: "Eric",
        content: "@Cláudio e o prazo?",
        contentType: "text",
        isInternal: false,
        mentions: [OUR_LID],
        createdAt: Date.now() + 1_000,
      });
    });

    await t.action(internal.groupAgent.internalProcessGroupTurn, { queueItemId: item._id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Um item NOVO foi criado, apontando para a segunda menção.
    const items = await queueItems(t);
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.triggerMessageId === missedId)).toBe(true);
  });

  async function runTurnForMissed(t: TestConvex<typeof schema>, seed: Seed) {
    const messageId = await memberMessage(t, seed, {
      content: "@Cláudio qual o horário de sábado?",
      mentions: [OUR_LID],
    });
    await t.mutation(internal.groupAgent.internalEnqueueFromGroup, { messageId });
    const item = (await queueItems(t))[0];
    await releaseDebounce(t, item._id);
    return item;
  }

  test("aceitar o repasse da sala pausa por 24 h, não para sempre", async () => {
    // Review de correção nº 6: `acceptHandoffCore` gravava MAX_SAFE_INTEGER e
    // o agente da sala nunca mais respondia a uma menção — sem aviso e sem
    // nada na tela que desfizesse.
    const t = setup();
    const seed = await seedGroupOrg(t);
    const handoffId = await t.run(async (ctx) =>
      ctx.db.insert("handoffs", {
        organizationId: seed.organizationId,
        conversationId: seed.conversationId,
        subjectLabel: "Grupo-Teste-Eric",
        fromMemberId: seed.agentId,
        reason: "precisa de humano",
        suggestedActions: [],
        status: "pending",
        createdAt: Date.now(),
      })
    );
    const asAdmin = t.withIdentity({ subject: `${seed.adminUserId}|session1` });
    await asAdmin.mutation(api.handoffs.acceptHandoff, { handoffId });

    const conversation = await t.run(async (ctx) => ctx.db.get(seed.conversationId));
    const pausedFor = (conversation!.aiPausedUntil ?? 0) - Date.now();
    expect(pausedFor).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(pausedFor).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  test("o card do repasse de grupo carrega o nome da sala", async () => {
    // Review de correção nº 13: `subjectLabel` era usado só no audit e no
    // e-mail; o card de /app/repasses saía com título vazio.
    const t = setup();
    const seed = await seedGroupOrg(t);
    await t.mutation(internal.groupAgent.internalCreateGroupHandoff, {
      organizationId: seed.organizationId,
      groupChatId: seed.groupChatId,
      conversationId: seed.conversationId,
      agentMemberId: seed.agentId,
      reason: "cliente pediu humano",
    });

    const asAdmin = t.withIdentity({ subject: `${seed.adminUserId}|session1` });
    const rows = await asAdmin.query(api.handoffs.getHandoffs, {
      organizationId: seed.organizationId,
      status: "pending",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("Grupo-Teste-Eric");
    expect(rows[0].isGroup).toBe(true);
  });

  test("a notificação de oportunidade mascara o telefone do membro", async () => {
    // Review de segurança nº 12: o número inteiro de um terceiro ficava
    // persistido em `notifications`.
    const t = setup();
    const seed = await seedGroupOrg(t, { opportunityRadar: true });
    await t.run(async (ctx) => {
      const group = (await ctx.db.get(seed.groupChatId))!;
      await ctx.db.patch(seed.groupChatId, {
        participants: (group.participants ?? []).map((p) =>
          p.lid === MEMBER_LID ? { ...p, name: undefined, phone: MEMBER_PHONE } : p
        ),
      });
    });

    await t.mutation(internal.groupAgent.internalFlagOpportunity, {
      organizationId: seed.organizationId,
      groupChatId: seed.groupChatId,
      conversationId: seed.conversationId,
      agentMemberId: seed.agentId,
      participantKey: MEMBER_LID,
      summary: "quer comprar 10 unidades",
      tipo: "compra",
    });

    const notifications = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    const opportunity = notifications.find((n) => n.type === "group_opportunity")!;
    expect(opportunity.body).not.toContain(MEMBER_PHONE);
    expect(opportunity.body).toContain("••••");
  });
});
