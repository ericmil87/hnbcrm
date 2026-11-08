/// <reference types="vite/client" />
/**
 * B2: agrupamento do sino (`createNotification` + `coalesce`), `new_message`
 * por membro com ou sem Telegram (1 envio por janela), buffer antigo com
 * `linkId`, prévia traduzida, `lead_assigned` e resolução do dono anterior.
 * `fetch` sempre stubado; token falso.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { coalesceKeys, createNotification, GROUP_MENTION_WINDOW_MS } from "./lib/notify";
import { notificationCopy } from "./lib/notificationCopy";
import { RELAY_BUFFER_MS } from "./lib/telegramRelay";
import { transferConversationCore } from "./lib/conversationTransfer";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const FAKE_TOKEN = "123456:FAKE-TOKEN-b2";
const CHAT = 9101;

type Call = { method: string; body: Record<string, any> };
let calls: Call[];
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", FAKE_TOKEN);
  vi.stubEnv("APP_URL", "https://app.example.test");
  calls = [];
  let nextId = 100;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = u.split("/").pop() ?? "";
      const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (!u.includes("api.telegram.org")) return new Response(JSON.stringify({}), { status: 200 });
      calls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: nextId++ } : true }), {
        status: 200,
      });
    })
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
const tgSends = () => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === CHAT);

async function seed(opts: { leadTitle?: string } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Acme",
      slug: "acme",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { telegram: true, departments: true } },
      createdAt: now,
      updatedAt: now,
    });
    const human = async (name: string, role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", { email: `${name.toLowerCase()}@acme.test` });
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active", createdAt: now, updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await human("Eric", "admin");
    const seller = await human("Ana", "agent");
    const other = await human("Bruno", "agent");
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Principal",
      phoneNumberId: "pn-b2", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false,
      createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Maria", whatsappNumber: "5511987654321", tags: [], createdAt: now, updatedAt: now,
    });
    // Lead de um humano (org sem IA): humano no comando → relay para ele.
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: opts.leadTitle ?? "Maria", contactId, boardId, stageId, assignedTo: seller.memberId,
      value: 0, currency: "BRL", priority: "medium", temperature: "warm", tags: [], customFields: {},
      conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active",
      assignedTo: seller.memberId, messageCount: 0, createdAt: now, updatedAt: now,
    });
    return { organizationId, admin, seller, other, configId, leadId, conversationId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function link(s: Seed, who: { userId: Id<"users">; memberId: Id<"teamMembers"> }, extra: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const linkId = await ctx.db.insert("telegramLinks", {
      organizationId: s.organizationId, teamMemberId: who.memberId, userId: who.userId, chatId: CHAT, telegramUserId: CHAT,
      status: "active",
      prefs: { relayAssignedConversations: true, mediaInbound: true },
      assistant: {
        mode: "suggest", suggestOnEvents: false, autoSendDelaySeconds: 15,
        autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
      },
      reports: { enabled: false, morningHour: 8, eveningHour: 18 },
      linkedAt: now, lastSeenAt: now, ...extra,
    });
    await ctx.db.insert("telegramChats", {
      chatId: CHAT, telegramUserId: CHAT, activeOrganizationId: s.organizationId, activeTeamMemberId: who.memberId, updatedAt: now,
    });
    return linkId;
  });
}

const inbound = (s: Seed, content: string) =>
  t.mutation(internal.conversations.internalReceiveMessage, {
    organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId,
    content, skipAiEnqueue: true,
  });

const bellOf = (memberId: Id<"teamMembers">) =>
  t.run((ctx) =>
    ctx.db.query("notifications").withIndex("by_member_and_created", (q) => q.eq("memberId", memberId)).order("desc").collect()
  );

describe("new_message por membro, agrupado", () => {
  test("5 mensagens em 3 janelas → 1 não lida '5 mensagens novas de Ana'; leu → a próxima cria outra", async () => {
    const s = await seed({ leadTitle: "Ana" });
    await inbound(s, "Oi");
    await inbound(s, "tudo bem?");
    await drain();
    await inbound(s, "queria o preço");
    await inbound(s, "do plano anual");
    await drain();
    await inbound(s, "Pix serve?");
    await drain();

    const bell = await bellOf(s.seller.memberId);
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ type: "new_message", title: "5 mensagens novas de Ana", body: "Pix serve?" });
    expect(bell[0].coalesceKey).toBe(coalesceKeys.newMessage(s.conversationId));
    expect(bell[0].data?.count).toBe(5);
    expect(bell[0].readAt).toBeUndefined();
    // Sem Telegram: nada sai para lá, mas o sino recebeu (achado 18).
    expect(tgSends()).toEqual([]);

    const firstCreatedAt = bell[0].createdAt;
    await t.withIdentity({ subject: `${s.seller.userId}|s1` }).mutation(api.notifications.markRead, {
      organizationId: s.organizationId, notificationId: bell[0]._id,
    });
    vi.advanceTimersByTime(1000);
    await inbound(s, "e aí?");
    await drain();
    const after = await bellOf(s.seller.memberId);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ title: "Mensagem nova de Ana", body: "e aí?" });
    expect(after[0].readAt).toBeUndefined();
    expect(after[0].createdAt).toBeGreaterThan(firstCreatedAt);
  });

  test("patch renova createdAt (sobe ao topo do sino)", async () => {
    const s = await seed({ leadTitle: "Ana" });
    await inbound(s, "Oi");
    await drain();
    const [first] = await bellOf(s.seller.memberId);
    vi.advanceTimersByTime(60_000);
    await inbound(s, "?");
    await drain();
    const [again] = await bellOf(s.seller.memberId);
    expect(again._id).toBe(first._id);
    expect(again.createdAt).toBeGreaterThan(first.createdAt);
  });

  test("com Telegram: 1 envio por janela (não 2), mesmo agrupando no sino", async () => {
    const s = await seed({ leadTitle: "Ana" });
    await link(s, s.seller);
    await inbound(s, "um");
    await inbound(s, "dois");
    await drain();
    expect(tgSends()).toHaveLength(1);
    expect(tgSends()[0].body.text).toContain('"um"\n"dois"');
    await inbound(s, "três");
    await drain();
    expect(tgSends()).toHaveLength(2);
    // O cartão da 2ª janela mostra só a mensagem dela.
    expect(tgSends()[1].body.text).toContain('"três"');
    expect(tgSends()[1].body.text).not.toContain('"um"');
    const bell = await bellOf(s.seller.memberId);
    expect(bell).toHaveLength(1);
    expect(bell[0].title).toBe("3 mensagens novas de Ana");
  });

  test("/pausar do Telegram não silencia o sino", async () => {
    const s = await seed({ leadTitle: "Ana" });
    await link(s, s.seller, { mutedUntil: Date.now() + 3_600_000 });
    await inbound(s, "oi");
    await drain();
    expect(tgSends()).toEqual([]);
    expect((await bellOf(s.seller.memberId)).map((n) => n.type)).toEqual(["new_message"]);
  });

  test("buffer antigo (com linkId, sem memberId) drena normalmente", async () => {
    const s = await seed({ leadTitle: "Ana" });
    const linkId = await link(s, s.seller);
    const bufferId = await t.run(async (ctx) => {
      const now = Date.now();
      const m = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "inbound",
        senderType: "contact", content: "mensagem de antes do deploy", contentType: "text", isInternal: false, createdAt: now,
      });
      return await ctx.db.insert("telegramRelayBuffer", {
        organizationId: s.organizationId, conversationId: s.conversationId, linkId, messageIds: [m], flushAt: now + RELAY_BUFFER_MS,
      });
    });
    await t.mutation(internal.telegram.internalFlushRelayBuffer, { bufferId });
    await drain();
    const bell = await bellOf(s.seller.memberId);
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ type: "new_message", title: "Mensagem nova de Ana", body: "mensagem de antes do deploy" });
    expect(tgSends()).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("telegramRelayBuffer").collect())).toEqual([]);
  });

  test("prévia usa a tradução pronta com o idioma de origem", async () => {
    const s = await seed({ leadTitle: "John" });
    await t.run(async (ctx) => {
      const now = Date.now();
      const m = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "inbound",
        senderType: "contact", content: "How much is it?", translatedText: "Quanto custa?", contentType: "text",
        isInternal: false, metadata: { translation: { status: "done", role: "inbound", sourceLang: "en", targetLang: "pt-BR", at: now } },
        createdAt: now,
      });
      await ctx.db.insert("telegramRelayBuffer", {
        organizationId: s.organizationId, conversationId: s.conversationId, memberId: s.seller.memberId, messageIds: [m],
        flushAt: now,
      });
    });
    const [buffer] = await t.run((ctx) => ctx.db.query("telegramRelayBuffer").collect());
    await t.mutation(internal.telegram.internalFlushRelayBuffer, { bufferId: buffer._id });
    const [n] = await bellOf(s.seller.memberId);
    expect(n.body).toBe("Quanto custa? (traduzido do inglês)");
  });
});

describe("group_mention: janela de 10 min", () => {
  test("menções na janela agrupam (sem 2º Telegram); depois da janela nasce outra", async () => {
    const s = await seed();
    await link(s, s.seller);
    const groupChatId = await t.run((ctx) =>
      ctx.db.insert("groupChats", {
        organizationId: s.organizationId, channelConfigId: s.configId, jid: "123@g.us", subject: "Sementes",
        monitored: true, createdAt: Date.now(), updatedAt: Date.now(),
      } as any)
    );
    const mention = () =>
      t.run(async (ctx) => {
        const render = (count: number) =>
          notificationCopy({ type: "group_mention", groupName: "Sementes", senderName: "Carla", preview: "oi", count });
        await createNotification(ctx, {
          organizationId: s.organizationId, memberId: s.seller.memberId, type: "group_mention", ...render(1),
          groupChatId,
          coalesce: { key: coalesceKeys.groupMention(groupChatId), windowMs: GROUP_MENTION_WINDOW_MS, render },
        });
      });
    await mention();
    vi.advanceTimersByTime(4 * 60_000);
    await mention();
    vi.advanceTimersByTime(5 * 60_000);
    await mention(); // 9 min depois da primeira: ainda na janela (contada da primeira)
    await drain();
    let bell = await bellOf(s.seller.memberId);
    expect(bell).toHaveLength(1);
    expect(bell[0].title).toBe("3 menções a você no grupo Sementes");
    expect(tgSends()).toHaveLength(1);
    vi.advanceTimersByTime(2 * 60_000); // 11 min da primeira
    await mention();
    await drain();
    bell = await bellOf(s.seller.memberId);
    expect(bell).toHaveLength(2);
    expect(bell[0].title).toBe("Mencionaram você no grupo Sementes");
    expect(tgSends()).toHaveLength(2);
  });
});

describe("lead_assigned no sino", () => {
  test("atribuir lead avisa o novo responsável (PT-BR, sem PII)", async () => {
    const s = await seed({ leadTitle: "+55 11 98765-4321" });
    await t.withIdentity({ subject: `${s.admin.userId}|s1` }).mutation(api.leads.assignLead, {
      leadId: s.leadId, assignedTo: s.other.memberId,
    });
    const [n] = await bellOf(s.other.memberId);
    expect(n).toMatchObject({ type: "lead_assigned", title: "Eric atribuiu o lead Contato a você" });
    expect(n.data?.leadId).toBe(s.leadId);
  });
});

describe("transferências resolvem avisos de quem saiu", () => {
  test("transferir conversa: new_message e resposta sugerida do dono anterior viram lidas", async () => {
    const s = await seed({ leadTitle: "Ana" });
    await inbound(s, "oi");
    await drain();
    await t.run(async (ctx) => {
      await createNotification(ctx, {
        organizationId: s.organizationId, memberId: s.seller.memberId, type: "ai_draft_pending",
        ...notificationCopy({ type: "ai_draft_pending", contactName: "Ana" }), conversationId: s.conversationId,
      });
      const conversation = (await ctx.db.get(s.conversationId))!;
      const actor = (await ctx.db.get(s.admin.memberId))!;
      const toMember = (await ctx.db.get(s.other.memberId))!;
      await transferConversationCore(ctx, { conversation, toDept: null, toMember, actor, now: Date.now() });
    });
    const seller = await bellOf(s.seller.memberId);
    expect(seller.length).toBe(2);
    for (const n of seller) {
      expect(n.readAt).toBeDefined();
      expect(n.data?.resolvedReason).toBe("conversation_transferred_away");
      expect(n.data?.resolvedBy).toBe(s.admin.memberId);
    }
    const other = await bellOf(s.other.memberId);
    expect(other.map((n) => n.type)).toEqual(["conversation_transferred"]);
    expect(other[0].title).toBe("Eric transferiu a conversa com Ana para você");
  });

  test("trocar responsável da tarefa resolve o task_assigned de quem saiu", async () => {
    const s = await seed();
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const taskId = await asAdmin.mutation(api.tasks.createTask, {
      organizationId: s.organizationId, title: "Ligar", type: "task", priority: "medium", assignedTo: s.seller.memberId,
    } as any);
    const [assigned] = await bellOf(s.seller.memberId);
    expect(assigned).toMatchObject({ type: "task_assigned", title: "Eric atribuiu uma tarefa a você", body: "Ligar" });
    await asAdmin.mutation(api.tasks.assignTask, { taskId, assignedTo: s.other.memberId });
    const [resolved] = await bellOf(s.seller.memberId);
    expect(resolved.readAt).toBeDefined();
    expect(resolved.data?.resolvedReason).toBe("task_unassigned");
    expect((await bellOf(s.other.memberId))[0].readAt).toBeUndefined();
  });
});
