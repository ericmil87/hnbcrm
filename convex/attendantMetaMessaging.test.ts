/// <reference types="vite/client" />
/**
 * Meta Messaging F3: atendente de IA no Instagram e no Messenger.
 *
 * Prova que:
 *  - dentro da janela a IA responde nos dois canais (fila → claim → commit →
 *    mensagem outbound pela porta única), em TEXTO PURO (sem `*`/`_`);
 *  - fora da janela, ou dentro da margem de 15 min, a elegibilidade recusa com
 *    `janela_24h`; o anúncio do Messenger abre 7 dias (`windowOpenedByAdAt`);
 *  - inbound em standby (outro app controla a thread) → `outro_app_controla`;
 *  - conexão `reauth_required` ou módulo desligado → nem cria fila;
 *  - o commit transacional re-checa a janela (TOCTOU);
 *  - o repasse por palavra-chave continua no IG; curtida sozinha enfileira;
 *  - WhatsApp meta e bridge seguem iguais (formato `*x*`, janela, ack).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { CURATED_GOLDENS, goldenTransport } from "./agentEvals";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { aiWindowClosed, evaluateEligibility, formatReplyForTransport } from "./attendant";
import { personaForIndustry } from "./lib/agentPersonas";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PAGE_ID = "1000000000000001";
const IG_ID = "1000000000000003";
const PSID = "1000000000000002";
const IGSID = "1000000000000004";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T15:00:00Z"));
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Surface = "instagram" | "messenger";

async function seed(
  t: TestConvex<typeof schema>,
  opts: {
    module?: boolean;
    authState?: "ok" | "reauth_required";
    mode?: "suggest" | "autopilot";
    systemPrompt?: string;
  } = {}
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Casa Lumiar (teste)",
      slug: "casa-lumiar-teste",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        ...(opts.module === false ? {} : { modules: { metaMessaging: true } }),
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } },
      },
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Guia (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: {
        kind: "attendant",
        mode: opts.mode ?? "autopilot",
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const connectionId = await ctx.db.insert("metaConnections", {
      organizationId,
      authMethod: "facebook_login",
      tokenKind: "page",
      tokenEncrypted: "fake-ciphertext",
      tokenLast4: "oken",
      pageId: PAGE_ID,
      pageName: "Página",
      igAccountId: IG_ID,
      scopes: [],
      authState: opts.authState ?? "ok",
      connectedByMemberId: adminId,
      createdAt: now,
      updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "messenger",
      displayName: "Página",
      status: "active",
      metaConnectionId: connectionId,
      messengerPageId: PAGE_ID,
      createdAt: now,
      updatedAt: now,
    });
    const instagramId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "instagram",
      displayName: "@conta",
      status: "active",
      metaConnectionId: connectionId,
      instagramAccountId: IG_ID,
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    // Contato vindo de PSID/IGSID: SEM telefone.
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Marina", tags: [], createdAt: now, updatedAt: now,
    });
    for (const [channelConfigId, kind, externalId] of [
      [messengerId, "messenger", PSID],
      [instagramId, "instagram", IGSID],
    ] as const) {
      await ctx.db.insert("contactChannelIdentities", {
        organizationId, contactId, channelConfigId, kind, externalId, profileFetchedAt: now, createdAt: now,
      });
    }
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Marina", contactId, boardId, stageId, assignedTo: agentId,
      value: 0, currency: "BRL", priority: "medium", temperature: "warm", tags: [],
      customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conv = async (channel: Surface, configId: Id<"channelConfigs">) =>
      await ctx.db.insert("conversations", {
        organizationId, leadId, channel, channelConfigId: configId, channelProvider: channel,
        status: "active", lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
      });
    const conversations: Record<Surface, Id<"conversations">> = {
      instagram: await conv("instagram", instagramId),
      messenger: await conv("messenger", messengerId),
    };
    return { organizationId, userId, adminId, agentId, connectionId, messengerId, instagramId, contactId, leadId, conversations };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function inbound(
  t: TestConvex<typeof schema>,
  s: Seed,
  surface: Surface,
  content: string,
  metadata?: Record<string, unknown>
): Promise<Id<"messages">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(s.conversations[surface], { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: s.organizationId,
      conversationId: s.conversations[surface],
      leadId: s.leadId,
      direction: "inbound",
      senderType: "contact",
      content,
      contentType: "text",
      isInternal: false,
      ...(metadata ? { metadata } : {}),
      createdAt: now,
    });
  });
}

async function enqueue(t: TestConvex<typeof schema>, messageId: Id<"messages">) {
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
}

async function queueOf(t: TestConvex<typeof schema>, conversationId: Id<"conversations">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("aiReplyQueue").collect()).filter((i) => i.conversationId === conversationId)
  );
}

async function messagesOf(t: TestConvex<typeof schema>, conversationId: Id<"conversations">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversationId))
      .collect()
  );
}

function stubLlmReply(text: string) {
  const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) throw new Error(`fetch inesperado: ${url}`);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "replyToCustomer", arguments: JSON.stringify({ text }) } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function readyItem(t: TestConvex<typeof schema>, conversationId: Id<"conversations">) {
  const item = (await queueOf(t, conversationId)).find((i) => i.status === "pending");
  expect(item, "o inbound precisa ter enfileirado um item").toBeTruthy();
  await t.run(async (ctx) => ctx.db.patch(item!._id, { nextAttemptAt: Date.now() - 1_000 }));
  return item!._id;
}

async function scheduledNames(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((f) => f.state.kind === "pending")
      .map((f) => f.name)
  );
}

const MARKDOWN_REPLY = "**Oi, Marina!** Temos _sim_ o plano anual.\n* à vista\n* parcelado 😊";
const PLAIN_REPLY = "Oi, Marina! Temos sim o plano anual.\n- à vista\n- parcelado 😊";

describe("responde dentro da janela", () => {
  for (const surface of ["instagram", "messenger"] as const) {
    test(`${surface}: fila → commit → outbound pela porta, em texto puro`, async () => {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      await enqueue(t, await inbound(t, s, surface, "Oi! Vocês têm plano anual?"));
      const itemId = await readyItem(t, s.conversations[surface]);
      const fetchMock = stubLlmReply(MARKDOWN_REPLY);

      await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

      const outbound = (await messagesOf(t, s.conversations[surface])).filter((m) => m.direction === "outbound");
      expect(outbound).toHaveLength(1);
      expect(outbound[0]).toMatchObject({ senderType: "ai", isInternal: false });
      // A divulgação (texto humano) vem antes; a resposta da IA sai sem marcador.
      expect(outbound[0].content.endsWith(PLAIN_REPLY)).toBe(true);
      expect(outbound[0].content).not.toMatch(/[*_~]/);
      // Envio pela porta única → dispatcher da Meta.
      expect(await scheduledNames(t)).toContain("metaMessaging:internalDispatchMessage");
      const item = (await queueOf(t, s.conversations[surface])).find((i) => i._id === itemId)!;
      expect(item.status).toBe("done");
      // Persona padrão fala o nome do canal.
      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
      const label = surface === "instagram" ? "Instagram" : "Messenger";
      expect(body.messages[0].content).toContain(`no ${label}.`);
    });
  }
});

describe("janela da Meta com margem de 15 min (elegibilidade pura)", () => {
  const now = 1_800_000_000_000;
  const base = {
    org: {
      settings: {
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, lgpdAck: { acceptedAt: now, acceptedBy: "m1" } },
      },
    },
    agent: { _id: "agent1", status: "active", type: "ai", agentProfile: { kind: "attendant", mode: "autopilot" } },
    lead: null,
    contact: null,
    aiReplyCountConversation: 0,
    aiReplyCountLastHour: 0,
    now,
  } as unknown as Omit<Parameters<typeof evaluateEligibility>[0], "conversation" | "channelProvider">;
  const conv = (fields: Partial<Doc<"conversations">>) => fields as unknown as Doc<"conversations">;

  for (const surface of ["instagram", "messenger"] as const) {
    test(`${surface}: aberta, fechada e dentro da margem`, () => {
      const ok = evaluateEligibility({ ...base, channelProvider: surface, conversation: conv({ lastInboundAt: now - (DAY - 20 * MIN) }) });
      expect(ok).toEqual({ ok: true });
      const margem = evaluateEligibility({ ...base, channelProvider: surface, conversation: conv({ lastInboundAt: now - (DAY - 10 * MIN) }) });
      expect(margem).toEqual({ ok: false, reason: "janela_24h" });
      const fechada = evaluateEligibility({ ...base, channelProvider: surface, conversation: conv({ lastInboundAt: now - 25 * HOUR }) });
      expect(fechada).toEqual({ ok: false, reason: "janela_24h" });
      expect(evaluateEligibility({ ...base, channelProvider: surface, conversation: conv({}) })).toEqual({
        ok: false,
        reason: "janela_24h",
      });
    });
  }

  test("messenger: anúncio abre 7 dias (com a mesma margem)", () => {
    const viaAnuncio = conv({ lastInboundAt: now - 3 * DAY, windowOpenedByAdAt: now - 3 * DAY });
    expect(evaluateEligibility({ ...base, channelProvider: "messenger", conversation: viaAnuncio })).toEqual({ ok: true });
    const quaseFim = conv({ lastInboundAt: now - (7 * DAY - 10 * MIN), windowOpenedByAdAt: now - (7 * DAY - 10 * MIN) });
    expect(evaluateEligibility({ ...base, channelProvider: "messenger", conversation: quaseFim })).toEqual({
      ok: false,
      reason: "janela_24h",
    });
  });

  test("transporte null numa conversa Instagram/Messenger: janela FECHADA (fail-closed)", () => {
    const fresca = { lastInboundAt: now - MIN };
    expect(aiWindowClosed(null, { ...fresca, channel: "instagram" }, now)).toBe(true);
    expect(aiWindowClosed(null, { ...fresca, channel: "messenger" }, now)).toBe(true);
    // WhatsApp sem config resolvido continua na régua do oficial (aberta aqui).
    expect(aiWindowClosed(null, { ...fresca, channel: "whatsapp" }, now)).toBe(false);
    expect(
      evaluateEligibility({ ...base, channelProvider: null, conversation: conv({ ...fresca, channel: "instagram" }) })
    ).toEqual({ ok: false, reason: "janela_24h" });
  });

  test("WhatsApp oficial não ganha margem; bridge não tem janela", () => {
    const quase = conv({ lastInboundAt: now - (DAY - 10 * MIN) });
    expect(evaluateEligibility({ ...base, channelProvider: "meta", conversation: quase })).toEqual({ ok: true });
    expect(aiWindowClosed("bridge", {}, now)).toBe(false);
    expect(aiWindowClosed(null, { lastInboundAt: now - 25 * HOUR }, now)).toBe(true);
  });

  test("standby só conta no Instagram/Messenger e vem depois da janela", () => {
    const aberta = conv({ lastInboundAt: now - MIN });
    expect(
      evaluateEligibility({ ...base, channelProvider: "instagram", conversation: aberta, lastInboundStandby: true })
    ).toEqual({ ok: false, reason: "outro_app_controla" });
    expect(
      evaluateEligibility({ ...base, channelProvider: "meta", conversation: aberta, lastInboundStandby: true })
    ).toEqual({ ok: true });
    const fechada = conv({ lastInboundAt: now - 25 * HOUR });
    expect(
      evaluateEligibility({ ...base, channelProvider: "messenger", conversation: fechada, lastInboundStandby: true })
    ).toEqual({ ok: false, reason: "janela_24h" });
  });
});

describe("recusas no enqueue", () => {
  test("dentro da margem de 15 min: rastro janela_24h, sem inferência", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const messageId = await inbound(t, s, "instagram", "Oi");
    await t.run(async (ctx) => ctx.db.patch(s.conversations.instagram, { lastInboundAt: Date.now() - (DAY - 5 * MIN) }));
    await enqueue(t, messageId);
    const items = await queueOf(t, s.conversations.instagram);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "skipped", error: "janela_24h" });
  });

  test("standby: enfileira o rastro outro_app_controla e não responde", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await enqueue(t, await inbound(t, s, "messenger", "Oi, tudo bem?", { standby: true }));
    const items = await queueOf(t, s.conversations.messenger);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "skipped", error: "outro_app_controla" });
    expect((await messagesOf(t, s.conversations.messenger)).filter((m) => m.direction === "outbound")).toHaveLength(0);
  });

  test("inbound normal depois do standby libera de novo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await enqueue(t, await inbound(t, s, "instagram", "Oi", { standby: true }));
    vi.setSystemTime(Date.now() + 1_000);
    await enqueue(t, await inbound(t, s, "instagram", "Ainda tem vaga?"));
    const items = await queueOf(t, s.conversations.instagram);
    expect(items.map((i) => i.status).sort()).toEqual(["pending", "skipped"]);
  });

  test("conexão reauth_required: nem cria fila", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { authState: "reauth_required" });
    await enqueue(t, await inbound(t, s, "instagram", "Oi"));
    expect(await queueOf(t, s.conversations.instagram)).toHaveLength(0);
  });

  test("módulo metaMessaging desligado: nem cria fila", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { module: false });
    await enqueue(t, await inbound(t, s, "messenger", "Oi"));
    expect(await queueOf(t, s.conversations.messenger)).toHaveLength(0);
  });

  test("curtida sozinha enfileira (o atendente decide; não é erro)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await enqueue(t, await inbound(t, s, "instagram", "[curtiu]", { metaType: "like_heart" }));
    const items = await queueOf(t, s.conversations.instagram);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("pending");
  });

  test("repasse por palavra-chave continua funcionando no Instagram", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await enqueue(t, await inbound(t, s, "instagram", "quero falar com um atendente, por favor"));
    const handoffs = await t.run(async (ctx) => ctx.db.query("handoffs").collect());
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ origin: "ai_keyword", conversationId: s.conversations.instagram });
    expect(await queueOf(t, s.conversations.instagram)).toHaveLength(0);
  });
});

describe("commit re-checa a janela (TOCTOU)", () => {
  test("janela entra na margem entre o claim e o commit → nada sai", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await enqueue(t, await inbound(t, s, "instagram", "Quero comprar"));
    const [item] = await queueOf(t, s.conversations.instagram);
    vi.setSystemTime(Date.now() + 10_000);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-toctou",
    });
    expect(claim.kind).toBe("run");
    if (claim.kind !== "run") throw new Error("unreachable");
    expect(claim.context.transport).toBe("instagram");

    // A geração demorou: a janela chegou nos últimos 15 min.
    await t.run(async (ctx) =>
      ctx.db.patch(s.conversations.instagram, { lastInboundAt: Date.now() - (DAY - 5 * MIN) })
    );
    const commit = await t.mutation(internal.attendant.internalCommitAiReply, {
      queueItemId: item._id,
      conversationId: s.conversations.instagram,
      agentMemberId: s.agentId,
      runId: "run-toctou",
      agentRunId: claim.context.agentRunId,
      runStartedAt: claim.context.runStartedAt,
      text: "Olá! Posso ajudar?",
      needsDisclosure: false,
      disclosure: "",
      allowPendingHandoff: false,
    });
    expect(commit).toEqual({ committed: false, reason: "janela_24h" });
    expect((await messagesOf(t, s.conversations.instagram)).filter((m) => m.direction === "outbound")).toHaveLength(0);
  });

  test("standby chega entre o claim e o commit → outro_app_controla", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await enqueue(t, await inbound(t, s, "messenger", "Oi"));
    const [item] = await queueOf(t, s.conversations.messenger);
    vi.setSystemTime(Date.now() + 10_000);
    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-standby",
    });
    if (claim.kind !== "run") throw new Error("claim devia rodar");
    await inbound(t, s, "messenger", "outra coisa", { standby: true });
    const commit = await t.mutation(internal.attendant.internalCommitAiReply, {
      queueItemId: item._id,
      conversationId: s.conversations.messenger,
      agentMemberId: s.agentId,
      runId: "run-standby",
      agentRunId: claim.context.agentRunId,
      runStartedAt: claim.context.runStartedAt,
      text: "Olá!",
      needsDisclosure: false,
      disclosure: "",
      allowPendingHandoff: false,
    });
    expect(commit).toEqual({ committed: false, reason: "outro_app_controla" });
  });
});

describe("WhatsApp intacto", () => {
  async function seedWhatsapp(t: TestConvex<typeof schema>, provider: "meta" | "bridge") {
    const s = await seed(t);
    return await t.run(async (ctx) => {
      const now = Date.now();
      const org = (await ctx.db.get(s.organizationId))!;
      if (provider === "bridge") {
        await ctx.db.patch(s.organizationId, {
          settings: {
            ...org.settings,
            aiConfig: { ...org.settings.aiConfig!, bridgeAiAck: { acceptedAt: now, acceptedBy: s.adminId } },
          },
        });
      }
      const configId = await ctx.db.insert("channelConfigs", {
        organizationId: s.organizationId,
        channel: "whatsapp",
        provider,
        displayName: provider,
        ...(provider === "bridge"
          ? { bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: "inst1" }
          : { phoneNumberId: "555000111" }),
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: configId,
        status: "active", lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
      });
      const messageId = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId, leadId: s.leadId, direction: "inbound",
        senderType: "contact", content: "Oi", contentType: "text", isInternal: false, createdAt: now,
      });
      return { ...s, conversationId, messageId };
    });
  }

  test("meta: responde com a formatação do WhatsApp (*x*)", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWhatsapp(t, "meta");
    await enqueue(t, w.messageId);
    const itemId = await readyItem(t, w.conversationId);
    const fetchMock = stubLlmReply("O cupom é **PORTO50**!");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const outbound = (await messagesOf(t, w.conversationId)).filter((m) => m.direction === "outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound[0].content.endsWith("O cupom é *PORTO50*!")).toBe(true);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.messages[0].content).toContain("no WhatsApp.");
  });

  test("bridge com aceite: enfileira como antes; a saída é a do WhatsApp", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWhatsapp(t, "bridge");
    await enqueue(t, w.messageId);
    expect((await queueOf(t, w.conversationId)).map((i) => i.status)).toEqual(["pending"]);
    expect(formatReplyForTransport("**x** e _y_", "bridge")).toBe("*x* e _y_");
    expect(formatReplyForTransport("**x** e _y_", null)).toBe("*x* e _y_");
    expect(formatReplyForTransport("**x** e _y_", "instagram")).toBe("x e y");
  });
});

describe("persona de indústria e timeline", () => {
  const persona = personaForIndustry("geral").systemPrompt;

  test("persona de indústria ('no WhatsApp') + Instagram: prompt ganha a linha fixa do canal", async () => {
    expect(persona).toContain("no WhatsApp");
    const t = convexTest(schema, modules);
    const s = await seed(t, { systemPrompt: persona });
    await enqueue(t, await inbound(t, s, "instagram", "Oi"));
    const itemId = await readyItem(t, s.conversations.instagram);
    const fetchMock = stubLlmReply("Oi! Como posso ajudar?");
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const system = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).messages[0].content as string;
    expect(system).toContain(persona);
    expect(system).toContain("Canal desta conversa: Instagram.");

    // Timeline do lead fala o canal real.
    const activities = await t.run(async (ctx) => ctx.db.query("activities").collect());
    expect(activities.map((a) => a.content)).toContain("Resposta enviada pelo atendente IA via Instagram");
  });

  test("persona de indústria + WhatsApp: sem linha de canal", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { systemPrompt: persona });
    const asAdmin = t.withIdentity({ subject: `${s.userId}|s1` });
    for (const transport of [undefined, "meta", "messenger"] as const) {
      const fetchMock = stubLlmReply("Oi!");
      await asAdmin.action(api.attendant.simulateAttendant, {
        organizationId: s.organizationId,
        agentMemberId: s.agentId,
        transcript: [{ role: "customer", content: "Oi" }],
        ...(transport ? { transport } : {}),
      });
      const system = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).messages[0].content as string;
      if (transport === "messenger") expect(system).toContain("Canal desta conversa: Messenger.");
      else expect(system).not.toContain("Canal desta conversa");
    }
  });
});

describe("simulador e goldens", () => {
  test("simulateAttendant com transport instagram/messenger devolve texto puro; sem transport = WhatsApp", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.userId}|s1` });
    for (const [transport, expected] of [
      ["instagram", PLAIN_REPLY],
      ["messenger", PLAIN_REPLY],
      [undefined, "*Oi, Marina!* Temos _sim_ o plano anual.\n- à vista\n- parcelado 😊"],
      ["bridge", "*Oi, Marina!* Temos _sim_ o plano anual.\n- à vista\n- parcelado 😊"],
    ] as const) {
      const fetchMock = stubLlmReply(MARKDOWN_REPLY);
      const result = await asAdmin.action(api.attendant.simulateAttendant, {
        organizationId: s.organizationId,
        agentMemberId: s.agentId,
        transcript: [{ role: "customer", content: "Oi! Tem plano anual?" }],
        ...(transport ? { transport } : {}),
      });
      expect(result.error).toBeNull();
      expect(result.reply).toBe(expected);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
      const label = transport === "instagram" ? "Instagram" : transport === "messenger" ? "Messenger" : "WhatsApp";
      expect(body.messages[0].content).toContain(`no ${label}.`);
    }
  });

  test("goldens curadas têm um caso de Instagram e um de Messenger, e o replay acha o canal pela tag", () => {
    const ig = CURATED_GOLDENS.filter((g) => goldenTransport(g.tags) === "instagram");
    const ms = CURATED_GOLDENS.filter((g) => goldenTransport(g.tags) === "messenger");
    expect(ig).toHaveLength(1);
    expect(ms).toHaveLength(1);
    expect(ig[0].expectation).toMatch(/texto PURO/);
    expect(ms[0].expectation).toMatch(/texto PURO/);
    expect(new Set(CURATED_GOLDENS.map((g) => g.name)).size).toBe(CURATED_GOLDENS.length);
    expect(goldenTransport(["audio", "regressao"])).toBeUndefined();
  });
});
