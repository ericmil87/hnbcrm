/**
 * Foto de perfil do GRUPO do WhatsApp (bridge): mesmo gateway (`POST /user/avatar` com o
 * JID `@g.us`), mesmas validações de download e mesmo ritmo/teto por canal do contato
 * (`channelAvatarPacing`, teto diário compartilhado). Guarda o ARQUIVO no storage e
 * escreve `conversations.groupAvatarUrl` (o que a lista lê) SÓ quando a URL muda.
 *
 * Agendamento só por `maybeScheduleGroupAvatar` (lib/groupAvatarOps.ts). A action nunca
 * lança por problema de gateway e nunca loga JID nem URL. NÃO medido com grupo real:
 * qualquer erro (inclusive 401 de comunidade) vira `error`/`none` sem insistir.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/secretCrypto";
import { fetchGatewayAvatar } from "./lib/avatarFetch";
import {
  AVATAR_ABSENT_RENEW_MS,
  AVATAR_CONFIG_SKIP_BACKOFF_MS,
  AVATAR_REFUSED_BACKOFF_MS,
  avatarPauseMs,
  computeNextCheckAt,
  pacingAfterAvatarError,
} from "./lib/contactAvatar";
import { classifyAvatarChannel } from "./lib/contactAvatarOps";
import { groupAvatarConversationPatch } from "./lib/groupAvatar";
import { dropGroupAvatarFile, scheduleGroupAvatarFetch, stampGroupAvatar } from "./lib/groupAvatarOps";
import { checkAvatarQuota } from "./lib/fileQuotas";
import { deleteFileRow, insertFileRow } from "./lib/storageUsage";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";
import { noteGatewaySuccess } from "./contactAvatar";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

const keyArgs = {
  organizationId: v.id("organizations"),
  groupChatId: v.id("groupChats"),
  channelConfigId: v.id("channelConfigs"),
};

export const internalMaybeScheduleGroup = internalMutation({
  args: { organizationId: v.id("organizations"), groupChatId: v.id("groupChats") },
  returns: v.string(),
  handler: async (ctx, args) => await scheduleGroupAvatarFetch(ctx, args),
});

export const internalGetGroupAvatarPlan = internalQuery({
  args: keyArgs,
  returns: v.union(
    v.null(),
    v.object({
      baseUrl: v.string(),
      tokenEncrypted: v.string(),
      jid: v.string(),
      pictureId: v.union(v.string(), v.null()),
      hasBlob: v.boolean(),
      pausedUntil: v.union(v.number(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupChatId);
    if (!group || group.organizationId !== args.organizationId || !group.jid.endsWith("@g.us")) return null;
    if (!group.monitored || group.removedAt !== undefined || group.leftAt !== undefined) return null;
    const config = await ctx.db.get(args.channelConfigId);
    if (classifyAvatarChannel(config, args.organizationId) !== "ok") return null;
    if (!config || !config.bridgeBaseUrl || !config.bridgeTokenEncrypted) return null;
    const row = await ctx.db
      .query("groupAvatars")
      .withIndex("by_group_chat", (q) => q.eq("groupChatId", args.groupChatId))
      .first();
    if (!row || row.organizationId !== args.organizationId || row.pendingSince === undefined) return null;
    const pacing = await ctx.db
      .query("channelAvatarPacing")
      .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
      .first();
    return {
      baseUrl: config.bridgeBaseUrl,
      tokenEncrypted: config.bridgeTokenEncrypted,
      jid: group.jid,
      pictureId: row.pictureId ?? null,
      hasBlob: !!row.fileId,
      pausedUntil: pacing?.pausedUntil ?? null,
    };
  },
});

type Outcome = "same" | "hidden" | "none" | "error" | "rate_limited" | "skipped" | "paused" | "refused";

export const internalFetchGroupAvatar = internalAction({
  args: keyArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = async (outcome: Outcome) => {
      try {
        await ctx.runMutation(internal.groupAvatar.internalRecordGroupAvatarCheck, { ...args, outcome });
      } catch {
        /* a linha vence sozinha em 10 min (pendingSince) */
      }
    };
    let storedId: Id<"_storage"> | null = null;
    try {
      const plan = await ctx.runQuery(internal.groupAvatar.internalGetGroupAvatarPlan, args);
      if (!plan) {
        await record("skipped");
        return null;
      }
      if (plan.pausedUntil !== null && plan.pausedUntil > Date.now()) {
        await record("paused");
        return null;
      }
      const token = await decryptSecret(plan.tokenEncrypted);
      const result = await fetchGatewayAvatar({
        baseUrl: plan.baseUrl,
        token,
        target: plan.jid,
        pictureId: plan.pictureId,
        hasBlob: plan.hasBlob,
      });
      if (result.kind === "outcome") {
        await record(result.outcome);
        return null;
      }
      storedId = await ctx.storage.store(new Blob([result.image.bytes], { type: result.image.mime }));
      await ctx.runMutation(internal.groupAvatar.internalApplyGroupAvatar, {
        ...args,
        storageId: storedId,
        mimeType: result.image.mime,
        size: result.image.size,
        ...(result.pictureId ? { pictureId: result.pictureId } : {}),
      });
      storedId = null;
    } catch (e) {
      console.warn(`group avatar: falha (${e instanceof Error ? e.name : "erro"})`);
      if (storedId) await ctx.storage.delete(storedId).catch(() => undefined);
      await record("error");
    }
    return null;
  },
});

async function conversationOf(ctx: MutationCtx, group: Doc<"groupChats">) {
  const conversation = group.conversationId ? await ctx.db.get(group.conversationId) : null;
  return conversation && conversation.organizationId === group.organizationId ? conversation : null;
}

/** Foto NOVA baixada: `files` (porta de cota), apaga a anterior, linha lateral, conversa (só se a URL mudou) e carimbo. */
export const internalApplyGroupAvatar = internalMutation({
  args: {
    ...keyArgs,
    storageId: v.id("_storage"),
    mimeType: v.string(),
    size: v.number(),
    pictureId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const discard = async () => {
      await ctx.storage.delete(args.storageId).catch(() => undefined);
      return false;
    };
    const group = await ctx.db.get(args.groupChatId);
    if (!group || group.organizationId !== args.organizationId) return await discard();
    const row = await ctx.db
      .query("groupAvatars")
      .withIndex("by_group_chat", (q) => q.eq("groupChatId", args.groupChatId))
      .first();
    if (!row || row.organizationId !== args.organizationId) return await discard();
    const config = await ctx.db.get(args.channelConfigId);
    const now = Date.now();
    if (!config || config.organizationId !== args.organizationId) {
      await ctx.db.patch(row._id, { pendingSince: undefined });
      return await discard();
    }
    const quota = await checkAvatarQuota(ctx, { organizationId: args.organizationId, fileSize: args.size });
    const url = quota.ok ? await ctx.storage.getUrl(args.storageId) : null;
    if (!quota.ok || !url) {
      const failures = Math.min((row.failures ?? 0) + 1, 10);
      const nextCheckAt = now + AVATAR_REFUSED_BACKOFF_MS;
      await ctx.db.patch(row._id, { status: "error", failures, checkedAt: now, nextCheckAt, pendingSince: undefined });
      await stampGroupAvatar(ctx, group, { avatarNextCheckAt: nextCheckAt });
      return await discard();
    }
    const oldFile = row.fileId ? await ctx.db.get(row.fileId) : null;
    const fileId = await insertFileRow(ctx, {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: "whatsapp-group-avatar",
      mimeType: args.mimeType,
      size: args.size,
      fileType: "other",
      metadata: { kind: "contact_avatar", groupChatId: args.groupChatId },
      createdAt: 0, // fora do teto diário de uploads (mesma razão da foto do contato)
    });
    const nextCheckAt = computeNextCheckAt("ok", 0, now);
    await ctx.db.patch(row._id, {
      channelConfigId: args.channelConfigId,
      status: "ok",
      pictureId: args.pictureId,
      fileId,
      storageId: args.storageId,
      url,
      checkedAt: now,
      nextCheckAt,
      failures: undefined,
      pendingSince: undefined,
    });
    if (oldFile && oldFile.organizationId === args.organizationId) {
      await deleteBlobIfUnreferenced(ctx, oldFile);
      await deleteFileRow(ctx, oldFile);
    }
    const conversation = await conversationOf(ctx, group);
    if (conversation) {
      const effect = groupAvatarConversationPatch(conversation.groupAvatarUrl, url);
      if (effect.write) await ctx.db.patch(conversation._id, { groupAvatarUrl: effect.groupAvatarUrl });
    }
    await stampGroupAvatar(ctx, group, { avatarNextCheckAt: nextCheckAt, pictureUrl: url });
    await noteGatewaySuccess(ctx, args.channelConfigId);
    return true;
  },
});

/** Tira a foto guardada (removida/oculta/sem foto): arquivo, linha, conversa (se era a exibida) e carimbo. */
async function removeGroupAvatar(
  ctx: MutationCtx,
  row: Doc<"groupAvatars">,
  group: Doc<"groupChats"> | null,
  patch: { status: "hidden" | "none"; checkedAt: number; nextCheckAt: number }
): Promise<void> {
  const hadUrl = row.url;
  await dropGroupAvatarFile(ctx, row);
  await ctx.db.patch(row._id, {
    ...patch,
    pictureId: undefined,
    fileId: undefined,
    storageId: undefined,
    url: undefined,
    failures: undefined,
    pendingSince: undefined,
  });
  if (!group || group.organizationId !== row.organizationId) return;
  if (hadUrl) {
    const conversation = await conversationOf(ctx, group);
    if (conversation && conversation.groupAvatarUrl === hadUrl) {
      await ctx.db.patch(conversation._id, { groupAvatarUrl: undefined });
    }
  }
  await stampGroupAvatar(ctx, group, { avatarNextCheckAt: patch.nextCheckAt, pictureUrl: null });
}

/** Resultado de uma busca que NÃO trouxe foto nova. */
export const internalRecordGroupAvatarCheck = internalMutation({
  args: {
    ...keyArgs,
    outcome: v.union(
      v.literal("same"),
      v.literal("hidden"),
      v.literal("none"),
      v.literal("error"),
      v.literal("rate_limited"),
      v.literal("skipped"),
      v.literal("paused"),
      v.literal("refused")
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("groupAvatars")
      .withIndex("by_group_chat", (q) => q.eq("groupChatId", args.groupChatId))
      .first();
    if (!row || row.organizationId !== args.organizationId) return null;
    const group = await ctx.db.get(args.groupChatId);
    const ownGroup = group && group.organizationId === args.organizationId ? group : null;
    const now = Date.now();
    const pacingOf = async () =>
      await ctx.db
        .query("channelAvatarPacing")
        .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
        .first();
    switch (args.outcome) {
      case "skipped": {
        if (row.pendingSince === undefined) return null;
        const nextCheckAt = Math.max(row.nextCheckAt, now + AVATAR_CONFIG_SKIP_BACKOFF_MS);
        await ctx.db.patch(row._id, { pendingSince: undefined, nextCheckAt });
        if (ownGroup) await stampGroupAvatar(ctx, ownGroup, { avatarNextCheckAt: nextCheckAt });
        return null;
      }
      case "paused":
        if (row.pendingSince !== undefined) await ctx.db.patch(row._id, { pendingSince: undefined });
        if (ownGroup) await stampGroupAvatar(ctx, ownGroup, { avatarNextCheckAt: now });
        return null;
      case "same": {
        const nextCheckAt = computeNextCheckAt("ok", 0, now);
        await ctx.db.patch(row._id, { status: "ok", checkedAt: now, nextCheckAt, failures: undefined, pendingSince: undefined });
        if (ownGroup) await stampGroupAvatar(ctx, ownGroup, { avatarNextCheckAt: nextCheckAt });
        await noteGatewaySuccess(ctx, args.channelConfigId);
        return null;
      }
      case "hidden":
      case "none":
        await removeGroupAvatar(ctx, row, ownGroup, {
          status: args.outcome,
          checkedAt: now,
          nextCheckAt: now + AVATAR_ABSENT_RENEW_MS,
        });
        await noteGatewaySuccess(ctx, args.channelConfigId);
        return null;
      case "rate_limited": {
        const pacing = await pacingOf();
        const strikes = (pacing?.strikes ?? 0) + 1;
        const pausedUntil = now + avatarPauseMs(strikes);
        if (pacing) {
          await ctx.db.patch(pacing._id, { strikes, pausedUntil });
        } else {
          await ctx.db.insert("channelAvatarPacing", {
            organizationId: args.organizationId,
            channelConfigId: args.channelConfigId,
            nextFetchAt: now,
            strikes,
            pausedUntil,
          });
        }
        const nextCheckAt = Math.max(row.nextCheckAt, pausedUntil);
        await ctx.db.patch(row._id, { pendingSince: undefined, nextCheckAt });
        if (ownGroup) await stampGroupAvatar(ctx, ownGroup, { avatarNextCheckAt: nextCheckAt });
        return null;
      }
      case "refused":
      case "error": {
        if (args.outcome === "error") {
          const pacing = await pacingOf();
          if (pacing) await ctx.db.patch(pacing._id, pacingAfterAvatarError(pacing, now));
        }
        const failures = Math.min((row.failures ?? 0) + 1, 10);
        const nextCheckAt =
          args.outcome === "refused" ? now + AVATAR_REFUSED_BACKOFF_MS : computeNextCheckAt("error", failures, now);
        await ctx.db.patch(row._id, { status: "error", failures, checkedAt: now, nextCheckAt, pendingSince: undefined });
        if (ownGroup) await stampGroupAvatar(ctx, ownGroup, { avatarNextCheckAt: nextCheckAt });
        return null;
      }
    }
  },
});

/**
 * Evento `Picture` de GRUPO. `remove` apaga já a foto guardada (e a da conversa); senão só
 * marca a foto como vencida (linha lateral e carimbo em 0): a busca vem no próximo gatilho,
 * nunca no evento. Grupo desconhecido, de outra org ou sem acompanhamento: ignora sem escrever.
 */
export const internalApplyGroupPictureEvent = internalMutation({
  args: { channelConfigId: v.id("channelConfigs"), groupJid: v.string(), remove: v.boolean() },
  returns: v.union(v.literal("expired"), v.literal("removed"), v.literal("ignored")),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config || config.channel !== "whatsapp" || config.provider !== "bridge") return "ignored";
    const group = await ctx.db
      .query("groupChats")
      .withIndex("by_channel_config_and_jid", (q) =>
        q.eq("channelConfigId", args.channelConfigId).eq("jid", args.groupJid)
      )
      .first();
    if (!group || group.organizationId !== config.organizationId || !group.monitored) return "ignored";
    const row = await ctx.db
      .query("groupAvatars")
      .withIndex("by_group_chat", (q) => q.eq("groupChatId", group._id))
      .first();
    const now = Date.now();
    if (args.remove) {
      if (!row || row.organizationId !== group.organizationId) return "ignored";
      await removeGroupAvatar(ctx, row, group, { status: "none", checkedAt: now, nextCheckAt: now + AVATAR_ABSENT_RENEW_MS });
      return "removed";
    }
    if (row && row.organizationId === group.organizationId && row.nextCheckAt !== 0) {
      await ctx.db.patch(row._id, { nextCheckAt: 0 });
    }
    await stampGroupAvatar(ctx, group, { avatarNextCheckAt: 0 });
    return "expired";
  },
});
