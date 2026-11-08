/// <reference types="vite/client" />
/**
 * Copiloto no Telegram — F2: comandos, listas, paginação, foco, pausar, org,
 * teclado persistente. `fetch` SEMPRE stubado; token falso.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { hashLinkCode } from "./lib/telegramCore";

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

async function seedHandoff(s: Seed, lead: { leadId: Id<"leads">; conversationId: Id<"conversations"> }, opts: { to?: Id<"teamMembers">; ageMin?: number; reason?: string; summary?: string; actions?: string[] } = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("handoffs", {
      organizationId: s.organizationId, leadId: lead.leadId, conversationId: lead.conversationId, fromMemberId: s.aiId,
      toMemberId: opts.to, reason: opts.reason ?? "preço", ...(opts.summary ? { summary: opts.summary } : {}), suggestedActions: opts.actions ?? [], origin: "ai_tool", status: "pending",
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
// C1: a pausa do `/pausar` vive no membro (`notificationPreferences.pausedUntil`), não no vínculo.
const pausedOf = (id: Id<"telegramLinks">) =>
  t.run(async (ctx) => {
    const link = (await ctx.db.get(id))!;
    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) => q.eq("organizationId", link.organizationId).eq("teamMemberId", link.teamMemberId))
      .first();
    return prefs?.pausedUntil ?? undefined;
  });

async function adminChat() {
  const s = await seedOrg();
  const linkId = await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
  return { s, linkId };
}

// ── /repasses ───────────────────────────────────────────────────────────

describe("/repasses", () => {
  test("cada linha é o cartão completo do repasse: resumo, ações sugeridas, peek e entrega registrada", async () => {
    const { s } = await adminChat();
    const maria = await seedLead(s, "Maria Souza", s.aiId);
    const pedro = await seedLead(s, "Pedro Nunes", s.aiId, { channel: "instagram" });
    const hMaria = await seedHandoff(s, maria, {
      ageMin: 42, reason: "preço", summary: "Quer 15% no plano anual", actions: ["Oferecer 10%", "Ligar hoje"],
    });
    const hPedro = await seedHandoff(s, pedro, { ageMin: 200, reason: "reclamação" });
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: maria.conversationId, leadId: maria.leadId, direction: "inbound",
        senderType: "contact", content: "Vocês fazem 15% no anual?", contentType: "text", isInternal: false, createdAt: Date.now() - 60_000,
      }),
    );
    await say(CHAT_ADMIN, "/repasses");
    const out = sends(CHAT_ADMIN);
    expect(out).toHaveLength(3);
    expect(out[0].body.text).toBe("🔁 2 repasses pendentes · Acme Corp");
    const card = out[1].body.text as string;
    expect(card).toContain("🔔 <b>Repasse da IA</b>");
    expect(card).toContain("<b>Maria Souza</b>\nWhatsApp");
    expect(card).toContain("<b>Motivo:</b> preço");
    expect(card).toContain("<b>Resumo</b>\nQuer 15% no plano anual");
    expect(card).toContain("<b>Ações sugeridas</b>\n• Oferecer 10%\n• Ligar hoje");
    expect(card).toContain("Vocês fazem 15% no anual?");
    expect(datas(out[1])).toEqual(
      expect.arrayContaining([`ah:${hMaria}`, `ia:${maria.conversationId}`, `va:${maria.conversationId}`]),
    );
    expect(out[2].body.text).toContain("<b>Pedro Nunes</b>\nInstagram");
    expect(datas(out[2])).toEqual(expect.arrayContaining([`ah:${hPedro}`, `va:${pedro.conversationId}`]));
    // Each row is recorded like a pushed card (no notification behind it).
    const deliveries = await t.run((ctx) => ctx.db.query("telegramDeliveries").collect());
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.handoffId).sort()).toEqual([hMaria, hPedro].sort());
    expect(deliveries.every((d) => d.kind === "notification" && d.notificationId === undefined && d.chatId === CHAT_ADMIN)).toBe(true);
  });

  test("Ver tudo numa linha da lista edita o cartão para o histórico", async () => {
    const { s } = await adminChat();
    const maria = await seedLead(s, "Maria Souza", s.aiId);
    await seedHandoff(s, maria);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: maria.conversationId, leadId: maria.leadId, direction: "inbound",
        senderType: "contact", content: "Preciso de desconto", contentType: "text", isInternal: false, createdAt: Date.now() - 1000,
      }),
    );
    await say(CHAT_ADMIN, "/repasses");
    const rowId = 701; // header 700, first card 701
    await tap(CHAT_ADMIN, rowId, `va:${maria.conversationId}`);
    const edit = edits().at(-1)!;
    expect(edit.body.message_id).toBe(rowId);
    expect(edit.body.text).toContain("últimas");
    expect(edit.body.text).toContain("Preciso de desconto");
  });

  test("vazio", async () => {
    await adminChat();
    await say(CHAT_ADMIN, "/repasses");
    expect(texts(CHAT_ADMIN)).toEqual(["Nenhum repasse pendente 🎉"]);
  });

  test("agent vê só os dirigidos a ele ou broadcast; admin vê todos", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER);
    const a = await seedLead(s, "Para Admin", s.aiId);
    const b = await seedLead(s, "Para Vendedor", s.aiId);
    const c = await seedLead(s, "Para Todos", s.aiId);
    await seedHandoff(s, a, { to: s.adminId });
    await seedHandoff(s, b, { to: s.sellerId });
    await seedHandoff(s, c);
    await say(CHAT_SELLER, "/repasses");
    const seller = texts(CHAT_SELLER).join("\n");
    expect(seller).toContain("2 repasses pendentes");
    expect(seller).toContain("Para Vendedor");
    expect(seller).toContain("Para Todos");
    expect(seller).not.toContain("Para Admin");
    await say(CHAT_ADMIN, "/repasses");
    expect(texts(CHAT_ADMIN)[0]).toContain("3 repasses pendentes");
  });

  test("paginação: 5 cartões + Mais 5 →, a segunda página edita o rodapé", async () => {
    const { s } = await adminChat();
    for (let i = 0; i < 12; i++) {
      const lead = await seedLead(s, `Lead ${i + 1}`, s.aiId);
      await seedHandoff(s, lead, { ageMin: 100 - i });
    }
    await say(CHAT_ADMIN, "/repasses");
    const first = sends(CHAT_ADMIN);
    expect(first).toHaveLength(7); // header + 5 cards + footer
    expect(first[0].body.text).toBe("🔁 12 repasses pendentes · Acme Corp");
    expect(first[5].body.text).toContain("<b>Lead 5</b>");
    expect(first[6].body.text).toBe("Mostrando 1–5.");
    expect(buttons(first[6])).toEqual([{ text: "Mais 5 →", callback_data: "pg:repasses:5" }]);
    const footerId = 700 + 6;
    calls = [];
    await tap(CHAT_ADMIN, footerId, "pg:repasses:5");
    const second = sends(CHAT_ADMIN);
    expect(second).toHaveLength(6); // 5 cards + footer
    expect(second[0].body.text).toContain("<b>Lead 6</b>");
    expect(second[5].body.text).toBe("Mostrando 1–10.");
    expect(edits()).toHaveLength(1);
    expect(edits()[0].body).toMatchObject({ message_id: footerId, text: "Mostrando 1–5." });
  });

  test("modo discreto: iniciais, sem telefone, WhatsApp, resumo nem Ver tudo", async () => {
    const s = await seedOrg({ discreet: true });
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    const maria = await seedLead(s, "Maria Souza", s.aiId);
    await seedHandoff(s, maria, {
      ageMin: 10, reason: "Maria Souza pediu retorno no 11 98765-4321", summary: "Segredo do resumo", actions: ["Ligar para Maria"],
    });
    await say(CHAT_ADMIN, "/repasses");
    const row = sends(CHAT_ADMIN)[1];
    const text = row.body.text as string;
    expect(text).toContain("<b>M. S.</b>\nWhatsApp");
    for (const leak of ["Maria", "98765", "Segredo", "Ligar para"]) expect(text).not.toContain(leak);
    expect(datas(row).some((d: string) => d.startsWith("va:") || d.includes("wa.me"))).toBe(false);
    expect(datas(row).some((d: string) => d.startsWith("ah:"))).toBe(true);
  });

  test("callback cmd:repasses de um relatório age como o comando", async () => {
    const { s } = await adminChat();
    const maria = await seedLead(s, "Maria Souza", s.aiId);
    await seedHandoff(s, maria);
    await tap(CHAT_ADMIN, 555, "cmd:repasses");
    expect(texts(CHAT_ADMIN)[0]).toBe("🔁 1 repasse pendente · Acme Corp");
    expect(texts(CHAT_ADMIN)).toHaveLength(2);
    expect(texts(CHAT_ADMIN)[1]).toContain("🔔 <b>Repasse da IA</b>");
  });

  test("Aceitar numa linha da lista aceita o repasse pela porta do F1", async () => {
    const { s } = await adminChat();
    const maria = await seedLead(s, "Maria Souza", s.aiId);
    const hid = await seedHandoff(s, maria);
    await say(CHAT_ADMIN, "/repasses");
    const row = sends(CHAT_ADMIN)[1];
    await tap(CHAT_ADMIN, 701, `ah:${hid}`);
    expect(row.body.reply_markup).toBeDefined();
    const h = await t.run((ctx) => ctx.db.get(hid));
    expect(h?.status).toBe("accepted");
  });
});

// ── /tarefas ────────────────────────────────────────────────────────────

describe("/tarefas", () => {
  test("minhas pendentes: atrasada primeiro, concluída e de outro fora, botões Concluir/Adiar", async () => {
    const { s } = await adminChat();
    const later = await seedTask(s, s.adminId, "Enviar proposta", 120);
    const late = await seedTask(s, s.adminId, "Ligar para Maria", -90);
    await seedTask(s, s.adminId, "Já feita", -10, "completed");
    await seedTask(s, s.sellerId, "Do vendedor", 10);
    await say(CHAT_ADMIN, "/tarefas");
    const out = sends(CHAT_ADMIN);
    expect(out[0].body.text).toBe("✅ 2 tarefas (1 atrasada) · Acme Corp");
    expect(out[1].body.text).toContain("1. <b>Ligar para Maria</b>\n⚠️ atrasada desde");
    expect(datas(out[1])).toEqual([`ct:${late}`, `sz1:${late}`]);
    expect(out[2].body.text).toContain("2. <b>Enviar proposta</b>\n⏰ ");
    expect(datas(out[2])).toEqual([`ct:${later}`, `sz1:${later}`]);
  });

  test("vazio", async () => {
    await adminChat();
    await say(CHAT_ADMIN, "/tarefas");
    expect(texts(CHAT_ADMIN)).toEqual(["Nenhuma tarefa pendente para você 🎉"]);
  });

  test("rótulo do teclado ✅ Tarefas funciona como /tarefas", async () => {
    const { s } = await adminChat();
    await seedTask(s, s.adminId, "Uma", 30);
    await say(CHAT_ADMIN, "✅ Tarefas");
    expect(texts(CHAT_ADMIN)[0]).toContain("1 tarefa");
  });
});

// ── /leads ──────────────────────────────────────────────────────────────

describe("/leads", () => {
  test("admin vê os da org, agent só os próprios; botão abre o pipeline", async () => {
    const s = await seedOrg();
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER);
    const mine = await seedLead(s, "Lead do Vendedor", s.sellerId, { ageDays: 3, value: 4800 });
    await seedLead(s, "Lead da IA", s.aiId);
    await say(CHAT_SELLER, "/leads");
    const [seller] = sends(CHAT_SELLER);
    expect(seller.body.text).toContain("👥 Seus leads · Acme Corp");
    expect(seller.body.text).toContain("1. <b>Lead do Vendedor</b> · Qualificado");
    expect(seller.body.text).toContain("há 3 dias");
    expect(seller.body.text).not.toContain("Lead da IA");
    expect(datas(seller)).toEqual([`${APP}/app/pipeline?lead=${mine.leadId}`]);
    await say(CHAT_ADMIN, "/leads");
    const admin = sends(CHAT_ADMIN)[0].body.text as string;
    expect(admin).toContain("👥 Leads · Acme Corp");
    expect(admin).toContain("Lead do Vendedor");
    expect(admin).toContain("Lead da IA");
  });

  test("Mais 10 → quando há mais de 10", async () => {
    const { s } = await adminChat();
    for (let i = 0; i < 12; i++) await seedLead(s, `L${i + 1}`, s.adminId);
    await say(CHAT_ADMIN, "/leads");
    const [first] = sends(CHAT_ADMIN);
    expect(first.body.text.split("\n")).toHaveLength(11);
    expect(datas(first).at(-1)).toBe("pg:leads:10");
    await tap(CHAT_ADMIN, 700, "pg:leads:10");
    const second = sends(CHAT_ADMIN)[1];
    expect(second.body.text.split("\n").slice(1)).toHaveLength(2);
    expect(second.body.text).toContain("11. ");
  });

  test("vazio e modo discreto", async () => {
    const s = await seedOrg({ discreet: true });
    await linkMember(s, s.adminId, s.adminUserId, CHAT_ADMIN);
    await say(CHAT_ADMIN, "/leads");
    expect(texts(CHAT_ADMIN)).toEqual(["Nenhum lead para mostrar."]);
    await seedLead(s, "Maria Souza", s.adminId);
    await say(CHAT_ADMIN, "/leads");
    expect(sends(CHAT_ADMIN)[1].body.text).toContain("1. <b>M. S.</b>");
    expect(sends(CHAT_ADMIN)[1].body.text).not.toContain("Maria");
  });
});

// ── /foco e /novo ───────────────────────────────────────────────────────

describe("/foco e /novo", () => {
  test("lista minhas conversas abertas, toque define o foco, /novo limpa", async () => {
    const { s } = await adminChat();
    const carlos = await seedLead(s, "Carlos Lima", s.adminId);
    await seedLead(s, "Da IA", s.aiId);
    await say(CHAT_ADMIN, "/foco");
    const [picker] = sends(CHAT_ADMIN);
    expect(picker.body.text).toBe("Qual conversa fica em foco? (suas conversas abertas)");
    expect(buttons(picker)).toEqual([{ text: "Carlos Lima · WhatsApp", callback_data: `fc:${carlos.conversationId}` }]);
    await tap(CHAT_ADMIN, 700, `fc:${carlos.conversationId}`);
    expect(texts(CHAT_ADMIN)[1]).toBe(
      "🎯 Foco: <b>Carlos Lima</b>\nWhatsApp · Qualificado\n\nTudo que você me disser agora é sobre essa conversa.\n/novo limpa.",
    );
    expect((await chatOf(CHAT_ADMIN))?.focus).toMatchObject({ conversationId: carlos.conversationId, leadId: carlos.leadId, source: "command" });
    // With a focus, /foco shows the current one first with "Limpar foco".
    await say(CHAT_ADMIN, "/foco");
    const withFocus = sends(CHAT_ADMIN).slice(2);
    expect(withFocus[0].body.text).toContain("🎯 Foco atual: <b>Carlos Lima</b>");
    expect(datas(withFocus[0])).toEqual(["fc:off"]);
    await say(CHAT_ADMIN, "/novo");
    expect(texts(CHAT_ADMIN).at(-1)).toBe("Foco limpo e conversa nova com o Copiloto.");
    const rotations = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j) =>
      j.name.includes("internalRotateCopilotThread"),
    );
    expect(rotations).toHaveLength(1);
    expect((await chatOf(CHAT_ADMIN))?.focus).toBeUndefined();
  });

  test("fc: recusa conversa de outro responsável (agent) e de outra org", async () => {
    const s = await seedOrg();
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER);
    const other = await seedLead(s, "Do Admin", s.adminId);
    const s2 = await seedOrg({ name: "Org B", slug: "b" });
    const foreign = await seedLead(s2, "Estrangeiro", s2.adminId);
    await tap(CHAT_SELLER, 700, `fc:${other.conversationId}`);
    await tap(CHAT_SELLER, 700, `fc:${foreign.conversationId}`);
    await tap(CHAT_SELLER, 700, "fc:garbage");
    expect(texts(CHAT_SELLER).every((x) => x.startsWith("⚠️ Não encontrei essa conversa"))).toBe(true);
    expect((await chatOf(CHAT_SELLER))?.focus).toBeUndefined();
  });

  test("sem conversas abertas", async () => {
    await adminChat();
    await say(CHAT_ADMIN, "/foco");
    expect(texts(CHAT_ADMIN)).toEqual(["Você não tem conversas abertas para pôr em foco."]);
  });
});

// ── /pausar ─────────────────────────────────────────────────────────────

describe("/pausar", () => {
  test("silencia TODOS os vínculos do chat; Retomar reverte", async () => {
    const s1 = await seedOrg();
    const s2 = await seedOrg({ name: "Org B", slug: "b" });
    const l1 = await linkMember(s1, s1.adminId, s1.adminUserId, CHAT_ADMIN);
    const l2 = await t.run(async (ctx) => {
      // Second org, same person/chat: same userId.
      const member = await ctx.db.insert("teamMembers", {
        organizationId: s2.organizationId, userId: s1.adminUserId, name: "Eric", role: "admin", type: "human",
        status: "active", createdAt: Date.now(), updatedAt: Date.now(),
      });
      return await ctx.db.insert("telegramLinks", {
        organizationId: s2.organizationId, teamMemberId: member, userId: s1.adminUserId, chatId: CHAT_ADMIN, telegramUserId: CHAT_ADMIN,
        status: "active", prefs: { relayAssignedConversations: true, mediaInbound: true },
        assistant: { mode: "suggest", suggestOnEvents: true, autoSendDelaySeconds: 15, autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false } },
        reports: { enabled: true, morningHour: 8, eveningHour: 18 }, linkedAt: Date.now(), lastSeenAt: Date.now(),
      });
    });
    await say(CHAT_ADMIN, "/pausar");
    const [menu] = sends(CHAT_ADMIN);
    expect(datas(menu)).toEqual(["mu:1h", "mu:tomorrow", "mu:off"]);
    await tap(CHAT_ADMIN, 700, "mu:1h");
    const until = Date.now() + 3600_000;
    expect(await pausedOf(l1)).toBe(until);
    expect(await pausedOf(l2)).toBe(until);
    expect((await linkOf(l1))?.mutedUntil).toBeUndefined();
    expect(edits()[0].body.text).toBe("🔕 <b>Silenciado até 13:00.</b>\nO sino segue registrando; pedido de ajuda urgente ainda avisa.");
    await tap(CHAT_ADMIN, 700, "mu:off");
    expect(await pausedOf(l1) ?? undefined).toBeUndefined();
    expect((await pausedOf(l2)) ?? undefined).toBeUndefined();
    expect(edits()[1].body.text).toBe("🔔 Notificações retomadas.");
  });

  test("até amanhã 8h no fuso da org; mutado ainda responde a comandos", async () => {
    const { linkId } = await adminChat();
    await say(CHAT_ADMIN, "/pausar");
    await tap(CHAT_ADMIN, 700, "mu:tomorrow");
    // 2026-11-04 08:00 America/Sao_Paulo (UTC-3) = 11:00Z.
    expect(await pausedOf(linkId)).toBe(Date.UTC(2026, 10, 4, 11, 0));
    expect(edits()[0].body.text).toBe("🔕 <b>Silenciado até amanhã 08:00.</b>\nO sino segue registrando; pedido de ajuda urgente ainda avisa.");
    await say(CHAT_ADMIN, "/repasses");
    expect(texts(CHAT_ADMIN).at(-1)).toBe("Nenhum repasse pendente 🎉");
  });
});

// ── /org ────────────────────────────────────────────────────────────────

describe("/org", () => {
  test("um só vínculo", async () => {
    await adminChat();
    await say(CHAT_ADMIN, "/org");
    expect(texts(CHAT_ADMIN)).toEqual(["Você só está vinculado a <b>Acme Corp</b>."]);
  });

  async function twoOrgs() {
    const s1 = await seedOrg();
    const s2 = await seedOrg({ name: "Aos Filhos da Terra", slug: "terra" });
    await linkMember(s1, s1.adminId, s1.adminUserId, CHAT_ADMIN);
    const { memberId, linkId } = await t.run(async (ctx) => {
      const now = Date.now();
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId: s2.organizationId, userId: s1.adminUserId, name: "Eric", role: "admin", type: "human",
        status: "active", createdAt: now, updatedAt: now,
      });
      const linkId = await ctx.db.insert("telegramLinks", {
        organizationId: s2.organizationId, teamMemberId: memberId, userId: s1.adminUserId, chatId: CHAT_ADMIN, telegramUserId: CHAT_ADMIN,
        status: "active", prefs: { relayAssignedConversations: true, mediaInbound: true },
        assistant: { mode: "suggest", suggestOnEvents: true, autoSendDelaySeconds: 15, autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false } },
        reports: { enabled: true, morningHour: 8, eveningHour: 18 }, linkedAt: now, lastSeenAt: now,
      });
      return { memberId, linkId };
    });
    return { s1, s2, memberId, linkId };
  }

  test("troca a org ativa e limpa o foco", async () => {
    const { s1, s2, memberId, linkId } = await twoOrgs();
    const c = await seedLead(s1, "Carlos", s1.adminId);
    await t.run(async (ctx) => {
      const chat = (await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first())!;
      await ctx.db.patch(chat._id, { focus: { conversationId: c.conversationId, setAt: Date.now(), source: "command" } });
    });
    await say(CHAT_ADMIN, "/org");
    const [menu] = sends(CHAT_ADMIN);
    expect(menu.body.text).toBe("Você está em <b>Acme Corp</b>.\n\nTrocar para:");
    expect(buttons(menu)).toEqual([{ text: "Aos Filhos da Terra", callback_data: `org:${linkId}` }]);
    await tap(CHAT_ADMIN, 700, `org:${linkId}`);
    const chat = await chatOf(CHAT_ADMIN);
    expect(chat).toMatchObject({ activeOrganizationId: s2.organizationId, activeTeamMemberId: memberId });
    expect(chat?.focus).toBeUndefined();
    expect(edits()[0].body.text).toBe("✅ Organização ativa: <b>Aos Filhos da Terra</b>.");
    await say(CHAT_ADMIN, "/repasses");
    expect(texts(CHAT_ADMIN).at(-1)).toBe("Nenhum repasse pendente 🎉");
    await say(CHAT_ADMIN, "/org");
    expect(sends(CHAT_ADMIN).at(-1)!.body.text).toBe("Você está em <b>Aos Filhos da Terra</b>.\n\nTrocar para:");
  });

  test("com duas orgs no chat o cabeçalho do cartão traz a org; com uma, não", async () => {
    const { s1 } = await twoOrgs();
    const lead = await seedLead(s1, "Maria Souza", s1.aiId);
    await seedHandoff(s1, lead);
    await say(CHAT_ADMIN, "/repasses");
    expect(sends(CHAT_ADMIN)[1].body.text.split("\n")[0]).toMatch(/^🔔 <b>Repasse da IA<\/b> · Acme Corp · \d\d:\d\d$/);
  });

  test("recusa e revoga o vínculo de membro removido; recusa link de outro chat", async () => {
    const { s2, memberId, linkId } = await twoOrgs();
    await t.run((ctx) => ctx.db.patch(memberId, { removedAt: Date.now() } as any));
    await tap(CHAT_ADMIN, 700, `org:${linkId}`);
    expect(edits()[0].body.text).toBe("Esse vínculo não está mais ativo.");
    expect((await linkOf(linkId))?.status).toBe("revoked");
    expect((await chatOf(CHAT_ADMIN))?.activeOrganizationId).not.toBe(s2.organizationId);
    // A link that belongs to another chat is not switchable from this one.
    const s3 = await seedOrg({ name: "Org C", slug: "c" });
    const foreign = await linkMember(s3, s3.adminId, s3.adminUserId, 9099);
    calls = [];
    await tap(CHAT_ADMIN, 700, `org:${foreign}`);
    expect(edits()[0].body.text).toBe("Esse vínculo não está mais ativo.");
    expect((await chatOf(CHAT_ADMIN))?.activeOrganizationId).not.toBe(s3.organizationId);
  });
});

// ── teclado ─────────────────────────────────────────────────────────────

describe("teclado persistente", () => {
  test("/start vincula e mostra o teclado por padrão; /teclado oculta e mostra", async () => {
    const s = await seedOrg();
    const code = "A".repeat(43);
    await t.run(async (ctx) => {
      await ctx.db.insert("telegramLinkCodes", {
        organizationId: s.organizationId, teamMemberId: s.adminId, userId: s.adminUserId,
        codeHash: await hashLinkCode(code), expiresAt: Date.now() + 600_000, createdAt: Date.now(),
      });
    });
    await say(CHAT_ADMIN, `/start ${code}`);
    // Card 0 (inline) first, the persistent keyboard in its own message.
    expect(sends(CHAT_ADMIN)[0].body.reply_markup.inline_keyboard[0][0].callback_data).toBe("ob:1");
    expect(sends(CHAT_ADMIN)[1].body.reply_markup).toEqual({
      keyboard: [[{ text: "📋 Hoje" }, { text: "🔁 Repasses" }], [{ text: "✅ Tarefas" }, { text: "⏸ Pausar" }]],
      resize_keyboard: true,
      is_persistent: true,
    });
    expect((await chatOf(CHAT_ADMIN))?.keyboardShown).toBe(true);
    await say(CHAT_ADMIN, "/teclado");
    expect(sends(CHAT_ADMIN).at(-1)!.body).toMatchObject({ text: "Teclado oculto.\n/teclado mostra de novo.", reply_markup: { remove_keyboard: true } });
    expect((await chatOf(CHAT_ADMIN))?.keyboardShown).toBe(false);
    await say(CHAT_ADMIN, "/teclado");
    expect(sends(CHAT_ADMIN).at(-1)!.body.reply_markup.is_persistent).toBe(true);
    expect((await chatOf(CHAT_ADMIN))?.keyboardShown).toBe(true);
  });

  test("⏸ Pausar e 🔁 Repasses são comandos", async () => {
    await adminChat();
    await say(CHAT_ADMIN, "⏸ Pausar");
    expect(datas(sends(CHAT_ADMIN)[0])).toEqual(["mu:1h", "mu:tomorrow", "mu:off"]);
    await say(CHAT_ADMIN, "🔁 Repasses");
    expect(texts(CHAT_ADMIN).at(-1)).toBe("Nenhum repasse pendente 🎉");
  });
});

// ── /hoje, /ajuda, desconhecido, grupo ─────────────────────────────────

describe("demais", () => {
  test("/hoje e 📋 Hoje pedem o relatório da manhã com trigger command", async () => {
    const { linkId } = await adminChat();
    await t.run(async (ctx) => {
      const chat = (await ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", CHAT_ADMIN)).first())!;
      expect(chat).toBeDefined();
    });
    await say(CHAT_ADMIN, "/hoje");
    await say(CHAT_ADMIN, "📋 Hoje");
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const reports = jobs.filter((j) => j.name.includes("internalSendReport"));
    expect(reports).toHaveLength(2);
    for (const j of reports) expect(j.args[0]).toEqual({ linkId, kind: "morning", trigger: "command" });
    // The command itself says nothing (the report does).
    expect(sends(CHAT_ADMIN).filter((c) => /Hoje|hoje/.test(c.body.text) && c.body.text.includes("não conheço"))).toHaveLength(0);
  });

  test("/ajuda lista os comandos; comando desconhecido; texto livre", async () => {
    await adminChat();
    await say(CHAT_ADMIN, "/ajuda");
    await say(CHAT_ADMIN, "/banana");
    await say(CHAT_ADMIN, "quais leads?");
    const [help, unknown, free] = texts(CHAT_ADMIN);
    for (const c of ["/hoje", "/repasses", "/tarefas", "/leads", "/foco", "/novo", "/pausar", "/org", "/teclado", "/sair"]) {
      expect(help).toContain(c);
    }
    expect(unknown).toBe("Não conheço esse comando.\n/ajuda lista o que sei fazer.");
    // F3: free text goes to the Copilot (AI off in this org → §4.10 copy).
    expect(free).toContain("IA não está ativada");
  });

  test("grupo nunca recebe listas", async () => {
    const { s } = await adminChat();
    const lead = await seedLead(s, "Maria", s.aiId);
    await seedHandoff(s, lead);
    await say(CHAT_ADMIN, "/repasses", "group");
    await say(CHAT_ADMIN, "/leads", "supergroup");
    expect(sends()).toHaveLength(0);
  });

  test("sem vínculo: avisa que o chat não está conectado, sem dados", async () => {
    await say(5555, "/repasses");
    expect(texts(5555)[0]).toContain("ainda não está conectado");
  });

  test("agent sem permissão de caixa recebe a negativa, não a lista", async () => {
    const s = await seedOrg();
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER);
    await t.run((ctx) =>
      ctx.db.patch(s.sellerId, {
        permissions: { leads: "view_own", contacts: "view", inbox: "none", tasks: "view_own", reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none" },
      } as any),
    );
    const lead = await seedLead(s, "Maria", s.aiId);
    await seedHandoff(s, lead);
    await say(CHAT_SELLER, "/repasses");
    expect(texts(CHAT_SELLER)).toHaveLength(1);
    expect(texts(CHAT_SELLER)[0]).toContain("🚫 Você não tem permissão");
    expect(texts(CHAT_SELLER)[0]).not.toContain("Maria");
  });
});

// ── review fixes ────────────────────────────────────────────────────────

describe("429 no meio da lista mantém a ordem", () => {
  test("429 na linha 3 reenvia 3..N em ordem e nunca repete as anteriores", async () => {
    const { s } = await adminChat();
    for (let i = 0; i < 5; i++) {
      const lead = await seedLead(s, `Lead ${i + 1}`, s.aiId);
      await seedHandoff(s, lead, { ageMin: 100 - i });
    }
    // sendMessage #1 header, #2 row 1, #3 row 2, #4 row 3 -> 429 (once).
    let sendCount = 0;
    const attempted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        const method = u.split("/").pop() ?? "";
        const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (method !== "sendMessage") return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        sendCount++;
        attempted.push(body.text);
        if (sendCount === 4) {
          return new Response(
            JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }),
            { status: 429 },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 800 + sendCount } }), { status: 200 });
      }),
    );
    await say(CHAT_ADMIN, "/repasses");
    const rows = attempted.map((x) => Number(x.match(/<b>Lead (\d+)<\/b>/)?.[1] ?? 0));
    // header(0), 1, 2, 3(429), 3, 4, 5
    expect(rows).toEqual([0, 1, 2, 3, 3, 4, 5]);
  });
});

describe("escopo por permissões efetivas", () => {
  async function twoLeads(s: Seed) {
    await seedLead(s, "Lead do Admin", s.adminId);
    await seedLead(s, "Lead do Vendedor", s.sellerId);
  }

  test("agent com leads:view_all vê a org; agent padrão só os seus", async () => {
    const s = await seedOrg();
    await linkMember(s, s.sellerId, s.sellerUserId, CHAT_SELLER);
    await twoLeads(s);
    await say(CHAT_SELLER, "/leads");
    expect(sends(CHAT_SELLER)[0].body.text).toContain("Seus leads");
    expect(sends(CHAT_SELLER)[0].body.text).not.toContain("Lead do Admin");
    await t.run((ctx) =>
      ctx.db.patch(s.sellerId, {
        permissions: { leads: "view_all", contacts: "view", inbox: "reply", tasks: "edit_own", reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none" },
      } as any),
    );
    await say(CHAT_SELLER, "/leads");
    const text = sends(CHAT_SELLER)[1].body.text as string;
    expect(text).toContain("👥 Leads · Acme Corp");
    expect(text).toContain("Lead do Admin");
    expect(text).toContain("Lead do Vendedor");
  });

  test("manager restrito a view_own vê só os próprios leads e repasses dirigidos/broadcast", async () => {
    const s = await seedOrg();
    const managerUserId = await t.run((ctx) => ctx.db.insert("users", { email: "manager@acme.test" }));
    const managerId = await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        organizationId: s.organizationId, userId: managerUserId, name: "Gerente", role: "manager", type: "human", status: "active",
        createdAt: Date.now(), updatedAt: Date.now(),
        permissions: { leads: "view_own", contacts: "view", inbox: "view_own", tasks: "view_own", reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none" },
      } as any),
    );
    await linkMember(s, managerId, managerUserId, 9003);
    const mine = await seedLead(s, "Lead do Gerente", managerId);
    await seedLead(s, "Lead do Admin", s.adminId);
    const other = await seedLead(s, "Outro", s.aiId);
    await seedHandoff(s, mine, { to: managerId });
    await seedHandoff(s, other, { to: s.adminId });
    await say(9003, "/leads");
    const leads = sends(9003)[0].body.text as string;
    expect(leads).toContain("Lead do Gerente");
    expect(leads).not.toContain("Lead do Admin");
    await say(9003, "/repasses");
    expect(texts(9003).join("\n")).toContain("1 repasse pendente");
  });
});

describe("/foco com poucas leituras", () => {
  test("lê no máximo 20 leads (≈60 documentos) e ignora os demais", async () => {
    const { s } = await adminChat();
    for (let i = 0; i < 25; i++) await seedLead(s, `Lead ${i + 1}`, s.adminId);
    await say(CHAT_ADMIN, "/foco");
    // 20 scanned, 10 shown + "Mais 10 →".
    const [picker] = sends(CHAT_ADMIN);
    expect(buttons(picker)).toHaveLength(11);
    await tap(CHAT_ADMIN, 700, "pg:foco:10");
    expect(buttons(sends(CHAT_ADMIN)[1])).toHaveLength(10);
    // Past the cap the link goes to the real inbox route.
    const { buildFocusPicker } = await import("./lib/telegramCommands");
    const capped = buildFocusPicker({ rows: [], offset: 40, discreet: false, hasMore: true, appBaseUrl: APP });
    expect(capped.keyboard).toEqual([[{ text: "🔗 Abrir no CRM", url: `${APP}/app/entrada` }]]);
  });
});
