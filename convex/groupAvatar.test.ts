/// <reference types="vite/client" />
/**
 * Foto de perfil do GRUPO (bridge): gatilhos (ingest sem escrita no caso comum), elegibilidade,
 * aplicação (`conversations.groupAvatarUrl` só em troca real), evento Picture e exclusão.
 * Gateway simulado; bytes da imagem montados em código (sem base64, por causa do `secretScan`).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const PICTURE_URL = "https://pps.whatsapp.net/v/t61/group.jpg?oe=6A0F1234";
const JID = "120363000000000001@g.us";

function jpegBytes(size = 120, fill = 7): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

type Gateway = { status?: number; body?: unknown; image?: Uint8Array };
function stubGateway(gateway: Gateway) {
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/user/avatar")) {
      return new Response(JSON.stringify(gateway.body ?? {}), { status: gateway.status ?? 200 });
    }
    if (url.startsWith("https://pps.whatsapp.net/")) {
      return new Response((gateway.image ?? jpegBytes()) as BodyInit, { status: 200 });
    }
    return new Response("ok", { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
const okBody = (id = "g1") => ({ code: 200, success: true, data: { url: PICTURE_URL, id, type: "preview" } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type T = TestConvex<typeof schema>;

async function seed(t: T, opts: { monitored?: boolean; archived?: boolean; left?: boolean } = {}) {
  const tokenEncrypted = await encryptSecret("fake-instance-token");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org", slug: "org", settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now, updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "admin@teste.com" });
    await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active",
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge", displayName: "Loja",
      bridgeBaseUrl: "https://wa-gw.example.test", bridgeInstanceId: "inst_a",
      bridgeTokenEncrypted: tokenEncrypted, bridgeTokenLast4: "aaaa",
      bridgeSessionState: "connected", status: "active", createdAt: now, updatedAt: now,
    });
    const groupChatId = await ctx.db.insert("groupChats", {
      organizationId, channelConfigId: configId, jid: JID, subject: "Turma",
      monitored: opts.monitored ?? true, ...(opts.left ? { leftAt: now } : {}),
      createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, kind: "group", externalChatId: JID, groupChatId, channel: "whatsapp",
      channelConfigId: configId, groupSubject: "Turma", groupParticipantsCount: 3,
      status: "active", messageCount: 0, unreadCount: 1, createdAt: now, updatedAt: now,
      ...(opts.archived ? { archivedAt: now } : {}),
    });
    await ctx.db.patch(groupChatId, { conversationId });
    return { organizationId, userId, configId, groupChatId, conversationId } as unknown as {
      organizationId: Id<"organizations">; userId: Id<"users">; configId: Id<"channelConfigs">;
      groupChatId: Id<"groupChats">; conversationId: Id<"conversations">;
    };
  });
}

let ext = 0;
async function receive(t: T, s: Awaited<ReturnType<typeof seed>>) {
  ext += 1;
  return await t.mutation(internal.conversations.internalReceiveGroupMessage, {
    organizationId: s.organizationId, groupChatId: s.groupChatId, channelConfigId: s.configId,
    externalId: `3EB0G${ext}`, content: "Oi", senderPhone: "5511999990001",
  });
}

async function pendingNames(t: T, part: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (j) => j.name.includes(part) && j.state.kind === "pending"
    )
  );
}

/** Roda os `internalMaybeScheduleGroup` pendentes (o gatilho só os agenda). */
async function runScheduling(t: T): Promise<string[]> {
  const jobs = await t.run(async (ctx) => {
    const mine = (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (j) => j.name.includes("internalMaybeScheduleGroup") && j.state.kind === "pending"
    );
    for (const job of mine) await ctx.scheduler.cancel(job._id);
    return mine.map((j) => j.args[0] as { organizationId: Id<"organizations">; groupChatId: Id<"groupChats"> });
  });
  const out: string[] = [];
  for (const args of jobs) out.push(await t.mutation(internal.groupAvatar.internalMaybeScheduleGroup, args));
  return out;
}

async function cancelPending(t: T) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

const rowOf = (t: T, groupChatId: Id<"groupChats">) =>
  t.run(async (ctx) => ctx.db.query("groupAvatars").withIndex("by_group_chat", (q) => q.eq("groupChatId", groupChatId)).first());
const fetchArgs = (s: Awaited<ReturnType<typeof seed>>) => ({
  organizationId: s.organizationId, groupChatId: s.groupChatId, channelConfigId: s.configId,
});
async function fetchPhoto(t: T, s: Awaited<ReturnType<typeof seed>>, gw: Gateway) {
  await receive(t, s);
  await runScheduling(t);
  const mock = stubGateway(gw);
  await t.action(internal.groupAvatar.internalFetchGroupAvatar, fetchArgs(s));
  return mock;
}

describe("gatilhos", () => {
  test("ingest agenda UMA busca; depois do carimbo, mensagem de grupo não lê nem escreve nada de foto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s);
    expect(await pendingNames(t, "internalMaybeScheduleGroup")).toHaveLength(1);
    expect(await runScheduling(t)).toEqual(["scheduled"]);
    expect(await pendingNames(t, "internalFetchGroupAvatar")).toHaveLength(1);
    const before = await t.run(async (ctx) => ({
      group: await ctx.db.get(s.groupChatId),
      row: await ctx.db.query("groupAvatars").first(),
      pacing: await ctx.db.query("channelAvatarPacing").collect(),
    }));
    expect(before.group?.avatarNextCheckAt).toBeGreaterThan(Date.now());
    await receive(t, s);
    await receive(t, s);
    expect(await pendingNames(t, "internalMaybeScheduleGroup")).toHaveLength(0);
    const after = await t.run(async (ctx) => ({
      group: await ctx.db.get(s.groupChatId),
      row: await ctx.db.query("groupAvatars").first(),
      pacing: await ctx.db.query("channelAvatarPacing").collect(),
    }));
    expect(after).toEqual(before);
    await cancelPending(t);
  });

  test("arquivada, não acompanhada, saída do grupo e kill switch não agendam", async () => {
    for (const opts of [{ archived: true }, { monitored: false }, { left: true }]) {
      const t = convexTest(schema, modules);
      const s = await seed(t, opts);
      await receive(t, s);
      expect(await pendingNames(t, "internalMaybeScheduleGroup")).toHaveLength(0);
    }
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.stubEnv("CONTACT_AVATAR_FETCH", "0");
    await receive(t, s);
    expect(await pendingNames(t, "internalMaybeScheduleGroup")).toHaveLength(0);
  });

  test("a mutation de agendamento revalida: grupo arquivado depois do gatilho não reserva canal", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s);
    await t.run(async (ctx) => ctx.db.patch(s.conversationId, { archivedAt: Date.now() }));
    expect(await runScheduling(t)).toEqual(["ineligible"]);
    expect(await t.run(async (ctx) => (await ctx.db.query("channelAvatarPacing").collect()).length)).toBe(0);
  });

  test("abrir a conversa de grupo com não lidas agenda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${s.userId}|s1` });
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId: s.conversationId });
    expect(await runScheduling(t)).toEqual(["scheduled"]);
    await cancelPending(t);
  });

  test("teto de fila: canal ocupado carimba 15 min e não reagenda a cada mensagem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("channelAvatarPacing", {
        organizationId: s.organizationId, channelConfigId: s.configId, nextFetchAt: Date.now() + 3_600_000,
      });
    });
    await receive(t, s);
    expect(await runScheduling(t)).toEqual(["throttled"]);
    await receive(t, s);
    expect(await pendingNames(t, "internalMaybeScheduleGroup")).toHaveLength(0);
  });
});

describe("aplicar o resultado", () => {
  test("foto nova grava arquivo, linha lateral, conversa e pictureUrl; a chamada leva o JID do grupo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const mock = await fetchPhoto(t, s, { body: okBody("g1") });
    const state = await t.run(async (ctx) => {
      const row = (await ctx.db.query("groupAvatars").first())!;
      return {
        row,
        conversation: (await ctx.db.get(s.conversationId))!,
        group: (await ctx.db.get(s.groupChatId))!,
        file: row.fileId ? await ctx.db.get(row.fileId) : null,
      };
    });
    expect(state.row).toMatchObject({ status: "ok", pictureId: "g1" });
    expect(state.row.url).not.toContain("whatsapp.net");
    expect(state.conversation.groupAvatarUrl).toBe(state.row.url);
    expect(state.group.pictureUrl).toBe(state.row.url);
    expect(state.group.avatarNextCheckAt).toBe(state.row.nextCheckAt);
    expect(state.file).toMatchObject({ fileType: "other", createdAt: 0, metadata: { kind: "contact_avatar" } });
    const call = mock.mock.calls.find((c) => String(c[0]).endsWith("/user/avatar"))!;
    expect(JSON.parse(((call as unknown[])[1] as RequestInit).body as string)).toEqual({ Phone: JID, Preview: true });
    await cancelPending(t);
  });

  test("mesma pictureId não escreve a conversa; foto trocada escreve uma vez e apaga a anterior", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await fetchPhoto(t, s, { body: okBody("g1") });
    const first = (await rowOf(t, s.groupChatId))!;
    const convBefore = await t.run(async (ctx) => await ctx.db.get(s.conversationId));
    // Reconferência com a mesma foto: só carimba a linha.
    await t.run(async (ctx) => ctx.db.patch(first._id, { pendingSince: Date.now(), nextCheckAt: 0 }));
    stubGateway({ body: okBody("g1") });
    await t.action(internal.groupAvatar.internalFetchGroupAvatar, fetchArgs(s));
    expect(await t.run(async (ctx) => await ctx.db.get(s.conversationId))).toEqual(convBefore);
    // Troca de verdade.
    await t.run(async (ctx) => ctx.db.patch(first._id, { pendingSince: Date.now(), nextCheckAt: 0 }));
    stubGateway({ body: okBody("g2"), image: jpegBytes(200, 9) });
    await t.action(internal.groupAvatar.internalFetchGroupAvatar, fetchArgs(s));
    const row = (await rowOf(t, s.groupChatId))!;
    const state = await t.run(async (ctx) => ({
      conversation: await ctx.db.get(s.conversationId),
      oldFile: await ctx.db.get(first.fileId!),
      files: (await ctx.db.query("files").collect()).length,
    }));
    expect(row.pictureId).toBe("g2");
    expect(row.url).not.toBe(first.url);
    expect(state.conversation?.groupAvatarUrl).toBe(row.url);
    expect(state.oldFile).toBeNull();
    expect(state.files).toBe(1);
    await cancelPending(t);
  });

  test("getConversationById devolve groupAvatarUrl sem leitura nova (campo da própria conversa)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await fetchPhoto(t, s, { body: okBody("g1") });
    const row = (await rowOf(t, s.groupChatId))!;
    const asAdmin = t.withIdentity({ subject: `${s.userId}|s1` });
    const one = await asAdmin.query(api.conversations.getConversationById, { conversationId: s.conversationId });
    expect(one?.groupAvatarUrl).toBe(row.url);
    const list = await asAdmin.query(api.conversations.getConversations, { organizationId: s.organizationId });
    const rows = list as unknown as Array<{ _id: string; groupAvatarUrl?: string } | null>;
    expect(rows.find((c) => c?._id === s.conversationId)?.groupAvatarUrl).toBe(row.url);
    await cancelPending(t);
  });

  test("erro do gateway (ex.: 401 de comunidade) vira error com recuo e não escreve a conversa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await fetchPhoto(t, s, { status: 401, body: { code: 401, success: false, error: "unauthorized" } });
    const row = (await rowOf(t, s.groupChatId))!;
    expect(row).toMatchObject({ status: "error", failures: 1 });
    expect(row.nextCheckAt).toBeGreaterThan(Date.now());
    const group = await t.run(async (ctx) => await ctx.db.get(s.groupChatId));
    expect(group?.avatarNextCheckAt).toBe(row.nextCheckAt);
    expect((await t.run(async (ctx) => await ctx.db.get(s.conversationId)))?.groupAvatarUrl).toBeUndefined();
    await cancelPending(t);
  });

  test("sem foto e oculta tiram a guardada, a da conversa e o pictureUrl (30 dias)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await fetchPhoto(t, s, { body: okBody("g1") });
    const row = (await rowOf(t, s.groupChatId))!;
    await t.run(async (ctx) => ctx.db.patch(row._id, { pendingSince: Date.now(), nextCheckAt: 0 }));
    stubGateway({ status: 500, body: { code: 500, success: false, error: "user has not set a profile picture: does not have a profile picture" } });
    await t.action(internal.groupAvatar.internalFetchGroupAvatar, fetchArgs(s));
    const state = await t.run(async (ctx) => ({
      row: await ctx.db.query("groupAvatars").first(),
      conversation: await ctx.db.get(s.conversationId),
      group: await ctx.db.get(s.groupChatId),
      files: (await ctx.db.query("files").collect()).length,
    }));
    expect(state.row).toMatchObject({ status: "none" });
    expect(state.row?.url).toBeUndefined();
    expect(state.conversation?.groupAvatarUrl).toBeUndefined();
    expect(state.group?.pictureUrl).toBeUndefined();
    expect(state.files).toBe(0);
    await cancelPending(t);
  });
});

describe("evento Picture de grupo", () => {
  test("troca só marca vencida (carimbo e linha em 0), sem buscar; remoção apaga já", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await fetchPhoto(t, s, { body: okBody("g1") });
    await cancelPending(t);
    const result = await t.mutation(internal.groupAvatar.internalApplyGroupPictureEvent, {
      channelConfigId: s.configId, groupJid: JID, remove: false,
    });
    expect(result).toBe("expired");
    expect((await rowOf(t, s.groupChatId))?.nextCheckAt).toBe(0);
    expect((await t.run(async (ctx) => await ctx.db.get(s.groupChatId)))?.avatarNextCheckAt).toBe(0);
    expect(await pendingNames(t, "internalFetchGroupAvatar")).toHaveLength(0);
    // O próximo gatilho (mensagem) reagenda.
    await receive(t, s);
    expect(await runScheduling(t)).toEqual(["scheduled"]);
    await cancelPending(t);

    const removed = await t.mutation(internal.groupAvatar.internalApplyGroupPictureEvent, {
      channelConfigId: s.configId, groupJid: JID, remove: true,
    });
    expect(removed).toBe("removed");
    const conv = await t.run(async (ctx) => await ctx.db.get(s.conversationId));
    expect(conv?.groupAvatarUrl).toBeUndefined();
    expect((await rowOf(t, s.groupChatId))?.status).toBe("none");
  });

  test("grupo desconhecido, não acompanhado ou de outro canal: ignora sem escrever", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { monitored: false });
    expect(
      await t.mutation(internal.groupAvatar.internalApplyGroupPictureEvent, { channelConfigId: s.configId, groupJid: JID, remove: false })
    ).toBe("ignored");
    expect(
      await t.mutation(internal.groupAvatar.internalApplyGroupPictureEvent, { channelConfigId: s.configId, groupJid: "999@g.us", remove: true })
    ).toBe("ignored");
    expect(await t.run(async (ctx) => (await ctx.db.query("groupAvatars").collect()).length)).toBe(0);
  });

  test("o parser entrega group_picture para @g.us", async () => {
    const { parseBridgeEvent } = await import("./lib/bridgeParse");
    expect(parseBridgeEvent({ type: "Picture", event: { JID: JID, Remove: true } })).toMatchObject({
      kind: "group_picture",
      picture: { groupJid: JID, remove: true },
    });
  });
});

describe("exclusão", () => {
  test("a cascata do canal apaga linha lateral, arquivo e blob do grupo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await fetchPhoto(t, s, { body: okBody("g1") });
    await cancelPending(t);
    await t.mutation(internal.groupChats.internalCascadeDeleteChannelGroups, { channelConfigId: s.configId });
    const state = await t.run(async (ctx) => ({
      rows: (await ctx.db.query("groupAvatars").collect()).length,
      files: (await ctx.db.query("files").collect()).length,
      groups: (await ctx.db.query("groupChats").collect()).length,
    }));
    expect(state).toEqual({ rows: 0, files: 0, groups: 0 });
  });
});

describe("proteção do canal (foto de contato 1 a 1)", () => {
  const pacingOf = (t: T, s: Awaited<ReturnType<typeof seed>>) =>
    t.run(async (ctx) =>
      ctx.db.query("channelAvatarPacing").withIndex("by_channel_config", (q) => q.eq("channelConfigId", s.configId)).first()
    );

  test("erro de grupo não soma no disjuntor do canal nem o pausa; 429 continua pausando", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("channelAvatarPacing", {
        organizationId: s.organizationId, channelConfigId: s.configId, nextFetchAt: 0, errorStreak: 4,
      });
    });
    await fetchPhoto(t, s, { status: 500, body: { code: 500, success: false, error: "boom" } });
    expect(await pacingOf(t, s)).toMatchObject({ errorStreak: 4 });
    expect((await pacingOf(t, s))!.pausedUntil).toBeUndefined();
    expect((await rowOf(t, s.groupChatId))!).toMatchObject({ status: "error", failures: 1 });
    await cancelPending(t);

    await t.mutation(internal.groupAvatar.internalRecordGroupAvatarCheck, { ...fetchArgs(s), outcome: "rate_limited" });
    expect((await pacingOf(t, s))!.pausedUntil).toBeGreaterThan(Date.now());
  });

  test("sucesso de grupo não zera o errorStreak de contato", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("channelAvatarPacing", {
        organizationId: s.organizationId, channelConfigId: s.configId, nextFetchAt: 0, errorStreak: 3,
      });
    });
    await fetchPhoto(t, s, { body: okBody() });
    expect((await rowOf(t, s.groupChatId))!.status).toBe("ok");
    expect((await pacingOf(t, s))!.errorStreak).toBe(3);
    await cancelPending(t);
  });

  test("busca de grupo para com 100 no dia; contato ainda tem o resto do teto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("channelAvatarPacing", {
        organizationId: s.organizationId, channelConfigId: s.configId, nextFetchAt: 0,
        day: new Date(Date.now()).toISOString().slice(0, 10), dayCount: 100,
      });
    });
    await receive(t, s);
    expect(await runScheduling(t)).toEqual(["throttled"]);
    expect((await pacingOf(t, s))!.dayCount).toBe(100);
    await cancelPending(t);
  });
});

describe("sync de grupos", () => {
  test("agenda foto de no máximo 5 grupos por execução", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const jids: string[] = [];
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 8; i++) {
        const jid = `1203630000000001${i}0@g.us`;
        jids.push(jid);
        const groupChatId = await ctx.db.insert("groupChats", {
          organizationId: s.organizationId, channelConfigId: s.configId, jid, subject: `G${i}`,
          monitored: true, createdAt: now, updatedAt: now,
        });
        const conversationId = await ctx.db.insert("conversations", {
          organizationId: s.organizationId, kind: "group", externalChatId: jid, groupChatId, channel: "whatsapp",
          channelConfigId: s.configId, status: "active", messageCount: 0, createdAt: now, updatedAt: now,
        });
        await ctx.db.patch(groupChatId, { conversationId });
      }
    });
    await t.mutation(internal.groupChats.internalUpsertGroupsFromSync, {
      channelConfigId: s.configId,
      full: false,
      groups: jids.map((jid, i) => ({
        jid, subject: `G${i}`, isAnnounce: false, isLocked: false, isEphemeral: false, isCommunityParent: false,
        participants: [], participantsCount: 0,
      })),
    });
    expect(await pendingNames(t, "internalMaybeScheduleGroup")).toHaveLength(5);
    await cancelPending(t);
  });
});
