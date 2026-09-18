/// <reference types="vite/client" />
/**
 * Publicações programadas em grupos (F3) — CRUD, RBAC, worker e aprovação.
 *
 * O que estes testes travam:
 *  - `create`/`activate` calculam o `nextRunAt` a partir da agenda no fuso;
 *  - o tick publica UMA mensagem por grupo, com `metadata.groupPost` +
 *    `scheduled: true`, e reagenda para o próximo slot;
 *  - a biblioteca sequencial anda no cursor e o mesmo slot nunca publica duas
 *    vezes (`lastSlotKey`);
 *  - IA: `generate` cria o pendente e notifica; aprovado publica; sem
 *    aprovação o `onMissedApproval` decide entre pular e publicar;
 *  - canal desconectado PAUSA a publicação e notifica `group_post_failed`;
 *  - o teto diário por canal pula o slot sem pausar;
 *  - `sendNow` com `dryRun` devolve a prévia sem escrever nada;
 *  - RBAC `campaigns` (view/manage/full) e isolamento entre organizações.
 *
 * O tick é chamado DIRETO (`t.mutation(internal.groupPostWorker.tick, …)`) em
 * vez de drenado pelo scheduler: a publicação se reagenda todo dia, então
 * `finishAllScheduledFunctions` não termina nunca. As funções agendadas com
 * `runAfter(0)` (webhook, e-mail, dispatch) ficam pendentes de propósito — o
 * que os testes conferem é o que a mutation escreveu no banco.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Quarta-feira, 16/09/2026, 09:00 em São Paulo. */
const NOW = Date.UTC(2026, 8, 16, 12, 0);
/** O slot das 12:00 locais desse mesmo dia. */
const SLOT_1 = Date.UTC(2026, 8, 16, 15, 0);

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const asUser = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function seed() {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Aos Filhos da Terra",
      slug: "aft",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });

    const mk = async (name: string, role: "admin" | "manager" | "agent") => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name,
        role,
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await mk("Admin", "admin"); // campaigns: full
    const manager = await mk("Gerente", "manager"); // campaigns: manage
    const agent = await mk("Vendedor", "agent"); // campaigns: view

    const channelConfigId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Número da loja",
      bridgeBaseUrl: "https://wuzapi.example.com",
      bridgeInstanceId: "inst_1",
      bridgeSessionState: "connected",
      bridgeGroupsEnabled: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const mkGroup = async (subject: string, jid: string) => {
      const conversationId = await ctx.db.insert("conversations", {
        organizationId,
        kind: "group",
        externalChatId: jid,
        channel: "whatsapp",
        channelConfigId,
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      const groupChatId = await ctx.db.insert("groupChats", {
        organizationId,
        channelConfigId,
        conversationId,
        jid,
        subject,
        monitored: true,
        monitoredSince: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(conversationId, { groupChatId });
      return { groupChatId, conversationId };
    };

    const g1 = await mkGroup("Turma da Terra", "120363111@g.us");
    const g2 = await mkGroup("Clube do Mel", "120363222@g.us");

    return { organizationId, admin, manager, agent, channelConfigId, g1, g2 };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** Agenda diária às 12:00 locais, encerrando depois de 3 dias. */
function dailySchedule(overrides: Record<string, unknown> = {}) {
  return {
    timezone: "America/Sao_Paulo",
    times: ["12:00"],
    days: [1, 2, 3, 4, 5, 6, 7],
    endAt: NOW + 3 * DAY,
    ...overrides,
  };
}

const libraryContent = (texts: string[], order: "sequential" | "random" = "sequential") => ({
  kind: "library" as const,
  library: { items: texts.map((text) => ({ text })), order },
});

async function createPost(
  s: Seed,
  opts: {
    content?: any;
    schedule?: any;
    groups?: Id<"groupChats">[];
    as?: Id<"users">;
    name?: string;
  } = {}
) {
  return await asUser(opts.as ?? s.admin.userId).mutation(api.groupPosts.create, {
    organizationId: s.organizationId,
    name: opts.name ?? "Mensagem do dia",
    groupChatIds: opts.groups ?? [s.g1.groupChatId, s.g2.groupChatId],
    schedule: (opts.schedule ?? dailySchedule()) as any,
    content: (opts.content ?? libraryContent(["Bom dia, {{grupo}}!"])) as any,
  });
}

async function activate(s: Seed, postId: Id<"groupPosts">) {
  await asUser(s.admin.userId).mutation(api.groupPosts.activate, { groupPostId: postId });
}

async function postDoc(postId: Id<"groupPosts">) {
  return (await t.run(async (ctx) => await ctx.db.get(postId)))!;
}

/** Roda o tick com o token vigente (o scheduler real levaria 1 dia). */
async function runTick(postId: Id<"groupPosts">) {
  const token = (await postDoc(postId)).tickToken;
  await t.mutation(internal.groupPostWorker.tick, {
    groupPostId: postId,
    tickToken: token ?? "sem-token",
  });
}

async function groupMessages(conversationId: Id<"conversations">) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect()
  );
}

async function notificationsOfType(type: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("notifications").collect()).filter((n) => n.type === type)
  );
}

/** LLM falso: devolve sempre o mesmo texto e captura o request. */
function stubLlm(reply: string) {
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 40 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Liga a IA da org + cria o atendente cuja persona a publicação reaproveita. */
async function enableAi(s: Seed, over: Record<string, unknown> = {}) {
  await t.run(async (ctx) => {
    const org = (await ctx.db.get(s.organizationId))!;
    await ctx.db.patch(s.organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 3,
          lgpdAck: { acceptedAt: Date.now(), acceptedBy: s.admin.memberId },
          groupAgentEnabled: true,
          ...over,
        },
      },
    });
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId: s.organizationId,
      userId,
      name: "Guardião",
      role: "agent",
      type: "ai",
      status: "active",
      agentProfile: {
        kind: "attendant",
        mode: "suggest",
        systemPrompt: "Você é o Guardião, sério e acolhedor.",
        knowledge: "Entregas às quartas.",
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

const aiContent = (over: Record<string, unknown> = {}) => ({
  kind: "ai" as const,
  ai: {
    prompt: "Anuncie a agenda da semana",
    useKnowledge: true,
    generateMinutesBefore: 60,
    requiresApproval: true,
    onMissedApproval: "skip" as const,
    ...over,
  },
});

// ─────────────────────────────────────────────────────────────────────────────

describe("criação e agendamento", () => {
  test("create nasce em draft, sem nextRunAt, e denormaliza o canal", async () => {
    const s = await seed();
    const postId = await createPost(s);
    const post = await postDoc(postId);
    expect(post.status).toBe("draft");
    expect(post.nextRunAt).toBeUndefined();
    expect(post.channelConfigId).toBe(s.channelConfigId);
    expect(post.targets).toHaveLength(2);
  });

  test("activate calcula o nextRunAt no fuso da agenda e agenda o tick", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    const post = await postDoc(postId);
    expect(post.status).toBe("active");
    expect(post.nextRunAt).toBe(SLOT_1);
    expect(post.tickToken).toBeTruthy();
    expect(post.schedulerFnId).toBeTruthy();
  });

  test("activate recusa agenda cujo endAt já passou", async () => {
    const s = await seed();
    const postId = await createPost(s, { schedule: dailySchedule({ endAt: NOW - DAY }) });
    await expect(activate(s, postId)).rejects.toThrow(/próximos 400 dias/i);
  });

  test("update de agenda em publicação ativa recalcula o próximo disparo", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await asUser(s.admin.userId).mutation(api.groupPosts.update, {
      groupPostId: postId,
      schedule: dailySchedule({ times: ["18:00"] }) as any,
    });
    const post = await postDoc(postId);
    // 18:00 em São Paulo = 21:00 UTC do mesmo dia.
    expect(post.nextRunAt).toBe(Date.UTC(2026, 8, 16, 21, 0));
  });

  test("editar publicação ativa PRESERVA o slot vencido que ainda não disparou", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);

    // Canal congelado: o tique das 12:00 se reagendou e o slot continua devendo.
    await t.run(async (ctx) => {
      await ctx.db.insert("channelPacing", {
        organizationId: s.organizationId,
        channelConfigId: s.channelConfigId,
        nextDispatchAt: 0,
        campaignFrozenUntil: SLOT_1 + 40 * 60 * 1000,
      });
    });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect((await postDoc(postId)).nextRunAt).toBe(SLOT_1);

    // Alguém renomeia a publicação às 12:10. Antes, isso empurrava o
    // `nextRunAt` para amanhã e o post de hoje sumia sem rastro nenhum.
    vi.setSystemTime(SLOT_1 + 10 * 60 * 1000);
    await asUser(s.admin.userId).mutation(api.groupPosts.update, {
      groupPostId: postId,
      name: "Mensagem do dia (v2)",
    });
    const post = await postDoc(postId);
    expect(post.nextRunAt).toBe(SLOT_1);
    expect(post.nextSlotKey).toBe("2026-09-16T12:00");
    expect(post.stats.skipped).toBe(0);
  });

  test("editar a AGENDA com slot vencido registra o horário perdido", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.insert("channelPacing", {
        organizationId: s.organizationId,
        channelConfigId: s.channelConfigId,
        nextDispatchAt: 0,
        campaignFrozenUntil: SLOT_1 + 40 * 60 * 1000,
      });
    });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);

    vi.setSystemTime(SLOT_1 + 10 * 60 * 1000);
    await asUser(s.admin.userId).mutation(api.groupPosts.update, {
      groupPostId: postId,
      schedule: dailySchedule({ times: ["18:00"] }) as any,
    });
    const post = await postDoc(postId);
    expect(post.nextRunAt).toBe(Date.UTC(2026, 8, 16, 21, 0));
    expect(post.stats.skipped).toBe(1);
    expect(
      post.timeline?.some((e) => e.kind === "skipped" && e.slotKey === "2026-09-16T12:00")
    ).toBe(true);
  });

  test("retomar publicação pausada é 'manage'; a PRIMEIRA ativação segue 'full'", async () => {
    const s = await seed();
    const postId = await createPost(s);
    // Manager (campaigns:manage, sem full) não consegue ativar do zero.
    await expect(
      asUser(s.manager.userId).mutation(api.groupPosts.activate, { groupPostId: postId })
    ).rejects.toThrow();

    await activate(s, postId);
    await asUser(s.manager.userId).mutation(api.groupPosts.pause, {
      groupPostId: postId,
      reason: "pausa de teste",
    });
    // …mas quem pausou consegue religar.
    await asUser(s.manager.userId).mutation(api.groupPosts.activate, { groupPostId: postId });
    expect((await postDoc(postId)).status).toBe("active");
  });

  test("recusa grupos de canais diferentes e grupo de outra org", async () => {
    const s = await seed();
    const other = await seed();
    await expect(
      createPost(s, { groups: [s.g1.groupChatId, other.g1.groupChatId] })
    ).rejects.toThrow(/não encontrado nesta organização/i);

    const foreignGroup = await t.run(async (ctx) => {
      const cfg = await ctx.db.insert("channelConfigs", {
        organizationId: s.organizationId,
        channel: "whatsapp",
        provider: "bridge",
        displayName: "Outro número",
        bridgeGroupsEnabled: true,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        kind: "group",
        channel: "whatsapp",
        channelConfigId: cfg,
        status: "active",
        messageCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return await ctx.db.insert("groupChats", {
        organizationId: s.organizationId,
        channelConfigId: cfg,
        conversationId,
        jid: "120363999@g.us",
        subject: "Outro canal",
        monitored: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(createPost(s, { groups: [s.g1.groupChatId, foreignGroup] })).rejects.toThrow(
      /mesmo número/i
    );
  });

  test("recusa grupo não monitorado", async () => {
    const s = await seed();
    await t.run(async (ctx) => {
      await ctx.db.patch(s.g2.groupChatId, { monitored: false });
    });
    await expect(createPost(s)).rejects.toThrow(/Acompanhe o grupo/i);
  });
});

describe("worker — biblioteca", () => {
  test("o tick publica uma mensagem por grupo e reagenda para o dia seguinte", async () => {
    const s = await seed();
    const postId = await createPost(s, { content: libraryContent(["Bom dia, {{grupo}}!"]) });
    await activate(s, postId);

    vi.setSystemTime(SLOT_1);
    await runTick(postId);

    const m1 = await groupMessages(s.g1.conversationId);
    const m2 = await groupMessages(s.g2.conversationId);
    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
    expect(m1[0].content).toBe("Bom dia, Turma da Terra!");
    expect(m2[0].content).toBe("Bom dia, Clube do Mel!");
    expect(m1[0].direction).toBe("outbound");
    expect(m1[0].leadId).toBeUndefined();
    expect(m1[0].metadata?.scheduled).toBe(true);
    expect(m1[0].metadata?.groupPost).toMatchObject({
      postId,
      slotKey: "2026-09-16T12:00",
      itemIndex: 0,
      generated: false,
    });

    const post = await postDoc(postId);
    expect(post.status).toBe("active");
    expect(post.stats.sent).toBe(1);
    expect(post.lastSlotKey).toBe("2026-09-16T12:00");
    expect(post.nextRunAt).toBe(SLOT_1 + DAY);
    const sentEntry = (post.timeline ?? []).find((e) => e.kind === "sent");
    expect(sentEntry?.sends).toHaveLength(2);
    expect(sentEntry?.sends?.[0].messageId).toBeTruthy();
  });

  test("a ordem sequencial anda no cursor entre os slots", async () => {
    const s = await seed();
    const postId = await createPost(s, { content: libraryContent(["um", "dois"]) });
    await activate(s, postId);

    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    vi.setSystemTime(SLOT_1 + DAY);
    await runTick(postId);

    const msgs = await groupMessages(s.g1.conversationId);
    expect(msgs.map((m) => m.content)).toEqual(["um", "dois"]);
    expect((await postDoc(postId)).content.library?.cursor).toBe(0); // voltou ao início
  });

  test("o mesmo slot não publica duas vezes (idempotência por lastSlotKey)", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);

    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    // Um tick zumbi do mesmo horário: força o par (nextRunAt, nextSlotKey) de
    // volta ao slot 1 — a chave viaja junto com o instante desde a correção do
    // jitter, e é ela que a idempotência compara.
    await t.run(async (ctx) => {
      await ctx.db.patch(postId, { nextRunAt: SLOT_1, nextSlotKey: "2026-09-16T12:00" });
    });
    await runTick(postId);

    expect(await groupMessages(s.g1.conversationId)).toHaveLength(1);
    expect((await postDoc(postId)).stats.sent).toBe(1);
  });

  test("tick com token velho é zumbi e não faz nada", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    vi.setSystemTime(SLOT_1);
    await t.mutation(internal.groupPostWorker.tick, {
      groupPostId: postId,
      tickToken: "token-de-outra-era",
    });
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
  });

  test("antes da hora o tick só reagenda", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    vi.setSystemTime(SLOT_1 - HOUR);
    await runTick(postId);
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
    expect((await postDoc(postId)).nextRunAt).toBe(SLOT_1);
  });

  test("slot atrasado mais de 1 h é pulado em vez de publicado fora de hora", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    vi.setSystemTime(SLOT_1 + 5 * HOUR);
    await runTick(postId);

    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
    const post = await postDoc(postId);
    expect(post.stats.skipped).toBe(1);
    expect(post.lastSlotKey).toBe("2026-09-16T12:00");
    expect(post.status).toBe("active");
  });

  test("a publicação encerra quando a agenda acaba", async () => {
    const s = await seed();
    const postId = await createPost(s, { schedule: dailySchedule({ endAt: SLOT_1 + HOUR }) });
    await activate(s, postId);
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    const post = await postDoc(postId);
    expect(post.status).toBe("ended");
    expect(post.nextRunAt).toBeUndefined();
  });
});

describe("worker — guardas do canal e tetos", () => {
  test("um 'piscar' da sessão adia o disparo em vez de pausar a publicação", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.channelConfigId, { bridgeSessionState: "disconnected" });
    });

    vi.setSystemTime(SLOT_1);
    await runTick(postId);

    let post = await postDoc(postId);
    expect(post.status).toBe("active");
    expect(post.channelRetries).toBe(1);
    expect(post.timeline?.some((e) => e.kind === "channel_retry")).toBe(true);
    expect(await notificationsOfType("group_post_failed")).toHaveLength(0);

    // Sessão voltou: publica no mesmo slot e zera o contador.
    await t.run(async (ctx) => {
      await ctx.db.patch(s.channelConfigId, { bridgeSessionState: "connected" });
    });
    vi.setSystemTime(SLOT_1 + 2 * 60 * 1000);
    await runTick(postId);
    post = await postDoc(postId);
    expect(post.status).toBe("active");
    expect(post.channelRetries).toBeUndefined();
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(1);
  });

  test("sessão desconectada insistente pausa a publicação e notifica", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.channelConfigId, { bridgeSessionState: "disconnected" });
    });

    // 3 tentativas com backoff e só então a pausa.
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    await runTick(postId);
    await runTick(postId);
    expect((await postDoc(postId)).status).toBe("active");
    await runTick(postId);

    const post = await postDoc(postId);
    expect(post.status).toBe("paused");
    expect(post.pausedReason).toMatch(/desconectada/i);
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
    const notes = await notificationsOfType("group_post_failed");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].groupPostId).toBe(postId);
  });

  test("sessão BANIDA pausa na hora, sem backoff", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.channelConfigId, { bridgeSessionState: "banned" });
    });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    const post = await postDoc(postId);
    expect(post.status).toBe("paused");
    expect(post.pausedReason).toMatch(/BANIDA/);
  });

  test("grupos desligados no número pausam a publicação", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.channelConfigId, { bridgeGroupsEnabled: false });
    });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect((await postDoc(postId)).pausedReason).toMatch(/grupos foram desligados/i);
  });

  test("canal congelado adia o disparo sem pausar", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.insert("channelPacing", {
        organizationId: s.organizationId,
        channelConfigId: s.channelConfigId,
        nextDispatchAt: 0,
        campaignFrozenUntil: SLOT_1 + 10 * 60 * 1000,
      });
    });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    const post = await postDoc(postId);
    expect(post.status).toBe("active");
    expect(post.lastSlotKey).toBeUndefined();
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
  });

  test("grupo perdido sai dos destinos; sem nenhum, a publicação pausa", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.g2.groupChatId, { leftAt: Date.now() });
    });

    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    let post = await postDoc(postId);
    // O destino é MARCADO, não apagado: um grupo desmarcado por engano volta
    // sozinho quando o operador conserta (só sai depois de 24 h assim).
    expect(post.targets).toHaveLength(2);
    expect(post.targets.find((t) => t.groupChatId === s.g2.groupChatId)?.missingSince).toBeTypeOf(
      "number"
    );
    expect(post.status).toBe("active");
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(1);
    expect(await groupMessages(s.g2.conversationId)).toHaveLength(0);

    await t.run(async (ctx) => {
      await ctx.db.patch(s.g1.groupChatId, { monitored: false });
    });
    vi.setSystemTime(SLOT_1 + DAY);
    await runTick(postId);
    post = await postDoc(postId);
    expect(post.status).toBe("paused");
    expect(post.pausedReason).toMatch(/Nenhum grupo válido/i);
  });

  test("grupo que volta a ser acompanhado dentro da tolerância volta a receber", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.g2.groupChatId, { monitored: false });
    });

    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect(await groupMessages(s.g2.conversationId)).toHaveLength(0);

    await t.run(async (ctx) => {
      await ctx.db.patch(s.g2.groupChatId, { monitored: true });
    });
    vi.setSystemTime(SLOT_1 + DAY);
    await runTick(postId);
    const post = await postDoc(postId);
    expect(post.targets).toHaveLength(2);
    expect(post.targets.every((t) => t.missingSince === undefined)).toBe(true);
    expect(await groupMessages(s.g2.conversationId)).toHaveLength(1);
  });

  test("destino ausente por mais de 24 h sai da publicação de vez", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.g2.groupChatId, { monitored: false });
    });

    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect((await postDoc(postId)).targets).toHaveLength(2);

    vi.setSystemTime(SLOT_1 + 2 * DAY);
    await runTick(postId);
    const post = await postDoc(postId);
    expect(post.targets).toHaveLength(1);
    expect(post.targets[0].groupChatId).toBe(s.g1.groupChatId);
  });

  test("teto diário por canal pula o slot sem pausar", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    await t.run(async (ctx) => {
      await ctx.db.insert("channelPacing", {
        organizationId: s.organizationId,
        channelConfigId: s.channelConfigId,
        nextDispatchAt: 0,
        groupPostDaily: { day: new Date(SLOT_1).toISOString().slice(0, 10), sent: 10 },
      });
    });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    const post = await postDoc(postId);
    expect(post.status).toBe("active");
    expect(post.stats.skipped).toBe(1);
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
  });

  test("um disparo conta 1 no teto do canal, mesmo em 2 grupos", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    const row = await t.run(async (ctx) => await ctx.db.query("channelPacing").first());
    expect(row?.groupPostDaily?.sent).toBe(1);
  });
});

describe("worker — conteúdo por IA", () => {
  test("generate grava o pendente e notifica quem aprova", async () => {
    const s = await seed();
    await enableAi(s);
    const fetchMock = stubLlm("Agenda desta semana: entregas na quarta. 🌱");
    const postId = await createPost(s, { content: aiContent() });
    await activate(s, postId);

    await t.action(internal.groupPostWorker.generate, {
      groupPostId: postId,
      slotKey: "2026-09-16T12:00",
      runAt: SLOT_1,
    });

    const post = await postDoc(postId);
    expect(post.pending).toMatchObject({
      slotKey: "2026-09-16T12:00",
      status: "pendingApproval",
      dueAt: SLOT_1,
    });
    expect(post.pending?.text).toBe("Agenda desta semana: entregas na quarta. 🌱");

    const notes = await notificationsOfType("group_post_pending");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].groupPostId).toBe(postId);

    // A persona e o conhecimento do atendente entraram no system prompt.
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.messages[0].content).toContain("Você é o Guardião");
    expect(body.messages[0].content).toContain("Entregas às quartas.");
    expect(body.messages[1].content).toContain("Anuncie a agenda da semana");
    // …e o carimbo de data/hora, no fuso da AGENDA da publicação.
    expect(body.messages[0].content).toContain("DATA E HORA ATUAIS");
    expect(body.messages[0].content).toContain("Próximos dias:");

    const run = await t.run(async (ctx) => await ctx.db.query("agentRuns").first());
    expect(run?.kind).toBe("group_post");
    expect(run?.status).toBe("done");
  });

  test("includeCurrentDateTime:false no perfil do atendente tira o carimbo", async () => {
    const s = await seed();
    await enableAi(s);
    // A publicação escreve com a persona do atendente, então segue a flag DELE.
    await t.run(async (ctx) => {
      const attendant = (await ctx.db.query("teamMembers").collect()).find(
        (m) => m.agentProfile?.kind === "attendant"
      )!;
      await ctx.db.patch(attendant._id, {
        agentProfile: { ...attendant.agentProfile!, includeCurrentDateTime: false },
      });
    });
    const fetchMock = stubLlm("Agenda desta semana.");
    const postId = await createPost(s, { content: aiContent() });
    await activate(s, postId);
    await t.action(internal.groupPostWorker.generate, {
      groupPostId: postId,
      slotKey: "2026-09-16T12:00",
      runAt: SLOT_1,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.messages[0].content).not.toContain("DATA E HORA ATUAIS");
    // Sem o carimbo, o "Hoje é …" do user volta a ser a única fonte de data.
    expect(body.messages[1].content).toContain("Hoje é");
  });

  test("texto aprovado é publicado no slot", async () => {
    const s = await seed();
    await enableAi(s);
    stubLlm("Agenda da semana!");
    const postId = await createPost(s, { content: aiContent() });
    await activate(s, postId);
    await t.action(internal.groupPostWorker.generate, {
      groupPostId: postId,
      slotKey: "2026-09-16T12:00",
      runAt: SLOT_1,
    });
    await asUser(s.manager.userId).mutation(api.groupPosts.approvePending, { groupPostId: postId });

    vi.setSystemTime(SLOT_1);
    await runTick(postId);

    const msgs = await groupMessages(s.g1.conversationId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Agenda da semana!");
    expect(msgs[0].metadata?.groupPost).toMatchObject({ generated: true });
    expect((await postDoc(postId)).pending).toBeUndefined();
  });

  test("aprovação com edição publica o texto corrigido", async () => {
    const s = await seed();
    await enableAi(s);
    stubLlm("Texto meia-boca");
    const postId = await createPost(s, { content: aiContent() });
    await activate(s, postId);
    await t.action(internal.groupPostWorker.generate, {
      groupPostId: postId,
      slotKey: "2026-09-16T12:00",
      runAt: SLOT_1,
    });
    await asUser(s.manager.userId).mutation(api.groupPosts.approvePending, {
      groupPostId: postId,
      editedText: "Texto revisado pela equipe",
    });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect((await groupMessages(s.g1.conversationId))[0].content).toBe("Texto revisado pela equipe");
  });

  test("sem aprovação a tempo, onMissedApproval skip pula o slot", async () => {
    const s = await seed();
    await enableAi(s);
    stubLlm("Nunca aprovado");
    const postId = await createPost(s, { content: aiContent({ onMissedApproval: "skip" }) });
    await activate(s, postId);
    await t.action(internal.groupPostWorker.generate, {
      groupPostId: postId,
      slotKey: "2026-09-16T12:00",
      runAt: SLOT_1,
    });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
    expect((await postDoc(postId)).stats.skipped).toBe(1);
  });

  test("sem aprovação a tempo, onMissedApproval send publica assim mesmo", async () => {
    const s = await seed();
    await enableAi(s);
    stubLlm("Vai assim mesmo");
    const postId = await createPost(s, { content: aiContent({ onMissedApproval: "send" }) });
    await activate(s, postId);
    await t.action(internal.groupPostWorker.generate, {
      groupPostId: postId,
      slotKey: "2026-09-16T12:00",
      runAt: SLOT_1,
    });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect((await groupMessages(s.g1.conversationId))[0].content).toBe("Vai assim mesmo");
  });

  test("texto rejeitado nunca vai ao ar", async () => {
    const s = await seed();
    await enableAi(s);
    stubLlm("Texto ruim");
    const postId = await createPost(s, { content: aiContent({ onMissedApproval: "send" }) });
    await activate(s, postId);
    await t.action(internal.groupPostWorker.generate, {
      groupPostId: postId,
      slotKey: "2026-09-16T12:00",
      runAt: SLOT_1,
    });
    await asUser(s.manager.userId).mutation(api.groupPosts.rejectPending, { groupPostId: postId });
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
    expect((await postDoc(postId)).stats.skipped).toBe(1);
  });

  test("falha do LLM registra, notifica e NÃO publica — sem pausar a publicação", async () => {
    const s = await seed();
    await enableAi(s);
    vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
    // 400 de propósito: 5xx é retentável e o backoff dorme num `setTimeout`
    // que os fake timers deste arquivo congelariam.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "modelo indisponível" } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    const postId = await createPost(s, { content: aiContent() });
    await activate(s, postId);
    await t.action(internal.groupPostWorker.generate, {
      groupPostId: postId,
      slotKey: "2026-09-16T12:00",
      runAt: SLOT_1,
    });

    let post = await postDoc(postId);
    expect(post.pending).toBeUndefined();
    expect(post.stats.lastError).toBeTruthy();
    expect(post.status).toBe("active");
    expect((await notificationsOfType("group_post_failed")).length).toBeGreaterThan(0);

    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
    post = await postDoc(postId);
    expect(post.stats.skipped).toBe(1);
    expect(post.status).toBe("active");
  });

  test("conteúdo por IA exige a IA da org ligada e o interruptor de grupos", async () => {
    const s = await seed();
    await expect(createPost(s, { content: aiContent() })).rejects.toThrow(/Ative a IA/i);
    await enableAi(s, { groupAgentEnabled: false });
    await expect(createPost(s, { content: aiContent() })).rejects.toThrow(/IA em grupos/i);
  });

  test('"sem aprovação" exige campaigns:full', async () => {
    const s = await seed();
    await enableAi(s);
    await expect(
      createPost(s, { content: aiContent({ requiresApproval: false }), as: s.manager.userId })
    ).rejects.toThrow(/permiss/i);
    // Admin consegue, e o texto gerado já nasce aprovado.
    stubLlm("Publica sozinho");
    const postId = await createPost(s, { content: aiContent({ requiresApproval: false }) });
    await activate(s, postId);
    await t.action(internal.groupPostWorker.generate, {
      groupPostId: postId,
      slotKey: "2026-09-16T12:00",
      runAt: SLOT_1,
    });
    expect((await postDoc(postId)).pending?.status).toBe("approved");
    expect(await notificationsOfType("group_post_pending")).toHaveLength(0);
  });
});

describe("enviar agora", () => {
  test("dryRun devolve a prévia por grupo e não escreve nada", async () => {
    const s = await seed();
    const postId = await createPost(s, { content: libraryContent(["Oi, {{grupo}}"]) });
    const result = await asUser(s.manager.userId).action(api.groupPosts.sendNow, {
      groupPostId: postId,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.previews.map((p: any) => p.text)).toEqual(["Oi, Turma da Terra", "Oi, Clube do Mel"]);
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);
    // A prévia não pode mexer no cursor da biblioteca.
    expect((await postDoc(postId)).content.library?.cursor).toBeUndefined();
  });

  test("dryRun com destino inválido NÃO apaga o destino da publicação", async () => {
    const s = await seed();
    const postId = await createPost(s, { content: libraryContent(["Oi, {{grupo}}"]) });
    // Alguém desmarcou "Acompanhar" no g2 — a prévia não pode transformar isso
    // numa remoção permanente (restaurar o grupo depois não o traria de volta).
    await t.run(async (ctx) => {
      await ctx.db.patch(s.g2.groupChatId, { monitored: false });
    });

    const result = await asUser(s.manager.userId).action(api.groupPosts.sendNow, {
      groupPostId: postId,
      dryRun: true,
    });
    expect(result.previews).toHaveLength(1);

    const post = await postDoc(postId);
    expect(post.targets).toHaveLength(2);
    expect(post.targets.every((tg) => tg.missingSince === undefined)).toBe(true);
    expect(post.timeline ?? []).toHaveLength(1); // só o "created"
  });

  test("envio real publica fora da agenda sem consumir o slot", async () => {
    const s = await seed();
    const postId = await createPost(s, { content: libraryContent(["Teste ao vivo"]) });
    await activate(s, postId);
    const result = await asUser(s.admin.userId).action(api.groupPosts.sendNow, {
      groupPostId: postId,
    });
    expect(result.delivered).toBe(2);
    expect((await groupMessages(s.g1.conversationId))[0].metadata?.groupPost).toMatchObject({
      manual: true,
    });
    const post = await postDoc(postId);
    expect(post.lastSlotKey).toBeUndefined();
    expect(post.nextRunAt).toBe(SLOT_1);
  });

  /**
   * Segurança 14. O `tick` sempre revalidou `config.organizationId ===
   * post.organizationId`; o "enviar agora" confiava no `channelConfigId`
   * gravado. Sem impacto conhecido hoje (o id é validado na criação), mas duas
   * portas para o mesmo gateway com guardas diferentes é o tipo de divergência
   * que um refactor futuro transforma em vazamento entre inquilinos.
   */
  test("envio real revalida a organização do canal, como o tique", async () => {
    const s = await seed();
    const other = await seed();
    const postId = await createPost(s, { content: libraryContent(["Oi, {{grupo}}"]) });
    await activate(s, postId);

    // Divergência artificial: o canal gravado no post passou a pertencer a
    // OUTRA organização. Os grupos continuam válidos (é o canal que divergiu),
    // então quem tem de barrar é a guarda de org, não a poda de destinos.
    await t.run(async (ctx) => {
      await ctx.db.patch(s.channelConfigId, { organizationId: other.organizationId });
    });

    await expect(
      t.mutation(internal.groupPostWorker.internalExecuteSendNow, {
        groupPostId: postId,
        dryRun: false,
      })
    ).rejects.toThrow(/indispon/i);
    expect(await groupMessages(s.g1.conversationId)).toHaveLength(0);

    // O tique recusa o mesmo documento (a guarda que já existia).
    vi.setSystemTime(SLOT_1);
    await runTick(postId);
    expect((await postDoc(postId)).status).toBe("paused");
  });

  test("envio real exige campaigns:full", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await expect(
      asUser(s.manager.userId).action(api.groupPosts.sendNow, { groupPostId: postId })
    ).rejects.toThrow(/permiss/i);
  });
});

describe("RBAC e ciclo de vida", () => {
  test("campaigns:view não cria; manage cria mas não ativa; full ativa", async () => {
    const s = await seed();
    await expect(createPost(s, { as: s.agent.userId })).rejects.toThrow(/permiss/i);

    const postId = await createPost(s, { as: s.manager.userId });
    await expect(
      asUser(s.manager.userId).mutation(api.groupPosts.activate, { groupPostId: postId })
    ).rejects.toThrow(/permiss/i);
    await activate(s, postId);
    expect((await postDoc(postId)).status).toBe("active");
  });

  test("manage pausa; full encerra; excluir só fora de ativa", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);

    await asUser(s.manager.userId).mutation(api.groupPosts.pause, { groupPostId: postId });
    let post = await postDoc(postId);
    expect(post.status).toBe("paused");
    expect(post.tickToken).toBeUndefined();

    await expect(
      asUser(s.admin.userId).mutation(api.groupPosts.remove, { groupPostId: postId })
    ).rejects.toThrow(/Encerre a publicação/i);

    await asUser(s.admin.userId).mutation(api.groupPosts.end, { groupPostId: postId });
    post = await postDoc(postId);
    expect(post.status).toBe("ended");

    await asUser(s.admin.userId).mutation(api.groupPosts.remove, { groupPostId: postId });
    expect(await t.run(async (ctx) => await ctx.db.get(postId))).toBeNull();
  });

  test("ativar grava audit de severidade alta", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "groupPost")
    );
    const activated = audits.find((a) => a.description?.includes("ativada"));
    expect(activated?.severity).toBe("high");
  });

  test("list e get respeitam campaigns:view e não vazam outra org", async () => {
    const s = await seed();
    const other = await seed();
    const postId = await createPost(s);
    await createPost(other);

    const mine = await asUser(s.agent.userId).query(api.groupPosts.list, {
      organizationId: s.organizationId,
    });
    expect(mine).toHaveLength(1);
    expect(mine[0]._id).toBe(postId);
    expect(mine[0].targetNames).toEqual(["Turma da Terra", "Clube do Mel"]);

    await expect(
      asUser(other.agent.userId).query(api.groupPosts.get, { groupPostId: postId })
    ).rejects.toThrow();
  });

  test("getHistory devolve os envios com o id da mensagem", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    vi.setSystemTime(SLOT_1);
    await runTick(postId);

    const history = await asUser(s.agent.userId).query(api.groupPosts.getHistory, {
      groupPostId: postId,
    });
    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe("sent");
    expect(history[0].sends).toHaveLength(2);
    expect(history[0].sends[0].subject).toBe("Turma da Terra");
    expect(history[0].sends[0].messageId).toBeTruthy();
  });
});

describe("watchdog", () => {
  test("reativa publicação ativa cujo agendamento se perdeu", async () => {
    const s = await seed();
    const postId = await createPost(s);
    await activate(s, postId);
    // Simula o agendamento perdido: nextRunAt no passado e sem job.
    await t.run(async (ctx) => {
      await ctx.db.patch(postId, { nextRunAt: NOW - HOUR, schedulerFnId: undefined });
    });
    const before = (await postDoc(postId)).tickToken;

    await t.mutation(internal.groupPostWorker.internalWatchdog, {});

    const post = await postDoc(postId);
    expect(post.tickToken).not.toBe(before);
    expect(post.schedulerFnId).toBeTruthy();
    expect((post.timeline ?? []).some((e) => e.kind === "watchdog")).toBe(true);
  });
});
