/**
 * Ops da busca sem acento (07/11/2026). Dois backfills, ambos `dryRun` default TRUE,
 * paginados por `cursor`, idempotentes (só escrevem quando o valor muda) e
 * sem PII na saída (só contagens).
 *
 * - `internalBackfillContactSearchText`: reescreve `contacts.searchText`
 *   dobrado. Contato COM `searchText` vira `foldForSearch(searchText)` (mantém
 *   o que cada escritor gravou, ex.: @ do Instagram); contato SEM o campo
 *   ganha `buildSearchText(contact)`.
 * - `internalBackfillMessageSearchText`: grava `messages.searchNorm`
 *   (`messageSearchNorm`) nas mensagens antigas. Opcional `organizationId`
 *   e `sinceMs` (`createdAt >=`).
 *
 * Dry run lê UMA página e devolve o que escreveria. `countAll: true` no dry
 * run segue pelas páginas (agendando a si mesmo, sem escrever) e loga o total
 * no fim (`console.log` com contagens), para decidir o custo de I/O antes.
 * Real (`dryRun: false`) escreve a página e agenda a próxima.
 *
 *   npx convex run opsSearchFold:internalBackfillContactSearchText '{"dryRun":true,"countAll":true}'
 *   npx convex run opsSearchFold:internalBackfillContactSearchText '{"dryRun":false}'
 *   npx convex run opsSearchFold:internalBackfillMessageSearchText '{"dryRun":true,"countAll":true}'
 *   npx convex run opsSearchFold:internalBackfillMessageSearchText '{"dryRun":false}'
 * (PROD: o mesmo com `--prod`, sempre depois do dry run.)
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildSearchText } from "./lib/searchText";
import { foldForSearch } from "./lib/searchFold";
import { messageSearchNorm } from "./lib/messageSearch";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

const totalsValidator = v.object({
  scanned: v.number(),
  wouldWrite: v.number(),
  pages: v.number(),
});

const resultValidator = v.object({
  dryRun: v.boolean(),
  scanned: v.number(),
  /** Linhas desta página que mudam (dry run) ou que foram escritas (real). */
  wouldWrite: v.number(),
  written: v.number(),
  skipped: v.number(),
  isDone: v.boolean(),
  continueCursor: v.union(v.string(), v.null()),
  scheduledNext: v.boolean(),
  /** Acumulado desde a 1ª página (só com `countAll` ou no modo real). */
  totals: totalsValidator,
});

function clampPageSize(n: number | undefined): number {
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n ?? DEFAULT_PAGE_SIZE)));
}

/** Novo `searchText` do contato (ou `undefined` = nada a gravar). */
export function nextContactSearchText(contact: {
  searchText?: string;
  firstName?: string; lastName?: string; email?: string; phone?: string;
  company?: string; title?: string; city?: string; state?: string;
  country?: string; industry?: string; bio?: string; instagramUsername?: string;
}): string | undefined {
  const next = contact.searchText ? foldForSearch(contact.searchText) : buildSearchText(contact);
  return next || undefined;
}

export const internalBackfillContactSearchText = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    countAll: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    organizationId: v.optional(v.id("organizations")),
    totals: v.optional(totalsValidator),
  },
  returns: resultValidator,
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const pageSize = clampPageSize(args.pageSize);
    const paginationOpts = { cursor: args.cursor ?? null, numItems: pageSize };
    const page = args.organizationId
      ? await ctx.db
          .query("contacts")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId!))
          .paginate(paginationOpts)
      : await ctx.db.query("contacts").paginate(paginationOpts);

    let wouldWrite = 0;
    let written = 0;
    for (const contact of page.page) {
      const next = nextContactSearchText(contact);
      if (next === contact.searchText) continue;
      wouldWrite++;
      if (!dryRun) {
        await ctx.db.patch(contact._id, { searchText: next });
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
      await ctx.scheduler.runAfter(0, internal.opsSearchFold.internalBackfillContactSearchText, {
        dryRun,
        ...(args.countAll ? { countAll: true } : {}),
        cursor: page.continueCursor,
        pageSize,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        totals,
      });
    }
    if (page.isDone && (!dryRun || args.countAll)) {
      console.log(JSON.stringify({ op: "backfillContactSearchText", dryRun, ...totals }));
    }
    return {
      dryRun,
      scanned: page.page.length,
      wouldWrite,
      written,
      skipped: page.page.length - wouldWrite,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
      scheduledNext: chain,
      totals,
    };
  },
});

export const internalBackfillMessageSearchText = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    countAll: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    organizationId: v.optional(v.id("organizations")),
    /** Só mensagens com `createdAt >= sinceMs`. */
    sinceMs: v.optional(v.number()),
    totals: v.optional(totalsValidator),
  },
  returns: resultValidator,
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const pageSize = clampPageSize(args.pageSize);
    const sinceMs =
      args.sinceMs !== undefined && Number.isFinite(args.sinceMs) && args.sinceMs > 0
        ? args.sinceMs
        : undefined;
    const paginationOpts = { cursor: args.cursor ?? null, numItems: pageSize };
    // Com org: índice da org (o `sinceMs` vira filtro em código, a página ainda
    // lê as linhas antigas). Sem org: o próprio `_creationTime` (≈ createdAt)
    // recorta a faixa no índice.
    const page = args.organizationId
      ? await ctx.db
          .query("messages")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId!))
          .paginate(paginationOpts)
      : sinceMs !== undefined
        ? await ctx.db
            .query("messages")
            .withIndex("by_creation_time", (q) => q.gte("_creationTime", sinceMs))
            .paginate(paginationOpts)
        : await ctx.db.query("messages").paginate(paginationOpts);

    let wouldWrite = 0;
    let written = 0;
    for (const message of page.page) {
      if (sinceMs !== undefined && message.createdAt < sinceMs) continue;
      const next = messageSearchNorm(message);
      if (next === message.searchNorm) continue;
      wouldWrite++;
      if (!dryRun) {
        await ctx.db.patch(message._id, { searchNorm: next });
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
      await ctx.scheduler.runAfter(0, internal.opsSearchFold.internalBackfillMessageSearchText, {
        dryRun,
        ...(args.countAll ? { countAll: true } : {}),
        cursor: page.continueCursor,
        pageSize,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        totals,
      });
    }
    if (page.isDone && (!dryRun || args.countAll)) {
      console.log(JSON.stringify({ op: "backfillMessageSearchText", dryRun, ...totals }));
    }
    return {
      dryRun,
      scanned: page.page.length,
      wouldWrite,
      written,
      skipped: page.page.length - wouldWrite,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
      scheduledNext: chain,
      totals,
    };
  },
});
