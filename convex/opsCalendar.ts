/**
 * Ops da agenda. `internalBackfillCalendarLongStart` grava `calendarEvents.longStart`
 * (= startTime) nos eventos de duração > 1 dia que ainda não o têm — o campo
 * que alimenta `by_organization_and_long_start` (lib/calendarRules.longStartFor).
 * Até rodar, evento longo legado que começou mais de 1 dia antes da janela não
 * aparece na grade (igual ao comportamento anterior, sem regressão).
 *
 * `dryRun` default TRUE (lê UMA página e conta; `countAll: true` segue pelas páginas
 * sem escrever), paginado por `cursor`, idempotente, saída só com contagens (sem PII).
 *
 *   npx convex run opsCalendar:internalBackfillCalendarLongStart '{"dryRun":true,"countAll":true}'
 *   npx convex run opsCalendar:internalBackfillCalendarLongStart '{"dryRun":false}'
 * (PROD: o mesmo com `--prod`, sempre depois do dry run.)
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { longStartFor } from "./lib/calendarRules";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

const totalsValidator = v.object({ scanned: v.number(), wouldWrite: v.number(), pages: v.number() });

export const internalBackfillCalendarLongStart = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    countAll: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    organizationId: v.optional(v.id("organizations")),
    totals: v.optional(totalsValidator),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    wouldWrite: v.number(),
    written: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    scheduledNext: v.boolean(),
    totals: totalsValidator,
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)));
    const paginationOpts = { cursor: args.cursor ?? null, numItems: pageSize };
    const page = args.organizationId
      ? await ctx.db
          .query("calendarEvents")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId!))
          .paginate(paginationOpts)
      : await ctx.db.query("calendarEvents").paginate(paginationOpts);

    let wouldWrite = 0;
    let written = 0;
    for (const event of page.page) {
      const longStart = longStartFor(event.startTime, event.endTime);
      if (longStart === undefined || event.longStart === longStart) continue;
      wouldWrite++;
      if (!dryRun) {
        await ctx.db.patch(event._id, { longStart });
        written++;
      }
    }

    const prev = args.totals ?? { scanned: 0, wouldWrite: 0, pages: 0 };
    const totals = {
      scanned: prev.scanned + page.page.length,
      wouldWrite: prev.wouldWrite + wouldWrite,
      pages: prev.pages + 1,
    };
    const chain = !page.isDone && (!dryRun || args.countAll === true);
    if (chain) {
      await ctx.scheduler.runAfter(0, internal.opsCalendar.internalBackfillCalendarLongStart, {
        dryRun,
        ...(args.countAll ? { countAll: true } : {}),
        cursor: page.continueCursor,
        pageSize,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        totals,
      });
    }
    if (page.isDone && (!dryRun || args.countAll)) {
      console.log(JSON.stringify({ op: "backfillCalendarLongStart", dryRun, ...totals }));
    }
    return {
      dryRun,
      scanned: page.page.length,
      wouldWrite,
      written,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
      scheduledNext: chain,
      totals,
    };
  },
});
