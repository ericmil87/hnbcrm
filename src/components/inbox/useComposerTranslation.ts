import { useCallback, useEffect, useRef, useState } from "react";
import { mutationErrorMessage } from "@/lib/errors";
import {
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_SEND_CAP_MS,
  PreviewCache,
  planTranslatedSend,
  previewCacheKey,
  previewResultFrom,
  textForCounter,
  type ComposerTranslationMode,
  type PreviewResponse,
  type PreviewResult,
  type SendPlan,
} from "@/lib/composerTranslation";

export type ComposerPreviewView =
  | { kind: "loading" }
  | { kind: "ready"; text: string; targetLang: string }
  | { kind: "skipped"; targetLang: string }
  | { kind: "error"; message: string };

// Compartilhado entre composers: trocar de conversa e voltar não paga de novo.
const sharedCache = new PreviewCache<PreviewResult>(100);

export interface UseComposerTranslationArgs {
  conversationId: string | null;
  mode: ComposerTranslationMode;
  /** Idioma do lead (`conversationLanguageState().lang`). */
  targetLang: string | undefined;
  /** Texto do campo, como está (o hook apara). */
  text: string;
  /** `useAction(api.translation.preview)` no container; mock nos testes. */
  requestPreview: (args: { conversationId: string; text: string }) => Promise<PreviewResponse>;
  debounceMs?: number;
  capMs?: number;
  /** Cache próprio (testes); padrão = o compartilhado do módulo. */
  cache?: PreviewCache<PreviewResult>;
}

/**
 * Prévia viva da tradução no composer ("Revisar rápido"/"Revisar antes"): pede
 * `translation.preview` ~700 ms depois da última tecla, guarda num LRU e decide
 * o que o Enter envia (`decide`). Nunca trava o envio: prévia em voo espera no
 * máximo `capMs` e depois o texto digitado segue para o desvio do servidor.
 */
export function useComposerTranslation({
  conversationId,
  mode,
  targetLang,
  text,
  requestPreview,
  debounceMs = PREVIEW_DEBOUNCE_MS,
  capMs = PREVIEW_SEND_CAP_MS,
  cache = sharedCache,
}: UseComposerTranslationArgs) {
  const trimmed = text.trim();
  const keyFor = useCallback(
    (t: string) =>
      mode !== "off" && conversationId && targetLang && t ? previewCacheKey(conversationId, targetLang, t) : null,
    [mode, conversationId, targetLang]
  );
  const key = keyFor(trimmed);

  const errors = useRef(new Map<string, string>());
  const inflight = useRef(new Map<string, Promise<PreviewResult | null>>());
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState<string | undefined>(undefined);
  const [armed, setArmed] = useState(false);
  const [waitingSend, setWaitingSend] = useState(false);
  const requestRef = useRef(requestPreview);
  requestRef.current = requestPreview;

  const fetchPreview = useCallback(
    (k: string, t: string): Promise<PreviewResult | null> => {
      const cached = cache.get(k);
      if (cached) return Promise.resolve(cached);
      const running = inflight.current.get(k);
      if (running) return running;
      if (!conversationId || !targetLang) return Promise.resolve(null);
      const target = targetLang;
      const promise = requestRef
        .current({ conversationId, text: t })
        .then((res) => {
          const result = previewResultFrom(res, target);
          cache.set(k, result);
          errors.current.delete(k);
          return result;
        })
        .catch((e: unknown) => {
          errors.current.set(k, mutationErrorMessage(e, "Não foi possível traduzir agora."));
          return null;
        })
        .finally(() => {
          inflight.current.delete(k);
          bump();
        });
      inflight.current.set(k, promise);
      return promise;
    },
    [cache, conversationId, targetLang, bump]
  );

  // Texto novo: a edição e a confirmação do "Revisar antes" eram do anterior.
  useEffect(() => {
    setEditing(false);
    setEditedText(undefined);
    setArmed(false);
  }, [key]);

  // Debounce: só pede depois que o usuário para de digitar.
  useEffect(() => {
    if (!key || cache.get(key) || errors.current.has(key)) return;
    const timer = setTimeout(() => void fetchPreview(key, trimmed), debounceMs);
    return () => clearTimeout(timer);
    // `trimmed` acompanha `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, debounceMs, fetchPreview, cache]);

  const result: PreviewResult | null = key ? (cache.get(key) ?? null) : null;
  const errorMessage = key ? errors.current.get(key) : undefined;
  const view: ComposerPreviewView | null = !key
    ? null
    : result?.kind === "ready"
      ? { kind: "ready", text: result.text, targetLang: result.targetLang }
      : result?.kind === "skipped"
        ? { kind: "skipped", targetLang: result.targetLang }
        : errorMessage
          ? { kind: "error", message: errorMessage }
          : { kind: "loading" };

  /** O que o Enter (ou o botão) envia agora. Pode esperar a prévia em voo até `capMs`. */
  const decide = async (typed: string, opts: { untranslated?: boolean } = {}): Promise<SendPlan> => {
    const t = typed.trim();
    const k = keyFor(t);
    if (!k) return { kind: "plain" };
    if (opts.untranslated) return { kind: "untranslated" };
    if (mode === "strict" && !armed) {
      if (!cache.get(k) && !errors.current.has(k)) void fetchPreview(k, t);
      setArmed(true);
      return { kind: "confirm" };
    }
    let preview = cache.get(k) ?? null;
    if (!preview && !errors.current.has(k)) {
      setWaitingSend(true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        preview = await Promise.race([
          fetchPreview(k, t),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), capMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        setWaitingSend(false);
      }
    }
    return planTranslatedSend({ mode, typed: t, preview, editedText, strictArmed: true });
  };

  const edited =
    result?.kind === "ready" && editedText !== undefined && editedText.trim() !== "" && editedText.trim() !== result.text.trim();

  return {
    active: mode !== "off",
    view,
    result,
    editing,
    editedText,
    edited,
    armed,
    waitingSend,
    startEdit: () => {
      if (result?.kind !== "ready") return;
      setEditedText((prev) => prev ?? result.text);
      setEditing(true);
    },
    setEditedText,
    restoreTranslation: () => {
      setEditedText(undefined);
      setEditing(false);
    },
    decide,
    counterText: (typed: string) => textForCounter(typed, result, editedText),
  };
}

export type ComposerTranslation = ReturnType<typeof useComposerTranslation>;
