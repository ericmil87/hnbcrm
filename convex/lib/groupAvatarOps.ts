/**
 * Foto de perfil do GRUPO — PORTAS com `ctx` (regras puras em `lib/groupAvatar.ts`,
 * gateway em `lib/avatarFetch.ts`, vencimento/ritmo em `lib/contactAvatar.ts`).
 *
 *  - `maybeScheduleGroupAvatar`: GATILHO (porta única). Sem NENHUMA leitura: decide pelo
 *    doc do grupo (e conversa) que o chamador já tem; vencido agenda
 *    `internalMaybeScheduleGroup`, que revalida e mexe no canal/linha FORA da transação.
 *  - `scheduleGroupAvatarFetch`: o agendamento de fato (cursor do canal, carimbo, action).
 *  - `deleteGroupAvatarRows`: exclusão do grupo (cascata do canal) pelas portas de `files`.
 */
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { deleteBlobIfUnreferenced } from "./fileRefs";
import { deleteFileRow } from "./storageUsage";
import { classifyAvatarChannel } from "./contactAvatarOps";
import {
  AVATAR_CONFIG_SKIP_BACKOFF_MS,
  AVATAR_NON_BRIDGE_BACKOFF_MS,
  AVATAR_PENDING_TTL_MS,
  isAvatarCheckDue,
  planAvatarSlot,
} from "./contactAvatar";
import {
  GROUP_AVATAR_THROTTLE_STAMP_MS,
  groupAvatarEligible,
  groupAvatarStampDue,
} from "./groupAvatar";

/** GATILHO: ingest de grupo, sync, abrir conversa, acompanhar. Nunca lança, nunca lê nem escreve. */
export async function maybeScheduleGroupAvatar(
  ctx: MutationCtx,
  args: { group: Doc<"groupChats">; conversation?: Doc<"conversations"> | null }
): Promise<boolean> {
  try {
    const { group, conversation } = args;
    if (!groupAvatarEligible(group, conversation)) return false;
    if (!groupAvatarStampDue(group, Date.now())) return false;
    await ctx.scheduler.runAfter(0, internal.groupAvatar.internalMaybeScheduleGroup, {
      organizationId: group.organizationId,
      groupChatId: group._id,
    });
    return true;
  } catch (e) {
    console.warn(`group avatar: gatilho falhou (${e instanceof Error ? e.name : "erro"})`);
    return false;
  }
}

/** Carimbo do grupo (e, se dado, `pictureUrl`): só escreve o que mudou. */
export async function stampGroupAvatar(
  ctx: MutationCtx,
  group: Doc<"groupChats">,
  patch: { avatarNextCheckAt: number; pictureUrl?: string | null }
): Promise<void> {
  const next: { avatarNextCheckAt?: number; pictureUrl?: string | undefined } = {};
  if (group.avatarNextCheckAt !== patch.avatarNextCheckAt) next.avatarNextCheckAt = patch.avatarNextCheckAt;
  if (patch.pictureUrl !== undefined) {
    const url = patch.pictureUrl ?? undefined;
    if (group.pictureUrl !== url) next.pictureUrl = url;
  }
  if (Object.keys(next).length > 0) await ctx.db.patch(group._id, next);
}

export type GroupScheduleOutcome =
  | "scheduled"
  | "ineligible"
  | "not_due"
  | "foreign_channel"
  | "skipped_config"
  | "skipped_non_bridge"
  | "throttled";

export async function scheduleGroupAvatarFetch(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; groupChatId: Id<"groupChats"> }
): Promise<GroupScheduleOutcome> {
  const group = await ctx.db.get(args.groupChatId);
  if (!group || group.organizationId !== args.organizationId) return "ineligible";
  const conversation = group.conversationId ? await ctx.db.get(group.conversationId) : null;
  if (!conversation || !groupAvatarEligible(group, conversation)) return "ineligible";

  const row = await ctx.db
    .query("groupAvatars")
    .withIndex("by_group_chat", (q) => q.eq("groupChatId", group._id))
    .first();
  if (row && row.organizationId !== group.organizationId) return "ineligible";
  const now = Date.now();
  if (!isAvatarCheckDue(row, now)) {
    // Carimbo defasado: realinha (a pendência em andamento segura até o TTL).
    const until = row?.pendingSince !== undefined ? Math.max(row.nextCheckAt, row.pendingSince + AVATAR_PENDING_TTL_MS) : row?.nextCheckAt ?? now;
    await stampGroupAvatar(ctx, group, { avatarNextCheckAt: until });
    return "not_due";
  }

  const channelConfigId = group.channelConfigId;
  const config = await ctx.db.get(channelConfigId);
  const verdict = classifyAvatarChannel(config, group.organizationId);
  if (verdict === "foreign") return "foreign_channel";
  if (verdict === "non_bridge" || verdict === "unusable") {
    await stampGroupAvatar(ctx, group, {
      avatarNextCheckAt: now + (verdict === "non_bridge" ? AVATAR_NON_BRIDGE_BACKOFF_MS : AVATAR_CONFIG_SKIP_BACKOFF_MS),
    });
    return verdict === "non_bridge" ? "skipped_non_bridge" : "skipped_config";
  }

  const pacing = await ctx.db
    .query("channelAvatarPacing")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .first();
  const slot = planAvatarSlot(pacing, now, Math.random());
  if (!slot) {
    await stampGroupAvatar(ctx, group, { avatarNextCheckAt: now + GROUP_AVATAR_THROTTLE_STAMP_MS });
    return "throttled";
  }
  const pacingPatch = { nextFetchAt: slot.nextFetchAt, day: slot.day, dayCount: slot.dayCount };
  if (pacing) {
    await ctx.db.patch(pacing._id, pacingPatch);
  } else {
    await ctx.db.insert("channelAvatarPacing", {
      organizationId: group.organizationId,
      channelConfigId,
      ...pacingPatch,
    });
  }
  if (row) {
    await ctx.db.patch(row._id, { pendingSince: slot.runAt, channelConfigId });
  } else {
    await ctx.db.insert("groupAvatars", {
      organizationId: group.organizationId,
      groupChatId: group._id,
      channelConfigId,
      status: "none",
      checkedAt: 0,
      nextCheckAt: 0,
      pendingSince: slot.runAt,
    });
  }
  // Carimbo = quando a busca vai rodar + a vida da pendência: o ingest para de agendar já.
  await stampGroupAvatar(ctx, group, { avatarNextCheckAt: slot.runAt + AVATAR_PENDING_TTL_MS });
  await ctx.scheduler.runAt(slot.runAt, internal.groupAvatar.internalFetchGroupAvatar, {
    organizationId: group.organizationId,
    groupChatId: group._id,
    channelConfigId,
  });
  return "scheduled";
}

/** Apaga o blob + a linha de `files` guardados na linha lateral (portas de `fileRefs`/`storageUsage`). */
export async function dropGroupAvatarFile(ctx: MutationCtx, row: Doc<"groupAvatars">): Promise<void> {
  if (!row.fileId) return;
  const file = await ctx.db.get(row.fileId);
  if (file && file.organizationId === row.organizationId) {
    await deleteBlobIfUnreferenced(ctx, file);
    await deleteFileRow(ctx, file);
  }
}

/** Exclusão do grupo: linha lateral + arquivo. Devolve as escritas feitas (orçamento da cascata). */
export async function deleteGroupAvatarRows(ctx: MutationCtx, groupChatId: Id<"groupChats">): Promise<number> {
  let writes = 0;
  const rows = await ctx.db
    .query("groupAvatars")
    .withIndex("by_group_chat", (q) => q.eq("groupChatId", groupChatId))
    .take(5);
  for (const row of rows) {
    await dropGroupAvatarFile(ctx, row);
    await ctx.db.delete(row._id);
    writes += 2;
  }
  return writes;
}
