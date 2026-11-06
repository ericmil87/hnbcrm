/**
 * Tradução no composer (F3, "Revisar rápido"): regras puras da prévia viva e
 * da decisão de envio. Sem React nem Convex; o hook
 * `components/inbox/useComposerTranslation.ts` liga o relógio e a action.
 *
 * Contrato com o servidor (F1): `sendMessage({content: traduzido,
 * translation: {authoredText, sourceLang, targetLang, edited}})` insere a
 * mensagem já `done`, sem desvio. `language:"off"` envia como foi escrito.
 * Sem nenhum dos dois, o desvio da porta traduz no servidor.
 */
import type { ConversationLanguageState, OutboundMode } from "@/lib/translationRules";

export type ComposerTranslationMode = "off" | "quick" | "strict";

/** Espera depois da última tecla antes de pedir a prévia. */
export const PREVIEW_DEBOUNCE_MS = 700;
/** Enter com a prévia em voo espera no máximo isto; depois envia o digitado (o servidor traduz). */
export const PREVIEW_SEND_CAP_MS = 4000;

export function composerTranslationMode(args: {
  moduleEnabled: boolean;
  outboundMode: OutboundMode;
  languageState: Pick<ConversationLanguageState, "active" | "lang">;
  isInternal: boolean;
}): ComposerTranslationMode {
  if (!args.moduleEnabled || args.isInternal) return "off";
  if (!args.languageState.active || !args.languageState.lang) return "off";
  if (args.outboundMode === "direct") return "off";
  return args.outboundMode === "strict_review" ? "strict" : "quick";
}

/** Resultado da prévia guardado no cache (erros nunca entram). */
export type PreviewResult =
  | { kind: "ready"; text: string; sourceLang: string; targetLang: string }
  | { kind: "skipped"; targetLang: string };

/** Resposta de `api.translation.preview`. */
export interface PreviewResponse {
  text: string;
  sourceLang: string;
  targetLang: string | null;
  engine: string | null;
  skipped: boolean;
  reason?: string;
}

export function previewResultFrom(res: PreviewResponse, fallbackTarget: string): PreviewResult {
  const targetLang = res.targetLang ?? fallbackTarget;
  if (res.skipped) return { kind: "skipped", targetLang };
  return { kind: "ready", text: res.text, sourceLang: res.sourceLang, targetLang };
}

export function previewCacheKey(conversationId: string, targetLang: string, text: string): string {
  return `${conversationId}\u0000${targetLang}\u0000${text}`;
}

/** LRU pequeno em memória: redigitar o mesmo texto não chama o provedor de novo. */
export class PreviewCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly max = 100) {}
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  get size(): number {
    return this.map.size;
  }
}

export interface TranslatedSendArgs {
  content: string;
  translation: { authoredText: string; sourceLang: string; targetLang: string; edited?: boolean };
}

export type SendPlan =
  /** Envia a tradução mostrada (nasce `done`, sem desvio). */
  | ({ kind: "translated" } & TranslatedSendArgs)
  /** Envia o digitado com `language:"off"`. */
  | { kind: "untranslated" }
  /** Envia o digitado sem args: o servidor decide (desvio da F1). */
  | { kind: "plain" }
  /** Revisar antes: o primeiro Enter só mostra a prévia. */
  | { kind: "confirm" };

/**
 * Decide o que um Enter faz. `preview` = resultado para o texto digitado
 * (null = em voo que estourou o prazo, erro do provedor ou ainda não pedido).
 */
export function planTranslatedSend(args: {
  mode: ComposerTranslationMode;
  typed: string;
  preview: PreviewResult | null;
  editedText?: string;
  strictArmed?: boolean;
  forceUntranslated?: boolean;
}): SendPlan {
  if (args.mode === "off" || !args.typed.trim()) return { kind: "plain" };
  if (args.forceUntranslated) return { kind: "untranslated" };
  if (args.mode === "strict" && !args.strictArmed) return { kind: "confirm" };
  const preview = args.preview;
  if (!preview) return { kind: "plain" };
  if (preview.kind === "skipped") return { kind: "untranslated" };
  const edited = args.editedText !== undefined ? args.editedText.trim() : "";
  const isEdited = edited.length > 0 && edited !== preview.text.trim();
  return {
    kind: "translated",
    content: isEdited ? edited : preview.text.trim(),
    translation: {
      authoredText: args.typed.trim(),
      sourceLang: preview.sourceLang,
      targetLang: preview.targetLang,
      ...(isEdited ? { edited: true } : {}),
    },
  };
}

/** Texto que o contador do canal deve medir: a tradução (editada) quando há prévia. */
export function textForCounter(typed: string, preview: PreviewResult | null, editedText?: string): string {
  if (preview?.kind !== "ready") return typed;
  const edited = editedText?.trim();
  return edited ? edited : preview.text;
}
