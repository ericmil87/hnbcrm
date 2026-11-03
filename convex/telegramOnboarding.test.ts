/// <reference types="vite/client" />
/**
 * Copiloto no Telegram — F3: onboarding guiado (D24): cartão 0 no /start, ob:*
 * editando a mesma mensagem, modos, /tour, Terminar. `fetch` SEMPRE stubado; token falso.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { hashLinkCode } from "./lib/telegramCore";
import { ONBOARDING_COPY } from "./lib/telegramOnboarding";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const FAKE_TOKEN = "123456:FAKE-TOKEN-f2";
const SECRET = "fake-telegram-webhook-secret-f2";
const APP = "https://app.example.test";
const CHAT_ADMIN = 9001;
const CHAT_SELLER = 9002;

type Call = { method: string; body: Record<string, any> };
let calls: Call[];
let nextMessageId: number;
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T15:00:00Z"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", FAKE_TOKEN);
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "hnbcrm_test_bot");
  vi.stubEnv("APP_URL", APP);
  calls = [];
  nextMessageId = 700;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = u.split("/").pop() ?? "";
      const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (!u.includes("api.telegram.org")) return new Response("{}", { status: 200 });
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
const edits = () => calls.filter((c) => c.method === "editMessageText");
const buttons = (c: Call) => ((c.body.reply_markup?.inline_keyboard ?? []) as any[][]).flat();
const datas = (c: Call) => buttons(c).map((b) => b.callback_data ?? b.url);
const texts = (chatId: number) => sends(chatId).map((c) => c.body.text as string);

// ── seed ────────────────────────────────────────────────────────────────

type Seed = Awaited<ReturnType<typeof seedOrg>>;

async function seedOrg(opts: { name?: string; slug?: string; discreet?: boolean; telegram?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const slug = opts.slug ?? "acme";
    const adminUserId = await ctx.db.insert("users", { email: `admin-${slug}@acme.test` });
    const sellerUserId = await ctx.db.insert("users", { email: `seller-${slug}@acme.test` });
    const organizationId = await ctx.db.insert("organizations", {
      name: opts.name ?? "Acme Corp",
      slug,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        modules: { telegram: opts.telegram ?? true },
        ...(opts.discreet ? { telegram: { discreet: true } } : {}),
      },
      createdAt: now,
      updatedAt: now,
    } as any);
    const human = (userId: Id<"users">, name: string, role: "admin" | "agent") =>
      ctx.db.insert("teamMembers", { organizationId, userId, name, role, type: "human", status: "active", createdAt: now, updatedAt: now });
    const adminId = await human(adminUserId, "Eric", "admin");
    const sellerId = await human(sellerUserId, "Vendedor", "agent");
    const aiId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" }, createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Qualificado", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, sellerUserId, adminId, sellerId, aiId, boardId, stageId };
  });
}

async function seedLead(s: Seed, title: string, assignedTo: Id<"teamMembers"> | undefined, extra: { channel?: "whatsapp" | "instagram"; ageDays?: number; value?: number } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now() - (extra.ageDays ?? 0) * 86_400_000;
    const leadId = await ctx.db.insert("leads", {
      organizationId: s.organizationId, title, boardId: s.boardId, stageId: s.stageId, assignedTo, value: extra.value ?? 0,
      currency: "BRL", priority: "medium", temperature: "warm", tags: [], customFields: {},
      conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: s.organizationId, leadId, channel: extra.channel ?? "whatsapp", status: "active",
      messageCount: 0, createdAt: now, updatedAt: now,
    } as any);
    return { leadId, conversationId };
  });
}

async function seedHandoff(s: Seed, lead: { leadId: Id<"leads">; conversationId: Id<"conversations"> }, opts: { to?: Id<"teamMembers">; ageMin?: number; reason?: string } = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("handoffs", {
      organizationId: s.organizationId, leadId: lead.leadId, conversationId: lead.conversationId, fromMemberId: s.aiId,
      toMemberId: opts.to, reason: opts.reason ?? "preço", suggestedActions: [], origin: "ai_tool", status: "pending",
      createdAt: Date.now() - (opts.ageMin ?? 5) * 60_000,
    }),
  );
}

async function seedTask(s: Seed, memberId: Id<"teamMembers">, title: string, dueInMin: number | undefined, status: "pending" | "completed" = "pending") {
  return await t.run((ctx) => {
    const now = Date.now();
    return ctx.db.insert("tasks", {
      organizationId: s.organizationId, title, type: "task", status, priority: "medium", assignedTo: memberId, createdBy: memberId,
      ...(dueInMin !== undefined ? { dueDate: now + dueInMin * 60_000 } : {}), createdAt: now, updatedAt: now,
    });
  });
}

async function linkMember(s: Seed, memberId: Id<"teamMembers">, userId: Id<"users">, chatId: number, extra: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const linkId = await ctx.db.insert("telegramLinks", {
      organizationId: s.organizationId, teamMemberId: memberId, userId, chatId, telegramUserId: chatId, status: "active",
      prefs: { relayAssignedConversations: true, mediaInbound: true },
      assistant: {
        mode: "suggest", suggestOnEvents: true, autoSendDelaySeconds: 15,
        autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
      },
      reports: { enabled: true, morningHour: 8, eveningHour: 18 },
      linkedAt: now, lastSeenAt: now, ...extra,
    });
    const chat = await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", chatId)).first();
    if (chat) await ctx.db.patch(chat._id, { activeOrganizationId: s.organizationId, activeTeamMemberId: memberId });
    else await ctx.db.insert("telegramChats", { chatId, telegramUserId: chatId, activeOrganizationId: s.organizationId, activeTeamMemberId: memberId, updatedAt: now });
    return linkId;
  });
}

let updateSeq = 7000;
async function post(update: unknown) {
  const res = await t.fetch("/webhooks/telegram/platform", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: JSON.stringify(update),
  });
  expect(res.status).toBe(200);
  await drain();
}
const say = (chatId: number, text: string, chatType = "private") =>
  post({
    update_id: updateSeq++,
    message: { message_id: updateSeq, date: 1, chat: { id: chatId, type: chatType }, from: { id: chatId, first_name: "Eric" }, text },
  });
const tap = (chatId: number, messageId: number, data: string) =>
  post({
    update_id: updateSeq++,
    callback_query: {
      id: `cbq-${updateSeq}`, from: { id: chatId, first_name: "Eric" },
      message: { message_id: messageId, date: 1, chat: { id: chatId, type: "private" } }, data,
    },
  });

const chatOf = (chatId: number) => t.run((ctx) => ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", chatId)).first());
const linkOf = (id: Id<"telegramLinks">) => t.run((ctx) => ctx.db.get(id));

async function adminChat() {
  const s = await seedOrg();
  const linkId = await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
  return { s, linkId };
}

// ── onboarding ──────────────────────────────────────────────────────────

const edited = () => calls.filter((c) => c.method === "editMessageText");

describe("onboarding D24", () => {
  test("/start entrega o cartão 0 com Próximo e grava step 0", async () => {
    const s = await seedOrg();
    const code = "B".repeat(43);
    await t.run(async (ctx) => {
      await ctx.db.insert("telegramLinkCodes", {
        organizationId: s.organizationId, teamMemberId: s.adminId, userId: s.adminUserId,
        codeHash: await hashLinkCode(code), expiresAt: Date.now() + 600_000, createdAt: Date.now(),
      });
    });
    await say(CHAT_ADMIN, `/start ${code}`);
    const [card0, kb] = sends(CHAT_ADMIN);
    expect(card0.body.text).toBe(
      "👋 <b>Conectado!</b>\nEric · Acme Corp\n\nSou sua assistente no HNBCRM.\nEm 4 passos rápidos você vê como funciona.",
    );
    expect(datas(card0)).toEqual(["ob:1", "ob:done"]);
    expect(kb.body.reply_markup.is_persistent).toBe(true);
    const link = await t.run((ctx) => ctx.db.query("telegramLinks").first());
    expect(link?.onboarding).toEqual({ step: 0 });
  });

  test("Próximo e ← editam a MESMA mensagem e guardam o passo", async () => {
    const { linkId } = await adminChat();
    await tap(CHAT_ADMIN, 321, "ob:1");
    expect(edited()[0].body).toMatchObject({ chat_id: CHAT_ADMIN, message_id: 321 });
    expect(edited()[0].body.text).toContain("1/4 · O que chega aqui");
    expect((await linkOf(linkId))?.onboarding?.step).toBe(1);
    await tap(CHAT_ADMIN, 321, "ob:2");
    expect(edited()[1].body.text).toContain("2/4 · Dois modos");
    await tap(CHAT_ADMIN, 321, "ob:back");
    expect(edited()[2].body.text).toContain("1/4 · O que chega aqui");
    expect((await linkOf(linkId))?.onboarding?.step).toBe(1);
    await tap(CHAT_ADMIN, 321, "ob:back");
    expect(edited()[3].body.text).toContain("👋 <b>Conectado!</b>\nEric · Acme Corp");
    expect((await linkOf(linkId))?.onboarding?.step).toBe(0);
    // Toque em cartão antigo: abre o cartão pedido, sem estado preso.
    await tap(CHAT_ADMIN, 321, "ob:3");
    expect(edited()[4].body.text).toContain("3/4 · Como falar comigo");
    expect(sends(CHAT_ADMIN)).toHaveLength(0);
  });

  test("cartão 2: Sugestão e Automático gravam o modo e seguem para o 3", async () => {
    const { linkId } = await adminChat();
    await tap(CHAT_ADMIN, 321, "ob:mode:auto");
    expect((await linkOf(linkId))?.assistant.mode).toBe("auto");
    expect(texts(CHAT_ADMIN)).toEqual(["✅ Começando em 🤖 <b>Automático</b>.\n/modo troca quando quiser."]);
    expect(edited()[0].body.text).toContain("3/4 · Como falar comigo");
    await tap(CHAT_ADMIN, 321, "ob:mode:suggest");
    expect((await linkOf(linkId))?.assistant.mode).toBe("suggest");
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.filter((a) => a.metadata?.event === "telegram.assistant_mode")).toHaveLength(2);
  });

  test("org com allowAutoMode:false: Automático vira Sugestão com aviso", async () => {
    const { s, linkId } = await adminChat();
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, telegram: { allowAutoMode: false } } });
    });
    await tap(CHAT_ADMIN, 321, "ob:mode:auto");
    expect((await linkOf(linkId))?.assistant.mode).toBe("suggest");
    expect(texts(CHAT_ADMIN)[0]).toBe("O modo automático está desligado pela sua organização.\nFicou em 💡 <b>Sugestão</b>.");
    expect(edited()[0].body.text).toContain("3/4");
  });

  test("cartão 4: Ver meu /hoje agenda o relatório; Terminar grava doneAt e mostra o teclado", async () => {
    const { linkId } = await adminChat();
    await tap(CHAT_ADMIN, 321, "ob:4");
    expect(edited()[0].body.text).toBe("<b>4/4 · Teste agora</b>\n\nToque em um:");
    await tap(CHAT_ADMIN, 321, "cmd:hoje");
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const report = jobs.find((j) => j.name.includes("internalSendReport"));
    expect(report?.args[0]).toEqual({ linkId, kind: "morning", trigger: "command" });
    calls = [];
    // F4 pacing: draining may run a later message 1 s ahead, so pin the tap time.
    const tappedAt = Date.now();
    await tap(CHAT_ADMIN, 321, "ob:done");
    const link = await linkOf(linkId);
    expect(link?.onboarding?.step).toBe(4);
    expect(link?.onboarding?.doneAt).toBe(tappedAt);
    expect(edited()[0].body.reply_markup).toEqual({ inline_keyboard: [] });
    const [final] = sends(CHAT_ADMIN);
    expect(final.body.text).toBe(ONBOARDING_COPY.done);
    expect(final.body.reply_markup.is_persistent).toBe(true);
  });

  test("Pular tour no cartão 0 encerra, tira os botões e mantém o cartão", async () => {
    const { linkId } = await adminChat();
    await t.run((ctx) => ctx.db.patch(linkId, { onboarding: { step: 0 } }));
    await tap(CHAT_ADMIN, 321, "ob:done");
    expect(edited()[0].body.text).toContain("👋 <b>Conectado!</b>\nEric · Acme Corp");
    expect(edited()[0].body.reply_markup).toEqual({ inline_keyboard: [] });
    expect((await linkOf(linkId))?.onboarding?.doneAt).toBeDefined();
    expect(sends(CHAT_ADMIN)[0].body.text).toBe(ONBOARDING_COPY.done);
  });

  test("Terminar respeita teclado oculto", async () => {
    await adminChat();
    await t.run(async (ctx) => {
      const chat = (await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first())!;
      await ctx.db.patch(chat._id, { keyboardShown: false });
    });
    await tap(CHAT_ADMIN, 321, "ob:done");
    expect(sends(CHAT_ADMIN)[0].body.reply_markup).toBeUndefined();
  });

  test("/tour reabre no cartão 1 em mensagem nova e /ajuda cita o /tour", async () => {
    const { linkId } = await adminChat();
    await tap(CHAT_ADMIN, 321, "ob:done");
    calls = [];
    await say(CHAT_ADMIN, "/tour");
    const [card] = sends(CHAT_ADMIN);
    expect(card.body.text).toContain("1/4 · O que chega aqui");
    expect(datas(card)).toEqual(["ob:back", "ob:2"]);
    const link = await linkOf(linkId);
    expect(link?.onboarding?.step).toBe(1);
    expect(link?.onboarding?.doneAt).toBeDefined();
    await say(CHAT_ADMIN, "/ajuda");
    expect(sends(CHAT_ADMIN)[1].body.text).toContain("/tour — reabre o guia");
  });

  test("chat sem vínculo não consegue dirigir ob:*", async () => {
    await tap(5656, 1, "ob:mode:auto");
    await tap(5656, 1, "ob:done");
    expect(edited()).toHaveLength(0);
    expect(texts(5656).every((x) => x.includes("ainda não está conectado"))).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("telegramLinks").collect())).toHaveLength(0);
  });
});
