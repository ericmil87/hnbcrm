/**
 * Ops do backlog dos crons de tarefas (perf Convex I/O, fase 1).
 *
 * Os crons `processOverdueReminders` e `processRecurringTasks` passaram a ler
 * por índice o deployment INTEIRO. A varredura antiga (`take(500)` sem range)
 * nunca alcançava parte das tasks, então no 1º tick depois do deploy podem
 * aparecer de uma vez: lembretes vencidos há meses (notificação + e-mail
 * "Tarefa atrasada" para cada um) e recorrentes concluídas antigas sem
 * `lastGeneratedAt` (instância nova para cada uma).
 *
 * Uso previsto: UMA vez em prod, antes ou logo após o deploy da fase, pelo
 * operador (`npx convex run --prod opsTasks:...`). Primeiro
 * `internalCountCronBacklog` para medir; depois `internalStampLegacyCronBacklog`
 * em dryRun (default) e, conferido o plano, com `dryRun:false`. O carimbo só
 * tira o legado da fila dos crons — não notifica, não manda e-mail, não dispara
 * webhook e não gera instância.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { overdueReminderRanges, ungeneratedRecurrenceRanges } from "./tasks";

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNT_RANGE_LIMIT = 1000;

const ageBucketsValidator = {
  count: v.number(),
  olderThan7d: v.number(),
  olderThan30d: v.number(),
};

const byOrganizationValidator = v.array(
  v.object({ organizationId: v.id("organizations"), ...ageBucketsValidator })
);

function summarize(docs: Doc<"tasks">[], ageOf: (d: Doc<"tasks">) => number | undefined, now: number) {
  const olderThan = (d: Doc<"tasks">, days: number) => {
    const at = ageOf(d);
    // Sem data (recorrente legada sem completedAt) conta como antiga.
    return at === undefined || at < now - days * DAY_MS;
  };
  const bucket = (list: Doc<"tasks">[]) => ({
    count: list.length,
    olderThan7d: list.filter((d) => olderThan(d, 7)).length,
    olderThan30d: list.filter((d) => olderThan(d, 30)).length,
  });
  const byOrg = new Map<Id<"organizations">, Doc<"tasks">[]>();
  for (const d of docs) {
    const list = byOrg.get(d.organizationId) ?? [];
    list.push(d);
    byOrg.set(d.organizationId, list);
  }
  return {
    total: bucket(docs),
    byOrganization: [...byOrg.entries()].map(([organizationId, list]) => ({
      organizationId,
      ...bucket(list),
    })),
  };
}

/**
 * Só leitura: o que os dois crons enxergam AGORA, pelos MESMOS ranges, com
 * `take(1000)` por range (`truncated` = o range tem mais que isso).
 * `now` opcional para teste; sem ele usa o relógio (query de ops avulsa, não
 * é assinada por cliente, então `Date.now()` aqui não afeta reatividade).
 */
export const internalCountCronBacklog = internalQuery({
  args: { now: v.optional(v.number()) },
  returns: v.object({
    now: v.number(),
    reminders: v.object({
      ranges: v.array(
        v.object({
          status: v.union(v.literal("pending"), v.literal("in_progress")),
          reminderTriggered: v.union(v.literal("unset"), v.literal("false")),
          truncated: v.boolean(),
          snoozed: v.number(),
          ...ageBucketsValidator,
        })
      ),
      total: v.object(ageBucketsValidator),
      byOrganization: byOrganizationValidator,
    }),
    recurrences: v.object({
      ranges: v.array(
        v.object({
          pattern: v.union(
            v.literal("daily"),
            v.literal("weekly"),
            v.literal("biweekly"),
            v.literal("monthly")
          ),
          truncated: v.boolean(),
          ...ageBucketsValidator,
        })
      ),
      total: v.object(ageBucketsValidator),
      byOrganization: byOrganizationValidator,
    }),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const dueOf = (d: Doc<"tasks">) => d.dueDate;
    const completedOf = (d: Doc<"tasks">) => d.completedAt;

    const reminderRanges = await overdueReminderRanges(ctx, now, COUNT_RANGE_LIMIT);
    const recurrenceRanges = await ungeneratedRecurrenceRanges(ctx, COUNT_RANGE_LIMIT);

    const allReminders = reminderRanges.flatMap((r) => r.docs);
    const allRecurrences = recurrenceRanges.flatMap((r) => r.docs);

    return {
      now,
      reminders: {
        ranges: reminderRanges.map((r) => ({
          status: r.status,
          reminderTriggered: r.triggered === false ? ("false" as const) : ("unset" as const),
          truncated: r.docs.length >= COUNT_RANGE_LIMIT,
          snoozed: r.docs.filter((d) => d.snoozedUntil != null && d.snoozedUntil > now).length,
          ...summarize(r.docs, dueOf, now).total,
        })),
        ...summarize(allReminders, dueOf, now),
      },
      recurrences: {
        ranges: recurrenceRanges.map((r) => ({
          pattern: r.pattern,
          truncated: r.docs.length >= COUNT_RANGE_LIMIT,
          ...summarize(r.docs, completedOf, now).total,
        })),
        ...summarize(allRecurrences, completedOf, now),
      },
    };
  },
});

const planValidator = v.object({
  count: v.number(),
  byOrganization: v.array(
    v.object({ organizationId: v.id("organizations"), taskIds: v.array(v.id("tasks")) })
  ),
});

function groupIds(docs: Doc<"tasks">[]) {
  const byOrg = new Map<Id<"organizations">, Id<"tasks">[]>();
  for (const d of docs) {
    const list = byOrg.get(d.organizationId) ?? [];
    list.push(d._id);
    byOrg.set(d.organizationId, list);
  }
  return {
    count: docs.length,
    byOrganization: [...byOrg.entries()].map(([organizationId, taskIds]) => ({
      organizationId,
      taskIds,
    })),
  };
}

/**
 * Carimba o LEGADO para os crons não o processarem:
 *  - lembrete elegível com `dueDate < now - olderThanDays` → `reminderTriggered: true`
 *    (adiado com snooze futuro fica de fora — o job dele ainda vai disparar);
 *  - recorrente concluída elegível com `completedAt < now - olderThanDays` (ou
 *    sem `completedAt`) → `recurrence.lastGeneratedAt = now`, sem gerar instância.
 * Nenhum efeito colateral além do patch: sem notificação, e-mail, webhook,
 * activity ou audit; um `console.log` JSON por org com os ids.
 * `limit` é o teto TOTAL de tasks por chamada (lembretes primeiro); se
 * `truncated`, rode de novo.
 */
export const internalStampLegacyCronBacklog = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    olderThanDays: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    cutoff: v.number(),
    reminders: planValidator,
    recurrences: planValidator,
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const olderThanDays = args.olderThanDays ?? 7;
    const limit = args.limit ?? 500;
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      throw new Error("olderThanDays deve ser um número ≥ 0");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
      throw new Error("limit deve ser um inteiro entre 1 e 2000");
    }

    const now = Date.now();
    const cutoff = now - olderThanDays * DAY_MS;
    let budget = limit;
    let truncated = false;

    // Lembretes: o corte entra no próprio range (dueDate < cutoff).
    const reminders: Doc<"tasks">[] = [];
    for (const status of ["pending", "in_progress"] as const) {
      for (const triggered of [undefined, false] as const) {
        if (budget <= 0) {
          truncated = true;
          continue;
        }
        const docs = await ctx.db
          .query("tasks")
          .withIndex("by_type_and_status_and_reminder_and_due", (q) =>
            q
              .eq("type", "reminder")
              .eq("status", status)
              .eq("reminderTriggered", triggered)
              .gt("dueDate", undefined)
              .lt("dueDate", cutoff)
          )
          .take(budget);
        if (docs.length >= budget) truncated = true;
        budget -= docs.length;
        reminders.push(...docs.filter((d) => !(d.snoozedUntil != null && d.snoozedUntil > now)));
      }
    }

    // Recorrentes: completedAt não está no índice — filtra em JS.
    const recurrences: Doc<"tasks">[] = [];
    if (budget > 0) {
      for (const range of await ungeneratedRecurrenceRanges(ctx, budget)) {
        if (range.docs.length >= budget) truncated = true;
        for (const d of range.docs) {
          if (recurrences.length >= budget) {
            truncated = true;
            break;
          }
          if (d.completedAt === undefined || d.completedAt < cutoff) recurrences.push(d);
        }
      }
    } else {
      truncated = true;
    }

    const reminderPlan = groupIds(reminders);
    const recurrencePlan = groupIds(recurrences);

    if (!dryRun) {
      for (const d of reminders) {
        await ctx.db.patch(d._id, { reminderTriggered: true });
      }
      for (const d of recurrences) {
        if (!d.recurrence) continue;
        await ctx.db.patch(d._id, { recurrence: { ...d.recurrence, lastGeneratedAt: now } });
      }
      const orgs = new Set([
        ...reminderPlan.byOrganization.map((o) => o.organizationId),
        ...recurrencePlan.byOrganization.map((o) => o.organizationId),
      ]);
      for (const organizationId of orgs) {
        console.log(
          JSON.stringify({
            event: "stampLegacyCronBacklog",
            organizationId,
            cutoff,
            reminderTaskIds:
              reminderPlan.byOrganization.find((o) => o.organizationId === organizationId)?.taskIds ?? [],
            recurrenceTaskIds:
              recurrencePlan.byOrganization.find((o) => o.organizationId === organizationId)?.taskIds ?? [],
          })
        );
      }
    }

    return { dryRun, cutoff, reminders: reminderPlan, recurrences: recurrencePlan, truncated };
  },
});
