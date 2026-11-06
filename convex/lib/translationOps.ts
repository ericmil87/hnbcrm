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
import { ConvexError } from "convex/values";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { getLeadRef } from "./leadRef";
import { maybeNotifyTelegramSendFailed } from "./telegramRelay";
import { languageName as languageNameOf, normalizeLanguageCode, sameLanguage } from "./languages";
import { detectLanguage } from "./languageDetect";
import { resolveTargetLanguage } from "./translationLang";
import {
  conversationHasForeignLanguage,
  MAX_TRANSLATION_CHARS,
  resolveTranslationSettings,
  shouldTranslateDisplay,
  shouldTranslateDraft,
  shouldTranslateInbound,
  shouldTranslateOutbound,
  translationEnabledForOrg,
  translationOf,
  translatableText,
  TranslationMeta,
} from "./translationGate";

/** Tradução de saída `pending` mais velha que isto vira `failed` (watchdog). */
export const OUTBOUND_PENDING_TIMEOUT_MS = 2 * 60 * 1000;
export const OUTBOUND_TIMEOUT_ERROR =
  "A tradução demorou demais e a mensagem não foi enviada. Tente de novo ou envie sem tradução.";

type MessageDoc = Doc<"messages">;

export const LONG_OUTBOUND_ERROR = "Mensagem longa demais para traduzir";

/**
 * Decisão pura do agendamento (inbound/display). Inbound numa conversa SEM
 * idioma estrangeiro (nem candidato) cuja detecção local dá a língua da
 * equipe, ou não detecta (curta), não agenda nada (review #10: zero job e
 * zero escrita por mensagem de conversa em pt-BR).
 */
export function shouldScheduleMessageTranslation(args: {
  org: Doc<"organizations"> | null | undefined;
  conversation: Doc<"conversations"> | null | undefined;
  message: MessageDoc;
  role: "inbound" | "display";
  text?: string;
  hintLang?: string;
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
  if (!decision.ok && decision.reason !== "aguardando_escolha") return false;
  const team = resolveTranslationSettings(args.org).teamLanguage;
  if (conversationHasForeignLanguage(args.conversation, team)) return true;
  const hint = normalizeLanguageCode(args.hintLang);
  if (hint && !sameLanguage(hint, team)) return true;
  const text = args.text ?? translatableText(args.message);
  const detected = text ? detectLanguage(text) : undefined;
  return !!detected && !sameLanguage(detected.lang, team);
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
  // Conversa já carregada pelo receiver: grupo sai sem NENHUMA leitura.
  if (args.conversation?.kind === "group") return false;
  const message = await ctx.db.get(args.messageId);
  if (!message || message.isInternal) return false;
  if (args.role === "inbound" && message.direction !== "inbound") return false;
  if (args.role === "display" && message.senderType !== "ai") return false;
  const conversation = args.conversation ?? (await ctx.db.get(message.conversationId));
  // Grupo e nota interna saem antes de ler a org (nenhuma leitura extra no caminho quente de grupo).
  if (!conversation || conversation.kind === "group" || message.isInternal) return false;
  const org = await ctx.db.get(message.organizationId);
  const hint = normalizeLanguageCode(args.hintLang);
  if (
    !shouldScheduleMessageTranslation({ org, conversation, message, role: args.role, text: args.text, hintLang: hint })
  ) {
    return false;
  }
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
  const decision = shouldTranslateOutbound({ org, conversation, message, targetLang });
  const now = Date.now();
  const sourceLang = resolveTranslationSettings(org).teamLanguage;
  if (!decision.ok && decision.reason === "texto_longo") {
    // Tradução devida, mas o texto passa do teto: RETIDA como `failed`
    // (review #1). A UI oferece "Enviar sem traduzir"; nunca sai em pt-BR sozinha.
    const failed: TranslationMeta = {
      status: "failed",
      role: "outbound",
      sourceLang,
      targetLang: normalizeLanguageCode(targetLang)!,
      reason: "long_text",
      error: LONG_OUTBOUND_ERROR,
      at: now,
    };
    await writeOutboundFailed(ctx, message, failed, LONG_OUTBOUND_ERROR);
    return "held";
  }
  if (!decision.ok) return "dispatch";

  const pending: TranslationMeta = {
    status: "pending",
    role: "outbound",
    sourceLang,
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
    if (!sourceLang || !targetLang) throw new ConvexError("Idioma da tradução não suportado");
    const authored = args.translation.authoredText;
    if (authored.length > 20_000) throw new ConvexError("Texto original longo demais");
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
  if (!code) throw new ConvexError(`Idioma "${args.language}" não suportado`);
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
  const translation: TranslationMeta = { ...current, status: "failed", error: error.slice(0, 300), at: Date.now() };
  await writeOutboundFailed(ctx, message, translation, error);
  return true;
}

/** A escrita de uma saída reprovada (estado + entrega legível + timeline + Telegram). */
async function writeOutboundFailed(
  ctx: MutationCtx,
  message: MessageDoc,
  translation: TranslationMeta,
  error: string
): Promise<void> {
  const now = translation.at;
  const detail = `Tradução falhou: ${error}`.slice(0, 300);
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
}

/** Saída longa demais para a tradução automática (o retry recusa; a UI oferece enviar sem traduzir). */
export function isOutboundTooLong(message: Pick<MessageDoc, "content">): boolean {
  return String(message.content ?? "").trim().length > MAX_TRANSLATION_CHARS;
}

/** Ops de presas: a saída está retida numa tradução `pending` velha? */
export function isStuckOutboundTranslation(message: MessageDoc, now: number): boolean {
  const t = translationOf(message);
  return t?.role === "outbound" && t.status === "pending" && now - t.at > OUTBOUND_PENDING_TIMEOUT_MS;
}

/**
 * Campos de tradução do insert de uma outbound humana (app, REST, MCP,
 * Telegram), já com as guardas do review #9: módulo desligado, conversa de
 * grupo ou nota interna IGNORAM `language`/`translation` (nenhum campo
 * escrito, nenhum erro). `untranslatedTarget` = a conversa tem idioma
 * estrangeiro ativo e o envio pediu `language:"off"`: quem insere grava o
 * audit (`auditUntranslatedSend`, review #4).
 */
export async function translationInsertFieldsFor(
  ctx: { db: QueryCtx["db"] },
  conversation: Doc<"conversations">,
  base: { metadata?: Record<string, unknown> },
  args: {
    language?: string;
    translation?: { authoredText: string; sourceLang: string; targetLang: string; edited?: boolean };
    isInternal?: boolean;
  },
  now: number
): Promise<{ fields: { metadata?: Record<string, unknown>; translatedText?: string }; untranslatedTarget?: string }> {
  if (args.language === undefined && args.translation === undefined) return { fields: base };
  if (args.isInternal || conversation.kind === "group") return { fields: base };
  const org = await ctx.db.get(conversation.organizationId);
  if (!translationEnabledForOrg(org)) return { fields: base };
  const extra = outboundTranslationInsertFields(args, now);
  const fields =
    !extra.metadata && !extra.translatedText
      ? base
      : {
          ...(extra.metadata || base.metadata ? { metadata: { ...(base.metadata ?? {}), ...(extra.metadata ?? {}) } } : {}),
          ...(extra.translatedText !== undefined ? { translatedText: extra.translatedText } : {}),
        };
  let untranslatedTarget: string | undefined;
  if (args.language === "off" && args.translation === undefined && conversation.translation?.mode !== "off") {
    const lang = normalizeLanguageCode(conversation.translation?.lang);
    if (lang && !sameLanguage(lang, resolveTranslationSettings(org).teamLanguage)) untranslatedTarget = lang;
  }
  return { fields, ...(untranslatedTarget ? { untranslatedTarget } : {}) };
}

/** Audit `medium` do envio com `language:"off"` numa conversa em idioma estrangeiro. */
export async function auditUntranslatedSend(
  ctx: MutationCtx,
  args: {
    conversation: Doc<"conversations">;
    messageId: Id<"messages">;
    actor: Doc<"teamMembers">;
    targetLang: string;
    via?: string;
    now: number;
  }
): Promise<void> {
  await ctx.db.insert("auditLogs", {
    organizationId: args.conversation.organizationId,
    entityType: "message",
    entityId: args.messageId,
    action: "update",
    actorId: args.actor._id,
    actorType: args.actor.type === "ai" ? "ai" : "human",
    changes: { after: { translation: "skipped", reason: "language_off" } },
    metadata: {
      conversationId: args.conversation._id,
      sentUntranslated: true,
      targetLang: args.targetLang,
      ...(args.via ? { via: args.via } : {}),
    },
    description: `Mensagem enviada sem tradução (o cliente fala ${languageNameOf(args.targetLang)})`,
    severity: "medium",
    createdAt: args.now,
  });
}
