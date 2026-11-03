/**
 * Copilot on Telegram — F4 (D25): the life end of a FILE draft (a file the
 * member sent for "Responder" that will not go out). One door, used by cancel,
 * replace, expiry (on the next update AND at `expiresAt`, review F4 #2) and
 * revocation: the `files` row and blob go through the storage ports and the
 * reserved quota is released.
 */
import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { deleteBlobIfUnreferenced } from "./fileRefs";
import { deleteFileRow } from "./storageUsage";

export type PendingPrompt = NonNullable<Doc<"telegramChats">["pendingPrompt"]>;
export type DraftAttachment = NonNullable<PendingPrompt["draftAttachments"]>[number];

export async function discardDraftFile(ctx: MutationCtx, a: DraftAttachment, organizationId: Id<"organizations"> | undefined) {
  const file = await ctx.db.get(a.fileId);
  // Only a file that never left (no message): a sent attachment belongs to the message now.
  if (file && file.organizationId === organizationId && file.messageId === undefined) {
    await deleteBlobIfUnreferenced(ctx, file);
    await deleteFileRow(ctx, file);
  }
  if (organizationId) {
    await ctx.scheduler.runAfter(0, internal.telegramQuota.internalReleaseFileQuota, {
      linkId: a.quota.linkId,
      organizationId,
      bytes: a.size,
      dayKey: a.quota.dayKey,
      ...(a.quota.hourStart !== undefined ? { hourStart: a.quota.hourStart } : {}),
    });
  }
}

export async function discardPromptDraft(ctx: MutationCtx, prompt: Pick<PendingPrompt, "draftAttachments" | "organizationId">) {
  for (const a of prompt.draftAttachments ?? []) await discardDraftFile(ctx, a, prompt.organizationId);
}

/** Revocation: the chat's open prompt of THIS org goes, with its file draft. */
export async function discardChatPromptForOrg(ctx: MutationCtx, chatId: number, organizationId: Id<"organizations">, now: number) {
  const chat = await ctx.db
    .query("telegramChats")
    .withIndex("by_chat_id", (q) => q.eq("chatId", chatId))
    .first();
  const prompt = chat?.pendingPrompt;
  if (!chat || !prompt || prompt.organizationId !== organizationId) return;
  await discardPromptDraft(ctx, prompt);
  await ctx.db.patch(chat._id, { pendingPrompt: undefined, updatedAt: now });
}
