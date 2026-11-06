/**
 * Idioma da CONVERSA (tradução automática F1). PURO.
 *
 * - `resolveTargetLanguage`: a ÚNICA regra de precedência do idioma de saída.
 *   Override manual da conversa > automático da conversa > `contact.preferredLanguage`
 *   > último inbound detectado > dica do DDI (só dica: `hintOnly`, nunca traduz
 *   sozinha) > nenhum.
 * - `nextConversationTranslation`: como a detecção de UMA mensagem mexe no
 *   idioma da conversa. Mensagem curta (detecção `undefined`) herda; troca só
 *   depois de 2 mensagens longas consecutivas divergentes (`divergentStreak` +
 *   `candidateLang`); manual/off nunca são sobrescritos pela detecção.
 *   O PRIMEIRO idioma (conversa sem `lang`) só é fixado com evidência
 *   (review #11): 2 mensagens longas consecutivas no mesmo idioma, OU detecção
 *   forte (confiança ≥ 0,85 em texto com ≥ 40 letras), OU concordância com
 *   `contact.preferredLanguage`/dica do DDI. Sem isso fica só `candidateLang`
 *   (a mensagem em si é traduzida para exibição do mesmo jeito).
 */
import { DetectedLanguage } from "./languageDetect";
import { languageHintFromDialCode, normalizeLanguageCode, sameLanguage } from "./languages";

export type ConversationTranslation = {
  lang?: string;
  source?: "auto" | "manual" | "contact";
  mode?: "auto" | "manual" | "off";
  detectedAt?: number;
  divergentStreak?: number;
  candidateLang?: string;
};

export type TargetLanguageSource = "manual" | "auto" | "contact" | "last_inbound" | "dial_code" | "off" | "none";

export type ResolvedTargetLanguage = {
  lang?: string;
  source: TargetLanguageSource;
  /** true = só sugestão (DDI); quem envia NÃO deve traduzir com base nisso. */
  hintOnly: boolean;
};

/** Confiança mínima de uma detecção para contar na regra da conversa. */
export const MIN_DETECTION_CONFIDENCE = 0.6;
/** Mensagens longas divergentes consecutivas para trocar o idioma da conversa. */
export const DIVERGENT_STREAK_TO_SWITCH = 2;
/** Detecção forte o bastante para fixar o 1º idioma da conversa sozinha. */
export const STRONG_DETECTION_CONFIDENCE = 0.85;
export const STRONG_DETECTION_ALPHA_CHARS = 40;

/** Evidência extra para fixar o 1º idioma (todas opcionais). */
export type LanguageEvidence = {
  /** Letras do texto detectado (`countAlphaChars`). */
  alphaChars?: number;
  contactPreferredLanguage?: string | null;
  /** Dica do DDI do contato (`languageHintFromDialCode`). */
  dialHint?: string | null;
};

/** O 1º idioma detectado pode ser fixado já nesta mensagem? */
export function firstDetectionFixesLanguage(detected: DetectedLanguage, evidence: LanguageEvidence = {}): boolean {
  const lang = normalizeLanguageCode(detected.lang);
  if (!lang) return false;
  if (
    detected.confidence >= STRONG_DETECTION_CONFIDENCE &&
    (evidence.alphaChars ?? 0) >= STRONG_DETECTION_ALPHA_CHARS
  ) {
    return true;
  }
  if (sameLanguage(normalizeLanguageCode(evidence.contactPreferredLanguage), lang)) return true;
  return sameLanguage(normalizeLanguageCode(evidence.dialHint), lang);
}

export function resolveTargetLanguage(input: {
  conversation?: ConversationTranslation | null;
  contactPreferredLanguage?: string | null;
  lastInboundLang?: string | null;
  phone?: string | null;
}): ResolvedTargetLanguage {
  const conv = input.conversation ?? undefined;
  if (conv?.mode === "off") return { source: "off", hintOnly: false };
  const convLang = normalizeLanguageCode(conv?.lang);
  if (convLang && (conv?.mode === "manual" || conv?.source === "manual")) {
    return { lang: convLang, source: "manual", hintOnly: false };
  }
  if (convLang) return { lang: convLang, source: "auto", hintOnly: false };
  const contact = normalizeLanguageCode(input.contactPreferredLanguage);
  if (contact) return { lang: contact, source: "contact", hintOnly: false };
  const last = normalizeLanguageCode(input.lastInboundLang);
  if (last) return { lang: last, source: "last_inbound", hintOnly: false };
  const hint = languageHintFromDialCode(input.phone);
  if (hint) return { lang: hint, source: "dial_code", hintOnly: true };
  return { source: "none", hintOnly: false };
}

/**
 * Próximo estado de `conversations.translation` após detectar uma mensagem
 * inbound. `undefined` = nada muda (zero escrita).
 */
export function nextConversationTranslation(
  current: ConversationTranslation | null | undefined,
  detected: DetectedLanguage | undefined,
  now: number,
  evidence: LanguageEvidence = {}
): ConversationTranslation | undefined {
  const next = nextConversationTranslationRaw(current, detected, now, evidence);
  return next === undefined ? undefined : compactTranslation(next);
}

/** Tira chaves `undefined` (o doc gravado fica limpo). */
export function compactTranslation(t: ConversationTranslation): ConversationTranslation {
  return Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)) as ConversationTranslation;
}

function nextConversationTranslationRaw(
  current: ConversationTranslation | null | undefined,
  detected: DetectedLanguage | undefined,
  now: number,
  evidence: LanguageEvidence
): ConversationTranslation | undefined {
  if (current?.mode === "off" || current?.mode === "manual" || current?.source === "manual") return undefined;
  if (!detected || detected.confidence < MIN_DETECTION_CONFIDENCE) return undefined;
  const lang = normalizeLanguageCode(detected.lang);
  if (!lang) return undefined;

  const base: ConversationTranslation = { ...(current ?? {}) };
  if (!current?.lang) {
    const streak = sameLanguage(current?.candidateLang, lang) ? (current?.divergentStreak ?? 0) + 1 : 1;
    if (streak >= DIVERGENT_STREAK_TO_SWITCH || firstDetectionFixesLanguage({ lang, confidence: detected.confidence }, evidence)) {
      return {
        ...base,
        lang,
        source: "auto",
        detectedAt: now,
        divergentStreak: 0,
        candidateLang: undefined,
      };
    }
    return { ...base, divergentStreak: streak, candidateLang: lang };
  }
  if (sameLanguage(current.lang, lang)) {
    if ((current.divergentStreak ?? 0) === 0 && current.candidateLang === undefined) return undefined;
    return { ...base, divergentStreak: 0, candidateLang: undefined };
  }
  const streak = sameLanguage(current.candidateLang, lang) ? (current.divergentStreak ?? 0) + 1 : 1;
  if (streak >= DIVERGENT_STREAK_TO_SWITCH) {
    return { ...base, lang, source: "auto", detectedAt: now, divergentStreak: 0, candidateLang: undefined };
  }
  return { ...base, divergentStreak: streak, candidateLang: lang };
}

/**
 * Idioma de origem de UMA mensagem inbound para traduzir: a detecção dela
 * quando confiável, senão o idioma da conversa (mensagem curta herda), senão
 * a dica externa (ex.: idioma devolvido pelo Whisper).
 */
export function effectiveSourceLanguage(input: {
  detected?: DetectedLanguage;
  conversationLang?: string;
  hint?: string;
}): string | undefined {
  if (input.detected && input.detected.confidence >= MIN_DETECTION_CONFIDENCE) {
    return normalizeLanguageCode(input.detected.lang);
  }
  return normalizeLanguageCode(input.conversationLang) ?? normalizeLanguageCode(input.hint);
}
