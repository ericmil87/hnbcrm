/**
 * Backfill da flag `conversations.hasUnread` (índice do chip "Não lidas" por
 * tempo, ver lib/unreadFields.ts e docs/architecture/inbox.md).
 *
 * `internalBackfillHasUnread`: percorre TODAS as conversas (paginado por
 * `cursor`, `pageSize` default 150 = no máximo 150 escritas por execução) e
 * alinha a flag a `unreadCount > 0`: grava `true` em quem tem não lidas sem a
 * flag e REMOVE a flag órfã de quem está com 0. Percorre a tabela toda (e não o
 * índice antigo por org) para cobrir todas as orgs e achar flag órfã. `dryRun`
 * default TRUE (lê uma página e só conta; `countAll: true` segue sem escrever).
 * Idempotente: a 2ª execução não escreve. Saída só com contagens.
 *
 *   npx convex run opsUnreadIndex:internalBackfillHasUnread '{"dryRun":true,"countAll":true}'
 *   npx convex run opsUnreadIndex:internalBackfillHasUnread '{"dryRun":false}'
 * Depois (por deployment): `INBOX_UNREAD_TIME_INDEX=1`.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

const DEFAULT_PAGE_SIZE = 150;
const MAX_PAGE_SIZE = 150;

const totalsValidator = v.object({
  scanned: v.number(),
  wouldSet: v.number(),
  wouldClear: v.number(),
  pages: v.number(),
});

export const internalBackfillHasUnread = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    countAll: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    totals: v.optional(totalsValidator),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    wouldSet: v.number(),
    wouldClear: v.number(),
    written: v.number(),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    scheduledNext: v.boolean(),
    totals: totalsValidator,
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)));
    const page = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: pageSize });

    let wouldSet = 0;
    let wouldClear = 0;
    let written = 0;
    for (const c of page.page) {
      const unread = (c.unreadCount ?? 0) > 0;
      if (unread && c.hasUnread !== true) {
        wouldSet++;
        if (!dryRun) {
          await ctx.db.patch(c._id, { hasUnread: true });
          written++;
        }
      } else if (!unread && c.hasUnread !== undefined) {
        wouldClear++;
        if (!dryRun) {
          await ctx.db.patch(c._id, { hasUnread: undefined });
          written++;
        }
      }
    }

    const prev = args.totals ?? { scanned: 0, wouldSet: 0, wouldClear: 0, pages: 0 };
    const totals = {
      scanned: prev.scanned + page.page.length,
      wouldSet: prev.wouldSet + wouldSet,
      wouldClear: prev.wouldClear + wouldClear,
      pages: prev.pages + 1,
    };
    const chain = !page.isDone && (!dryRun || args.countAll === true);
    if (chain) {
      await ctx.scheduler.runAfter(0, internal.opsUnreadIndex.internalBackfillHasUnread, {
        dryRun,
        ...(args.countAll ? { countAll: true } : {}),
        cursor: page.continueCursor,
        pageSize,
        totals,
      });
    }
    if (page.isDone && (!dryRun || args.countAll)) {
      console.log(JSON.stringify({ op: "backfillHasUnread", dryRun, ...totals }));
    }
    return {
      dryRun,
      scanned: page.page.length,
      wouldSet,
      wouldClear,
      written,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
      scheduledNext: chain,
      totals,
    };
  },
});
