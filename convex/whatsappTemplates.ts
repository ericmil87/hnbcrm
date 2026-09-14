/**
 * Templates da Meta (Cloud API) — cache por canal, sincronizado sob demanda.
 * Criar/editar template continua no WhatsApp Manager (fora da v1).
 *
 * Também lê o tier do portfólio (`whatsapp_business_manager_messaging_limit`)
 * — o campo antigo `messaging_limit_tier` foi descontinuado em 07/10/2025.
 * Token NUNCA sai do servidor: só a action descriptografa.
 */
import { v, type ObjectType } from "convex/values";
import { query, action, internalQuery, internalMutation, QueryCtx, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  authorizeCampaigns,
  resolveActorMember,
  memberHasAny,
  type InternalActorArgs,
} from "./lib/campaignAuth";
import { decryptSecret } from "./lib/secretCrypto";
import { configProvider } from "./channelConfigs";

const GRAPH_API_BASE = "https://graph.facebook.com/v23.0";
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

export const listTemplatesArgs = { channelConfigId: v.id("channelConfigs"), onlyApproved: v.optional(v.boolean()) };
export type ListTemplatesArgs = ObjectType<typeof listTemplatesArgs> & InternalActorArgs;
export async function listTemplatesHandler(ctx: QueryCtx, args: ListTemplatesArgs) {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) return [];
    await authorizeCampaigns(ctx, config.organizationId, "view", args.actorMemberId);
    const rows = await ctx.db
      .query("whatsappTemplates")
      .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
      .collect();
    const filtered = args.onlyApproved ? rows.filter((r) => r.status === "APPROVED") : rows;
    return filtered
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({
        _id: r._id,
        metaId: r.metaId,
        name: r.name,
        language: r.language,
        category: r.category,
        status: r.status,
        qualityScore: r.qualityScore ?? null,
        components: r.components,
        syncedAt: r.syncedAt,
        bodyText: extractBodyText(r.components),
        headerFormat: extractHeaderFormat(r.components),
        bodyParamCount: countBodyParams(r.components),
        buttons: extractButtons(r.components),
      }));
  }
export const listTemplates = query({
  args: listTemplatesArgs,
  returns: v.any(),
  handler: listTemplatesHandler,
});

export function extractBodyText(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  const body = components.find((c) => c && typeof c === "object" && (c as { type?: string }).type === "BODY") as
    | { text?: string }
    | undefined;
  return body?.text ?? null;
}

export function extractHeaderFormat(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  const header = components.find((c) => c && typeof c === "object" && (c as { type?: string }).type === "HEADER") as
    | { format?: string }
    | undefined;
  return header?.format ?? null;
}

export function countBodyParams(components: unknown): number {
  const text = extractBodyText(components) ?? "";
  const matches = text.match(/\{\{\d+\}\}/g) ?? [];
  return new Set(matches).size;
}

export function extractButtons(components: unknown): Array<{ type: string; text: string; url?: string; dynamic?: boolean }> {
  if (!Array.isArray(components)) return [];
  const buttons = components.find((c) => c && typeof c === "object" && (c as { type?: string }).type === "BUTTONS") as
    | { buttons?: Array<{ type?: string; text?: string; url?: string }> }
    | undefined;
  return (buttons?.buttons ?? []).map((b) => ({
    type: b.type ?? "QUICK_REPLY",
    text: b.text ?? "",
    ...(b.url ? { url: b.url, dynamic: /\{\{\d+\}\}/.test(b.url) } : {}),
  }));
}

async function requireTemplateManager(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  actorMemberId?: Id<"teamMembers">
) {
  const member = await resolveActorMember(ctx, organizationId, actorMemberId);
  if (!memberHasAny(member, [{ category: "campaigns", level: "manage" }, { category: "settings", level: "manage" }])) {
    throw new Error("Permissão insuficiente");
  }
  return member;
}

export const internalTemplateSyncContext = internalQuery({
  args: { channelConfigId: v.id("channelConfigs"), actorMemberId: v.optional(v.id("teamMembers")) },
  returns: v.object({
    organizationId: v.id("organizations"),
    wabaId: v.string(),
    phoneNumberId: v.string(),
    accessTokenEncrypted: v.string(),
  }),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) throw new Error("Canal não encontrado");
    await requireTemplateManager(ctx, config.organizationId, args.actorMemberId);
    if (configProvider(config) !== "meta") throw new Error("Templates existem só no canal oficial (Meta)");
    if (!config.wabaId || !config.accessTokenEncrypted || !config.phoneNumberId) {
      throw new Error("Canal Meta incompleto — informe WABA ID e token em Configurações → Canais");
    }
    return {
      organizationId: config.organizationId,
      wabaId: config.wabaId,
      phoneNumberId: config.phoneNumberId,
      accessTokenEncrypted: config.accessTokenEncrypted,
    };
  },
});

export const syncMetaTemplatesArgs = { channelConfigId: v.id("channelConfigs") };
export type SyncMetaTemplatesArgs = ObjectType<typeof syncMetaTemplatesArgs> & InternalActorArgs;
export async function syncMetaTemplatesHandler(ctx: ActionCtx, args: SyncMetaTemplatesArgs): Promise<{ synced: number; removed: number; approved: number }> {
    const context = await ctx.runQuery(internal.whatsappTemplates.internalTemplateSyncContext, {
      channelConfigId: args.channelConfigId,
      actorMemberId: args.actorMemberId,
    });
    const token = await decryptSecret(context.accessTokenEncrypted);
    const templates: Array<Record<string, unknown>> = [];
    let url: string | null =
      `${GRAPH_API_BASE}/${context.wabaId}/message_templates?fields=id,name,status,category,language,quality_score,components&limit=${PAGE_LIMIT}`;
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const body = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `Meta respondeu HTTP ${res.status} ao listar templates`);
      }
      for (const t of body.data ?? []) templates.push(t);
      url = typeof body?.paging?.next === "string" ? body.paging.next : null;
    }
    const result = await ctx.runMutation(internal.whatsappTemplates.internalUpsertTemplates, {
      channelConfigId: args.channelConfigId,
      templates: templates.map((t) => ({
        metaId: String(t.id ?? ""),
        name: String(t.name ?? ""),
        language: String(t.language ?? ""),
        category: String(t.category ?? ""),
        status: String(t.status ?? ""),
        qualityScore: qualityOf(t.quality_score),
        components: t.components ?? [],
      })),
    });
    return result;
  }
export const syncMetaTemplates = action({
  args: syncMetaTemplatesArgs,
  returns: v.object({ synced: v.number(), removed: v.number(), approved: v.number() }),
  handler: syncMetaTemplatesHandler,
});

function qualityOf(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw && typeof (raw as { score?: unknown }).score === "string") {
    return (raw as { score: string }).score;
  }
  return undefined;
}

export const internalUpsertTemplates = internalMutation({
  args: {
    channelConfigId: v.id("channelConfigs"),
    templates: v.array(
      v.object({
        metaId: v.string(),
        name: v.string(),
        language: v.string(),
        category: v.string(),
        status: v.string(),
        qualityScore: v.optional(v.string()),
        components: v.any(),
      })
    ),
  },
  returns: v.object({ synced: v.number(), removed: v.number(), approved: v.number() }),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) throw new Error("Canal não encontrado");
    const now = Date.now();
    const existing = await ctx.db
      .query("whatsappTemplates")
      .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
      .collect();
    const byMetaId = new Map(existing.map((r) => [r.metaId, r]));
    const seen = new Set<string>();
    let approved = 0;
    for (const t of args.templates) {
      if (!t.metaId || !t.name) continue;
      seen.add(t.metaId);
      if (t.status === "APPROVED") approved++;
      const row = byMetaId.get(t.metaId);
      const doc = {
        organizationId: config.organizationId,
        channelConfigId: args.channelConfigId,
        metaId: t.metaId,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        qualityScore: t.qualityScore,
        components: t.components,
        syncedAt: now,
      };
      if (row) await ctx.db.patch(row._id, doc);
      else await ctx.db.insert("whatsappTemplates", doc);
    }
    let removed = 0;
    for (const row of existing) {
      if (!seen.has(row.metaId)) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    return { synced: seen.size, removed, approved };
  },
});

/** Tier do portfólio da Meta (ex.: "TIER_250"). Chamado pela UI antes de lançar. */
export const readMetaTierArgs = { channelConfigId: v.id("channelConfigs") };
export type ReadMetaTierArgs = ObjectType<typeof readMetaTierArgs> & InternalActorArgs;
export async function readMetaTierHandler(ctx: ActionCtx, args: ReadMetaTierArgs): Promise<{ tier: string; limit: number | null }> {
    const context = await ctx.runQuery(internal.whatsappTemplates.internalTemplateSyncContext, {
      channelConfigId: args.channelConfigId,
      actorMemberId: args.actorMemberId,
    });
    const token = await decryptSecret(context.accessTokenEncrypted);
    const res = await fetch(
      `${GRAPH_API_BASE}/${context.phoneNumberId}?fields=whatsapp_business_manager_messaging_limit`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      throw new Error(body?.error?.message ?? `Meta respondeu HTTP ${res.status} ao ler o limite`);
    }
    const tier = String(body.whatsapp_business_manager_messaging_limit ?? "unknown");
    const limits: Record<string, number | null> = {
      TIER_250: 250,
      TIER_2K: 2000,
      TIER_10K: 10000,
      TIER_100K: 100000,
      TIER_UNLIMITED: null,
    };
    return { tier, limit: tier in limits ? limits[tier] : null };
  }
export const readMetaTier = action({
  args: readMetaTierArgs,
  returns: v.object({ tier: v.string(), limit: v.union(v.number(), v.null()) }),
  handler: readMetaTierHandler,
});
