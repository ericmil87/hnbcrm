import { useCallback, useEffect, useRef, useState } from "react";
import {
  convexSiteUrl,
  onboardingErrorMessage,
  runOnboardingTurnRequest,
  type OnboardingAttachment,
  type OnboardingEvent,
  type OnboardingReplyAudio,
  type OnboardingStreamEvent,
  type OnboardingTurnError,
} from "@/lib/onboardingStream";

/** Estado do turno em andamento (o mais recente). */
export interface OnboardingStreamTurn {
  replyText: string;
  blocks: Record<string, unknown>[];
  chips: string[];
  /** Último `status` ("Lendo o site…"); some quando chega texto. */
  status: string | null;
  audio: OnboardingReplyAudio | null;
  draft: { version: number; hash: string } | null;
  /** `done` recebido. */
  done: { nextStage: string | null; askForMaterials: boolean } | null;
  error: OnboardingTurnError | null;
}

export interface SendOnboardingTurnInput {
  text?: string;
  attachment?: OnboardingAttachment;
  /** Evento de cartão (sem LLM, sem mensagem da pessoa); exclusivo com `text`/`attachment`. */
  event?: OnboardingEvent;
}

/**
 * Resultado de `send`:
 * - `ok`: o turno chegou ao `done` (mesmo que a espera do áudio tenha sido abortada depois);
 * - `failed`: não começou ou terminou com erro (`error` preenchido quando houve erro);
 * - `superseded`: abortado antes do `done` por um turno novo, `abort()` ou desmontagem.
 *   Quem chamou NÃO deve desfazer nada: o estado já é do turno seguinte.
 */
export type OnboardingTurnResult = "ok" | "failed" | "superseded";

export interface UseOnboardingStreamOptions {
  organizationId: string | null;
  sessionId?: string | null;
  /** JWT do Convex Auth (`useAuthToken()`); null = sem login (`unauthenticated`, sem rede). */
  token: string | null;
  /** Sessão resolvida pelo servidor (evento `session`). */
  onSession?: (sessionId: string) => void;
  /** Injeções para teste. */
  fetchImpl?: typeof fetch;
  siteUrl?: string;
}

export interface UseOnboardingStreamResult {
  turn: OnboardingStreamTurn | null;
  /** Antes do `done`: a entrada fica travada. */
  isStreaming: boolean;
  /** Depois do `done`, a conexão segue aberta esperando um possível `audio`. */
  awaitingAudio: boolean;
  error: OnboardingTurnError | null;
  /**
   * Envia um turno. Um turno ainda aberto (esperando áudio) é abortado; com um
   * turno antes do `done`, a chamada é ignorada (`false`). Nunca reconecta sozinho.
   */
  send: (input: SendOnboardingTurnInput) => Promise<OnboardingTurnResult>;
  abort: () => void;
  clearError: () => void;
}

const emptyTurn = (): OnboardingStreamTurn => ({
  replyText: "",
  blocks: [],
  chips: [],
  status: null,
  audio: null,
  draft: null,
  done: null,
  error: null,
});

/**
 * Cliente do SSE `POST /api/onboarding/stream` (mesmo padrão de autenticação do
 * `useCopilotStream`: `Authorization: Bearer <JWT do Convex Auth>`). Parsing e
 * erros em `src/lib/onboardingStream.ts`. Aborta ao desmontar; `audio` depois
 * do `done` é aceito (a conexão só fecha quando o servidor fecha).
 */
export function useOnboardingStream(options: UseOnboardingStreamOptions): UseOnboardingStreamResult {
  const { organizationId, sessionId = null, token, fetchImpl, siteUrl } = options;
  const [turn, setTurn] = useState<OnboardingStreamTurn | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [awaitingAudio, setAwaitingAudio] = useState(false);
  const [error, setError] = useState<OnboardingTurnError | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const mountedRef = useRef(true);
  const onSessionRef = useRef(options.onSession);
  onSessionRef.current = options.onSession;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Aborta depois de uma microtarefa: no StrictMode o efeito é desmontado e
      // remontado na hora, e o turno já iniciado não pode morrer por isso.
      const pending = controllerRef.current;
      queueMicrotask(() => {
        if (mountedRef.current || controllerRef.current !== pending) return;
        pending?.abort();
        controllerRef.current = null;
      });
    };
  }, []);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    streamingRef.current = false;
    setIsStreaming(false);
    setAwaitingAudio(false);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const send = useCallback(
    async (input: SendOnboardingTurnInput): Promise<OnboardingTurnResult> => {
      const text = input.text?.trim() ?? "";
      if (input.event && (text || input.attachment)) return "failed";
      if (!text && !input.attachment && !input.event) return "failed";
      if (streamingRef.current) return "failed";
      if (!organizationId) return "failed";
      if (!token) {
        const err: OnboardingTurnError = { code: "unauthenticated", message: onboardingErrorMessage("unauthenticated") };
        setError(err);
        return "failed";
      }
      // Turno anterior ainda aberto só pelo áudio: encerra (o histórico traz o áudio depois).
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      streamingRef.current = true;
      setIsStreaming(true);
      setAwaitingAudio(false);
      setError(null);
      setTurn(emptyTurn());

      // Só o controller decide se o turno ainda é o atual (a desmontagem aborta por ele).
      const isCurrent = () => controllerRef.current === controller;
      let gotDone = false;
      const apply = (fn: (t: OnboardingStreamTurn) => OnboardingStreamTurn) => {
        if (isCurrent()) setTurn((prev) => fn(prev ?? emptyTurn()));
      };

      const onEvent = (event: OnboardingStreamEvent) => {
        switch (event.type) {
          case "session":
            if (isCurrent()) onSessionRef.current?.(event.sessionId);
            break;
          case "status":
            apply((t) => ({ ...t, status: event.text }));
            break;
          case "delta":
            apply((t) => ({ ...t, status: null, replyText: t.replyText + event.text }));
            break;
          case "block":
            apply((t) => ({ ...t, blocks: [...t.blocks, event.block] }));
            break;
          case "chips":
            apply((t) => ({ ...t, chips: event.chips }));
            break;
          case "draft":
            apply((t) => ({ ...t, draft: { version: event.version, hash: event.hash } }));
            break;
          case "done":
            apply((t) => ({ ...t, status: null, done: { nextStage: event.nextStage, askForMaterials: event.askForMaterials } }));
            break;
          case "audio":
            apply((t) => ({ ...t, audio: { url: event.url, durationSec: event.durationSec, mimeType: event.mimeType } }));
            break;
          case "error":
            apply((t) => ({ ...t, status: null, error: { code: event.code, message: event.message } }));
            break;
        }
      };

      const outcome = await runOnboardingTurnRequest({
        fetchImpl: fetchImpl ?? ((...args) => fetch(...args)),
        siteUrl: siteUrl ?? convexSiteUrl(import.meta.env.VITE_CONVEX_URL as string | undefined),
        token,
        body: {
          organizationId,
          ...(sessionRef.current ? { sessionId: sessionRef.current } : {}),
          ...(text ? { text } : {}),
          ...(input.attachment ? { attachment: input.attachment } : {}),
          ...(input.event ? { event: input.event } : {}),
        },
        signal: controller.signal,
        onEvent,
        onDone: () => {
          gotDone = true;
          // Destrava a entrada sem esperar o TTS; a leitura continua por um `audio`.
          if (!isCurrent()) return;
          streamingRef.current = false;
          setIsStreaming(false);
          setAwaitingAudio(true);
        },
      });

      if (outcome.ok || gotDone) {
        if (isCurrent()) {
          controllerRef.current = null;
          setAwaitingAudio(false);
        }
        return "ok";
      }
      if (!isCurrent()) return "superseded";
      controllerRef.current = null;
      streamingRef.current = false;
      setIsStreaming(false);
      setAwaitingAudio(false);
      if ("error" in outcome) {
        setError(outcome.error);
        setTurn((prev) => ({ ...(prev ?? emptyTurn()), status: null, error: outcome.error }));
        return "failed";
      }
      return "superseded";
    },
    [organizationId, token, fetchImpl, siteUrl]
  );

  return { turn, isStreaming, awaitingAudio, error, send, abort, clearError };
}
