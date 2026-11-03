/**
 * Copilot on Telegram (F3, D9/D10/D16/D17/D21). Free text, voice and photos
 * from a linked chat become a Copilot turn (`lib/copilotTurn.runCopilotTurn`,
 * the same loop as the web panel) with:
 * - session without JWT (`copilot.internalResolveSessionForMember`), spend gate;
 * - product `telegramCopilot` routes (D16);
 * - thread `telegramLinks.copilotThreadId` ("Telegram"; `/novo` rotates it);
 * - the D17 context block when the chat has a conversation in focus (< 6 h);
 * - streaming drafts (`sendMessageDraft`, ≥ 1 s apart, fallback typing);
 * - final answer as Telegram HTML (`markdownToTelegramHtml` + `splitMessage`);
 * - each pending action → a card with ✅ Confirmar (`pa:`) · ✖ Cancelar (`pc:`).
 *
 * Voice: getFile (≤ 20 MB) → download (15 s) → storage → Whisper → blob
 * deleted → "🎙 Entendi: '…'" → the transcript answers an open prompt, or
 * runs the turn. Photo (no prompt) → vision chain → "[imagem: …]" in the turn.
 * Domain writes happen only inside the Copilot executors / lib/telegramActions.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { appUrl } from "./lib/appUrl";
import { monthKeyUtc } from "./lib/aiSpend";
import { modulesOf } from "./lib/orgModules";
import { isLinkMemberAlive } from "./lib/telegramLinks";
import { FOCUS_TTL_MS } from "./lib/telegramRelay";
import { buildConversationContextBlock, loadFocusContextInput } from "./lib/telegramContext";
import { handleTelegramPromptAnswer, type ActionResult } from "./lib/telegramActions";
import { escapeHtml, markdownToTelegramHtml, splitMessage } from "./lib/telegramFormat";
import {
  TELEGRAM_FILE_MAX_BYTES,
  downloadTelegramFile,
  getFile,
  sendChatAction,
  sendMessageDraft,
} from "./lib/telegramApi";
import { buildSystemPrompt, resolveCopilotRoutes, runCopilotTurn, type CopilotSession } from "./lib/copilotTurn";
import type { CardKeyboard } from "./lib/telegramNotifications";
import type { AgentToolSpec } from "./lib/agentTools";
import { orgAiActive } from "./lib/agentSecurity";
import { MAX_IMAGE_BYTES } from "./vision";
import { wrapUntrusted, wrapUntrustedJson } from "./lib/promptEnvelope";
import { safeTimezone } from "./lib/promptDateTime";
import { initials } from "./lib/telegramNotifications";
import {
  AUTO_TURN_TRIGGERS,
  SUGGEST_TRIGGERS,
  AUTO_ACTIONS_PER_HOUR,
  STEP_LABELS,
  SUGGEST_SYSTEM_TEXT,
  UNDO_WINDOW_MS,
  autoActionsLeft,
  autoModeSystemText,
  autoWriteTools,
  effectiveAssistantMode,
  parseSuggestion,
} from "./lib/telegramAssistant";

/** ≥ 1 s between `sendMessageDraft` calls (D10; editing faster gets 429). */
export const DRAFT_THROTTLE_MS = 1000;
export const DOWNLOAD_TIMEOUT_MS = 15_000;
export const THINKING_TEXT = "Pensando…";

export const COPILOT_COPY = {
  aiOff: (org: string) => `🤖 A IA não está ativada na ${escapeHtml(org)}. Um admin ativa em Configurações → IA.`,
  copilotOff: (org: string) => `🤖 O Copiloto está desligado na ${escapeHtml(org)}. Um admin liga em Configurações → IA.`,
  spendCap: (org: string) =>
    `💸 A ${escapeHtml(org)} atingiu o teto de gastos de IA do mês. Notificações e botões continuam; o Copiloto e o modo automático voltam quando o teto for ajustado.`,
  noRoute: "⚠️ Nenhum provedor de IA disponível agora. Tente de novo em instantes.",
  turnError: "⚠️ Não consegui responder agora. Tente de novo em instantes.",
  canceled: "⏹ Resposta interrompida.",
  voiceTooBig: (mb: number) => `📦 Esse áudio tem ${mb.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB; o máximo é 20 MB.`,
  voiceFailed: "⚠️ Não consegui transcrever o áudio. Tente de novo ou escreva.",
  voiceHeard: (text: string) => `🎙 Entendi: "${escapeHtml(text)}"`,
  photoFailed: (reason: string) => `⚠️ Não consegui ler a imagem: ${escapeHtml(reason)}`,
  photoTooBig: "📦 Essa imagem passa de 5 MB, o máximo que eu leio. Mande uma menor ou pelo CRM.",
  video: "Ainda não envio vídeos pelo Telegram. Mande pelo CRM ou pelo WhatsApp.",
  pendingCard: (preview: string) => `⚠️ Confirme antes de eu fazer:\n${escapeHtml(preview)}`,
  busy: "⏳ Ainda estou terminando a anterior… Mande de novo em instantes.",
} as const;

/** One turn per link at a time (OCC on `telegramLinks.turnLock`); TTL > the 8 min turn cap. */
export const TURN_LOCK_TTL_MS = 9 * 60 * 1000;
/** A trigger that finds the lock taken waits and retries (FIFO-ish), up to ~2 min. */
export const TURN_RETRY_MS = 5_000;
export const TURN_MAX_RETRIES = 24;
const HOUR_MS = 60 * 60 * 1000;

const settingsButton = (secao: string): CardKeyboard => [
  [{ text: "🔗 Abrir configurações", url: `${appUrl()}/app/configuracoes?secao=${secao}` }],
];

// ---------------------------------------------------------------------------
// Queries / mutations used by the runner
// ---------------------------------------------------------------------------

const runTargetValidator = v.object({
  organizationId: v.id("organizations"),
  memberId: v.id("teamMembers"),
  linkId: v.id("telegramLinks"),
  chatId: v.number(),
  orgName: v.string(),
  threadId: v.optional(v.id("copilotThreads")),
  assistantThreadId: v.optional(v.id("copilotThreads")),
  focusConversationId: v.optional(v.id("conversations")),
  promptOpen: v.boolean(),
  protectContent: v.boolean(),
});
type RunTarget = {
  organizationId: Id<"organizations">;
  memberId: Id<"teamMembers">;
  linkId: Id<"telegramLinks">;
  chatId: number;
  orgName: string;
  threadId?: Id<"copilotThreads">;
  assistantThreadId?: Id<"copilotThreads">;
  focusConversationId?: Id<"conversations">;
  promptOpen: boolean;
  protectContent: boolean;
};

async function chatRow(ctx: { db: QueryCtx["db"] }, chatId: number): Promise<Doc<"telegramChats"> | null> {
  return await ctx.db
    .query("telegramChats")
    .withIndex("by_chat_id", (q) => q.eq("chatId", chatId))
    .first();
}

/** Live link + member + module, the valid focus and whether a prompt is open (`now` passed in). */
export const internalGetCopilotRun = internalQuery({
  args: { linkId: v.id("telegramLinks"), now: v.number() },
  returns: v.union(v.null(), runTargetValidator),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link || link.status !== "active") return null;
    const member = await ctx.db.get(link.teamMemberId);
    if (!member || !isLinkMemberAlive(link, member)) return null;
    const org = await ctx.db.get(link.organizationId);
    if (!org || !modulesOf(org).telegram) return null;
    const chat = await chatRow(ctx, link.chatId);
    const focus = chat?.focus;
    let focusConversationId: Id<"conversations"> | undefined;
    if (focus && focus.setAt > args.now - FOCUS_TTL_MS) {
      const conversation = await ctx.db.get(focus.conversationId);
      if (conversation && conversation.organizationId === org._id) focusConversationId = conversation._id;
    }
    const prompt = chat?.pendingPrompt;
    return {
      organizationId: org._id,
      memberId: member._id,
      linkId: link._id,
      chatId: link.chatId,
      orgName: org.name,
      ...(link.copilotThreadId ? { threadId: link.copilotThreadId } : {}),
      ...(link.assistantThreadId ? { assistantThreadId: link.assistantThreadId } : {}),
      ...(focusConversationId ? { focusConversationId } : {}),
      promptOpen: prompt !== undefined && prompt.expiresAt > args.now && prompt.organizationId === org._id,
      protectContent: org.settings.telegram?.protectContent === true,
    };
  },
});

/**
 * Claims the link's turn lock (and, for automatic turns, reserves one slot of
 * the 20/h cap in the SAME transaction — concurrent events cannot overshoot).
 */
export const internalClaimTurn = internalMutation({
  args: {
    linkId: v.id("telegramLinks"),
    token: v.string(),
    reserveAuto: v.optional(v.boolean()),
    /** "assistant" = event turns (own thread + lock); default the free-text thread. */
    slot: v.optional(v.union(v.literal("copilot"), v.literal("assistant"))),
  },
  returns: v.union(v.literal("ok"), v.literal("locked"), v.literal("capped"), v.literal("gone")),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link || link.status !== "active") return "gone";
    const now = Date.now();
    const field = args.slot === "assistant" ? "assistantTurnLock" : "turnLock";
    const lock = link[field];
    if (lock && lock.expiresAt > now && lock.token !== args.token) return "locked";
    let assistant = link.assistant;
    if (args.reserveAuto) {
      const fresh = assistant.autoHourStart === undefined || now - assistant.autoHourStart >= HOUR_MS;
      const used = fresh ? 0 : (assistant.autoActionsThisHour ?? 0);
      if (used >= AUTO_ACTIONS_PER_HOUR) return "capped";
      assistant = { ...assistant, autoHourStart: fresh ? now : assistant.autoHourStart, autoActionsThisHour: used + 1 };
    }
    await ctx.db.patch(link._id, {
      [field]: { token: args.token, expiresAt: now + TURN_LOCK_TTL_MS },
      ...(args.reserveAuto ? { assistant } : {}),
    });
    return "ok";
  },
});

/**
 * Releases the lock (only the holder's token) and settles the reserved slot:
 * `autoAdjust` −1 = the turn wrote nothing (slot returned), +n = extra steps.
 */
export const internalReleaseTurn = internalMutation({
  args: {
    linkId: v.id("telegramLinks"),
    token: v.string(),
    autoAdjust: v.optional(v.number()),
    slot: v.optional(v.union(v.literal("copilot"), v.literal("assistant"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return null;
    const patch: Partial<Doc<"telegramLinks">> = {};
    const field = args.slot === "assistant" ? "assistantTurnLock" : "turnLock";
    if (link[field]?.token === args.token) patch[field] = undefined;
    const adjust = Math.trunc(args.autoAdjust ?? 0);
    if (adjust !== 0 && link.assistant.autoHourStart !== undefined && Date.now() - link.assistant.autoHourStart < HOUR_MS) {
      patch.assistant = {
        ...link.assistant,
        autoActionsThisHour: Math.max(0, (link.assistant.autoActionsThisHour ?? 0) + adjust),
      };
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(link._id, patch);
    return null;
  },
});

/** AI on for the org (voice answering an open prompt needs Whisper, not the Copilot). */
export const internalOrgAiActive = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.boolean(),
  handler: async (ctx, args) => orgAiActive(await ctx.db.get(args.organizationId)),
});

export const internalBuildFocusContext = internalQuery({
  args: { organizationId: v.id("organizations"), conversationId: v.id("conversations") },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const input = await loadFocusContextInput(ctx.db, args);
    return input ? buildConversationContextBlock(input) : null;
  },
});

export const internalSetCopilotThread = internalMutation({
  args: {
    linkId: v.id("telegramLinks"),
    threadId: v.id("copilotThreads"),
    slot: v.optional(v.union(v.literal("copilot"), v.literal("assistant"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return null;
    const field = args.slot === "assistant" ? "assistantThreadId" : "copilotThreadId";
    if (link[field] !== args.threadId) await ctx.db.patch(link._id, { [field]: args.threadId });
    return null;
  },
});

/**
 * `/novo` (called by the commands handler): next Copilot message starts a new
 * "Telegram" thread and the conversation focus is cleared (D17).
 */
export const internalRotateCopilotThread = internalMutation({
  args: { linkId: v.id("telegramLinks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.linkId);
    if (!link) return null;
    if (link.copilotThreadId) await ctx.db.patch(link._id, { copilotThreadId: undefined });
    const chat = await chatRow(ctx, link.chatId);
    if (chat && (chat.focus || chat.cancelRequestedAt)) {
      await ctx.db.patch(chat._id, { focus: undefined, cancelRequestedAt: undefined, updatedAt: Date.now() });
    }
    return null;
  },
});

export const internalCancelRequestedSince = internalQuery({
  args: { chatId: v.number(), since: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const chat = await chatRow(ctx, args.chatId);
    return chat?.cancelRequestedAt !== undefined && chat.cancelRequestedAt >= args.since;
  },
});

export const internalPendingActionPreviews = internalQuery({
  args: { ids: v.array(v.id("pendingActions")), organizationId: v.id("organizations") },
  returns: v.array(v.object({ id: v.id("pendingActions"), preview: v.string() })),
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids.slice(0, 5)) {
      const pa = await ctx.db.get(id);
      if (pa && pa.organizationId === args.organizationId && pa.status === "pending") out.push({ id, preview: pa.preview });
    }
    return out;
  },
});

/** A voice transcript answering the open prompt (F1 consumer, text path). */
export const internalAnswerPromptWithText = internalMutation({
  args: { chatId: v.number(), text: v.string() },
  returns: v.union(v.null(), v.object({ replies: v.array(v.any()), edits: v.array(v.any()) })),
  handler: async (ctx, args) => {
    return await handleTelegramPromptAnswer(ctx, { chatId: args.chatId, text: args.text, now: Date.now(), appBaseUrl: appUrl() });
  },
});

// ---------------------------------------------------------------------------
// Sending (through `telegram.internalDeliverReply`: 429/403 handling, records)
// ---------------------------------------------------------------------------

type Out = {
  chatId: number;
  text: string;
  keyboard?: CardKeyboard;
  protectContent?: boolean;
  record?: {
    organizationId: Id<"organizations">;
    linkId: Id<"telegramLinks">;
    kind: "copilot";
    conversationId?: Id<"conversations">;
  };
};

async function send(ctx: ActionCtx, out: Out): Promise<void> {
  await ctx.runAction(internal.telegram.internalDeliverReply, {
    reply: {
      chatId: out.chatId,
      chunks: splitMessage(out.text),
      ...(out.keyboard ? { keyboard: out.keyboard } : {}),
      ...(out.protectContent ? { protectContent: true } : {}),
      ...(out.record ? { record: out.record } : {}),
    },
    attempt: 1,
  });
}

async function deliverResult(ctx: ActionCtx, result: ActionResult | null): Promise<void> {
  if (!result) return;
  await ctx.runAction(internal.telegram.internalDeliverActionResult, { result: result as any });
}

// ---------------------------------------------------------------------------
// Media → text
// ---------------------------------------------------------------------------

type MediaArg = {
  kind: "voice" | "audio" | "photo" | "video" | "video_note" | "document";
  fileId: string;
  fileSize?: number;
  mimeType?: string;
  fileName?: string;
};

/** getFile + download into storage. The caller deletes the blob. */
async function fetchToStorage(
  ctx: ActionCtx,
  media: MediaArg,
  maxBytes: number = TELEGRAM_FILE_MAX_BYTES,
): Promise<{ ok: true; storageId: Id<"_storage">; size: number; mimeType: string } | { ok: false; reason: "too_large" | "failed" }> {
  // Size known from the update → refuse BEFORE any network call.
  if (media.fileSize !== undefined && media.fileSize > maxBytes) return { ok: false, reason: "too_large" };
  const file = await getFile({ fileId: media.fileId });
  if (!file.ok || !file.result.file_path) return { ok: false, reason: "failed" };
  if ((file.result.file_size ?? 0) > maxBytes) return { ok: false, reason: "too_large" };
  const dl = await downloadTelegramFile(file.result.file_path, { timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes });
  if (!dl.ok) return { ok: false, reason: dl.reason === "too_large" ? "too_large" : "failed" };
  const mimeType = media.mimeType ?? dl.contentType;
  const storageId = await ctx.storage.store(new Blob([dl.bytes], { type: mimeType }));
  return { ok: true, storageId, size: dl.bytes.byteLength, mimeType };
}

async function transcribeVoice(ctx: ActionCtx, target: RunTarget, media: MediaArg): Promise<string | null> {
  const stored = await fetchToStorage(ctx, media);
  if (!stored.ok) {
    await send(ctx, {
      chatId: target.chatId,
      text: stored.reason === "too_large" ? COPILOT_COPY.voiceTooBig((media.fileSize ?? 0) / 1024 / 1024) : COPILOT_COPY.voiceFailed,
    });
    return null;
  }
  try {
    const res: { status: "done" | "failed"; text?: string } = await ctx.runAction(
      internal.transcription.internalTranscribeStoredAudio,
      { storageId: stored.storageId, size: stored.size },
    );
    if (res.status !== "done" || !res.text?.trim()) {
      await send(ctx, { chatId: target.chatId, text: COPILOT_COPY.voiceFailed });
      return null;
    }
    const text = res.text.trim();
    await send(ctx, { chatId: target.chatId, text: COPILOT_COPY.voiceHeard(text.length > 600 ? `${text.slice(0, 600)}…` : text) });
    return text;
  } finally {
    await ctx.storage.delete(stored.storageId);
  }
}

async function describePhoto(ctx: ActionCtx, target: RunTarget, media: MediaArg): Promise<string | null> {
  // Vision reads at most 5 MB: never download more than that.
  const stored = await fetchToStorage(ctx, media, MAX_IMAGE_BYTES);
  if (!stored.ok) {
    await send(ctx, {
      chatId: target.chatId,
      text: stored.reason === "too_large" ? COPILOT_COPY.photoTooBig : COPILOT_COPY.photoFailed("download falhou"),
    });
    return null;
  }
  try {
    const res: { status: "done" | "failed"; text?: string; error?: string } = await ctx.runAction(
      internal.vision.internalDescribeImageForCopilot,
      {
        organizationId: target.organizationId,
        memberId: target.memberId,
        storageId: stored.storageId,
        mimeType: stored.mimeType,
        size: stored.size,
      },
    );
    if (res.status !== "done" || !res.text) {
      await send(ctx, { chatId: target.chatId, text: COPILOT_COPY.photoFailed(res.error ?? "sem leitura") });
      return null;
    }
    return res.text;
  } finally {
    await ctx.storage.delete(stored.storageId);
  }
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export type TelegramTurnOptions = {
  /** D22: extra system text appended (automatic / suggestion modes). */
  extraSystem?: string;
  toolFilter?: (spec: AgentToolSpec) => boolean;
  /** Stream drafts + send the final text and pending cards (false for the automatic record flow). */
  interactive?: boolean;
  /** Gate failures (AI off, spend cap) do not message the chat: the caller falls back to the card. */
  quiet?: boolean;
  /** D22: write tools run with `via:"telegram_auto"` (undo steps, audit). */
  toolVia?: "telegram_auto";
  /** "assistant": event turns use `telegramLinks.assistantThreadId` ("Assistente"). */
  thread?: "copilot" | "assistant";
  /** Session/routes already resolved (and gated) by the caller. */
  prepared?: PreparedSession;
};
type PreparedSession = { session: CopilotSession; routes: any[]; canonicalModel: string };

/** Maps session/route failures to the §4.10 copy (sent) and returns false. */
async function prepareSession(
  ctx: ActionCtx,
  target: RunTarget,
  quiet = false,
): Promise<PreparedSession | null> {
  const say = async (out: Out) => {
    if (!quiet) await send(ctx, out);
  };
  let session: CopilotSession;
  try {
    session = await ctx.runQuery(internal.copilot.internalResolveSessionForMember, {
      organizationId: target.organizationId,
      memberId: target.memberId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    const text = /desativado/i.test(msg)
      ? COPILOT_COPY.copilotOff(target.orgName)
      : /não está ativada/i.test(msg)
        ? COPILOT_COPY.aiOff(target.orgName)
        : COPILOT_COPY.turnError;
    await say({ chatId: target.chatId, text, keyboard: settingsButton("ai") });
    return null;
  }
  const gate: { blocked: boolean } = await ctx.runQuery(internal.aiSpend.internalSpendGate, {
    organizationId: target.organizationId,
    month: monthKeyUtc(Date.now()),
  });
  if (gate.blocked) {
    await say({ chatId: target.chatId, text: COPILOT_COPY.spendCap(target.orgName), keyboard: settingsButton("ai") });
    return null;
  }
  try {
    const { routes, canonicalModel } = await resolveCopilotRoutes(ctx, target.organizationId, session.providerConfig, "telegramCopilot");
    return { session, routes, canonicalModel };
  } catch {
    await say({ chatId: target.chatId, text: COPILOT_COPY.noRoute });
    return null;
  }
}

export type TurnOutcome = {
  status: "done" | "error" | "canceled" | "gated";
  finalText: string;
  toolCallNames: string[];
  pendingActionIds: Id<"pendingActions">[];
  threadId?: Id<"copilotThreads">;
  agentRunId?: Id<"agentRuns">;
};

/** Runs one Copilot turn for the link (shared by free text, auto and suggest turns). */
export async function runTelegramTurn(
  ctx: ActionCtx,
  target: RunTarget,
  text: string,
  opts: TelegramTurnOptions = {},
): Promise<TurnOutcome> {
  const interactive = opts.interactive !== false;
  const prepared = opts.prepared ?? (await prepareSession(ctx, target, opts.quiet === true));
  if (!prepared) return { status: "gated", finalText: "", toolCallNames: [], pendingActionIds: [] };
  const now = Date.now();
  const contextBlock = target.focusConversationId
    ? ((await ctx.runQuery(internal.telegramCopilot.internalBuildFocusContext, {
        organizationId: target.organizationId,
        conversationId: target.focusConversationId,
      })) ?? undefined)
    : undefined;
  const systemPrompt =
    buildSystemPrompt(prepared.session, now, { variant: "telegram" }) + (opts.extraSystem ? `\n\n${opts.extraSystem}` : "");

  // Streaming drafts (D10): ≥ 1 s apart; refused method → typing only.
  // Random per turn (two turns in the same ms must not share a draft bubble); Bot API wants a non-zero int.
  const draftId = 1 + Math.floor(Math.random() * 2_000_000_000);
  let buffer = "";
  let lastDraftAt = 0;
  let draftsOn = interactive;
  const draft = async (force = false) => {
    if (!draftsOn) return;
    const t = Date.now();
    if (!force && t - lastDraftAt < DRAFT_THROTTLE_MS) return;
    lastDraftAt = t;
    const res = await sendMessageDraft({ chatId: target.chatId, draftId, text: buffer.trim() || THINKING_TEXT });
    if (!res.ok && res.kind !== "rate_limited") {
      draftsOn = false;
      await sendChatAction({ chatId: target.chatId, action: "typing" });
    }
  };
  if (interactive) await draft(true);
  else await sendChatAction({ chatId: target.chatId, action: "typing" });

  const slot = opts.thread ?? "copilot";
  const threadId = slot === "assistant" ? target.assistantThreadId : target.threadId;
  const result = await runCopilotTurn(ctx, {
    organizationId: target.organizationId,
    session: prepared.session,
    routes: prepared.routes,
    canonicalModel: prepared.canonicalModel,
    threadId,
    text,
    kind: "telegram_copilot",
    systemPrompt,
    ...(contextBlock ? { contextBlock } : {}),
    ...(opts.toolFilter ? { toolFilter: opts.toolFilter } : {}),
    ...(target.focusConversationId ? { focusConversationId: target.focusConversationId } : {}),
    // D22: lets the write executors record undo steps (copilotTurn passes it to the tool runner).
    ...(opts.toolVia ? { toolVia: opts.toolVia } : {}),
    onDelta: async (delta: string) => {
      buffer += delta;
      await draft();
    },
    onTool: async () => {
      await sendChatAction({ chatId: target.chatId, action: "typing" });
    },
    shouldCancel: async () =>
      await ctx.runQuery(internal.telegramCopilot.internalCancelRequestedSince, { chatId: target.chatId, since: now }),
  });

  if (result.threadId && result.threadId !== threadId) {
    await ctx.runMutation(internal.telegramCopilot.internalSetCopilotThread, { linkId: target.linkId, threadId: result.threadId, slot });
    if (!threadId) {
      await ctx.runMutation(internal.copilot.internalSetThreadTitle, {
        threadId: result.threadId,
        title: slot === "assistant" ? "Assistente" : "Telegram",
      });
    }
  }

  if (interactive) {
    if (result.status === "canceled") {
      await send(ctx, { chatId: target.chatId, text: COPILOT_COPY.canceled });
    } else if (result.status === "error") {
      await send(ctx, { chatId: target.chatId, text: COPILOT_COPY.turnError });
    } else if (result.finalText.trim()) {
      await send(ctx, {
        chatId: target.chatId,
        text: markdownToTelegramHtml(result.finalText),
        protectContent: target.protectContent,
        record: { organizationId: target.organizationId, linkId: target.linkId, kind: "copilot" },
      });
    }
    await sendPendingCards(ctx, target, result.pendingActionIds);
  }
  return {
    status: result.status,
    finalText: result.finalText,
    toolCallNames: result.toolCallNames ?? [],
    pendingActionIds: result.pendingActionIds,
    threadId: result.threadId,
    ...(result.agentRunId ? { agentRunId: result.agentRunId } : {}),
  };
}

/** Each pending action of the turn → a card with Confirmar (`pa:`) · Cancelar (`pc:`). */
export async function sendPendingCards(ctx: ActionCtx, target: RunTarget, ids: Id<"pendingActions">[]): Promise<void> {
  if (ids.length === 0) return;
  const previews: { id: Id<"pendingActions">; preview: string }[] = await ctx.runQuery(
    internal.telegramCopilot.internalPendingActionPreviews,
    { ids, organizationId: target.organizationId },
  );
  for (const p of previews) {
    await send(ctx, {
      chatId: target.chatId,
      text: COPILOT_COPY.pendingCard(p.preview),
      keyboard: [[{ text: "✅ Confirmar", callback_data: `pa:${p.id}` }, { text: "✖ Cancelar", callback_data: `pc:${p.id}` }]],
      record: { organizationId: target.organizationId, linkId: target.linkId, kind: "copilot" },
    });
  }
}

/**
 * Free input from a linked chat (scheduled by `telegram.internalRouteUpdate`):
 * text, voice or photo. Voice with an open prompt answers the prompt.
 */
export const internalCopilotTurn = internalAction({
  args: {
    linkId: v.id("telegramLinks"),
    text: v.optional(v.string()),
    source: v.union(v.literal("text"), v.literal("voice"), v.literal("photo")),
    media: v.optional(
      v.object({
        kind: v.union(
          v.literal("voice"),
          v.literal("audio"),
          v.literal("photo"),
          v.literal("video"),
          v.literal("video_note"),
          v.literal("document"),
        ),
        fileId: v.string(),
        fileSize: v.optional(v.number()),
        mimeType: v.optional(v.string()),
        fileName: v.optional(v.string()),
      }),
    ),
    /** Retries while another turn of the same link holds the lock. */
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target: RunTarget | null = await ctx.runQuery(internal.telegramCopilot.internalGetCopilotRun, {
      linkId: args.linkId,
      now: Date.now(),
    });
    if (!target) return null;
    const token = crypto.randomUUID();
    const claim: string = await ctx.runMutation(internal.telegramCopilot.internalClaimTurn, { linkId: args.linkId, token });
    if (claim === "gone") return null;
    if (claim !== "ok") {
      const attempt = args.attempt ?? 0;
      if (attempt < TURN_MAX_RETRIES) {
        await ctx.scheduler.runAfter(TURN_RETRY_MS, internal.telegramCopilot.internalCopilotTurn, { ...args, attempt: attempt + 1 });
      } else {
        await send(ctx, { chatId: target.chatId, text: COPILOT_COPY.busy });
      }
      return null;
    }
    try {
      await copilotTurnLocked(ctx, target, args);
    } finally {
      await ctx.runMutation(internal.telegramCopilot.internalReleaseTurn, { linkId: args.linkId, token });
    }
    return null;
  },
});

async function copilotTurnLocked(
  ctx: ActionCtx,
  target: RunTarget,
  args: { text?: string; source: "text" | "voice" | "photo"; media?: MediaArg },
): Promise<void> {
  // Gates BEFORE any download/transcription/vision (no cost when the AI is off or capped).
  // Voice answering an OPEN prompt (instruct/regenerate/reply) is an attendant/human
  // action, not a Copilot turn: it needs the AI on + the spend cap, never `copilotEnabled`.
  const voiceForPrompt = args.source === "voice" && target.promptOpen;
  let prepared: PreparedSession | null = null;
  if (voiceForPrompt) {
    if (!(await promptVoiceGate(ctx, target))) return;
  } else {
    prepared = await prepareSession(ctx, target);
    if (!prepared) return;
  }
  let text = args.text?.trim() ?? "";
  if (args.source === "voice" && args.media) {
    const transcript = await transcribeVoice(ctx, target, args.media);
    if (!transcript) return;
    if (target.promptOpen) {
      // The transcript answers the open prompt (instruct / regenerate / reply).
      const answered: ActionResult | null = await ctx.runMutation(internal.telegramCopilot.internalAnswerPromptWithText, {
        chatId: target.chatId,
        text: transcript,
      });
      if (answered) {
        await deliverResult(ctx, answered);
        return;
      }
    }
    text = transcript;
  } else if (args.source === "photo" && args.media) {
    const description = await describePhoto(ctx, target, args.media);
    if (!description) return;
    // The member's caption stays plain; the vision text is data (the image may carry instructions).
    text = `${text ? `${text}\n` : ""}${wrapUntrusted("imagem enviada pelo usuário (descrição automática)", `[imagem: ${description}]`)}`;
  }
  if (!text) return;
  // The prompt expired/was answered meanwhile: the transcript becomes a Copilot turn after all.
  if (!prepared) {
    prepared = await prepareSession(ctx, target);
    if (!prepared) return;
  }
  await runTelegramTurn(ctx, target, text, { prepared });
}

/** Gate for a voice note that answers an open prompt: AI on + spend cap (copy sent on refusal). */
async function promptVoiceGate(ctx: ActionCtx, target: RunTarget): Promise<boolean> {
  const aiOn: boolean = await ctx.runQuery(internal.telegramCopilot.internalOrgAiActive, { organizationId: target.organizationId });
  if (!aiOn) {
    await send(ctx, { chatId: target.chatId, text: COPILOT_COPY.aiOff(target.orgName), keyboard: settingsButton("ai") });
    return false;
  }
  const gate: { blocked: boolean } = await ctx.runQuery(internal.aiSpend.internalSpendGate, {
    organizationId: target.organizationId,
    month: monthKeyUtc(Date.now()),
  });
  if (gate.blocked) {
    await send(ctx, { chatId: target.chatId, text: COPILOT_COPY.spendCap(target.orgName), keyboard: settingsButton("ai") });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// D22 — assistant modes on events (automatic / suggestion)
// ---------------------------------------------------------------------------

const ASSISTANT_TRIGGERS = new Set([...AUTO_TURN_TRIGGERS, ...SUGGEST_TRIGGERS]);
const SUGGESTION_TTL_MS = 30 * 60 * 1000;

/**
 * Who handles a notification: the plain card, the automatic turn, or the
 * suggestion turn. Cheap reads only (`now` passed in). Any doubt → card.
 */
export const internalAssistantDecision = internalQuery({
  args: { notificationId: v.id("notifications"), now: v.number() },
  returns: v.object({
    route: v.union(v.literal("card"), v.literal("auto"), v.literal("suggest")),
    linkId: v.optional(v.id("telegramLinks")),
  }),
  handler: async (ctx, args) => {
    const card = { route: "card" as const };
    const n = await ctx.db.get(args.notificationId);
    if (!n || !n.conversationId || !ASSISTANT_TRIGGERS.has(n.type)) return card;
    const link = await ctx.db
      .query("telegramLinks")
      .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", n.memberId).eq("status", "active"))
      .first();
    if (!link || link.organizationId !== n.organizationId) return card;
    if (link.mutedUntil !== undefined && link.mutedUntil > args.now) return card;
    const member = await ctx.db.get(link.teamMemberId);
    if (!member || !isLinkMemberAlive(link, member)) return card;
    const org = await ctx.db.get(n.organizationId);
    if (!org || !modulesOf(org).telegram || !orgAiActive(org) || org.settings.aiConfig?.copilotEnabled === false) return card;
    const mode = effectiveAssistantMode(link, org);
    // D22 amended (incident 03/11 in PROD): the automatic turn ONLY for a customer message in the
    // conversation in focus (D17). Handoffs and stuck follow-ups behave as in suggest mode, in
    // either mode: card + read-only suggestion, the human decides.
    if (mode === "auto" && AUTO_TURN_TRIGGERS.has(n.type)) {
      if (autoActionsLeft(link, args.now) <= 0) return card;
      const chat = await chatRow(ctx, link.chatId);
      const inFocus = chat?.focus?.conversationId === n.conversationId && chat.focus.setAt > args.now - FOCUS_TTL_MS;
      if (!inFocus) return card;
      return { route: "auto" as const, linkId: link._id };
    }
    if (link.assistant.suggestOnEvents !== false && SUGGEST_TRIGGERS.has(n.type)) {
      return { route: "suggest" as const, linkId: link._id };
    }
    return card;
  },
});

const EVENT_LABELS: Record<string, string> = {
  handoff_requested: "repasse da IA para a equipe",
  new_message: "nova mensagem do cliente numa conversa sua",
  ai_followup_needs_human: "follow-up que a IA não conseguiu fazer",
};

export const internalAssistantEvent = internalQuery({
  args: { notificationId: v.id("notifications"), linkId: v.id("telegramLinks") },
  returns: v.union(
    v.null(),
    v.object({
      text: v.string(),
      conversationId: v.id("conversations"),
      leadId: v.optional(v.id("leads")),
      handoffId: v.optional(v.id("handoffs")),
      leadLabel: v.string(),
      timezone: v.string(),
      allowedWriteTools: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.notificationId);
    const link = await ctx.db.get(args.linkId);
    if (!n || !link || !n.conversationId || n.organizationId !== link.organizationId) return null;
    const conversation = await ctx.db.get(n.conversationId);
    const org = await ctx.db.get(n.organizationId);
    if (!conversation || !org || conversation.organizationId !== org._id) return null;
    const lead = conversation.leadId ? await ctx.db.get(conversation.leadId) : null;
    const title = lead?.title ?? "Contato";
    const discreet = org.settings.telegram?.discreet === true;
    return {
      text: [
        `Evento do CRM: ${EVENT_LABELS[n.type] ?? n.type}.`,
        // Title/body derive from the customer's text (new_message body IS it): data, never instruction.
        wrapUntrustedJson("dados do evento (título e detalhe da notificação)", {
          titulo: n.title,
          ...(n.body ? { detalhe: n.body.slice(0, 500) } : {}),
        }),
        "A conversa deste evento é a conversa em foco (bloco de contexto).",
      ]
        .filter(Boolean)
        .join("\n"),
      conversationId: conversation._id,
      ...(lead ? { leadId: lead._id } : {}),
      ...(n.handoffId ? { handoffId: n.handoffId } : {}),
      leadLabel: discreet ? initials(title) : title,
      timezone: safeTimezone(org.settings.timezone),
      allowedWriteTools: autoWriteTools(link),
    };
  },
});

/** Undo steps of ONE automatic turn (keyed by its `agentRuns` id, never by time). */
export const internalAutoStepsForRun = internalQuery({
  args: { runId: v.id("agentRuns") },
  returns: v.array(v.object({ kind: v.string(), refId: v.string(), before: v.optional(v.any()), after: v.optional(v.any()) })),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("telegramAutoSteps")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .take(50);
    return rows.map((r) => ({
      kind: r.kind,
      refId: r.refId,
      ...(r.before !== undefined ? { before: r.before } : {}),
      ...(r.after !== undefined ? { after: r.after } : {}),
    }));
  },
});

const suggestionValidator = v.object({
  tool: v.union(v.literal("instructAttendant"), v.literal("acceptHandoff"), v.literal("regenerateAiReply")),
  args: v.record(v.string(), v.string()),
  resumo: v.string(),
});
type Suggestion = { tool: "instructAttendant" | "acceptHandoff" | "regenerateAiReply"; args: Record<string, string>; resumo: string };
/** A handoff's suggestion is shared by every member it was broadcast to for 10 min (review #11). */
export const SUGGESTION_SHARE_MS = 10 * 60 * 1000;
/** A "pending" claim older than this is abandoned (turn died): the next member recomputes. */
const SUGGESTION_PENDING_STALE_MS = 2 * 60 * 1000;

/**
 * One suggestion LLM call per handoff: the first member's turn claims it
 * ("run"), the others wait for it ("wait") or reuse it ("cached", null = the
 * model proposed nothing).
 */
export const internalClaimSuggestion = internalMutation({
  args: { organizationId: v.id("organizations"), handoffId: v.id("handoffs") },
  returns: v.union(
    v.object({ kind: v.literal("run"), rowId: v.id("telegramSuggestions") }),
    v.object({ kind: v.literal("wait") }),
    v.object({ kind: v.literal("cached"), suggestion: v.union(v.null(), suggestionValidator) }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const latest = await ctx.db
      .query("telegramSuggestions")
      .withIndex("by_handoff_and_created", (q) => q.eq("handoffId", args.handoffId).gte("createdAt", now - SUGGESTION_SHARE_MS))
      .order("desc")
      .first();
    if (latest && latest.organizationId === args.organizationId) {
      if (latest.status === "done") return { kind: "cached" as const, suggestion: latest.suggestion ?? null };
      if (latest.createdAt > now - SUGGESTION_PENDING_STALE_MS) return { kind: "wait" as const };
    }
    const rowId = await ctx.db.insert("telegramSuggestions", {
      organizationId: args.organizationId,
      handoffId: args.handoffId,
      status: "pending",
      createdAt: now,
    });
    return { kind: "run" as const, rowId };
  },
});

export const internalStoreSuggestion = internalMutation({
  args: { rowId: v.id("telegramSuggestions"), suggestion: v.optional(suggestionValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (row) await ctx.db.patch(row._id, { status: "done", ...(args.suggestion ? { suggestion: args.suggestion } : {}) });
    return null;
  },
});

/** Suggest mode: the proposed write becomes a pendingAction ("💡 Aplicar sugestão"). */
export const internalCreateSuggestion = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    threadId: v.optional(v.id("copilotThreads")),
    conversationId: v.id("conversations"),
    tool: v.union(v.literal("instructAttendant"), v.literal("acceptHandoff"), v.literal("regenerateAiReply")),
    args: v.record(v.string(), v.string()),
    preview: v.string(),
  },
  returns: v.id("pendingActions"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("pendingActions", {
      organizationId: args.organizationId,
      requestedBy: args.memberId,
      ...(args.threadId ? { threadId: args.threadId } : {}),
      tool: args.tool,
      args: { ...args.args, conversationId: args.conversationId },
      preview: args.preview,
      status: "pending",
      expiresAt: now + SUGGESTION_TTL_MS,
      createdAt: now,
    });
  },
});

type AssistantEvent = {
  text: string;
  conversationId: Id<"conversations">;
  leadId?: Id<"leads">;
  handoffId?: Id<"handoffs">;
  leadLabel: string;
  timezone: string;
  allowedWriteTools: string[];
};

async function deliverCard(
  ctx: ActionCtx,
  notificationId: Id<"notifications">,
  extra: { preface?: string; suggestion?: { pendingActionId: Id<"pendingActions">; summary: string } } = {},
) {
  await ctx.runAction(internal.telegram.internalDeliverNotification, { notificationId, forceCard: true, ...extra });
}

type AssistantTurnArgs = { linkId: Id<"telegramLinks">; notificationId: Id<"notifications">; attempt?: number };

/**
 * Claims the link's turn for an assistant event. Locked → retry in 5 s (up to
 * TURN_MAX_RETRIES), then the plain card. Capped/gone → the plain card.
 */
async function claimAssistantTurn(
  ctx: ActionCtx,
  args: AssistantTurnArgs,
  kind: "auto" | "suggest",
): Promise<string | null> {
  const token = crypto.randomUUID();
  const claim: string = await ctx.runMutation(internal.telegramCopilot.internalClaimTurn, {
    linkId: args.linkId,
    token,
    slot: "assistant",
    ...(kind === "auto" ? { reserveAuto: true } : {}),
  });
  if (claim === "ok") return token;
  const attempt = args.attempt ?? 0;
  if (claim === "locked" && attempt < TURN_MAX_RETRIES) {
    const next = { linkId: args.linkId, notificationId: args.notificationId, attempt: attempt + 1 };
    if (kind === "auto") await ctx.scheduler.runAfter(TURN_RETRY_MS, internal.telegramCopilot.internalAssistantAutoTurn, next);
    else await ctx.scheduler.runAfter(TURN_RETRY_MS, internal.telegramCopilot.internalAssistantSuggestTurn, next);
    return null;
  }
  await deliverCard(ctx, args.notificationId);
  return null;
}

async function prepareAssistant(ctx: ActionCtx, linkId: Id<"telegramLinks">, notificationId: Id<"notifications">) {
  const target: RunTarget | null = await ctx.runQuery(internal.telegramCopilot.internalGetCopilotRun, { linkId, now: Date.now() });
  const event: AssistantEvent | null = target
    ? await ctx.runQuery(internal.telegramCopilot.internalAssistantEvent, { notificationId, linkId })
    : null;
  if (!target || !event) return null;
  // D17: the chat focus changes only by tap, reply or command. The event's
  // conversation reaches THIS turn as `focusConversationId` (context block +
  // D18 tools) and is never persisted on `telegramChats.focus`.
  return { target: { ...target, focusConversationId: event.conversationId }, event };
}

/**
 * Automatic mode (D22, §3.4b): the event becomes a Copilot turn with only the
 * `autoAllowed` write tools. Writes → ONE record card "🤖 Resolvi sozinha"
 * with ↩️ Desfazer (10 min) · ✏️ Ajustar · 👁 Ver conversa; no write → the
 * normal card with "🤔 Não decidi sozinha…". Gated AI → the normal card.
 */
export const internalAssistantAutoTurn = internalAction({
  args: { linkId: v.id("telegramLinks"), notificationId: v.id("notifications"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await claimAssistantTurn(ctx, args, "auto");
    if (!token) return null;
    // The reserved cap slot is returned (−1) unless the turn wrote something.
    let autoAdjust = -1;
    try {
      autoAdjust = await assistantAutoTurnLocked(ctx, args);
    } finally {
      await ctx.runMutation(internal.telegramCopilot.internalReleaseTurn, { linkId: args.linkId, token, autoAdjust, slot: "assistant" });
    }
    return null;
  },
});

/** Returns the cap adjustment: −1 (no write, slot returned) or steps − 1. */
async function assistantAutoTurnLocked(ctx: ActionCtx, args: AssistantTurnArgs): Promise<number> {
  const prepared = await prepareAssistant(ctx, args.linkId, args.notificationId);
  if (!prepared) {
    await deliverCard(ctx, args.notificationId);
    return -1;
  }
  const { target, event } = prepared;
  const allowed = new Set(event.allowedWriteTools);
  const outcome = await runTelegramTurn(ctx, target, event.text, {
    extraSystem: autoModeSystemText(event.allowedWriteTools),
    toolFilter: (spec) => spec.effect === "read" || (spec.effect === "write" && allowed.has(spec.name)),
    interactive: false,
    quiet: true,
    toolVia: "telegram_auto",
    thread: "assistant",
  });
  if (outcome.status === "gated" || !outcome.threadId || !outcome.agentRunId) {
    await deliverCard(ctx, args.notificationId);
    return -1;
  }
  const steps: { kind: string; refId: string; before?: unknown; after?: unknown }[] = await ctx.runQuery(
    internal.telegramCopilot.internalAutoStepsForRun,
    { runId: outcome.agentRunId },
  );
  if (steps.length === 0) {
    const why = outcome.finalText.trim().replace(/\s+/g, " ").slice(0, 300);
    await deliverCard(ctx, args.notificationId, { preface: `🤔 Não decidi sozinha${why ? `: ${why}` : "."}` });
    await sendPendingCards(ctx, target, outcome.pendingActionIds);
    return -1;
  }
  const now = Date.now();
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone: event.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(now));
  const contextHtml = outcome.finalText.trim() ? markdownToTelegramHtml(outcome.finalText.trim().slice(0, 800)) : "";
  const text = [
    `🤖 Resolvi sozinha · <b>${escapeHtml(event.leadLabel)}</b> · ${time}`,
    contextHtml,
    "Fiz:",
    ...steps.map((st) => `• ${escapeHtml(STEP_LABELS[st.kind] ?? st.kind)}`),
  ]
    .filter(Boolean)
    .join("\n");
  await ctx.runAction(internal.telegram.internalDeliverReply, {
    reply: {
      chatId: target.chatId,
      chunks: splitMessage(text),
      keyboard: [
        [
          { text: "↩️ Desfazer", callback_data: `un:${args.notificationId}` },
          { text: "✏️ Ajustar", callback_data: `aj:${event.conversationId}` },
        ],
        [{ text: "👁 Ver conversa", callback_data: `va:${event.conversationId}` }],
      ],
      ...(target.protectContent ? { protectContent: true } : {}),
      record: {
        organizationId: target.organizationId,
        linkId: target.linkId,
        kind: "auto_record",
        conversationId: event.conversationId,
        notificationId: args.notificationId,
        ...(event.handoffId ? { handoffId: event.handoffId } : {}),
        undo: { steps: steps as { kind: string; refId: string; before?: any; after?: any }[], expiresAt: now + UNDO_WINDOW_MS },
      },
    },
    attempt: 1,
  });
  await sendPendingCards(ctx, target, outcome.pendingActionIds);
  return steps.length - 1;
}

/**
 * Suggest mode with `suggestOnEvents` (§3.4b "💡 Sugiro"): a READ-ONLY turn
 * proposes one action; it becomes a pendingAction and the normal card gains
 * "💡 Sugiro: …" + "💡 Aplicar sugestão". No proposal → the plain card.
 */
export const internalAssistantSuggestTurn = internalAction({
  args: { linkId: v.id("telegramLinks"), notificationId: v.id("notifications"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await claimAssistantTurn(ctx, args, "suggest");
    if (!token) return null;
    let retry = false;
    try {
      retry = (await assistantSuggestTurnLocked(ctx, args)) === "wait";
    } finally {
      await ctx.runMutation(internal.telegramCopilot.internalReleaseTurn, { linkId: args.linkId, token, slot: "assistant" });
    }
    if (retry) {
      // Another member's turn is computing this handoff's suggestion: wait for it.
      const attempt = args.attempt ?? 0;
      if (attempt < TURN_MAX_RETRIES) {
        await ctx.scheduler.runAfter(TURN_RETRY_MS, internal.telegramCopilot.internalAssistantSuggestTurn, {
          linkId: args.linkId,
          notificationId: args.notificationId,
          attempt: attempt + 1,
        });
      } else {
        await deliverCard(ctx, args.notificationId);
      }
    }
    return null;
  },
});

async function assistantSuggestTurnLocked(ctx: ActionCtx, args: AssistantTurnArgs): Promise<"done" | "wait"> {
  const prepared = await prepareAssistant(ctx, args.linkId, args.notificationId);
  if (!prepared) {
    await deliverCard(ctx, args.notificationId);
    return "done";
  }
  const { target, event } = prepared;
  const compute = async (): Promise<{ suggestion: Suggestion | null; threadId?: Id<"copilotThreads"> }> => {
    const outcome = await runTelegramTurn(ctx, target, event.text, {
      extraSystem: SUGGEST_SYSTEM_TEXT,
      toolFilter: (spec) => spec.effect === "read",
      interactive: false,
      quiet: true,
      thread: "assistant",
    });
    return {
      suggestion: outcome.status === "done" ? parseSuggestion(outcome.finalText) : null,
      ...(outcome.threadId ? { threadId: outcome.threadId } : {}),
    };
  };
  let suggestion: Suggestion | null;
  let threadId: Id<"copilotThreads"> | undefined;
  if (event.handoffId) {
    const claim: { kind: "run"; rowId: Id<"telegramSuggestions"> } | { kind: "wait" } | { kind: "cached"; suggestion: Suggestion | null } =
      await ctx.runMutation(internal.telegramCopilot.internalClaimSuggestion, {
        organizationId: target.organizationId,
        handoffId: event.handoffId,
      });
    if (claim.kind === "wait") return "wait";
    if (claim.kind === "cached") {
      suggestion = claim.suggestion;
    } else {
      let computed: Suggestion | null = null;
      try {
        const res = await compute();
        computed = res.suggestion;
        threadId = res.threadId;
      } finally {
        await ctx.runMutation(internal.telegramCopilot.internalStoreSuggestion, {
          rowId: claim.rowId,
          ...(computed ? { suggestion: computed } : {}),
        });
      }
      suggestion = computed;
    }
  } else {
    const res = await compute();
    suggestion = res.suggestion;
    threadId = res.threadId;
  }
  if (!suggestion) {
    await deliverCard(ctx, args.notificationId);
    return "done";
  }
  // Each member gets their OWN pendingAction (`requestedBy` differs), same proposal.
  const pendingActionId = await ctx.runMutation(internal.telegramCopilot.internalCreateSuggestion, {
    organizationId: target.organizationId,
    memberId: target.memberId,
    ...(threadId ? { threadId } : {}),
    conversationId: event.conversationId,
    tool: suggestion.tool,
    args: suggestion.args,
    preview: suggestion.resumo,
  });
  await deliverCard(ctx, args.notificationId, { suggestion: { pendingActionId, summary: suggestion.resumo } });
  return "done";
}
