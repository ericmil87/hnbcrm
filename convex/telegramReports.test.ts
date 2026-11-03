/// <reference types="vite/client" />
/**
 * Relatórios do Telegram (F2, D11): cron de hora em hora na hora LOCAL de
 * cada org, carimbo por data local (idempotente), fim de semana, escopo
 * agente × admin, tetos "50+", `/hoje` (trigger command) sem carimbo, gates e
 * paginação. `fetch` stubado; token falso.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { ReportData } from "./lib/executiveReport";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// Terça 03/11/2026 11:05 UTC = 08:05 em São Paulo (UTC−3) = 07:05 em Manaus (UTC−4).
const TUE_1105 = Date.UTC(2026, 10, 3, 11, 5);
const TUE_1205 = Date.UTC(2026, 10, 3, 12, 5);
const SAT_1105 = Date.UTC(2026, 10, 7, 11, 5);
const HOUR = 60 * 60 * 1000;

type Call = { method: string; body: Record<string, any> };
let calls: Call[];
let nextId: number;
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TUE_1105);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:FAKE-TOKEN-rep");
  vi.stubEnv("APP_URL", "https://app.example.test");
  calls = [];
  nextId = 700;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: nextId++ } : true }), {
        status: 200,
      });
    }),
  );
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
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
const tick = async (now: number) => {
  vi.setSystemTime(now);
  const res = await t.mutation(internal.telegramReports.internalReportsTick, {});
  await drain();
  return res;
};

async function seedOrg(opts: { slug: string; tz?: string; telegram?: boolean }) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${opts.slug}`,
      slug: opts.slug,
      settings: { timezone: opts.tz ?? "America/Sao_Paulo", currency: "BRL", modules: { telegram: opts.telegram ?? true } },
      createdAt: now,
      updatedAt: now,
    });
    const member = async (name: string, role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", { email: `${name.toLowerCase()}@${opts.slug}.test` });
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active", createdAt: now, updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await member("Eric", "admin");
    const agent = await member("Ana", "agent");
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#000", order: 0, isClosedWon: false, isClosedLost: false,
      createdAt: now, updatedAt: now,
    });
    return { organizationId, admin, agent, boardId, stageId };
  });
}
type Org = Awaited<ReturnType<typeof seedOrg>>;

async function link(org: Org, who: { userId: Id<"users">; memberId: Id<"teamMembers"> }, chatId: number, reports: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("telegramLinks", {
      organizationId: org.organizationId, teamMemberId: who.memberId, userId: who.userId, chatId, telegramUserId: chatId,
      status: "active",
      prefs: { relayAssignedConversations: true, mediaInbound: true },
      assistant: {
        mode: "suggest", suggestOnEvents: true, autoSendDelaySeconds: 15,
        autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
      },
      reports: { enabled: true, morningHour: 8, eveningHour: 18, ...reports },
      linkedAt: now, lastSeenAt: now,
    });
  });
}

async function lead(org: Org, title: string, extra: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("leads", {
      organizationId: org.organizationId, title, boardId: org.boardId, stageId: org.stageId, value: 0, currency: "BRL",
      priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), ...extra,
    } as any),
  );
}

async function task(org: Org, title: string, assignedTo: Id<"teamMembers">, extra: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("tasks", {
      organizationId: org.organizationId, title, type: "task", status: "pending", priority: "medium",
      assignedTo, createdBy: assignedTo, createdAt: Date.now(), updatedAt: Date.now(), ...extra,
    } as any),
  );
}

describe("cron por fuso (D11)", () => {
  test("São Paulo às 11:05 UTC, Manaus às 12:05 UTC — cada um na sua hora local", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const ma = await seedOrg({ slug: "ma", tz: "America/Manaus" });
    await link(sp, sp.admin, 1001);
    await link(ma, ma.admin, 1002);
    await tick(TUE_1105);
    expect(sends(1001)).toHaveLength(1);
    expect(sends(1001)[0].body.text).toMatch(/^☀️ Bom dia, Eric · Org sp · ter 03\/11/);
    expect(sends(1002)).toEqual([]);
    await tick(TUE_1205);
    expect(sends(1002)).toHaveLength(1);
    expect(sends(1001)).toHaveLength(1);
    // A entrega fica registrada (kind report).
    const deliveries = await t.run((ctx) => ctx.db.query("telegramDeliveries").collect());
    expect(deliveries.map((d) => d.kind)).toEqual(["report", "report"]);
  });

  test("idempotente: duas execuções na mesma hora → um envio; carimbo sobrevive", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const linkId = await link(sp, sp.admin, 1001);
    await tick(TUE_1105);
    await tick(TUE_1105 + 10 * 60 * 1000);
    expect(sends(1001)).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(linkId)))!.lastMorningReportDate).toBe("2026-11-03");
    // "Reinício": nova cadeia do zero na mesma hora local.
    await t.mutation(internal.telegramReports.internalReportsTick, { cursor: null });
    await drain();
    expect(sends(1001)).toHaveLength(1);
  });

  test("fim de semana pulado por padrão; enviado com weekends:true", async () => {
    const sp = await seedOrg({ slug: "sp" });
    await link(sp, sp.admin, 1001);
    await link(sp, sp.agent, 1003, { weekends: true });
    await tick(SAT_1105);
    expect(sends(1001)).toEqual([]);
    expect(sends(1003)).toHaveLength(1);
  });

  test("fim do dia às 18h locais", async () => {
    const sp = await seedOrg({ slug: "sp" });
    await link(sp, sp.admin, 1001);
    await tick(Date.UTC(2026, 10, 3, 21, 5));
    expect(sends(1001)[0].body.text).toMatch(/^🌙 Fechamento · ter 03\/11 · Org sp/);
  });

  test("vínculo com relatórios desligados, módulo desligado ou revogado: nada", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const off = await seedOrg({ slug: "off", telegram: false });
    await link(sp, sp.admin, 1001, { enabled: false });
    const revoked = await link(sp, sp.agent, 1003);
    await t.run((ctx) => ctx.db.patch(revoked, { status: "revoked" }));
    await link(off, off.admin, 1004);
    const res = await tick(TUE_1105);
    expect(res.scheduled).toBe(0);
    expect(sends()).toEqual([]);
  });

  test("CRONS_DISABLED=1 → no-op", async () => {
    const sp = await seedOrg({ slug: "sp" });
    await link(sp, sp.admin, 1001);
    vi.stubEnv("CRONS_DISABLED", "1");
    const res = await tick(TUE_1105);
    expect(res.skipped).toBe("crons_disabled");
    expect(sends()).toEqual([]);
  });

  test("paginação: 101 vínculos em duas páginas, todos atendidos uma vez", async () => {
    const sp = await seedOrg({ slug: "sp" });
    for (let i = 0; i < 101; i++) await link(sp, sp.admin, 5000 + i);
    const first = await t.mutation(internal.telegramReports.internalReportsTick, {});
    expect(first).toMatchObject({ scanned: 100, scheduled: 100, isDone: false });
    await drain();
    expect(sends()).toHaveLength(101);
    const stamped = (await t.run((ctx) => ctx.db.query("telegramLinks").collect())).filter(
      (l) => l.lastMorningReportDate === "2026-11-03",
    );
    expect(stamped).toHaveLength(101);
  });
});

describe("/hoje (trigger command)", () => {
  test("envia mesmo com relatórios desligados e NÃO carimba", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const linkId = await link(sp, sp.admin, 1001, { enabled: false });
    await t.action(internal.telegramReports.internalSendReport, { linkId, kind: "morning", trigger: "command" });
    expect(sends(1001)).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(linkId)))!.lastMorningReportDate).toBeUndefined();
    // Cron com relatórios desligados: não envia.
    await t.action(internal.telegramReports.internalSendReport, { linkId, kind: "morning", trigger: "cron" });
    expect(sends(1001)).toHaveLength(1);
  });

  test("membro sem inbox:view_own não recebe", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const linkId = await link(sp, sp.agent, 1003);
    await t.run((ctx) =>
      ctx.db.patch(sp.agent.memberId, {
        permissions: {
          leads: "view_own", contacts: "view", inbox: "none", tasks: "view_own",
          reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none",
        } as any,
      }),
    );
    await t.action(internal.telegramReports.internalSendReport, { linkId, kind: "morning", trigger: "command" });
    expect(sends()).toEqual([]);
  });
});

describe("dados (internalBuildReportData)", () => {
  test("agente vê as próprias tarefas/leads; admin vê a org", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const now = TUE_1105;
    const todayAt = (h: number) => Date.UTC(2026, 10, 3, h + 3, 0); // hora local SP
    await task(sp, "Tarefa do admin", sp.admin.memberId, { dueDate: todayAt(10) });
    await task(sp, "Tarefa da Ana", sp.agent.memberId, { dueDate: todayAt(11) });
    await task(sp, "Atrasada da Ana", sp.agent.memberId, { dueDate: todayAt(-20) });
    await lead(sp, "Lead da Ana", { assignedTo: sp.agent.memberId, createdAt: now - HOUR });
    await lead(sp, "Lead sem dono", { createdAt: now - HOUR });
    await lead(sp, "Lead antigo", { createdAt: now - 3 * 24 * HOUR });
    const data = async (memberId: Id<"teamMembers">) =>
      (await t.query(internal.telegramReports.internalBuildReportData, {
        organizationId: sp.organizationId, memberId, kind: "morning", now,
      })) as ReportData | null;
    const agent = (await data(sp.agent.memberId))!;
    expect(agent.scope).toBe("own");
    expect(agent.morning!.tasksToday.items.map((i) => i.title)).toEqual(["Tarefa da Ana"]);
    expect(agent.morning!.tasksOverdue.count).toBe(1);
    expect(agent.morning!.newLeads).toMatchObject({ count: 1, mine: 1 });
    expect(agent.morning!.followUps).toBeNull();
    const admin = (await data(sp.admin.memberId))!;
    expect(admin.scope).toBe("org");
    expect(admin.morning!.tasksToday.items.map((i) => i.title)).toEqual(["Tarefa do admin"]);
    expect(admin.morning!.newLeads).toMatchObject({ count: 2, mine: 0 });
    expect(admin.morning!.followUps).toEqual({ count: 0, capped: false, items: [] });
  });

  test("teto: 55 leads novos viram '50+'", async () => {
    const sp = await seedOrg({ slug: "sp" });
    for (let i = 0; i < 55; i++) await lead(sp, `Lead ${i}`, { createdAt: TUE_1105 - HOUR });
    const data = (await t.query(internal.telegramReports.internalBuildReportData, {
      organizationId: sp.organizationId, memberId: sp.admin.memberId, kind: "morning", now: TUE_1105,
    })) as ReportData;
    expect(data.morning!.newLeads).toMatchObject({ count: 50, capped: true });
    const linkId = await link(sp, sp.admin, 1001);
    await t.action(internal.telegramReports.internalSendReport, { linkId, kind: "morning", trigger: "command" });
    expect(sends(1001)[0].body.text).toContain("🆕 50+ leads desde ontem 18h");
  });

  test("fim do dia: ganhos somados, repasse sem dono vira botão 'Pegar'", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const at = Date.UTC(2026, 10, 3, 21, 5); // 18:05 SP
    vi.setSystemTime(at);
    await lead(sp, "Ganho A", { closedAt: at - HOUR, closedType: "won", value: 5000 });
    await lead(sp, "Ganho B", { closedAt: at - HOUR, closedType: "won", value: 4120 });
    await lead(sp, "Perdido", { closedAt: at - HOUR, closedType: "lost", value: 100 });
    const leadId = await lead(sp, "Ana Reis", { createdAt: at - 2 * HOUR });
    const handoffId = await t.run(async (ctx) => {
      const ai = await ctx.db.insert("teamMembers", {
        organizationId: sp.organizationId, name: "IA", role: "ai", type: "ai", status: "active", createdAt: at, updatedAt: at,
      });
      return await ctx.db.insert("handoffs", {
        organizationId: sp.organizationId, leadId, fromMemberId: ai, reason: "reclamação", suggestedActions: [],
        status: "pending", createdAt: at - 3 * HOUR,
      });
    });
    const linkId = await link(sp, sp.admin, 1001);
    await t.action(internal.telegramReports.internalSendReport, { linkId, kind: "evening", trigger: "command" });
    const msg = sends(1001)[0];
    expect(msg.body.text).toContain("🏆 2 ganhos (R$ 9.120) · ❌ 1 perdido");
    expect(msg.body.text).toContain("🔁 1 repasse ainda sem dono: Ana Reis (reclamação, 3h esperando) ⚠️");
    expect(msg.body.reply_markup.inline_keyboard[0]).toEqual([{ text: "🔁 Pegar Ana Reis", callback_data: `ah:${handoffId}` }]);
  });
});

describe("revisão F2 — lote 1", () => {
  const agentPerms = (over: Record<string, string>) => ({
    leads: "edit_own", contacts: "edit", inbox: "reply", tasks: "edit_own", reports: "view",
    team: "none", settings: "none", auditLogs: "none", apiKeys: "none", campaigns: "view", ...over,
  });
  const build = async (org: Org, memberId: Id<"teamMembers">, kind: "morning" | "evening", now: number, weekends?: boolean) =>
    (await t.query(internal.telegramReports.internalBuildReportData, {
      organizationId: org.organizationId, memberId, kind, now, ...(weekends !== undefined ? { weekends } : {}),
    })) as ReportData;

  test("#2 /hoje no máximo uma vez por minuto", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const linkId = await link(sp, sp.admin, 1001);
    const hoje = () => t.action(internal.telegramReports.internalSendReport, { linkId, kind: "morning", trigger: "command" });
    await hoje();
    vi.setSystemTime(TUE_1105 + 30_000);
    await hoje();
    expect(sends(1001)).toHaveLength(2);
    expect(sends(1001)[0].body.text).toMatch(/^☀️ Bom dia/);
    expect(sends(1001)[1].body.text).toBe("⏳ Acabei de mandar o relatório; peça de novo em 1 min.");
    vi.setSystemTime(TUE_1105 + 61_000);
    await hoje();
    expect(sends(1001)[2].body.text).toMatch(/^☀️ Bom dia/);
  });

  test("#3 não lidas do agente fora das 200 primeiras: '0+', não '0'", async () => {
    const sp = await seedOrg({ slug: "sp" });
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert("conversations", {
          organizationId: sp.organizationId, channel: "whatsapp", status: "active", messageCount: 1,
          unreadCount: i < 295 ? 1 : 5, // as 5 do agente ordenam DEPOIS no índice
          ...(i >= 295 ? { assignedTo: sp.agent.memberId } : {}),
          createdAt: now, updatedAt: now,
        });
      }
    });
    const data = await build(sp, sp.agent.memberId, "morning", TUE_1105);
    expect(data.morning!.unread).toEqual({ count: 0, capped: true });
    const linkId = await link(sp, sp.agent, 1003);
    await t.action(internal.telegramReports.internalSendReport, { linkId, kind: "morning", trigger: "command" });
    expect(sends(1003)[0].body.text).toContain("💬 0+ conversas não lidas");
  });

  test("#3 tarefa de hoje depois das 200 mais antigas ainda conta (faixa por prazo)", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const nextWeek = TUE_1105 + 7 * 24 * HOUR;
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("tasks", {
          organizationId: sp.organizationId, title: `Futura ${i}`, type: "task", status: "pending", priority: "medium",
          assignedTo: sp.admin.memberId, createdBy: sp.admin.memberId, dueDate: nextWeek, createdAt: now, updatedAt: now,
        } as any);
      }
    });
    await task(sp, "A de hoje", sp.admin.memberId, { dueDate: Date.UTC(2026, 10, 3, 17, 0) });
    const data = await build(sp, sp.admin.memberId, "morning", TUE_1105);
    expect(data.morning!.tasksToday).toMatchObject({ count: 1, capped: false });
    expect(data.morning!.tasksToday.items.map((i) => i.title)).toEqual(["A de hoje"]);
  });

  test("#4 bloco de IA por settings:view, não por papel; escopo por permissão resolvida", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const at = Date.UTC(2026, 10, 3, 21, 5);
    await t.run(async (ctx) => {
      await ctx.db.patch(sp.agent.memberId, { permissions: agentPerms({ settings: "view", leads: "edit_all" }) as any });
      const userId = await ctx.db.insert("users", { email: "gerente@sp.test" });
      await ctx.db.insert("teamMembers", {
        organizationId: sp.organizationId, userId, name: "Gerente", role: "manager", type: "human", status: "active",
        permissions: {
          leads: "edit_all", contacts: "edit", inbox: "full", tasks: "edit_all", reports: "view",
          team: "view", settings: "none", auditLogs: "view", apiKeys: "none", campaigns: "manage",
        } as any,
        createdAt: at, updatedAt: at,
      });
    });
    const manager = await t.run(async (ctx) =>
      (await ctx.db.query("teamMembers").collect()).find((m) => m.name === "Gerente")!._id,
    );
    const agent = await build(sp, sp.agent.memberId, "evening", at);
    expect(agent.scope).toBe("org"); // leads:edit_all customizado
    expect(agent.evening!.ai).not.toBeNull();
    const mgr = await build(sp, manager, "evening", at);
    expect(mgr.scope).toBe("org");
    expect(mgr.evening!.ai).toBeNull();
  });

  test("#5 segunda sem fim de semana olha desde sexta 18h; com fim de semana, desde domingo 18h", async () => {
    const sp = await seedOrg({ slug: "sp" });
    const MON_1105 = Date.UTC(2026, 10, 9, 11, 5); // segunda 08:05 SP
    vi.setSystemTime(MON_1105);
    await lead(sp, "Lead de sábado", { createdAt: Date.UTC(2026, 10, 7, 13, 0) });
    await lead(sp, "Lead de domingo à noite", { createdAt: Date.UTC(2026, 10, 9, 0, 0) });
    const off = await build(sp, sp.admin.memberId, "morning", MON_1105, false);
    expect(off.morning!.newLeads).toMatchObject({ count: 2, sinceLabel: "sexta 18h" });
    const on = await build(sp, sp.admin.memberId, "morning", MON_1105, true);
    expect(on.morning!.newLeads).toMatchObject({ count: 1, sinceLabel: "ontem 18h" });
  });
});
