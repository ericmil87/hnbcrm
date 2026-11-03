/**
 * Loads the `CardContext` of a Telegram card (F1). Reads only, bounded, every
 * entity checked against the org. Shared by the delivery query and the
 * action mutations (records, "Ver tudo"/"Resumir").
 */
import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { getLeadRef } from "./leadRef";
import { safeTimezone } from "./promptDateTime";
import { normalizeCampaignPhone } from "./phone";
import { resolveDefaultCountry } from "./orgPhone";
import { messageLineText, type CardContext, type HistoryLine } from "./telegramNotifications";

type Db = QueryCtx["db"];

const HISTORY_SIZE = 10;

async function firstFileName(db: Db, m: Doc<"messages">): Promise<string | undefined> {
  const fileId = m.attachments?.[0];
  if (!fileId) return undefined;
  const file = await db.get(fileId);
  return file && file.organizationId === m.organizationId ? file.name : undefined;
}

export async function messageText(db: Db, m: Doc<"messages">): Promise<string> {
  return messageLineText({
    content: m.content,
    contentType: m.contentType,
    transcriptText: m.transcriptText,
    imageDescription: m.imageDescription,
    fileName: m.contentType === "file" ? await firstFileName(db, m) : undefined,
  });
}

/** Last pending AI draft of the conversation (newest first, bounded). */
export async function pendingDraftOf(db: Db, conversationId: Id<"conversations">): Promise<Doc<"messages"> | null> {
  const recent = await db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .take(30);
  return (
    recent.find((m) => (m.metadata?.aiDraft as { status?: string } | undefined)?.status === "pending") ?? null
  );
}

export async function loadCardContext(
  db: Db,
  args: {
    organizationId: Id<"organizations">;
    now: number;
    appBaseUrl: string;
    notification?: Doc<"notifications">;
    conversationId?: Id<"conversations">;
    handoffId?: Id<"handoffs">;
    taskId?: Id<"tasks">;
  },
): Promise<CardContext | null> {
  const org = await db.get(args.organizationId);
  if (!org) return null;
  const orgId = org._id;
  const n = args.notification;
  const ctx: CardContext = {
    orgName: org.name,
    timezone: safeTimezone(org.settings.timezone),
    currency: org.settings.currency || "BRL",
    appBaseUrl: args.appBaseUrl,
    discreet: org.settings.telegram?.discreet === true,
    now: args.now,
  };

  const handoffId = args.handoffId ?? n?.handoffId;
  const handoff = handoffId ? await db.get(handoffId) : null;
  const validHandoff = handoff && handoff.organizationId === orgId ? handoff : null;
  if (validHandoff) {
    const from = await db.get(validHandoff.fromMemberId);
    const acceptedBy = validHandoff.acceptedBy ? await db.get(validHandoff.acceptedBy) : null;
    ctx.handoff = {
      id: validHandoff._id,
      status: validHandoff.status,
      reason: validHandoff.reason,
      summary: validHandoff.summary,
      fromAi: !from || from.type === "ai",
      fromName: from?.name,
      acceptedByName: acceptedBy?.name,
    };
  }

  const taskId = args.taskId ?? n?.taskId;
  const task = taskId ? await db.get(taskId) : null;
  const validTask = task && task.organizationId === orgId ? task : null;
  if (validTask) {
    ctx.task = { id: validTask._id, title: validTask.title, dueDate: validTask.dueDate, status: validTask.status };
  }

  const conversationId = args.conversationId ?? n?.conversationId ?? validHandoff?.conversationId;
  const conversation = conversationId ? await db.get(conversationId) : null;
  const validConversation = conversation && conversation.organizationId === orgId ? conversation : null;
  if (validConversation) ctx.conversation = { id: validConversation._id, channel: validConversation.channel };

  const lead = await getLeadRef(db, validConversation?.leadId ?? validHandoff?.leadId ?? validTask?.leadId);
  if (lead && lead.organizationId === orgId) {
    const contact = lead.contactId ? await db.get(lead.contactId) : null;
    // E.164 through the phone port (org default country); no button when it does not normalize.
    const raw = contact?.whatsappNumber ?? contact?.phone ?? "";
    const normalized = raw ? normalizeCampaignPhone(raw, resolveDefaultCountry(org.settings)) : null;
    const phone = normalized?.ok ? normalized.phone : "";
    const stage = await db.get(lead.stageId);
    const board = await db.get(lead.boardId);
    ctx.lead = {
      id: lead._id,
      title: lead.title,
      ...(phone.length >= 8 ? { phone } : {}),
      ...(contact?.instagramUsername ? { instagramUsername: contact.instagramUsername } : {}),
      ...(lead.value ? { value: lead.value } : {}),
      ...(stage ? { stageName: stage.name } : {}),
      ...(board ? { boardName: board.name } : {}),
    };
  }

  if (validConversation) {
    const recent = await db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", validConversation._id))
      .order("desc")
      .take(20);
    const lastInbound = recent.find((m) => m.direction === "inbound");
    if (lastInbound) ctx.lastInbound = { text: await messageText(db, lastInbound), at: lastInbound.createdAt };
    if (n?.type === "ai_draft_pending") {
      const draft = await pendingDraftOf(db, validConversation._id);
      if (draft) ctx.draft = { messageId: draft._id, text: draft.content };
    }
  }

  const messageIds = (n?.data as { messageIds?: unknown } | undefined)?.messageIds;
  if (n?.type === "new_message" && Array.isArray(messageIds)) {
    const lines: HistoryLine[] = [];
    for (const id of messageIds.slice(0, 50)) {
      if (typeof id !== "string") continue;
      const m = await db.get(id as Id<"messages">);
      if (!m || m.organizationId !== orgId || m.conversationId !== validConversation?._id) continue;
      lines.push({ at: m.createdAt, author: "", text: await messageText(db, m) });
    }
    const more = (n.data as { moreCount?: unknown }).moreCount;
    if (typeof more === "number" && more > 0) {
      lines.push({ at: lines.at(-1)?.at ?? n.createdAt, author: "", text: `… e mais ${more} mensagens (abrir no CRM)` });
    }
    ctx.relayLines = lines;
  }
  if (n?.actorId) {
    const actor = await db.get(n.actorId);
    if (actor && actor.organizationId === orgId) ctx.actorName = actor.name;
  }
  return ctx;
}

/** Last 10 visible messages (no internal notes/drafts), oldest first, for "Ver tudo". */
export async function loadHistory(
  db: Db,
  conversation: Doc<"conversations">,
  leadTitle: string | undefined,
): Promise<HistoryLine[]> {
  const recent = await db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
    .order("desc")
    .take(40);
  const visible = recent.filter((m) => !m.isInternal && m.direction !== "internal").slice(0, HISTORY_SIZE).reverse();
  const customer = leadTitle?.split(/\s+/)[0] || "Cliente";
  const names = new Map<string, string>();
  const out: HistoryLine[] = [];
  for (const m of visible) {
    let author = customer;
    if (m.direction === "outbound") {
      if (m.senderType === "ai") author = "IA";
      else if (m.senderId) {
        if (!names.has(m.senderId)) names.set(m.senderId, (await db.get(m.senderId))?.name ?? "Equipe");
        author = names.get(m.senderId)!;
      } else author = "Equipe";
    }
    out.push({ at: m.createdAt, author, text: await messageText(db, m) });
  }
  return out;
}
