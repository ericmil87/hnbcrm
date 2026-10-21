/// <reference types="vite/client" />
/**
 * Crons com leitura por índice (perf Convex I/O, fase 1).
 *
 *  - `groupAgent.internalListDigestDue`: só salas acompanhadas COM horário de
 *    digest saem do índice; os demais filtros (org, IA, hora, idempotência)
 *    continuam valendo.
 *  - `email.sendDailyDigest`: contagens por range (leads das últimas 24 h,
 *    tarefas concluídas nas últimas 24 h, atrasadas com prazo) com o MESMO
 *    resultado de antes. O componente Resend não é registrado nos testes, então
 *    o envio é verificado pelo `dispatchNotification` agendado.
 *  - `cronsDisabled()`: com `CRONS_DISABLED=1` o handler sai sem efeito.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const DAY_MS = 24 * 60 * 60 * 1000;
// 21/10/2026 15:00 UTC = 12:00 em São Paulo.
const NOW = Date.UTC(2026, 9, 21, 15, 0, 0);

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seedOrg(opts: { aiOn?: boolean; groupAgent?: boolean; slug: string }) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${opts.slug}`,
      slug: opts.slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const userId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      email: `admin@${opts.slug}.com.br`,
      role: "admin",
      type: "human",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    if (opts.aiOn) {
      await ctx.db.patch(organizationId, {
        settings: {
          timezone: "America/Sao_Paulo",
          currency: "BRL",
          aiConfig: {
            enabled: true,
            autoAssign: false,
            handoffThreshold: 0.8,
            lgpdAck: { acceptedAt: NOW, acceptedBy: adminId },
            ...(opts.groupAgent !== false ? { groupAgentEnabled: true } : {}),
          },
        },
      });
    }
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Número bridge",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    return { organizationId, adminId, configId };
  });
}

async function seedGroup(
  seed: Awaited<ReturnType<typeof seedOrg>>,
  opts: { jid: string; monitored: boolean; dailyDigestAt?: string; lastDigestAt?: number }
) {
  return await t.run(async (ctx) => {
    const groupChatId = await ctx.db.insert("groupChats", {
      organizationId: seed.organizationId,
      channelConfigId: seed.configId,
      jid: opts.jid,
      subject: `Sala ${opts.jid}`,
      monitored: opts.monitored,
      participantsCount: 0,
      participants: [],
      ai: {
        mode: "mention",
        replyMode: "inherit",
        ...(opts.dailyDigestAt !== undefined ? { dailyDigestAt: opts.dailyDigestAt } : {}),
        ...(opts.lastDigestAt !== undefined ? { lastDigestAt: opts.lastDigestAt } : {}),
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: seed.organizationId,
      kind: "group",
      externalChatId: opts.jid,
      groupChatId,
      channel: "whatsapp",
      channelConfigId: seed.configId,
      status: "active",
      messageCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.patch(groupChatId, { conversationId });
    return groupChatId;
  });
}

describe("internalListDigestDue (índice by_monitored_and_digest_at)", () => {
  test("devolve só a sala acompanhada, com digest na hora, de org com IA de grupo", async () => {
    const org = await seedOrg({ aiOn: true, slug: "ia-on" });
    const due = await seedGroup(org, { jid: "1@g.us", monitored: true, dailyDigestAt: "12:00" });
    await seedGroup(org, { jid: "2@g.us", monitored: false, dailyDigestAt: "12:00" });
    await seedGroup(org, { jid: "3@g.us", monitored: true });
    await seedGroup(org, { jid: "4@g.us", monitored: true, dailyDigestAt: "08:00" });
    await seedGroup(org, {
      jid: "5@g.us",
      monitored: true,
      dailyDigestAt: "12:00",
      lastDigestAt: NOW - 2 * 60 * 60 * 1000,
    });
    const noGroupAgent = await seedOrg({ aiOn: true, groupAgent: false, slug: "sem-grupo" });
    await seedGroup(noGroupAgent, { jid: "6@g.us", monitored: true, dailyDigestAt: "12:00" });
    const aiOff = await seedOrg({ slug: "ia-off" });
    await seedGroup(aiOff, { jid: "7@g.us", monitored: true, dailyDigestAt: "12:00" });

    const rows = await t.query(internal.groupAgent.internalListDigestDue, { now: NOW });
    expect(rows).toEqual([{ groupChatId: due, organizationId: org.organizationId }]);
  });

  test("com CRONS_DISABLED=1 o cron horário sai sem consultar nada", async () => {
    vi.stubEnv("CRONS_DISABLED", "1");
    expect(await t.action(internal.groupAgent.internalRunGroupDigests, {})).toBeNull();
  });
});

async function seedDigestData(organizationId: Id<"organizations">, adminId: Id<"teamMembers">) {
  await t.run(async (ctx) => {
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Funil",
      color: "#3b82f6",
      isDefault: true,
      order: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const lead = (title: string, createdAt: number) =>
      ctx.db.insert("leads", {
        organizationId,
        title,
        boardId,
        stageId,
        value: 0,
        currency: "BRL",
        priority: "medium",
        temperature: "warm",
        tags: [],
        customFields: {},
        conversationStatus: "new",
        lastActivityAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      });
    await lead("Novo agora", NOW - 60_000);
    await lead("Antigo", NOW - 3 * DAY_MS);

    const task = (
      title: string,
      fields: { status: "pending" | "in_progress" | "completed"; dueDate?: number; completedAt?: number }
    ) =>
      ctx.db.insert("tasks", {
        organizationId,
        title,
        type: "task",
        priority: "medium",
        createdBy: adminId,
        createdAt: NOW - 5 * DAY_MS,
        updatedAt: NOW,
        ...fields,
      });
    await task("Concluída agora", { status: "completed", completedAt: NOW - 60_000 });
    await task("Concluída há 3 dias", { status: "completed", completedAt: NOW - 3 * DAY_MS });
    await task("Atrasada", { status: "pending", dueDate: NOW - DAY_MS });
    await task("Sem prazo", { status: "pending" });
    await task("No prazo", { status: "in_progress", dueDate: NOW + DAY_MS });
  });
}

async function scheduledDigests() {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
      f.name.includes("dispatchNotification")
    )
  );
}

describe("sendDailyDigest (contagens por range)", () => {
  test("conta leads novos, concluídas e atrasadas das últimas 24 h", async () => {
    const org = await seedOrg({ slug: "digest" });
    await seedDigestData(org.organizationId, org.adminId);

    await t.mutation(internal.email.sendDailyDigest, {});

    const jobs = await scheduledDigests();
    expect(jobs).toHaveLength(1);
    const args = jobs[0].args[0] as any;
    expect(args.recipientMemberId).toBe(org.adminId);
    expect(args.eventType).toBe("dailyDigest");
    expect(args.templateData).toMatchObject({
      newLeadsCount: 1,
      completedTasksCount: 1,
      overdueTasksCount: 1,
      pendingHandoffsCount: 0,
    });
  });

  test("org sem destinatário (membro sem conta) não agenda nada", async () => {
    const org = await seedOrg({ slug: "sem-conta" });
    await t.run(async (ctx) => {
      await ctx.db.patch(org.adminId, { userId: undefined });
    });
    await seedDigestData(org.organizationId, org.adminId);

    await t.mutation(internal.email.sendDailyDigest, {});
    expect(await scheduledDigests()).toHaveLength(0);
  });

  test("com CRONS_DISABLED=1 não agenda nada", async () => {
    const org = await seedOrg({ slug: "desligado" });
    await seedDigestData(org.organizationId, org.adminId);
    vi.stubEnv("CRONS_DISABLED", "1");

    await t.mutation(internal.email.sendDailyDigest, {});
    expect(await scheduledDigests()).toHaveLength(0);
  });
});
