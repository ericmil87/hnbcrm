/// <reference types="vite/client" />
/**
 * Copilot on Telegram — F4 (D21/D25): files both ways with limits.
 * Customer → Telegram (photo/voice/document after the card, caps → link line,
 * video/sticker lines, discreet), member → customer through "Responder"
 * (inbound attachment port, preview, send with the attachment, allowlist,
 * size, hourly quota, failed dispatch), pacing and revocation cleanup.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { createNotification } from "./lib/notify";
import { hourStartOf, localDayKey } from "./lib/telegramQuota";
import { PACING_CHAT_GAP_MS, PACING_GLOBAL_GAP_MS } from "./lib/telegramPacing";
import { planMedia } from "./lib/telegramMedia";
import { COPY_DOCUMENT_WITHOUT_PROMPT } from "./telegram";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const SECRET = "fake-telegram-webhook-secret-f4";
const CHAT = 9401;
const MB = 1024 * 1024;
const TZ = "America/Sao_Paulo";

type Call = { method: string; body: any; at: number };
let calls: Call[];
let nextMessageId: number;
let telegramFiles: Record<string, { size: number; path: string; head?: string; headBytes?: number[]; announce?: boolean }>;
let t: TestConvex<typeof schema>;
let refuseUrlButtons: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T14:10:00Z"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:FAKE-TOKEN-f4");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "hnbcrm_test_bot");
  vi.stubEnv("APP_URL", "https://app.example.test");
  calls = [];
  nextMessageId = 700;
  telegramFiles = {};
  refuseUrlButtons = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.telegram.org/file/")) {
        const path = url.split("/file/bot")[1]?.split("/").slice(1).join("/") ?? "";
        const file = Object.values(telegramFiles).find((f) => f.path === path);
        const bytes = new Uint8Array(file?.size ?? 4);
        // Real magic bytes (review F4 #1 sniffs them); default a PDF header.
        const head = file?.headBytes ? new Uint8Array(file.headBytes) : new TextEncoder().encode(file?.head ?? "%PDF-1.7");
        bytes.set(head.slice(0, bytes.length));
        return new Response(bytes, { status: 200 });
      }
      if (url.includes("api.telegram.org")) {
        const method = url.split("/").pop() ?? "";
        let body: any = null;
        if (init?.body instanceof FormData) {
          const fields: Record<string, unknown> = {};
          init.body.forEach((val, k) => {
            fields[k] = typeof val === "string" ? val : { name: (val as File).name, size: (val as File).size };
          });
          body = fields;
          body.chat_id = Number(body.chat_id);
        } else if (typeof init?.body === "string") body = JSON.parse(init.body);
        calls.push({ method, body, at: Date.now() });
        if (refuseUrlButtons && method === "sendMessage" && JSON.stringify(body?.reply_markup ?? {}).includes('"url"')) {
          return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: BUTTON_URL_INVALID" }), { status: 200 });
        }
        if (method === "getFile") {
          const f = telegramFiles[body.file_id];
          const announced = f && f.announce !== false ? { file_size: f.size } : {};
          return new Response(JSON.stringify({ ok: true, result: { file_id: body.file_id, file_path: f?.path ?? "x", ...announced } }), { status: 200 });
        }
        const result = method.startsWith("send") ? { message_id: nextMessageId++ } : true;
        return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      }
      // WhatsApp / anything else: a failure the dispatcher records.
      return new Response(JSON.stringify({ error: { message: "fake", code: 100 } }), { status: 400 });
    }),
  );
  for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);
const of = (method: string, chatId = CHAT) => calls.filter((c) => c.method === method && c.body?.chat_id === chatId);
/** `getFile` carries no chat id. */
const getFiles = () => calls.filter((c) => c.method === "getFile");
const sends = (chatId = CHAT) => of("sendMessage", chatId);

async function seed(opts: { discreet?: boolean; mediaInbound?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: "eric@acme.test" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Acme Corp",
      slug: "acme",
      settings: {
        timezone: TZ,
        currency: "BRL",
        modules: { telegram: true },
        telegram: { ...(opts.discreet ? { discreet: true } : {}) },
      },
      createdAt: now,
      updatedAt: now,
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Eric Milfont", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Principal", phoneNumberId: "pn-f4",
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Proposta", color: "#000", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Carlos", lastName: "Lima", whatsappNumber: "5511987654321", tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Carlos Lima", contactId, boardId, stageId, assignedTo: memberId, value: 4800, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now,
      createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active", lastInboundAt: now,
      messageCount: 0, createdAt: now, updatedAt: now,
    });
    const linkId = await ctx.db.insert("telegramLinks", {
      organizationId, teamMemberId: memberId, userId, chatId: CHAT, telegramUserId: CHAT, status: "active",
      prefs: { relayAssignedConversations: true, mediaInbound: opts.mediaInbound ?? true },
      assistant: {
        mode: "suggest", suggestOnEvents: false, autoSendDelaySeconds: 15,
        autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
      },
      reports: { enabled: true, morningHour: 8, eveningHour: 18 },
      linkedAt: now, lastSeenAt: now,
    });
    await ctx.db.insert("telegramChats", {
      chatId: CHAT, telegramUserId: CHAT, activeOrganizationId: organizationId, activeTeamMemberId: memberId, updatedAt: now,
    });
    return { organizationId, memberId, conversationId, leadId, linkId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

/** A customer message with one attachment of `size` bytes (blob really stored). */
async function inbound(
  s: Seed,
  file: { name: string; mimeType: string; size: number },
  extra: { contentType: "image" | "audio" | "file"; content?: string; transcriptText?: string; metadata?: Record<string, unknown> },
) {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(Math.min(file.size, 64))], { type: file.mimeType }));
    const fileId = await ctx.db.insert("files", {
      organizationId: s.organizationId, storageId, name: file.name, mimeType: file.mimeType, size: file.size,
      fileType: "message_attachment", createdAt: Date.now(),
    });
    const messageId = await ctx.db.insert("messages", {
      organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "inbound",
      senderType: "contact", content: extra.content ?? "", contentType: extra.contentType, attachments: [fileId],
      isInternal: false, ...(extra.transcriptText ? { transcriptText: extra.transcriptText } : {}),
      ...(extra.metadata ? { metadata: extra.metadata } : {}), createdAt: Date.now(),
    });
    return { messageId, storageId };
  });
}
async function relay(s: Seed, messageIds: Id<"messages">[]) {
  await t.run((ctx) =>
    createNotification(ctx, {
      organizationId: s.organizationId, memberId: s.memberId, type: "new_message", title: "Carlos Lima · WhatsApp",
      body: "…", conversationId: s.conversationId, data: { messageIds },
    }),
  );
  await drain();
}

describe("cliente → Telegram (D21)", () => {
  test("foto ≤ 5 MB: sendPhoto pela URL do storage, depois do cartão, com linha em telegramDeliveries", async () => {
    const s = await seed();
    const { messageId } = await inbound(s, { name: "orcamento.jpg", mimeType: "image/jpeg", size: 1.2 * MB }, { contentType: "image", content: "olha" });
    await relay(s, [messageId]);
    expect(sends()[0].body.text).toContain("[imagem] olha");
    const photo = of("sendPhoto")[0];
    expect(photo).toBeDefined();
    expect(typeof photo.body.photo).toBe("string");
    expect(photo.body.photo).toMatch(/^https?:\/\//);
    expect(photo.at).toBeGreaterThanOrEqual(sends()[0].at + PACING_CHAT_GAP_MS);
    const kinds = await t.run(async (ctx) => (await ctx.db.query("telegramDeliveries").collect()).map((d) => d.kind));
    expect(kinds).toEqual(["notification", "media"]);
  });

  test("imagem de 6 MB: linha com link para o CRM, nenhum sendPhoto", async () => {
    const s = await seed();
    const { messageId } = await inbound(s, { name: "grande.jpg", mimeType: "image/jpeg", size: 6 * MB }, { contentType: "image" });
    await relay(s, [messageId]);
    expect(of("sendPhoto")).toHaveLength(0);
    expect(sends().some((c) => /grande\.jpg \(6 MB\) passa do limite do Telegram/.test(c.body.text) && c.body.text.includes("/app/entrada?conversation="))).toBe(true);
  });

  test("áudio: transcrição na linha do cartão + sendVoice do OGG", async () => {
    const s = await seed();
    const { messageId } = await inbound(
      s,
      { name: "audio.ogg", mimeType: "audio/ogg; codecs=opus", size: 200_000 },
      { contentType: "audio", transcriptText: "pode mandar o contrato" },
    );
    await relay(s, [messageId]);
    expect(sends()[0].body.text).toContain("[áudio: pode mandar o contrato]");
    expect(of("sendVoice")).toHaveLength(1);
  });

  test("documento: sendDocument (upload com o nome real)", async () => {
    const s = await seed();
    const { messageId } = await inbound(s, { name: "contrato-assinado.pdf", mimeType: "application/pdf", size: 2.9 * MB }, { contentType: "file" });
    await relay(s, [messageId]);
    const doc = of("sendDocument")[0];
    expect(doc.body.document.name).toBe("contrato-assinado.pdf");
  });

  test("vídeo: só a linha '🎬 vídeo (abrir no CRM)'; figurinha: '[figurinha]'", async () => {
    const s = await seed();
    const video = await inbound(s, { name: "v.mp4", mimeType: "video/mp4", size: 3 * MB }, { contentType: "file" });
    const sticker = await inbound(s, { name: "s.webp", mimeType: "image/webp", size: 20_000 }, { contentType: "image", metadata: { whatsappType: "sticker" } });
    await relay(s, [video.messageId, sticker.messageId]);
    const text = sends()[0].body.text as string;
    expect(text).toContain("🎬 vídeo (abrir no CRM)");
    expect(text).toContain("[figurinha]");
    expect(calls.filter((c) => /^send(Photo|Video|Document|Voice|Audio)$/.test(c.method))).toHaveLength(0);
  });

  test("modo discreto e mediaInbound desligado: nenhuma mídia, só o texto", async () => {
    const s = await seed({ discreet: true });
    const { messageId } = await inbound(s, { name: "f.jpg", mimeType: "image/jpeg", size: 100_000 }, { contentType: "image" });
    await relay(s, [messageId]);
    expect(of("sendPhoto")).toHaveLength(0);
    expect(sends()).toHaveLength(1);
    expect(planMedia({ storageId: "x", name: "a.mp4", mimeType: "video/mp4", size: 1 }, "u")).toBeNull();
  });

  test("mídia do cliente encaminhada NÃO gasta a cota do membro (review #3): cota cheia e a foto sai mesmo assim", async () => {
    const s = await seed();
    const now = Date.now();
    const full = { hourStart: hourStartOf(now, TZ), filesThisHour: 30, dayKey: localDayKey(now, TZ), bytesToday: 0 };
    await t.run((ctx) => ctx.db.patch(s.linkId, { quota: full }));
    const { messageId } = await inbound(s, { name: "f.jpg", mimeType: "image/jpeg", size: 100_000 }, { contentType: "image" });
    await relay(s, [messageId]);
    expect(of("sendPhoto")).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(s.linkId)))!.quota).toEqual(full);
  });

  test("Ver tudo duas vezes: cada arquivo vai uma vez; na segunda, a linha com link", async () => {
    const s = await seed();
    await inbound(s, { name: "orcamento.jpg", mimeType: "image/jpeg", size: 100_000 }, { contentType: "image" });
    await t.run((ctx) =>
      ctx.db.insert("telegramDeliveries", {
        organizationId: s.organizationId, linkId: s.linkId, chatId: CHAT, messageId: 650, kind: "notification",
        conversationId: s.conversationId, sentAt: Date.now(),
      }),
    );
    const viewAll = () =>
      t.fetch("/webhooks/telegram/platform", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
        body: JSON.stringify({ update_id: seqView++, callback_query: { id: `v${seqView}`, from: { id: CHAT }, message: { message_id: 650, date: 1, chat: { id: CHAT, type: "private" } }, data: `va:${s.conversationId}` } }),
      });
    await viewAll();
    await drain();
    await viewAll();
    await drain();
    expect(of("sendPhoto")).toHaveLength(1);
    expect(sends().some((c) => /orcamento\.jpg \(já enviado acima\)/.test(c.body.text))).toBe(true);
  });
});

let seqView = 50_000;

// ── member → customer ──────────────────────────────────────────────────

let seq = 9000;
async function post(update: unknown) {
  const res = await t.fetch("/webhooks/telegram/platform", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify(update),
  });
  expect(res.status).toBe(200);
}
const tap = (messageId: number, data: string) =>
  post({ update_id: seq++, callback_query: { id: `cb${seq}`, from: { id: CHAT }, message: { message_id: messageId, date: 1, chat: { id: CHAT, type: "private" } }, data } });
const openReply = (s: Seed) =>
  t.run(async (ctx) => {
    const chat = await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT)).first();
    await ctx.db.patch(chat!._id, {
      pendingPrompt: {
        kind: "reply_customer", conversationId: s.conversationId, promptMessageId: 1,
        organizationId: s.organizationId, expiresAt: Date.now() + 15 * 60 * 1000,
      },
    });
  });
function sendDocument(name: string, mime: string, size: number, caption?: string) {
  const fileId = `doc-${seq}`;
  telegramFiles[fileId] = { size, path: `documents/${fileId}.bin` };
  return post({
    update_id: seq++,
    message: {
      message_id: seq, date: 1, chat: { id: CHAT, type: "private" }, from: { id: CHAT },
      document: { file_id: fileId, file_unique_id: `u${seq}`, file_name: name, mime_type: mime, file_size: size },
      ...(caption ? { caption } : {}),
    },
  });
}
/** Runs only what is due now (keeps the dispatch pending). */
async function step(n = 6) {
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(PACING_CHAT_GAP_MS);
    await t.finishInProgressScheduledFunctions();
  }
}

describe("Telegram → cliente pelo Responder (D25, §4.5)", () => {
  test("PDF de 3 MB: guardado pela porta do inbound, prévia, Enviar → internalSendMessageCore com o anexo e dispatch agendado", async () => {
    const s = await seed();
    await openReply(s);
    await sendDocument("contrato-carlos.pdf", "application/pdf", 3 * MB, "Carlos, segue o contrato pra assinatura");
    await step();
    const files = await t.run(async (ctx) => (await ctx.db.query("files").collect()).filter((f) => f.name === "contrato-carlos.pdf"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ fileType: "message_attachment", mimeType: "application/pdf", size: 3 * MB });
    const preview = sends().at(-1)!;
    expect(preview.body.text).toContain("Enviar para <b>Carlos Lima</b> no WhatsApp?");
    expect(preview.body.text).toContain("📄 contrato-carlos.pdf · 3 MB");
    expect(preview.body.text).toContain("Carlos, segue o contrato pra assinatura");
    const previewId = nextMessageId - 1;
    await tap(previewId, `ps:${s.conversationId}`);
    await step(2);
    const sent = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ contentType: "file", attachments: [files[0]._id], content: "Carlos, segue o contrato pra assinatura" });
    expect((sent[0].metadata as any).via).toBe("telegram");
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((j) => j.name.includes("internalDispatchMessage"))).toBe(true);
    expect(of("editMessageText").some((e) => /^✓ Enviado · \d\d:\d\d · 📄 contrato-carlos\.pdf/.test(e.body.text))).toBe(true);
  });

  test("dispatch que falha: o cartão vira '✗ Falhou' com link e a cota volta", async () => {
    const s = await seed();
    await openReply(s);
    await sendDocument("contrato.pdf", "application/pdf", 1 * MB);
    await step();
    expect((await t.run((ctx) => ctx.db.get(s.linkId)))!.quota?.filesThisHour).toBe(1);
    await tap(nextMessageId - 1, `ps:${s.conversationId}`);
    await step(3); // the tap runs before the drain jumps the clock past the prompt's expiry
    await drain();
    const last = of("editMessageText").at(-1)!;
    expect(last.body.text).toMatch(/^✗ Falhou: /);
    expect(JSON.stringify(last.body.reply_markup)).toContain("/app/entrada?conversation=");
    expect((await t.run((ctx) => ctx.db.get(s.linkId)))!.quota?.filesThisHour).toBe(0);
  });

  test("modo automático: o arquivo do membro ganha a contagem do D23 e sai com o anexo no prazo", async () => {
    const s = await seed();
    await t.run(async (ctx) => {
      const link = (await ctx.db.get(s.linkId))!;
      await ctx.db.patch(s.linkId, { assistant: { ...link.assistant, mode: "auto" } });
    });
    await openReply(s);
    await sendDocument("contrato.pdf", "application/pdf", 1 * MB, "segue");
    await step();
    const countdown = sends().at(-1)!;
    expect(countdown.body.text).toMatch(/^⏳ Enviando em 15 s → <b>Carlos Lima<\/b> \(WhatsApp\)\n📄 contrato\.pdf · 1 MB/);
    // Review F4 #5: the member's own file has nothing to regenerate.
    expect(JSON.stringify(countdown.body.reply_markup)).not.toContain("Regenerar");
    expect(JSON.stringify(countdown.body.reply_markup)).toContain("Cancelar envio");
    // Only the 15 s (a full drain would also jump past the prompt's 15 min expiry).
    vi.advanceTimersByTime(16_000);
    await t.finishInProgressScheduledFunctions();
    await step(3);
    const sent = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ contentType: "file", content: "segue" });
    expect((sent[0].metadata as any).via).toBe("telegram_auto");
  });

  test(".exe recusado com a cópia do §4.5; nada é baixado", async () => {
    const s = await seed();
    await openReply(s);
    await sendDocument("instalador.exe", "application/x-msdownload", 300_000);
    await drain();
    expect(sends().at(-1)!.body.text).toBe("🚫 Tipo de arquivo não permitido (.exe). Aceito PDF, imagens, áudio, Office, CSV, TXT e ZIP.");
    expect(getFiles()).toHaveLength(0);
  });

  test("24 MB recusado antes do download", async () => {
    const s = await seed();
    await openReply(s);
    await sendDocument("grande.pdf", "application/pdf", 24 * MB);
    await drain();
    expect(sends().at(-1)!.body.text).toBe("📦 Esse arquivo tem 24 MB; o máximo pelo Telegram é 20 MB. Mande pelo CRM.");
    expect(getFiles()).toHaveLength(0);
  });

  test("31º arquivo na hora: recusado com 'Libera às HH:00'; na hora seguinte passa", async () => {
    const s = await seed();
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.patch(s.linkId, { quota: { hourStart: hourStartOf(now, TZ), filesThisHour: 30, dayKey: localDayKey(now, TZ), bytesToday: 0 } }),
    );
    await openReply(s);
    await sendDocument("a.pdf", "application/pdf", 100_000);
    await drain();
    expect(sends().at(-1)!.body.text).toBe(
      "⏳ Você já enviou 30 arquivos nesta hora pelo Telegram. Libera às 12:00. Enquanto isso, use o CRM.",
    );
    expect(await t.run(async (ctx) => (await ctx.db.query("files").collect()).length)).toBe(0);
    vi.setSystemTime(new Date("2026-11-03T15:01:00Z")); // 12:01 local
    await openReply(s);
    await sendDocument("a.pdf", "application/pdf", 100_000);
    await step();
    expect(sends().at(-1)!.body.text).toContain("📄 a.pdf · ");
  });

  test("cancelar a prévia: arquivo e blob apagados, cota devolvida", async () => {
    const s = await seed();
    await openReply(s);
    await sendDocument("a.pdf", "application/pdf", 100_000);
    await step();
    await tap(nextMessageId - 1, `cp:${s.conversationId}`);
    await drain();
    expect(await t.run(async (ctx) => (await ctx.db.query("files").collect()).length)).toBe(0);
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(s.linkId)))!.quota?.filesThisHour).toBe(0);
  });

  test("documento sem Responder aberto: explica como mandar", async () => {
    await seed();
    await sendDocument("a.pdf", "application/pdf", 100_000);
    await drain();
    expect(sends().at(-1)!.body.text).toBe(COPY_DOCUMENT_WITHOUT_PROMPT);
    expect(getFiles()).toHaveLength(0);
  });

  test("vídeo no Responder: recusa do §4.5 com 'Abrir conversa'", async () => {
    const s = await seed();
    await openReply(s);
    await post({
      update_id: seq++,
      message: { message_id: seq, date: 1, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, video: { file_id: "v1", file_unique_id: "vu", width: 1, height: 1, duration: 3, file_size: 1000 } },
    });
    await drain();
    const last = sends().at(-1)!;
    expect(last.body.text).toBe("Ainda não envio vídeos pelo Telegram. Mande pelo CRM ou pelo WhatsApp.");
    expect(JSON.stringify(last.body.reply_markup)).toContain("Abrir conversa");
  });
});

describe("pacing (D25)", () => {
  test("30 envios no mesmo tick para um chat: espaçados ≥ 1 s e reagendados em vez de saírem juntos", async () => {
    await seed();
    const replies = Array.from({ length: 30 }, (_, i) => ({ chatId: CHAT, text: `msg ${i}` }));
    await t.action(internal.telegram.internalDeliverActionResult, { result: { replies, edits: [] } });
    expect(sends()).toHaveLength(1);
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.includes("internalDeliverReply") && j.state.kind === "pending"),
    );
    expect(pending).toHaveLength(1);
    await drain();
    const at = sends().map((c) => c.at);
    expect(at).toHaveLength(30);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(PACING_CHAT_GAP_MS);
  });

  test("30 chats diferentes no mesmo tick: teto global ≥ 40 ms entre envios", async () => {
    await seed();
    const replies = Array.from({ length: 30 }, (_, i) => ({ chatId: 20_000 + i, text: `msg ${i}` }));
    const start = Date.now();
    for (const r of replies) await t.action(internal.telegram.internalDeliverActionResult, { result: { replies: [r], edits: [] } });
    // Same tick: only the first goes now; the others are rescheduled AT their slots.
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    const slots = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((j) => j.name.includes("internalDeliverReply") && j.state.kind === "pending")
        .map((j) => j.scheduledTime),
    );
    const at = [start, ...slots].sort((a, b) => a - b);
    expect(at).toHaveLength(30);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(PACING_GLOBAL_GAP_MS);
    await drain();
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(30);
  });
});

describe("revogação apaga as mídias ≤ 48 h", () => {
  test("Desconectar: deleteMessage também nas mensagens de mídia", async () => {
    const s = await seed();
    const { messageId } = await inbound(s, { name: "f.jpg", mimeType: "image/jpeg", size: 100_000 }, { contentType: "image" });
    await relay(s, [messageId]);
    const mediaIds = await t.run(async (ctx) =>
      (await ctx.db.query("telegramDeliveries").collect()).filter((d) => d.kind === "media").map((d) => d.messageId),
    );
    expect(mediaIds).toHaveLength(1);
    await t.mutation(internal.telegram.internalRevokeLinksForMember, { teamMemberId: s.memberId, actorId: s.memberId });
    await drain();
    expect(of("deleteMessage").map((c) => c.body.message_id)).toEqual(expect.arrayContaining(mediaIds));
  });
});


// ── review F4 ──────────────────────────────────────────────────────────

const filesCount = () => t.run(async (ctx) => (await ctx.db.query("files").collect()).length);
const blobsCount = () => t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
const quotaOf = async (s: Seed) => (await t.run((ctx) => ctx.db.get(s.linkId)))!.quota;

describe("review F4", () => {
  test("#1 boleto.exe declarado como PDF: recusado antes do download", async () => {
    const s = await seed();
    await openReply(s);
    await sendDocument("boleto.exe", "application/pdf", 100_000);
    await drain();
    expect(sends().at(-1)!.body.text).toBe("🚫 Tipo de arquivo não permitido (.exe). Aceito PDF, imagens, áudio, Office, CSV, TXT e ZIP.");
    expect(getFiles()).toHaveLength(0);
  });

  test("#1 .pdf com bytes que não são PDF: recusado depois do download, sem blob, cota devolvida", async () => {
    const s = await seed();
    await openReply(s);
    const fileId = `doc-${seq}`;
    await sendDocument("fatura.pdf", "application/pdf", 50_000);
    telegramFiles[fileId].headBytes = [0x4d, 0x5a, 0x90, 0x00]; // "MZ": a Windows executable
    await drain();
    expect(getFiles()).toHaveLength(1);
    expect(sends().at(-1)!.body.text).toBe("🚫 Tipo de arquivo não permitido (.pdf). Aceito PDF, imagens, áudio, Office, CSV, TXT e ZIP.");
    expect(await filesCount()).toBe(0);
    expect(await blobsCount()).toBe(0);
    expect((await quotaOf(s))?.filesThisHour).toBe(0);
  });

  test("#2 PDF na prévia e mais nada: no vencimento o arquivo, o blob e a cota vão embora", async () => {
    const s = await seed();
    await openReply(s);
    await sendDocument("a.pdf", "application/pdf", 100_000);
    await step();
    expect(await filesCount()).toBe(1);
    expect((await quotaOf(s))?.filesThisHour).toBe(1);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1000);
    await t.finishInProgressScheduledFunctions();
    await drain();
    expect(await filesCount()).toBe(0);
    expect(await blobsCount()).toBe(0);
    expect((await quotaOf(s))?.filesThisHour).toBe(0);
    const chat = await t.run((ctx) => ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT)).first());
    expect(chat!.pendingPrompt).toBeUndefined();
  });

  test("#2 /sair com arquivo na prévia: arquivo, blob e cota liberados", async () => {
    const s = await seed();
    await openReply(s);
    await sendDocument("a.pdf", "application/pdf", 100_000);
    await step();
    expect(await filesCount()).toBe(1);
    await post({ update_id: seq++, message: { message_id: seq, date: 1, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text: "/sair" } });
    await step(3);
    expect(await filesCount()).toBe(0);
    expect(await blobsCount()).toBe(0);
    expect((await quotaOf(s))?.filesThisHour).toBe(0);
  });

  test("#3 cliente manda 30 fotos e o membro ainda manda o contrato", async () => {
    const s = await seed();
    for (let card = 0; card < 6; card++) {
      const ids: Id<"messages">[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await inbound(s, { name: `f${card}-${i}.jpg`, mimeType: "image/jpeg", size: 50_000 }, { contentType: "image" })).messageId);
      }
      await relay(s, ids);
    }
    expect(of("sendPhoto")).toHaveLength(30);
    expect((await quotaOf(s))?.filesThisHour ?? 0).toBe(0);
    await openReply(s);
    await sendDocument("contrato.pdf", "application/pdf", 1 * MB);
    await step();
    expect(sends().at(-1)!.body.text).toContain("📄 contrato.pdf · 1 MB");
  });

  test("#4 arquivo sem tamanho anunciado: reserva o teto e ajusta ao tamanho real", async () => {
    const s = await seed();
    await openReply(s);
    const fileId = `doc-${seq}`;
    // Telegram announces no size anywhere (update nor getFile).
    telegramFiles[fileId] = { size: 300_000, path: `documents/${fileId}.bin`, announce: false };
    await post({
      update_id: seq++,
      message: {
        message_id: seq, date: 1, chat: { id: CHAT, type: "private" }, from: { id: CHAT },
        document: { file_id: fileId, file_unique_id: `u${seq}`, file_name: "sem-tamanho.pdf", mime_type: "application/pdf" },
      },
    });
    await step();
    const quota = await quotaOf(s);
    expect(quota?.filesThisHour).toBe(1);
    expect(quota?.bytesToday).toBe(300_000);
    const org = await t.run(async (ctx) => (await ctx.db.query("telegramOrgQuota").collect())[0]);
    expect(org.bytes).toBe(300_000);
  });

  test("#5 cancelar o próprio envio no automático: o registro oferece Responder, nunca Regenerar", async () => {
    const s = await seed();
    await t.run(async (ctx) => {
      const link = (await ctx.db.get(s.linkId))!;
      await ctx.db.patch(s.linkId, { assistant: { ...link.assistant, mode: "auto" } });
    });
    await openReply(s);
    await sendDocument("a.pdf", "application/pdf", 100_000);
    await step();
    const countdownId = nextMessageId - 1;
    expect(JSON.stringify(sends().at(-1)!.body.reply_markup)).not.toContain("rg:");
    await tap(countdownId, `vc:${s.conversationId}`);
    await step(2);
    const record = of("editMessageText").at(-1)!;
    expect(record.body.text).toMatch(/^✖ Envio cancelado/);
    const markup = JSON.stringify(record.body.reply_markup);
    expect(markup).toContain(`rp:${s.conversationId}`);
    expect(markup).not.toContain("rg:");
    expect(await filesCount()).toBe(0);
  });

  test("#6 foto de 7 MB do membro é aceita e vira prévia (o teto de 5 MB é do relay)", async () => {
    const s = await seed();
    await openReply(s);
    const fileId = `ph-${seq}`;
    telegramFiles[fileId] = { size: 7 * MB, path: `photos/${fileId}.jpg`, headBytes: [0xff, 0xd8, 0xff, 0xe0] };
    await post({
      update_id: seq++,
      message: {
        message_id: seq, date: 1, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, caption: "o orçamento",
        photo: [{ file_id: fileId, file_unique_id: `u${seq}`, width: 4000, height: 3000, file_size: 7 * MB }],
      },
    });
    await step();
    expect(sends().at(-1)!.body.text).toMatch(/📎 foto-\d+\.jpg · 7 MB/);
    expect(await filesCount()).toBe(1);
  });

  test("#7 internalMarkDispatchFailed duas vezes: a cota volta uma vez só", async () => {
    const s = await seed();
    await openReply(s);
    await sendDocument("a.pdf", "application/pdf", 100_000);
    await step();
    await tap(nextMessageId - 1, `ps:${s.conversationId}`);
    await step(2);
    const sent = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).find((m) => m.direction === "outbound")!);
    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, { messageId: sent._id, detail: "janela da Meta fechada" });
    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, { messageId: sent._id, detail: "janela da Meta fechada" });
    const releases = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.includes("internalReleaseFileQuota")),
    );
    expect(releases).toHaveLength(1);
  });

  test("#7 fallback do botão de configurações também reivindica um slot de pacing", async () => {
    await seed();
    refuseUrlButtons = true;
    await t.action(internal.telegram.internalDeliverActionResult, {
      result: { replies: [{ chatId: CHAT, text: "Ative a IA", settingsButton: true }], edits: [] },
    });
    // The refused send used the first slot; the plain-link fallback waits for its own (1 s later).
    expect(sends()).toHaveLength(1);
    await drain();
    expect(sends()).toHaveLength(2);
    expect(sends()[1].body.text).toContain("/app/configuracoes");
    expect(sends()[1].at - sends()[0].at).toBeGreaterThanOrEqual(PACING_CHAT_GAP_MS);
  });
});
