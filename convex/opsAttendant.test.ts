/// <reference types="vite/client" />
/**
 * Backfill de `conversations.aiResumedAt` (opsAttendant): conversas devolvidas
 * à IA antes do campo existir ficavam com o chip "IA em espera" para sempre.
 * Prova que só carimba quando o motivo do último skip não vale mais, que o dry
 * run não escreve, que o real se reagenda pelo cursor e grava UM auditLog.
 */
import { expect, test, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Case = {
  error: string;
  status?: "skipped" | "failed" | "done";
  paused?: boolean;
  leadHandoffPending?: boolean;
  pendingHandoffRow?: boolean;
  botSuspicion?: "active" | "cleared";
  skipBeforeInbound?: boolean;
  resumed?: boolean;
};

async function seed(t: TestConvex<typeof schema>, cases: Record<string, Case>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: "admin@teste.com" });
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Ops",
      slug: "org-ops",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra",
      slug: "outra",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin",
      type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" },
      createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0,
      createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });

    const ids: Record<string, Id<"conversations">> = {};
    for (const [name, c] of Object.entries(cases)) {
      const contactId = await ctx.db.insert("contacts", {
        organizationId, firstName: name, tags: [], createdAt: now, updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId, title: name, contactId, boardId, stageId,
        assignedTo: agentId, value: 0, currency: "BRL", priority: "medium",
        temperature: "warm", tags: [], customFields: {}, conversationStatus: "active",
        lastActivityAt: now, createdAt: now, updatedAt: now,
        ...(c.leadHandoffPending
          ? {
              handoffState: {
                status: "pending" as const,
                fromMemberId: agentId,
                reason: "Cliente pediu humano",
                requestedAt: now,
              },
            }
          : {}),
      });
      const lastInboundAt = c.skipBeforeInbound ? now + 5_000 : now;
      const conversationId = await ctx.db.insert("conversations", {
        organizationId, leadId, channel: "whatsapp", status: "active",
        lastInboundAt, messageCount: 1, createdAt: now, updatedAt: now,
        ...(c.paused ? { aiPausedUntil: Number.MAX_SAFE_INTEGER } : {}),
        ...(c.resumed ? { aiResumedAt: now - 10_000 } : {}),
        ...(c.botSuspicion
          ? {
              botSuspicion: {
                at: now,
                source: "heuristic" as const,
                reason: "respostas instantâneas",
                ...(c.botSuspicion === "cleared" ? { clearedAt: now, clearedBy: adminId } : {}),
              },
            }
          : {}),
      });
      const messageId = await ctx.db.insert("messages", {
        organizationId, conversationId, leadId, direction: "inbound",
        senderType: "contact", content: "Oi", contentType: "text",
        isInternal: false, createdAt: now,
      });
      await ctx.db.insert("aiReplyQueue", {
        organizationId, conversationId, triggerMessageId: messageId,
        agentMemberId: agentId, status: c.status ?? "skipped", attempts: 0,
        nextAttemptAt: now + 1_000, error: c.error,
        createdAt: now + 1_000, updatedAt: now + 1_000,
      });
      if (c.pendingHandoffRow) {
        await ctx.db.insert("handoffs", {
          organizationId, leadId, conversationId, fromMemberId: agentId,
          reason: "Cliente pediu humano", suggestedActions: [], status: "pending", createdAt: now,
        });
      }
      ids[name] = conversationId;
    }
    // Conversa de outra org: o escopo por organizationId não pode tocá-la.
    await ctx.db.insert("conversations", {
      organizationId: otherOrgId, channel: "whatsapp", status: "active",
      messageCount: 0, createdAt: now, updatedAt: now,
    });
    return { organizationId, userId, ids };
  });
}

const CASES: Record<string, Case> = {
  handoffDone: { error: "handoff_pendente" },
  handoffStillLead: { error: "handoff_pendente", leadHandoffPending: true },
  handoffStillRow: { error: "handoff_pendente", pendingHandoffRow: true },
  pausedOver: { error: "ia_pausada" },
  pausedStill: { error: "ia_pausada", paused: true },
  botCleared: { error: "suspeita_de_bot", botSuspicion: "cleared" },
  botActive: { error: "suspeita_de_bot", botSuspicion: "active" },
  failedHandoff: { error: "handoff_pendente", status: "failed" },
  otherReason: { error: "lead_de_humano" },
  doneItem: { error: "handoff_pendente", status: "done" },
  beforeInbound: { error: "handoff_pendente", skipBeforeInbound: true },
  alreadyResumed: { error: "handoff_pendente", resumed: true },
};
const EXPECTED = ["handoffDone", "pausedOver", "botCleared", "failedHandoff"];

test("dry run relata sem escrever; real carimba só as elegíveis, pagina e audita uma vez", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t, CASES);
  vi.setSystemTime(Date.now() + 60_000);

  const dry = await t.mutation(internal.opsAttendant.internalBackfillAiResumedAt, {
    organizationId: s.organizationId,
    pageSize: 30,
  });
  expect(dry.dryRun).toBe(true);
  expect(dry.isDone).toBe(true);
  expect(dry.stamped).toEqual({ handoff_pendente: 2, ia_pausada: 1, suspeita_de_bot: 1 });
  expect(dry.skipped).toEqual({ ja_carimbada: 1, pausada: 1, sem_chip: 3, ainda_vale: 3 });
  expect(new Set(dry.conversationIds)).toEqual(new Set(EXPECTED.map((n) => s.ids[n])));
  const untouched = await t.run(async (ctx) =>
    (await ctx.db.query("conversations").collect()).filter((c) => c.aiResumedAt !== undefined)
  );
  expect(untouched.map((c) => c._id)).toEqual([s.ids.alreadyResumed]);

  // Chip ainda aparece antes do real.
  const asAdmin = t.withIdentity({ subject: `${s.userId}|s1` });
  expect(
    await asAdmin.query(api.attendant.getConversationAiState, { conversationId: s.ids.handoffDone })
  ).toMatchObject({ status: "skipped", reason: "handoff_pendente" });

  const first = await t.mutation(internal.opsAttendant.internalBackfillAiResumedAt, {
    organizationId: s.organizationId,
    dryRun: false,
    pageSize: 3,
  });
  expect(first.scheduledNext).toBe(true);
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const after = await t.run(async (ctx) => ({
    conversations: await ctx.db.query("conversations").collect(),
    audits: await ctx.db
      .query("auditLogs")
      .withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId))
      .collect(),
  }));
  const stampedNow = after.conversations
    .filter((c) => c.aiResumedAt !== undefined && c._id !== s.ids.alreadyResumed)
    .map((c) => c._id);
  expect(new Set(stampedNow)).toEqual(new Set(EXPECTED.map((n) => s.ids[n])));
  expect(after.audits).toHaveLength(1);
  expect(after.audits[0].metadata).toMatchObject({ totalStamped: 4 });

  for (const name of EXPECTED) {
    expect(
      await asAdmin.query(api.attendant.getConversationAiState, { conversationId: s.ids[name] })
    ).toBeNull();
  }
  expect(
    await asAdmin.query(api.attendant.getConversationAiState, { conversationId: s.ids.botActive })
  ).toMatchObject({ reason: "suspeita_de_bot" });

  // Idempotente: rodar de novo não carimba nada.
  const again = await t.mutation(internal.opsAttendant.internalBackfillAiResumedAt, {
    organizationId: s.organizationId,
    pageSize: 30,
  });
  expect(again.conversationIds).toHaveLength(0);
  expect(again.skipped.ja_carimbada).toBe(5);
});
