/**
 * Campanhas de WhatsApp (disparo em massa) — API pública.
 * Plano: docs/CAMPANHAS-WHATSAPP-PLAN.md. Worker: campaignWorker.ts.
 *
 * RBAC (categoria `campaigns`): view = ler; manage = criar/editar/pausar/
 * retomar/público; full = lançar, cancelar, excluir, override de tetos.
 * Lançar é SEMPRE humano (o copiloto só rascunha).
 */
import { v, type ObjectType } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  query,
  mutation,
  action,
  internalMutation,
  internalQuery,
  QueryCtx,
  MutationCtx,
  ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { authorizeCampaigns, viaMeta, type InternalActorArgs } from "./lib/campaignAuth";
import { configProvider } from "./channelConfigs";
import {
  campaignPacingValidator,
  campaignScheduleValidator,
  campaignVariantValidator,
  campaignTemplateParamValidator,
  campaignAudienceFiltersValidator,
  campaignStatusValidator,
  campaignRecipientStatusValidator,
} from "./schema";
import {
  safeDefaultsFor,
  clampToHardCap,
  isWithinSafeDefaults,
  warmupDayFor,
  BRIDGE_HARD_CAP,
  tierLimit,
  type CampaignPacing,
} from "./lib/campaignPacing";
import { containsLink, extractVars } from "./lib/campaignRender";
import { resolveSegmentAudience, isPhoneSuppressed, contactDisplayName, contactVars } from "./lib/campaignAudience";
import { normalizeCampaignPhone } from "./lib/phone";
import { parseCsv } from "./lib/csv";
import { estimateCampaignCost, loadPricing } from "./lib/whatsappPricing";
import {
  addTimeline,
  pauseCampaignCore,
  scheduleCampaignTick,
  transitionRecipient,
} from "./lib/campaignHooks";

const SNAPSHOT_BATCH_LEADS = 400;
const MANUAL_CHUNK = 500;
const IMPORT_BATCH = 200;
const MAX_CSV_BYTES = 5 * 1024 * 1024;
const MIN_VARIANTS_BRIDGE_ABOVE = 30;

// ── Validators locais ──

const contentValidator = v.object({
  kind: v.union(v.literal("text"), v.literal("template")),
  variants: v.array(campaignVariantValidator),
  contentType: v.optional(
    v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))
  ),
  template: v.optional(
    v.object({
      name: v.string(),
      language: v.string(),
      category: v.optional(v.string()),
      headerFileId: v.optional(v.id("files")),
      headerFormat: v.optional(v.string()),
      bodyParams: v.optional(v.array(campaignTemplateParamValidator)),
      headerParams: v.optional(v.array(campaignTemplateParamValidator)),
      buttonParams: v.optional(v.array(campaignTemplateParamValidator)),
      bodyText: v.optional(v.string()),
    })
  ),
});

const audienceValidator = v.object({
  source: v.union(v.literal("segment"), v.literal("import"), v.literal("manual")),
  filters: v.optional(campaignAudienceFiltersValidator),
  importFileId: v.optional(v.id("files")),
  targetBoardId: v.optional(v.id("boards")),
  targetStageId: v.optional(v.id("stages")),
  targetTags: v.optional(v.array(v.string())),
});

const safetyValidator = v.object({
  checkNumbersFirst: v.optional(v.boolean()),
  allowLinks: v.optional(v.boolean()),
  stopOnReplyRateBelow: v.optional(v.union(v.number(), v.null())),
  stopOnDeliveryRateBelow: v.optional(v.union(v.number(), v.null())),
  minSampleForKillSwitch: v.optional(v.number()),
  maxConsecutiveFailures: v.optional(v.number()),
});

const emptyStats = () => ({
  total: 0,
  pending: 0,
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  replied: 0,
  failed: 0,
  skipped: 0,
  optedOut: 0,
  consecutiveFailures: 0,
});

// ── Helpers ──

/**
 * Chamada sem sessão (REST via API key, copiloto, MCP): o ator vem por
 * `actorMemberId`. As funções PÚBLICAS nunca aceitam esse campo (não está no
 * validator delas) — só os wrappers `internal*` de campaignsInternal.ts.
 * `via` marca a auditoria ("api" | "copilot").
 */
export type { InternalActorArgs };
const authorize = authorizeCampaigns;

async function getCampaignInOrg(
  ctx: QueryCtx | MutationCtx,
  campaignId: Id<"campaigns">,
  organizationId?: Id<"organizations">
): Promise<Doc<"campaigns">> {
  const campaign = await ctx.db.get(campaignId);
  if (!campaign) throw new Error("Campanha não encontrada");
  if (organizationId && campaign.organizationId !== organizationId) {
    throw new Error("Campanha não encontrada");
  }
  return campaign;
}

async function getChannelInOrg(
  ctx: QueryCtx | MutationCtx,
  channelConfigId: Id<"channelConfigs">,
  organizationId: Id<"organizations">
): Promise<Doc<"channelConfigs">> {
  const config = await ctx.db.get(channelConfigId);
  if (!config || config.organizationId !== organizationId || config.channel !== "whatsapp") {
    throw new Error("Canal WhatsApp não encontrado nesta organização");
  }
  return config;
}

function channelAgeDay(config: Doc<"channelConfigs">, now: number): number {
  return warmupDayFor(config.bridgeConnectedAt ?? config.createdAt, now);
}

function channelSummary(config: Doc<"channelConfigs"> | null) {
  if (!config) return null;
  return {
    _id: config._id,
    displayName: config.displayName,
    provider: configProvider(config),
    displayPhoneNumber: config.displayPhoneNumber ?? null,
    status: config.status,
    bridgeSessionState: config.bridgeSessionState ?? null,
    connectedAt: config.bridgeConnectedAt ?? config.createdAt,
  };
}

function defaultSchedule(timezone: string) {
  return { timezone, windowStartHour: 9, windowEndHour: 20, days: [1, 2, 3, 4, 5] };
}

function defaultSafety(provider: "meta" | "bridge") {
  return provider === "bridge"
    ? {
        checkNumbersFirst: true,
        allowLinks: false,
        stopOnReplyRateBelow: 0.1,
        stopOnDeliveryRateBelow: 0.6,
        maxConsecutiveFailures: 5,
      }
    : { checkNumbersFirst: false, allowLinks: true, maxConsecutiveFailures: 5 };
}

function cleanSafety(
  input: {
    checkNumbersFirst?: boolean;
    allowLinks?: boolean;
    stopOnReplyRateBelow?: number | null;
    stopOnDeliveryRateBelow?: number | null;
    minSampleForKillSwitch?: number;
    maxConsecutiveFailures?: number;
  },
  base: Doc<"campaigns">["safety"]
): Doc<"campaigns">["safety"] {
  const next: Doc<"campaigns">["safety"] = { ...base };
  if (input.checkNumbersFirst !== undefined) next.checkNumbersFirst = input.checkNumbersFirst;
  if (input.allowLinks !== undefined) next.allowLinks = input.allowLinks;
  if (input.stopOnReplyRateBelow !== undefined) {
    next.stopOnReplyRateBelow = input.stopOnReplyRateBelow === null ? undefined : clamp01(input.stopOnReplyRateBelow);
  }
  if (input.stopOnDeliveryRateBelow !== undefined) {
    next.stopOnDeliveryRateBelow =
      input.stopOnDeliveryRateBelow === null ? undefined : clamp01(input.stopOnDeliveryRateBelow);
  }
  if (input.minSampleForKillSwitch !== undefined) {
    next.minSampleForKillSwitch = Math.max(1, Math.floor(input.minSampleForKillSwitch));
  }
  if (input.maxConsecutiveFailures !== undefined) {
    next.maxConsecutiveFailures = Math.max(0, Math.floor(input.maxConsecutiveFailures));
  }
  return next;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function validateSchedule(s: { windowStartHour: number; windowEndHour: number; days: number[]; startAt?: number }) {
  if (!Number.isInteger(s.windowStartHour) || s.windowStartHour < 0 || s.windowStartHour > 23) {
    throw new Error("Hora inicial da janela deve estar entre 0 e 23");
  }
  if (!Number.isInteger(s.windowEndHour) || s.windowEndHour < 1 || s.windowEndHour > 24) {
    throw new Error("Hora final da janela deve estar entre 1 e 24");
  }
  if (s.windowEndHour <= s.windowStartHour) throw new Error("A janela precisa terminar depois de começar");
  if (s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error("Dias da semana inválidos");
  }
}

function validateContent(content: Doc<"campaigns">["content"], provider: "meta" | "bridge") {
  if (content.kind === "template") {
    if (provider !== "meta") throw new Error("Templates são exclusivos da WhatsApp Cloud API oficial (canal Meta)");
    if (!content.template?.name || !content.template.language) {
      throw new Error("Escolha um template aprovado e o idioma");
    }
  } else {
    const variants = content.variants.filter((vr) => vr.text.trim() || (vr.attachmentFileIds?.length ?? 0) > 0);
    if (variants.length === 0) throw new Error("A mensagem precisa de pelo menos uma variante com texto ou mídia");
  }
}

async function assertFilesInOrg(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  fileIds: Id<"files">[]
) {
  for (const fileId of fileIds) {
    const file = await ctx.db.get(fileId);
    if (!file || file.organizationId !== organizationId) throw new Error("Anexo não pertence a esta organização");
  }
}

function contentFileIds(content: Doc<"campaigns">["content"]): Id<"files">[] {
  const ids: Id<"files">[] = [];
  for (const vr of content.variants) for (const id of vr.attachmentFileIds ?? []) ids.push(id);
  if (content.template?.headerFileId) ids.push(content.template.headerFileId);
  return ids;
}

async function audit(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  args: {
    actorId: Id<"teamMembers">;
    action: "create" | "update" | "delete";
    description: string;
    severity: "low" | "medium" | "high";
    changes?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
    metadata?: Record<string, unknown>;
  },
  now: number
) {
  await ctx.db.insert("auditLogs", {
    organizationId: campaign.organizationId,
    entityType: "campaign",
    entityId: campaign._id,
    action: args.action,
    actorId: args.actorId,
    actorType: "human",
    changes: args.changes,
    metadata: { campaign: true, name: campaign.name, ...(args.metadata ?? {}) },
    description: args.description,
    severity: args.severity,
    createdAt: now,
  });
}

// ── Leitura ──

export const listCampaignsArgs = {
    organizationId: v.id("organizations"),
    status: v.optional(campaignStatusValidator),
  };
export type ListCampaignsArgs = ObjectType<typeof listCampaignsArgs> & InternalActorArgs;
export async function listCampaignsHandler(ctx: QueryCtx, args: ListCampaignsArgs) {
    await authorize(ctx, args.organizationId, "view", args.actorMemberId);
    const rows = args.status
      ? await ctx.db
          .query("campaigns")
          .withIndex("by_organization_and_status", (q) =>
            q.eq("organizationId", args.organizationId).eq("status", args.status!)
          )
          .order("desc")
          .take(200)
      : await ctx.db
          .query("campaigns")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
          .order("desc")
          .take(200);
    const out = [];
    for (const c of rows) {
      const config = await ctx.db.get(c.channelConfigId);
      const creator = await ctx.db.get(c.createdBy);
      out.push({
        _id: c._id,
        name: c.name,
        description: c.description ?? null,
        status: c.status,
        provider: c.provider,
        contentKind: c.content.kind,
        channel: channelSummary(config),
        creatorName: creator?.name ?? null,
        stats: c.stats,
        pausedReason: c.pausedReason ?? null,
        audienceSource: c.audience.source,
        startedAt: c.startedAt ?? null,
        completedAt: c.completedAt ?? null,
        scheduledStartAt: c.schedule.startAt ?? null,
        nextTickAt: c.nextTickAt ?? null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      });
    }
    return out;
  }
export const listCampaigns = query({
  args: listCampaignsArgs,
  returns: v.any(),
  handler: listCampaignsHandler,
});

export const getCampaignArgs = { campaignId: v.id("campaigns") };
export type GetCampaignArgs = ObjectType<typeof getCampaignArgs> & InternalActorArgs;
export async function getCampaignHandler(ctx: QueryCtx, args: GetCampaignArgs) {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) return null;
    await authorize(ctx, campaign.organizationId, "view", args.actorMemberId);
    const config = await ctx.db.get(campaign.channelConfigId);
    const creator = await ctx.db.get(campaign.createdBy);
    const targetBoard = campaign.audience.targetBoardId ? await ctx.db.get(campaign.audience.targetBoardId) : null;
    const targetStage = campaign.audience.targetStageId ? await ctx.db.get(campaign.audience.targetStageId) : null;
    return {
      ...campaign,
      channel: channelSummary(config),
      creatorName: creator?.name ?? null,
      targetBoardName: targetBoard?.name ?? null,
      targetStageName: targetStage?.name ?? null,
    };
  }
export const getCampaign = query({
  args: getCampaignArgs,
  returns: v.any(),
  handler: getCampaignHandler,
});

/** Defaults seguros para o canal (wizard, passo Limites). */
export const getSafeDefaultsArgs = {
    channelConfigId: v.id("channelConfigs"),
    tier: v.optional(v.string()),
    // Sem Date.now() em query: o cliente manda o "agora" (só afeta a idade do número)
    now: v.number(),
  };
export type GetSafeDefaultsArgs = ObjectType<typeof getSafeDefaultsArgs> & InternalActorArgs;
export async function getSafeDefaultsHandler(ctx: QueryCtx, args: GetSafeDefaultsArgs) {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config) throw new Error("Canal não encontrado");
    await authorize(ctx, config.organizationId, "view", args.actorMemberId);
    const provider = configProvider(config);
    const warmupDay = channelAgeDay(config, args.now);
    const safe = safeDefaultsFor({ provider, warmupDay, tier: args.tier });
    const org = await ctx.db.get(config.organizationId);
    const orgDefaults = org?.settings.campaignDefaults;
    return {
      provider,
      warmupDay,
      connectedAt: config.bridgeConnectedAt ?? config.createdAt,
      safe: safe.pacing,
      orgDefaults: orgDefaults ?? null,
      hardCap:
        provider === "bridge"
          ? { ...BRIDGE_HARD_CAP }
          : { maxPerDay: tierLimit(args.tier), maxPerHour: tierLimit(args.tier), minDelaySec: 0, maxNewContactsPerDay: null },
      newNumberRisk: safe.newNumberRisk ?? null,
      warmupWarning: safe.warmupWarning ?? null,
      tier: safe.tier ?? null,
      schedule: defaultSchedule(org?.settings.timezone ?? "America/Sao_Paulo"),
      safety: defaultSafety(provider),
    };
  }
export const getSafeDefaults = query({
  args: getSafeDefaultsArgs,
  returns: v.any(),
  handler: getSafeDefaultsHandler,
});

export const getCampaignRecipientsArgs = {
    campaignId: v.id("campaigns"),
    paginationOpts: paginationOptsValidator,
    status: v.optional(campaignRecipientStatusValidator),
    search: v.optional(v.string()),
  };
export type GetCampaignRecipientsArgs = ObjectType<typeof getCampaignRecipientsArgs> & InternalActorArgs;
export async function getCampaignRecipientsHandler(ctx: QueryCtx, args: GetCampaignRecipientsArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    await authorize(ctx, campaign.organizationId, "view", args.actorMemberId);
    const search = args.search?.trim().toLowerCase();
    if (search) {
      // Busca simples: varre até 2000 e filtra (v1)
      const rows = args.status
        ? await ctx.db
            .query("campaignRecipients")
            .withIndex("by_campaign_and_status", (q) =>
              q.eq("campaignId", args.campaignId).eq("status", args.status!)
            )
            .take(2000)
        : await ctx.db
            .query("campaignRecipients")
            .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
            .take(2000);
      const digits = search.replace(/\D+/g, "");
      const page = rows
        .filter(
          (r) =>
            (digits && r.phone.includes(digits)) ||
            (r.displayName ?? "").toLowerCase().includes(search)
        )
        .slice(0, args.paginationOpts.numItems);
      return { page, isDone: true, continueCursor: "" };
    }
    if (args.status) {
      return await ctx.db
        .query("campaignRecipients")
        .withIndex("by_campaign_and_status", (q) =>
          q.eq("campaignId", args.campaignId).eq("status", args.status!)
        )
        .order("desc")
        .paginate(args.paginationOpts);
    }
    return await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .order("desc")
      .paginate(args.paginationOpts);
  }
export const getCampaignRecipients = query({
  args: getCampaignRecipientsArgs,
  returns: v.any(),
  handler: getCampaignRecipientsHandler,
});

export const getCampaignsForLead = query({
  args: { leadId: v.id("leads") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return [];
    await requirePermission(ctx, lead.organizationId, "campaigns", "view");
    const rows = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_lead", (q) => q.eq("leadId", args.leadId))
      .order("desc")
      .take(50);
    const out = [];
    for (const r of rows) {
      if (r.organizationId !== lead.organizationId) continue;
      const campaign = await ctx.db.get(r.campaignId);
      if (!campaign) continue;
      out.push({
        recipientId: r._id,
        campaignId: r.campaignId,
        campaignName: campaign.name,
        campaignStatus: campaign.status,
        provider: campaign.provider,
        status: r.status,
        sentAt: r.sentAt ?? null,
        deliveredAt: r.deliveredAt ?? null,
        readAt: r.readAt ?? null,
        repliedAt: r.repliedAt ?? null,
        lastError: r.lastError ?? null,
        conversationId: r.conversationId ?? null,
        createdAt: r.createdAt,
      });
    }
    return out;
  },
});

export const getCampaignReportArgs = { campaignId: v.id("campaigns") };
export type GetCampaignReportArgs = ObjectType<typeof getCampaignReportArgs> & InternalActorArgs;
export async function getCampaignReportHandler(ctx: QueryCtx, args: GetCampaignReportArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    await authorize(ctx, campaign.organizationId, "view", args.actorMemberId);
    const s = campaign.stats;
    const dispatched = s.sent + s.delivered + s.read + s.replied;
    const delivered = s.delivered + s.read + s.replied;
    const readCount = s.read + s.replied;
    const attempted = dispatched + s.failed + s.optedOut;
    const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
    // Quebra de erros (amostra até 1000 falhas)
    const failed = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", args.campaignId).eq("status", "failed"))
      .take(1000);
    const errorBreakdown: Record<string, number> = {};
    for (const r of failed) {
      const key = r.errorCode ? String(r.errorCode) : r.skipReason ?? "outro";
      errorBreakdown[key] = (errorBreakdown[key] ?? 0) + 1;
    }
    const skipped = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", args.campaignId).eq("status", "skipped"))
      .take(1000);
    const skipBreakdown: Record<string, number> = {};
    for (const r of skipped) {
      const key = r.skipReason ?? "outro";
      skipBreakdown[key] = (skipBreakdown[key] ?? 0) + 1;
    }
    return {
      campaignId: campaign._id,
      name: campaign.name,
      status: campaign.status,
      provider: campaign.provider,
      stats: s,
      dispatched,
      attempted,
      rates: {
        delivered: rate(delivered, dispatched),
        read: rate(readCount, dispatched),
        replied: rate(s.replied, dispatched),
        failed: rate(s.failed, attempted),
        optedOut: rate(s.optedOut, attempted),
      },
      errorBreakdown,
      skipBreakdown,
      estimatedCostUsd: s.estimatedCostUsd ?? null,
      tierAtLaunch: campaign.tierAtLaunch ?? null,
      templateQualityAtLaunch: campaign.templateQualityAtLaunch ?? null,
      timeline: campaign.timeline ?? [],
      pausedReason: campaign.pausedReason ?? null,
      startedAt: campaign.startedAt ?? null,
      completedAt: campaign.completedAt ?? null,
      progress: s.total > 0 ? Math.round(((s.total - s.pending - s.queued) / s.total) * 1000) / 10 : 0,
    };
  }
export const getCampaignReport = query({
  args: getCampaignReportArgs,
  returns: v.any(),
  handler: getCampaignReportHandler,
});

/** Contador ao vivo + amostra do segmento (passo Público do wizard). */
export const previewAudienceArgs = {
    organizationId: v.id("organizations"),
    filters: campaignAudienceFiltersValidator,
    now: v.number(),
  };
export type PreviewAudienceArgs = ObjectType<typeof previewAudienceArgs> & InternalActorArgs;
export async function previewAudienceHandler(ctx: QueryCtx, args: PreviewAudienceArgs) {
    await authorize(ctx, args.organizationId, "manage", args.actorMemberId);
    const result = await resolveSegmentAudience(ctx, {
      organizationId: args.organizationId,
      filters: args.filters,
      now: args.now,
      scanLimit: 3000,
    });
    return {
      count: result.candidates.length,
      sample: result.candidates.slice(0, 10).map((c) => ({
        leadId: c.leadId,
        contactId: c.contactId,
        phone: c.phone,
        displayName: c.displayName ?? null,
        vars: c.vars,
      })),
      excluded: result.excluded,
      scanned: result.scanned,
      truncated: result.truncated,
    };
  }
export const previewAudience = query({
  args: previewAudienceArgs,
  returns: v.any(),
  handler: previewAudienceHandler,
});

// ── Escrita ──

export const createCampaignArgs = {
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    channelConfigId: v.id("channelConfigs"),
    content: contentValidator,
    audience: audienceValidator,
    schedule: v.optional(campaignScheduleValidator),
    pacing: v.optional(campaignPacingValidator),
    safeMode: v.optional(v.boolean()),
    safety: v.optional(safetyValidator),
  };
export type CreateCampaignArgs = ObjectType<typeof createCampaignArgs> & InternalActorArgs;
export async function createCampaignHandler(ctx: MutationCtx, args: CreateCampaignArgs) {
    const member = await authorize(ctx, args.organizationId, "manage", args.actorMemberId);
    const name = args.name.trim();
    if (!name) throw new Error("Dê um nome à campanha");
    const config = await getChannelInOrg(ctx, args.channelConfigId, args.organizationId);
    const provider = configProvider(config);
    validateContent(args.content, provider);
    await assertFilesInOrg(ctx, args.organizationId, contentFileIds(args.content));
    if (args.audience.targetBoardId) {
      const board = await ctx.db.get(args.audience.targetBoardId);
      if (!board || board.organizationId !== args.organizationId) throw new Error("Funil de destino não encontrado");
      if (args.audience.targetStageId) {
        const stage = await ctx.db.get(args.audience.targetStageId);
        if (!stage || stage.boardId !== board._id) throw new Error("Estágio de destino não pertence ao funil escolhido");
      }
    }
    const org = await ctx.db.get(args.organizationId);
    const now = Date.now();
    const schedule = args.schedule ?? defaultSchedule(org?.settings.timezone ?? "America/Sao_Paulo");
    validateSchedule(schedule);
    const safe = safeDefaultsFor({ provider, warmupDay: channelAgeDay(config, now) });
    const basePacing = org?.settings.campaignDefaults ?? safe.pacing;
    const pacing = clampToHardCap(args.pacing ?? basePacing, provider);
    const safeMode = args.safeMode ?? isWithinSafeDefaults(pacing, safe.pacing);
    const safety = cleanSafety(args.safety ?? {}, defaultSafety(provider));

    const campaignId = await ctx.db.insert("campaigns", {
      organizationId: args.organizationId,
      name,
      description: args.description?.trim() || undefined,
      status: "draft",
      channelConfigId: config._id,
      provider,
      content: args.content,
      audience: args.audience,
      schedule,
      pacing,
      safeMode,
      safety,
      stats: emptyStats(),
      timeline: [{ at: now, kind: "created", actorId: member._id }],
      createdBy: member._id,
      createdAt: now,
      updatedAt: now,
    });
    const campaign = (await ctx.db.get(campaignId))!;
    await audit(
      ctx,
      campaign,
      { actorId: member._id, action: "create", description: `Criou a campanha «${name}» (rascunho)`, severity: "medium", metadata: viaMeta(args.via) },
      now
    );
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "campaign.created",
      payload: { campaignId, name, provider, channelConfigId: config._id },
    });
    return campaignId;
  }
export const createCampaign = mutation({
  args: createCampaignArgs,
  returns: v.id("campaigns"),
  handler: createCampaignHandler,
});

export const updateCampaignArgs = {
    campaignId: v.id("campaigns"),
    patch: v.object({
      name: v.optional(v.string()),
      description: v.optional(v.union(v.string(), v.null())),
      channelConfigId: v.optional(v.id("channelConfigs")),
      content: v.optional(contentValidator),
      audience: v.optional(audienceValidator),
      schedule: v.optional(campaignScheduleValidator),
      pacing: v.optional(campaignPacingValidator),
      safeMode: v.optional(v.boolean()),
      safety: v.optional(safetyValidator),
    }),
  };
export type UpdateCampaignArgs = ObjectType<typeof updateCampaignArgs> & InternalActorArgs;
export async function updateCampaignHandler(ctx: MutationCtx, args: UpdateCampaignArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    const member = await authorize(ctx, campaign.organizationId, "manage", args.actorMemberId);
    const editableAll = campaign.status === "draft";
    const editableLimits = campaign.status === "paused" || campaign.status === "scheduled";
    if (!editableAll && !editableLimits) {
      throw new Error("Só rascunhos podem ser editados (pausada: apenas limites, agenda e segurança)");
    }
    const p = args.patch;
    const now = Date.now();
    const next: Partial<Doc<"campaigns">> = { updatedAt: now };

    if (!editableAll) {
      if (p.name !== undefined || p.channelConfigId !== undefined || p.content !== undefined || p.audience !== undefined) {
        throw new Error("Com a campanha pausada só é possível alterar limites, agenda e segurança");
      }
    }
    let config = await ctx.db.get(campaign.channelConfigId);
    if (p.channelConfigId !== undefined) {
      config = await getChannelInOrg(ctx, p.channelConfigId, campaign.organizationId);
      next.channelConfigId = config._id;
      next.provider = configProvider(config);
    }
    const provider = next.provider ?? campaign.provider;
    if (p.name !== undefined) {
      const name = p.name.trim();
      if (!name) throw new Error("Dê um nome à campanha");
      next.name = name;
    }
    if (p.description !== undefined) next.description = p.description?.trim() || undefined;
    if (p.content !== undefined) {
      validateContent(p.content, provider);
      await assertFilesInOrg(ctx, campaign.organizationId, contentFileIds(p.content));
      next.content = p.content;
    } else if (p.channelConfigId !== undefined) {
      validateContent(campaign.content, provider);
    }
    if (p.audience !== undefined) {
      if (p.audience.targetBoardId) {
        const board = await ctx.db.get(p.audience.targetBoardId);
        if (!board || board.organizationId !== campaign.organizationId) throw new Error("Funil de destino não encontrado");
        if (p.audience.targetStageId) {
          const stage = await ctx.db.get(p.audience.targetStageId);
          if (!stage || stage.boardId !== board._id) throw new Error("Estágio de destino não pertence ao funil escolhido");
        }
      }
      // Trocar a fonte do público invalida destinatários manuais/importados já adicionados
      if (p.audience.source !== campaign.audience.source && campaign.stats.total > 0) {
        throw new Error("A campanha já tem destinatários — remova-os antes de trocar a fonte do público");
      }
      next.audience = { ...p.audience, snapshotAt: campaign.audience.snapshotAt, total: campaign.audience.total };
    }
    if (p.schedule !== undefined) {
      validateSchedule(p.schedule);
      next.schedule = p.schedule;
    }
    if (p.pacing !== undefined) {
      next.pacing = clampToHardCap(p.pacing, provider, campaign.tierAtLaunch);
    }
    if (p.safeMode !== undefined) next.safeMode = p.safeMode;
    if (p.safety !== undefined) next.safety = cleanSafety(p.safety, campaign.safety);

    await ctx.db.patch(campaign._id, next);
    await audit(
      ctx,
      { ...campaign, ...next } as Doc<"campaigns">,
      {
        actorId: member._id,
        action: "update",
        description: `Atualizou a campanha «${next.name ?? campaign.name}»`,
        severity: "low",
        changes: { after: Object.keys(p).reduce((acc, k) => ({ ...acc, [k]: true }), {}) },
      },
      now
    );
    return null;
  }
export const updateCampaign = mutation({
  args: updateCampaignArgs,
  returns: v.null(),
  handler: updateCampaignHandler,
});

export const duplicateCampaignArgs = { campaignId: v.id("campaigns") };
export type DuplicateCampaignArgs = ObjectType<typeof duplicateCampaignArgs> & InternalActorArgs;
export async function duplicateCampaignHandler(ctx: MutationCtx, args: DuplicateCampaignArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    const member = await authorize(ctx, campaign.organizationId, "manage", args.actorMemberId);
    const now = Date.now();
    const { _id: _i, _creationTime: _c, ...rest } = campaign;
    const id = await ctx.db.insert("campaigns", {
      ...rest,
      name: `${campaign.name} (cópia)`,
      status: "draft",
      audience: { ...campaign.audience, snapshotAt: undefined, total: undefined },
      stats: emptyStats(),
      timeline: [{ at: now, kind: "created", detail: `Duplicada de «${campaign.name}»`, actorId: member._id }],
      overrideAck: undefined,
      safety: { ...campaign.safety, consentAck: undefined, bridgeRiskAck: undefined, newNumberRiskAck: undefined },
      pausedReason: undefined,
      pausedBy: undefined,
      lastError: undefined,
      tierAtLaunch: undefined,
      templateQualityAtLaunch: undefined,
      schedulerFnId: undefined,
      nextTickAt: undefined,
      tickToken: undefined,
      batchSentSinceLastPause: undefined,
      snapshotOffset: undefined,
      startedAt: undefined,
      completedAt: undefined,
      createdBy: member._id,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }
export const duplicateCampaign = mutation({
  args: duplicateCampaignArgs,
  returns: v.id("campaigns"),
  handler: duplicateCampaignHandler,
});

export const deleteCampaignArgs = { campaignId: v.id("campaigns") };
export type DeleteCampaignArgs = ObjectType<typeof deleteCampaignArgs> & InternalActorArgs;
export async function deleteCampaignHandler(ctx: MutationCtx, args: DeleteCampaignArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    const member = await authorize(ctx, campaign.organizationId, "full", args.actorMemberId);
    if (!["draft", "canceled", "completed", "failed"].includes(campaign.status)) {
      throw new Error("Cancele a campanha antes de excluí-la");
    }
    const now = Date.now();
    // Apaga destinatários em lotes (job re-agendado); a campanha some por último
    await ctx.db.patch(campaign._id, { status: "canceled", updatedAt: now });
    await audit(
      ctx,
      campaign,
      {
        actorId: member._id,
        action: "delete",
        description: `Excluiu a campanha «${campaign.name}»`,
        severity: "high",
        changes: { before: { name: campaign.name, status: campaign.status, stats: campaign.stats } },
        metadata: viaMeta(args.via),
      },
      now
    );
    await ctx.scheduler.runAfter(0, internal.campaigns.internalCascadeDeleteCampaign, { campaignId: campaign._id });
    return null;
  }
export const deleteCampaign = mutation({
  args: deleteCampaignArgs,
  returns: v.null(),
  handler: deleteCampaignHandler,
});

export const internalCascadeDeleteCampaign = internalMutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(200);
    for (const r of rows) await ctx.db.delete(r._id);
    if (rows.length === 200) {
      await ctx.scheduler.runAfter(0, internal.campaigns.internalCascadeDeleteCampaign, { campaignId: args.campaignId });
      return null;
    }
    const campaign = await ctx.db.get(args.campaignId);
    if (campaign) await ctx.db.delete(campaign._id);
    return null;
  },
});

// ── Público: manual / importação ──

function assertEditableAudience(campaign: Doc<"campaigns">) {
  if (campaign.status !== "draft") throw new Error("Só é possível alterar o público de um rascunho");
  if (campaign.audience.source === "segment") {
    throw new Error("Esta campanha usa segmento — os destinatários são calculados no lançamento");
  }
}

async function insertRecipientRows(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  rows: Array<{ phone: string; displayName?: string; vars?: Record<string, string>; contactId?: Id<"contacts">; leadId?: Id<"leads"> }>,
  now: number
): Promise<{ added: number; duplicates: number; suppressed: number }> {
  let added = 0;
  let duplicates = 0;
  let suppressed = 0;
  for (const row of rows) {
    const existing = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign_and_phone", (q) => q.eq("campaignId", campaign._id).eq("phone", row.phone))
      .first();
    if (existing) {
      duplicates++;
      continue;
    }
    if (await isPhoneSuppressed(ctx, campaign.organizationId, row.phone)) {
      suppressed++;
      continue;
    }
    await ctx.db.insert("campaignRecipients", {
      organizationId: campaign.organizationId,
      campaignId: campaign._id,
      phone: row.phone,
      displayName: row.displayName,
      vars: row.vars && Object.keys(row.vars).length > 0 ? row.vars : undefined,
      contactId: row.contactId,
      leadId: row.leadId,
      status: "pending",
      attempts: 0,
      createdAt: now,
    });
    added++;
  }
  if (added > 0) {
    const fresh = (await ctx.db.get(campaign._id))!;
    await ctx.db.patch(campaign._id, {
      stats: { ...fresh.stats, total: fresh.stats.total + added, pending: fresh.stats.pending + added },
      audience: { ...fresh.audience, total: fresh.stats.total + added },
      updatedAt: now,
    });
  }
  return { added, duplicates, suppressed };
}

export const addManualRecipientsArgs = {
    campaignId: v.id("campaigns"),
    entries: v.array(
      v.object({
        phone: v.string(),
        name: v.optional(v.string()),
        vars: v.optional(v.record(v.string(), v.string())),
      })
    ),
  };
export type AddManualRecipientsArgs = ObjectType<typeof addManualRecipientsArgs> & InternalActorArgs;
export async function addManualRecipientsHandler(ctx: MutationCtx, args: AddManualRecipientsArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    await authorize(ctx, campaign.organizationId, "manage", args.actorMemberId);
    assertEditableAudience(campaign);
    if (args.entries.length > MANUAL_CHUNK) {
      throw new Error(`Adicione no máximo ${MANUAL_CHUNK} números por vez`);
    }
    const now = Date.now();
    const invalid: Array<{ phone: string; reason: string }> = [];
    const rows: Array<{ phone: string; displayName?: string; vars?: Record<string, string> }> = [];
    const seen = new Set<string>();
    let dupInBatch = 0;
    for (const entry of args.entries) {
      const n = normalizeCampaignPhone(entry.phone);
      if (!n.ok) {
        invalid.push({ phone: entry.phone, reason: n.reason });
        continue;
      }
      if (seen.has(n.phone)) {
        dupInBatch++;
        continue;
      }
      seen.add(n.phone);
      rows.push({ phone: n.phone, displayName: entry.name?.trim() || undefined, vars: entry.vars });
    }
    const result = await insertRecipientRows(ctx, campaign, rows, now);
    return { added: result.added, invalid, duplicates: result.duplicates + dupInBatch, suppressed: result.suppressed };
  }
export const addManualRecipients = mutation({
  args: addManualRecipientsArgs,
  returns: v.object({
    added: v.number(),
    invalid: v.array(v.object({ phone: v.string(), reason: v.string() })),
    duplicates: v.number(),
    suppressed: v.number(),
  }),
  handler: addManualRecipientsHandler,
});

export const removeRecipient = mutation({
  args: { recipientId: v.id("campaignRecipients") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const recipient = await ctx.db.get(args.recipientId);
    if (!recipient) return null;
    const campaign = await getCampaignInOrg(ctx, recipient.campaignId);
    await requirePermission(ctx, campaign.organizationId, "campaigns", "manage");
    if (campaign.status !== "draft") throw new Error("Só é possível remover destinatários de um rascunho");
    await ctx.db.delete(recipient._id);
    await ctx.db.patch(campaign._id, {
      stats: { ...campaign.stats, total: Math.max(0, campaign.stats.total - 1), pending: Math.max(0, campaign.stats.pending - 1) },
      audience: { ...campaign.audience, total: Math.max(0, (campaign.audience.total ?? campaign.stats.total) - 1) },
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const clearRecipients = mutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    await requirePermission(ctx, campaign.organizationId, "campaigns", "manage");
    if (campaign.status !== "draft") throw new Error("Só é possível limpar destinatários de um rascunho");
    await ctx.db.patch(campaign._id, {
      stats: emptyStats(),
      audience: { ...campaign.audience, total: 0 },
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.campaigns.internalClearRecipients, { campaignId: campaign._id });
    return null;
  },
});

export const internalClearRecipients = internalMutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign", (q) => q.eq("campaignId", args.campaignId))
      .take(200);
    for (const r of rows) await ctx.db.delete(r._id);
    if (rows.length === 200) {
      await ctx.scheduler.runAfter(0, internal.campaigns.internalClearRecipients, { campaignId: args.campaignId });
    }
    return null;
  },
});

// Importação CSV — a action lê o arquivo (storage) e faz o dry-run em memória;
// o commit insere em lotes via internalMutation. Contato/lead são criados só
// no ENVIO (importar não é contatar).
const importMappingValidator = v.object({
  phone: v.string(),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  company: v.optional(v.string()),
  varsColumns: v.optional(v.array(v.string())),
});

export const importRecipientsCsvArgs = {
    campaignId: v.id("campaigns"),
    csvText: v.optional(v.string()),
    fileId: v.optional(v.id("files")),
    mapping: v.optional(importMappingValidator),
    dryRun: v.boolean(),
  };
export type ImportRecipientsCsvArgs = ObjectType<typeof importRecipientsCsvArgs> & InternalActorArgs;
export async function importRecipientsCsvHandler(ctx: ActionCtx, args: ImportRecipientsCsvArgs): Promise<Record<string, unknown>> {
    const context = await ctx.runQuery(internal.campaigns.internalImportContext, {
      campaignId: args.campaignId,
      fileId: args.fileId,
      actorMemberId: args.actorMemberId,
    });
    let text = args.csvText ?? "";
    if (!text && context.storageId) {
      const blob = await ctx.storage.get(context.storageId as Id<"_storage">);
      if (!blob) throw new Error("Arquivo não encontrado no armazenamento");
      if (blob.size > MAX_CSV_BYTES) throw new Error("Arquivo maior que 5 MB");
      text = await blob.text();
    }
    if (!text) throw new Error("Envie o conteúdo CSV ou um arquivo");
    if (text.length > MAX_CSV_BYTES) throw new Error("CSV maior que 5 MB");

    const parsed = parseCsv(text);
    if (parsed.headers.length === 0) throw new Error("CSV vazio ou sem cabeçalho");

    // Sem mapping: só devolve headers + sugestão (passo 1 do wizard)
    const suggest = (candidates: string[]) =>
      parsed.headers.find((h) => candidates.includes(h.toLowerCase().trim())) ?? null;
    const suggestedMapping = {
      phone: suggest(["telefone", "phone", "celular", "whatsapp", "fone", "numero", "número", "mobile", "tel"]),
      name: suggest(["nome", "name", "contato", "cliente", "primeiro nome", "first name", "full name"]),
      email: suggest(["email", "e-mail", "mail"]),
      company: suggest(["empresa", "company", "organização", "organizacao"]),
    };
    if (!args.mapping) {
      return {
        headers: parsed.headers,
        rowCount: parsed.rows.length,
        suggestedMapping,
        preview: parsed.rows.slice(0, 5),
      };
    }

    const mapping = args.mapping;
    if (!parsed.headers.includes(mapping.phone)) throw new Error(`Coluna de telefone "${mapping.phone}" não existe no CSV`);
    const seen = new Set<string>();
    const valid: Array<{ phone: string; displayName?: string; vars?: Record<string, string> }> = [];
    const invalid: Array<{ row: number; phone: string; reason: string }> = [];
    let duplicates = 0;
    parsed.rows.forEach((row, i) => {
      const raw = row[mapping.phone] ?? "";
      const n = normalizeCampaignPhone(raw);
      if (!n.ok) {
        invalid.push({ row: i + 2, phone: raw, reason: n.reason });
        return;
      }
      if (seen.has(n.phone)) {
        duplicates++;
        return;
      }
      seen.add(n.phone);
      const vars: Record<string, string> = {};
      const name = mapping.name ? row[mapping.name]?.trim() : undefined;
      if (name) vars.nome = name;
      if (mapping.email && row[mapping.email]?.trim()) vars.email = row[mapping.email].trim();
      if (mapping.company && row[mapping.company]?.trim()) vars.empresa = row[mapping.company].trim();
      for (const col of mapping.varsColumns ?? []) {
        const val = row[col];
        if (val !== undefined && val.trim()) vars[col] = val.trim();
      }
      valid.push({ phone: n.phone, displayName: name || undefined, vars });
    });

    // supressão + contatos existentes (lotes de 200)
    let suppressed = 0;
    let existingContacts = 0;
    const cleared: typeof valid = [];
    for (let i = 0; i < valid.length; i += IMPORT_BATCH) {
      const chunk = valid.slice(i, i + IMPORT_BATCH);
      const check = await ctx.runQuery(internal.campaigns.internalCheckPhones, {
        organizationId: context.organizationId,
        phones: chunk.map((c) => c.phone),
      });
      for (const c of chunk) {
        if (check.suppressed.includes(c.phone)) {
          suppressed++;
          continue;
        }
        if (check.existing.includes(c.phone)) existingContacts++;
        cleared.push(c);
      }
    }

    const summary = {
      headers: parsed.headers,
      rowCount: parsed.rows.length,
      valid: cleared.length,
      invalid: invalid.slice(0, 20),
      invalidCount: invalid.length,
      duplicates,
      suppressed,
      existingContacts,
      preview: cleared.slice(0, 10),
      suggestedMapping,
    };
    if (args.dryRun) return summary;

    let added = 0;
    let dupInCampaign = 0;
    for (let i = 0; i < cleared.length; i += IMPORT_BATCH) {
      const res = await ctx.runMutation(internal.campaigns.internalInsertRecipients, {
        campaignId: args.campaignId,
        rows: cleared.slice(i, i + IMPORT_BATCH),
      });
      added += res.added;
      dupInCampaign += res.duplicates;
    }
    await ctx.runMutation(internal.campaigns.internalMarkImported, {
      campaignId: args.campaignId,
      fileId: args.fileId,
      added,
    });
    return { ...summary, added, duplicatesInCampaign: dupInCampaign };
  }
export const importRecipientsCsv = action({
  args: importRecipientsCsvArgs,
  returns: v.any(),
  handler: importRecipientsCsvHandler,
});

export const internalImportContext = internalQuery({
  args: { campaignId: v.id("campaigns"), fileId: v.optional(v.id("files")), actorMemberId: v.optional(v.id("teamMembers")) },
  returns: v.object({ organizationId: v.id("organizations"), storageId: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    await authorize(ctx, campaign.organizationId, "manage", args.actorMemberId);
    assertEditableAudience(campaign);
    let storageId: string | null = null;
    if (args.fileId) {
      const file = await ctx.db.get(args.fileId);
      if (!file || file.organizationId !== campaign.organizationId) throw new Error("Arquivo não encontrado");
      if (file.fileType !== "import_file") throw new Error("Envie o arquivo como import_file");
      storageId = file.storageId;
    }
    return { organizationId: campaign.organizationId, storageId };
  },
});

export const internalCheckPhones = internalQuery({
  args: { organizationId: v.id("organizations"), phones: v.array(v.string()) },
  returns: v.object({ suppressed: v.array(v.string()), existing: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const suppressed: string[] = [];
    const existing: string[] = [];
    for (const phone of args.phones) {
      if (await isPhoneSuppressed(ctx, args.organizationId, phone)) suppressed.push(phone);
      const contact = await ctx.db
        .query("contacts")
        .withIndex("by_organization_and_phone", (q) => q.eq("organizationId", args.organizationId).eq("phone", phone))
        .first();
      if (contact) existing.push(phone);
    }
    return { suppressed, existing };
  },
});

export const internalInsertRecipients = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    rows: v.array(
      v.object({
        phone: v.string(),
        displayName: v.optional(v.string()),
        vars: v.optional(v.record(v.string(), v.string())),
      })
    ),
  },
  returns: v.object({ added: v.number(), duplicates: v.number(), suppressed: v.number() }),
  handler: async (ctx, args) => {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    if (campaign.status !== "draft") throw new Error("Campanha não está em rascunho");
    return await insertRecipientRows(ctx, campaign, args.rows, Date.now());
  },
});

export const internalMarkImported = internalMutation({
  args: { campaignId: v.id("campaigns"), fileId: v.optional(v.id("files")), added: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    const now = Date.now();
    await ctx.db.patch(campaign._id, {
      audience: { ...campaign.audience, importFileId: args.fileId ?? campaign.audience.importFileId },
      updatedAt: now,
    });
    await addTimeline(ctx, campaign, { kind: "imported", detail: `${args.added} destinatários importados` }, now);
    return null;
  },
});

// ── Lançamento / controle ──

async function validateForLaunch(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  config: Doc<"channelConfigs">,
  now: number
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const provider = configProvider(config);
  if (config.status !== "active") throw new Error("O canal escolhido não está ativo");
  if (provider === "bridge" && config.bridgeSessionState && config.bridgeSessionState !== "connected") {
    throw new Error("A sessão do bridge não está conectada — escaneie o QR em Configurações → Canais");
  }
  validateContent(campaign.content, provider);

  if (provider === "meta" && campaign.content.kind === "text") {
    const onlyOpen = campaign.audience.source === "segment" && campaign.audience.filters?.onlyOpenWindow === true;
    if (!onlyOpen) {
      throw new Error(
        "No canal oficial (Meta), texto livre só chega a quem tem a janela de 24h aberta. Use um template aprovado ou marque o filtro \"só janela aberta\" no público."
      );
    }
  }

  if (provider === "bridge") {
    const day = channelAgeDay(config, now);
    const total = campaign.audience.source === "segment" ? (campaign.audience.total ?? Infinity) : campaign.stats.total;
    const variants = campaign.content.variants.filter((vr) => vr.text.trim());
    if (total > MIN_VARIANTS_BRIDGE_ABOVE && variants.length < 2 && !variants.some((vr) => /\{[^{}]*\|[^{}]*\}/.test(vr.text))) {
      throw new Error(
        `No bridge, campanhas com mais de ${MIN_VARIANTS_BRIDGE_ABOVE} destinatários precisam de pelo menos 2 variantes de texto (ou spintax {a|b}) — texto idêntico em massa é o sinal mais forte de spam`
      );
    }
    if (!campaign.safety.allowLinks && variants.some((vr) => containsLink(vr.text))) {
      throw new Error(
        "A mensagem contém link. No bridge, link no primeiro contato aumenta muito o risco de bloqueio — remova-o ou marque \"permitir links\" em Segurança"
      );
    }
    const safe = safeDefaultsFor({ provider, warmupDay: day });
    // Número recém-conectado não trava — o aceite próprio é exigido no launch.
    if (safe.newNumberRisk) {
      warnings.push(
        `Número conectado há ${day} dia(s) — lançada com o aceite do risco de número recém-conectado. Acompanhe entregas e bloqueios de perto.`
      );
    }
    if (safe.warmupWarning) warnings.push(safe.warmupWarning);
  }
  if (campaign.audience.source !== "segment" && campaign.stats.pending === 0) {
    throw new Error("A campanha não tem destinatários pendentes");
  }
  const vars = new Set<string>();
  for (const vr of campaign.content.variants) for (const k of extractVars(vr.text)) vars.add(k);
  if (vars.size > 0) warnings.push(`Variáveis usadas: ${[...vars].join(", ")} — destinatário sem valor recebe o texto de fallback (ou vazio)`);
  return { warnings };
}

export const launchCampaignArgs = {
    campaignId: v.id("campaigns"),
    consentAck: v.boolean(),
    bridgeRiskAck: v.optional(v.boolean()),
    newNumberRiskAck: v.optional(v.boolean()), // bridge com < BRIDGE_MIN_AGE_DAYS dias
    overrideAck: v.optional(v.boolean()),
    overrideWord: v.optional(v.string()),
    tierAtLaunch: v.optional(v.string()),
    templateQualityAtLaunch: v.optional(v.string()),
  };
export type LaunchCampaignArgs = ObjectType<typeof launchCampaignArgs> & InternalActorArgs;
export async function launchCampaignHandler(ctx: MutationCtx, args: LaunchCampaignArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    const member = await authorize(ctx, campaign.organizationId, "full", args.actorMemberId);
    if (campaign.status !== "draft") throw new Error("Só rascunhos podem ser lançados");
    const config = await getChannelInOrg(ctx, campaign.channelConfigId, campaign.organizationId);
    const provider = configProvider(config);
    const now = Date.now();

    if (args.consentAck !== true) {
      throw new Error("Confirme que você tem consentimento ou base legal para contatar esta lista (LGPD)");
    }
    if (provider === "bridge" && args.bridgeRiskAck !== true) {
      throw new Error("Confirme que aceita o risco de banimento do número ao disparar pela API não-oficial");
    }
    const warmupDay = channelAgeDay(config, now);
    const safe = safeDefaultsFor({ provider, warmupDay, tier: args.tierAtLaunch });
    // Número recém-conectado AVISA e exige aceite próprio, mas não trava: a
    // decisão é de quem opera. Os limites de aquecimento continuam valendo.
    const newNumber = safe.newNumberRisk !== undefined;
    if (newNumber && args.newNumberRiskAck !== true) {
      throw new Error(
        `Número conectado há ${warmupDay} dia(s): confirme que aceita o risco de disparar por um número recém-conectado`
      );
    }
    let pacing = clampToHardCap(campaign.pacing, provider, args.tierAtLaunch);
    const withinSafe = isWithinSafeDefaults(pacing, safe.pacing);
    let overrideAck = campaign.overrideAck;
    if (!withinSafe) {
      if (args.overrideAck !== true || (args.overrideWord ?? "").trim().toUpperCase() !== "ENTENDO") {
        throw new Error(
          'Os limites desta campanha estão acima do modo seguro. Para lançar assim mesmo, digite "ENTENDO" e confirme o override'
        );
      }
      overrideAck = { acceptedAt: now, acceptedBy: member._id };
    } else {
      pacing = { ...pacing };
    }

    const { warnings } = await validateForLaunch(ctx, { ...campaign, pacing }, config, now);

    const pricing = loadPricing(process.env.WA_PRICING_JSON);
    const recipients = campaign.audience.source === "segment" ? (campaign.audience.total ?? 0) : campaign.stats.total;
    const estimatedCostUsd = estimateCampaignCost(
      { provider, category: campaign.content.template?.category ?? null, recipients },
      pricing
    );

    const startAt = Math.max(campaign.schedule.startAt ?? now, now);
    const needsSnapshot = campaign.audience.source === "segment";
    const status = needsSnapshot ? "scheduled" : "running";
    await ctx.db.patch(campaign._id, {
      status,
      pacing,
      safeMode: withinSafe,
      overrideAck,
      safety: {
        ...campaign.safety,
        consentAck: { acceptedAt: now, acceptedBy: member._id },
        ...(provider === "bridge" ? { bridgeRiskAck: { acceptedAt: now, acceptedBy: member._id } } : {}),
        ...(newNumber ? { newNumberRiskAck: { acceptedAt: now, acceptedBy: member._id } } : {}),
      },
      stats: { ...campaign.stats, estimatedCostUsd, consecutiveFailures: 0 },
      tierAtLaunch: args.tierAtLaunch ?? (provider === "meta" ? "unknown" : undefined),
      templateQualityAtLaunch: args.templateQualityAtLaunch,
      startedAt: now,
      pausedReason: undefined,
      pausedBy: undefined,
      batchSentSinceLastPause: 0,
      snapshotOffset: 0,
      updatedAt: now,
    });
    let fresh = (await ctx.db.get(campaign._id))!;
    await addTimeline(ctx, fresh, { kind: "launched", actorId: member._id, detail: `${withinSafe ? "modo seguro" : "override de limites"}${newNumber ? ` · número recém-conectado (dia ${warmupDay})` : ""}` }, now);
    fresh = (await ctx.db.get(campaign._id))!;

    await audit(
      ctx,
      fresh,
      {
        actorId: member._id,
        action: "update",
        description: `Lançou a campanha «${campaign.name}» (${provider}, ${recipients} destinatários${withinSafe ? "" : ", LIMITES ACIMA DO MODO SEGURO"}${newNumber ? `, NÚMERO RECÉM-CONECTADO (dia ${warmupDay})` : ""})`,
        severity: "high",
        changes: {
          before: { status: "draft" },
          after: { status, pacing, safeMode: withinSafe, consentAck: true, bridgeRiskAck: provider === "bridge", newNumberRiskAck: newNumber, warmupDay: provider === "bridge" ? warmupDay : null, override: !withinSafe, estimatedCostUsd, tierAtLaunch: args.tierAtLaunch ?? null },
        },
        metadata: viaMeta(args.via),
      },
      now
    );
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: campaign.organizationId,
      event: "campaign.started",
      payload: { campaignId: campaign._id, name: campaign.name, provider, recipients, startAt },
    });

    if (needsSnapshot) {
      await ctx.scheduler.runAfter(0, internal.campaigns.internalSnapshotAudience, { campaignId: campaign._id });
    } else {
      await scheduleCampaignTick(ctx, fresh, startAt, now);
    }
    return { status, warnings, estimatedCostUsd };
  }
export const launchCampaign = mutation({
  args: launchCampaignArgs,
  returns: v.object({ status: v.string(), warnings: v.array(v.string()), estimatedCostUsd: v.number() }),
  handler: launchCampaignHandler,
});

/** Snapshot do segmento em lotes; ao terminar vira `running` e agenda o 1º tick. */
export const internalSnapshotAudience = internalMutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign || campaign.status !== "scheduled") return null;
    const now = Date.now();
    const offset = campaign.snapshotOffset ?? 0;
    const result = await resolveSegmentAudience(ctx, {
      organizationId: campaign.organizationId,
      filters: campaign.audience.filters ?? {},
      now,
      scanOffset: offset,
      scanLimit: SNAPSHOT_BATCH_LEADS,
    });
    await insertRecipientRows(
      ctx,
      campaign,
      result.candidates.map((c) => ({
        phone: c.phone,
        displayName: c.displayName,
        vars: c.vars,
        contactId: c.contactId,
        leadId: c.leadId,
      })),
      now
    );
    const fresh = (await ctx.db.get(campaign._id))!;
    if (result.truncated) {
      await ctx.db.patch(campaign._id, { snapshotOffset: offset + SNAPSHOT_BATCH_LEADS, updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.campaigns.internalSnapshotAudience, { campaignId: campaign._id });
      return null;
    }
    const total = fresh.stats.total;
    // O custo estimado no lançamento era 0 (o segmento ainda não existia);
    // agora que o snapshot fechou, recalcula com o total real.
    const config = await ctx.db.get(campaign.channelConfigId);
    const estimatedCostUsd = estimateCampaignCost(
      {
        provider: config ? configProvider(config) : campaign.provider,
        category: campaign.content.template?.category ?? null,
        recipients: total,
      },
      loadPricing(process.env.WA_PRICING_JSON)
    );
    await ctx.db.patch(campaign._id, {
      status: "running",
      audience: { ...fresh.audience, snapshotAt: now, total },
      stats: { ...fresh.stats, estimatedCostUsd },
      updatedAt: now,
    });
    const running = (await ctx.db.get(campaign._id))!;
    await addTimeline(ctx, running, { kind: "snapshot", detail: `${total} destinatários no segmento` }, now);
    const again = (await ctx.db.get(campaign._id))!;
    const startAt = Math.max(again.schedule.startAt ?? now, now);
    await scheduleCampaignTick(ctx, again, startAt, now);
    return null;
  },
});

export const pauseCampaignArgs = { campaignId: v.id("campaigns"), reason: v.optional(v.string()) };
export type PauseCampaignArgs = ObjectType<typeof pauseCampaignArgs> & InternalActorArgs;
export async function pauseCampaignHandler(ctx: MutationCtx, args: PauseCampaignArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    const member = await authorize(ctx, campaign.organizationId, "manage", args.actorMemberId);
    if (campaign.status !== "running" && campaign.status !== "scheduled") throw new Error("A campanha não está em andamento");
    await pauseCampaignCore(ctx, campaign, {
      reason: args.reason?.trim() || "Pausada manualmente",
      actorId: member._id,
      automatic: false,
    });
    return null;
  }
export const pauseCampaign = mutation({
  args: pauseCampaignArgs,
  returns: v.null(),
  handler: pauseCampaignHandler,
});

export const resumeCampaignArgs = { campaignId: v.id("campaigns") };
export type ResumeCampaignArgs = ObjectType<typeof resumeCampaignArgs> & InternalActorArgs;
export async function resumeCampaignHandler(ctx: MutationCtx, args: ResumeCampaignArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    const member = await authorize(ctx, campaign.organizationId, "manage", args.actorMemberId);
    if (campaign.status !== "paused") throw new Error("A campanha não está pausada");
    const config = await getChannelInOrg(ctx, campaign.channelConfigId, campaign.organizationId);
    if (config.status !== "active") throw new Error("O canal não está ativo");
    const now = Date.now();
    await ctx.db.patch(campaign._id, {
      status: "running",
      pausedReason: undefined,
      pausedBy: undefined,
      stats: { ...campaign.stats, consecutiveFailures: 0 },
      batchSentSinceLastPause: 0,
      updatedAt: now,
    });
    let fresh = (await ctx.db.get(campaign._id))!;
    await addTimeline(ctx, fresh, { kind: "resumed", actorId: member._id }, now);
    fresh = (await ctx.db.get(campaign._id))!;
    await audit(ctx, fresh, { actorId: member._id, action: "update", description: `Retomou a campanha «${campaign.name}»`, severity: "medium", metadata: viaMeta(args.via) }, now);
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: campaign.organizationId,
      event: "campaign.resumed",
      payload: { campaignId: campaign._id, name: campaign.name },
    });
    await scheduleCampaignTick(ctx, fresh, now, now);
    return null;
  }
export const resumeCampaign = mutation({
  args: resumeCampaignArgs,
  returns: v.null(),
  handler: resumeCampaignHandler,
});

export const cancelCampaignArgs = { campaignId: v.id("campaigns") };
export type CancelCampaignArgs = ObjectType<typeof cancelCampaignArgs> & InternalActorArgs;
export async function cancelCampaignHandler(ctx: MutationCtx, args: CancelCampaignArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    const member = await authorize(ctx, campaign.organizationId, "full", args.actorMemberId);
    if (!["running", "paused", "scheduled"].includes(campaign.status)) throw new Error("A campanha não pode ser cancelada neste estado");
    const now = Date.now();
    if (campaign.schedulerFnId) {
      try {
        await ctx.scheduler.cancel(campaign.schedulerFnId as Id<"_scheduled_functions">);
      } catch {
        // já rodou
      }
    }
    await ctx.db.patch(campaign._id, {
      status: "canceled",
      schedulerFnId: undefined,
      nextTickAt: undefined,
      tickToken: undefined,
      completedAt: now,
      updatedAt: now,
    });
    let fresh = (await ctx.db.get(campaign._id))!;
    await addTimeline(ctx, fresh, { kind: "canceled", actorId: member._id }, now);
    fresh = (await ctx.db.get(campaign._id))!;
    await audit(
      ctx,
      fresh,
      { actorId: member._id, action: "update", description: `Cancelou a campanha «${campaign.name}»`, severity: "high", changes: { before: { status: campaign.status, stats: campaign.stats }, after: { status: "canceled" } }, metadata: viaMeta(args.via) },
      now
    );
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: campaign.organizationId,
      event: "campaign.canceled",
      payload: { campaignId: campaign._id, name: campaign.name, stats: campaign.stats },
    });
    await ctx.scheduler.runAfter(0, internal.campaigns.internalSkipPendingRecipients, { campaignId: campaign._id });
    return null;
  }
export const cancelCampaign = mutation({
  args: cancelCampaignArgs,
  returns: v.null(),
  handler: cancelCampaignHandler,
});

export const internalSkipPendingRecipients = internalMutation({
  args: { campaignId: v.id("campaigns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", args.campaignId).eq("status", "pending"))
      .take(200);
    const now = Date.now();
    for (const r of rows) {
      await transitionRecipient(ctx, r, "skipped", { skipReason: "canceled" }, { now, force: true });
    }
    if (rows.length === 200) {
      await ctx.scheduler.runAfter(0, internal.campaigns.internalSkipPendingRecipients, { campaignId: args.campaignId });
    }
    return null;
  },
});

/** Reenfileira falhas elegíveis: 131049 vencido, falhas de rede, pulados por cancelamento. */
export const retryFailedArgs = { campaignId: v.id("campaigns") };
export type RetryFailedArgs = ObjectType<typeof retryFailedArgs> & InternalActorArgs;
export async function retryFailedHandler(ctx: MutationCtx, args: RetryFailedArgs) {
    const campaign = await getCampaignInOrg(ctx, args.campaignId);
    const member = await authorize(ctx, campaign.organizationId, "manage", args.actorMemberId);
    if (!["paused", "completed", "canceled"].includes(campaign.status)) {
      throw new Error("Pause ou conclua a campanha antes de reenviar falhas");
    }
    const now = Date.now();
    const failed = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", args.campaignId).eq("status", "failed"))
      .take(500);
    const skipped = await ctx.db
      .query("campaignRecipients")
      .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", args.campaignId).eq("status", "skipped"))
      .take(500);
    const NEVER = new Set([131026, 131047, 131050, 130403, 131048, 132015]);
    let requeued = 0;
    for (const r of [...failed, ...skipped]) {
      const eligible =
        (r.status === "skipped" && r.skipReason === "canceled") ||
        (r.status === "failed" && (r.errorCode === undefined || (!NEVER.has(r.errorCode) && r.errorCode !== 131049) || (r.errorCode === 131049 && (r.scheduledFor ?? 0) <= now)));
      if (!eligible) continue;
      const ok = await transitionRecipient(
        ctx,
        r,
        "pending",
        { messageId: undefined, scheduledFor: undefined, lastError: undefined, errorCode: undefined, skipReason: undefined },
        { now, force: true }
      );
      if (ok) requeued++;
    }
    if (requeued > 0) {
      const fresh = (await ctx.db.get(campaign._id))!;
      await ctx.db.patch(campaign._id, {
        status: "running",
        pausedReason: undefined,
        completedAt: undefined,
        stats: { ...fresh.stats, consecutiveFailures: 0 },
        updatedAt: now,
      });
      let again = (await ctx.db.get(campaign._id))!;
      await addTimeline(ctx, again, { kind: "retry", detail: `${requeued} reenfileirados`, actorId: member._id }, now);
      again = (await ctx.db.get(campaign._id))!;
      await audit(ctx, again, { actorId: member._id, action: "update", description: `Reenviou ${requeued} falhas da campanha «${campaign.name}»`, severity: "medium", metadata: viaMeta(args.via) }, now);
      await scheduleCampaignTick(ctx, again, now, now);
    }
    return { requeued };
  }
export const retryFailed = mutation({
  args: retryFailedArgs,
  returns: v.object({ requeued: v.number() }),
  handler: retryFailedHandler,
});

// Helper exportado para REST/UI (mesmo cálculo do lançamento)
export function estimateCostForCampaign(campaign: Doc<"campaigns">): number {
  const recipients = campaign.audience.source === "segment" ? (campaign.audience.total ?? 0) : campaign.stats.total;
  return estimateCampaignCost(
    { provider: campaign.provider, category: campaign.content.template?.category ?? null, recipients },
    loadPricing(process.env.WA_PRICING_JSON)
  );
}

export { type CampaignPacing };

/** Badge da navegação: campanhas pausadas por kill switch / canal (têm pausedReason). */
export const getPausedCount = query({
  args: { organizationId: v.id("organizations") },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "campaigns", "view");
    const rows = await ctx.db
      .query("campaigns")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", "paused")
      )
      .take(100);
    return rows.filter((c) => Boolean(c.pausedReason)).length;
  },
});
