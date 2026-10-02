/**
 * Investimento em mídia (por dia/campanha) — módulo `attribution` do MVP
 * "Central". Alimenta ROAS/CAC do painel (`centralAnalytics`).
 *
 * Linha única por (data, plataforma, campanha normalizada, unidade): o upsert
 * e a importação de CSV colado substituem o valor em vez de duplicar.
 * Leitura: `reports:view` (lista VAZIA com o módulo desligado). Escrita:
 * `settings:manage` + módulo ligado.
 */
import { v, ConvexError } from "convex/values";
import { query, mutation, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { assertModule, getModules, normalizeCampaignKey } from "./lib/orgModules";
import { adSpendFields } from "./schema";

export const adSpendDocValidator = v.object({
  _id: v.id("adSpend"),
  _creationTime: v.number(),
  ...adSpendFields,
});

const MAX_IMPORT_ROWS = 1000;
const MAX_LIST_ROWS = 5000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const adSpendRowValidator = v.object({
  date: v.string(),
  platform: adSpendFields.platform,
  campaignName: v.string(),
  unitId: v.optional(v.id("units")),
  amount: v.number(),
  currency: v.optional(v.string()),
  impressions: v.optional(v.number()),
  clicks: v.optional(v.number()),
});

type AdSpendRow = {
  date: string;
  platform: Doc<"adSpend">["platform"];
  campaignName: string;
  unitId?: Id<"units">;
  amount: number;
  currency?: string;
  impressions?: number;
  clicks?: number;
};

function validateRow(row: AdSpendRow): string | null {
  if (!DATE_RE.test(row.date)) return `Data inválida "${row.date}" (use AAAA-MM-DD)`;
  if (!row.campaignName.trim()) return "Nome da campanha vazio";
  if (!Number.isFinite(row.amount) || row.amount < 0) return `Valor inválido na campanha "${row.campaignName}"`;
  return null;
}

/** Grava/atualiza uma linha; devolve id e se foi criada. */
export async function upsertRow(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  row: AdSpendRow,
  defaultCurrency: string,
  now: number
): Promise<{ id: Id<"adSpend">; created: boolean }> {
  const error = validateRow(row);
  if (error) throw new ConvexError(error);
  if (row.unitId) {
    const unit = await ctx.db.get(row.unitId);
    if (!unit || unit.organizationId !== organizationId) {
      throw new ConvexError("Unidade não pertence à organização");
    }
  }
  const campaignName = row.campaignName.trim();
  const campaignKey = normalizeCampaignKey(campaignName);
  const sameDay = await ctx.db
    .query("adSpend")
    .withIndex("by_organization_and_date", (q) =>
      q.eq("organizationId", organizationId).eq("date", row.date)
    )
    .take(500);
  const existing = sameDay.find(
    (r) =>
      r.platform === row.platform &&
      r.campaignKey === campaignKey &&
      (r.unitId ?? null) === (row.unitId ?? null)
  );
  const fields = {
    date: row.date,
    platform: row.platform,
    campaignName,
    campaignKey,
    ...(row.unitId ? { unitId: row.unitId } : {}),
    amount: row.amount,
    currency: row.currency ?? defaultCurrency,
    ...(row.impressions !== undefined ? { impressions: row.impressions } : {}),
    ...(row.clicks !== undefined ? { clicks: row.clicks } : {}),
  };
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    return { id: existing._id, created: false };
  }
  const id = await ctx.db.insert("adSpend", { organizationId, ...fields, createdAt: now });
  return { id, created: true };
}

export const listAdSpend = query({
  args: {
    organizationId: v.id("organizations"),
    from: v.string(), // YYYY-MM-DD (inclusive)
    to: v.string(), // YYYY-MM-DD (inclusive)
  },
  returns: v.array(adSpendDocValidator),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "reports", "view");
    if (!(await getModules(ctx, args.organizationId)).attribution) return [];
    return await ctx.db
      .query("adSpend")
      .withIndex("by_organization_and_date", (q) =>
        q.eq("organizationId", args.organizationId).gte("date", args.from).lte("date", args.to)
      )
      .take(MAX_LIST_ROWS);
  },
});

export const upsertAdSpend = mutation({
  args: { organizationId: v.id("organizations"), ...adSpendRowValidator.fields },
  returns: v.id("adSpend"),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await assertModule(ctx, args.organizationId, "attribution");
    const org = await ctx.db.get(args.organizationId);
    const { organizationId, ...row } = args;
    const now = Date.now();
    const result = await upsertRow(ctx, organizationId, row, org?.settings.currency ?? "BRL", now);
    await ctx.db.insert("auditLogs", {
      organizationId,
      entityType: "adSpend",
      entityId: result.id,
      action: result.created ? "create" : "update",
      actorId: member._id,
      actorType: "human",
      metadata: { date: row.date, campaignName: row.campaignName, amount: row.amount },
      description: `Registrou investimento de ${row.amount} em "${row.campaignName}" (${row.date})`,
      severity: "low",
      createdAt: now,
    });
    return result.id;
  },
});

/** Lote colado de CSV no front (já parseado). Tudo ou nada: uma linha ruim recusa o lote. */
export const importAdSpendRows = mutation({
  args: {
    organizationId: v.id("organizations"),
    rows: v.array(adSpendRowValidator),
  },
  returns: v.object({ created: v.number(), updated: v.number() }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await assertModule(ctx, args.organizationId, "attribution");
    if (args.rows.length === 0) return { created: 0, updated: 0 };
    if (args.rows.length > MAX_IMPORT_ROWS) {
      throw new ConvexError(`No máximo ${MAX_IMPORT_ROWS} linhas por importação`);
    }
    args.rows.forEach((row, i) => {
      const error = validateRow(row);
      if (error) throw new ConvexError(`Linha ${i + 1}: ${error}`);
    });
    const org = await ctx.db.get(args.organizationId);
    const currency = org?.settings.currency ?? "BRL";
    const now = Date.now();
    let created = 0;
    let updated = 0;
    for (const row of args.rows) {
      const result = await upsertRow(ctx, args.organizationId, row, currency, now);
      if (result.created) created++;
      else updated++;
    }
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "adSpend",
      entityId: args.organizationId,
      action: "create",
      actorId: member._id,
      actorType: "human",
      metadata: { rows: args.rows.length, created, updated },
      description: `Importou ${args.rows.length} linha(s) de investimento em mídia`,
      severity: "low",
      createdAt: now,
    });
    return { created, updated };
  },
});

export const deleteAdSpend = mutation({
  args: { adSpendId: v.id("adSpend") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.adSpendId);
    if (!row) throw new Error("Registro não encontrado");
    const member = await requirePermission(ctx, row.organizationId, "settings", "manage");
    await assertModule(ctx, row.organizationId, "attribution");
    await ctx.db.delete(args.adSpendId);
    await ctx.db.insert("auditLogs", {
      organizationId: row.organizationId,
      entityType: "adSpend",
      entityId: args.adSpendId,
      action: "delete",
      actorId: member._id,
      actorType: "human",
      metadata: { date: row.date, campaignName: row.campaignName, amount: row.amount },
      description: `Excluiu investimento de ${row.amount} em "${row.campaignName}" (${row.date})`,
      severity: "low",
      createdAt: Date.now(),
    });
    return null;
  },
});
