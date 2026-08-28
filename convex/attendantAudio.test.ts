/// <reference types="vite/client" />
/**
 * O atendente "ouve" as mensagens de voz (plano docs/AI-ATTENDANT-AUDIO-PLAN.md).
 * Prova que:
 *  - o claim ESPERA a transcrição em voo em vez de responder ao placeholder
 *    "[áudio]" (D1) — sem consumir tentativas de falha;
 *  - com transcrição pronta, a história entrega a fala do cliente (D3);
 *  - estourado o teto de espera, a run acontece assim mesmo, com o marcador de
 *    indisponível (D4) — transcrição que falhou nunca trava a fila;
 *  - o gate da transcrição vale para o atendente mesmo sem o toggle do inbox (D2);
 *  - conversa só de texto não ganha nenhuma espera nova (regressão).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("WHISPER_SERVICE_URL", "https://whisper.test.local");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup() {
  return convexTest(schema, modules);
}

type Seed = Awaited<ReturnType<typeof seedAttendantOrg>>;

async function seedAttendantOrg(
  t: TestConvex<typeof schema>,
  opts?: { aiEnabled?: boolean; attendantEnabled?: boolean; autoTranscribeAudio?: boolean }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Áudio",
      slug: "org-audio",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig:
          opts?.aiEnabled === false
            ? { enabled: false, autoAssign: false, handoffThreshold: 0.8 }
            : {
                enabled: true,
                autoAssign: false,
                handoffThreshold: 0.8,
                ...(opts?.attendantEnabled === false ? { attendantEnabled: false } : {}),
              },
      },
      createdAt: now,
      updatedAt: now,
    });
    // Admin de verdade (com user vinculado): o simulador exige settings/view.
    const adminUserId = await ctx.db.insert("users", { email: "admin@audio.test" });
    const humanId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Humano",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Ana (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" },
      createdAt: now,
      updatedAt: now,
    });
    // Aceite LGPD (gate de ativação da IA da org).
    if (opts?.aiEnabled !== false) {
      const org = (await ctx.db.get(organizationId))!;
      await ctx.db.patch(organizationId, {
        settings: {
          ...org.settings,
          aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: humanId } },
        },
      });
    }
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número principal",
      phoneNumberId: "555000222",
      status: "active",
      autoTranscribeAudio: opts?.autoTranscribeAudio ?? false,
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
      phone: "5511977776666",
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
    return {
      organizationId,
      humanId,
      adminUserId,
      agentId,
      configId,
      contactId,
      leadId,
      conversationId,
    };
  });
}

// Nota de voz inbound como o ingest grava: content é o placeholder do parser e o
// áudio real vive num anexo (files) — a transcrição chega depois, se chegar.
async function insertVoiceNote(
  t: TestConvex<typeof schema>,
  seed: Seed,
  opts?: {
    transcription?: { status: "pending" | "done" | "failed"; text?: string };
    transcriptText?: string;
    withAttachment?: boolean;
  }
): Promise<Id<"messages">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(seed.conversationId, { lastInboundAt: now });
    const messageId = await ctx.db.insert("messages", {
      organizationId: seed.organizationId,
      conversationId: seed.conversationId,
      leadId: seed.leadId,
      direction: "inbound",
      senderType: "contact",
      content: "[mensagem de voz]",
      contentType: "audio",
      isInternal: false,
      ...(opts?.transcription ? { metadata: { transcription: { ...opts.transcription, engine: "faster-whisper", at: now } } } : {}),
      ...(opts?.transcriptText ? { transcriptText: opts.transcriptText } : {}),
      createdAt: now,
    });
    if (opts?.withAttachment !== false) {
      const fileId = await ctx.db.insert("files", {
        organizationId: seed.organizationId,
        storageId: "kg2storage-audio",
        name: "voice.ogg",
        mimeType: "audio/ogg; codecs=opus",
        size: 18_000,
        fileType: "message_attachment",
        messageId,
        createdAt: now,
      });
      await ctx.db.patch(messageId, { attachments: [fileId] });
    }
    return messageId;
  });
}

async function insertTextInbound(
  t: TestConvex<typeof schema>,
  seed: Seed,
  content: string
): Promise<Id<"messages">> {
  return await t.run(async (ctx) => {
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
}

// Enfileira e adianta o relógio além do debounce, devolvendo o item da fila.
async function enqueueAndSettle(t: TestConvex<typeof schema>, messageId: Id<"messages">) {
  await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId });
  const item = await t.run(async (ctx) => (await ctx.db.query("aiReplyQueue").collect())[0]);
  vi.setSystemTime(Date.now() + 10_000);
  return item;
}

describe("espera pela transcrição no claim (D1)", () => {
  test("áudio com transcrição pendente: claim re-enfileira em vez de responder", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t);
    const messageId = await insertVoiceNote(t, seed, { transcription: { status: "pending" } });
    const item = await enqueueAndSettle(t, messageId);

    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-audio-pending",
    });

    expect(claim).toEqual({ kind: "requeued", reason: "aguardando_transcricao" });

    const { updated, conversation } = await t.run(async (ctx) => ({
      updated: await ctx.db.get(item._id),
      conversation: await ctx.db.get(seed.conversationId),
    }));
    // Continua pendente, com novo slot e o teto da espera gravado…
    expect(updated!.status).toBe("pending");
    expect(updated!.nextAttemptAt).toBe(Date.now() + 8_000);
    // Campo generalizado na v0.51 (D12 do plano de visão): a espera cobre
    // transcrição, passe de visão e download em voo. `transcriptWaitUntil`
    // sobrevive como legado só para as linhas que já estavam em voo.
    expect(updated!.mediaWaitUntil).toBe(item.createdAt + 60_000);
    // …sem consumir tentativa de falha nem tomar o lock de turno.
    expect(updated!.attempts).toBe(0);
    expect(conversation!.aiTurnLock).toBeUndefined();
  });

  test("áudio ainda sem metadata de transcrição também segura o turno", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t);
    const messageId = await insertVoiceNote(t, seed);
    const item = await enqueueAndSettle(t, messageId);

    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-audio-sem-meta",
    });
    expect(claim.kind).toBe("requeued");
  });

  test("sem Whisper configurado, o atendente não espera nada", async () => {
    vi.stubEnv("WHISPER_SERVICE_URL", "");
    const t = setup();
    const seed = await seedAttendantOrg(t);
    const messageId = await insertVoiceNote(t, seed, { transcription: { status: "pending" } });
    const item = await enqueueAndSettle(t, messageId);

    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-sem-whisper",
    });
    expect(claim.kind).toBe("run");
  });

  test("transcrição que falhou não trava a fila (D4)", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t);
    const messageId = await insertVoiceNote(t, seed, { transcription: { status: "failed" } });
    const item = await enqueueAndSettle(t, messageId);

    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-audio-failed",
    });
    expect(claim.kind).toBe("run");
    if (claim.kind !== "run") throw new Error("unreachable");
    expect(claim.context.history.at(-1)!.texto).toBe("[áudio recebido — transcrição indisponível]");
  });
});

describe("história do atendente com áudio (D3)", () => {
  test("transcrição pronta: a fala do cliente entra no contexto", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t);
    const messageId = await insertVoiceNote(t, seed, {
      transcription: { status: "done", text: "Oi, queria saber o preço do plano anual" },
      transcriptText: "Oi, queria saber o preço do plano anual",
    });
    const item = await enqueueAndSettle(t, messageId);

    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-audio-done",
    });
    expect(claim.kind).toBe("run"); // transcrição pronta: nada a esperar
    if (claim.kind !== "run") throw new Error("unreachable");

    const last = claim.context.history.at(-1)!;
    expect(last.de).toBe("cliente");
    expect(last.texto).toBe("[áudio transcrito]: Oi, queria saber o preço do plano anual");
    // O placeholder do ingest não chega ao modelo.
    expect(last.texto).not.toContain("[mensagem de voz]");
  });

  test("teto de espera estourado: roda com o marcador de indisponível", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t);
    const messageId = await insertVoiceNote(t, seed, { transcription: { status: "pending" } });
    const item = await enqueueAndSettle(t, messageId);
    // Deadline no passado — o Whisper demorou demais (ou morreu).
    await t.run(async (ctx) => {
      await ctx.db.patch(item._id, { transcriptWaitUntil: Date.now() - 1 });
    });

    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-audio-deadline",
    });
    expect(claim.kind).toBe("run");
    if (claim.kind !== "run") throw new Error("unreachable");
    expect(claim.context.history.at(-1)!.texto).toBe("[áudio recebido — transcrição indisponível]");
  });
});

describe("gate da transcrição (D2)", () => {
  test("toggle do inbox desligado + org com atendente ativo → transcreve mesmo assim", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t, { autoTranscribeAudio: false });
    const messageId = await insertVoiceNote(t, seed);

    const message = await t.query(internal.transcription.internalGetAudioMessageIfEligible, {
      messageId,
    });
    expect(message).not.toBeNull();
    expect(message!.messageId).toEqual(messageId);
  });

  test("org sem IA ativa e toggle desligado → segue no-op (comportamento atual)", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t, { aiEnabled: false, autoTranscribeAudio: false });
    const messageId = await insertVoiceNote(t, seed);

    const message = await t.query(internal.transcription.internalGetAudioMessageIfEligible, {
      messageId,
    });
    expect(message).toBeNull();
  });

  test("atendente desligado na org → só o toggle do inbox decide", async () => {
    const t = setup();
    const off = await seedAttendantOrg(t, { attendantEnabled: false, autoTranscribeAudio: false });
    const semGate = await insertVoiceNote(t, off);
    expect(
      await t.query(internal.transcription.internalGetAudioMessageIfEligible, {
        messageId: semGate,
      })
    ).toBeNull();

    await t.run(async (ctx) => {
      await ctx.db.patch(off.configId, { autoTranscribeAudio: true });
    });
    const comToggle = await insertVoiceNote(t, off);
    expect(
      await t.query(internal.transcription.internalGetAudioMessageIfEligible, {
        messageId: comToggle,
      })
    ).not.toBeNull();
  });
});

describe("regressão: conversa de texto", () => {
  test("inbound só de texto roda direto, sem espera nem requeue", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t);
    const messageId = await insertTextInbound(t, seed, "Oi, quero um orçamento");
    const item = await enqueueAndSettle(t, messageId);

    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-texto",
    });
    expect(claim.kind).toBe("run");
    if (claim.kind !== "run") throw new Error("unreachable");
    expect(claim.context.history.at(-1)!.texto).toBe("Oi, quero um orçamento");

    const { updated, conversation } = await t.run(async (ctx) => ({
      updated: await ctx.db.get(item._id),
      conversation: await ctx.db.get(seed.conversationId),
    }));
    expect(updated!.status).toBe("processing");
    expect(updated!.transcriptWaitUntil).toBeUndefined();
    expect(conversation!.aiTurnLock?.runId).toBe("run-texto");
  });

  test("áudio já transcrito seguido de texto: a rajada não espera de novo", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t);
    const audioId = await insertVoiceNote(t, seed, {
      transcription: { status: "done", text: "Bom dia" },
      transcriptText: "Bom dia",
    });
    await t.mutation(internal.attendant.internalEnqueueFromInbound, { messageId: audioId });
    const textId = await insertTextInbound(t, seed, "…e queria saber o prazo de entrega");
    const item = await enqueueAndSettle(t, textId);

    const claim = await t.mutation(internal.attendant.internalClaimForProcessing, {
      queueItemId: item._id,
      runId: "run-rajada",
    });
    expect(claim.kind).toBe("run");
    if (claim.kind !== "run") throw new Error("unreachable");
    expect(claim.context.history.map((h: { texto: string }) => h.texto)).toEqual([
      "[áudio transcrito]: Bom dia",
      "…e queria saber o prazo de entrega",
    ]);
  });
});

describe("simulador + golden com áudio (F4)", () => {
  test("turno marcado como áudio chega ao modelo com o marcador do runtime", async () => {
    vi.useRealTimers(); // a camada LLM dorme com setTimeout real em retry
    vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
    const t = setup();
    const seed = await seedAttendantOrg(t);
    const asAdmin = t.withIdentity({ subject: `${seed.adminUserId}|s1` });

    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "O plano anual sai por R$ 990 e dá pra parcelar em 3x.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 12 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const result = await asAdmin.action(api.attendant.simulateAttendant, {
      organizationId: seed.organizationId,
      agentMemberId: seed.agentId,
      transcript: [
        { role: "customer", content: "Oi, boa tarde!" },
        { role: "customer", content: "Quanto custa o plano anual?", audio: true },
      ],
    });

    expect(result.error).toBeNull();
    expect(result.reply).toContain("plano anual");
    // O prompt vê a nota de voz como fala transcrita, igual ao runtime…
    expect(bodies[0]).toContain("[áudio transcrito]: Quanto custa o plano anual?");
    // …e o texto puro do turno anterior segue intocado.
    expect(bodies[0]).toContain("Oi, boa tarde!");

    vi.unstubAllGlobals();
  }, 20_000);

  test("goldens curadas: instaladas uma vez só, com os turnos de mídia preservados", async () => {
    const t = setup();
    const seed = await seedAttendantOrg(t);

    const first = await t.mutation(internal.agentEvals.internalSeedCuratedGoldens, {
      organizationId: seed.organizationId,
    });
    const again = await t.mutation(internal.agentEvals.internalSeedCuratedGoldens, {
      organizationId: seed.organizationId,
    });
    expect(again).toEqual(first); // idempotente pelo nome

    const evals = await t.run(async (ctx) => ctx.db.query("agentEvals").collect());
    expect(evals).toHaveLength(3);
    expect(evals.every((e) => e.createdBy === seed.humanId)).toBe(true);

    const audio = evals.find((e) => e.tags?.includes("audio"))!;
    expect(audio.transcript.filter((turn) => turn.audio)).toHaveLength(1);
    expect(audio.expectation).toMatch(/não consegue ouvir/i);

    // D13 do plano de visão: a IA lê o comprovante e NÃO confirma o pagamento.
    const visao = evals.find((e) => e.tags?.includes("visao"))!;
    expect(visao.transcript.filter((turn) => turn.image)).toHaveLength(1);
    expect(visao.transcript.find((turn) => turn.image)!.content).toContain("R$ 1.247,90");
    expect(visao.expectation).toMatch(/NUNCA declarar o pagamento confirmado/i);

    // PDF: só o nome chega — a IA não pode fingir ter lido.
    const pdf = evals.find((e) => e.tags?.includes("pdf"))!;
    expect(pdf.transcript.filter((turn) => turn.file)).toHaveLength(1);
    expect(pdf.transcript.find((turn) => turn.file)!.content).toMatch(/\.pdf$/);
    expect(pdf.expectation).toMatch(/NUNCA fingir ter lido/i);
  });
});
