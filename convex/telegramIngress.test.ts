/// <reference types="vite/client" />
/**
 * Copiloto no Telegram — F0: webhook (secret, dedupe, 200 sempre), vínculo
 * por `/start <code>`, `/sair`, `/ajuda`, chat sem vínculo, bloqueio, membro
 * removido, API do card e as varreduras. `fetch` SEMPRE stubado: nada sai
 * para api.telegram.org. Token e segredo são falsos.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const FAKE_TOKEN = "123456:FAKE-TOKEN-xyz";
const SECRET = "fake-telegram-webhook-secret";
const BOT = "hnbcrm_test_bot";
const APP = "https://app.example.test";
const CHAT_A = 7001;
const CHAT_B = 7002;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Call = { method: string; url: string; body: Record<string, any> };
let calls: Call[];
let nextMessageId: number;
let logs: string[];
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", FAKE_TOKEN);
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("TELEGRAM_BOT_USERNAME", BOT);
  vi.stubEnv("APP_URL", APP);
  calls = [];
  nextMessageId = 500;
  logs = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method: u.split("/").pop() ?? "", url: u, body });
      const result = u.endsWith("/sendMessage") ? { message_id: nextMessageId++ } : true;
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  for (const level of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  t = convexTest(schema, modules);
});

afterEach(() => {
  // Nenhum log, em nenhum teste, carrega o token.
  expect(logs.filter((l) => l.includes(FAKE_TOKEN))).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);
const sent = (method = "sendMessage") => calls.filter((c) => c.method === method);

// ── seed ────────────────────────────────────────────────────────────────

async function seedOrg(opts: { name?: string; slug?: string; telegram?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("organizations", {
      name: opts.name ?? "Acme Corp",
      slug: opts.slug ?? "acme",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        modules: { telegram: opts.telegram ?? true },
      },
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedUser(email: string | null = "eric@acme.test") {
  return await t.run(async (ctx) => await ctx.db.insert("users", email ? { email } : {}));
}

async function seedMember(
  organizationId: Id<"organizations">,
  userId: Id<"users">,
  name = "Eric Milfont",
  role: "admin" | "agent" = "admin",
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name,
      role,
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seed() {
  const organizationId = await seedOrg();
  const userId = await seedUser();
  const memberId = await seedMember(organizationId, userId);
  return { organizationId, userId, memberId };
}

const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function newCode(userId: Id<"users">, organizationId: Id<"organizations">) {
  const res = await as(userId).mutation(api.telegram.createLinkCode, { organizationId });
  const code = new URL(res.url).searchParams.get("start");
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return code!;
}

// ── updates ─────────────────────────────────────────────────────────────

let updateSeq = 1000;
function message(
  chatId: number,
  text: string,
  from: { id?: number; first_name?: string; username?: string; chatType?: string } = {},
) {
  return {
    update_id: updateSeq++,
    message: {
      message_id: updateSeq,
      date: 1,
      chat: { id: chatId, type: from.chatType ?? "private", first_name: from.first_name ?? "Eric" },
      from: { id: from.id ?? chatId, is_bot: false, first_name: from.first_name ?? "Eric", username: from.username ?? "ericm" },
      text,
    },
  };
}

async function post(update: unknown, secret: string | null = SECRET, raw?: string) {
  return await t.fetch("/webhooks/telegram/platform", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret !== null ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}),
    },
    body: raw ?? JSON.stringify(update),
  });
}

async function send(update: unknown) {
  const res = await post(update);
  expect(res.status).toBe(200);
  await drain();
  return res;
}

async function link(userId: Id<"users">, organizationId: Id<"organizations">, chatId = CHAT_A) {
  const code = await newCode(userId, organizationId);
  await send(message(chatId, `/start ${code}`));
  return code;
}

const linksOf = (memberId: Id<"teamMembers">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("telegramLinks").collect()).filter((l) => l.teamMemberId === memberId),
  );
const chatRow = (chatId: number) =>
  t.run(async (ctx) =>
    ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", chatId)).first(),
  );

// ── tests ───────────────────────────────────────────────────────────────

describe("webhook", () => {
  test("secret errado, ausente, ou env ausente → 401 e nada gravado", async () => {
    expect((await post(message(CHAT_A, "oi"), "wrong-secret")).status).toBe(401);
    expect((await post(message(CHAT_A, "oi"), null)).status).toBe(401);
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    expect((await post(message(CHAT_A, "oi"))).status).toBe(401);
    const rows = await t.run((ctx) => ctx.db.query("telegramUpdates").collect());
    expect(rows).toEqual([]);
  });

  test("secret válido → 200; JSON inválido também 200 sem gravar", async () => {
    expect((await post(null, SECRET, "{not json")).status).toBe(200);
    const res = await post(message(CHAT_A, "oi"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    const rows = await t.run((ctx) => ctx.db.query("telegramUpdates").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ botKey: "platform", kind: "message", chatId: CHAT_A, status: "pending" });
    await drain();
  });

  test("update_id repetido é idempotente: uma linha, um processamento", async () => {
    const update = message(CHAT_A, "oi");
    await send(update);
    await send(update);
    const rows = await t.run((ctx) => ctx.db.query("telegramUpdates").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
    expect(rows[0].parsed).toBeUndefined(); // recorte apagado ao terminar
    expect(sent()).toHaveLength(1);
  });

  test("callback_query → ack no corpo da resposta", async () => {
    const res = await post({
      update_id: updateSeq++,
      callback_query: { id: "cbq-1", from: { id: CHAT_A, first_name: "Eric" }, data: "x:1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: "answerCallbackQuery", callback_query_id: "cbq-1" });
    await drain();
  });

  test("sem TELEGRAM_BOT_TOKEN o envio é no-op logado (DEV neutralizado)", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    await send(message(CHAT_A, "oi"));
    expect(calls).toEqual([]);
    expect(logs.some((l) => l.includes("TELEGRAM_BOT_TOKEN ausente; chamada ignorada: sendMessage"))).toBe(true);
  });
});

describe("vínculo por /start <code>", () => {
  test("válido cria link + chat + auditoria e envia as boas-vindas em HTML", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId);

    const [l] = await linksOf(s.memberId);
    expect(l).toMatchObject({
      organizationId: s.organizationId,
      userId: s.userId,
      chatId: CHAT_A,
      telegramUserId: CHAT_A,
      username: "ericm",
      status: "active",
      prefs: { relayAssignedConversations: true, mediaInbound: true },
      reports: { enabled: true, morningHour: 8, eveningHour: 18 },
      assistant: {
        mode: "suggest",
        suggestOnEvents: true,
        autoSendDelaySeconds: 15,
        autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
      },
    });
    expect(await chatRow(CHAT_A)).toMatchObject({
      activeOrganizationId: s.organizationId,
      activeTeamMemberId: s.memberId,
    });
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.find((a) => a.metadata?.event === "telegram.linked")).toMatchObject({
      entityType: "telegramLink",
      entityId: l._id,
      severity: "high",
      actorId: s.memberId,
    });
    const codes = await t.run((ctx) => ctx.db.query("telegramLinkCodes").collect());
    expect(codes).toHaveLength(1);
    expect(codes[0].usedAt).toBeDefined();
    expect(codes[0].codeHash).toMatch(/^[0-9a-f]{64}$/);

    const [welcome] = sent();
    expect(welcome.body).toMatchObject({
      chat_id: CHAT_A,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(welcome.body.text).toBe(
      "Conectado como <b>Eric Milfont</b> em <b>Acme Corp</b>. Você vai receber repasses, tarefas e alertas aqui, " +
        "pode me mandar texto ou áudio a qualquer hora. /ajuda mostra tudo.",
    );
    // O código cru nunca é gravado.
    const code = await newCode(s.userId, s.organizationId);
    const dump = JSON.stringify(await t.run((ctx) => ctx.db.query("telegramLinkCodes").collect()));
    expect(dump).not.toContain(code);
  });

  test("código expirado é recusado", async () => {
    const s = await seed();
    const code = await newCode(s.userId, s.organizationId);
    vi.advanceTimersByTime(11 * 60 * 1000);
    await send(message(CHAT_A, `/start ${code}`));
    expect(await linksOf(s.memberId)).toEqual([]);
    expect(sent()[0].body.text).toBe(
      "Este link expirou ou já foi usado. Gere outro em Configurações → Notificações → Telegram.",
    );
  });

  test("código já usado é recusado", async () => {
    const s = await seed();
    const code = await link(s.userId, s.organizationId);
    calls = [];
    await send(message(CHAT_B, `/start ${code}`));
    const links = await linksOf(s.memberId);
    expect(links).toHaveLength(1);
    expect(links[0].chatId).toBe(CHAT_A);
    expect(sent()[0].body.text).toMatch(/expirou ou já foi usado/);
  });

  test("código novo invalida o anterior", async () => {
    const s = await seed();
    const first = await newCode(s.userId, s.organizationId);
    await newCode(s.userId, s.organizationId);
    await send(message(CHAT_A, `/start ${first}`));
    expect(await linksOf(s.memberId)).toEqual([]);
  });

  test("segunda org do mesmo usuário: dois vínculos, org ativa troca", async () => {
    const s = await seed();
    const org2 = await seedOrg({ name: "Aos Filhos da Terra", slug: "terra" });
    const member2 = await seedMember(org2, s.userId);
    await link(s.userId, s.organizationId);
    calls = [];
    await link(s.userId, org2);
    expect((await linksOf(s.memberId))[0].status).toBe("active");
    expect((await linksOf(member2))[0].status).toBe("active");
    expect(await chatRow(CHAT_A)).toMatchObject({ activeOrganizationId: org2, activeTeamMemberId: member2 });
    const text = sent()[0].body.text as string;
    expect(text).toContain("em <b>Aos Filhos da Terra</b>");
    expect(text).toContain("também está conectado a <b>Acme Corp</b>");
  });

  test("chat já ligado a outro usuário recusa", async () => {
    const s = await seed();
    const otherUser = await seedUser("ana@acme.test");
    const otherMember = await seedMember(s.organizationId, otherUser, "Ana");
    await link(s.userId, s.organizationId);
    calls = [];
    await link(otherUser, s.organizationId, CHAT_A);
    expect(await linksOf(otherMember)).toEqual([]);
    expect(sent()[0].body.text).toBe(
      "Este Telegram já está conectado a outra conta do HNBCRM. Use /sair lá primeiro.",
    );
  });

  test("vincular outro Telegram revoga o antigo (que recebe o aviso)", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId, CHAT_A);
    calls = [];
    await link(s.userId, s.organizationId, CHAT_B);
    const links = await linksOf(s.memberId);
    expect(links.find((l) => l.chatId === CHAT_A)?.status).toBe("revoked");
    expect(links.find((l) => l.chatId === CHAT_B)?.status).toBe("active");
    expect(sent().some((c) => c.body.chat_id === CHAT_A && /outro Telegram/.test(c.body.text))).toBe(true);
    expect((await chatRow(CHAT_A))?.activeOrganizationId).toBeUndefined();
  });

  test("membro removido: recusa no processador e o vínculo vira revoked", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId);
    await t.run((ctx) => ctx.db.patch(s.memberId, { status: "inactive", removedAt: Date.now() }));
    calls = [];
    await send(message(CHAT_A, "oi"));
    const [l] = await linksOf(s.memberId);
    expect(l.status).toBe("revoked");
    expect(l.revokedReason).toBe("member_removed");
    const texts = sent().map((c) => c.body.text as string);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^Sua conta não está mais nesta organização/);
    expect((await chatRow(CHAT_A))?.activeOrganizationId).toBeUndefined();
  });

  test("removeTeamMember revoga o vínculo na hora", async () => {
    const s = await seed();
    const agentUser = await seedUser("ana@acme.test");
    const agent = await seedMember(s.organizationId, agentUser, "Ana", "agent");
    await link(agentUser, s.organizationId, CHAT_B);
    await as(s.userId).mutation(api.teamMembers.removeTeamMember, { teamMemberId: agent });
    await drain();
    expect((await linksOf(agent))[0].status).toBe("revoked");
  });
});

describe("comandos e chat sem vínculo", () => {
  test("chat sem vínculo recebe o botão de configurações", async () => {
    await send(message(CHAT_A, "oi"));
    const [reply] = sent();
    expect(reply.body.chat_id).toBe(CHAT_A);
    expect(reply.body.text).toBe(
      "Este Telegram ainda não está conectado a uma conta do HNBCRM.\n" +
        'Abra Configurações → Notificações → Telegram no CRM e toque em "Conectar".',
    );
    expect(reply.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: "🔗 Abrir configurações", url: `${APP}/app/configuracoes?secao=notifications` }]],
    });
  });

  test("/ajuda e texto livre de chat vinculado", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId);
    calls = [];
    await send(message(CHAT_A, "/ajuda"));
    await send(message(CHAT_A, "quais leads?"));
    const [help, other] = sent();
    expect(help.body.text).toContain("/sair desconecta este Telegram.");
    expect(other.body.text).toBe(
      "Ainda estou aprendendo: por enquanto respondo a /ajuda e /sair. Em breve: repasses, tarefas e o Copiloto.",
    );
  });

  test("/sair revoga todos os vínculos do chat e remove o teclado", async () => {
    const s = await seed();
    const org2 = await seedOrg({ name: "Org Dois", slug: "dois" });
    const member2 = await seedMember(org2, s.userId);
    await link(s.userId, s.organizationId);
    await link(s.userId, org2);
    calls = [];
    await send(message(CHAT_A, "/sair"));
    expect((await linksOf(s.memberId))[0].status).toBe("revoked");
    expect((await linksOf(member2))[0].status).toBe("revoked");
    const farewells = sent();
    expect(farewells).toHaveLength(2);
    for (const f of farewells) {
      expect(f.body.reply_markup).toEqual({ remove_keyboard: true });
      expect(f.body.text).toMatch(/^Desconectado do HNBCRM \(/);
    }
    expect((await chatRow(CHAT_A))?.activeOrganizationId).toBeUndefined();
  });

  test("my_chat_member kicked → blocked; member → volta a active", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId);
    const status = (st: string) => ({
      update_id: updateSeq++,
      my_chat_member: {
        chat: { id: CHAT_A, type: "private" },
        from: { id: CHAT_A },
        date: 1,
        old_chat_member: { status: "member" },
        new_chat_member: { status: st },
      },
    });
    await send(status("kicked"));
    expect((await linksOf(s.memberId))[0].status).toBe("blocked");
    await send(status("member"));
    expect((await linksOf(s.memberId))[0].status).toBe("active");
  });

  test("403 no envio marca o vínculo como blocked", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), {
          status: 403,
        }),
      ),
    );
    await send(message(CHAT_A, "/ajuda"));
    expect((await linksOf(s.memberId))[0].status).toBe("blocked");
  });
});

describe("API do card", () => {
  test("módulo telegram: setOrgModules liga, desligado por padrão, fora da Central", async () => {
    const organizationId = await seedOrg({ slug: "mod", telegram: false });
    const userId = await seedUser();
    await seedMember(organizationId, userId);
    const before = await as(userId).query(api.orgModules.getOrgModules, { organizationId });
    expect(before.telegram).toBe(false);
    const after = await as(userId).mutation(api.orgModules.setOrgModules, { organizationId, modules: { telegram: true } });
    expect(after).toMatchObject({ telegram: true, units: false, departments: false, attribution: false, central: false });
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).find((a) => a.metadata?.modules));
    expect(audit?.changes?.after?.telegram).toBe(true);
  });

  test("createLinkCode recusa sem e-mail, sem módulo e sem TELEGRAM_BOT_USERNAME", async () => {
    const s = await seed();
    const anon = await seedUser(null);
    await seedMember(s.organizationId, anon, "Anônimo");
    await expect(
      as(anon).mutation(api.telegram.createLinkCode, { organizationId: s.organizationId }),
    ).rejects.toThrow(/conta com e-mail/);

    const offOrg = await seedOrg({ slug: "off", telegram: false });
    await seedMember(offOrg, s.userId);
    await expect(as(s.userId).mutation(api.telegram.createLinkCode, { organizationId: offOrg })).rejects.toThrow(
      /Módulo não habilitado: Telegram para a equipe/,
    );

    vi.stubEnv("TELEGRAM_BOT_USERNAME", "");
    await expect(
      as(s.userId).mutation(api.telegram.createLinkCode, { organizationId: s.organizationId }),
    ).rejects.toThrow(/Telegram não está configurado neste ambiente/);
  });

  test("createLinkCode devolve o deep link e expira em 10 min", async () => {
    const s = await seed();
    const now = Date.now();
    const res = await as(s.userId).mutation(api.telegram.createLinkCode, { organizationId: s.organizationId });
    expect(res.url).toMatch(new RegExp(`^https://t\\.me/${BOT}\\?start=[A-Za-z0-9_-]{43}$`));
    expect(res.expiresAt).toBe(now + 10 * 60 * 1000);
  });

  test("getMyLink: forma exata antes, durante e depois do vínculo", async () => {
    const s = await seed();
    const me = () => as(s.userId).query(api.telegram.getMyLink, { organizationId: s.organizationId });
    expect(await me()).toEqual({
      moduleEnabled: true,
      botUsername: BOT,
      link: null,
      org: { discreet: false, protectContent: false, allowAutoMode: true },
      canManage: true,
    });
    await link(s.userId, s.organizationId);
    const linked = await me();
    expect(Object.keys(linked.link!).sort()).toEqual(
      ["_id", "assistant", "firstName", "lastSeenAt", "linkedAt", "prefs", "reports", "status", "username"].sort(),
    );
    expect(linked.link).toMatchObject({
      status: "active",
      username: "ericm",
      firstName: "Eric",
      prefs: { relayAssignedConversations: true, mediaInbound: true },
      reports: { enabled: true, morningHour: 8, eveningHour: 18 },
      assistant: { mode: "suggest" },
    });
    await t.run(async (ctx) => {
      const [l] = await ctx.db.query("telegramLinks").collect();
      await ctx.db.patch(l._id, { status: "blocked" });
    });
    expect((await me()).link?.status).toBe("blocked");
    await as(s.userId).mutation(api.telegram.unlink, { organizationId: s.organizationId });
    await drain();
    expect((await me()).link).toBeNull();
  });

  test("unlink: revoga, audita, despede e apaga as mensagens das últimas 48 h", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId);
    const [l] = await linksOf(s.memberId);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const [messageId, sentAt] of [
        [11, now - HOUR],
        [12, now - 47 * HOUR],
        [13, now - 3 * DAY],
      ] as const) {
        await ctx.db.insert("telegramDeliveries", {
          organizationId: s.organizationId,
          linkId: l._id,
          chatId: CHAT_A,
          messageId,
          kind: "notification",
          sentAt,
        });
      }
    });
    calls = [];
    await as(s.userId).mutation(api.telegram.unlink, { organizationId: s.organizationId });
    await drain();
    expect((await linksOf(s.memberId))[0]).toMatchObject({ status: "revoked", revokedReason: "unlink" });
    expect(sent()[0].body).toMatchObject({ chat_id: CHAT_A, reply_markup: { remove_keyboard: true } });
    expect(sent()[0].body.text).toMatch(/^Desconectado do HNBCRM \(Acme Corp\)/);
    expect(sent("deleteMessage").map((c) => c.body.message_id).sort()).toEqual([11, 12]);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.metadata?.event === "telegram.unlinked" && a.severity === "high")).toBe(true);
    expect((await chatRow(CHAT_A))?.activeOrganizationId).toBeUndefined();
  });

  test("updateMyLinkPrefs valida horas e grava parcial", async () => {
    const s = await seed();
    const call = (args: Record<string, unknown>) =>
      as(s.userId).mutation(api.telegram.updateMyLinkPrefs, { organizationId: s.organizationId, ...args });
    await expect(call({ prefs: { mediaInbound: false } })).rejects.toThrow(/Nenhum Telegram conectado/);
    await link(s.userId, s.organizationId);
    await expect(call({ reports: { morningHour: 24 } })).rejects.toThrow(/entre 0 e 23/);
    await expect(call({ reports: { eveningHour: 7.5 } })).rejects.toThrow(/entre 0 e 23/);
    await expect(call({ reports: { eveningHour: -1 } })).rejects.toThrow(/entre 0 e 23/);
    await call({ prefs: { mediaInbound: false }, reports: { morningHour: 7 } });
    const [l] = await linksOf(s.memberId);
    expect(l.prefs).toEqual({ relayAssignedConversations: true, mediaInbound: false });
    expect(l.reports).toEqual({ enabled: true, morningHour: 7, eveningHour: 18 });
  });

  test("API pública exige membro da org", async () => {
    const s = await seed();
    const outsider = await seedUser("x@fora.test");
    await expect(as(outsider).query(api.telegram.getMyLink, { organizationId: s.organizationId })).rejects.toThrow(
      /Not authorized/,
    );
  });
});

describe("retenção e varredura", () => {
  test("retenção apaga telegramUpdates > 2 d, códigos > 1 d e entregas > 30 d", async () => {
    const s = await seed();
    const ids = await t.run(async (ctx) => {
      const now = Date.now();
      const upd = (updateId: number, receivedAt: number) =>
        ctx.db.insert("telegramUpdates", { botKey: "platform", updateId, kind: "message", receivedAt, status: "done" });
      const codeRow = (createdAt: number) =>
        ctx.db.insert("telegramLinkCodes", {
          organizationId: s.organizationId,
          teamMemberId: s.memberId,
          userId: s.userId,
          codeHash: `h-${createdAt}`,
          expiresAt: createdAt + 600_000,
          createdAt,
        });
      const linkId = await ctx.db.insert("telegramLinks", {
        organizationId: s.organizationId,
        teamMemberId: s.memberId,
        userId: s.userId,
        chatId: CHAT_A,
        telegramUserId: CHAT_A,
        status: "revoked",
        prefs: { relayAssignedConversations: true, mediaInbound: true },
        assistant: {
          mode: "suggest",
          suggestOnEvents: true,
          autoSendDelaySeconds: 15,
          autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
        },
        reports: { enabled: true, morningHour: 8, eveningHour: 18 },
        linkedAt: now,
        lastSeenAt: now,
      });
      const delivery = (sentAt: number) =>
        ctx.db.insert("telegramDeliveries", {
          organizationId: s.organizationId,
          linkId,
          chatId: CHAT_A,
          messageId: sentAt % 1000,
          kind: "notification",
          sentAt,
        });
      return {
        oldUpdate: await upd(1, now - 3 * DAY),
        newUpdate: await upd(2, now - HOUR),
        oldCode: await codeRow(now - 2 * DAY),
        newCode: await codeRow(now - HOUR),
        oldDelivery: await delivery(now - 31 * DAY),
        newDelivery: await delivery(now - 29 * DAY),
      };
    });
    for (const table of ["telegramUpdates", "telegramLinkCodes", "telegramDeliveries"] as const) {
      await t.mutation(internal.retention.internalRunRetentionNow, { dryRun: false, table });
      await drain();
    }
    const exists = (id: string) => t.run(async (ctx) => (await ctx.db.get(id as any)) !== null);
    expect(await exists(ids.oldUpdate)).toBe(false);
    expect(await exists(ids.newUpdate)).toBe(true);
    expect(await exists(ids.oldCode)).toBe(false);
    expect(await exists(ids.newCode)).toBe(true);
    expect(await exists(ids.oldDelivery)).toBe(false);
    expect(await exists(ids.newDelivery)).toBe(true);
  });

  test("internalRevokeForRemovedMembers: dryRun só relata, real revoga", async () => {
    const s = await seed();
    const user2 = await seedUser("ana@acme.test");
    const member2 = await seedMember(s.organizationId, user2, "Ana", "agent");
    await link(s.userId, s.organizationId, CHAT_A);
    await link(user2, s.organizationId, CHAT_B);
    await t.run((ctx) => ctx.db.patch(member2, { removedAt: Date.now() }));

    const dry = await t.mutation(internal.telegram.internalRevokeForRemovedMembers, {});
    expect(dry).toMatchObject({
      dryRun: true,
      status: "active",
      nextStatus: "blocked",
      scanned: 2,
      toRevoke: 1,
      revoked: 0,
      isDone: false,
    });
    expect(JSON.stringify(dry)).not.toMatch(/Ana|Eric|7001|7002/);
    expect((await linksOf(member2))[0].status).toBe("active");

    const real = await t.mutation(internal.telegram.internalRevokeForRemovedMembers, { dryRun: false, pageSize: 1 });
    await drain();
    expect(real.dryRun).toBe(false);
    expect((await linksOf(member2))[0].status).toBe("revoked");
    expect((await linksOf(s.memberId))[0].status).toBe("active");
  });

  test("varredura do cron respeita CRONS_DISABLED", async () => {
    vi.stubEnv("CRONS_DISABLED", "1");
    const res = await t.mutation(internal.telegram.internalRevokeForRemovedMembers, { dryRun: false, fromCron: true });
    expect(res.skipped).toBe("crons_disabled");
  });
});

describe("revisão de segurança (F0)", () => {
  test("/start <code> num grupo não cria vínculo nem responde", async () => {
    const s = await seed();
    const code = await newCode(s.userId, s.organizationId);
    await send(message(-100123, `/start ${code}`, { chatType: "group" }));
    expect(await linksOf(s.memberId)).toEqual([]);
    expect(sent()).toEqual([]);
    const codes = await t.run((ctx) => ctx.db.query("telegramLinkCodes").collect());
    expect(codes[0].usedAt).toBeUndefined();
  });

  test("nome do membro com HTML sai escapado nas boas-vindas", async () => {
    const organizationId = await seedOrg();
    const userId = await seedUser();
    await seedMember(organizationId, userId, "<b>X</b>&");
    await link(userId, organizationId);
    const text = sent()[0].body.text as string;
    expect(text).toContain("Conectado como <b>&lt;b&gt;X&lt;/b&gt;&amp;</b> em <b>Acme Corp</b>.");
    expect(text).not.toContain("<b>X</b>&");
  });

  test("código válido com o módulo desligado depois de gerado: aviso e nenhum vínculo", async () => {
    const s = await seed();
    const code = await newCode(s.userId, s.organizationId);
    await t.run(async (ctx) => {
      const org = await ctx.db.get(s.organizationId);
      await ctx.db.patch(s.organizationId, { settings: { ...org!.settings, modules: { telegram: false } } });
    });
    await send(message(CHAT_A, `/start ${code}`));
    expect(await linksOf(s.memberId)).toEqual([]);
    expect(sent()[0].body.text).toBe(
      "O Telegram não está habilitado nesta organização. Peça a um admin para ligar em Configurações → Notificações → Telegram.",
    );
  });

  test("vínculo bloqueado de outro usuário também ocupa o chat (desbloquear não junta dois usuários)", async () => {
    const s = await seed();
    const userB = await seedUser("ana@acme.test");
    const memberB = await seedMember(s.organizationId, userB, "Ana");
    await link(s.userId, s.organizationId, CHAT_A);
    await send({
      update_id: updateSeq++,
      my_chat_member: { chat: { id: CHAT_A, type: "private" }, from: { id: CHAT_A }, date: 1, new_chat_member: { status: "kicked" } },
    });
    expect((await linksOf(s.memberId))[0].status).toBe("blocked");
    calls = [];
    await link(userB, s.organizationId, CHAT_A);
    expect(await linksOf(memberB)).toEqual([]);
    expect(sent()[0].body.text).toMatch(/já está conectado a outra conta/);
    await send({
      update_id: updateSeq++,
      my_chat_member: { chat: { id: CHAT_A, type: "private" }, from: { id: CHAT_A }, date: 1, new_chat_member: { status: "member" } },
    });
    const active = await t.run((ctx) =>
      ctx.db
        .query("telegramLinks")
        .withIndex("by_chat_id_and_status", (q) => q.eq("chatId", CHAT_A).eq("status", "active"))
        .collect(),
    );
    expect(active.map((l) => l.userId)).toEqual([s.userId]);
  });

  test("varredura real também revoga vínculo bloqueado de membro removido", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId, CHAT_A);
    await t.run(async (ctx) => {
      const [l] = await ctx.db.query("telegramLinks").collect();
      await ctx.db.patch(l._id, { status: "blocked" });
      await ctx.db.patch(s.memberId, { removedAt: Date.now() });
    });
    const dryBlocked = await t.mutation(internal.telegram.internalRevokeForRemovedMembers, { status: "blocked" });
    expect(dryBlocked).toMatchObject({ status: "blocked", nextStatus: null, toRevoke: 1, revoked: 0, isDone: true });
    await t.mutation(internal.telegram.internalRevokeForRemovedMembers, { dryRun: false });
    await drain();
    expect((await linksOf(s.memberId))[0]).toMatchObject({ status: "revoked", revokedReason: "member_removed" });
  });

  test("ingest que falha (nada gravado) responde 500 para o Telegram repetir", async () => {
    // Campo iniciado por "$" não é valor Convex: o runMutation do ingest lança antes de gravar.
    const res = await post({ update_id: updateSeq++, $bad: 1, message: { chat: { id: CHAT_A, type: "private" } } });
    expect(res.status).toBe(500);
    expect(await t.run((ctx) => ctx.db.query("telegramUpdates").collect())).toEqual([]);
    expect(logs.some((l) => l.includes("ingest falhou"))).toBe(true);
  });
});

describe("revisão de segurança (F0, 2º lote)", () => {
  test("429 no meio: o retry agendado leva só os blocos que faltam, sem repetir os entregues", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push({ method: String(url).split("/").pop() ?? "", url: String(url), body });
        n++;
        if (n === 2) {
          return new Response(
            JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } }),
            { status: 429 },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: n } }), { status: 200 });
      }),
    );
    await t.action(internal.telegram.internalDeliverReply, {
      reply: { chatId: CHAT_A, chunks: ["um", "dois", "três"] },
      attempt: 1,
    });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const retry = scheduled.find((j) => j.name.includes("internalDeliverReply"));
    expect(retry?.args[0]).toEqual({ reply: { chatId: CHAT_A, chunks: ["dois", "três"] }, attempt: 2 });
    await drain();
    expect(sent().map((c) => c.body.text)).toEqual(["um", "dois", "dois", "três"]);
  });

  test("erro do processamento grava só o nome, nunca a mensagem (que ecoa argumentos)", async () => {
    const s = await seed();
    const code = await newCode(s.userId, s.organizationId);
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error(`falhou com ${code} de Eric Milfont`));
    await send(message(CHAT_A, `/start ${code}`));
    const [row] = await t.run((ctx) => ctx.db.query("telegramUpdates").collect());
    expect(row.status).toBe("error");
    expect(row.error).toBe("Error");
    expect(JSON.stringify(row)).not.toContain(code);
  });

  test("callback_query sem `message` não vira chat privado: só o ack, nenhuma resposta", async () => {
    const res = await post({
      update_id: updateSeq++,
      callback_query: { id: "cbq-2", from: { id: CHAT_B, first_name: "Eric" }, data: "x:1" },
    });
    expect(await res.json()).toEqual({ method: "answerCallbackQuery", callback_query_id: "cbq-2" });
    await drain();
    expect(sent()).toEqual([]);
    const [row] = await t.run((ctx) => ctx.db.query("telegramUpdates").collect());
    expect(row.chatId).toBeUndefined();
    expect(row.status).toBe("done");
  });

  test("auditoria da revogação descreve o motivo e não atribui ao membro removido", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId, CHAT_A);
    await link(s.userId, s.organizationId, CHAT_B); // moved
    await t.run((ctx) => ctx.db.patch(s.memberId, { removedAt: Date.now() }));
    await send(message(CHAT_B, "oi")); // processador detecta a remoção
    const audits = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).filter(
      (a) => a.metadata?.event === "telegram.unlinked",
    );
    const byReason = Object.fromEntries(audits.map((a) => [a.metadata!.reason, a]));
    expect(byReason.moved).toMatchObject({
      description: "Telegram vinculado a outro chat",
      actorType: "human",
      actorId: s.memberId,
    });
    expect(byReason.member_removed).toMatchObject({
      description: "Vínculo do Telegram revogado (membro removido)",
      actorType: "system",
    });
    expect(byReason.member_removed.actorId).toBeUndefined();
  });

  test("unlink e /sair: \"Desconectou o Telegram\" pelo próprio membro", async () => {
    const s = await seed();
    await link(s.userId, s.organizationId, CHAT_A);
    await send(message(CHAT_A, "/sair"));
    const audit = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).find(
      (a) => a.metadata?.event === "telegram.unlinked",
    );
    expect(audit).toMatchObject({ description: "Desconectou o Telegram", actorType: "human", actorId: s.memberId });
  });
});
