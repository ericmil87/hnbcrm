/**
 * Fase 4d (perf Convex I/O): `groupChats.participants`/`timeline` saem do doc
 * para `groupParticipants`/`groupTimeline`.
 *
 * Cobre o helper de armazenamento (upsert idempotente, diff do gateway, cap
 * 1.024, linha do tempo cap 100), a migração em 2 passos (backfill → finish →
 * restore) e os leitores que precisam devolver o MESMO resultado antes e
 * depois da migração.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  appendTimelineRows,
  findParticipant,
  participantsOf,
  syncParticipantsTable,
  timelineOf,
  upsertParticipant,
} from "./lib/groupParticipantsStore";
import { mergeParticipantWithFlag, mergeParticipantsFromGateway } from "./lib/groupChatCore";
import { resolveGroupMentions } from "./lib/groupGuard";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const GROUP_JID = "120363431849092219@g.us";
const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";
const ERIC_LID = "180002129735765@lid";
const ERIC_PHONE = "558181392929";
const ANA_LID = "111111111111111@lid";
const ANA_PHONE = "558199990000";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  return convexTest(schema, modules);
}

type Participant = NonNullable<Doc<"groupChats">["participants"]>[number];

/** Sala no formato LEGADO (arrays no doc), acompanhada e com conversa. */
async function seed(
  t: TestConvex<typeof schema>,
  opts: { participants?: Participant[]; timeline?: Doc<"groupChats">["timeline"] } = {}
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org 4d",
      slug: "org-4d",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "admin4d@test.hnbcrm.com" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Bridge",
      status: "active",
      bridgeGroupsEnabled: true,
      bridgeLid: OUR_LID,
      bridgePhone: OUR_PHONE,
      createdAt: now,
      updatedAt: now,
    } as Doc<"channelConfigs">);
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Eric",
      phone: ERIC_PHONE,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    const participants: Participant[] = opts.participants ?? [
      { lid: OUR_LID, phone: OUR_PHONE, isAdmin: false, isSuperAdmin: false },
      { lid: ERIC_LID, phone: ERIC_PHONE, name: "Eric", isAdmin: true, isSuperAdmin: true, contactId },
      { lid: ANA_LID, phone: ANA_PHONE, name: "Ana", isAdmin: false, isSuperAdmin: false },
    ];
    const groupChatId = await ctx.db.insert("groupChats", {
      organizationId,
      channelConfigId: configId,
      jid: GROUP_JID,
      subject: "Sala 4d",
      monitored: true,
      participants,
      participantsCount: participants.filter((p) => p.leftAt === undefined).length,
      timeline: opts.timeline ?? [
        { at: now - 2000, type: "discovered" },
        { at: now - 1000, type: "monitored_on", data: "Admin" },
      ],
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      kind: "group",
      externalChatId: GROUP_JID,
      groupChatId,
      channel: "whatsapp",
      channelConfigId: configId,
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(groupChatId, { conversationId });
    return { organizationId, userId, adminId, configId, contactId, groupChatId, conversationId };
  });
}

async function migrate(t: TestConvex<typeof schema>) {
  await t.mutation(internal.groupChats.internalBackfillGroupParticipants, { dryRun: false });
  return await t.mutation(internal.groupChats.internalFinishGroupParticipantsMigration, {
    dryRun: false,
  });
}

function stripSystem<T extends Record<string, unknown>>(doc: T) {
  const { _creationTime, updatedAt, ...rest } = doc as any;
  return rest;
}

describe("store — upsert, diff do gateway, tetos", () => {
  test("upsert é idempotente: a mesma mensagem do mesmo membro não regrava", async () => {
    const t = setup();
    const { groupChatId } = await seed(t);
    await migrate(t);
    const res = await t.run(async (ctx) => {
      const group = (await ctx.db.get(groupChatId))!;
      const incoming = { lid: ANA_LID, phone: ANA_PHONE, name: "Ana Paula" };
      const merge = (prev: Participant | null) => {
        const { list, changed } = mergeParticipantWithFlag(prev ? [prev] : [], incoming);
        return changed ? list[list.length - 1] : null;
      };
      const first = await upsertParticipant(ctx, group, incoming, merge, 1);
      const second = await upsertParticipant(ctx, group, incoming, merge, 2);
      const row = await ctx.db
        .query("groupParticipants")
        .withIndex("by_group_and_key", (q) => q.eq("groupChatId", groupChatId).eq("key", ANA_LID))
        .first();
      return { first, second, row };
    });
    expect(res.first.changed).toBe(true);
    expect(res.first.inserted).toBe(false);
    expect(res.second.changed).toBe(false);
    expect(res.row!.name).toBe("Ana Paula");
    expect(res.row!.updatedAt).toBe(1);
  });

  test("diff do gateway: novo entra, mudado atualiza, quem sumiu ganha leftAt", async () => {
    const t = setup();
    const { groupChatId } = await seed(t);
    await migrate(t);
    const rows = await t.run(async (ctx) => {
      const group = (await ctx.db.get(groupChatId))!;
      const current = await participantsOf(ctx, group);
      const merged = mergeParticipantsFromGateway(
        current,
        [
          { lid: OUR_LID, phone: OUR_PHONE, isAdmin: true, isSuperAdmin: false }, // mudou
          { lid: ERIC_LID, phone: ERIC_PHONE, isAdmin: true, isSuperAdmin: true },
          { lid: "222@lid", phone: "558188887777", isAdmin: false, isSuperAdmin: false }, // novo
        ],
        5000
      );
      const res = await syncParticipantsTable(ctx, group, merged, 5000);
      const list = await participantsOf(ctx, group);
      return { res, list };
    });
    expect(rows.res).toEqual({ inserted: 1, updated: 2, deleted: 0 });
    const byLid = new Map(rows.list.map((p) => [p.lid, p]));
    expect(byLid.get(OUR_LID)!.isAdmin).toBe(true);
    expect(byLid.get("222@lid")!.leftAt).toBeUndefined();
    expect(byLid.get(ANA_LID)!.leftAt).toBe(5000);
    // O nome aprendido pelo PushName sobrevive à sincronização.
    expect(byLid.get(ERIC_LID)!.name).toBe("Eric");
  });

  test("teto de 1.024 membros: o 1.025º não entra", async () => {
    const t = setup();
    const { groupChatId } = await seed(t, { participants: [] });
    await migrate(t);
    const out = await t.run(async (ctx) => {
      const group = (await ctx.db.get(groupChatId))!;
      const many: Participant[] = Array.from({ length: 1030 }, (_, i) => ({
        lid: `${1000 + i}@lid`,
        isAdmin: false,
        isSuperAdmin: false,
      }));
      await syncParticipantsTable(ctx, group, many, 1);
      const extra = await upsertParticipant(
        ctx,
        group,
        { lid: "9999@lid" },
        () => ({ lid: "9999@lid", isAdmin: false, isSuperAdmin: false }),
        2
      );
      const count = (
        await ctx.db
          .query("groupParticipants")
          .withIndex("by_group", (q) => q.eq("groupChatId", groupChatId))
          .collect()
      ).length;
      return { extra, count };
    });
    expect(out.count).toBe(1024);
    expect(out.extra.inserted).toBe(false);
  });

  test("linha do tempo fica em 100 eventos (FIFO por instante)", async () => {
    const t = setup();
    const { groupChatId } = await seed(t);
    await migrate(t);
    const timeline = await t.run(async (ctx) => {
      const group = (await ctx.db.get(groupChatId))!;
      const base = Date.now() + 10_000;
      for (let i = 0; i < 110; i++) {
        await appendTimelineRows(ctx, group, [{ at: base + i, type: "join", actorJid: `${i}@lid` }]);
      }
      return await timelineOf(ctx, group);
    });
    expect(timeline).toHaveLength(100);
    expect(timeline[0].type).toBe("join");
    expect(timeline[0].actorJid).toBe("10@lid");
    expect(timeline[99].actorJid).toBe("109@lid");
  });
});

describe("migração em 2 passos", () => {
  test("backfill dryRun não escreve; real copia e é idempotente", async () => {
    const t = setup();
    const { groupChatId } = await seed(t);

    const dry = await t.mutation(internal.groupChats.internalBackfillGroupParticipants, {});
    expect(dry.dryRun).toBe(true);
    expect(dry.participantsInserted).toBe(3);
    expect(dry.timelineInserted).toBe(2);
    const afterDry = await t.run(async (ctx) =>
      ctx.db
        .query("groupParticipants")
        .withIndex("by_group", (q) => q.eq("groupChatId", groupChatId))
        .collect()
    );
    expect(afterDry).toHaveLength(0);

    const real = await t.mutation(internal.groupChats.internalBackfillGroupParticipants, {
      dryRun: false,
    });
    expect(real.participantsInserted).toBe(3);
    expect(real.timelineInserted).toBe(2);
    const again = await t.mutation(internal.groupChats.internalBackfillGroupParticipants, {
      dryRun: false,
    });
    expect(again.participantsInserted).toBe(0);
    expect(again.participantsUpdated).toBe(0);
    expect(again.timelineInserted).toBe(0);
    expect(again.pending).toBe(0);

    // O array legado continua lá (o finish é quem apaga).
    const group = await t.run(async (ctx) => ctx.db.get(groupChatId));
    expect(group!.participants).toHaveLength(3);
    expect(group!.participantsMigratedAt).toBeUndefined();
  });

  test("finish encolhe o doc; recusa sala divergente; restore devolve os arrays", async () => {
    const t = setup();
    const { groupChatId } = await seed(t);

    // Sem backfill a tabela está vazia: divergente, recusada.
    const refused = await t.mutation(internal.groupChats.internalFinishGroupParticipantsMigration, {
      dryRun: false,
    });
    expect(refused.finished).toBe(0);
    expect(refused.divergent).toBe(1);
    expect(refused.divergentSample[0].missing).toBe(3);
    expect((await t.run(async (ctx) => ctx.db.get(groupChatId)))!.participantsMigratedAt).toBeUndefined();

    const before = await t.run(async (ctx) => {
      const group = (await ctx.db.get(groupChatId))!;
      return { participants: await participantsOf(ctx, group), timeline: await timelineOf(ctx, group) };
    });

    const finished = await migrate(t);
    expect(finished.finished).toBe(1);
    const migrated = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!;
    expect(migrated.participantsMigratedAt).toBeDefined();
    expect(migrated.participants).toBeUndefined();
    expect(migrated.timeline).toBeUndefined();
    expect(migrated.participantsCount).toBe(3);

    const after = await t.run(async (ctx) => {
      const group = (await ctx.db.get(groupChatId))!;
      return { participants: await participantsOf(ctx, group), timeline: await timelineOf(ctx, group) };
    });
    expect(after).toEqual(before);

    // Rodar de novo não faz nada.
    const twice = await t.mutation(internal.groupChats.internalFinishGroupParticipantsMigration, {
      dryRun: false,
    });
    expect(twice.alreadyMigrated).toBe(1);

    const restored = await t.mutation(internal.groupChats.internalRestoreGroupArraysFromTable, {
      dryRun: false,
    });
    expect(restored.restored).toBe(1);
    const back = (await t.run(async (ctx) => ctx.db.get(groupChatId)))!;
    expect(back.participantsMigratedAt).toBeUndefined();
    expect(back.participants).toEqual(before.participants);
    expect(back.timeline).toEqual(before.timeline);
  });

  test("finish recusa quando uma linha diverge do array (campo a campo)", async () => {
    const t = setup();
    const { groupChatId } = await seed(t);
    await t.mutation(internal.groupChats.internalBackfillGroupParticipants, { dryRun: false });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("groupParticipants")
        .withIndex("by_group_and_key", (q) => q.eq("groupChatId", groupChatId).eq("key", ANA_LID))
        .first();
      await ctx.db.patch(row!._id, { name: "Outra" });
    });
    const res = await t.mutation(internal.groupChats.internalFinishGroupParticipantsMigration, {
      dryRun: false,
    });
    expect(res.divergent).toBe(1);
    expect(res.divergentSample[0].changed).toBe(1);
  });

  test("sala NÃO acompanhada com membros no array legado: a tabela fica vazia (LGPD)", async () => {
    const t = setup();
    const { groupChatId } = await seed(t);
    await t.run(async (ctx) => ctx.db.patch(groupChatId, { monitored: false }));
    const res = await migrate(t);
    expect(res.finished).toBe(1);
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("groupParticipants")
        .withIndex("by_group", (q) => q.eq("groupChatId", groupChatId))
        .collect()
    );
    expect(rows).toHaveLength(0);
  });
});

describe("leitores — mesmo resultado antes e depois da migração", () => {
  test("getGroup devolve o mesmo shape (participants com isSelf, timeline)", async () => {
    const t = setup();
    const { groupChatId, userId } = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${userId}|s1` });
    const before = await asAdmin.query(api.groupChats.getGroup, { groupChatId });
    await migrate(t);
    const after = await asAdmin.query(api.groupChats.getGroup, { groupChatId });
    expect(stripSystem(after!)).toEqual(stripSystem(before!));
    expect(after!.participants.filter((p: { isSelf: boolean }) => p.isSelf)).toHaveLength(1);
    expect(after!.timeline).toHaveLength(2);
    expect((after as any).participantsMigratedAt).toBeUndefined();
  });

  test("listGroupsForContact acha a sala pelo contactId do membro", async () => {
    const t = setup();
    const { groupChatId, userId, organizationId, contactId } = await seed(t);
    const asAdmin = t.withIdentity({ subject: `${userId}|s1` });
    const before = await asAdmin.query(api.groupChats.listGroupsForContact, {
      organizationId,
      contactId,
    });
    await migrate(t);
    const after = await asAdmin.query(api.groupChats.listGroupsForContact, {
      organizationId,
      contactId,
    });
    expect(before).toHaveLength(1);
    expect(after).toEqual(before);
    expect(after[0]._id).toEqual(groupChatId);
    expect(after[0].isAdmin).toBe(true);
  });

  test("menção outbound só sai para quem está na sala (resolveGroupMentions)", async () => {
    const t = setup();
    const { conversationId } = await seed(t);
    const mentions = [ERIC_LID, `${ANA_PHONE}@s.whatsapp.net`, "999@lid"];
    const resolve = () =>
      t.run(async (ctx) => {
        const conversation = (await ctx.db.get(conversationId))!;
        return await resolveGroupMentions(ctx, conversation, mentions);
      });
    const before = await resolve();
    await migrate(t);
    const after = await resolve();
    expect(before).toEqual([ERIC_LID, `${ANA_PHONE}@s.whatsapp.net`]);
    expect(after).toEqual(before);
  });

  test("lookup por chave (admin do revoke) casa por LID ou telefone", async () => {
    const t = setup();
    const { groupChatId } = await seed(t);
    await migrate(t);
    const out = await t.run(async (ctx) => {
      const group = (await ctx.db.get(groupChatId))!;
      return {
        byLid: await findParticipant(ctx, group, { lid: ERIC_LID }),
        byPhone: await findParticipant(ctx, group, { phone: ERIC_PHONE }),
        none: await findParticipant(ctx, group, { lid: "nao@lid" }),
      };
    });
    expect(out.byLid!.isSuperAdmin).toBe(true);
    expect(out.byPhone!.lid).toBe(ERIC_LID);
    expect(out.none).toBeNull();
  });

  test("ingest de membro NOVO cria a linha; mensagem repetida não regrava a sala", async () => {
    const t = setup();
    const { groupChatId, organizationId, configId } = await seed(t);
    await migrate(t);
    const receive = (externalId: string, name: string) =>
      t.mutation(internal.conversations.internalReceiveGroupMessage, {
        organizationId,
        groupChatId,
        channelConfigId: configId,
        externalId,
        content: "oi",
        senderLid: "333@lid",
        senderPhone: "558177776666",
        senderName: name,
      });

    await receive("m1", "Novo Membro");
    const first = await t.run(async (ctx) => ({
      group: (await ctx.db.get(groupChatId))!,
      row: await ctx.db
        .query("groupParticipants")
        .withIndex("by_group_and_key", (q) => q.eq("groupChatId", groupChatId).eq("key", "333@lid"))
        .first(),
    }));
    expect(first.row!.name).toBe("Novo Membro");
    expect(first.group.participantsCount).toBe(4);
    expect(first.group.participants).toBeUndefined();

    // Mesma pessoa, mesmo nome, dentro do mesmo minuto: nem a linha nem a sala
    // são regravadas.
    await receive("m2", "Novo Membro");
    const second = await t.run(async (ctx) => ({
      group: (await ctx.db.get(groupChatId))!,
      row: await ctx.db
        .query("groupParticipants")
        .withIndex("by_group_and_key", (q) => q.eq("groupChatId", groupChatId).eq("key", "333@lid"))
        .first(),
    }));
    expect(second.group.updatedAt).toBe(first.group.updatedAt);
    expect(second.row!.updatedAt).toBe(first.row!.updatedAt);
  });

  test("sala não migrada: ingest grava nos DOIS lugares (dual-write)", async () => {
    const t = setup();
    const { groupChatId, organizationId, configId } = await seed(t);
    await t.mutation(internal.conversations.internalReceiveGroupMessage, {
      organizationId,
      groupChatId,
      channelConfigId: configId,
      externalId: "m1",
      content: "oi",
      senderLid: "333@lid",
      senderName: "Novo",
    });
    const out = await t.run(async (ctx) => ({
      group: (await ctx.db.get(groupChatId))!,
      row: await ctx.db
        .query("groupParticipants")
        .withIndex("by_group_and_key", (q) => q.eq("groupChatId", groupChatId).eq("key", "333@lid"))
        .first(),
    }));
    expect(out.group.participants!.some((p) => p.lid === "333@lid")).toBe(true);
    expect(out.row!.name).toBe("Novo");
  });

  test("parar de acompanhar apaga as linhas (LGPD) e a cascata do canal limpa tudo", async () => {
    const t = setup();
    const { groupChatId, userId, configId } = await seed(t);
    await migrate(t);
    const asAdmin = t.withIdentity({ subject: `${userId}|s1` });
    await asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: false });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("groupParticipants")
        .withIndex("by_group", (q) => q.eq("groupChatId", groupChatId))
        .collect()
    );
    expect(rows).toHaveLength(0);
    const timeline = await t.run(async (ctx) =>
      timelineOf(ctx, (await ctx.db.get(groupChatId))!)
    );
    expect(timeline.at(-1)!.type).toBe("monitored_off");

    await t.mutation(internal.groupChats.internalCascadeDeleteChannelGroups, {
      channelConfigId: configId as Id<"channelConfigs">,
    });
    const left = await t.run(async (ctx) => ({
      group: await ctx.db.get(groupChatId),
      timeline: await ctx.db
        .query("groupTimeline")
        .withIndex("by_group_and_at", (q) => q.eq("groupChatId", groupChatId))
        .collect(),
    }));
    expect(left.group).toBeNull();
    expect(left.timeline).toHaveLength(0);
  });
});
