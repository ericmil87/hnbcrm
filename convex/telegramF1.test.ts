/// <reference types="vite/client" />
/**
 * Copiloto no Telegram — F1: fan-out de `createNotification`, ações por botão
 * (reautorização D6, RBAC, corrida de aceite, org do cartão), prompts
 * (instruir/regenerar/responder), "mensagem vira registro", relay D20 (buffer
 * de 20 s, só com humano no comando, nunca grupo) e relay da IA na conversa em
 * foco. `fetch` SEMPRE stubado; token falso.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { createNotification } from "./lib/notify";
import { patchMemberPrefs } from "./lib/notificationPrefs";
import { maybeBufferInboundForRelay, maybeScheduleAiReplyRelay } from "./lib/telegramRelay";
import { handleTelegramPromptAnswer } from "./lib/telegramActions";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const FAKE_TOKEN = "123456:FAKE-TOKEN-f1";
const SECRET = "fake-telegram-webhook-secret-f1";
const APP = "https://app.example.test";
const CHAT_ADMIN = 8001;
const CHAT_SELLER = 8002;
const CHAT_VIEWER = 8003;

type Call = { method: string; body: Record<string, any> };
let calls: Call[];
let nextMessageId: number;
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", FAKE_TOKEN);
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "hnbcrm_test_bot");
  vi.stubEnv("APP_URL", APP);
  calls = [];
  nextMessageId = 900;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = u.split("/").pop() ?? "";
      const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (!u.includes("api.telegram.org")) {
        // Channel dispatch (WhatsApp/Meta) in tests: answer something harmless.
        return new Response(JSON.stringify({ messages: [{ id: "wamid.fake" }] }), { status: 200 });
      }
      calls.push({ method, body });
      const result = method === "sendMessage" ? { message_id: nextMessageId++ } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
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
const sends = (chatId?: number) => calls.filter((c) => c.method === "sendMessage" && (chatId === undefined || c.body.chat_id === chatId));
const edits = (chatId?: number) => calls.filter((c) => c.method === "editMessageText" && (chatId === undefined || c.body.chat_id === chatId));
const callbackDatas = (c: Call) =>
  ((c.body.reply_markup?.inline_keyboard ?? []) as any[][]).flat().map((b) => b.callback_data ?? b.url);

// ── seed ────────────────────────────────────────────────────────────────

type Seed = Awaited<ReturnType<typeof seedOrg>>;

async function seedOrg(opts: { slug?: string; aiOn?: boolean; telegram?: boolean; userIds?: { admin?: Id<"users"> } } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adminUserId = opts.userIds?.admin ?? (await ctx.db.insert("users", { email: `admin-${opts.slug ?? "a"}@acme.test` }));
    const sellerUserId = await ctx.db.insert("users", { email: `seller-${opts.slug ?? "a"}@acme.test` });
    const viewerUserId = await ctx.db.insert("users", { email: `viewer-${opts.slug ?? "a"}@acme.test` });
    const organizationId = await ctx.db.insert("organizations", {
      name: opts.slug === "b" ? "Org B" : "Acme Corp",
      slug: opts.slug ?? "acme",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        modules: { telegram: opts.telegram ?? true },
        ...(opts.aiOn ? { aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 } } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const human = (userId: Id<"users">, name: string, role: "admin" | "agent", extra: Record<string, unknown> = {}) =>
      ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active", createdAt: now, updatedAt: now, ...extra,
      });
    const adminId = await human(adminUserId, "Eric", "admin");
    const sellerId = await human(sellerUserId, "Vendedor", "agent");
    const viewerId = await human(viewerUserId, "Leitor", "agent", {
      permissions: {
        leads: "view_own", contacts: "view", inbox: "view_own", tasks: "view_own",
        reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none",
      },
    });
    if (opts.aiOn) {
      const org = (await ctx.db.get(organizationId))!;
      await ctx.db.patch(organizationId, {
        settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } } },
      });
    }
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" }, createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Principal",
      phoneNumberId: `pn-${opts.slug ?? "a"}`, status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Proposta", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false,
      createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Maria", lastName: "Souza", whatsappNumber: "5511987654321", tags: [],
      createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Maria Souza", contactId, boardId, stageId, assignedTo: agentId, value: 4800,
      currency: "BRL", priority: "medium", temperature: "warm", tags: [], customFields: {},
      conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active",
      lastInboundAt: now, messageCount: 1, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("messages", {
      organizationId, conversationId, leadId, direction: "inbound", senderType: "contact",
      content: "Vocês fazem 15% no anual?", contentType: "text", isInternal: false, createdAt: now - 60_000,
    });
    return {
      organizationId, adminUserId, sellerUserId, viewerUserId, adminId, sellerId, viewerId, agentId,
      configId, boardId, stageId, contactId, leadId, conversationId,
    };
  });
}

async function linkMember(s: Pick<Seed, "organizationId">, memberId: Id<"teamMembers">, userId: Id<"users">, chatId: number, extra: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const linkId = await ctx.db.insert("telegramLinks", {
      organizationId: s.organizationId, teamMemberId: memberId, userId, chatId, telegramUserId: chatId,
      status: "active",
      prefs: { relayAssignedConversations: true, mediaInbound: true },
      assistant: {
        mode: "suggest", suggestOnEvents: true, autoSendDelaySeconds: 15,
        autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
      },
      reports: { enabled: true, morningHour: 8, eveningHour: 18 },
      linkedAt: now, lastSeenAt: now, ...extra,
    });
    const chat = await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", chatId)).first();
    if (chat) {
      await ctx.db.patch(chat._id, { activeOrganizationId: s.organizationId, activeTeamMemberId: memberId });
    } else {
      await ctx.db.insert("telegramChats", {
        chatId, telegramUserId: chatId, activeOrganizationId: s.organizationId, activeTeamMemberId: memberId, updatedAt: now,
      });
    }
    return linkId;
  });
}

async function seedHandoff(s: Seed, recipients: Id<"teamMembers">[]) {
  return await t.run(async (ctx) => {
    const handoffId = await ctx.db.insert("handoffs", {
      organizationId: s.organizationId, leadId: s.leadId, conversationId: s.conversationId,
      fromMemberId: s.agentId, reason: "pediu desconto e quer falar com uma pessoa",
      suggestedActions: [], origin: "ai_tool", status: "pending", createdAt: Date.now(),
    });
    for (const memberId of recipients) {
      await createNotification(ctx, {
        organizationId: s.organizationId, memberId, type: "handoff_requested",
        title: "Repasse: Maria Souza", handoffId, conversationId: s.conversationId, actorId: s.agentId,
      });
    }
    return handoffId;
  });
}

/** The Telegram message id of the card delivered to `chatId` for this handoff/notification. */
async function cardOf(chatId: number, by: { handoffId?: Id<"handoffs">; taskId?: Id<"tasks">; kind?: string }) {
  const rows = await t.run((ctx) => ctx.db.query("telegramDeliveries").collect());
  const row = rows.find(
    (d) =>
      d.chatId === chatId &&
      (by.handoffId ? d.handoffId === by.handoffId : true) &&
      (by.taskId ? d.taskId === by.taskId : true) &&
      (by.kind ? d.kind === by.kind : true),
  );
  expect(row, `card for chat ${chatId}`).toBeDefined();
  return row!.messageId;
}

let updateSeq = 5000;
async function post(update: unknown) {
  const res = await t.fetch("/webhooks/telegram/platform", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify(update),
  });
  expect(res.status).toBe(200);
  await drain();
}
const tap = (chatId: number, messageId: number, data: string) =>
  post({
    update_id: updateSeq++,
    callback_query: {
      id: `cbq-${updateSeq}`,
      from: { id: chatId, first_name: "Eric" },
      message: { message_id: messageId, date: 1, chat: { id: chatId, type: "private" } },
      data,
    },
  });
const say = (chatId: number, text: string) =>
  post({
    update_id: updateSeq++,
    message: { message_id: updateSeq, date: 1, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Eric" }, text },
  });

// ── tests ───────────────────────────────────────────────────────────────

describe("fan-out (D7)", () => {
  test("membro com vínculo recebe o cartão com botões e a entrega é registrada", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    const [card] = sends(CHAT_ADMIN);
    expect(card.body.parse_mode).toBe("HTML");
    expect(card.body.text).toContain("🔔 <b>Repasse da IA</b>");
    expect(card.body.text).toContain("<b>Maria Souza</b>\nWhatsApp · +55 11 98765-4321");
    expect(callbackDatas(card)).toEqual(
      expect.arrayContaining([`ah:${handoffId}`, `ia:${s.conversationId}`, "https://wa.me/5511987654321"]),
    );
    const deliveries = await t.run((ctx) => ctx.db.query("telegramDeliveries").collect());
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ kind: "notification", handoffId, chatId: CHAT_ADMIN, messageId: 900 });
  });

  test("sem vínculo, mutado ou módulo desligado: nada é agendado nem enviado", async () => {
    const s = await seedOrg();
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER, { mutedUntil: Date.now() + 3600_000 });
    // C1 (E3): pedido de ajuda fura a pausa por padrão; aqui o seller desligou a exceção.
    await t.run((ctx) => patchMemberPrefs(ctx, s.organizationId, s.sellerId, { urgentBypass: false }, Date.now()));
    await seedHandoff(s, [s.adminId, s.sellerId]); // admin sem vínculo, seller mutado
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((j) => j.name.includes("internalDeliverNotification"))).toHaveLength(0);

    const off = await seedOrg({ slug: "off", telegram: false });
    await linkMember(off, off.adminId, off.adminUserId, 8100);
    await seedHandoff(off, [off.adminId]);
    await drain();
    expect(sends()).toEqual([]);
  });

  test("new_message com newMessage = false: o sino registra, o Telegram não envia (C1)", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("notificationPreferences", {
        organizationId: s.organizationId, teamMemberId: s.adminId, invite: true, handoffRequested: true,
        handoffResolved: true, taskOverdue: true, taskAssigned: true, leadAssigned: true, newMessage: false,
        dailyDigest: true, createdAt: now, updatedAt: now,
      });
      await createNotification(ctx, {
        organizationId: s.organizationId, memberId: s.adminId, type: "new_message", title: "Maria · WhatsApp",
        conversationId: s.conversationId,
      });
    });
    await drain();
    expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toHaveLength(1);
    expect(sends()).toEqual([]);
  });
});

describe("ações por botão (D6/D8)", () => {
  test("aceitar: porta única, auditoria via telegram e o cartão vira registro", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    const msg = await cardOf(CHAT_ADMIN, { handoffId });
    await tap(CHAT_ADMIN, msg, `ah:${handoffId}`);
    const h = await t.run((ctx) => ctx.db.get(handoffId));
    expect(h).toMatchObject({ status: "accepted", acceptedBy: s.adminId });
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.entityId === handoffId && a.metadata?.via === "telegram")).toBe(true);
    const [e] = edits(CHAT_ADMIN);
    expect(e.body.message_id).toBe(msg);
    expect(e.body.text).toMatch(/^✅ Aceito por você · \d\d:\d\d/);
    expect(callbackDatas(e)).toEqual(expect.arrayContaining([`rp:${s.conversationId}`, `ia:${s.conversationId}`]));
    const chat = await t.run((ctx) => ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first());
    expect(chat?.focus?.conversationId).toBe(s.conversationId);
  });

  test("agente sem inbox:reply recebe a cópia §4.10 e nada é escrito", async () => {
    const s = await seedOrg();
    await linkMember(s, s.viewerId, s.viewerUserId, CHAT_VIEWER);
    const handoffId = await seedHandoff(s, [s.viewerId]);
    await drain();
    const msg = await cardOf(CHAT_VIEWER, { handoffId });
    calls = [];
    await tap(CHAT_VIEWER, msg, `ah:${handoffId}`);
    expect((await t.run((ctx) => ctx.db.get(handoffId)))!.status).toBe("pending");
    expect(sends(CHAT_VIEWER)[0].body.text).toBe(
      '🚫 Você não tem permissão para isso (perfil "agent" sem inbox:reply). Fale com um admin da Acme Corp.',
    );
    expect(edits()).toEqual([]);
  });

  test("corrida: quem perde vê 'já aceito', a cópia do vencedor fica intacta", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER);
    const handoffId = await seedHandoff(s, [s.adminId, s.sellerId]);
    await drain();
    const adminMsg = await cardOf(CHAT_ADMIN, { handoffId });
    const sellerMsg = await cardOf(CHAT_SELLER, { handoffId });

    await tap(CHAT_SELLER, sellerMsg, `ah:${handoffId}`);
    // Ao aceitar, a cópia do admin vira o registro "✅ Aceito por Vendedor" sem botões de ação
    // (gancho do acceptHandoffCore → internalMarkHandoffCards).
    const adminEdit = edits(CHAT_ADMIN).find((e) => e.body.message_id === adminMsg)!;
    expect(adminEdit.body.text).toMatch(/^✅ Aceito por Vendedor · \d\d:\d\d/);
    expect(callbackDatas(adminEdit).some((d) => String(d).startsWith("ah:"))).toBe(false);

    calls = [];
    await tap(CHAT_ADMIN, adminMsg, `ah:${handoffId}`);
    expect((await t.run((ctx) => ctx.db.get(handoffId)))!.acceptedBy).toBe(s.sellerId);
    expect(edits(CHAT_ADMIN)[0].body.text).toContain("⚠️ Repasse já aceito por Vendedor");
    expect(edits(CHAT_SELLER)).toEqual([]); // a do vencedor não é tocada
  });

  test("membro busy age; membro removido não age e perde o vínculo", async () => {
    const s = await seedOrg();
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER);
    await t.run((ctx) => ctx.db.patch(s.sellerId, { status: "busy" }));
    const h1 = await seedHandoff(s, [s.sellerId]);
    await drain();
    await tap(CHAT_SELLER, await cardOf(CHAT_SELLER, { handoffId: h1 }), `ah:${h1}`);
    expect((await t.run((ctx) => ctx.db.get(h1)))!.status).toBe("accepted");

    const h2 = await seedHandoff(s, [s.sellerId]);
    await drain();
    const msg = await cardOf(CHAT_SELLER, { handoffId: h2 });
    await t.run((ctx) => ctx.db.patch(s.sellerId, { removedAt: Date.now(), status: "inactive" }));
    await tap(CHAT_SELLER, msg, `ah:${h2}`);
    expect((await t.run((ctx) => ctx.db.get(h2)))!.status).toBe("pending");
    const links = await t.run((ctx) => ctx.db.query("telegramLinks").collect());
    expect(links.find((l) => l.teamMemberId === s.sellerId)?.status).toBe("revoked");
  });

  test("cartão da org B tocado com a org A ativa age na org B", async () => {
    const a = await seedOrg();
    const b = await seedOrg({ slug: "b", userIds: { admin: a.adminUserId } });
    await linkMember(b, b.adminId, a.adminUserId, CHAT_ADMIN);
    await linkMember(a, a.adminId, a.adminUserId, CHAT_ADMIN); // A fica ativa
    const handoffB = await seedHandoff(b, [b.adminId]);
    await drain();
    const chat = await t.run((ctx) => ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first());
    expect(chat?.activeOrganizationId).toBe(a.organizationId);
    await tap(CHAT_ADMIN, await cardOf(CHAT_ADMIN, { handoffId: handoffB }), `ah:${handoffB}`);
    expect(await t.run((ctx) => ctx.db.get(handoffB))).toMatchObject({ status: "accepted", acceptedBy: b.adminId });
  });

  test("callback forjado com id de outra tabela não acha nada", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    calls = [];
    await tap(CHAT_ADMIN, await cardOf(CHAT_ADMIN, { handoffId }), `ah:${s.conversationId}`);
    expect(sends(CHAT_ADMIN)[0].body.text).toMatch(/Não encontrei este item/);
    expect((await t.run((ctx) => ctx.db.get(handoffId)))!.status).toBe("pending");
  });
});

describe("prompts (§3.4)", () => {
  test("instruir a IA no repasse: prompt, teto de 2000, devolve com instrução", async () => {
    const s = await seedOrg(); // IA desligada: o turno instruído agendado vira no-op
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    const card = await cardOf(CHAT_ADMIN, { handoffId });
    calls = [];
    await tap(CHAT_ADMIN, card, `ia:${s.conversationId}`);
    const prompt = sends(CHAT_ADMIN)[0];
    expect(prompt.body.text).toContain("🤖 Diga à IA o que fazer com <b>Maria Souza</b>");
    expect(callbackDatas(prompt)).toEqual([`ni:${s.conversationId}`, `cp:${s.conversationId}`]);
    const chat = await t.run((ctx) => ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first());
    expect(chat?.pendingPrompt).toMatchObject({ kind: "instruct_ai", cardMessageId: card });
    expect(chat?.pendingPrompt?.promptMessageId).toBeGreaterThan(card);

    calls = [];
    await say(CHAT_ADMIN, "x".repeat(2431));
    expect(sends(CHAT_ADMIN)[0].body.text).toBe("⏳ A instrução tem 2.431 caracteres; o máximo é 2.000. Resuma e mande de novo.");
    expect((await t.run((ctx) => ctx.db.get(handoffId)))!.status).toBe("pending");

    calls = [];
    await say(CHAT_ADMIN, "diz que o desconto de 10% vale até sexta");
    const h = await t.run((ctx) => ctx.db.get(handoffId));
    expect(h).toMatchObject({ status: "rejected", notes: "diz que o desconto de 10% vale até sexta" });
    expect(sends(CHAT_ADMIN).map((c) => c.body.text)).toContain(
      "🤖 Instrução enviada. A IA responde em instantes e eu te mostro.",
    );
    const cardEdit = edits(CHAT_ADMIN).find((e) => e.body.message_id === card)!;
    expect(cardEdit.body.text).toMatch(/^🤖 Devolvido à IA por você · \d\d:\d\d · instrução: "diz que o desconto/);
    const after = await t.run((ctx) => ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first());
    expect(after?.pendingPrompt).toBeUndefined();
  });

  test("prompt expirado não age", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    await tap(CHAT_ADMIN, await cardOf(CHAT_ADMIN, { handoffId }), `ia:${s.conversationId}`);
    vi.advanceTimersByTime(16 * 60 * 1000);
    calls = [];
    await say(CHAT_ADMIN, "faz assim");
    expect(sends(CHAT_ADMIN)[0].body.text).toBe("⌛ Este pedido expirou. Toque no botão do cartão de novo.");
    expect((await t.run((ctx) => ctx.db.get(handoffId)))!.status).toBe("pending");
  });

  test("responder: prévia primeiro, envia só no toque, mensagem sai com via telegram", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    // Aceita (humano no comando) e então responde pelo cartão-registro.
    const card = await cardOf(CHAT_ADMIN, { handoffId });
    await tap(CHAT_ADMIN, card, `ah:${handoffId}`);
    await tap(CHAT_ADMIN, card, `rp:${s.conversationId}`);
    calls = [];
    await say(CHAT_ADMIN, "Oi Maria! Segue a chave Pix.");
    const preview = sends(CHAT_ADMIN)[0];
    expect(preview.body.text).toContain("Enviar para <b>Maria Souza</b> no WhatsApp?");
    const outboundBefore = await t.run(async (ctx) =>
      (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound"),
    );
    expect(outboundBefore).toEqual([]);
    const pending = await t.run((ctx) =>
      ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first(),
    );
    expect(pending?.pendingPrompt?.draftText).toBe("Oi Maria! Segue a chave Pix.");
    await tap(CHAT_ADMIN, pending!.pendingPrompt!.promptMessageId, `ps:${s.conversationId}`);
    const out = await t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ content: "Oi Maria! Segue a chave Pix.", senderId: s.adminId, senderType: "human" });
    expect(out[0].metadata?.via).toBe("telegram");
  });
});

describe("tarefas e Ver tudo", () => {
  test("concluir, adiar 1h e Ver tudo editam o mesmo cartão", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const taskId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "Ligar para a Maria", type: "task", status: "pending",
        priority: "medium", leadId: s.leadId, assignedTo: s.adminId, createdBy: s.sellerId, dueDate: now + 3600_000,
        createdAt: now, updatedAt: now,
      } as any);
      await createNotification(ctx, {
        organizationId: s.organizationId, memberId: s.adminId, type: "task_assigned", title: "Nova tarefa", taskId: id,
      });
      return id;
    });
    await drain();
    const msg = await cardOf(CHAT_ADMIN, { taskId });
    await tap(CHAT_ADMIN, msg, `sz1:${taskId}`);
    const snoozed = await t.run((ctx) => ctx.db.get(taskId));
    expect(snoozed!.snoozedUntil).toBe(Date.now() + 3600_000);
    expect(edits(CHAT_ADMIN).at(-1)!.body.text).toContain("⏰ Adiada para");
    await tap(CHAT_ADMIN, msg, `ct:${taskId}`);
    expect((await t.run((ctx) => ctx.db.get(taskId)))!.status).toBe("completed");
    expect(edits(CHAT_ADMIN).at(-1)!.body.text).toMatch(/✅ Concluída por você/);
  });

  test("Ver tudo mostra o histórico e Resumir volta ao cartão", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    const msg = await cardOf(CHAT_ADMIN, { handoffId });
    await tap(CHAT_ADMIN, msg, `va:${s.conversationId}`);
    const hist = edits(CHAT_ADMIN).at(-1)!;
    expect(hist.body.text).toContain("últimas 1 mensagens");
    expect(hist.body.text).toContain("<b>Maria</b>");
    expect(callbackDatas(hist)[0]).toBe(`rs:${s.conversationId}`);
    await tap(CHAT_ADMIN, msg, `rs:${s.conversationId}`);
    expect(edits(CHAT_ADMIN).at(-1)!.body.text).toContain("🔔 <b>Repasse da IA</b>");
  });
});

describe("relay (D20)", () => {
  async function inbound(s: Seed, content: string) {
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId,
      content, skipAiEnqueue: true,
    });
  }
  const buffers = () => t.run((ctx) => ctx.db.query("telegramRelayBuffer").collect());

  test("só com humano no comando: IA no comando, sem dono, grupo → nada; sem vínculo ou pref desligada → só o sino (B2)", async () => {
    const s = await seedOrg({ aiOn: true });
    // IA no comando (lead do atendente, sem pausa).
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await t.run((ctx) => ctx.db.patch(s.conversationId, { assignedTo: s.adminId }));
    await inbound(s, "oi");
    expect(await buffers()).toEqual([]);
    // Sem dono humano.
    await t.run((ctx) => ctx.db.patch(s.leadId, { assignedTo: undefined }));
    await t.run((ctx) => ctx.db.patch(s.conversationId, { assignedTo: undefined }));
    await inbound(s, "oi");
    expect(await buffers()).toEqual([]);
    // Dono humano sem vínculo: B2 — o buffer é por membro, o sino recebe.
    await t.run((ctx) => ctx.db.patch(s.leadId, { assignedTo: s.sellerId }));
    await inbound(s, "oi");
    expect((await buffers()).map((b) => b.memberId)).toEqual([s.sellerId]);
    await drain();
    const bell = () =>
      t.run((ctx) => ctx.db.query("notifications").withIndex("by_member_and_created", (q) => q.eq("memberId", s.sellerId)).collect());
    expect((await bell()).map((n) => n.type)).toEqual(["new_message"]);
    expect(sends()).toEqual([]);
    // Dono com vínculo mas preferência do relay desligada: sino sim, Telegram não.
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER, {
      prefs: { relayAssignedConversations: false, mediaInbound: true },
    });
    await inbound(s, "oi de novo");
    await drain();
    expect(await bell()).toHaveLength(1); // agrupada na mesma não lida
    expect((await bell())[0].data?.count).toBe(2);
    expect(sends(CHAT_SELLER)).toEqual([]);
    expect(await buffers()).toEqual([]);
    // Grupo: nunca.
    await t.run(async (ctx) => {
      const now = Date.now();
      const groupConv = await ctx.db.insert("conversations", {
        organizationId: s.organizationId, kind: "group", channel: "whatsapp", status: "active",
        assignedTo: s.adminId, aiPausedUntil: Number.MAX_SAFE_INTEGER, messageCount: 0, createdAt: now, updatedAt: now,
      });
      const m = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: groupConv, direction: "inbound", senderType: "contact",
        content: "oi grupo", contentType: "text", isInternal: false, createdAt: now,
      });
      await maybeBufferInboundForRelay(ctx, (await ctx.db.get(groupConv))!, null, m, now);
    });
    expect(await buffers()).toEqual([]);
  });

  test("3 mensagens em 20 s viram UMA notificação e UMA mensagem no Telegram", async () => {
    const s = await seedOrg({ aiOn: true });
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await t.run((ctx) => ctx.db.patch(s.leadId, { assignedTo: s.adminId })); // humano no comando
    await inbound(s, "Pix!");
    vi.advanceTimersByTime(5_000);
    await inbound(s, "Me manda a chave");
    await inbound(s, "que eu pago hoje");
    const [buffer] = await buffers();
    expect(buffer.messageIds).toHaveLength(3);
    await drain();
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "new_message", memberId: s.adminId, conversationId: s.conversationId });
    expect((notes[0].data as any).messageIds).toHaveLength(3);
    const tg = sends(CHAT_ADMIN);
    expect(tg).toHaveLength(1);
    expect(tg[0].body.text).toContain('"Pix!"\n"Me manda a chave"\n"que eu pago hoje"');
    expect(callbackDatas(tg[0])).toEqual(
      expect.arrayContaining([`rp:${s.conversationId}`, `ia:${s.conversationId}`, "https://wa.me/5511987654321"]),
    );
    expect(await buffers()).toEqual([]);
  });

  test("0.77.2: só a resposta da instrução pedida pelo Telegram volta, uma vez, a quem pediu (com a linha de fecho)", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER);
    const now = Date.now();
    await t.run(async (ctx) => {
      const chat = await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first();
      await ctx.db.patch(chat!._id, { focus: { conversationId: s.conversationId, setAt: now, source: "notification" } });
    });
    const messageId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.agentId, senderType: "ai", content: "Oi Maria! Consigo 10% até sexta.", contentType: "text",
        isInternal: false, metadata: { aiReply: { requestedVia: "telegram", instructedBy: s.adminId } }, createdAt: now,
      });
      await maybeScheduleAiReplyRelay(ctx, (await ctx.db.get(s.conversationId))!, id, { requestedVia: "telegram", instructedBy: s.adminId });
      return id;
    });
    await drain();
    expect(sends(CHAT_ADMIN)).toHaveLength(1);
    expect(sends(CHAT_ADMIN)[0].body.text).toMatch(/^🤖 IA → <b>Maria Souza<\/b>/);
    expect(sends(CHAT_ADMIN)[0].body.text).toContain(
      "✅ O Atendente voltou a conduzir a conversa. Se precisar de você de novo, o repasse chega aqui.",
    );
    expect(sends(CHAT_SELLER)).toEqual([]);
    // De novo para a mesma mensagem: dedupe.
    await t.action(internal.telegram.internalRelayAiReply, { messageId });
    expect(sends(CHAT_ADMIN)).toHaveLength(1);
  });
});

describe("resposta da IA a pedido do próprio membro (C1)", () => {
  test("chega mesmo com newMessage=false, preset none, silêncio ativo e pausa", async () => {
    const s = await seedOrg({ aiOn: true });
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN, { mutedUntil: Date.now() + 3600_000 });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("notificationPreferences", {
        organizationId: s.organizationId, teamMemberId: s.adminId, invite: true, handoffRequested: true,
        handoffResolved: true, taskOverdue: true, taskAssigned: true, leadAssigned: true, newMessage: false,
        dailyDigest: true, preset: "none", pausedUntil: now + 3600_000,
        quietHours: { enabled: true, start: "00:00", end: "23:59", timeZone: "UTC" },
        createdAt: now, updatedAt: now,
      });
    });
    const messageId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.agentId, senderType: "ai", content: "Oi Maria! Consigo 10% até sexta.", contentType: "text",
        isInternal: false, metadata: { aiReply: { requestedVia: "telegram", instructedBy: s.adminId } }, createdAt: Date.now(),
      });
      return id;
    });
    await t.action(internal.telegram.internalRelayAiReply, { messageId });
    expect(sends(CHAT_ADMIN)).toHaveLength(1);
    expect(sends(CHAT_ADMIN)[0].body.text).toMatch(/^🤖 IA → /);
  });
});

describe("opções da org (API do card)", () => {
  test("updateOrgTelegramSettings: só settings:manage; getMyLink reflete", async () => {
    const s = await seedOrg();
    const as = (u: Id<"users">) => t.withIdentity({ subject: `${u}|s1` });
    await expect(
      as(s.sellerUserId).mutation(api.telegram.updateOrgTelegramSettings, { organizationId: s.organizationId, discreet: true }),
    ).rejects.toThrow(/Permissão insuficiente/);
    await as(s.adminUserId).mutation(api.telegram.updateOrgTelegramSettings, {
      organizationId: s.organizationId, discreet: true, allowAutoMode: false,
    });
    const me = await as(s.adminUserId).query(api.telegram.getMyLink, { organizationId: s.organizationId });
    expect(me.org).toEqual({ discreet: true, protectContent: false, allowAutoMode: false });
    expect(me.canManage).toBe(true);
    expect((await as(s.sellerUserId).query(api.telegram.getMyLink, { organizationId: s.organizationId })).canManage).toBe(false);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.metadata?.event === "telegram.settings_updated")).toBe(true);
  });
});

describe("revisão F1 — lote 1", () => {
  const as = (u: Id<"users">) => t.withIdentity({ subject: `${u}|s1` });
  const chatOf = (chatId: number) =>
    t.run((ctx) => ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", chatId)).first());

  test("#2/#5 aceite pelo app edita as cópias vivas; vínculo revogado fica de fora", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const viewerLink = await linkMember(s, s.viewerId, s.viewerUserId, CHAT_VIEWER);
    const handoffId = await seedHandoff(s, [s.adminId, s.viewerId]);
    await drain();
    const adminMsg = await cardOf(CHAT_ADMIN, { handoffId });
    await t.run((ctx) => ctx.db.patch(viewerLink, { status: "revoked" }));
    calls = [];
    await as(s.sellerUserId).mutation(api.handoffs.acceptHandoff, { handoffId });
    await drain();
    const e = edits(CHAT_ADMIN).find((x) => x.body.message_id === adminMsg)!;
    expect(e.body.text).toMatch(/^✅ Aceito por Vendedor · \d\d:\d\d/);
    expect(callbackDatas(e).some((d) => /^(ah|ia|rg):/.test(String(d)))).toBe(false);
    expect(callbackDatas(e)).toEqual(expect.arrayContaining([`va:${s.conversationId}`, "https://wa.me/5511987654321"]));
    expect(edits(CHAT_VIEWER)).toEqual([]);
  });

  test("#1 cartão velho: Instruir, Devolver e Assumir não tiram a conversa de quem assumiu", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    const card = await cardOf(CHAT_ADMIN, { handoffId });
    // Prompt aberto ANTES de a Ana (Vendedor) aceitar pelo app.
    await tap(CHAT_ADMIN, card, `ia:${s.conversationId}`);
    await as(s.sellerUserId).mutation(api.handoffs.acceptHandoff, { handoffId });
    await drain();
    calls = [];
    await say(CHAT_ADMIN, "devolve pra IA e oferece 10%");
    expect(sends(CHAT_ADMIN)[0].body.text).toMatch(/^⚠️ Vendedor assumiu esta conversa às \d\d:\d\d\.$/);
    expect(edits(CHAT_ADMIN).find((x) => x.body.message_id === card)!.body.text).toMatch(/^⚠️ Vendedor assumiu/);
    const after = async () => ({
      conv: await t.run((ctx) => ctx.db.get(s.conversationId)),
      lead: await t.run((ctx) => ctx.db.get(s.leadId)),
    });
    let st = await after();
    expect(st.lead!.assignedTo).toBe(s.sellerId);
    expect(st.conv!.aiPausedUntil).toBe(Number.MAX_SAFE_INTEGER);
    expect((await chatOf(CHAT_ADMIN))?.pendingPrompt).toBeUndefined();

    // Tocar "Instruir a IA" de novo no cartão velho: recusa sem abrir prompt.
    calls = [];
    await tap(CHAT_ADMIN, card, `ia:${s.conversationId}`);
    expect(sends(CHAT_ADMIN)[0].body.text).toMatch(/^⚠️ Vendedor assumiu/);
    expect((await chatOf(CHAT_ADMIN))?.pendingPrompt).toBeUndefined();
    // "Devolver sem instrução" e "Assumir eu" também recusam.
    await tap(CHAT_ADMIN, card, `ni:${s.conversationId}`);
    await tap(CHAT_ADMIN, card, `ae:${s.conversationId}`);
    st = await after();
    expect(st.lead!.assignedTo).toBe(s.sellerId);
    expect(st.conv!.aiPausedUntil).toBe(Number.MAX_SAFE_INTEGER);
    expect(sends(CHAT_ADMIN).filter((c) => /assumiu esta conversa/.test(c.body.text))).toHaveLength(3);
  });

  test("#3 'Enviar' numa prévia antiga não envia o texto mais novo", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    const card = await cardOf(CHAT_ADMIN, { handoffId });
    await tap(CHAT_ADMIN, card, `ah:${handoffId}`);
    await tap(CHAT_ADMIN, card, `rp:${s.conversationId}`);
    await say(CHAT_ADMIN, "primeira versão");
    const first = (await chatOf(CHAT_ADMIN))!.pendingPrompt!.promptMessageId;
    await say(CHAT_ADMIN, "segunda versão");
    const second = (await chatOf(CHAT_ADMIN))!.pendingPrompt!.promptMessageId;
    expect(second).not.toBe(first);
    calls = [];
    await tap(CHAT_ADMIN, first, `ps:${s.conversationId}`);
    expect(sends(CHAT_ADMIN)[0].body.text).toMatch(/não é mais a atual/);
    const outbound = () => t.run(async (ctx) => (await ctx.db.query("messages").collect()).filter((m) => m.direction === "outbound"));
    expect(await outbound()).toEqual([]);
    await tap(CHAT_ADMIN, second, `ps:${s.conversationId}`);
    expect((await outbound()).map((m) => m.content)).toEqual(["segunda versão"]);
  });

  test("#6 id forjado de OUTRA org (ah, ct, va) não age nem vaza", async () => {
    const a = await seedOrg();
    const b = await seedOrg({ slug: "b" });
    await linkMember(a, a.adminId, a.adminUserId, CHAT_ADMIN);
    const handoffA = await seedHandoff(a, [a.adminId]);
    await drain();
    const card = await cardOf(CHAT_ADMIN, { handoffId: handoffA });
    const handoffB = await seedHandoff(b, []);
    const taskB = await t.run((ctx) =>
      ctx.db.insert("tasks", {
        organizationId: b.organizationId, title: "Tarefa da org B", type: "task", status: "pending",
        priority: "medium", createdBy: b.adminId, createdAt: Date.now(), updatedAt: Date.now(),
      } as any),
    );
    calls = [];
    await tap(CHAT_ADMIN, card, `ah:${handoffB}`);
    await tap(CHAT_ADMIN, card, `ct:${taskB}`);
    await tap(CHAT_ADMIN, card, `va:${b.conversationId}`);
    expect(sends(CHAT_ADMIN).map((c) => c.body.text)).toEqual(Array(3).fill("⚠️ Não encontrei este item. Ele pode ter sido apagado."));
    expect(edits()).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(handoffB)))!.status).toBe("pending");
    expect((await t.run((ctx) => ctx.db.get(taskB)))!.status).toBe("pending");
  });

  test("#6 RBAC negado sem escrita em ia, rp, ps, sd e ae", async () => {
    const s = await seedOrg();
    await linkMember(s, s.viewerId, s.viewerUserId, CHAT_VIEWER);
    const handoffId = await seedHandoff(s, [s.viewerId]);
    const draftId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "internal",
        senderId: s.agentId, senderType: "ai", content: "rascunho", contentType: "text", isInternal: true,
        metadata: { aiDraft: { status: "pending" } }, createdAt: Date.now(),
      }),
    );
    await drain();
    const card = await cardOf(CHAT_VIEWER, { handoffId });
    calls = [];
    for (const data of [`ia:${s.conversationId}`, `rp:${s.conversationId}`, `ps:${s.conversationId}`, `sd:${draftId}`, `ae:${s.conversationId}`]) {
      await tap(CHAT_VIEWER, card, data);
    }
    expect(sends(CHAT_VIEWER).map((c) => c.body.text)).toEqual(
      Array(5).fill('🚫 Você não tem permissão para isso (perfil "agent" sem inbox:reply). Fale com um admin da Acme Corp.'),
    );
    expect((await chatOf(CHAT_VIEWER))?.pendingPrompt).toBeUndefined();
    expect(((await t.run((ctx) => ctx.db.get(draftId)))!.metadata as any).aiDraft.status).toBe("pending");
    expect((await t.run((ctx) => ctx.db.get(s.conversationId)))!.aiPausedUntil).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(handoffId)))!.status).toBe("pending");
  });

  test("#6 a resposta do prompt usa a org capturada no prompt, não a org ativa de agora", async () => {
    const a = await seedOrg();
    const b = await seedOrg({ slug: "b", userIds: { admin: a.adminUserId } });
    await linkMember(a, a.adminId, a.adminUserId, CHAT_ADMIN);
    await linkMember(b, b.adminId, a.adminUserId, CHAT_ADMIN);
    const handoffA = await seedHandoff(a, [a.adminId]);
    await drain();
    await tap(CHAT_ADMIN, await cardOf(CHAT_ADMIN, { handoffId: handoffA }), `ia:${a.conversationId}`);
    const chat = (await chatOf(CHAT_ADMIN))!;
    expect(chat.activeOrganizationId).toBe(b.organizationId); // B ficou ativa depois
    await say(CHAT_ADMIN, "oferece 10% até sexta");
    expect(await t.run((ctx) => ctx.db.get(handoffA))).toMatchObject({ status: "rejected", resolvedBy: a.adminId });
  });

  test("#6 relay não vai ao Telegram com vínculo mutado nem com o módulo desligado (o sino recebe, B2)", async () => {
    const s = await seedOrg({ aiOn: true });
    const link = await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN, { mutedUntil: Date.now() + 3600_000 });
    await t.run((ctx) => ctx.db.patch(s.leadId, { assignedTo: s.adminId }));
    const inbound = () =>
      t.mutation(internal.conversations.internalReceiveMessage, {
        organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId,
        content: "oi", skipAiEnqueue: true,
      });
    const bell = () => t.run((ctx) => ctx.db.query("notifications").collect());
    await inbound();
    await drain();
    // B2: `/pausar` só pausa o Telegram — o sino recebe.
    expect((await bell()).map((n) => n.type)).toEqual(["new_message"]);
    expect(sends(CHAT_ADMIN)).toEqual([]);
    await t.run(async (ctx) => {
      await ctx.db.patch(link, { mutedUntil: undefined });
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, modules: { telegram: false } } });
    });
    await inbound();
    await drain();
    expect(await bell()).toHaveLength(1);
    expect((await bell())[0].data?.count).toBe(2);
    expect(sends(CHAT_ADMIN)).toEqual([]);
  });

  test("#7/#8 (0.77.2) resposta sem pedido pelo Telegram não agenda relay, mesmo com foco; dedupe acha o relay mais recente", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const now = Date.now();
    const setFocus = (setAt: number) =>
      t.run(async (ctx) => {
        const chat = await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first();
        await ctx.db.patch(chat!._id, { focus: { conversationId: s.conversationId, setAt, source: "notification" } });
      });
    const marker = { requestedVia: "telegram" as const, instructedBy: s.adminId };
    const aiMessage = (instructed = false) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
          senderId: s.agentId, senderType: "ai", content: "resposta da IA", contentType: "text", isInternal: false,
          ...(instructed ? { metadata: { aiReply: marker } } : {}),
          createdAt: Date.now(),
        }),
      );
    await setFocus(now);
    const m1 = await aiMessage();
    await t.run(async (ctx) => maybeScheduleAiReplyRelay(ctx, (await ctx.db.get(s.conversationId))!, m1, null));
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((j) => j.name.includes("internalRelayAiReply"))).toHaveLength(0);

    // Foco válido + 220 entregas antigas na janela (a leitura antiga, crescente com take 200,
    // nunca chegava ao relay desta mensagem) + o relay desta mensagem por último.
    const m2 = await aiMessage(true);
    await t.run(async (ctx) => {
      const link = (await ctx.db.query("telegramLinks").collect())[0]!;
      for (let i = 0; i < 220; i++) {
        await ctx.db.insert("telegramDeliveries", {
          organizationId: s.organizationId, linkId: link._id, chatId: CHAT_ADMIN, messageId: 100 + i, kind: "relay",
          conversationId: s.conversationId, crmMessageId: m1, sentAt: now - 60 * 60 * 1000 + i,
        });
      }
      await ctx.db.insert("telegramDeliveries", {
        organizationId: s.organizationId, linkId: link._id, chatId: CHAT_ADMIN, messageId: 999, kind: "relay",
        conversationId: s.conversationId, crmMessageId: m2, sentAt: now,
      });
    });
    await t.action(internal.telegram.internalRelayAiReply, { messageId: m2 });
    expect(sends(CHAT_ADMIN)).toEqual([]);
  });
});

describe("revisão F1 — lote 2", () => {
  const chatOf = (chatId: number) =>
    t.run((ctx) => ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", chatId)).first());
  const noInbox = {
    leads: "view_own", contacts: "view", inbox: "none", tasks: "view_own",
    reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none",
  } as const;

  test("#9 quem perdeu o acesso ao inbox não recebe conteúdo de conversa", async () => {
    const s = await seedOrg();
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER);
    await t.run((ctx) => ctx.db.patch(s.sellerId, { permissions: noInbox as any }));
    await seedHandoff(s, [s.sellerId]);
    await drain();
    expect(sends(CHAT_SELLER)).toEqual([]);
    // Relay da IA na conversa em foco: idem.
    await t.run(async (ctx) => {
      const chat = await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_SELLER)).first();
      await ctx.db.patch(chat!._id, { focus: { conversationId: s.conversationId, setAt: Date.now(), source: "notification" } });
    });
    const m = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.agentId, senderType: "ai", content: "oi", contentType: "text", isInternal: false, createdAt: Date.now(),
      }),
    );
    await t.action(internal.telegram.internalRelayAiReply, { messageId: m });
    expect(sends(CHAT_SELLER)).toEqual([]);
    // Notificação sem conversa (tarefa) continua chegando.
    await t.run((ctx) =>
      createNotification(ctx, { organizationId: s.organizationId, memberId: s.sellerId, type: "channel_session_lost", title: "WhatsApp caiu" }),
    );
    await drain();
    expect(sends(CHAT_SELLER)).toHaveLength(1);
  });

  test("#10 porta que falha não deixa escrita parcial (foco revertido) e o usuário é avisado", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const draftId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "internal",
        senderId: s.agentId, senderType: "ai", content: "rascunho", contentType: "text", isInternal: true,
        metadata: { aiDraft: { status: "sent" } }, createdAt: Date.now(),
      }),
    );
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    calls = [];
    await tap(CHAT_ADMIN, await cardOf(CHAT_ADMIN, { handoffId }), `sd:${draftId}`);
    expect(sends(CHAT_ADMIN)[0].body.text).toBe("⚠️ Rascunho já revisado");
    expect((await chatOf(CHAT_ADMIN))?.focus).toBeUndefined(); // setFocus antes do core: revertido
    const rows = await t.run((ctx) => ctx.db.query("telegramUpdates").collect());
    expect(rows.at(-1)!.status).toBe("done");
  });

  test("#11 revogação limpa foco e prompt (com draftText) da org; prompt vencido some em qualquer update", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const handoffId = await seedHandoff(s, [s.adminId]);
    await drain();
    const card = await cardOf(CHAT_ADMIN, { handoffId });
    await tap(CHAT_ADMIN, card, `ah:${handoffId}`);
    await tap(CHAT_ADMIN, card, `rp:${s.conversationId}`);
    await say(CHAT_ADMIN, "texto pendente");
    expect((await chatOf(CHAT_ADMIN))?.pendingPrompt?.draftText).toBe("texto pendente");

    // Prompt vencido: um toque qualquer (Ver tudo) já remove o prompt e o draftText.
    vi.advanceTimersByTime(16 * 60 * 1000);
    await tap(CHAT_ADMIN, card, `va:${s.conversationId}`);
    expect((await chatOf(CHAT_ADMIN))?.pendingPrompt).toBeUndefined();

    // Novo prompt aberto e então o membro desconecta: nada da org fica no chat.
    await tap(CHAT_ADMIN, card, `rp:${s.conversationId}`);
    await say(CHAT_ADMIN, "outro texto");
    const as = (u: Id<"users">) => t.withIdentity({ subject: `${u}|s1` });
    await as(s.adminUserId).mutation(api.telegram.unlink, { organizationId: s.organizationId });
    await drain();
    const chat = await chatOf(CHAT_ADMIN);
    expect(chat?.pendingPrompt).toBeUndefined();
    expect(chat?.focus).toBeUndefined();
  });

  test("#12 acima de 50 mensagens na janela: '… e mais N'; preferência desligada no meio não envia", async () => {
    const s = await seedOrg({ aiOn: true });
    const link = await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await t.run((ctx) => ctx.db.patch(s.leadId, { assignedTo: s.adminId }));
    const inbound = (content: string) =>
      t.mutation(internal.conversations.internalReceiveMessage, {
        organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId,
        content, skipAiEnqueue: true,
      });
    for (let i = 0; i < 52; i++) await inbound(`m${i}`);
    const [buffer] = await t.run((ctx) => ctx.db.query("telegramRelayBuffer").collect());
    expect(buffer.messageIds).toHaveLength(50);
    expect(buffer.droppedCount).toBe(2);
    await drain();
    expect(sends(CHAT_ADMIN)).toHaveLength(1);
    expect(sends(CHAT_ADMIN)[0].body.text).toContain("… e mais 2 mensagens (abrir no CRM)");

    calls = [];
    await inbound("de novo");
    await t.run((ctx) => ctx.db.patch(link, { prefs: { relayAssignedConversations: false, mediaInbound: true } }));
    await drain();
    expect(sends(CHAT_ADMIN)).toEqual([]);
  });

  test("#13 mensagem de 5000 chars: cartão ≤ 4096, citação cortada com 'continua no CRM'", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "inbound",
        senderType: "contact", content: "a".repeat(5000), contentType: "text", isInternal: false, createdAt: Date.now(),
      }),
    );
    await seedHandoff(s, [s.adminId]);
    await drain();
    const card = sends(CHAT_ADMIN)[0].body.text as string;
    expect(card.length).toBeLessThanOrEqual(4096);
    expect(card).toContain("… (continua no CRM)");
    // The quote closes before anything appended after the card (D24 first-time tip).
    expect(card).toContain('… (continua no CRM)"</blockquote>');
  });

  test("#14 concluir tarefa grava UMA auditoria, com via telegram", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const taskId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "Ligar", type: "task", status: "pending", priority: "medium",
        assignedTo: s.adminId, createdBy: s.sellerId, createdAt: now, updatedAt: now,
      } as any);
      await createNotification(ctx, { organizationId: s.organizationId, memberId: s.adminId, type: "task_assigned", title: "Nova", taskId: id });
      return id;
    });
    await drain();
    await tap(CHAT_ADMIN, await cardOf(CHAT_ADMIN, { taskId }), `ct:${taskId}`);
    const audits = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).filter((a) => a.entityId === taskId);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata?.via).toBe("telegram");
  });

  test("#15 telefone local vira E.164 pela porta de telefone; inválido não gera botão", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappNumber: "(11) 98765-4321" }));
    await seedHandoff(s, [s.adminId]);
    await drain();
    expect(callbackDatas(sends(CHAT_ADMIN)[0])).toContain("https://wa.me/5511987654321");
    calls = [];
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappNumber: "123" }));
    await seedHandoff(s, [s.adminId]);
    await drain();
    expect(callbackDatas(sends(CHAT_ADMIN)[0]).some((u) => String(u).startsWith("https://wa.me"))).toBe(false);
    expect(sends(CHAT_ADMIN)[0].body.text).not.toContain("+123");
  });

  test("#16 regenerar marca como lidas as ai_draft_pending do membro naquela conversa", async () => {
    const s = await seedOrg({ aiOn: true });
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const now = Date.now();
    const ids = await t.run(async (ctx) => {
      const mine = await ctx.db.insert("notifications", {
        organizationId: s.organizationId, memberId: s.adminId, type: "ai_draft_pending", title: "Rascunho",
        conversationId: s.conversationId, createdAt: now,
      });
      const otherMember = await ctx.db.insert("notifications", {
        organizationId: s.organizationId, memberId: s.sellerId, type: "ai_draft_pending", title: "Rascunho",
        conversationId: s.conversationId, createdAt: now,
      });
      const chat = await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first();
      await ctx.db.patch(chat!._id, {
        pendingPrompt: {
          kind: "regenerate", conversationId: s.conversationId, promptMessageId: 1, organizationId: s.organizationId,
          expiresAt: now + 60_000,
        },
      });
      const result = await handleTelegramPromptAnswer(ctx, { chatId: CHAT_ADMIN, text: "mais curta", now, appBaseUrl: APP });
      expect(result!.replies[0].text).toBe("🔁 Pedi uma nova versão à IA. O rascunho chega aqui em instantes.");
      // Não roda o turno da IA neste teste.
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
      return { mine, otherMember };
    });
    const [mine, other] = await t.run(async (ctx) => [await ctx.db.get(ids.mine), await ctx.db.get(ids.otherMember)]);
    expect(mine!.readAt).toBe(now);
    expect(other!.readAt).toBeUndefined();
  });

  test("#17 o id da mensagem só vira promptMessageId do prompt para o qual foi enviada", async () => {
    const s = await seedOrg();
    const linkId = await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const now = Date.now();
    await t.run(async (ctx) => {
      const chat = await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first();
      await ctx.db.patch(chat!._id, {
        pendingPrompt: {
          kind: "reply_customer", conversationId: s.conversationId, promptMessageId: 10, organizationId: s.organizationId,
          expiresAt: now + 1000,
        },
      });
    });
    const record = (promptExpiresAt: number, messageId: number) =>
      t.mutation(internal.telegram.internalRecordDelivery, {
        record: {
          organizationId: s.organizationId, linkId, kind: "prompt", conversationId: s.conversationId,
          setPromptMessageId: true, promptExpiresAt,
        },
        chatId: CHAT_ADMIN,
        messageId,
      });
    await record(now + 999, 20); // prompt anterior (outro expiresAt): não mexe
    expect((await chatOf(CHAT_ADMIN))!.pendingPrompt!.promptMessageId).toBe(10);
    await record(now + 1000, 30);
    expect((await chatOf(CHAT_ADMIN))!.pendingPrompt!.promptMessageId).toBe(30);
  });
});
