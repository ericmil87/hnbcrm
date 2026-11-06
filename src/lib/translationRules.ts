/**
 * Tradução automática na conversa (F2): decisões puras da bolha, do chip de
 * idioma e do aviso da conversa. Sem Convex, sem relógio próprio (o `now`
 * entra por argumento) e sem DOM.
 *
 * Regra de ouro (contrato F1): `message.content` é o texto que trafegou no
 * canal. `translatedText` é sempre a versão na língua da equipe e o estado vive
 * em `metadata.translation`.
 */
import {
  DEFAULT_TEAM_LANGUAGE,
  LANGUAGES,
  languageName,
  normalizeLanguageCode,
  sameLanguage,
} from "../../convex/lib/languages";

export type TranslationStatus = "pending" | "done" | "failed" | "skipped";
export type TranslationRole = "inbound" | "outbound" | "display";

export interface TranslationMeta {
  status: TranslationStatus;
  role: TranslationRole;
  sourceLang?: string;
  targetLang?: string;
  confidence?: number;
  engine?: "libretranslate" | "llm";
  model?: string;
  upstream?: string;
  edited?: boolean;
  error?: string;
  /**
   * Motivo (só código): do `skipped` (F3) ou, na enviada `failed`, `long_text`
   * (texto grande demais para traduzir; tentar de novo não adianta).
   */
  reason?: "low_confidence" | "short" | "same_language" | "ask_mode" | "language_off" | "long_text";
  /** F3: idioma provável quando a detecção ficou incerta. */
  candidateLang?: string;
  at: number;
}

/** `conversations.translation` como o servidor grava. */
export interface ConversationTranslation {
  lang?: string;
  source?: "auto" | "manual" | "contact";
  mode?: "auto" | "manual" | "off";
  detectedAt?: number;
  divergentStreak?: number;
  candidateLang?: string;
}

export type InboundMode = "auto" | "ask";
export type OutboundMode = "direct" | "quick_review" | "strict_review";

/** O que a conversa precisa saber da org (módulo + idioma da equipe + modos). */
export interface TranslationOrgSettings {
  moduleEnabled: boolean;
  teamLanguage: string;
  inboundMode: InboundMode;
  /** F3: ausente no servidor = `quick_review` (prévia viva no composer). */
  outboundMode: OutboundMode;
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationOrgSettings = {
  moduleEnabled: false,
  teamLanguage: DEFAULT_TEAM_LANGUAGE,
  inboundMode: "auto",
  outboundMode: "quick_review",
};

/** Janela em que uma recebida sem `metadata.translation` ainda conta como "Traduzindo…". */
export const INFER_TRANSLATING_MS = 30_000;

// ── Nomes de idioma ────────────────────────────────────────────────────────

let displayNames: Intl.DisplayNames | null | undefined;
function intlNames(): Intl.DisplayNames | null {
  if (displayNames !== undefined) return displayNames;
  try {
    displayNames = new Intl.DisplayNames(["pt-BR"], { type: "language" });
  } catch {
    displayNames = null;
  }
  return displayNames;
}

const capitalize = (s: string) => (s ? s.charAt(0).toLocaleUpperCase("pt-BR") + s.slice(1) : s);

/**
 * Nome do idioma em PT-BR ("Espanhol", "Português (Brasil)"). `Intl.DisplayNames`
 * primeiro, catálogo (`languageName`) quando o navegador não sabe. `lower` dá a
 * forma para o meio da frase ("Este lead parece falar espanhol").
 */
export function languageDisplayName(code: string | undefined | null, opts?: { lower?: boolean }): string {
  const raw = String(code ?? "").trim();
  if (!raw) return "";
  let name = "";
  try {
    const fromIntl = intlNames()?.of(normalizeLanguageCode(raw) ?? raw);
    if (fromIntl && fromIntl.toLowerCase() !== raw.toLowerCase()) name = fromIntl;
  } catch {
    name = "";
  }
  if (!name) name = languageName(raw);
  return opts?.lower ? name.charAt(0).toLocaleLowerCase("pt-BR") + name.slice(1) : capitalize(name);
}

/** Código curto para pílulas: "es" → "ES", "pt-BR" → "PT". */
export function shortLanguageCode(code: string | undefined | null): string {
  return String(code ?? "").split(/[-_]/)[0].toUpperCase();
}

/** Código da equipe como aparece nos rótulos ("pt-BR"). */
export function teamLanguageLabel(code: string | undefined | null): string {
  return normalizeLanguageCode(code) ?? String(code ?? DEFAULT_TEAM_LANGUAGE);
}

/** Idiomas oferecidos no seletor (o da equipe vira "não traduzir"). */
export function selectableLanguages(teamLanguage: string): { code: string; name: string }[] {
  return LANGUAGES.filter((l) => !sameLanguage(l.code, teamLanguage)).map((l) => ({
    code: l.code,
    name: languageDisplayName(l.code),
  }));
}

/** Opções de `Select` com todo o catálogo (idioma da equipe, idioma preferido). */
export function languageSelectOptions(): { value: string; label: string }[] {
  return LANGUAGES.map((l) => ({ value: l.code, label: languageDisplayName(l.code) }));
}

// ── Estado da conversa ─────────────────────────────────────────────────────

export interface ConversationLanguageState {
  /** Idioma conhecido da conversa (detectado, do contato ou fixado). */
  lang?: string;
  mode?: "auto" | "manual" | "off";
  /** Idioma conhecido e diferente do da equipe. */
  foreign: boolean;
  /** O servidor traduz as recebidas desta conversa agora. */
  active: boolean;
  /** Modo "perguntar": idioma detectado, equipe ainda não escolheu. */
  awaitingChoice: boolean;
  /** Conversa elegível (módulo ligado e 1 a 1). */
  eligible: boolean;
}

/**
 * Só `translation.lang` conta como idioma da conversa. Enquanto o primeiro
 * idioma não se confirma, o servidor guarda apenas `candidateLang` +
 * `divergentStreak`: isso NÃO ativa nada (chip, "Traduzindo…", aviso).
 */
export function conversationLanguageState(
  conversation: { translation?: ConversationTranslation | null; kind?: string | null } | null | undefined,
  settings: Pick<TranslationOrgSettings, "moduleEnabled" | "teamLanguage" | "inboundMode">
): ConversationLanguageState {
  const t = conversation?.translation ?? undefined;
  const lang = normalizeLanguageCode(t?.lang) ?? undefined;
  const mode = t?.mode;
  const eligible = settings.moduleEnabled && !!conversation && conversation.kind !== "group";
  const foreign = !!lang && !sameLanguage(lang, settings.teamLanguage);
  const decided = mode !== undefined || settings.inboundMode === "auto";
  return {
    lang,
    mode,
    foreign,
    eligible,
    active: eligible && foreign && mode !== "off" && decided,
    awaitingChoice: eligible && foreign && mode === undefined && settings.inboundMode === "ask",
  };
}

/** Rótulo do chip de idioma (composer e cabeçalho). `null` = chip escondido. */
export function languageChipLabel(
  state: ConversationLanguageState,
  teamLanguage: string
): { short: string; full: string; tone: "active" | "off" } | null {
  if (!state.eligible) return null;
  if (state.mode === "off") {
    return {
      short: "Sem tradução",
      full: `Enviar em: ${languageDisplayName(teamLanguage)} (sem tradução)`,
      tone: "off",
    };
  }
  if (!state.lang) return null;
  // Lead no idioma da equipe e nada fixado: o chip seria ruído.
  if (!state.foreign && state.mode !== "manual") return null;
  const fixed = state.mode === "manual";
  const name = languageDisplayName(state.lang);
  return {
    short: `${shortLanguageCode(state.lang)} · ${fixed ? "fixo" : "auto"}`,
    full: `Enviar em: ${name} (${fixed ? "fixo" : "auto"})`,
    tone: state.foreign ? "active" : "off",
  };
}

// ── Bolha ──────────────────────────────────────────────────────────────────

export interface TranslatableMessage {
  content: string;
  direction: string;
  senderType: string;
  isInternal: boolean;
  createdAt: number;
  contentType?: string;
  translatedText?: string;
  metadata?: Record<string, any>;
}

export function getTranslationMeta(message: { metadata?: Record<string, any> }): TranslationMeta | null {
  const t = message.metadata?.translation;
  return t && typeof t === "object" && typeof t.status === "string" && typeof t.role === "string"
    ? (t as TranslationMeta)
    : null;
}

export type TranslationView =
  | { kind: "none" }
  /** Texto principal + secundário alternáveis, com rótulo. */
  | {
      kind: "translated";
      role: TranslationRole;
      primary: string;
      secondary: string;
      primaryLang?: string;
      secondaryLang?: string;
      /** Rótulo com o texto principal à vista. */
      label: string;
      /** Ação do rótulo com o principal à vista / com o secundário à vista. */
      showSecondaryLabel: string;
      showPrimaryLabel: string;
      /** Rótulo com o secundário à vista. */
      secondaryLabel: string;
    }
  | { kind: "translating"; inferred: boolean }
  | { kind: "failed" }
  | { kind: "outbound_pending" }
  /** `tooLong`: falhou por `long_text`; só "Enviar sem traduzir" resolve. */
  | { kind: "outbound_failed"; error?: string; tooLong?: boolean }
  | { kind: "outbound_skipped" }
  /** F3: recebida pulada com detecção incerta; oferece traduzir como `lang`. */
  | { kind: "uncertain"; lang: string };

export interface TranslationViewContext {
  /**
   * A conversa traduz as recebidas agora (`conversationLanguageState().active`:
   * idioma conhecido e diferente do da equipe, modo diferente de `off`). O
   * servidor não grava nada nas recebidas de conversas inativas, então só uma
   * conversa ativa infere "Traduzindo…".
   */
  conversationActive: boolean;
  now: number;
  /** Conversa de grupo nunca traduz. */
  isGroup?: boolean;
}

const NONE: TranslationView = { kind: "none" };

function outboundFailedView(meta: TranslationMeta): TranslationView {
  return meta.reason === "long_text"
    ? { kind: "outbound_failed", error: meta.error, tooLong: true }
    : { kind: "outbound_failed", error: meta.error };
}

const isInbound = (m: TranslatableMessage) => m.direction === "inbound" || m.senderType === "contact";
const isTextMessage = (m: TranslatableMessage) => !m.contentType || m.contentType === "text";

/**
 * Recebida de texto, sem `metadata.translation`, com menos de 30 s, numa
 * conversa ativa: o servidor ainda vai gravar o estado, então "Traduzindo…".
 */
function infersTranslating(m: TranslatableMessage, conversationActive: boolean, now: number): boolean {
  return (
    conversationActive &&
    isInbound(m) &&
    !m.isInternal &&
    isTextMessage(m) &&
    !getTranslationMeta(m) &&
    (m.content ?? "").trim().length > 0 &&
    now - m.createdAt < INFER_TRANSLATING_MS
  );
}

/** Como a bolha mostra a tradução desta mensagem. */
export function translationView(message: TranslatableMessage, ctx: TranslationViewContext): TranslationView {
  if (message.isInternal || ctx.isGroup) return NONE;
  const meta = getTranslationMeta(message);

  if (!meta) {
    return infersTranslating(message, ctx.conversationActive, ctx.now) ? { kind: "translating", inferred: true } : NONE;
  }

  if (meta.role === "outbound") {
    if (meta.status === "pending") return { kind: "outbound_pending" };
    if (meta.status === "failed") return outboundFailedView(meta);
    if (meta.status === "skipped") return { kind: "outbound_skipped" };
    if (meta.status === "done" && message.translatedText) {
      const team = teamLanguageLabel(meta.sourceLang);
      const target = languageDisplayName(meta.targetLang);
      const prefix = `${team} → ${target}`;
      return {
        kind: "translated",
        role: "outbound",
        primary: message.content,
        secondary: message.translatedText,
        primaryLang: meta.targetLang,
        secondaryLang: meta.sourceLang,
        label: `${prefix} · ${meta.edited ? "Tradução editada por você" : "Você escreveu"}`,
        showSecondaryLabel: "Ver",
        secondaryLabel: `${prefix} · Você escreveu`,
        showPrimaryLabel: "Ver o que foi enviado",
      };
    }
    return NONE;
  }

  // inbound e display: só a versão da equipe muda; o resto é o que chegou/saiu.
  if (meta.status === "pending") return { kind: "translating", inferred: false };
  if (meta.status === "failed") return { kind: "failed" };
  if (meta.status !== "done" || !message.translatedText) return NONE;

  if (meta.role === "display") {
    const team = teamLanguageLabel(meta.targetLang);
    return {
      kind: "translated",
      role: "display",
      primary: message.content,
      secondary: message.translatedText,
      primaryLang: meta.sourceLang,
      secondaryLang: meta.targetLang,
      label: "Resposta da IA",
      showSecondaryLabel: `Ver em ${team}`,
      secondaryLabel: `Resposta da IA em ${team}`,
      showPrimaryLabel: "Ver o que foi enviado",
    };
  }

  const prefix = `${languageDisplayName(meta.sourceLang)} → ${teamLanguageLabel(meta.targetLang)}`;
  return {
    kind: "translated",
    role: "inbound",
    primary: message.translatedText,
    secondary: message.content,
    primaryLang: meta.targetLang,
    secondaryLang: meta.sourceLang,
    label: prefix,
    showSecondaryLabel: "Ver original",
    secondaryLabel: `Original (${languageDisplayName(meta.sourceLang, { lower: true })})`,
    showPrimaryLabel: "Ver tradução",
  };
}

/**
 * Menu "Traduzir mesmo assim": recebida (ou resposta da IA) com texto, módulo
 * ligado, sem tradução feita nem em voo.
 */
export function canRequestTranslation(
  message: TranslatableMessage,
  opts: { moduleEnabled: boolean; isGroup?: boolean }
): boolean {
  if (!opts.moduleEnabled || opts.isGroup || message.isInternal) return false;
  if (!(message.content ?? "").trim()) return false;
  const meta = getTranslationMeta(message);
  if (meta) return (meta.role === "inbound" || meta.role === "display") && meta.status === "skipped";
  return isInbound(message);
}

/** Alguma recebida ainda pode ganhar o "Traduzindo…" inferido (liga o relógio do thread). */
export function hasFreshUntranslated(
  messages: readonly TranslatableMessage[] | undefined,
  now: number,
  conversationActive: boolean
): boolean {
  if (!messages || !conversationActive) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (now - m.createdAt >= INFER_TRANSLATING_MS) return false;
    if (infersTranslating(m, true, now)) return true;
  }
  return false;
}

/** O que a bolha recebe de tradução (`null` = nada, a bolha fica como antes). */
export interface BubbleTranslation {
  view: TranslationView;
  canRequest: boolean;
}

/**
 * Decisão de tradução por bolha no thread. Módulo desligado (ou grupo) esconde
 * tudo, MENOS a enviada retida em `pending`/`failed`: ela não saiu e precisa de
 * "Tentar de novo"/"Enviar sem traduzir" mesmo depois que alguém desliga o módulo.
 */
export function bubbleTranslation(
  message: TranslatableMessage,
  ctx: {
    moduleEnabled: boolean;
    isGroup: boolean;
    teamLanguage: string;
    conversationActive: boolean;
    now: number;
    conversation?: { translation?: ConversationTranslation | null } | null;
  }
): BubbleTranslation | null {
  if (!ctx.moduleEnabled || ctx.isGroup) {
    const meta = getTranslationMeta(message);
    if (message.isInternal || meta?.role !== "outbound") return null;
    if (meta.status === "pending") return { view: { kind: "outbound_pending" }, canRequest: false };
    if (meta.status === "failed") return { view: outboundFailedView(meta), canRequest: false };
    return null;
  }
  const lang = uncertainLanguageOffer(message, {
    moduleEnabled: true,
    teamLanguage: ctx.teamLanguage,
    conversation: ctx.conversation,
  });
  return {
    view: lang
      ? { kind: "uncertain", lang }
      : translationView(message, { conversationActive: ctx.conversationActive, now: ctx.now }),
    canRequest: canRequestTranslation(message, { moduleEnabled: true }),
  };
}

// ── Aviso da conversa ──────────────────────────────────────────────────────

/** Janela em que uma detecção ainda é "nova" para o aviso automático. */
export const BANNER_FRESH_MS = 10 * 60_000;

export type TranslationBannerKind = "auto" | "ask" | "discover";

/**
 * Qual aviso mostrar no topo do thread. `discover` = módulo desligado, mas o
 * contato parece falar outro idioma (preferência ou DDI) e quem vê pode ligar.
 */
export function translationBannerKind(args: {
  state: ConversationLanguageState;
  translation?: ConversationTranslation | null;
  settings: TranslationOrgSettings;
  isGroup: boolean;
  /** Relógio fixado na montagem do thread. */
  openedAt: number;
  dismissed: boolean;
  canManageSettings: boolean;
  /** `contacts.preferredLanguage` ou a dica do DDI. */
  contactLanguageHint?: string;
}): TranslationBannerKind | null {
  if (args.isGroup || args.dismissed) return null;
  if (!args.settings.moduleEnabled) {
    if (!args.canManageSettings || !args.contactLanguageHint) return null;
    return sameLanguage(args.contactLanguageHint, args.settings.teamLanguage) ? null : "discover";
  }
  if (args.state.awaitingChoice) return "ask";
  const t = args.translation;
  if (
    args.state.active &&
    t?.mode !== "manual" &&
    t?.source !== "manual" &&
    typeof t?.detectedAt === "number" &&
    args.openedAt - t.detectedAt < BANNER_FRESH_MS
  ) {
    return "auto";
  }
  return null;
}

// ── Idioma incerto (F3) ────────────────────────────────────────────────────

/**
 * "Idioma incerto · Traduzir como espanhol?": recebida pulada por detecção
 * fraca (ou curta demais) com um idioma provável diferente do da equipe.
 * Devolve o código a oferecer, ou `null` (sem rótulo).
 */
export function uncertainLanguageOffer(
  message: TranslatableMessage,
  ctx: {
    moduleEnabled: boolean;
    teamLanguage: string;
    isGroup?: boolean;
    conversation?: { translation?: ConversationTranslation | null } | null;
  }
): string | null {
  if (!ctx.moduleEnabled || ctx.isGroup || message.isInternal || !isInbound(message)) return null;
  if (!(message.content ?? "").trim()) return null;
  const meta = getTranslationMeta(message);
  if (!meta || meta.role !== "inbound" || meta.status !== "skipped") return null;
  if (meta.reason !== "low_confidence" && meta.reason !== "short") return null;
  if (ctx.conversation?.translation?.mode === "off") return null;
  const candidate =
    normalizeLanguageCode(meta.candidateLang) ?? normalizeLanguageCode(ctx.conversation?.translation?.candidateLang);
  if (!candidate || sameLanguage(candidate, ctx.teamLanguage)) return null;
  return candidate;
}

export function uncertainLanguageLabel(lang: string): string {
  return `Idioma incerto · Traduzir como ${languageDisplayName(lang, { lower: true })}?`;
}
