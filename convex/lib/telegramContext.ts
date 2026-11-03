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
import {
  channelLabel,
  formatMoney,
  initials,
  messageLineText,
  redactName,
  type CardContext,
  type HistoryLine,
} from "./telegramNotifications";
import { maskDigitRuns } from "./telegramFormat";
import { wrapUntrustedJson } from "./promptEnvelope";
import { isSticker } from "./mediaEnrichment";

type Db = QueryCtx["db"];

const HISTORY_SIZE = 10;

async function firstFile(db: Db, m: Doc<"messages">): Promise<Doc<"files"> | null> {
  const fileId = m.attachments?.[0];
  if (!fileId) return null;
  const file = await db.get(fileId);
  return file && file.organizationId === m.organizationId ? file : null;
}

export async function messageText(db: Db, m: Doc<"messages">): Promise<string> {
  const file = m.contentType === "file" ? await firstFile(db, m) : null;
  return messageLineText({
    content: m.content,
    contentType: m.contentType,
    transcriptText: m.transcriptText,
    imageDescription: m.imageDescription,
    fileName: file?.name,
    fileMime: file?.mimeType,
    sticker: isSticker(m.metadata as Record<string, unknown> | undefined),
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

// ---------------------------------------------------------------------------
// F3 (D17): context block of the conversation in focus, for the Copilot turn
// ---------------------------------------------------------------------------

export type FocusContextInput = {
  lead?: { title: string; stageName?: string; boardName?: string; value?: number; ownerName?: string };
  channel: string;
  attendantMode?: "suggest" | "autopilot" | null;
  handoff?: { origin?: string; reason: string };
  teamNotes: string[];
  pendingDraft?: string;
  messages: { direction: string; author: string; at: number; text: string }[];
  discreet: boolean;
  currency: string;
};

/** Customer text per message in the block (D17, cost cap). */
export const CONTEXT_MESSAGE_MAX = 300;
export const CONTEXT_MESSAGES = 20;

function clip(text: string, max = CONTEXT_MESSAGE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * The system message injected in a Copilot turn when the chat has a
 * conversation in focus (< 6 h). Not persisted in the thread. Customer text
 * goes inside the untrusted envelope. Discreet mode: lead name as initials
 * and digit runs masked; full mode: as the member sees it in the CRM.
 */
export function buildConversationContextBlock(input: FocusContextInput): string {
  const name = (t: string) => (input.discreet ? initials(t) : t);
  const mask = (t: string) => (input.discreet ? maskDigitRuns(redactNameIn(t, input.lead?.title)) : t);
  const lines: string[] = ["CONVERSA EM FOCO (contexto do sistema; o usuário está falando desta conversa)"];
  if (input.lead) {
    const bits = [`Lead: ${name(input.lead.title)}`];
    if (input.lead.boardName && input.lead.stageName) bits.push(`etapa ${input.lead.boardName} › ${input.lead.stageName}`);
    if (input.lead.value) bits.push(formatMoney(input.lead.value, input.currency));
    if (input.lead.ownerName) bits.push(`responsável: ${input.lead.ownerName}`);
    lines.push(bits.join(" · "));
  }
  lines.push(
    `Canal: ${channelLabel(input.channel)} · Atendente de IA: ${input.attendantMode ?? "nenhum para este canal"}`,
  );
  if (input.handoff) {
    lines.push(`Repasse pendente (origem ${input.handoff.origin ?? "?"}): ${mask(clip(input.handoff.reason, 300))}`);
  }
  if (input.teamNotes.length > 0) {
    lines.push("Notas da equipe já dadas à IA:");
    for (const note of input.teamNotes.slice(-5)) lines.push(`- ${mask(clip(note, 300))}`);
  }
  if (input.pendingDraft) lines.push(`Rascunho pendente da IA: "${mask(clip(input.pendingDraft, 500))}"`);
  const messages = input.messages.slice(-CONTEXT_MESSAGES).map((m) => ({
    de: m.author,
    direcao: m.direction,
    em: new Date(m.at).toISOString(),
    texto: mask(clip(m.text)),
  }));
  lines.push(wrapUntrustedJson("últimas mensagens da conversa em foco", messages));
  lines.push(
    "Quando o usuário falar desta conversa, prefira acionar o Atendente de IA com uma instrução clara (instructAttendant) a responder você mesmo; explique em uma linha o que fez.",
  );
  return lines.join("\n");
}

function redactNameIn(text: string, leadTitle: string | undefined): string {
  return leadTitle ? redactName({ discreet: true, lead: { id: "", title: leadTitle } }, text) : text;
}

/** Loads the focus conversation into a `FocusContextInput` (org-checked, bounded). */
export async function loadFocusContextInput(
  db: Db,
  args: { organizationId: Id<"organizations">; conversationId: Id<"conversations"> },
): Promise<FocusContextInput | null> {
  const org = await db.get(args.organizationId);
  const conversation = await db.get(args.conversationId);
  if (!org || !conversation || conversation.organizationId !== org._id || conversation.kind === "group") return null;
  const lead = await getLeadRef(db, conversation.leadId);
  let leadInfo: FocusContextInput["lead"];
  let attendantMode: FocusContextInput["attendantMode"] = null;
  if (lead && lead.organizationId === org._id) {
    const [stage, board, owner] = await Promise.all([
      db.get(lead.stageId),
      db.get(lead.boardId),
      lead.assignedTo ? db.get(lead.assignedTo) : Promise.resolve(null),
    ]);
    leadInfo = {
      title: lead.title,
      ...(stage ? { stageName: stage.name } : {}),
      ...(board ? { boardName: board.name } : {}),
      ...(lead.value ? { value: lead.value } : {}),
      ...(owner ? { ownerName: owner.name } : {}),
    };
    if (owner?.type === "ai" && owner.agentProfile?.kind === "attendant") attendantMode = owner.agentProfile.mode;
  }
  if (attendantMode === null) {
    const ais = await db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) => q.eq("organizationId", org._id).eq("type", "ai"))
      .take(20);
    const attendant = ais.find((m) => m.agentProfile?.kind === "attendant" && m.status !== "inactive");
    attendantMode = attendant?.agentProfile?.mode ?? null;
  }
  const handoff = await db
    .query("handoffs")
    .withIndex("by_conversation_and_status", (q) => q.eq("conversationId", conversation._id).eq("status", "pending"))
    .first();
  const draft = await pendingDraftOf(db, conversation._id);
  const recent = await db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
    .order("desc")
    .take(60);
  const visible = recent
    .filter((m) => !m.isInternal && m.direction !== "internal")
    .slice(0, CONTEXT_MESSAGES)
    .reverse();
  const names = new Map<string, string>();
  const messages: FocusContextInput["messages"] = [];
  for (const m of visible) {
    let author = "cliente";
    if (m.direction === "outbound") {
      if (m.senderType === "ai") author = "IA";
      else if (m.senderId) {
        if (!names.has(m.senderId)) names.set(m.senderId, (await db.get(m.senderId))?.name ?? "equipe");
        author = names.get(m.senderId)!;
      } else author = "equipe";
    }
    messages.push({ direction: m.direction, author, at: m.createdAt, text: await messageText(db, m) });
  }
  return {
    ...(leadInfo ? { lead: leadInfo } : {}),
    channel: conversation.channel,
    attendantMode,
    ...(handoff ? { handoff: { origin: handoff.origin, reason: handoff.reason } } : {}),
    teamNotes: (conversation.aiTeamNotes ?? []).map((n) => n.text),
    ...(draft ? { pendingDraft: draft.content } : {}),
    messages,
    discreet: org.settings.telegram?.discreet === true,
    currency: org.settings.currency || "BRL",
  };
}
