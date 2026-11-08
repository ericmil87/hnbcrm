import { ConvexError, v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { requireAuth, requirePermission, isMembershipRevoked } from "./lib/auth";
import {
  ACTIONABLE_FLAGS,
  DEFAULT_QUIET_END,
  DEFAULT_QUIET_START,
  KNOWN_FLAGS,
  channelAllows,
  isValidHHMM,
  isValidTimeZone,
  type ExternalChannel,
} from "./lib/notificationPolicy";
import { PREF_DEFAULTS, loadMemberPrefs, orgDefaultsOf, patchMemberPrefs, type PrefsPatch } from "./lib/notificationPrefs";
import { notifPresetValidator } from "./schema";
import { safeTimezone } from "./lib/promptDateTime";
import { tomorrowAt } from "./lib/telegramNotifications";
import { getAuthUserId } from "@convex-dev/auth/server";

// Default preferences — all notifications enabled (opt-out model)
const DEFAULTS = PREF_DEFAULTS;

/** Só os flags booleanos conhecidos de PREF_DEFAULTS (ignora o resto do corpo). */
function onlyBooleanFlags(input: Record<string, unknown>): Partial<Record<keyof typeof PREF_DEFAULTS, boolean>> {
  const out: Partial<Record<keyof typeof PREF_DEFAULTS, boolean>> = {};
  for (const key of Object.keys(PREF_DEFAULTS) as (keyof typeof PREF_DEFAULTS)[]) {
    if (typeof input[key] === "boolean") out[key] = input[key] as boolean;
  }
  return out;
}

/** @deprecated v0.79 — remover após 15/11/2026 (clientes antigos em cache). Use `getMyEffectivePreferences`. */
export const getMyPreferences = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("teamMemberId", userMember._id)
      )
      .first();

    if (!prefs) {
      return { ...DEFAULTS, _exists: false };
    }

    return {
      invite: prefs.invite,
      handoffRequested: prefs.handoffRequested,
      handoffResolved: prefs.handoffResolved,
      taskOverdue: prefs.taskOverdue,
      taskAssigned: prefs.taskAssigned,
      leadAssigned: prefs.leadAssigned,
      newMessage: prefs.newMessage,
      dailyDigest: prefs.dailyDigest,
      taskCommentMention: prefs.taskCommentMention ?? DEFAULTS.taskCommentMention,
      taskDueSoon: prefs.taskDueSoon ?? DEFAULTS.taskDueSoon,
      aiDraftPending: prefs.aiDraftPending ?? DEFAULTS.aiDraftPending,
      campaignCompleted: prefs.campaignCompleted ?? DEFAULTS.campaignCompleted,
      campaignPaused: prefs.campaignPaused ?? DEFAULTS.campaignPaused,
      groupJoined: prefs.groupJoined ?? DEFAULTS.groupJoined,
      groupMention: prefs.groupMention ?? DEFAULTS.groupMention,
      groupPostPending: prefs.groupPostPending ?? DEFAULTS.groupPostPending,
      groupPostFailed: prefs.groupPostFailed ?? DEFAULTS.groupPostFailed,
      groupOpportunity: prefs.groupOpportunity ?? DEFAULTS.groupOpportunity,
      groupDigest: prefs.groupDigest ?? DEFAULTS.groupDigest,
      aiFollowupNeedsHuman: prefs.aiFollowupNeedsHuman ?? DEFAULTS.aiFollowupNeedsHuman,
      conversationTransferred: prefs.conversationTransferred ?? DEFAULTS.conversationTransferred,
      channelSessionLost: prefs.channelSessionLost ?? DEFAULTS.channelSessionLost,
      aiSpendAlert: prefs.aiSpendAlert ?? DEFAULTS.aiSpendAlert,
      _id: prefs._id,
      _exists: true,
    };
  },
});

/** @deprecated v0.79 — remover após 15/11/2026 (clientes antigos em cache). Use `setChannelPref`/`setPreset`. */
export const updateMyPreferences = mutation({
  args: {
    organizationId: v.id("organizations"),
    invite: v.optional(v.boolean()),
    handoffRequested: v.optional(v.boolean()),
    handoffResolved: v.optional(v.boolean()),
    taskOverdue: v.optional(v.boolean()),
    taskAssigned: v.optional(v.boolean()),
    leadAssigned: v.optional(v.boolean()),
    newMessage: v.optional(v.boolean()),
    dailyDigest: v.optional(v.boolean()),
    taskCommentMention: v.optional(v.boolean()),
    taskDueSoon: v.optional(v.boolean()),
    aiDraftPending: v.optional(v.boolean()),
    campaignCompleted: v.optional(v.boolean()),
    campaignPaused: v.optional(v.boolean()),
    groupJoined: v.optional(v.boolean()),
    groupMention: v.optional(v.boolean()),
    groupPostPending: v.optional(v.boolean()),
    groupPostFailed: v.optional(v.boolean()),
    groupOpportunity: v.optional(v.boolean()),
    groupDigest: v.optional(v.boolean()),
    aiFollowupNeedsHuman: v.optional(v.boolean()),
    conversationTransferred: v.optional(v.boolean()),
    channelSessionLost: v.optional(v.boolean()),
    aiSpendAlert: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    // Porta única de escrita: só os flags enviados (o resto fica como está).
    const { organizationId: _org, ...flags } = args;
    await patchMemberPrefs(ctx, args.organizationId, userMember._id, onlyBooleanFlags(flags), Date.now());
    return null;
  },
});

/** @deprecated v0.79 — remover após 15/11/2026 (sem uso no app). Exige `team:manage`. */
export const getMemberPreferences = query({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "team", "manage");

    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("teamMemberId", args.teamMemberId)
      )
      .first();

    if (!prefs) {
      return { ...DEFAULTS, _exists: false };
    }

    return prefs;
  },
});

// Internal: Check if a member wants a specific event type notification
export const shouldNotify = internalQuery({
  args: {
    teamMemberId: v.id("teamMembers"),
    eventType: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Invite is always sent
    if (args.eventType === "invite") return true;

    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_member", (q) => q.eq("teamMemberId", args.teamMemberId))
      .first();

    // No row means all enabled (opt-out model)
    if (!prefs) return true;

    return (prefs as any)[args.eventType] !== false;
  },
});

// Internal: Get preferences for API key context
export const internalGetPreferences = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) =>
        q.eq("organizationId", args.organizationId).eq("teamMemberId", args.teamMemberId)
      )
      .first();

    const org = await ctx.db.get(args.organizationId);
    const orgPreset = orgDefaultsOf(org)?.preset;
    const defaultQuietHours = {
      enabled: false,
      start: DEFAULT_QUIET_START,
      end: DEFAULT_QUIET_END,
      timeZone: safeTimezone(org?.settings.timezone),
    };

    if (!prefs) {
      return {
        ...DEFAULTS,
        preset: orgPreset ?? "all",
        channels: {},
        pausedUntil: null,
        quietHours: defaultQuietHours,
        _exists: false,
      };
    }

    return {
      invite: prefs.invite,
      handoffRequested: prefs.handoffRequested,
      handoffResolved: prefs.handoffResolved,
      taskOverdue: prefs.taskOverdue,
      taskAssigned: prefs.taskAssigned,
      leadAssigned: prefs.leadAssigned,
      newMessage: prefs.newMessage,
      dailyDigest: prefs.dailyDigest,
      taskCommentMention: prefs.taskCommentMention ?? DEFAULTS.taskCommentMention,
      taskDueSoon: prefs.taskDueSoon ?? DEFAULTS.taskDueSoon,
      aiDraftPending: prefs.aiDraftPending ?? DEFAULTS.aiDraftPending,
      campaignCompleted: prefs.campaignCompleted ?? DEFAULTS.campaignCompleted,
      campaignPaused: prefs.campaignPaused ?? DEFAULTS.campaignPaused,
      groupJoined: prefs.groupJoined ?? DEFAULTS.groupJoined,
      groupMention: prefs.groupMention ?? DEFAULTS.groupMention,
      groupPostPending: prefs.groupPostPending ?? DEFAULTS.groupPostPending,
      groupPostFailed: prefs.groupPostFailed ?? DEFAULTS.groupPostFailed,
      groupOpportunity: prefs.groupOpportunity ?? DEFAULTS.groupOpportunity,
      groupDigest: prefs.groupDigest ?? DEFAULTS.groupDigest,
      aiFollowupNeedsHuman: prefs.aiFollowupNeedsHuman ?? DEFAULTS.aiFollowupNeedsHuman,
      conversationTransferred: prefs.conversationTransferred ?? DEFAULTS.conversationTransferred,
      channelSessionLost: prefs.channelSessionLost ?? DEFAULTS.channelSessionLost,
      aiSpendAlert: prefs.aiSpendAlert ?? DEFAULTS.aiSpendAlert,
      // Modelo atual (aditivo): flags = canais externos; o sino de tipo acionável registra sempre.
      preset: prefs.preset ?? orgPreset ?? "all",
      channels: prefs.channels ?? {},
      pausedUntil: prefs.pausedUntil ?? null,
      quietHours: prefs.quietHours ?? defaultQuietHours,
      _exists: true,
    };
  },
});

// Internal: Upsert preferences from API key context (mutation — can write)
export const internalUpsertPreferences = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    updates: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // REST/MCP: mesma porta de escrita do app; só flags booleanos conhecidos entram.
    await patchMemberPrefs(ctx, args.organizationId, args.teamMemberId, onlyBooleanFlags(args.updates ?? {}), Date.now());
    return null;
  },
});

// ---------------------------------------------------------------------------
// C1 — preferências por canal, pausa, silêncio, "aplicar a todas as organizações"
// ---------------------------------------------------------------------------

const channelValidator = v.union(v.literal("email"), v.literal("telegram"), v.literal("push"));
const channelMapValidator = v.record(v.string(), v.boolean());
const quietHoursResolvedValidator = v.object({
  enabled: v.boolean(),
  start: v.string(),
  end: v.string(),
  timeZone: v.string(),
});

/** Teto de uma pausa personalizada. */
const MAX_PAUSE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Preferências EFETIVAS do membro (padrões aplicados) — a forma que a tela (C2) consome.
 * `channels[canal][flag]` já considera flag antigo, preset do membro/da org e escolha
 * explícita; `bell` mostra o que o sino registra (acionáveis sempre `true`). Pausa e
 * silêncio ficam à parte: comparar `pausedUntil` com o relógio do cliente.
 */
export const getMyEffectivePreferences = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    preset: notifPresetValidator,
    presetSource: v.union(v.literal("member"), v.literal("org"), v.literal("default")),
    /** Flags antigos resolvidos (todos presentes, `true` = ligado). */
    flags: v.record(v.string(), v.boolean()),
    channels: v.object({
      bell: channelMapValidator,
      email: channelMapValidator,
      telegram: channelMapValidator,
      push: channelMapValidator,
    }),
    actionableFlags: v.array(v.string()),
    /** Fim da pausa (do app ou do `/pausar`), ou null. Pausado agora = `pausedUntil > Date.now()` no cliente. */
    pausedUntil: v.union(v.number(), v.null()),
    quietHours: quietHoursResolvedValidator,
    urgentBypass: v.boolean(),
    showPreview: v.boolean(),
    /** A org pede para ocultar a prévia na tela de bloqueio (vence `showPreview`). */
    orgHidePreview: v.boolean(),
    effectiveShowPreview: v.boolean(),
    orgDefaults: v.object({ preset: v.union(notifPresetValidator, v.null()), hidePreviewOnLockScreen: v.boolean() }),
  }),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const org = await ctx.db.get(args.organizationId);
    const prefs = await loadMemberPrefs(ctx, args.organizationId, member._id);
    const orgDefaults = orgDefaultsOf(org);
    const link = await ctx.db
      .query("telegramLinks")
      .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", member._id).eq("status", "active"))
      .first();

    const flags: Record<string, boolean> = {};
    const channels = { bell: {}, email: {}, telegram: {}, push: {} } as Record<
      "bell" | ExternalChannel,
      Record<string, boolean>
    >;
    for (const flag of KNOWN_FLAGS) {
      flags[flag] = (prefs as Record<string, unknown> | null)?.[flag] !== false;
      for (const channel of ["bell", "email", "telegram", "push"] as const) {
        channels[channel][flag] = channelAllows(flag, channel, prefs, orgDefaults);
      }
    }
    const pausedUntil = Math.max(prefs?.pausedUntil ?? 0, link?.mutedUntil ?? 0);
    const orgHidePreview = orgDefaults?.hidePreviewOnLockScreen === true;
    const showPreview = prefs?.showPreview ?? true;
    return {
      preset: prefs?.preset ?? orgDefaults?.preset ?? "all",
      presetSource: prefs?.preset ? ("member" as const) : orgDefaults?.preset ? ("org" as const) : ("default" as const),
      flags,
      channels,
      actionableFlags: [...ACTIONABLE_FLAGS],
      pausedUntil: pausedUntil > 0 ? pausedUntil : null,
      quietHours: prefs?.quietHours ?? {
        enabled: false,
        start: DEFAULT_QUIET_START,
        end: DEFAULT_QUIET_END,
        timeZone: safeTimezone(org?.settings.timezone),
      },
      urgentBypass: prefs?.urgentBypass ?? true,
      showPreview,
      orgHidePreview,
      effectiveShowPreview: showPreview && !orgHidePreview,
      orgDefaults: { preset: orgDefaults?.preset ?? null, hidePreviewOnLockScreen: orgHidePreview },
    };
  },
});

/**
 * Atalho Tudo / Só o que é comigo / Nada: grava o preset e ZERA as personalizações
 * (`channels` e flags antigos voltam a ligado) — o atalho é "recomeçar daqui".
 */
export const setPreset = mutation({
  args: { organizationId: v.id("organizations"), preset: notifPresetValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    await patchMemberPrefs(
      ctx,
      args.organizationId,
      member._id,
      { ...PREF_DEFAULTS, preset: args.preset, channels: undefined },
      Date.now()
    );
    return null;
  },
});

/** Liga/desliga um tipo de aviso em UM canal externo (o sino de acionáveis não é desligável). */
export const setChannelPref = mutation({
  args: {
    organizationId: v.id("organizations"),
    channel: channelValidator,
    flag: v.string(),
    enabled: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    if (!KNOWN_FLAGS.includes(args.flag)) throw new ConvexError("Tipo de aviso desconhecido");
    const existing = await loadMemberPrefs(ctx, args.organizationId, member._id);
    const channels = {
      ...(existing?.channels ?? {}),
      [args.channel]: { ...(existing?.channels?.[args.channel] ?? {}), [args.flag]: args.enabled },
    };
    // Tipo informativo: Telegram/push dependem do sino. Ligar um canal também liga o flag
    // antigo (o sino) para a escolha ter efeito.
    const reviveBell =
      args.enabled &&
      !ACTIONABLE_FLAGS.includes(args.flag) &&
      (existing as Record<string, unknown> | null)?.[args.flag] === false;
    // Religar o flag antigo (sino) por Telegram/push não pode trazer o e-mail do tipo junto:
    // sem escolha explícita de e-mail, ele fica desligado (como o flag antigo `false` o deixava).
    if (reviveBell && args.channel !== "email" && channels.email?.[args.flag] === undefined) {
      channels.email = { ...(channels.email ?? {}), [args.flag]: false };
    }
    await patchMemberPrefs(
      ctx,
      args.organizationId,
      member._id,
      { channels, ...(reviveBell ? { [args.flag]: true } : {}) },
      Date.now()
    );
    return null;
  },
});

/** Pausar avisos externos (o sino segue registrando). `tomorrow` = amanhã 08:00 no fuso da org. */
export const pauseFor = mutation({
  args: {
    organizationId: v.id("organizations"),
    mode: v.union(v.literal("1h"), v.literal("4h"), v.literal("tomorrow"), v.literal("custom")),
    /** Só com `mode: "custom"`: instante (ms) futuro, até 30 dias. */
    until: v.optional(v.number()),
  },
  returns: v.object({ pausedUntil: v.number() }),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const now = Date.now();
    let until: number;
    if (args.mode === "1h") until = now + 60 * 60 * 1000;
    else if (args.mode === "4h") until = now + 4 * 60 * 60 * 1000;
    else if (args.mode === "tomorrow") {
      const org = await ctx.db.get(args.organizationId);
      until = tomorrowAt(now, safeTimezone(org?.settings.timezone), 8);
    } else {
      if (args.until === undefined || !Number.isFinite(args.until)) throw new ConvexError("Informe até quando pausar");
      until = Math.floor(args.until);
    }
    if (until <= now || until > now + MAX_PAUSE_MS) throw new ConvexError("A pausa deve terminar nos próximos 30 dias");
    await patchMemberPrefs(ctx, args.organizationId, member._id, { pausedUntil: until }, now);
    return { pausedUntil: until };
  },
});

/** Retomar os avisos: limpa `pausedUntil` e o `mutedUntil` legado do vínculo do Telegram. */
export const resume = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const existing = await loadMemberPrefs(ctx, args.organizationId, member._id);
    if (existing?.pausedUntil !== undefined) {
      await patchMemberPrefs(ctx, args.organizationId, member._id, { pausedUntil: undefined }, Date.now());
    }
    const link = await ctx.db
      .query("telegramLinks")
      .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", member._id).eq("status", "active"))
      .first();
    if (link && link.organizationId === args.organizationId && link.mutedUntil !== undefined) {
      await ctx.db.patch(link._id, { mutedUntil: undefined });
    }
    return null;
  },
});

/** Horário de silêncio no fuso do membro (padrão sugerido 21:00–08:00, desligado). */
export const setQuietHours = mutation({
  args: {
    organizationId: v.id("organizations"),
    enabled: v.boolean(),
    start: v.optional(v.string()),
    end: v.optional(v.string()),
    timeZone: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const existing = await loadMemberPrefs(ctx, args.organizationId, member._id);
    const org = await ctx.db.get(args.organizationId);
    const quietHours = {
      enabled: args.enabled,
      start: args.start ?? existing?.quietHours?.start ?? DEFAULT_QUIET_START,
      end: args.end ?? existing?.quietHours?.end ?? DEFAULT_QUIET_END,
      timeZone: args.timeZone ?? existing?.quietHours?.timeZone ?? safeTimezone(org?.settings.timezone),
    };
    if (!isValidHHMM(quietHours.start) || !isValidHHMM(quietHours.end)) {
      throw new ConvexError("Horário inválido — use HH:MM");
    }
    if (quietHours.enabled && quietHours.start === quietHours.end) {
      throw new ConvexError("O início e o fim do silêncio não podem ser o mesmo horário");
    }
    if (!isValidTimeZone(quietHours.timeZone)) throw new ConvexError("Fuso horário inválido");
    await patchMemberPrefs(ctx, args.organizationId, member._id, { quietHours }, Date.now());
    return null;
  },
});

/** "Pedido de ajuda urgente fura pausa e silêncio" (padrão ligado). */
export const setUrgentBypass = mutation({
  args: { organizationId: v.id("organizations"), urgentBypass: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    await patchMemberPrefs(ctx, args.organizationId, member._id, { urgentBypass: args.urgentBypass }, Date.now());
    return null;
  },
});

/** "Mostrar prévia na tela de bloqueio" (padrão ligado; a política da org pode vetar). */
export const setShowPreview = mutation({
  args: { organizationId: v.id("organizations"), showPreview: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    await patchMemberPrefs(ctx, args.organizationId, member._id, { showPreview: args.showPreview }, Date.now());
    return null;
  },
});

/**
 * "Aplicar a todas as minhas organizações": copia preset, canais, flags, silêncio,
 * urgente e prévia de `sourceOrganizationId` para o vínculo ativo do usuário em cada
 * outra org. NÃO copia a pausa (é temporária). Cada org passa por `requireAuth`.
 */
export const applyToAllMyOrgs = mutation({
  args: { sourceOrganizationId: v.id("organizations") },
  returns: v.object({ applied: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const sourceMember = await requireAuth(ctx, args.sourceOrganizationId);
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const source = await loadMemberPrefs(ctx, args.sourceOrganizationId, sourceMember._id);
    const now = Date.now();
    const patch: PrefsPatch = { ...PREF_DEFAULTS, preset: undefined, channels: undefined, quietHours: undefined, urgentBypass: undefined, showPreview: undefined };
    if (source) {
      for (const flag of Object.keys(PREF_DEFAULTS) as (keyof typeof PREF_DEFAULTS)[]) patch[flag] = source[flag] ?? true;
      patch.preset = source.preset;
      patch.channels = source.channels;
      patch.quietHours = source.quietHours;
      patch.urgentBypass = source.urgentBypass;
      patch.showPreview = source.showPreview;
    }

    const memberships = await ctx.db
      .query("teamMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);
    const seen = new Set<string>([args.sourceOrganizationId]);
    let applied = 0;
    let skipped = 0;
    for (const m of memberships) {
      if (isMembershipRevoked(m) || m.type !== "human" || seen.has(m.organizationId)) continue;
      seen.add(m.organizationId);
      try {
        const target = await requireAuth(ctx, m.organizationId);
        await patchMemberPrefs(ctx, m.organizationId, target._id, patch, now);
        applied++;
      } catch {
        skipped++; // uma org problemática não derruba as demais
      }
    }
    return { applied, skipped };
  },
});
