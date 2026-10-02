/// <reference types="vite/client" />
/**
 * Agenda externa do atendente (v0.64): a tool de LEITURA `consultarAgenda` e o
 * flyer em `replyToCustomer.imageUrl`.
 *
 * O fetch global atende três hosts: o LLM (`/chat/completions`), o endpoint da
 * agenda e a CDN do flyer — cada teste diz o que cada um responde.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import {
  filterByCategory,
  isAllowedImageUrl,
  normalizeAgendaEvents,
} from "./lib/externalAgenda";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// 32 bytes em base64 — chave de cifra só de teste.
const TEST_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const AGENDA_URL = "https://agenda.example.com/api/agenda";
const FLYER_URL = "https://cdn.example.com/flyers/temazcal.jpg";
const AGENDA_KEY = "agenda-key-1234567890";

const AGENDA_JSON = {
  events: [
    {
      slug: "temazcal-outubro",
      title: "Temazcal de Outubro",
      category: "temazcal",
      categoryLabel: "Temazcal",
      startsAtLocal: "2026-10-18T09:00",
      endsAtLocal: "2026-10-18T13:00",
      locationLabel: "Sítio da casa",
      leaders: ["Guardião"],
      pricing: { formatted: "R$ 180,00", note: "Pix com 10% de desconto", internalCost: 50 },
      spotsLeft: 7,
      validationRequired: false,
      pageUrl: "https://example.com/temazcal",
      signupUrl: "",
      videoUrl: null,
      image: FLYER_URL,
      // Campos fora da whitelist: não podem chegar ao modelo.
      adminNotes: "não mostrar ao cliente",
      secretToken: "tok_123",
    },
    {
      slug: "lua-cheia",
      title: "Roda de Lua Cheia",
      category: "lua_cheia",
      categoryLabel: "Lua Cheia",
      startsAtLocal: "2026-10-25T19:00",
      pricing: { formatted: "R$ 80,00" },
      spotsLeft: null,
      image: "https://cdn.example.com/flyers/lua.jpg",
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup() {
  return convexTest(schema, modules);
}

async function seedOrg(
  t: TestConvex<typeof schema>,
  opts: { mode?: "suggest" | "autopilot"; agenda?: boolean } = {}
) {
  const encryptedKey = await encryptSecret(AGENDA_KEY);
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Casa Agenda",
      slug: "casa-agenda",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Humano",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    let apiKeyRef: { kind: "orgSecret"; id: Id<"orgSecrets"> } | undefined;
    if (opts.agenda) {
      const secretId = await ctx.db.insert("orgSecrets", {
        organizationId,
        name: "Agenda externa",
        purpose: "external-agenda-api-key",
        encryptedValue: encryptedKey,
        last4: AGENDA_KEY.slice(-4),
        createdBy: humanId,
        createdAt: now,
        updatedAt: now,
      });
      apiKeyRef = { kind: "orgSecret", id: secretId };
    }
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Guardião (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: {
        kind: "attendant",
        mode: opts.mode ?? "autopilot",
        ...(opts.agenda
          ? {
              externalAgenda: {
                enabled: true,
                url: AGENDA_URL,
                headerName: "X-Agenda-Key",
                ...(apiKeyRef ? { apiKeyRef } : {}),
              },
            }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: humanId } },
      },
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número principal",
      phoneNumberId: "555000111",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Vendas",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Cliente",
      phone: "5511988887777",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Cliente WhatsApp",
      contactId,
      boardId,
      stageId,
      assignedTo: agentId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: [],
      customFields: {},
      conversationStatus: "active",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: configId,
      status: "active",
      lastInboundAt: now,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, humanId, agentId, leadId, conversationId };
  });
}

type Seed = Awaited<ReturnType<typeof seedOrg>>;

async function enqueueTurn(t: TestConvex<typeof schema>, seed: Seed, content: string) {
  const messageId = await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.conversationId, { lastInboundAt: now });
    return await ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      direction: "inbound",
      senderType: "contact",
      content,
      contentType: "text",
      isInternal: false,
      createdAt: now,
    });
  });
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
  const item = await t.run(async (ctx) =>
    (await ctx.db.query("aiReplyQueue").collect()).find((i) => i.status === "pending")
  );
  expect(item).toBeTruthy();
  await t.run(async (ctx) => {
    await ctx.db.patch(item!._id, { nextAttemptAt: Date.now() - 1_000 });
  });
  return item!._id;
}

type ToolCall = { name: string; args: Record<string, unknown> };
type LlmTurn = { tools: ToolCall[] } | { text: string };

function llmResponse(turn: LlmTurn, index: number): Response {
  const message =
    "tools" in turn
      ? {
          role: "assistant",
          content: null,
          tool_calls: turn.tools.map((tc, i) => ({
            id: `call_${index}_${i}`,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        }
      : { role: "assistant", content: turn.text };
  return new Response(
    JSON.stringify({
      choices: [{ message, finish_reason: "tools" in turn ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

function stubNetwork(opts: {
  llm: LlmTurn[];
  agenda?: () => Response | Promise<Response>;
  flyer?: () => Response;
}) {
  let llmCall = 0;
  const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
    const url = String(input);
    if (url.includes("/chat/completions")) {
      const turn = opts.llm[Math.min(llmCall, opts.llm.length - 1)];
      const res = llmResponse(turn, llmCall);
      llmCall += 1;
      return res;
    }
    if (url.startsWith(AGENDA_URL)) {
      return opts.agenda
        ? await opts.agenda()
        : new Response(JSON.stringify(AGENDA_JSON), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }
    if (url.startsWith("https://cdn.example.com/")) {
      return opts.flyer
        ? opts.flyer()
        : new Response(JPEG_BYTES, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function llmCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).includes("/chat/completions"))
    .map((c) => JSON.parse((c[1] as { body: string }).body));
}

function agendaCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(AGENDA_URL));
}

function toolResultsOf(body: { messages: { role: string; content: string }[] }) {
  return body.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
}

async function outboundMessages(t: TestConvex<typeof schema>, seed: Seed) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("messages")
        .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", seed.conversationId))
        .collect()
    ).filter((m) => m.direction === "outbound")
  );
}

// ═══════════════════════════════════════════════════════════════════════════
describe("lib/externalAgenda (puro)", () => {
  test("normaliza só a whitelist, aceita array cru e filtra categoria sem acento/caixa", () => {
    const events = normalizeAgendaEvents(AGENDA_JSON);
    expect(events).toHaveLength(2);
    expect(Object.keys(events[0])).not.toContain("adminNotes");
    expect(Object.keys(events[0])).not.toContain("secretToken");
    expect(events[0].pricing).toEqual({ formatted: "R$ 180,00", note: "Pix com 10% de desconto" });
    expect(events[1].spotsLeft).toBeNull();
    expect(normalizeAgendaEvents(AGENDA_JSON.events)).toHaveLength(2);
    expect(normalizeAgendaEvents({ nada: 1 })).toEqual([]);
    expect(filterByCategory(events, "LUA CHEIA").map((e) => e.slug)).toEqual(["lua-cheia"]);
    expect(filterByCategory(events, "Temazcál").map((e) => e.slug)).toEqual(["temazcal-outubro"]);
    expect(isAllowedImageUrl(FLYER_URL, events)).toBe(true);
    expect(isAllowedImageUrl("https://evil.example.com/x.jpg", events)).toBe(false);
  });

  test("tetos: 20 eventos e título até 200 caracteres", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ slug: `e${i}`, title: "x".repeat(500) }));
    const events = normalizeAgendaEvents(many);
    expect(events).toHaveLength(20);
    expect(events[0].title).toHaveLength(200);
  });
});

describe("consultarAgenda no turno do atendente", () => {
  test("sem agenda configurada a tool nem é oferecida; configurada, é", async () => {
    const t = setup();
    const plain = await seedOrg(t, { agenda: false });
    const itemId = await enqueueTurn(t, plain, "Oi");
    const fetchMock = stubNetwork({
      llm: [{ tools: [{ name: "replyToCustomer", args: { text: "Olá!" } }] }],
    });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const body = llmCalls(fetchMock)[0];
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(names).not.toContain("consultarAgenda");
    expect(body.messages[0].content).not.toContain("AGENDA EXTERNA");

    const t2 = setup();
    const withAgenda = await seedOrg(t2, { agenda: true });
    const itemId2 = await enqueueTurn(t2, withAgenda, "Oi");
    const fetchMock2 = stubNetwork({
      llm: [{ tools: [{ name: "replyToCustomer", args: { text: "Olá!" } }] }],
    });
    await t2.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId2 });
    const body2 = llmCalls(fetchMock2)[0];
    const names2 = body2.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(names2).toContain("consultarAgenda");
    expect(body2.messages[0].content).toContain("AGENDA EXTERNA");
  });

  test("consulta sozinha → fetch com o header → resultado projetado e filtrado → resposta enviada", async () => {
    const t = setup();
    const seed = await seedOrg(t, { agenda: true });
    const itemId = await enqueueTurn(t, seed, "Quando é o próximo temazcal?");
    const fetchMock = stubNetwork({
      llm: [
        { tools: [{ name: "consultarAgenda", args: { categoria: "temazcal" } }] },
        { tools: [{ name: "replyToCustomer", args: { text: "O próximo temazcal é dia 18/10, R$ 180." } }] },
      ],
    });

    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

    const calls = agendaCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const headers = (calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["X-Agenda-Key"]).toBe(AGENDA_KEY);

    const second = llmCalls(fetchMock)[1];
    const [agendaResult] = toolResultsOf(second);
    expect(agendaResult.status).toBe("ok");
    expect(agendaResult.total).toBe(1);
    expect(agendaResult.eventos).toHaveLength(1);
    expect(agendaResult.eventos[0].slug).toBe("temazcal-outubro");
    expect(JSON.stringify(agendaResult)).not.toContain("adminNotes");
    expect(JSON.stringify(agendaResult)).not.toContain("internalCost");
    expect(JSON.stringify(second)).not.toContain(AGENDA_KEY);

    const outbound = await outboundMessages(t, seed);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].content).toContain("18/10");
    expect(outbound[0].contentType).toBe("text");

    const run = await t.run(async (ctx) => (await ctx.db.query("agentRuns").collect())[0]);
    expect(run.toolCallNames).toEqual(["consultarAgenda", "replyToCustomer"]);
  });

  test("consulta + resposta na MESMA rodada: a resposta é descartada e pedida de novo", async () => {
    const t = setup();
    const seed = await seedOrg(t, { agenda: true });
    const itemId = await enqueueTurn(t, seed, "Tem lua cheia?");
    const fetchMock = stubNetwork({
      llm: [
        {
          tools: [
            { name: "consultarAgenda", args: {} },
            { name: "replyToCustomer", args: { text: "Tem sim, dia 01/01 (chute)." } },
          ],
        },
        { tools: [{ name: "replyToCustomer", args: { text: "A próxima Lua Cheia é dia 25/10." } }] },
      ],
    });

    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

    const second = llmCalls(fetchMock)[1];
    const results = toolResultsOf(second);
    expect(results[0].status).toBe("ok");
    expect(results[1]).toMatchObject({ status: "descartado" });

    const outbound = await outboundMessages(t, seed);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].content).toContain("25/10");
    expect(outbound[0].content).not.toContain("chute");
    const run = await t.run(async (ctx) => (await ctx.db.query("agentRuns").collect())[0]);
    // O reply descartado não entra na contagem.
    expect(run.toolCallNames).toEqual(["consultarAgenda", "replyToCustomer"]);
  });

  test.each([
    ["401", () => new Response("nope", { status: 401 })],
    [
      "timeout",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ],
    ["json inválido", () => new Response("<html>", { status: 200 })],
  ])("endpoint com %s → agenda_indisponivel", async (_label, agenda) => {
    const t = setup();
    const seed = await seedOrg(t, { agenda: true });
    const itemId = await enqueueTurn(t, seed, "Quando é o próximo?");
    const fetchMock = stubNetwork({
      agenda,
      llm: [
        { tools: [{ name: "consultarAgenda", args: {} }] },
        { tools: [{ name: "replyToCustomer", args: { text: "Vou confirmar com a casa e já te retorno." } }] },
      ],
    });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const [result] = toolResultsOf(llmCalls(fetchMock)[1]);
    expect(result).toEqual({ status: "erro", erro: "agenda_indisponivel" });
    expect(await outboundMessages(t, seed)).toHaveLength(1);
  });
});

describe("flyer em replyToCustomer.imageUrl", () => {
  test("URL vinda da consulta → mensagem image com anexo; 2º envio reaproveita o blob", async () => {
    const t = setup();
    const seed = await seedOrg(t, { agenda: true });

    for (let i = 0; i < 2; i++) {
      // Pacing por org/conversa: o 2º turno precisa de relógio andando.
      vi.setSystemTime(Date.now() + 5 * 60_000);
      const itemId = await enqueueTurn(t, seed, `Me manda o flyer (${i})`);
      stubNetwork({
        llm: [
          { tools: [{ name: "consultarAgenda", args: { categoria: "temazcal" } }] },
          {
            tools: [
              {
                name: "replyToCustomer",
                args: { text: "Segue o flyer do **Temazcal**!", imageUrl: FLYER_URL },
              },
            ],
          },
        ],
      });
      await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    }

    const outbound = await outboundMessages(t, seed);
    expect(outbound).toHaveLength(2);
    const files = await t.run(async (ctx) => ctx.db.query("files").collect());
    expect(files).toHaveLength(2);
    for (const [index, message] of outbound.entries()) {
      expect(message.contentType).toBe("image");
      expect(message.content).toContain("*Temazcal*"); // legenda formatada p/ WhatsApp
      expect(message.attachments).toHaveLength(1);
      const file = files.find((f) => f._id === message.attachments![0])!;
      expect(file.sourceUrl).toBe(FLYER_URL);
      expect(file.messageId).toBe(message._id);
      expect(file.mimeType).toBe("image/jpeg");
      expect(index).toBeLessThan(2);
    }
    // Dedupe: um blob só.
    expect(files[0].storageId).toBe(files[1].storageId);
  });

  test("URL que NÃO veio da consulta → só texto, e a mensagem marca a recusa", async () => {
    const t = setup();
    const seed = await seedOrg(t, { agenda: true });
    const itemId = await enqueueTurn(t, seed, "Me manda o flyer");
    const fetchMock = stubNetwork({
      llm: [
        { tools: [{ name: "consultarAgenda", args: {} }] },
        {
          tools: [
            {
              name: "replyToCustomer",
              args: { text: "Segue!", imageUrl: "https://evil.example.com/phish.jpg" },
            },
          ],
        },
      ],
    });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

    const outbound = await outboundMessages(t, seed);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].contentType).toBe("text");
    expect(outbound[0].attachments).toBeUndefined();
    expect(outbound[0].metadata?.aiImageRejected).toBe(true);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("evil.example.com"))).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.query("files").collect())).toHaveLength(0);
  });

  test("download do flyer falha → sai só o texto, sem derrubar o turno", async () => {
    const t = setup();
    const seed = await seedOrg(t, { agenda: true });
    const itemId = await enqueueTurn(t, seed, "Me manda o flyer");
    stubNetwork({
      flyer: () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      llm: [
        { tools: [{ name: "consultarAgenda", args: {} }] },
        { tools: [{ name: "replyToCustomer", args: { text: "Segue!", imageUrl: FLYER_URL } }] },
      ],
    });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const outbound = await outboundMessages(t, seed);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].contentType).toBe("text");
  });

  test("modo sugestão: o rascunho carrega o flyer e o aceite sai como imagem", async () => {
    const t = setup();
    const seed = await seedOrg(t, { agenda: true, mode: "suggest" });
    const itemId = await enqueueTurn(t, seed, "Me manda o flyer");
    stubNetwork({
      llm: [
        { tools: [{ name: "consultarAgenda", args: {} }] },
        { tools: [{ name: "replyToCustomer", args: { text: "Segue o flyer!", imageUrl: FLYER_URL } }] },
      ],
    });
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });

    const draft = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).find((m) => m.isInternal && m.metadata?.aiDraft)
    );
    expect(draft).toBeTruthy();
    const aiDraft = draft!.metadata!.aiDraft as { attachments?: Id<"files">[]; contentType?: string };
    expect(aiDraft.attachments).toHaveLength(1);
    expect(aiDraft.contentType).toBe("image");
    expect(await outboundMessages(t, seed)).toHaveLength(0);

    const userId = await t.run(async (ctx) => {
      const uid = await ctx.db.insert("users", { email: "humano@example.com" });
      await ctx.db.patch(seed.humanId, { userId: uid });
      return uid;
    });
    const asHuman = t.withIdentity({ subject: `${userId}|session` });
    await asHuman.mutation(api.attendant.acceptAiDraft, { draftMessageId: draft!._id });

    const outbound = await outboundMessages(t, seed);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].contentType).toBe("image");
    expect(outbound[0].content).toContain("Segue o flyer!");
    const files = await t.run(async (ctx) => ctx.db.query("files").collect());
    expect(files).toHaveLength(2); // a linha do rascunho + a do envio, mesmo blob
    const sent = files.find((f) => f._id === outbound[0].attachments![0])!;
    expect(sent.messageId).toBe(outbound[0]._id);
    expect(sent.storageId).toBe(files.find((f) => f._id === aiDraft.attachments![0])!.storageId);
  });
});

describe("configuração (aiSettings)", () => {
  test("internalSetExternalAgenda: dryRun não grava; real cifra a chave e expõe só last4", async () => {
    const t = setup();
    const seed = await seedOrg(t, { agenda: false });

    const dry = await t.action(internal.aiSettings.internalSetExternalAgenda, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      enabled: true,
      url: "https://site.example.com/api/agenda?token=abc",
      apiKey: "chave-secreta-9876",
    });
    expect(dry).toMatchObject({ dryRun: true, keyAction: "replaced", url: "https://site.example.com/api/agenda" });
    let agent = await t.run(async (ctx) => ctx.db.get(seed.agentId));
    expect(agent!.agentProfile!.externalAgenda).toBeUndefined();

    await t.action(internal.aiSettings.internalSetExternalAgenda, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      enabled: true,
      url: "https://site.example.com/api/agenda",
      apiKey: "chave-secreta-9876",
      dryRun: false,
    });
    agent = await t.run(async (ctx) => ctx.db.get(seed.agentId));
    const config = agent!.agentProfile!.externalAgenda!;
    expect(config.enabled).toBe(true);
    const secret = await t.run(async (ctx) => ctx.db.get(config.apiKeyRef!.id));
    expect(secret!.purpose).toBe("external-agenda-api-key");
    expect(secret!.encryptedValue).not.toContain("chave-secreta");
    expect(secret!.last4).toBe("9876");

    // Trocar a chave apaga a anterior; null mantém.
    await t.action(internal.aiSettings.internalSetExternalAgenda, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      enabled: true,
      url: "https://site.example.com/api/agenda",
      apiKey: "outra-chave-1111",
      dryRun: false,
    });
    const after = await t.run(async (ctx) => ({
      secrets: await ctx.db.query("orgSecrets").collect(),
      agent: await ctx.db.get(seed.agentId),
    }));
    expect(after.secrets).toHaveLength(1);
    expect(after.secrets[0].last4).toBe("1111");
    await t.action(internal.aiSettings.internalSetExternalAgenda, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      enabled: false,
      url: "https://site.example.com/api/agenda",
      apiKey: null,
      dryRun: false,
    });
    const final = await t.run(async (ctx) => ctx.db.get(seed.agentId));
    expect(final!.agentProfile!.externalAgenda!.apiKeyRef?.id).toBe(after.secrets[0]._id);
    expect(final!.agentProfile!.externalAgenda!.enabled).toBe(false);

    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((a) => a.metadata?.externalAgenda)
    );
    expect(audits.length).toBe(3);
    expect(JSON.stringify(audits)).not.toContain("chave-secreta");
    expect(JSON.stringify(audits)).not.toContain("outra-chave");
  });

  test("recusa URL sem https", async () => {
    const t = setup();
    const seed = await seedOrg(t, { agenda: false });
    await expect(
      t.action(internal.aiSettings.internalSetExternalAgenda, {
        organizationId: seed.organizationId,
        agentMemberId: seed.agentId,
        enabled: true,
        url: "http://site.example.com/agenda",
        dryRun: false,
      })
    ).rejects.toThrow(/https/);
  });
});
