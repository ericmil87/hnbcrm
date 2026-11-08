/**
 * Web Push (E1): assinaturas por aparelho, vínculo por membership e a entrega.
 *
 * Público (o app chama; F1):
 *  - `getVapidPublicKey` — chave pública do deployment (null = push desligado).
 *  - `subscribe` — upsert por endpoint + vínculo à membership da org ativa.
 *  - `unsubscribe` — tira o vínculo desta org (último vínculo = assinatura sai).
 *  - `getMyDevices` / `removeDevice` — "Meus aparelhos".
 *
 * Interno: `internalDeliverPush` (agendado SÓ pelo dispatcher
 * `lib/notificationChannels.ts`) decide e monta o payload numa mutation;
 * `pushNode.internalSendPush` ("use node") envia; `internalRecordPushResults`
 * volta com o resultado (apaga 404/410, reagenda 429/5xx, contadores).
 */
import { v, ConvexError } from "convex/values";
import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth, isMembershipRevoked } from "./lib/auth";
import { loadMemberPrefs, orgDefaultsOf } from "./lib/notificationPrefs";
import { shouldDeliver } from "./lib/notificationPolicy";
import { hasPermission, resolvePermissions, type Role, type Permissions } from "./lib/permissions";
import { appUrl } from "./lib/appUrl";
import { truncateGraphemes } from "./lib/notificationCopy";
import {
  buildPushPayload,
  cleanUserAgentLabel,
  isAllowedPushEndpoint,
  isValidSubscriptionKeys,
  pushRequestOptions,
  pushTagOf,
  renotifyOf,
  retryDelayMs,
  PUSH_BADGE_CAP,
  PUSH_MAX_ATTEMPTS,
  PUSH_MAX_DEVICES,
  PUSH_TOUCH_MS,
} from "./lib/webPush";
import { bumpPushStat, deletePushSubscription, unlinkPushSubscriptionMember } from "./lib/pushStore";

const platformValidator = v.union(v.literal("android"), v.literal("ios"), v.literal("desktop"), v.literal("other"));
const outcomeValidator = v.union(
  v.literal("sent"),
  v.literal("gone"),
  v.literal("too_large"),
  v.literal("retry"),
  v.literal("failed")
);

/** Re-sync do app grava `lastSeenAt` no máximo 1×/hora (I/O). */
const SUBSCRIBE_TOUCH_MS = 60 * 60_000;
/** Tipos cujo texto é conteúdo de conversa: exigem `inbox:view_own` (como no Telegram). */
const CONVERSATION_CONTENT_TYPES = new Set(["new_message", "ai_draft_pending", "group_mention", "handoff_requested", "conversation_transferred"]);

// ---------------------------------------------------------------------------
// Público
// ---------------------------------------------------------------------------

export const getVapidPublicKey = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async () => {
    const key = process.env.VAPID_PUBLIC_KEY?.trim();
    return key ? key : null;
  },
});

export const subscribe = mutation({
  args: {
    organizationId: v.id("organizations"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    platform: platformValidator,
    userAgentLabel: v.optional(v.string()),
  },
  returns: v.object({ subscriptionId: v.id("pushSubscriptions"), reassigned: v.boolean() }),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const userId = member.userId;
    if (!userId || member.type !== "human") throw new ConvexError("Só pessoas da equipe recebem avisos no aparelho");
    const endpoint = args.endpoint.trim();
    if (!isAllowedPushEndpoint(endpoint)) throw new ConvexError("Este navegador usa um serviço de avisos que não é suportado");
    if (!isValidSubscriptionKeys(args.p256dh, args.auth)) throw new ConvexError("Assinatura de avisos inválida");
    const now = Date.now();
    const label = cleanUserAgentLabel(args.userAgentLabel);

    let subscriptionId: Id<"pushSubscriptions">;
    let reassigned = false;
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .first();
    if (existing && existing.userId !== userId) {
      // Troca de conta no mesmo aparelho/navegador: o endpoint passa a ser do
      // novo usuário e NENHUM vínculo do anterior sobrevive (ele não recebe
      // mais nada aqui; o outro usuário não herda as orgs dele).
      await deletePushSubscription(ctx, existing._id);
      reassigned = true;
    }
    if (existing && !reassigned) {
      subscriptionId = existing._id;
      const changed =
        existing.p256dh !== args.p256dh ||
        existing.auth !== args.auth ||
        existing.platform !== args.platform ||
        existing.userAgentLabel !== label;
      if (changed || now - (existing.lastSeenAt ?? 0) > SUBSCRIBE_TOUCH_MS) {
        await ctx.db.patch(existing._id, {
          p256dh: args.p256dh,
          auth: args.auth,
          platform: args.platform,
          userAgentLabel: label,
          lastSeenAt: now,
        });
      }
    } else {
      subscriptionId = await ctx.db.insert("pushSubscriptions", {
        userId,
        endpoint,
        p256dh: args.p256dh,
        auth: args.auth,
        platform: args.platform,
        ...(label ? { userAgentLabel: label } : {}),
        createdAt: now,
        lastSeenAt: now,
      });
    }

    const memberLinks = await ctx.db
      .query("pushSubscriptionMembers")
      .withIndex("by_member", (q) => q.eq("teamMemberId", member._id))
      .take(PUSH_MAX_DEVICES + 5);
    if (!memberLinks.some((l) => l.subscriptionId === subscriptionId)) {
      await ctx.db.insert("pushSubscriptionMembers", {
        organizationId: args.organizationId,
        teamMemberId: member._id,
        subscriptionId,
        createdAt: now,
      });
      // Teto de aparelhos por membro: o vínculo mais antigo sai.
      const overflow = memberLinks.length + 1 - PUSH_MAX_DEVICES;
      if (overflow > 0) {
        const oldest = [...memberLinks].sort((a, b) => a.createdAt - b.createdAt).slice(0, overflow);
        for (const link of oldest) await unlinkPushSubscriptionMember(ctx, link);
      }
    }
    return { subscriptionId, reassigned };
  },
});

export const unsubscribe = mutation({
  args: { organizationId: v.id("organizations"), endpoint: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const sub = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint.trim()))
      .first();
    if (!sub || sub.userId !== member.userId) return { removed: false };
    const links = await ctx.db
      .query("pushSubscriptionMembers")
      .withIndex("by_subscription", (q) => q.eq("subscriptionId", sub._id))
      .take(100);
    const mine = links.find((l) => l.teamMemberId === member._id);
    if (!mine) return { removed: false };
    await unlinkPushSubscriptionMember(ctx, mine);
    return { removed: true };
  },
});

const deviceValidator = v.object({
  subscriptionId: v.id("pushSubscriptions"),
  platform: platformValidator,
  userAgentLabel: v.union(v.string(), v.null()),
  createdAt: v.number(),
  lastSeenAt: v.union(v.number(), v.null()),
  /** Recebe avisos DESTA org. */
  linkedHere: v.boolean(),
  /** É o aparelho que perguntou (`currentEndpoint`). */
  isCurrent: v.boolean(),
});

export const getMyDevices = query({
  args: { organizationId: v.id("organizations"), currentEndpoint: v.optional(v.string()) },
  returns: v.array(deviceValidator),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    if (!member.userId) return [];
    const userId = member.userId;
    const [subs, links] = await Promise.all([
      ctx.db.query("pushSubscriptions").withIndex("by_user", (q) => q.eq("userId", userId)).take(30),
      ctx.db.query("pushSubscriptionMembers").withIndex("by_member", (q) => q.eq("teamMemberId", member._id)).take(30),
    ]);
    const linked = new Set(links.map((l) => l.subscriptionId));
    const current = args.currentEndpoint?.trim();
    return subs
      .map((s) => ({
        subscriptionId: s._id,
        platform: s.platform,
        userAgentLabel: s.userAgentLabel ?? null,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt ?? null,
        linkedHere: linked.has(s._id),
        isCurrent: current !== undefined && current === s.endpoint,
      }))
      .sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt));
  },
});

/** Remove o aparelho de TODAS as orgs do usuário (ele é o dono da assinatura). */
export const removeDevice = mutation({
  args: { organizationId: v.id("organizations"), subscriptionId: v.id("pushSubscriptions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const sub = await ctx.db.get(args.subscriptionId);
    if (!sub || sub.userId !== member.userId) throw new ConvexError("Aparelho não encontrado");
    await deletePushSubscription(ctx, sub._id);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Entrega
// ---------------------------------------------------------------------------

function memberAlive(member: Doc<"teamMembers"> | null, organizationId: Id<"organizations">): member is Doc<"teamMembers"> {
  return !!member && member.type === "human" && member.organizationId === organizationId && !!member.userId && !isMembershipRevoked(member);
}

/**
 * Decide e monta o push de UM aviso para os aparelhos do membro (≤ 10). Relê
 * tudo na hora: lido → não envia (conta `suppressed_read`); membro vivo da
 * org; política (pausa/silêncio/canal); prévia (membro × org × 413).
 */
export const internalDeliverPush = internalMutation({
  args: {
    notificationId: v.id("notifications"),
    attempt: v.optional(v.number()),
    /** Reenvio: só estas assinaturas (as que deram 429/5xx). */
    subscriptionIds: v.optional(v.array(v.id("pushSubscriptions"))),
    noPreview: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.notificationId);
    if (!n) return null;
    const now = Date.now();
    const stat = (outcome: string) =>
      bumpPushStat(ctx, { organizationId: n.organizationId, type: n.type, outcome, shardKey: n._id, now });
    if (n.readAt) {
      await stat("suppressed_read");
      return null;
    }
    const tag = pushTagOf({ ...n, _id: n._id });
    const options = pushRequestOptions(n.type, tag);
    if (!options) return null;
    const member = await ctx.db.get(n.memberId);
    if (!memberAlive(member, n.organizationId)) return null;
    const org = await ctx.db.get(n.organizationId);
    if (!org) return null;
    if (n.conversationId && CONVERSATION_CONTENT_TYPES.has(n.type)) {
      const perms = resolvePermissions(member.role as Role, member.permissions as Permissions | undefined);
      if (!hasPermission(perms, "inbox", "view_own")) return null;
    }
    const prefs = await loadMemberPrefs(ctx, n.organizationId, member._id);
    const decision = shouldDeliver({ type: n.type, channel: "push", prefs, orgDefaults: orgDefaultsOf(org), now });
    if (decision !== "deliver") {
      await stat(decision === "off" ? "suppressed_off" : "suppressed_hold");
      return null;
    }

    const links = await ctx.db
      .query("pushSubscriptionMembers")
      .withIndex("by_member", (q) => q.eq("teamMemberId", member._id))
      .take(PUSH_MAX_DEVICES);
    const only = args.subscriptionIds ? new Set(args.subscriptionIds) : null;
    const subscriptionIds: Id<"pushSubscriptions">[] = [];
    for (const link of links) {
      if (link.organizationId !== n.organizationId) continue;
      if (only && !only.has(link.subscriptionId)) continue;
      const sub = await ctx.db.get(link.subscriptionId);
      if (!sub) {
        await ctx.db.delete(link._id);
        continue;
      }
      // Defesa: a assinatura é do USUÁRIO do membro (troca de conta já limpa os vínculos).
      if (sub.userId !== member.userId) {
        await unlinkPushSubscriptionMember(ctx, link);
        continue;
      }
      subscriptionIds.push(sub._id);
    }
    if (subscriptionIds.length === 0) return null;

    // Só ids nos args agendados: endpoint, chaves e o texto (prévia de conversa)
    // são lidos pela action em `internalGetPushSendPlan` na hora do envio.
    await ctx.scheduler.runAfter(0, internal.pushNode.internalSendPush, {
      notificationId: n._id,
      subscriptionIds,
      attempt: args.attempt ?? 1,
      ...(args.noPreview ? { noPreview: true } : {}),
    });
    return null;
  },
});

const sendPlanValidator = v.union(
  v.object({ skip: v.literal("read"), organizationId: v.id("organizations"), type: v.string() }),
  v.object({ skip: v.literal("gone") }),
  v.object({
    skip: v.null(),
    organizationId: v.id("organizations"),
    type: v.string(),
    targets: v.array(
      v.object({ subscriptionId: v.id("pushSubscriptions"), endpoint: v.string(), p256dh: v.string(), auth: v.string() })
    ),
    payload: v.string(),
    fallbackPayload: v.union(v.string(), v.null()),
    ttlSeconds: v.number(),
    urgency: v.union(v.literal("very-low"), v.literal("low"), v.literal("normal"), v.literal("high")),
    topic: v.string(),
  })
);

/**
 * Lido pela action no início do envio: alvos (endpoint/chaves) e payload
 * montados aqui, nunca guardados em args de função agendada. Relê `readAt` e
 * o membro (a política com relógio ficou na mutation que agendou).
 */
export const internalGetPushSendPlan = internalQuery({
  args: {
    notificationId: v.id("notifications"),
    subscriptionIds: v.array(v.id("pushSubscriptions")),
    noPreview: v.optional(v.boolean()),
  },
  returns: sendPlanValidator,
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.notificationId);
    if (!n) return { skip: "gone" as const };
    if (n.readAt) return { skip: "read" as const, organizationId: n.organizationId, type: n.type };
    const options = pushRequestOptions(n.type, pushTagOf({ ...n, _id: n._id }));
    const member = await ctx.db.get(n.memberId);
    const org = await ctx.db.get(n.organizationId);
    if (!options || !memberAlive(member, n.organizationId) || !org) return { skip: "gone" as const };
    const targets: { subscriptionId: Id<"pushSubscriptions">; endpoint: string; p256dh: string; auth: string }[] = [];
    for (const id of args.subscriptionIds.slice(0, PUSH_MAX_DEVICES)) {
      const sub = await ctx.db.get(id);
      if (sub && sub.userId === member.userId) {
        targets.push({ subscriptionId: sub._id, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth });
      }
    }
    if (targets.length === 0) return { skip: "gone" as const };

    const prefs = await loadMemberPrefs(ctx, n.organizationId, member._id);
    const memberPrefsPreview = prefs?.showPreview ?? true;
    const orgHides = org.settings.notificationDefaults?.hidePreviewOnLockScreen === true;
    const showPreview = !args.noPreview && memberPrefsPreview && !orgHides;
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_member_and_read", (q) => q.eq("memberId", member._id).eq("readAt", undefined))
      .take(PUSH_BADGE_CAP);
    const memberships = await ctx.db
      .query("teamMembers")
      .withIndex("by_user", (q) => q.eq("userId", member.userId))
      .take(10);
    const multiOrg = memberships.filter((m) => !isMembershipRevoked(m)).length > 1;
    const common = {
      notification: { ...n, _id: n._id as string, organizationId: n.organizationId as string },
      appBaseUrl: appUrl(),
      orgLabel: multiOrg ? truncateGraphemes(org.name, 24) : undefined,
      badge: unread.length,
      renotify: renotifyOf(n.data),
    };
    const payload = buildPushPayload({ ...common, showPreview });
    const fallback = showPreview && payload.notification.body ? buildPushPayload({ ...common, showPreview: false }) : null;
    return {
      skip: null,
      organizationId: n.organizationId,
      type: n.type,
      targets,
      payload: JSON.stringify(payload),
      fallbackPayload: fallback ? JSON.stringify(fallback) : null,
      ttlSeconds: options.ttlSeconds,
      urgency: options.urgency,
      topic: options.topic,
    };
  },
});

/** Volta da action: limpa assinatura morta, reagenda o que pode voltar, conta. */
export const internalRecordPushResults = internalMutation({
  args: {
    notificationId: v.id("notifications"),
    organizationId: v.id("organizations"),
    type: v.string(),
    attempt: v.number(),
    results: v.array(
      v.object({
        subscriptionId: v.id("pushSubscriptions"),
        outcome: outcomeValidator,
        /** 413 resolvido reenviando sem prévia. */
        withoutPreview: v.optional(v.boolean()),
        retryAfterMs: v.optional(v.number()),
      })
    ),
    /** Sem VAPID válido no deployment: nada saiu, nenhuma assinatura tocada. */
    notConfigured: v.optional(v.boolean()),
    /** Lido entre o agendamento e o envio. */
    suppressedRead: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const base = { organizationId: args.organizationId, type: args.type, shardKey: args.notificationId, now };
    if (args.notConfigured) {
      await bumpPushStat(ctx, { ...base, outcome: "not_configured" });
      return null;
    }
    if (args.suppressedRead) {
      await bumpPushStat(ctx, { ...base, outcome: "suppressed_read" });
      return null;
    }
    const counts = new Map<string, number>();
    const retry: Id<"pushSubscriptions">[] = [];
    let retryAfter = 0;
    for (const r of args.results) {
      counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
      if (r.withoutPreview) counts.set("sent_without_preview", (counts.get("sent_without_preview") ?? 0) + 1);
      if (r.outcome === "gone") {
        await deletePushSubscription(ctx, r.subscriptionId);
      } else if (r.outcome === "sent") {
        const sub = await ctx.db.get(r.subscriptionId);
        if (sub && now - (sub.lastSeenAt ?? 0) > PUSH_TOUCH_MS) await ctx.db.patch(sub._id, { lastSeenAt: now });
      } else if (r.outcome === "retry") {
        retry.push(r.subscriptionId);
        retryAfter = Math.max(retryAfter, r.retryAfterMs ?? 0);
      }
    }
    for (const [outcome, by] of counts) await bumpPushStat(ctx, { ...base, outcome, by });
    if (retry.length > 0) {
      const delay = retryDelayMs(args.attempt, retryAfter || undefined);
      if (delay === null || args.attempt >= PUSH_MAX_ATTEMPTS) {
        await bumpPushStat(ctx, { ...base, outcome: "retry_exhausted", by: retry.length });
      } else {
        await ctx.scheduler.runAfter(delay, internal.push.internalDeliverPush, {
          notificationId: args.notificationId,
          attempt: args.attempt + 1,
          subscriptionIds: retry,
        });
      }
    }
    return null;
  },
});
