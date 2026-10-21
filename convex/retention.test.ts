/// <reference types="vite/client" />
/**
 * Retenção (perf Convex I/O, fase 4a): o cron diário apaga só o que é
 * histórico (lida/terminal/abandonado/`low` além da janela) e nunca dado vivo.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 21, 7, 30);

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function drain() {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

type Base = {
  organizationId: Id<"organizations">;
  memberId: Id<"teamMembers">;
  conversationId: Id<"conversations">;
  messageId: Id<"messages">;
  formId: Id<"forms">;
};

async function seedBase(): Promise<Base> {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org-retencao",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, name: "IA", role: "ai", type: "ai", status: "active", createdAt: NOW, updatedAt: NOW,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: NOW, updatedAt: NOW,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: NOW, updatedAt: NOW,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, channel: "whatsapp", status: "active", messageCount: 1, createdAt: NOW, updatedAt: NOW,
    });
    const messageId = await ctx.db.insert("messages", {
      organizationId, conversationId, direction: "inbound", senderType: "contact",
      content: "oi", contentType: "text", isInternal: false, createdAt: NOW,
    });
    const formId = await ctx.db.insert("forms", {
      organizationId,
      name: "Contato",
      slug: "contato-retencao",
      status: "published",
      fields: [{ id: "f1", type: "text", label: "Nome", isRequired: false }],
      theme: { primaryColor: "#000", backgroundColor: "#fff", textColor: "#000", borderRadius: "md", showBranding: false },
      settings: {
        submitButtonText: "Enviar",
        successMessage: "ok",
        notifyOnSubmission: false,
        leadTitle: "Lead do site",
        boardId,
        stageId,
        assignmentMode: "none",
        defaultPriority: "medium",
        defaultTemperature: "cold",
        tags: [],
        honeypotEnabled: false,
      },
      createdBy: memberId,
      submissionCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return { organizationId, memberId, conversationId, messageId, formId };
  });
}

const insertNotification = (b: Base, createdAt: number, readAt?: number) =>
  t.run((ctx) =>
    ctx.db.insert("notifications", {
      organizationId: b.organizationId,
      memberId: b.memberId,
      type: "task_assigned",
      title: "x",
      readAt,
      createdAt,
    })
  );

const insertQueue = (b: Base, status: "pending" | "processing" | "done" | "skipped" | "failed", updatedAt: number) =>
  t.run((ctx) =>
    ctx.db.insert("aiReplyQueue", {
      organizationId: b.organizationId,
      conversationId: b.conversationId,
      triggerMessageId: b.messageId,
      agentMemberId: b.memberId,
      status,
      attempts: 0,
      nextAttemptAt: updatedAt,
      createdAt: updatedAt,
      updatedAt,
    })
  );

const insertRun = (b: Base, status: "running" | "done" | "error" | "aborted", startedAt: number) =>
  t.run((ctx) =>
    ctx.db.insert("agentRuns", {
      organizationId: b.organizationId,
      memberId: b.memberId,
      kind: "attendant",
      status,
      requestCount: 1,
      startedAt,
    })
  );

const insertPartial = (b: Base, status: "in_progress" | "abandoned" | "converted", lastActivityAt: number) =>
  t.run((ctx) =>
    ctx.db.insert("formPartials", {
      organizationId: b.organizationId,
      formId: b.formId,
      sessionId: `s-${Math.random()}`,
      status,
      data: {},
      completedFieldIds: [],
      totalFields: 3,
      completionPercent: 10,
      firstInteractionAt: lastActivityAt,
      lastActivityAt,
      createdAt: lastActivityAt,
    })
  );

const insertAudit = (
  b: Base,
  severity: "low" | "medium" | "high" | "critical",
  createdAt: number,
  action: "create" | "update" | "delete" = "update"
) =>
  t.run((ctx) =>
    ctx.db.insert("auditLogs", {
      organizationId: b.organizationId,
      entityType: "lead",
      entityId: "x",
      action,
      actorType: "system",
      severity,
      createdAt,
    })
  );

const exists = (id: Id<any>) => t.run(async (ctx) => (await ctx.db.get(id)) !== null);

async function runCron(args: Record<string, unknown> = {}) {
  await t.mutation(internal.retention.internalRunRetention, args as any);
  await drain();
}

describe("retenção por tabela", () => {
  test("notifications: lida há > 90d sai; lida recente e não lida velha ficam", async () => {
    const b = await seedBase();
    const oldRead = await insertNotification(b, NOW - 200 * DAY, NOW - 91 * DAY);
    const recentRead = await insertNotification(b, NOW - 200 * DAY, NOW - 89 * DAY);
    const unreadOld = await insertNotification(b, NOW - 400 * DAY);
    await runCron();
    expect(await exists(oldRead)).toBe(false);
    expect(await exists(recentRead)).toBe(true);
    expect(await exists(unreadOld)).toBe(true);
  });

  test("aiReplyQueue: terminal velho sai; terminal recente e pending/processing velhos ficam", async () => {
    const b = await seedBase();
    const done = await insertQueue(b, "done", NOW - 91 * DAY);
    const skipped = await insertQueue(b, "skipped", NOW - 120 * DAY);
    const failed = await insertQueue(b, "failed", NOW - 100 * DAY);
    const recent = await insertQueue(b, "done", NOW - 10 * DAY);
    const pending = await insertQueue(b, "pending", NOW - 300 * DAY);
    const processing = await insertQueue(b, "processing", NOW - 300 * DAY);
    await runCron();
    expect(await exists(done)).toBe(false);
    expect(await exists(skipped)).toBe(false);
    expect(await exists(failed)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(pending)).toBe(true);
    expect(await exists(processing)).toBe(true);
  });

  test("agentRuns: terminal velha sai; running velha e terminal recente ficam", async () => {
    const b = await seedBase();
    const done = await insertRun(b, "done", NOW - 91 * DAY);
    const error = await insertRun(b, "error", NOW - 91 * DAY);
    const aborted = await insertRun(b, "aborted", NOW - 91 * DAY);
    const running = await insertRun(b, "running", NOW - 300 * DAY);
    const recent = await insertRun(b, "done", NOW - 30 * DAY);
    await runCron();
    expect(await exists(done)).toBe(false);
    expect(await exists(error)).toBe(false);
    expect(await exists(aborted)).toBe(false);
    expect(await exists(running)).toBe(true);
    expect(await exists(recent)).toBe(true);
  });

  test("formPartials: abandonado > 30d sai; in_progress/converted velhos e abandonado recente ficam", async () => {
    const b = await seedBase();
    const abandonedOld = await insertPartial(b, "abandoned", NOW - 31 * DAY);
    const abandonedRecent = await insertPartial(b, "abandoned", NOW - 5 * DAY);
    const inProgress = await insertPartial(b, "in_progress", NOW - 200 * DAY);
    const converted = await insertPartial(b, "converted", NOW - 200 * DAY);
    await runCron();
    expect(await exists(abandonedOld)).toBe(false);
    expect(await exists(abandonedRecent)).toBe(true);
    expect(await exists(inProgress)).toBe(true);
    expect(await exists(converted)).toBe(true);
  });

  test("auditLogs: só low > 180d e ação ≠ delete sai", async () => {
    const b = await seedBase();
    const lowOld = await insertAudit(b, "low", NOW - 181 * DAY);
    const lowCreateOld = await insertAudit(b, "low", NOW - 181 * DAY, "create");
    const lowRecent = await insertAudit(b, "low", NOW - 170 * DAY);
    const lowDeleteOld = await insertAudit(b, "low", NOW - 400 * DAY, "delete");
    const medium = await insertAudit(b, "medium", NOW - 400 * DAY);
    const high = await insertAudit(b, "high", NOW - 400 * DAY, "delete");
    const critical = await insertAudit(b, "critical", NOW - 400 * DAY);
    await runCron();
    expect(await exists(lowOld)).toBe(false);
    expect(await exists(lowCreateOld)).toBe(false);
    expect(await exists(lowRecent)).toBe(true);
    expect(await exists(lowDeleteOld)).toBe(true);
    expect(await exists(medium)).toBe(true);
    expect(await exists(high)).toBe(true);
    expect(await exists(critical)).toBe(true);
  });
});

describe("paginação, teto e travas", () => {
  test("450 velhos → três lotes, tudo apagado, nada vivo tocado", async () => {
    const b = await seedBase();
    await t.run(async (ctx) => {
      for (let i = 0; i < 450; i++) {
        await ctx.db.insert("notifications", {
          organizationId: b.organizationId,
          memberId: b.memberId,
          type: "task_assigned",
          title: "x",
          readAt: NOW - (100 + i) * DAY,
          createdAt: NOW - 500 * DAY,
        });
      }
    });
    const live = await insertNotification(b, NOW - 500 * DAY);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCron();
    const batches = log.mock.calls
      .map((c) => JSON.parse(String(c[0])))
      .filter((e) => e.event === "retention" && e.table === "notifications" && typeof e.deleted === "number");
    log.mockRestore();
    expect(batches.map((e) => e.deleted)).toEqual([200, 200, 50]);
    const left = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(left.map((n) => n._id)).toEqual([live]);
  });

  test("teto por execução para e deixa o resto para o dia seguinte", async () => {
    const b = await seedBase();
    for (let i = 0; i < 5; i++) await insertNotification(b, NOW - 500 * DAY, NOW - 100 * DAY);
    for (let i = 0; i < 5; i++) await insertRun(b, "done", NOW - 100 * DAY);
    await runCron({ maxDocs: 3 });
    const [notifs, runs] = await t.run(async (ctx) => [
      (await ctx.db.query("notifications").collect()).length,
      (await ctx.db.query("agentRuns").collect()).length,
    ]);
    expect(notifs).toBe(2);
    expect(runs).toBe(5);
  });

  test("RETENTION_DISABLED=1 e CRONS_DISABLED=1 → no-op", async () => {
    const b = await seedBase();
    const id = await insertNotification(b, NOW - 500 * DAY, NOW - 100 * DAY);
    vi.stubEnv("RETENTION_DISABLED", "1");
    await runCron();
    expect(await exists(id)).toBe(true);
    vi.unstubAllEnvs();
    vi.stubEnv("CRONS_DISABLED", "1");
    await runCron();
    expect(await exists(id)).toBe(true);
    vi.unstubAllEnvs();
    await runCron();
    expect(await exists(id)).toBe(false);
  });

  test("env de janela sobrepõe o padrão; valor inválido cai no padrão", async () => {
    const b = await seedBase();
    const id = await insertNotification(b, NOW - 500 * DAY, NOW - 40 * DAY);
    vi.stubEnv("RETENTION_NOTIFICATIONS_DAYS", "3"); // abaixo do piso → padrão 90
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await runCron();
    expect(await exists(id)).toBe(true);
    vi.stubEnv("RETENTION_NOTIFICATIONS_DAYS", "30");
    await runCron();
    expect(await exists(id)).toBe(false);
  });

  test("dryRun (default) não apaga e devolve o plano com os mais antigos", async () => {
    const b = await seedBase();
    const oldest = await insertRun(b, "error", NOW - 300 * DAY);
    await insertRun(b, "done", NOW - 200 * DAY);
    await insertRun(b, "running", NOW - 400 * DAY);
    const res = await t.mutation(internal.retention.internalRunRetentionNow, {});
    await drain();
    expect(res.dryRun).toBe(true);
    const runs = res.plan.find((p) => p.table === "agentRuns")!;
    expect(runs.count).toBe(2);
    expect(runs.oldest[0].id).toBe(oldest);
    expect(await exists(oldest)).toBe(true);
  });

  test("execução manual real com `table` só mexe naquela tabela e ignora CRONS_DISABLED", async () => {
    const b = await seedBase();
    const notif = await insertNotification(b, NOW - 500 * DAY, NOW - 100 * DAY);
    const run = await insertRun(b, "done", NOW - 100 * DAY);
    vi.stubEnv("CRONS_DISABLED", "1");
    await t.mutation(internal.retention.internalRunRetentionNow, { dryRun: false, table: "agentRuns" });
    await drain();
    expect(await exists(run)).toBe(false);
    expect(await exists(notif)).toBe(true);
  });

  test("override abaixo do piso é recusado", async () => {
    await expect(
      t.mutation(internal.retention.internalRunRetentionNow, { olderThanOverrides: { auditLogs: 1 } })
    ).rejects.toThrow(/≥ 7/);
  });
});

describe("preview", () => {
  test("conta os candidatos por tabela", async () => {
    const b = await seedBase();
    await insertNotification(b, NOW - 500 * DAY, NOW - 100 * DAY);
    await insertNotification(b, NOW - 500 * DAY);
    await insertQueue(b, "done", NOW - 100 * DAY);
    await insertQueue(b, "pending", NOW - 100 * DAY);
    await insertPartial(b, "abandoned", NOW - 40 * DAY);
    await insertAudit(b, "low", NOW - 200 * DAY);
    await insertAudit(b, "low", NOW - 200 * DAY, "delete");
    const out = await t.query(internal.retention.internalRetentionPreview, { now: NOW });
    const byTable = Object.fromEntries(out.map((p) => [p.table, p.count]));
    expect(byTable).toEqual({ notifications: 1, aiReplyQueue: 1, agentRuns: 0, formPartials: 1, auditLogs: 1 });
    expect(out.every((p) => p.truncated === false)).toBe(true);
    // Override de janela no preview.
    const wider = await t.query(internal.retention.internalRetentionPreview, {
      now: NOW,
      olderThanOverrides: { auditLogs: 365 },
    });
    expect(wider.find((p) => p.table === "auditLogs")!.count).toBe(0);
  });
});
