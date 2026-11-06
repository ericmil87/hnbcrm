/**
 * PORTA ÚNICA de agendamento da tradução automática (F1). Só este arquivo (e o
 * desvio em `lib/outboundDispatch.ts`, que chama `maybeDivertOutboundForTranslation`
 * daqui) agenda `internal.translation.*` — build guard `convex/translationPort.test.ts`.
 *
 * - `scheduleMessageTranslation`: inbound (os 4 receivers + transcrição) e
 *   exibição (`role:"display"`, commit do atendente). No-op barato quando o
 *   gate recusa — org sem módulo não ganha nenhuma escrita nem job.
 * - `maybeDivertOutboundForTranslation`: o desvio da saída. Na MESMA transação
 *   do insert, grava `metadata.translation.pending` e agenda
 *   `translateAndDispatch` em vez do dispatcher. Mensagem com tradução de saída
 *   `pending`/`failed` fica RETIDA (nunca sai em pt-BR sozinha, D5).
 * - `scheduleMessageTranslation(role:"draft")` (F3): rascunho da IA no idioma
 *   do lead ganha `metadata.aiDraft.translatedText` para a equipe ler.
 * - `markOutboundTranslationFailed`: o único jeito de reprovar uma saída
 *   traduzida (`failed` + `deliveryStatus:"failed"` legível), usado pela action,
 *   pelo watchdog por mensagem e pelo ops de presas.
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { getLeadRef } from "./leadRef";
import { maybeNotifyTelegramSendFailed } from "./telegramRelay";
import { normalizeLanguageCode } from "./languages";
import { resolveTargetLanguage } from "./translationLang";
import {
  resolveTranslationSettings,
  shouldTranslateDisplay,
  shouldTranslateDraft,
  shouldTranslateInbound,
  shouldTranslateOutbound,
  translationEnabledForOrg,
  translationOf,
  TranslationMeta,
} from "./translationGate";

/** Tradução de saída `pending` mais velha que isto vira `failed` (watchdog). */
export const OUTBOUND_PENDING_TIMEOUT_MS = 2 * 60 * 1000;
export const OUTBOUND_TIMEOUT_ERROR =
  "A tradução demorou demais e a mensagem não foi enviada. Tente de novo ou envie sem tradução.";

type MessageDoc = Doc<"messages">;

/** Decisão pura do agendamento (inbound/display). */
export function shouldScheduleMessageTranslation(args: {
  org: Doc<"organizations"> | null | undefined;
  conversation: Doc<"conversations"> | null | undefined;
  message: MessageDoc;
  role: "inbound" | "display";
  text?: string;
}): boolean {
  if (!translationEnabledForOrg(args.org)) return false;
  if (args.role === "display") {
    return shouldTranslateDisplay({ org: args.org, conversation: args.conversation, message: args.message }).ok;
  }
  // `ask` não bloqueia o agendamento: a action ainda detecta o idioma da
  // conversa (o banner "Traduzir esta conversa?" depende disso).
  const decision = shouldTranslateInbound({
    org: args.org,
    conversation: args.conversation,
    message: args.message,
    text: args.text,
  });
  return decision.ok || (!decision.ok && decision.reason === "aguardando_escolha");
}

/**
 * Agenda a tradução de UMA mensagem (inbound ou exibição). `hintLang` = idioma
 * já conhecido de fora (Whisper); `text` = texto a traduzir quando não é o
 * `content` (transcrição de áudio).
 */
export async function scheduleMessageTranslation(
  ctx: MutationCtx,
  args: {
    messageId: Id<"messages">;
    role: "inbound" | "display" | "draft";
    hintLang?: string;
    text?: string;
    conversation?: Doc<"conversations"> | null;
  }
): Promise<boolean> {
  if (args.role === "draft") return await scheduleDraftTranslation(ctx, args.messageId, args.conversation);
  const message = await ctx.db.get(args.messageId);
  if (!message || message.isInternal) return false;
  if (args.role === "inbound" && message.direction !== "inbound") return false;
  if (args.role === "display" && message.senderType !== "ai") return false;
  const conversation = args.conversation ?? (await ctx.db.get(message.conversationId));
  // Grupo e nota interna saem antes de ler a org (nenhuma leitura extra no caminho quente de grupo).
  if (!conversation || conversation.kind === "group" || message.isInternal) return false;
  const org = await ctx.db.get(message.organizationId);
  if (!shouldScheduleMessageTranslation({ org, conversation, message, role: args.role, text: args.text })) {
    return false;
  }
  const hint = normalizeLanguageCode(args.hintLang);
  if (args.role === "display") {
    await ctx.scheduler.runAfter(0, internal.translation.autoTranslateDisplay, { messageId: args.messageId });
  } else {
    await ctx.scheduler.runAfter(0, internal.translation.autoTranslateInbound, {
      messageId: args.messageId,
      ...(hint ? { hintLang: hint } : {}),
      ...(args.text !== undefined ? { fromTranscript: true } : {}),
    });
  }
  return true;
}

/** F3: rascunho (nota interna da IA) → `metadata.aiDraft.translatedText`. */
async function scheduleDraftTranslation(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  known: Doc<"conversations"> | null | undefined
): Promise<boolean> {
  const message = await ctx.db.get(messageId);
  if (!message || message.senderType !== "ai" || !message.metadata?.aiDraft) return false;
  const conversation = known ?? (await ctx.db.get(message.conversationId));
  if (!conversation || conversation.kind === "group") return false;
  // Sem idioma estrangeiro na conversa: sai antes de ler a org.
  if (!conversation.translation?.lang || conversation.translation.mode === "off") return false;
  const org = await ctx.db.get(message.organizationId);
  if (!shouldTranslateDraft({ org, conversation, message }).ok) return false;
  await ctx.scheduler.runAfter(0, internal.translation.autoTranslateDraft, { messageId });
  return true;
}

/** Idioma de destino de uma outbound (override da mensagem > conversa > contato). */
export async function outboundTargetLanguage(
  ctx: { db: QueryCtx["db"] },
  conversation: Doc<"conversations">,
  message: MessageDoc
): Promise<string | undefined> {
  const override = normalizeLanguageCode(message.metadata?.translationTarget as string | undefined);
  if (override) return override;
  const lead = await getLeadRef(ctx.db, conversation.leadId);
  const contact = lead?.contactId ? await ctx.db.get(lead.contactId) : null;
  const resolved = resolveTargetLanguage({
    conversation: conversation.translation,
    contactPreferredLanguage: contact?.organizationId === conversation.organizationId ? contact.preferredLanguage : undefined,
  });
  return resolved.hintOnly ? undefined : resolved.lang;
}

export type OutboundDiversion = "dispatch" | "diverted" | "held";

/**
 * O desvio da porta de saída. "dispatch" = siga para o canal; "diverted" =
 * tradução agendada (não despache agora); "held" = tradução pendente ou
 * falhou — não despache (a UI oferece "Tentar de novo"/"Enviar sem tradução").
 */
export async function maybeDivertOutboundForTranslation(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  messageId: Id<"messages">
): Promise<OutboundDiversion> {
  if (conversation.kind === "group") return "dispatch";
  const message = await ctx.db.get(messageId);
  if (!message || message.direction !== "outbound") return "dispatch";
  const existing = translationOf(message);
  if (existing?.role === "outbound" && (existing.status === "pending" || existing.status === "failed")) {
    return "held";
  }
  if (existing) return "dispatch";
  const org = await ctx.db.get(conversation.organizationId);
  if (!translationEnabledForOrg(org)) return "dispatch";
  const targetLang = await outboundTargetLanguage(ctx, conversation, message);
  if (!shouldTranslateOutbound({ org, conversation, message, targetLang }).ok) return "dispatch";

  const now = Date.now();
  const pending: TranslationMeta = {
    status: "pending",
    role: "outbound",
    sourceLang: resolveTranslationSettings(org).teamLanguage,
    targetLang: normalizeLanguageCode(targetLang)!,
    at: now,
  };
  await ctx.db.patch(messageId, { metadata: { ...(message.metadata ?? {}), translation: pending } });
  await scheduleOutboundTranslation(ctx, messageId);
  return "diverted";
}

/** Agenda a tradução de saída + o watchdog por mensagem (rede de segurança). */
export async function scheduleOutboundTranslation(ctx: MutationCtx, messageId: Id<"messages">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.translation.translateAndDispatch, { messageId });
  await ctx.scheduler.runAfter(OUTBOUND_PENDING_TIMEOUT_MS + 5_000, internal.translation.internalExpirePendingOutbound, {
    messageId,
  });
}

/**
 * Metadados de insert de uma outbound a partir dos args `language`/`translation`
 * de `sendMessage`/`internalSendMessageCore`/REST. Sem nenhum dos dois = `{}`
 * (byte a byte o insert de antes).
 */
export function outboundTranslationInsertFields(
  args: {
    language?: string;
    translation?: { authoredText: string; sourceLang: string; targetLang: string; edited?: boolean };
    isInternal?: boolean;
  },
  now: number
): { metadata?: Record<string, unknown>; translatedText?: string } {
  if (args.isInternal) return {};
  if (args.translation) {
    const sourceLang = normalizeLanguageCode(args.translation.sourceLang);
    const targetLang = normalizeLanguageCode(args.translation.targetLang);
    if (!sourceLang || !targetLang) throw new Error("Idioma da tradução não suportado");
    const authored = args.translation.authoredText;
    if (authored.length > 20_000) throw new Error("Texto original longo demais");
    const meta: TranslationMeta = {
      status: "done",
      role: "outbound",
      sourceLang,
      targetLang,
      ...(args.translation.edited ? { edited: true } : {}),
      at: now,
    };
    return { metadata: { translation: meta }, translatedText: authored };
  }
  if (args.language === undefined || args.language === "auto") return {};
  if (args.language === "off") {
    const meta: TranslationMeta = { status: "skipped", role: "outbound", reason: "language_off", at: now };
    return { metadata: { translation: meta } };
  }
  const code = normalizeLanguageCode(args.language);
  if (!code) throw new Error(`Idioma "${args.language}" não suportado`);
  return { metadata: { translationTarget: code } };
}

/**
 * Reprova uma saída traduzida: `metadata.translation.failed` + `deliveryStatus:
 * "failed"` legível (mesma semântica de `whatsapp.internalMarkDispatchFailed`:
 * nunca rebaixa uma mensagem que já saiu). Devolve false quando não havia o
 * que reprovar.
 */
export async function markOutboundTranslationFailed(
  ctx: MutationCtx,
  message: MessageDoc,
  error: string
): Promise<boolean> {
  const current = translationOf(message);
  if (!current || current.role !== "outbound" || current.status !== "pending") return false;
  if (message.externalId) return false;
  const now = Date.now();
  const detail = `Tradução falhou: ${error}`.slice(0, 300);
  const translation: TranslationMeta = { ...current, status: "failed", error: error.slice(0, 300), at: now };
  await ctx.db.patch(message._id, {
    deliveryStatus: "failed",
    metadata: { ...(message.metadata ?? {}), translation, deliveryError: detail },
  });
  if (message.leadId) {
    await ctx.db.insert("activities", {
      organizationId: message.organizationId,
      leadId: message.leadId,
      type: "note",
      actorType: "system",
      content: "Mensagem não enviada: a tradução automática falhou",
      metadata: { conversationId: message.conversationId, messageId: message._id },
      createdAt: now,
    });
  }
  await maybeNotifyTelegramSendFailed(ctx, message, detail);
  return true;
}

/** Ops de presas: a saída está retida numa tradução `pending` velha? */
export function isStuckOutboundTranslation(message: MessageDoc, now: number): boolean {
  const t = translationOf(message);
  return t?.role === "outbound" && t.status === "pending" && now - t.at > OUTBOUND_PENDING_TIMEOUT_MS;
}
