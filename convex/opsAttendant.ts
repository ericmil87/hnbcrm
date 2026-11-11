/**
 * Ops do atendente IA (estado da conversa). SÓ funções internas, `dryRun`
 * default TRUE, ids na saída (nunca nome/telefone).
 *
 *  - internalBackfillAiResumedAt: conversas devolvidas à IA ANTES de existir
 *    `conversations.aiResumedAt` continuam com o chip "IA em espera" (o último
 *    item da fila é um `skipped` velho, gravado com o repasse aberto / a
 *    conversa pausada / a suspeita de robô de pé). Como já não estão pausadas,
 *    o menu nem oferece "Devolver à IA" de novo. Carimba `aiResumedAt: now`
 *    quando TODAS valem:
 *      (a) `aiResumedAt` ausente;
 *      (b) não pausada (`aiPausedUntil` ausente ou <= agora);
 *      (c) o último item NÃO follow-up da fila (mesma regra do chip,
 *          `latestReactiveQueueItem`) é `skipped`/`failed` com motivo em
 *          `handoff_pendente`/`ia_pausada`/`suspeita_de_bot` e depois do
 *          último inbound;
 *      (d) a condição do motivo não vale mais: `handoff_pendente` → lead sem
 *          `handoffState` aberto E nenhum repasse `pending` da conversa;
 *          `ia_pausada` → (b); `suspeita_de_bot` → `botSuspicion` ausente ou
 *          com `clearedAt`.
 *    O dry run devolve as contagens de UMA página; o real se reagenda pelo
 *    cursor até o fim e, com `organizationId`, grava UM auditLog no fim.
 *
 *   npx convex run opsAttendant:internalBackfillAiResumedAt '{"dryRun":true}'
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getLeadRef } from "./lib/leadRef";
import { latestReactiveQueueItem } from "./lib/aiStateQueue";
import { checkUrl } from "./lib/safeFetch";
import { AGENDA_PORT_POLICY } from "./lib/externalAgenda";

const DEFAULT_PAGE_SIZE = 25;
// Cada conversa lê até 5 × 100 itens da fila (mesma janela do chip): 30 por
// página fica abaixo do teto de 16k leituras por transação no pior caso.
const MAX_PAGE_SIZE = 30;
const MAX_IDS = 200;
const STALE_REASONS = ["handoff_pendente", "ia_pausada", "suspeita_de_bot"] as const;
type StaleReason = (typeof STALE_REASONS)[number];

const countsValidator = v.object({
  handoff_pendente: v.number(),
  ia_pausada: v.number(),
  suspeita_de_bot: v.number(),
});

type Verdict =
  | { stamp: true; reason: StaleReason }
  | { stamp: false; why: "ja_carimbada" | "pausada" | "sem_chip" | "ainda_vale" };

async function evaluate(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  now: number
): Promise<Verdict> {
  if (conversation.aiResumedAt !== undefined) return { stamp: false, why: "ja_carimbada" };
  if (conversation.aiPausedUntil !== undefined && conversation.aiPausedUntil > now) {
    return { stamp: false, why: "pausada" };
  }
  const latest = await latestReactiveQueueItem(ctx.db, conversation._id);
  if (
    !latest ||
    (latest.status !== "skipped" && latest.status !== "failed") ||
    !(STALE_REASONS as readonly string[]).includes(latest.error ?? "") ||
    latest.updatedAt < (conversation.lastInboundAt ?? 0)
  ) {
    return { stamp: false, why: "sem_chip" };
  }
  const reason = latest.error as StaleReason;
  if (reason === "handoff_pendente") {
    const lead = await getLeadRef(ctx.db, conversation.leadId);
    if (lead?.handoffState && lead.handoffState.status !== "completed") {
      return { stamp: false, why: "ainda_vale" };
    }
    const pending = await ctx.db
      .query("handoffs")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversation._id).eq("status", "pending")
      )
      .first();
    if (pending) return { stamp: false, why: "ainda_vale" };
  } else if (reason === "suspeita_de_bot") {
    if (conversation.botSuspicion && conversation.botSuspicion.clearedAt === undefined) {
      return { stamp: false, why: "ainda_vale" };
    }
  }
  // ia_pausada: já garantido por (b).
  return { stamp: true, reason };
}

export const internalBackfillAiResumedAt = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    // Acumulado das páginas anteriores (só o run real se reagenda com ele).
    totalStamped: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    stamped: countsValidator,
    skipped: v.object({
      ja_carimbada: v.number(),
      pausada: v.number(),
      sem_chip: v.number(),
      ainda_vale: v.number(),
    }),
    conversationIds: v.array(v.id("conversations")),
    totalStamped: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
    scheduledNext: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const pageSize = Math.max(
      1,
      Math.min(MAX_PAGE_SIZE, Math.floor(Number.isFinite(args.pageSize) ? args.pageSize! : DEFAULT_PAGE_SIZE))
    );
    const paginationOpts = { cursor: args.cursor ?? null, numItems: pageSize };
    const page = args.organizationId
      ? await ctx.db
          .query("conversations")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId!))
          .paginate(paginationOpts)
      : await ctx.db.query("conversations").paginate(paginationOpts);

    const now = Date.now();
    const stamped = { handoff_pendente: 0, ia_pausada: 0, suspeita_de_bot: 0 };
    const skipped = { ja_carimbada: 0, pausada: 0, sem_chip: 0, ainda_vale: 0 };
    const conversationIds: Id<"conversations">[] = [];

    for (const conversation of page.page) {
      const verdict = await evaluate(ctx, conversation, now);
      if (!verdict.stamp) {
        skipped[verdict.why]++;
        continue;
      }
      stamped[verdict.reason]++;
      if (conversationIds.length < MAX_IDS) conversationIds.push(conversation._id);
      // Só o carimbo: não mexe em `updatedAt` (a lista do inbox não deve
      // reordenar por causa de um backfill).
      if (!dryRun) await ctx.db.patch(conversation._id, { aiResumedAt: now });
    }

    const pageStamped = stamped.handoff_pendente + stamped.ia_pausada + stamped.suspeita_de_bot;
    const totalStamped = (args.totalStamped ?? 0) + pageStamped;

    let scheduledNext = false;
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.opsAttendant.internalBackfillAiResumedAt, {
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        dryRun: false,
        cursor: page.continueCursor,
        pageSize,
        totalStamped,
      });
      scheduledNext = true;
    }

    if (!dryRun) {
      console.log(
        JSON.stringify({
          op: "backfillAiResumedAt",
          scanned: page.page.length,
          stamped,
          skipped,
          totalStamped,
          isDone: page.isDone,
        })
      );
      // Uma entrada de auditoria por run (no fim), só quando escopado: o
      // auditLog é por org e um run global atravessa várias.
      if (page.isDone && args.organizationId) {
        await ctx.db.insert("auditLogs", {
          organizationId: args.organizationId,
          entityType: "organization",
          entityId: args.organizationId,
          action: "update",
          actorType: "system",
          metadata: { op: "internalBackfillAiResumedAt", totalStamped },
          description: `Backfill de aiResumedAt: ${totalStamped} conversa(s) devolvidas à IA sem o carimbo`,
          severity: "low",
          createdAt: now,
        });
      }
    }

    return {
      dryRun,
      scanned: page.page.length,
      stamped,
      skipped,
      conversationIds,
      totalStamped,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      scheduledNext,
    };
  },
});

// ---------------------------------------------------------------------------
// Agenda externa × safeFetch (P2.2)
// ---------------------------------------------------------------------------

/** Host mascarado para saída de ops: 3 primeiros caracteres + último rótulo. */
export function maskAgendaHost(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "(inválida)";
  }
  const labels = host.replace(/\.$/, "").split(".");
  const last = labels.length > 1 ? `.${labels[labels.length - 1]}` : "";
  return host.length <= 6 ? `${host.slice(0, 1)}…` : `${host.slice(0, 3)}…${last}`;
}

/**
 * SÓ LEITURA (não há modo real): lista agendas externas salvas cuja URL o
 * `checkUrl` do P2.2 recusaria (http, porta < 1024 que não seja 443, IP
 * privado literal, `localhost`/`*.internal`, formato numérico alternativo…).
 * Varre `teamMembers` por cursor; a saída tem só org, membro, host mascarado
 * e o código — nunca a URL completa nem a chave. Não checa DNS.
 *
 *   npx convex run opsAttendant:internalAuditAgendaUrls '{}'
 *   npx convex run opsAttendant:internalAuditAgendaUrls '{"cursor":"<continueCursor>"}'
 */
export const internalAuditAgendaUrls = internalQuery({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    withAgenda: v.number(),
    refused: v.array(
      v.object({
        organizationId: v.id("organizations"),
        agentMemberId: v.id("teamMembers"),
        enabled: v.boolean(),
        host: v.string(),
        code: v.string(),
      })
    ),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const raw = Number.isFinite(args.pageSize) ? Math.floor(args.pageSize!) : 200;
    const numItems = Math.min(500, Math.max(1, raw));
    const result = await ctx.db.query("teamMembers").paginate({ numItems, cursor: args.cursor ?? null });
    let withAgenda = 0;
    const refused: Array<{
      organizationId: Id<"organizations">;
      agentMemberId: Id<"teamMembers">;
      enabled: boolean;
      host: string;
      code: string;
    }> = [];
    for (const member of result.page) {
      const agenda = member.agentProfile?.externalAgenda;
      if (!agenda) continue;
      withAgenda++;
      const check = checkUrl(agenda.url, AGENDA_PORT_POLICY);
      if (check.ok) continue;
      refused.push({
        organizationId: member.organizationId,
        agentMemberId: member._id,
        enabled: agenda.enabled,
        host: maskAgendaHost(agenda.url),
        code: check.code,
      });
    }
    return {
      scanned: result.page.length,
      withAgenda,
      refused,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});
