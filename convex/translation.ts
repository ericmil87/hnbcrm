/**
 * Tradução automática no inbox (F1). Plano: docs/TRADUCAO-AUTOMATICA-PLAN.md.
 *
 * Regra de ouro: `messages.content` é SEMPRE o texto que trafegou no canal.
 * `messages.translatedText` é a versão na língua da equipe (inbound: tradução;
 * outbound: o que o humano digitou; display: a resposta da IA traduzida).
 * Estado e metadados em `messages.metadata.translation` — nunca o texto.
 *
 * Fluxos:
 *  - Inbound: receiver → `scheduleMessageTranslation` (lib/translationOps) →
 *    `autoTranslateInbound` → `internalSetInboundResult` (UMA escrita: texto +
 *    estado + idioma da conversa).
 *  - Outbound: `scheduleOutboundDispatch` desvia (grava `pending`) →
 *    `translateAndDispatch` → `internalApplyOutbound` (troca `content`, reatualiza
 *    a prévia, chama a porta de novo, que agora despacha) ou
 *    `internalMarkTranslationFailed` (nunca envia sozinho, D5).
 *  - Display: commit do atendente → `autoTranslateDisplay`.
 *
 * Nada aqui registra texto de cliente em log: só ids, status e motivo.
 */
import { ConvexError, v } from "convex/values";
import { withMessageSearchPatch } from "./lib/messageSearch";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAccountWithEmail, requireAuth, requirePermission } from "./lib/auth";
import { orgAiActive } from "./lib/agentSecurity";
import { countAlphaChars, detectLanguage, MIN_ALPHA_CHARS } from "./lib/languageDetect";
import { languageHintFromDialCode, languageName, normalizeLanguageCode, sameLanguage } from "./lib/languages";
import {
  effectiveSourceLanguage,
  nextConversationTranslation,
  compactTranslation,
  MIN_DETECTION_CONFIDENCE,
} from "./lib/translationLang";
import {
  conversationHasForeignLanguage,
  resolveTranslationSettings,
  sanitizeGlossary,
  shouldTranslateDisplay,
  shouldTranslateDraft,
  shouldTranslateInbound,
  translatableText,
  translationEnabledForOrg,
  translationOf,
  TranslationEngine,
  TranslationMeta,
  MAX_GLOSSARY_TERMS,
} from "./lib/translationGate";
import { runTranslation, TranslationOutcome } from "./lib/translationCore";
import {
  isStuckOutboundTranslation,
  markOutboundTranslationFailed,
  outboundTargetLanguage,
  scheduleOutboundTranslation,
  OUTBOUND_TIMEOUT_ERROR,
  LONG_OUTBOUND_ERROR,
  isOutboundTooLong,
} from "./lib/translationOps";
import { scheduleOutboundDispatch } from "./lib/outboundDispatch";
import { lastMessagePatchFor } from "./lib/conversationListFields";
import { getLeadRef } from "./lib/leadRef";

const engineValidator = v.union(v.literal("libretranslate"), v.literal("llm"));
const skipReasonValidator = v.union(
  v.literal("low_confidence"),
  v.literal("short"),
  v.literal("same_language"),
  v.literal("ask_mode"),
  v.literal("language_off"),
  v.literal("long_text")
);

type TranslationContext = {
  message: Doc<"messages">;
  org: Doc<"organizations">;
  conversation: Doc<"conversations">;
};

const contextValidator = v.object({
  message: v.any(),
  org: v.any(),
  conversation: v.any(),
});

async function loadContext(
  ctx: { db: any },
  messageId: Id<"messages">
): Promise<TranslationContext | null> {
  const message = (await ctx.db.get(messageId)) as Doc<"messages"> | null;
  if (!message) return null;
  const [org, conversation] = await Promise.all([
    ctx.db.get(message.organizationId) as Promise<Doc<"organizations"> | null>,
    ctx.db.get(message.conversationId) as Promise<Doc<"conversations"> | null>,
  ]);
  if (!org || !conversation || conversation.organizationId !== message.organizationId) return null;
  return { message, org, conversation };
}

// ── Internal: contexto ──────────────────────────────────────────────────────

export const internalGetTranslationContext = internalQuery({
  args: { messageId: v.id("messages") },
  returns: v.union(contextValidator, v.null()),
  handler: async (ctx, args) => await loadContext(ctx, args.messageId),
});

/** Mesmo contexto, autorizado: membro com `inbox:view_own` da org da mensagem. */
export const internalGetTranslationContextForMember = internalQuery({
  args: { messageId: v.id("messages") },
  returns: contextValidator,
  handler: async (ctx, args) => {
    const loaded = await loadContext(ctx, args.messageId);
    if (!loaded) throw new ConvexError("Mensagem não encontrada");
    await requirePermission(ctx, loaded.message.organizationId, "inbox", "view_own");
    return loaded;
  },
});

// ── Inbound ─────────────────────────────────────────────────────────────────

const resultArgs = {
  messageId: v.id("messages"),
  role: v.union(v.literal("inbound"), v.literal("display")),
  status: v.union(v.literal("done"), v.literal("skipped"), v.literal("failed")),
  translatedText: v.optional(v.string()),
  sourceLang: v.optional(v.string()),
  targetLang: v.optional(v.string()),
  confidence: v.optional(v.number()),
  engine: v.optional(engineValidator),
  model: v.optional(v.string()),
  upstream: v.optional(v.string()),
  error: v.optional(v.string()),
  /** F3: motivo do `skipped` e idioma provável (só códigos). */
  reason: v.optional(skipReasonValidator),
  candidateLang: v.optional(v.string()),
  /** Detecção desta mensagem (atualiza o idioma da conversa, só inbound). */
  detectedLang: v.optional(v.string()),
  detectedConfidence: v.optional(v.number()),
  /** Tradução manual ("Traduzir"/"Tentar de novo"): sobrescreve o estado anterior. */
  force: v.optional(v.boolean()),
};

/** UMA escrita: estado + texto na mensagem e, se mudou, o idioma da conversa. */
export const internalSetInboundResult = internalMutation({
  args: resultArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    // Apagada pelo cliente: resultado tardio é descartado (molde transcrição/visão).
    if (!message || message.metadata?.deletedByCustomer === true) return null;
    const existing = translationOf(message);
    if (existing && existing.status !== "pending" && !args.force) return null;
    const now = Date.now();
    const translation: TranslationMeta = {
      status: args.status,
      role: args.role,
      ...(args.sourceLang ? { sourceLang: args.sourceLang } : {}),
      ...(args.targetLang ? { targetLang: args.targetLang } : {}),
      ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
      ...(args.engine ? { engine: args.engine } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.upstream ? { upstream: args.upstream } : {}),
      ...(args.error ? { error: args.error.slice(0, 300) } : {}),
      ...(args.status === "skipped" && args.reason ? { reason: args.reason } : {}),
      ...(args.status === "skipped" && args.candidateLang ? { candidateLang: args.candidateLang } : {}),
      at: now,
    };
    await ctx.db.patch(args.messageId, {
      metadata: { ...(message.metadata ?? {}), translation },
      ...(args.status === "done" && args.translatedText ? { translatedText: args.translatedText } : {}),
    });

    if (args.role !== "inbound" || !args.detectedLang) return null;
    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation || conversation.kind === "group") return null;
    // Evidência para fixar o 1º idioma (review #11): só lida quando a conversa
    // ainda não tem idioma (o contato vem junto, e serve à troca abaixo).
    const needsEvidence = !conversation.translation?.lang;
    let contactLoaded = false;
    let contact: Doc<"contacts"> | null = null;
    const loadContact = async () => {
      if (contactLoaded) return contact;
      contactLoaded = true;
      const lead = await getLeadRef(ctx.db, conversation.leadId);
      const found = lead?.contactId ? await ctx.db.get(lead.contactId) : null;
      contact = found && found.organizationId === conversation.organizationId ? found : null;
      return contact;
    };
    const evidenceContact = needsEvidence ? await loadContact() : null;
    const detectedText =
      message.contentType === "audio" ? (message.transcriptText ?? "") : String(message.content ?? "");
    const next = nextConversationTranslation(
      conversation.translation,
      { lang: args.detectedLang, confidence: args.detectedConfidence ?? 0 },
      now,
      needsEvidence
        ? {
            alphaChars: countAlphaChars(detectedText),
            contactPreferredLanguage: evidenceContact?.preferredLanguage,
            dialHint: languageHintFromDialCode(evidenceContact?.phone),
          }
        : {}
    );
    if (!next) return null;
    await ctx.db.patch(conversation._id, { translation: next });

    // Idioma novo da conversa vira o preferido do contato, salvo escolha manual.
    if (next.lang && next.lang !== conversation.translation?.lang) {
      const contact = await loadContact();
      if (
        contact &&
        contact.organizationId === conversation.organizationId &&
        contact.languageSource !== "manual" &&
        contact.preferredLanguage !== next.lang
      ) {
        await ctx.db.patch(contact._id, { preferredLanguage: next.lang, languageSource: "auto" });
      }
    }
    return null;
  },
});

type InboundRunResult = {
  status: "done" | "skipped" | "failed" | "pending";
  translatedText?: string;
  sourceLang?: string;
  targetLang?: string;
  error?: string;
};

async function translateForTeam(
  ctx: ActionCtx,
  loaded: TranslationContext,
  opts: { role: "inbound" | "display"; hintLang?: string; fromTranscript?: boolean; force?: boolean }
): Promise<InboundRunResult> {
  const { message, org, conversation } = loaded;
  const text = opts.fromTranscript
    ? message.transcriptText?.trim() || undefined
    : message.contentType === "audio"
      ? message.transcriptText?.trim() || undefined
      : translatableText(message);
  const settings = resolveTranslationSettings(org);
  const team = settings.teamLanguage;
  // Review #10: conversa sem idioma estrangeiro (nem candidato) não ganha
  // `skipped` gravado para mesma língua/curta — só a conversa ATIVA mostra isso.
  const activeConversation = conversationHasForeignLanguage(conversation, team);

  let waitingChoice = false;
  if (opts.role === "inbound") {
    const gate = shouldTranslateInbound({ org, conversation, message, text, force: opts.force });
    if (!gate.ok) {
      if (gate.reason !== "aguardando_escolha") return { status: "skipped", error: gate.reason };
      waitingChoice = true;
    }
  } else {
    const gate = shouldTranslateDisplay({ org, conversation, message });
    if (!gate.ok && !(opts.force && gate.reason === "ja_traduzida")) return { status: "skipped", error: gate.reason };
  }
  if (!text) return { status: "skipped", error: "sem_texto" };

  const ownDetection = detectLanguage(text);
  const hint = normalizeLanguageCode(opts.hintLang);
  const detected = ownDetection ?? (hint ? { lang: hint, confidence: 0.85 } : undefined);
  const sourceLang = effectiveSourceLanguage({
    detected,
    conversationLang: opts.role === "inbound" ? conversation.translation?.lang : undefined,
    hint,
  });
  const base = {
    messageId: message._id,
    role: opts.role,
    ...(opts.force ? { force: true } : {}),
    ...(opts.role === "inbound" && detected ? { detectedLang: detected.lang, detectedConfidence: detected.confidence } : {}),
  };

  const writeSkipped = async (
    lang: string | undefined,
    reason: "low_confidence" | "short" | "same_language" | "ask_mode"
  ): Promise<InboundRunResult> => {
    if (
      opts.role === "inbound" &&
      !opts.force &&
      !activeConversation &&
      (reason === "short" || reason === "same_language")
    ) {
      return { status: "skipped", sourceLang: lang, targetLang: team };
    }
    // Idioma provável para o "Idioma incerto · Traduzir como …?" da bolha.
    const candidate =
      reason === "low_confidence" && detected
        ? normalizeLanguageCode(detected.lang)
        : reason === "short"
          ? normalizeLanguageCode(conversation.translation?.candidateLang)
          : undefined;
    await ctx.runMutation(internal.translation.internalSetInboundResult, {
      ...base,
      status: "skipped",
      ...(lang ? { sourceLang: lang } : {}),
      targetLang: team,
      reason,
      ...(candidate && !sameLanguage(candidate, team) ? { candidateLang: candidate } : {}),
      ...(detected ? { confidence: detected.confidence } : {}),
    });
    return { status: "skipped", sourceLang: lang, targetLang: team };
  };

  if (waitingChoice) return await writeSkipped(sourceLang, "ask_mode");
  // "Traduzir mesmo assim" (`force`, review #15) não pula pela mesma língua:
  // o provedor recebe `source:"auto"` e decide.
  const forceAcrossSameLanguage = !!opts.force && !!sourceLang && sameLanguage(sourceLang, team);
  if (sourceLang && sameLanguage(sourceLang, team) && !opts.force) {
    // Detecção fraca apontando OUTRO idioma, vencida pelo idioma da conversa: incerto.
    const uncertain =
      !!detected && detected.confidence < MIN_DETECTION_CONFIDENCE && !sameLanguage(detected.lang, team);
    return await writeSkipped(sourceLang, uncertain ? "low_confidence" : "same_language");
  }
  // Curta e sem idioma conhecido na conversa: herda o "nada a traduzir" (zero LLM).
  if (!sourceLang && !detected && !opts.force) return await writeSkipped(undefined, "short");

  const outcome: TranslationOutcome = await runTranslation(ctx, {
    org,
    conversationId: conversation._id,
    messageId: message._id,
    text,
    from: forceAcrossSameLanguage ? undefined : sourceLang,
    to: team,
    role: opts.role,
  });
  if (outcome.status === "same_language") {
    await ctx.runMutation(internal.translation.internalSetInboundResult, {
      ...base,
      ...(opts.role === "inbound" ? { detectedLang: outcome.sourceLang, detectedConfidence: 0.9 } : {}),
      status: "skipped",
      sourceLang: outcome.sourceLang,
      targetLang: team,
      engine: outcome.engine,
      reason: "same_language",
    });
    return { status: "skipped", sourceLang: outcome.sourceLang, targetLang: team };
  }
  if (outcome.status === "failed") {
    await ctx.runMutation(internal.translation.internalSetInboundResult, {
      ...base,
      status: "failed",
      ...(sourceLang ? { sourceLang } : {}),
      targetLang: team,
      error: outcome.error,
    });
    return { status: "failed", error: outcome.error, sourceLang, targetLang: team };
  }
  // Sem detecção própria confiável, o idioma devolvido pelo provedor conta para a conversa.
  const providerDetected =
    opts.role === "inbound" && (!ownDetection || ownDetection.confidence < 0.6) && outcome.sourceLang
      ? { detectedLang: outcome.sourceLang, detectedConfidence: outcome.confidence ?? 0.9 }
      : {};
  await ctx.runMutation(internal.translation.internalSetInboundResult, {
    ...base,
    ...providerDetected,
    status: "done",
    translatedText: outcome.text,
    ...(outcome.sourceLang ? { sourceLang: outcome.sourceLang } : {}),
    targetLang: team,
    ...(outcome.confidence !== undefined
      ? { confidence: outcome.confidence }
      : detected
        ? { confidence: detected.confidence }
        : {}),
    engine: outcome.engine,
    ...(outcome.model ? { model: outcome.model } : {}),
    ...(outcome.upstream ? { upstream: outcome.upstream } : {}),
  });
  return { status: "done", translatedText: outcome.text, sourceLang: outcome.sourceLang, targetLang: team };
}

export const autoTranslateInbound = internalAction({
  args: {
    messageId: v.id("messages"),
    hintLang: v.optional(v.string()),
    fromTranscript: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const loaded: TranslationContext | null = await ctx.runQuery(internal.translation.internalGetTranslationContext, {
      messageId: args.messageId,
    });
    if (!loaded) return null;
    await translateForTeam(ctx, loaded, {
      role: "inbound",
      hintLang: args.hintLang,
      fromTranscript: args.fromTranscript,
    });
    return null;
  },
});

/** Resposta da IA (no idioma do lead) traduzida para a equipe ler (D6). */
export const autoTranslateDisplay = internalAction({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const loaded: TranslationContext | null = await ctx.runQuery(internal.translation.internalGetTranslationContext, {
      messageId: args.messageId,
    });
    if (!loaded) return null;
    await translateForTeam(ctx, loaded, { role: "display" });
    return null;
  },
});

// ── Rascunho da IA (F3) ─────────────────────────────────────────────────────

/**
 * Rascunho do modo sugerir no idioma do lead: versão pt-BR para a equipe ler
 * antes de aprovar, em `metadata.aiDraft.translatedText` (o rascunho é nota
 * interna; o `content` segue sendo o que sairá). Falha = nada gravado: o card
 * só não oferece "Ver em pt-BR".
 */
export const autoTranslateDraft = internalAction({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const loaded: TranslationContext | null = await ctx.runQuery(internal.translation.internalGetTranslationContext, {
      messageId: args.messageId,
    });
    if (!loaded) return null;
    const { message, org, conversation } = loaded;
    if (!shouldTranslateDraft({ org, conversation, message }).ok) return null;
    const text = message.content.trim();
    const team = resolveTranslationSettings(org).teamLanguage;
    const own = detectLanguage(text);
    // A IA respondeu no idioma da equipe (perfil fixo em pt-BR): nada a fazer.
    if (own && own.confidence >= MIN_DETECTION_CONFIDENCE && sameLanguage(own.lang, team)) return null;
    const from =
      own && own.confidence >= MIN_DETECTION_CONFIDENCE ? own.lang : (conversation.translation?.lang ?? undefined);
    const outcome = await runTranslation(ctx, {
      org,
      conversationId: conversation._id,
      messageId: message._id,
      text,
      from,
      to: team,
      role: "display",
    });
    if (outcome.status !== "done") return null;
    await ctx.runMutation(internal.translation.internalSetDraftTranslation, {
      messageId: message._id,
      translatedText: outcome.text,
      ...(outcome.sourceLang ? { sourceLang: outcome.sourceLang } : from ? { sourceLang: from } : {}),
      targetLang: team,
      expectedContent: message.content,
    });
    return null;
  },
});

/** UMA escrita: só em rascunho ainda pendente e com o mesmo texto. */
export const internalSetDraftTranslation = internalMutation({
  args: {
    messageId: v.id("messages"),
    translatedText: v.string(),
    sourceLang: v.optional(v.string()),
    targetLang: v.string(),
    expectedContent: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    const draft = message?.metadata?.aiDraft as Record<string, unknown> | undefined;
    if (!message || !draft || draft.status !== "pending" || message.content !== args.expectedContent) return false;
    await ctx.db.patch(message._id, {
      metadata: {
        ...(message.metadata ?? {}),
        aiDraft: {
          ...draft,
          translatedText: args.translatedText,
          ...(args.sourceLang ? { translatedFrom: args.sourceLang } : {}),
          translatedTo: args.targetLang,
        },
      },
    });
    return true;
  },
});

// ── Outbound ────────────────────────────────────────────────────────────────

export const translateAndDispatch = internalAction({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const loaded: TranslationContext | null = await ctx.runQuery(internal.translation.internalGetTranslationContext, {
      messageId: args.messageId,
    });
    if (!loaded) return null;
    const t = translationOf(loaded.message);
    if (!t || t.role !== "outbound" || t.status !== "pending" || !t.targetLang) return null;
    if (isOutboundTooLong(loaded.message)) {
      await ctx.runMutation(internal.translation.internalMarkTranslationFailed, {
        messageId: args.messageId,
        error: LONG_OUTBOUND_ERROR,
        expectedAt: t.at,
      });
      return null;
    }
    const outcome = await runTranslation(ctx, {
      org: loaded.org,
      conversationId: loaded.conversation._id,
      messageId: loaded.message._id,
      text: loaded.message.content,
      from: t.sourceLang,
      to: t.targetLang,
      role: "outbound",
      ...(loaded.message.senderId ? { memberId: loaded.message.senderId } : {}),
    });
    if (outcome.status === "failed") {
      await ctx.runMutation(internal.translation.internalMarkTranslationFailed, {
        messageId: args.messageId,
        error: outcome.error,
        expectedAt: t.at,
      });
      return null;
    }
    await ctx.runMutation(internal.translation.internalApplyOutbound, {
      messageId: args.messageId,
      expectedAt: t.at,
      ...(outcome.status === "done"
        ? {
            translatedText: outcome.text,
            engine: outcome.engine,
            ...(outcome.model ? { model: outcome.model } : {}),
            ...(outcome.upstream ? { upstream: outcome.upstream } : {}),
          }
        : { sameLanguage: true, engine: outcome.engine }),
    });
    return null;
  },
});

/**
 * ÚNICA mutation que troca o `content` de uma outbound traduzida: `content` ←
 * tradução, `translatedText` ← o que o humano digitou, `done`, prévia da lista
 * reatualizada, e a porta é chamada de novo (agora despacha). Idempotente por
 * claim: só age sobre `pending` com o mesmo `at` da tentativa.
 */
export const internalApplyOutbound = internalMutation({
  args: {
    messageId: v.id("messages"),
    expectedAt: v.number(),
    translatedText: v.optional(v.string()),
    sameLanguage: v.optional(v.boolean()),
    engine: v.optional(engineValidator),
    model: v.optional(v.string()),
    upstream: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.externalId) return false;
    const t = translationOf(message);
    if (!t || t.role !== "outbound" || t.status !== "pending" || t.at !== args.expectedAt) return false;
    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation) return false;
    const now = Date.now();
    const translation: TranslationMeta = {
      ...t,
      status: args.sameLanguage ? "skipped" : "done",
      ...(args.sameLanguage ? { reason: "same_language" as const } : {}),
      ...(args.engine ? { engine: args.engine } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.upstream ? { upstream: args.upstream } : {}),
      at: now,
    };
    const translated = !args.sameLanguage && args.translatedText ? args.translatedText : undefined;
    await ctx.db.patch(
      args.messageId,
      withMessageSearchPatch(message, {
        ...(translated ? { content: translated, translatedText: message.content } : {}),
        metadata: { ...(message.metadata ?? {}), translation },
      })
    );
    if (translated) {
      const updated = { ...message, content: translated };
      const preview = lastMessagePatchFor(conversation, message._id, updated);
      if (preview && (conversation.lastMessageId === undefined || conversation.lastMessageId === message._id)) {
        await ctx.db.patch(conversation._id, preview);
      }
    }
    await scheduleOutboundDispatch(ctx, conversation, message._id);
    return true;
  },
});

export const internalMarkTranslationFailed = internalMutation({
  args: { messageId: v.id("messages"), error: v.string(), expectedAt: v.optional(v.number()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return false;
    const t = translationOf(message);
    if (args.expectedAt !== undefined && t?.at !== args.expectedAt) return false;
    return await markOutboundTranslationFailed(ctx, message, args.error);
  },
});

/** Watchdog por mensagem: `pending` que passou do prazo vira `failed` legível. */
export const internalExpirePendingOutbound = internalMutation({
  args: { messageId: v.id("messages") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || !isStuckOutboundTranslation(message, Date.now())) return false;
    return await markOutboundTranslationFailed(ctx, message, OUTBOUND_TIMEOUT_ERROR);
  },
});

// ── Públicas ────────────────────────────────────────────────────────────────

const translateMessageResult = v.object({
  status: v.union(v.literal("done"), v.literal("skipped"), v.literal("failed"), v.literal("pending")),
  translatedText: v.optional(v.string()),
  sourceLang: v.optional(v.string()),
  targetLang: v.optional(v.string()),
  error: v.optional(v.string()),
});

/** "Traduzir" / "Tentar de novo" na bolha recebida (ou na resposta da IA). */
export const translateMessage = action({
  args: { messageId: v.id("messages") },
  returns: translateMessageResult,
  handler: async (ctx, args): Promise<InboundRunResult> => {
    const loaded: TranslationContext = await ctx.runQuery(
      internal.translation.internalGetTranslationContextForMember,
      { messageId: args.messageId }
    );
    if (!translationEnabledForOrg(loaded.org)) {
      throw new ConvexError("A tradução automática está desligada nesta organização");
    }
    const m = loaded.message;
    const role =
      m.direction === "inbound" && m.senderType === "contact"
        ? ("inbound" as const)
        : m.direction === "outbound" && m.senderType === "ai"
          ? ("display" as const)
          : null;
    if (!role) throw new ConvexError("Só mensagens do cliente ou respostas da IA podem ser traduzidas aqui");
    const result = await translateForTeam(ctx, loaded, { role, force: true });
    if (result.status === "skipped" && result.error && !result.sourceLang) {
      return { status: "skipped", error: legibleSkipReason(result.error) };
    }
    return result;
  },
});

function legibleSkipReason(reason: string): string {
  switch (reason) {
    case "grupo":
      return "Conversas de grupo não são traduzidas";
    case "nota_interna":
      return "Notas internas não são traduzidas";
    case "conversa_sem_traducao":
      return "A tradução está desligada nesta conversa";
    case "sem_texto":
      return "Mensagem sem texto para traduzir";
    case "texto_longo":
      return "Mensagem longa demais para traduzir";
    case "apagada":
      return "Mensagem apagada pelo cliente";
    default:
      return "Mensagem não traduzível";
  }
}

async function loadOutboundForMember(
  ctx: { db: any; auth: any },
  messageId: Id<"messages">
): Promise<{ message: Doc<"messages">; conversation: Doc<"conversations">; member: Doc<"teamMembers"> }> {
  const message = (await ctx.db.get(messageId)) as Doc<"messages"> | null;
  if (!message) throw new ConvexError("Mensagem não encontrada");
  // Reenviar/enviar sem traduzir é RESPONDER ao cliente (review #7).
  const member = await requirePermission(ctx as any, message.organizationId, "inbox", "reply");
  const conversation = (await ctx.db.get(message.conversationId)) as Doc<"conversations"> | null;
  if (!conversation || conversation.organizationId !== message.organizationId) {
    throw new ConvexError("Conversa não encontrada");
  }
  if (message.direction !== "outbound") throw new ConvexError("Só mensagens enviadas podem ser reenviadas");
  if (message.externalId) throw new ConvexError("Esta mensagem já foi enviada");
  return { message, conversation, member };
}

function metadataWithoutDeliveryError(metadata: Record<string, any> | undefined): Record<string, any> {
  const { deliveryError: _e, deliveryErrorCode: _c, ...rest } = metadata ?? {};
  return rest;
}

/** "Tentar de novo" numa saída cuja tradução falhou. */
export const retryOutbound = mutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { message } = await loadOutboundForMember(ctx, args.messageId);
    const t = translationOf(message);
    if (!t || t.role !== "outbound" || t.status !== "failed") {
      throw new ConvexError("Só dá para tentar de novo uma tradução que falhou");
    }
    if (isOutboundTooLong(message)) {
      throw new ConvexError(`${LONG_OUTBOUND_ERROR}. Divida em mensagens menores ou envie sem traduzir.`);
    }
    const pending: TranslationMeta = {
      status: "pending",
      role: "outbound",
      ...(t.sourceLang ? { sourceLang: t.sourceLang } : {}),
      ...(t.targetLang ? { targetLang: t.targetLang } : {}),
      at: Date.now(),
    };
    await ctx.db.patch(message._id, {
      deliveryStatus: undefined,
      metadata: { ...metadataWithoutDeliveryError(message.metadata), translation: pending },
    });
    await scheduleOutboundTranslation(ctx, message._id);
    return null;
  },
});

/** "Enviar em português assim mesmo": despacha o `content` original, auditado (avisar, não travar). */
export const sendUntranslated = mutation({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { message, conversation, member } = await loadOutboundForMember(ctx, args.messageId);
    const t = translationOf(message);
    if (!t || t.role !== "outbound" || (t.status !== "failed" && t.status !== "pending")) {
      throw new ConvexError("Esta mensagem não está aguardando tradução");
    }
    const now = Date.now();
    const translation: TranslationMeta = {
      status: "skipped",
      role: "outbound",
      ...(t.sourceLang ? { sourceLang: t.sourceLang } : {}),
      ...(t.targetLang ? { targetLang: t.targetLang } : {}),
      ...(t.error ? { error: t.error } : {}),
      at: now,
    };
    await ctx.db.patch(message._id, {
      deliveryStatus: undefined,
      metadata: { ...metadataWithoutDeliveryError(message.metadata), translation },
    });
    await ctx.db.insert("auditLogs", {
      organizationId: message.organizationId,
      entityType: "message",
      entityId: message._id,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: { before: { translation: t.status }, after: { translation: "skipped" } },
      metadata: {
        conversationId: conversation._id,
        sentUntranslated: true,
        ...(t.targetLang ? { targetLang: t.targetLang } : {}),
      },
      description: `Mensagem enviada sem tradução${t.targetLang ? ` (o cliente fala ${languageName(t.targetLang)})` : ""}`,
      severity: "medium",
      createdAt: now,
    });
    // Timeline do lead (review #13): a escolha fica visível para o time.
    const lead = await getLeadRef(ctx.db, conversation.leadId);
    if (lead && lead.organizationId === conversation.organizationId) {
      await ctx.db.insert("activities", {
        organizationId: conversation.organizationId,
        leadId: lead._id,
        type: "note",
        actorId: member._id,
        actorType: member.type === "ai" ? "ai" : "human",
        content: `Mensagem enviada sem tradução por ${member.name}`,
        metadata: { conversationId: conversation._id, messageId: message._id, sentUntranslated: true },
        createdAt: now,
      });
    }
    await scheduleOutboundDispatch(ctx, conversation, message._id);
    return null;
  },
});

export const setConversationLanguage = mutation({
  args: {
    conversationId: v.id("conversations"),
    lang: v.optional(v.string()),
    mode: v.union(v.literal("auto"), v.literal("manual"), v.literal("off")),
    applyToContact: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new ConvexError("Conversa não encontrada");
    const member = await requirePermission(ctx, conversation.organizationId, "inbox", "reply");
    if (conversation.kind === "group") throw new ConvexError("Conversas de grupo não são traduzidas");
    const lang = args.lang !== undefined ? normalizeLanguageCode(args.lang) : undefined;
    if (args.lang !== undefined && !lang) throw new ConvexError(`Idioma "${args.lang}" não suportado`);
    if (args.mode === "manual" && !lang) throw new ConvexError("Escolha o idioma da conversa");

    const before = conversation.translation ?? {};
    const now = Date.now();
    const keepLang = lang ?? (before.source !== "manual" ? before.lang : undefined);
    const next =
      args.mode === "manual"
        ? { lang, source: "manual" as const, mode: "manual" as const, detectedAt: now, divergentStreak: 0 }
        : args.mode === "off"
          ? { ...before, mode: "off" as const, divergentStreak: 0, candidateLang: undefined }
          : {
              ...(keepLang ? { lang: keepLang } : {}),
              source: "auto" as const,
              mode: "auto" as const,
              detectedAt: now,
              divergentStreak: 0,
            };
    await ctx.db.patch(conversation._id, { translation: compactTranslation(next) });

    if (args.applyToContact && lang) {
      const lead = await getLeadRef(ctx.db, conversation.leadId);
      const contact = lead?.contactId ? await ctx.db.get(lead.contactId) : null;
      if (contact && contact.organizationId === conversation.organizationId) {
        await ctx.db.patch(contact._id, { preferredLanguage: lang, languageSource: "manual", updatedAt: now });
        // A mudança no CONTATO tem audit próprio (review #13).
        await ctx.db.insert("auditLogs", {
          organizationId: conversation.organizationId,
          entityType: "contact",
          entityId: contact._id,
          action: "update",
          actorId: member._id,
          actorType: member.type === "ai" ? "ai" : "human",
          changes: {
            before: { preferredLanguage: contact.preferredLanguage ?? null, languageSource: contact.languageSource ?? null },
            after: { preferredLanguage: lang, languageSource: "manual" },
          },
          metadata: { translation: true, conversationId: conversation._id },
          description: `Definiu o idioma preferido do contato: ${languageName(lang)}`,
          severity: "low",
          createdAt: now,
        });
      }
    }
    await ctx.db.insert("auditLogs", {
      organizationId: conversation.organizationId,
      entityType: "conversation",
      entityId: conversation._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      changes: {
        before: { lang: before.lang ?? null, mode: before.mode ?? null },
        after: { lang: next.lang ?? null, mode: next.mode },
      },
      metadata: { translation: true, ...(args.applyToContact ? { applyToContact: true } : {}) },
      description:
        args.mode === "off"
          ? "Desligou a tradução nesta conversa"
          : `Definiu o idioma da conversa: ${next.lang ? languageName(next.lang) : "automático"}`,
      severity: "low",
      createdAt: now,
    });
    return null;
  },
});

// ── Prévia (F3 usa; nasce na F1) ────────────────────────────────────────────

export const internalGetPreviewContext = internalQuery({
  args: { conversationId: v.id("conversations") },
  returns: v.object({ org: v.any(), conversation: v.any(), targetLang: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new ConvexError("Conversa não encontrada");
    await requirePermission(ctx, conversation.organizationId, "inbox", "view_own");
    const org = await ctx.db.get(conversation.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const fake = {
      direction: "outbound",
      senderType: "human",
      isInternal: false,
      contentType: "text",
      content: "",
      metadata: undefined,
    } as unknown as Doc<"messages">;
    const targetLang = (await outboundTargetLanguage(ctx, conversation, fake)) ?? null;
    return { org, conversation, targetLang };
  },
});

const previewResult = v.object({
  text: v.string(),
  sourceLang: v.string(),
  targetLang: v.union(v.string(), v.null()),
  engine: v.union(engineValidator, v.null()),
  skipped: v.boolean(),
  reason: v.optional(v.string()),
});

const PREVIEW_MAX_CHARS = 4000;
/** Confiança mínima da detecção local para a prévia dizer "já está no idioma do lead". */
const PREVIEW_SAME_LANGUAGE_CONFIDENCE = 0.85;

export const preview = action({
  args: { conversationId: v.id("conversations"), text: v.string() },
  returns: previewResult,
  handler: async (ctx, args) => {
    const { org, conversation, targetLang } = (await ctx.runQuery(internal.translation.internalGetPreviewContext, {
      conversationId: args.conversationId,
    })) as { org: Doc<"organizations">; conversation: Doc<"conversations">; targetLang: string | null };
    const team = resolveTranslationSettings(org).teamLanguage;
    const text = args.text;
    const skip = (reason: string) => ({
      text,
      sourceLang: team,
      targetLang,
      engine: null,
      skipped: true,
      reason,
    });
    // Códigos (review #2): o composer só manda `language:"off"` com
    // `same_language`; qualquer outro envia sem args e o desvio do servidor decide.
    if (!translationEnabledForOrg(org)) return skip("module_off");
    if (conversation.kind === "group") return skip("group");
    if (conversation.translation?.mode === "off") return skip("language_off");
    if (!text.trim()) return skip("no_text");
    if (text.length > PREVIEW_MAX_CHARS) return skip("long_text");
    if (!targetLang) return skip("no_language");
    if (sameLanguage(targetLang, team)) return skip("no_language");
    // "Já está no idioma do lead" só com detecção forte em texto suficiente:
    // um pt-BR mal detectado como es não pode sair sem tradução.
    const own = detectLanguage(text);
    if (
      own &&
      own.confidence >= PREVIEW_SAME_LANGUAGE_CONFIDENCE &&
      countAlphaChars(text) >= MIN_ALPHA_CHARS &&
      sameLanguage(own.lang, targetLang)
    ) {
      return skip("same_language");
    }
    const outcome = await runTranslation(ctx, {
      org,
      conversationId: conversation._id,
      text,
      from: team,
      to: targetLang,
      role: "outbound",
    });
    if (outcome.status === "failed") throw new ConvexError(outcome.error);
    if (outcome.status === "same_language") return skip("same_language");
    return { text: outcome.text, sourceLang: team, targetLang, engine: outcome.engine, skipped: false };
  },
});

// ── Configurações ───────────────────────────────────────────────────────────

const settingsValidator = v.object({
  provider: v.union(v.literal("auto"), v.literal("libretranslate"), v.literal("llm")),
  teamLanguage: v.string(),
  inboundMode: v.union(v.literal("auto"), v.literal("ask")),
  outboundMode: v.union(v.literal("direct"), v.literal("quick_review"), v.literal("strict_review")),
  skipWhenSameLanguage: v.boolean(),
  tone: v.union(v.literal("neutral"), v.literal("formal"), v.literal("informal")),
  glossary: v.array(v.string()),
});

export const getSettings = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    moduleEnabled: v.boolean(),
    settings: settingsValidator,
    providers: v.object({ libretranslate: v.boolean(), llm: v.boolean() }),
  }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    return {
      moduleEnabled: translationEnabledForOrg(org),
      settings: resolveTranslationSettings(org),
      providers: {
        libretranslate: Boolean(process.env.LIBRETRANSLATE_URL?.trim()),
        llm: orgAiActive(org),
      },
    };
  },
});

/**
 * O mínimo que o INBOX precisa (qualquer membro da org, sem `settings:view`):
 * módulo ligado, idioma da equipe e os modos. Sem provedores nem glossário.
 */
export const getInboxSettings = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    moduleEnabled: v.boolean(),
    teamLanguage: v.string(),
    inboundMode: v.union(v.literal("auto"), v.literal("ask")),
    outboundMode: v.union(v.literal("direct"), v.literal("quick_review"), v.literal("strict_review")),
  }),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    const org = await ctx.db.get(args.organizationId);
    const settings = resolveTranslationSettings(org);
    return {
      moduleEnabled: translationEnabledForOrg(org),
      teamLanguage: settings.teamLanguage,
      inboundMode: settings.inboundMode,
      outboundMode: settings.outboundMode,
    };
  },
});

export const updateSettings = mutation({
  args: {
    organizationId: v.id("organizations"),
    patch: v.object({
      provider: v.optional(v.union(v.literal("auto"), v.literal("libretranslate"), v.literal("llm"))),
      teamLanguage: v.optional(v.string()),
      inboundMode: v.optional(v.union(v.literal("auto"), v.literal("ask"))),
      outboundMode: v.optional(
        v.union(v.literal("direct"), v.literal("quick_review"), v.literal("strict_review"))
      ),
      skipWhenSameLanguage: v.optional(v.boolean()),
      tone: v.optional(v.union(v.literal("neutral"), v.literal("formal"), v.literal("informal"))),
      glossary: v.optional(v.array(v.string())),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx, member.userId);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError("Organização não encontrada");
    const patch = { ...args.patch };
    if (patch.teamLanguage !== undefined) {
      const code = normalizeLanguageCode(patch.teamLanguage);
      if (!code) throw new ConvexError(`Idioma "${patch.teamLanguage}" não suportado`);
      patch.teamLanguage = code;
    }
    if (patch.glossary !== undefined) {
      if (patch.glossary.length > MAX_GLOSSARY_TERMS * 2) {
        throw new ConvexError(`O glossário aceita até ${MAX_GLOSSARY_TERMS} termos`);
      }
      patch.glossary = sanitizeGlossary(patch.glossary);
    }
    const current = org.settings.translation ?? {};
    const next = Object.fromEntries(
      Object.entries({ ...current, ...patch }).filter(([, value]) => value !== undefined)
    ) as typeof current;
    const now = Date.now();
    await ctx.db.patch(args.organizationId, {
      settings: { ...org.settings, translation: next },
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { ...current, glossary: current.glossary?.length ?? 0 },
        after: { ...next, glossary: next.glossary?.length ?? 0 },
      },
      metadata: { translationSettings: true, fields: Object.keys(args.patch) },
      description: "Alterou as configurações da tradução automática",
      severity: "medium",
      createdAt: now,
    });
    return null;
  },
});

export const internalRequireSettingsManage = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await ctx.db.get(args.organizationId);
  },
});

// Horário e valor de propósito: o servidor próprio devolve "10:00" e
// "R$ 1,500.00", e o "Testar conexão" precisa exercitar o guard de números.
const PING_TEXT = "Bom dia, tudo bem? Podemos conversar amanhã às 10h. O valor é R$ 1.500,00.";

export const pingProviders = action({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({ engine: engineValidator, ok: v.boolean(), latencyMs: v.number(), error: v.optional(v.string()) })
  ),
  handler: async (ctx, args) => {
    const org = (await ctx.runQuery(internal.translation.internalRequireSettingsManage, {
      organizationId: args.organizationId,
    })) as Doc<"organizations"> | null;
    if (!org) throw new ConvexError("Organização não encontrada");
    const out: { engine: TranslationEngine; ok: boolean; latencyMs: number; error?: string }[] = [];
    const engines: TranslationEngine[] = [];
    if (process.env.LIBRETRANSLATE_URL?.trim()) engines.push("libretranslate");
    if (orgAiActive(org)) engines.push("llm");
    // O teste ignora a preferência de provedor da org: mede os dois que existem.
    const probeOrg = {
      ...org,
      settings: { ...org.settings, translation: { ...(org.settings.translation ?? {}), provider: "auto" as const } },
    };
    for (const engine of engines) {
      const started = Date.now();
      const outcome = await runTranslation(ctx, {
        org: probeOrg,
        text: PING_TEXT,
        from: "pt-BR",
        to: "en",
        role: "outbound",
        engines: [engine],
      });
      out.push({
        engine,
        ok: outcome.status === "done",
        latencyMs: Date.now() - started,
        ...(outcome.status === "failed" ? { error: outcome.error } : {}),
      });
    }
    if (engines.length === 0) {
      return [
        {
          engine: "libretranslate" as const,
          ok: false,
          latencyMs: 0,
          error: "LibreTranslate não configurado (LIBRETRANSLATE_URL) e IA desligada",
        },
      ];
    }
    return out;
  },
});

/**
 * Sonda de ops (sem escrita, sem PII): confirma que o detector de idioma
 * (`tinyld/light`) carrega e responde no runtime V8 do deployment.
 * Uso: `npx convex run translation:internalDetectProbe '{"text":"hola, tienen disponibilidad?"}'`
 */
export const internalDetectProbe = internalAction({
  args: { text: v.string() },
  returns: v.object({
    lang: v.optional(v.string()),
    confidence: v.optional(v.number()),
    alphaChars: v.number(),
    minAlphaChars: v.number(),
  }),
  handler: async (_ctx, args) => {
    const detected = detectLanguage(args.text);
    return {
      ...(detected ? { lang: detected.lang, confidence: detected.confidence } : {}),
      alphaChars: countAlphaChars(args.text),
      minAlphaChars: MIN_ALPHA_CHARS,
    };
  },
});
