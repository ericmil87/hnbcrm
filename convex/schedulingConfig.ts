/**
 * Agenda v2 — configuração (A3a): serviços, recursos, `schedSettings`, modelos prontos e a prévia do
 * modo inteligente. Funções finas; a regra mora em `lib/schedConfigOps.ts`.
 *
 * Permissão: toda função exige `agenda`; escrita = `manage`; leitura = `view_own` (campos de
 * automação/IA só para `manage`). Query sem permissão (ou de outra org) devolve `null`/vazio, nunca
 * erro; mutation recusa com mensagem PT-BR. Módulo desligado: queries vazias, mutations recusam
 * (`assertModule`); quem LIGA o módulo é `orgModules.setOrgModules`.
 * Docs: docs/architecture/agenda.md.
 */
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requirePermission } from "./lib/auth";
import { assertModule } from "./lib/orgModules";
import {
  applySchedTemplateCore,
  resourceInputFields,
  serviceInputFields,
  setResourceActiveCore,
  setServiceActiveCore,
  settingsPatchValidator,
  templateDraftValidator,
  updateSchedSettingsCore,
  upsertResourceCore,
  upsertServiceCore,
} from "./lib/schedConfigOps";
import { isSchedulingOn, resolveAgendaReader } from "./lib/schedRead";
import { searchSlots } from "./lib/schedSearch";
import { buildTemplateDraft, isSchedTemplateKey, TEMPLATE_MAX_PEOPLE, type SchedTemplateDraft } from "./lib/schedTemplates";
import { isValidLocalDate } from "./lib/schedTime";
import { resolveSchedSettings } from "./lib/schedSettingsDefaults";
import { smartMode } from "./schema";
import {
  exceptionDocValidator,
  resourceDocValidator,
  serviceDocValidator,
  settingsViewValidator,
  slotValidator,
  toSettingsView,
} from "./lib/schedViews";
import { MAX_RESOURCES_PER_ORG, MAX_SERVICES_PER_ORG } from "./lib/schedConstants";
import { isMembershipRevoked } from "./lib/auth";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const CLOSURES_CAP = 200;

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export const getConfig = query({
  /** `closuresFrom`: data local (AAAA-MM-DD) de hoje; só os fechamentos dessa data em diante vêm (teto 200). */
  args: { organizationId: v.id("organizations"), closuresFrom: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      enabled: v.boolean(),
      canManage: v.boolean(),
      timezone: v.string(),
      settings: settingsViewValidator,
      services: v.array(serviceDocValidator),
      resources: v.array(resourceDocValidator),
      closures: v.array(exceptionDocValidator),
      closuresCapped: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    const reader = await resolveAgendaReader(ctx, args.organizationId, "view_own");
    if (!reader) return null;
    const org = await ctx.db.get(args.organizationId);
    if (!org) return null;
    const settingsDoc = await ctx.db
      .query("schedSettings")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .first();
    const settings = toSettingsView(resolveSchedSettings(settingsDoc), reader.canManage);
    const enabled = await isSchedulingOn(ctx, args.organizationId);
    if (!enabled) {
      return {
        enabled: false,
        canManage: reader.canManage,
        timezone: org.settings.timezone,
        settings,
        services: [],
        resources: [],
        closures: [],
        closuresCapped: false,
      };
    }
    const services = await ctx.db
      .query("schedServices")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(MAX_SERVICES_PER_ORG);
    const resources = await ctx.db
      .query("schedResources")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(MAX_RESOURCES_PER_ORG);
    const from = args.closuresFrom;
    if (!isValidLocalDate(from)) throw new ConvexError("Data inválida: use o formato AAAA-MM-DD.");
    const closureRows = await ctx.db
      .query("schedExceptions")
      .withIndex("by_organization_and_date", (q) => q.eq("organizationId", args.organizationId).gte("localDate", from))
      .take(CLOSURES_CAP + 1);
    return {
      enabled: true,
      canManage: reader.canManage,
      timezone: org.settings.timezone,
      settings,
      services: services.sort((a, b) => a.sortOrder - b.sortOrder),
      resources: resources.sort((a, b) => a.sortOrder - b.sortOrder),
      closures: closureRows.slice(0, CLOSURES_CAP),
      closuresCapped: closureRows.length > CLOSURES_CAP,
    };
  },
});

/** Rascunho do modelo montado no servidor (equipe humana ativa, teto 6). `null` sem `manage`. */
async function templateDraftFor(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  templateKey: string,
  configuringMemberId: Id<"teamMembers">
): Promise<SchedTemplateDraft | null> {
  if (!isSchedTemplateKey(templateKey)) return null;
  const humans = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "human"))
    .take(50);
  const members = humans
    .filter((m) => !isMembershipRevoked(m))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, Math.max(TEMPLATE_MAX_PEOPLE, 1))
    .map((m) => ({ id: m._id, name: m.name }));
  return buildTemplateDraft(templateKey, { members, configuringMemberId });
}

export const previewTemplate = query({
  args: { organizationId: v.id("organizations"), templateKey: v.string() },
  returns: v.union(v.null(), templateDraftValidator),
  handler: async (ctx, args) => {
    const reader = await resolveAgendaReader(ctx, args.organizationId, "manage");
    if (!reader) return null;
    const draft = await templateDraftFor(ctx, args.organizationId, args.templateKey, reader.member._id);
    if (!draft) return null;
    return {
      templateKey: draft.templateKey,
      settings: draft.settings,
      resources: draft.resources.map((r) => ({ ...r, teamMemberId: r.teamMemberId as Id<"teamMembers"> | undefined })),
      services: draft.services,
    };
  },
});

/** Efeito do modo inteligente para a tela de regras: o que a IA/link veria, com motivos, e o cronológico. */
export const previewSuggestions = query({
  args: {
    organizationId: v.id("organizations"),
    serviceId: v.id("schedServices"),
    localDate: v.string(),
    now: v.number(),
    audience: v.optional(v.union(v.literal("ai"), v.literal("public"))),
    // Rascunho da tela (ainda não salvo); ausente = o que está salvo.
    mode: v.optional(smartMode),
    weights: v.optional(
      v.object({
        adjacency: v.number(),
        deadGap: v.number(),
        openNewResource: v.number(),
        earlyFirst: v.number(),
        balance: v.number(),
        preference: v.number(),
      })
    ),
    minOffer: v.optional(v.number()),
  },
  returns: v.object({
    enabled: v.boolean(),
    mode: smartMode,
    suggestions: v.array(slotValidator),
    chronological: v.array(slotValidator),
    relaxed: v.boolean(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const empty = { enabled: false, mode: "rank" as const, suggestions: [], chronological: [], relaxed: false, truncated: false };
    const reader = await resolveAgendaReader(ctx, args.organizationId, "manage");
    if (!reader || !(await isSchedulingOn(ctx, args.organizationId))) return empty;
    if (args.weights) {
      for (const w of Object.values(args.weights)) if (!Number.isFinite(w) || w < 0 || w > 1000) return empty;
    }
    const res = await searchSlots(ctx, {
      organizationId: args.organizationId,
      serviceId: args.serviceId,
      fromLocalDate: args.localDate,
      audience: args.audience ?? "ai",
      reveal: true, // a prévia é do gestor (`manage`): mostra motivos
      now: args.now,
      limit: 3,
      override: { mode: args.mode, weights: args.weights, minOffer: args.minOffer },
    });
    return {
      enabled: true,
      mode: res.mode,
      suggestions: res.slots,
      chronological: res.chronological,
      relaxed: res.relaxed,
      truncated: res.truncated,
    };
  },
});

// ---------------------------------------------------------------------------
// Escrita (agenda:manage + módulo ligado)
// ---------------------------------------------------------------------------

const activeResult = v.object({ changed: v.boolean(), futureAppointments: v.number(), futureAppointmentsCapped: v.boolean() });
const resourceActiveResult = v.object({
  changed: v.boolean(),
  futureAppointments: v.number(),
  servicesAffected: v.array(v.string()),
});

async function gate(ctx: MutationCtx, organizationId: Id<"organizations">) {
  const member = await requirePermission(ctx, organizationId, "agenda", "manage");
  await assertModule(ctx, organizationId, "scheduling");
  return member;
}

export const upsertService = mutation({
  args: { organizationId: v.id("organizations"), serviceId: v.optional(v.id("schedServices")), ...serviceInputFields },
  returns: v.id("schedServices"),
  handler: async (ctx, args) => {
    const member = await gate(ctx, args.organizationId);
    const { organizationId, serviceId, ...input } = args;
    return await upsertServiceCore(ctx, { organizationId, member, serviceId, input, now: Date.now() });
  },
});

export const archiveService = mutation({
  args: { organizationId: v.id("organizations"), serviceId: v.id("schedServices"), acceptFuture: v.optional(v.boolean()) },
  returns: activeResult,
  handler: async (ctx, args) => {
    const member = await gate(ctx, args.organizationId);
    return await setServiceActiveCore(ctx, { ...args, member, active: false, now: Date.now() });
  },
});

export const reactivateService = mutation({
  args: { organizationId: v.id("organizations"), serviceId: v.id("schedServices") },
  returns: activeResult,
  handler: async (ctx, args) => {
    const member = await gate(ctx, args.organizationId);
    return await setServiceActiveCore(ctx, { ...args, member, active: true, now: Date.now() });
  },
});

export const upsertResource = mutation({
  args: {
    organizationId: v.id("organizations"),
    resourceId: v.optional(v.id("schedResources")),
    /** Aceite do aviso de agendamentos futuros fora do novo horário/capacidade (nada é cancelado). */
    acceptFuture: v.optional(v.boolean()),
    ...resourceInputFields,
  },
  returns: v.object({
    saved: v.boolean(),
    resourceId: v.id("schedResources"),
    futureOutsideHours: v.number(),
    overCapacityBy: v.number(),
    futureWithoutSpot: v.number(),
    inServiceKept: v.number(),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const member = await gate(ctx, args.organizationId);
    const { organizationId, resourceId, acceptFuture, ...input } = args;
    return await upsertResourceCore(ctx, { organizationId, member, resourceId, input, acceptFuture, now: Date.now() });
  },
});

export const archiveResource = mutation({
  args: { organizationId: v.id("organizations"), resourceId: v.id("schedResources"), acceptFuture: v.optional(v.boolean()) },
  returns: resourceActiveResult,
  handler: async (ctx, args) => {
    const member = await gate(ctx, args.organizationId);
    return await setResourceActiveCore(ctx, { ...args, member, active: false, now: Date.now() });
  },
});

export const reactivateResource = mutation({
  args: { organizationId: v.id("organizations"), resourceId: v.id("schedResources") },
  returns: resourceActiveResult,
  handler: async (ctx, args) => {
    const member = await gate(ctx, args.organizationId);
    return await setResourceActiveCore(ctx, { ...args, member, active: true, now: Date.now() });
  },
});

export const updateSettings = mutation({
  args: { organizationId: v.id("organizations"), patch: settingsPatchValidator, aiAutoAck: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await gate(ctx, args.organizationId);
    await updateSchedSettingsCore(ctx, {
      organizationId: args.organizationId,
      member,
      patch: args.patch,
      acks: args.aiAutoAck === undefined ? undefined : { aiAuto: args.aiAutoAck },
      via: "settings",
      now: Date.now(),
    });
    return null;
  },
});

export const applyTemplate = mutation({
  args: { organizationId: v.id("organizations"), templateKey: v.string(), draft: v.optional(templateDraftValidator) },
  returns: v.object({
    applied: v.boolean(),
    resourceIds: v.array(v.id("schedResources")),
    serviceIds: v.array(v.id("schedServices")),
  }),
  handler: async (ctx, args) => {
    const member = await gate(ctx, args.organizationId);
    const draft: SchedTemplateDraft | null =
      args.draft ?? (await templateDraftFor(ctx, args.organizationId, args.templateKey, member._id));
    if (!draft) throw new ConvexError("Modelo desconhecido.");
    return await applySchedTemplateCore(ctx, {
      organizationId: args.organizationId,
      member,
      templateKey: args.templateKey,
      draft,
      now: Date.now(),
    });
  },
});
