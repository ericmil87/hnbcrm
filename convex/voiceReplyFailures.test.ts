/// <reference types="vite/client" />
/**
 * Resposta em áudio (P4.1), caminhos de falha que o `fetch` simulado não alcança:
 *  - a action de síntese LANÇA (erro de plataforma) → resposta em texto (`falha_tts`);
 *  - o commit LANÇA depois da síntese → o ogg gravado é descartado (sem órfão);
 *  - o commit RECUSA (humano respondeu durante a geração) → o ogg é descartado.
 *
 * A síntese é trocada por uma action falsa (vi.mock) que grava um ogg de verdade
 * no storage pela mesma mutation da porta (`internalInsertVoiceNoteFile`).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

type Mode = "throw" | "ok" | "ok_then_human";
const state = vi.hoisted(() => ({ mode: "ok" as Mode, failSideEffects: false, humanId: null as string | null }));

vi.mock("./voiceReplyNode", async () => {
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  const { internal: internalApi } = await import("./_generated/api");
  return {
    internalSynthesizeVoiceNote: internalAction({
      args: {
        organizationId: v.id("organizations"),
        conversationId: v.id("conversations"),
        agentMemberId: v.id("teamMembers"),
        leadId: v.optional(v.id("leads")),
        text: v.string(),
        voice: v.string(),
        strictZdr: v.boolean(),
        routingAllowed: v.boolean(),
      },
      returns: v.any(),
      handler: async (ctx, args) => {
        if (state.mode === "throw") throw new Error("plataforma caiu no meio da síntese");
        const storageId = await ctx.storage.store(new Blob([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], { type: "audio/ogg" }));
        const fileId = await ctx.runMutation(internalApi.voiceReply.internalInsertVoiceNoteFile, {
          organizationId: args.organizationId,
          agentMemberId: args.agentMemberId,
          storageId,
          size: 4,
        });
        if (state.mode === "ok_then_human" && state.humanId) {
          // Um humano responde enquanto a voz era gerada: o commit tem que recusar.
          await ctx.runMutation(internalApi.conversations.internalSendMessage, {
            conversationId: args.conversationId,
            content: "Deixa comigo, respondo eu.",
            teamMemberId: state.humanId as never,
          });
        }
        return { ok: true, fileId, seconds: 2, waveform: new Array(64).fill(50), costUsd: 0.001 };
      },
    }),
  };
});

// Efeitos colaterais da saída: falham sob demanda para o commit LANÇAR.
vi.mock("./lib/outboundSideEffects", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/outboundSideEffects")>();
  return {
    ...original,
    applyOutboundMessageSideEffects: async (...a: Parameters<typeof original.applyOutboundMessageSideEffects>) => {
      if (state.failSideEffects && a[1].member.type === "ai") throw new Error("falha inesperada no commit");
      return original.applyOutboundMessageSideEffects(...a);
    },
  };
});

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENROUTER_API_KEY", "sk-test-openrouter-fake-000");
  state.mode = "ok";
  state.failSideEffects = false;
  state.humanId = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Clínica Voz",
      slug: "clinica-voz-falhas",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8, voiceReplyEnabled: true },
      },
      createdAt: now,
      updatedAt: now,
    });
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Marina (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "autopilot", disclosureMode: "on_demand" },
      createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig!,
          lgpdAck: { acceptedAt: now, acceptedBy: humanId },
          bridgeAiAck: { acceptedAt: now, acceptedBy: humanId },
        },
      },
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge", displayName: "Número",
      bridgeBaseUrl: "https://bridge.example.com", bridgeInstanceId: "org_fake", status: "active",
      createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false,
      createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", phone: "5511900002222", tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente", contactId, boardId, stageId, assignedTo: agentId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active",
      lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
    });
    const messageId = await ctx.db.insert("messages", {
      organizationId, conversationId, leadId, direction: "inbound", senderType: "contact",
      content: "[mensagem de voz]", contentType: "audio", isInternal: false, transcriptText: "Tem horário amanhã?",
      metadata: { transcription: { status: "done", text: "Tem horário amanhã?", engine: "faster-whisper", at: now } },
      createdAt: now,
    });
    return { organizationId, humanId, conversationId, messageId };
  });
}

async function enqueue(t: TestConvex<typeof schema>, s: Awaited<ReturnType<typeof seed>>) {
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId: s.messageId });
  const item = await t.run(async (ctx) =>
    (await ctx.db.query("aiReplyQueue").collect()).find((i) => i.status === "pending")
  );
  await t.run(async (ctx) => ctx.db.patch(item!._id, { nextAttemptAt: Date.now() - 1_000 }));
  return item!._id;
}

function stubLlm() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
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
                  {
                    id: "call_0",
                    type: "function",
                    function: { name: "replyToCustomer", arguments: JSON.stringify({ text: "Tenho sim, amanhã às dez. Pode ser?" }) },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    })
  );
}

async function snapshot(t: TestConvex<typeof schema>, s: Awaited<ReturnType<typeof seed>>) {
  return await t.run(async (ctx) => {
    const messages = (await ctx.db.query("messages").collect()).filter(
      (m) => m.conversationId === s.conversationId && m.direction === "outbound"
    );
    const files = (await ctx.db.query("files").collect()).filter((f) => f.organizationId === s.organizationId);
    const blobs = await ctx.db.system.query("_storage").collect();
    return { messages, files, blobCount: blobs.length };
  });
}

describe("falhas da resposta em áudio", () => {
  test("a action de síntese lança → resposta sai em texto (falha_tts), o turno não cai", async () => {
    state.mode = "throw";
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const itemId = await enqueue(t, s);
    stubLlm();
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const snap = await snapshot(t, s);
    expect(snap.messages).toHaveLength(1);
    expect(snap.messages[0].contentType).toBe("text");
    expect(snap.messages[0].metadata?.voiceReply).toEqual({ mode: "text", reason: "falha_tts" });
    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item!.status).toBe("done");
  });

  test("o commit lança depois da síntese → o ogg gravado é descartado (linha e blob)", async () => {
    state.failSideEffects = true;
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const itemId = await enqueue(t, s);
    stubLlm();
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const snap = await snapshot(t, s);
    expect(snap.messages).toHaveLength(0);
    expect(snap.files).toHaveLength(0);
    expect(snap.blobCount).toBe(0);
    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item!.status).not.toBe("done");
  });

  test("o commit recusa (humano respondeu durante a geração) → o ogg é descartado", async () => {
    state.mode = "ok_then_human";
    const t = convexTest(schema, modules);
    const s = await seed(t);
    state.humanId = s.humanId;
    const itemId = await enqueue(t, s);
    stubLlm();
    await t.action(internal.attendant.internalProcessQueueItem, { queueItemId: itemId });
    const snap = await snapshot(t, s);
    // Só a mensagem do humano; nenhuma da IA.
    expect(snap.messages.map((m) => m.senderType)).toEqual(["human"]);
    expect(snap.files).toHaveLength(0);
    expect(snap.blobCount).toBe(0);
    const item = await t.run(async (ctx) => ctx.db.get(itemId));
    expect(item!.status).toBe("skipped");
  });
});
