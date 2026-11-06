/**
 * Gates da tradução automática (F1). PURO: o ÚNICO lugar que decide se uma
 * mensagem é traduzida, em qualquer direção.
 *
 * - Módulo `translation` desligado (ausente) = nada acontece, byte a byte.
 * - Provedores (D2 ajustado): `auto` = LibreTranslate self-hosted (se
 *   `LIBRETRANSLATE_URL`) → LLM (só com `orgAiActive`); `libretranslate` e
 *   `llm` restringem a um só.
 * - Nunca traduz: nota interna, conversa de grupo, resposta da IA na saída
 *   (ela responde no idioma do lead; a equipe lê pelo papel `display`),
 *   template, encaminhada, campanha, boas-vindas automática, mídia sem texto,
 *   mensagem que já tem `metadata.translation`, mesma língua, conversa `off`.
 */
import { Doc } from "../_generated/dataModel";
import { orgAiActive } from "./agentSecurity";
import { DEFAULT_TEAM_LANGUAGE, normalizeLanguageCode, sameLanguage } from "./languages";
import { detectLanguage } from "./languageDetect";

export type TranslationEngine = "libretranslate" | "llm";
export type TranslationRole = "inbound" | "outbound" | "display";
export type TranslationStatus = "pending" | "done" | "failed" | "skipped";

export type TranslationMeta = {
  status: TranslationStatus;
  role: TranslationRole;
  sourceLang?: string;
  targetLang?: string;
  confidence?: number;
  engine?: TranslationEngine;
  model?: string;
  upstream?: string;
  edited?: boolean;
  error?: string;
  /**
   * F3: por que ficou `skipped` (só o código; nunca texto). `low_confidence` e
   * `short` alimentam o "Idioma incerto" da bolha.
   */
  reason?: TranslationSkipReason;
  /** F3: idioma provável quando a detecção não foi confiante (só o código). */
  candidateLang?: string;
  at: number;
};

export type TranslationSkipReason =
  | "low_confidence"
  | "short"
  | "same_language"
  | "ask_mode"
  | "language_off"
  /** Review: saída longa demais para traduzir (fica `failed`, retida). */
  | "long_text";

export type ResolvedTranslationSettings = {
  provider: "auto" | "libretranslate" | "llm";
  teamLanguage: string;
  inboundMode: "auto" | "ask";
  outboundMode: "direct" | "quick_review" | "strict_review";
  skipWhenSameLanguage: boolean;
  tone: "neutral" | "formal" | "informal";
  glossary: string[];
};

export const MAX_GLOSSARY_TERMS = 100;
export const MAX_GLOSSARY_TERM_LENGTH = 80;
/** Texto acima disso não é traduzido automaticamente (custo e limite do canal). */
export const MAX_TRANSLATION_CHARS = 4000;

type OrgLike = Pick<Doc<"organizations">, "settings"> | null | undefined;
type ConversationLike = Pick<Doc<"conversations">, "kind" | "channel" | "translation"> | null | undefined;
type MessageLike = Pick<
  Doc<"messages">,
  "direction" | "senderType" | "isInternal" | "contentType" | "content" | "metadata"
>;

export function translationEnabledForOrg(org: OrgLike): boolean {
  return org?.settings?.modules?.translation === true;
}

export function resolveTranslationSettings(org: OrgLike): ResolvedTranslationSettings {
  const t = org?.settings?.translation;
  return {
    provider: t?.provider ?? "auto",
    teamLanguage: normalizeLanguageCode(t?.teamLanguage) ?? DEFAULT_TEAM_LANGUAGE,
    inboundMode: t?.inboundMode ?? "auto",
    outboundMode: t?.outboundMode ?? "quick_review",
    skipWhenSameLanguage: t?.skipWhenSameLanguage !== false,
    tone: t?.tone ?? "neutral",
    glossary: sanitizeGlossary(t?.glossary ?? []),
  };
}

export function sanitizeGlossary(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of terms) {
    const term = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_GLOSSARY_TERM_LENGTH);
    if (!term || out.some((t) => t.toLowerCase() === term.toLowerCase())) continue;
    out.push(term);
    if (out.length >= MAX_GLOSSARY_TERMS) break;
  }
  return out;
}

/** Provedores disponíveis, na ordem em que a cadeia os tenta. */
export function availableEngines(
  org: OrgLike,
  env: { libretranslateUrl?: string | undefined }
): TranslationEngine[] {
  const provider = resolveTranslationSettings(org).provider;
  const lt = Boolean(env.libretranslateUrl && env.libretranslateUrl.trim());
  const llm = orgAiActive((org ?? null) as Doc<"organizations"> | null);
  const out: TranslationEngine[] = [];
  if (lt && (provider === "auto" || provider === "libretranslate")) out.push("libretranslate");
  if (llm && (provider === "auto" || provider === "llm")) out.push("llm");
  return out;
}

export function translationOf(message: Pick<Doc<"messages">, "metadata">): TranslationMeta | undefined {
  const t = message.metadata?.translation;
  return t && typeof t === "object" ? (t as TranslationMeta) : undefined;
}

/** Placeholder de mídia ("[imagem]", "[vídeo]") não é texto do cliente. */
export function isPlaceholderContent(content: string): boolean {
  return /^\s*\[[^\]]{1,40}\]\s*$/.test(content);
}

/**
 * Texto traduzível da mensagem (texto puro ou legenda de imagem). Com
 * `fileCaption` (só SAÍDA: o composer grava a legenda digitada em `content`;
 * na entrada um documento traz o NOME do arquivo ali), a legenda de um
 * arquivo/vídeo (`contentType:"file"`) também conta.
 */
export function translatableText(
  message: Pick<Doc<"messages">, "contentType" | "content">,
  opts: { fileCaption?: boolean } = {}
): string | undefined {
  const allowed =
    message.contentType === "text" || message.contentType === "image" || (opts.fileCaption && message.contentType === "file");
  if (!allowed) return undefined;
  const text = String(message.content ?? "").trim();
  if (!text || isPlaceholderContent(text)) return undefined;
  return text;
}

const OUTBOUND_EXCLUDED_METADATA = ["template", "forwarded", "campaign", "inboundWelcome"] as const;

export type GateDecision = { ok: true } | { ok: false; reason: string };

function commonRefusal(
  org: OrgLike,
  conversation: ConversationLike,
  message: MessageLike
): string | undefined {
  if (!translationEnabledForOrg(org)) return "modulo_desligado";
  if (!conversation) return "sem_conversa";
  if (conversation.kind === "group") return "grupo";
  if (message.isInternal || message.direction === "internal") return "nota_interna";
  if (conversation.translation?.mode === "off") return "conversa_sem_traducao";
  if (message.metadata?.deletedByCustomer === true) return "apagada";
  if (message.metadata?.importedFromHistory === true) return "historico";
  return undefined;
}

/**
 * Traduzir esta inbound (ou a transcrição dela, `text` explícito) para a
 * equipe? A detecção de idioma e o "mesma língua" ficam na action.
 */
export function shouldTranslateInbound(args: {
  org: OrgLike;
  conversation: ConversationLike;
  message: MessageLike;
  text?: string;
  force?: boolean;
}): GateDecision {
  const refusal = commonRefusal(args.org, args.conversation, args.message);
  if (refusal) return { ok: false, reason: refusal };
  if (args.message.direction !== "inbound" || args.message.senderType !== "contact") {
    return { ok: false, reason: "nao_e_inbound" };
  }
  const existing = translationOf(args.message);
  if (existing && !args.force && existing.status !== "pending") return { ok: false, reason: "ja_traduzida" };
  const text = args.text ?? translatableText(args.message);
  if (!text) return { ok: false, reason: "sem_texto" };
  if (text.length > MAX_TRANSLATION_CHARS) return { ok: false, reason: "texto_longo" };
  if (!args.force && resolveTranslationSettings(args.org).inboundMode === "ask" && !args.conversation?.translation?.mode) {
    return { ok: false, reason: "aguardando_escolha" };
  }
  return { ok: true };
}

/** Tradução de EXIBIÇÃO: resposta da IA (no idioma do lead) para a equipe. */
export function shouldTranslateDisplay(args: {
  org: OrgLike;
  conversation: ConversationLike;
  message: MessageLike;
}): GateDecision {
  const refusal = commonRefusal(args.org, args.conversation, args.message);
  if (refusal) return { ok: false, reason: refusal };
  if (args.message.direction !== "outbound" || args.message.senderType !== "ai") {
    return { ok: false, reason: "nao_e_ia" };
  }
  if (translationOf(args.message)) return { ok: false, reason: "ja_traduzida" };
  const text = translatableText(args.message);
  if (!text) return { ok: false, reason: "sem_texto" };
  if (text.length > MAX_TRANSLATION_CHARS) return { ok: false, reason: "texto_longo" };
  return { ok: true };
}

/**
 * Desviar esta outbound para a tradução ANTES do despacho? `targetLang` vem de
 * `resolveTargetLanguage` (nunca de uma dica de DDI). Mensagem já com
 * `metadata.translation` (done/skipped/failed/pending) segue o fluxo normal da
 * porta: o desvio acontece no máximo UMA vez por mensagem.
 */
export function shouldTranslateOutbound(args: {
  org: OrgLike;
  conversation: ConversationLike;
  message: MessageLike;
  targetLang: string | undefined;
}): GateDecision {
  const refusal = commonRefusal(args.org, args.conversation, args.message);
  if (refusal) return { ok: false, reason: refusal };
  if (args.message.direction !== "outbound") return { ok: false, reason: "nao_e_outbound" };
  // Rascunho da IA editado por um humano na língua da equipe (review #3): o
  // commit de aprovação marca `aiDraft.editedInTeamLanguage` e a saída é
  // traduzida como a de um humano.
  if (args.message.senderType === "ai" && !isTeamEditedAiDraft(args.message)) {
    return { ok: false, reason: "resposta_da_ia" };
  }
  for (const key of OUTBOUND_EXCLUDED_METADATA) {
    if (args.message.metadata?.[key] !== undefined && args.message.metadata?.[key] !== false) {
      return { ok: false, reason: key };
    }
  }
  if (translationOf(args.message)) return { ok: false, reason: "ja_tratada" };
  const text = translatableText(args.message, { fileCaption: true });
  if (!text) return { ok: false, reason: "sem_texto" };
  const target = normalizeLanguageCode(args.targetLang);
  if (!target) return { ok: false, reason: "sem_idioma" };
  const team = resolveTranslationSettings(args.org).teamLanguage;
  if (sameLanguage(target, team)) return { ok: false, reason: "mesma_lingua" };
  // Por último: só "longa demais" quando a tradução seria DEVIDA. O desvio
  // retém a mensagem como `failed` (nunca sai em pt-BR sozinha).
  if (text.length > MAX_TRANSLATION_CHARS) return { ok: false, reason: "texto_longo" };
  return { ok: true };
}

/** Rascunho da IA que um humano editou na língua da equipe (marcado no commit). */
export function isTeamEditedAiDraft(message: Pick<Doc<"messages">, "senderType" | "metadata">): boolean {
  if (message.senderType !== "ai") return false;
  const draft = message.metadata?.aiDraft as { editedInTeamLanguage?: unknown } | undefined;
  return draft?.editedInTeamLanguage === true;
}

/**
 * A conversa tem idioma estrangeiro ATIVO (ou um candidato a ele)? Só nela a
 * inbound na língua da equipe ganha `skipped` gravado; fora dela, nada é
 * escrito (review #10: custo por inbound com o módulo ligado).
 */
export function conversationHasForeignLanguage(conversation: ConversationLike, teamLanguage: string): boolean {
  const t = conversation?.translation;
  if (!t || t.mode === "off") return false;
  const lang = normalizeLanguageCode(t.lang);
  if (lang && !sameLanguage(lang, teamLanguage)) return true;
  const candidate = normalizeLanguageCode(t.candidateLang);
  return !!candidate && !sameLanguage(candidate, teamLanguage);
}

/**
 * F3: tradução de EXIBIÇÃO de um rascunho da IA (modo sugerir) para a equipe
 * ler em pt-BR antes de aprovar. O rascunho é nota interna por construção
 * (`isInternal`), então não passa por `commonRefusal`: aqui só vale conversa
 * 1 a 1 com idioma estrangeiro conhecido e tradução não desligada.
 */
export function shouldTranslateDraft(args: {
  org: OrgLike;
  conversation: ConversationLike;
  message: Pick<Doc<"messages">, "senderType" | "contentType" | "content" | "metadata">;
}): GateDecision {
  if (!translationEnabledForOrg(args.org)) return { ok: false, reason: "modulo_desligado" };
  const conversation = args.conversation;
  if (!conversation) return { ok: false, reason: "sem_conversa" };
  if (conversation.kind === "group") return { ok: false, reason: "grupo" };
  if (conversation.translation?.mode === "off") return { ok: false, reason: "conversa_sem_traducao" };
  if (args.message.senderType !== "ai") return { ok: false, reason: "nao_e_ia" };
  const draft = args.message.metadata?.aiDraft as { status?: string; translatedText?: string } | undefined;
  if (!draft || draft.status !== "pending") return { ok: false, reason: "sem_rascunho" };
  if (draft.translatedText) return { ok: false, reason: "ja_traduzida" };
  const text = String(args.message.content ?? "").trim();
  if (!text || isPlaceholderContent(text)) return { ok: false, reason: "sem_texto" };
  if (text.length > MAX_TRANSLATION_CHARS) return { ok: false, reason: "texto_longo" };
  const lang = normalizeLanguageCode(conversation.translation?.lang);
  if (!lang) return { ok: false, reason: "sem_idioma" };
  if (sameLanguage(lang, resolveTranslationSettings(args.org).teamLanguage)) return { ok: false, reason: "mesma_lingua" };
  return { ok: true };
}

/**
 * Review #3: o humano editou o rascunho da IA ao aprovar. Se o texto final
 * está na língua da equipe (ou é curto demais para detectar) numa conversa 1 a
 * 1 com idioma estrangeiro ativo, a saída precisa do desvio de tradução como a
 * de um humano — o commit marca `aiDraft.editedInTeamLanguage`.
 */
export function editedDraftNeedsTranslation(args: {
  org: OrgLike;
  conversation: ConversationLike;
  finalText: string;
}): boolean {
  if (!translationEnabledForOrg(args.org)) return false;
  const conversation = args.conversation;
  if (!conversation || conversation.kind === "group" || conversation.translation?.mode === "off") return false;
  const team = resolveTranslationSettings(args.org).teamLanguage;
  const lang = normalizeLanguageCode(conversation.translation?.lang);
  if (!lang || sameLanguage(lang, team)) return false;
  const detected = detectLanguage(args.finalText);
  return !detected || sameLanguage(detected.lang, team);
}
