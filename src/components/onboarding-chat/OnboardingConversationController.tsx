import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OnboardingDraft } from "../../../convex/lib/onboardingDraft";
import { useOnboardingStream, type OnboardingTurnResult } from "@/hooks/useOnboardingStream";
import { buildTimeline, currentChips, type HistoryMessage, type PendingTurn } from "@/lib/onboardingChat";
import { clearOnboardingIntent, type OnboardingIntent } from "@/lib/onboardingIntent";
import { CopilotNote, IntentBubble } from "./ConversationIntro";
import { DraftPreviewPanel } from "./DraftPreviewPanel";
import { OnboardingChatView } from "./OnboardingChatView";

export const WIZARD_HREF = "/app/configuracao-inicial";
export const HISTORY_PAGE = 30;

/** Chips da saudação (conversa nova, sem mensagem do hero): texto fixo do app. */
export const GREETING_CHIPS = [
  "Tenho uma imobiliária",
  "Tenho uma clínica",
  "Vendo serviços",
  "Tenho uma loja online",
] as const;

type PendingMeta = Pick<PendingTurn, "userText" | "baselineId" | "startedAt"> & { turnId: number };

export type ConversationAccess = { kind: "loading" } | { kind: "ready" } | { kind: "forbidden" } | { kind: "error"; message: string };

export interface ConversationHistory {
  /** Mais NOVO primeiro (como `listMessages`). */
  results: readonly HistoryMessage[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (numItems: number) => void;
}

export interface OnboardingConversationControllerProps {
  organizationId: string;
  /** Permissão e abertura da sessão (o container resolve). */
  access: ConversationAccess;
  sessionId: string | null;
  history: ConversationHistory;
  /** Etapa gravada na sessão (`getSession().stage`): a fonte de verdade. */
  sessionStage: string | null;
  /** `getChatState` (etapa de reserva e últimos chips). */
  chatState: { stage: string | null; lastChips: readonly string[] } | null;
  draft: OnboardingDraft | null;
  token: string | null;
  /** Mensagem guardada do hero: vira o primeiro turno quando a conversa está pronta. */
  intent: OnboardingIntent | null;
  /** A mensagem do hero COMEÇOU a ser enviada (quem guarda a intenção a descarta). */
  onIntentConsumed?: () => void;
  onSession?: (sessionId: string) => void;
  onPreferForm?: () => void;
  /** Conteúdo antes do histórico (ex.: seletor de organização). */
  orgPicker?: ReactNode;
  /** Injeções para teste. */
  fetchImpl?: typeof fetch;
  siteUrl?: string;
}

/**
 * Conversa com org, sem Convex (o container `OnboardingConversation` liga as
 * queries): envia turnos pelo SSE, junta histórico e turno em andamento, manda
 * a mensagem do hero uma vez e só desfaz um turno que falhou se ele ainda for
 * o atual (`turnIdRef`).
 */
export function OnboardingConversationController({
  organizationId,
  access,
  sessionId,
  history,
  sessionStage,
  chatState,
  draft,
  token,
  intent,
  onIntentConsumed,
  onSession,
  onPreferForm,
  orgPicker,
  fetchImpl,
  siteUrl,
}: OnboardingConversationControllerProps) {
  const [composer, setComposer] = useState("");
  const [pendingMeta, setPendingMeta] = useState<PendingMeta | null>(null);
  const [lastFailedText, setLastFailedText] = useState<string | null>(null);
  const turnIdRef = useRef(0);

  const stream = useOnboardingStream({ organizationId, sessionId, token, onSession, fetchImpl, siteUrl });
  const { send: streamSend, isStreaming, turn, error: streamError, clearError } = stream;

  // Histórico ainda carregando conta como "não pronto": nada de saudação, chips nem envio.
  const ready = access.kind === "ready" && sessionId !== null && history.status !== "LoadingFirstPage" && !!token;

  const historyRef = useRef(history.results);
  historyRef.current = history.results;

  /**
   * Começa um turno. Devolve null quando NÃO começou (não pronto, turno em
   * andamento, texto vazio); senão a promessa do resultado.
   */
  const startTurn = useCallback(
    (raw: string): Promise<OnboardingTurnResult> | null => {
      const text = raw.trim();
      if (!text || isStreaming || !ready) return null;
      const turnId = ++turnIdRef.current;
      setLastFailedText(null);
      setPendingMeta({ turnId, userText: text, baselineId: historyRef.current[0]?._id ?? null, startedAt: Date.now() });
      setComposer("");
      return streamSend({ text }).then((result) => {
        // Turno substituído por outro (ou desmontagem): o estado já é do seguinte.
        if (result === "failed" && turnIdRef.current === turnId) {
          setPendingMeta((cur) => (cur?.turnId === turnId ? null : cur));
          setLastFailedText(text);
          // Devolve o texto ao campo para a pessoa não perder o que escreveu.
          setComposer((current) => (current.trim() ? current : text));
        }
        return result;
      });
    },
    [streamSend, isStreaming, ready]
  );

  const send = useCallback((raw: string) => void startTurn(raw), [startTurn]);

  // Mensagem do hero: primeiro turno quando a conversa fica pronta. Só marca
  // como enviada (e apaga a intenção) depois que o envio COMEÇOU.
  const intentSentRef = useRef(false);
  useEffect(() => {
    if (intentSentRef.current || !intent?.message) return;
    const started = startTurn(intent.message);
    if (!started) return;
    intentSentRef.current = true;
    clearOnboardingIntent();
    onIntentConsumed?.();
  }, [intent, startTurn, onIntentConsumed]);

  const pending: PendingTurn | null = useMemo(() => {
    if (!pendingMeta) return null;
    return {
      userText: pendingMeta.userText,
      baselineId: pendingMeta.baselineId,
      startedAt: pendingMeta.startedAt,
      replyText: turn?.replyText ?? "",
      blocks: turn?.blocks ?? [],
      chips: turn?.chips ?? [],
      status: turn?.status ?? null,
      ...(turn?.audio ? { audio: turn.audio } : {}),
      streaming: isStreaming,
    };
  }, [pendingMeta, turn, isStreaming]);

  const timeline = useMemo(() => buildTimeline(history.results, pending), [history.results, pending]);

  // Estável entre deltas: os blocos não re-renderizam a cada pedaço de texto.
  const blockCtx = useMemo(
    () => ({ organizationId, sessionId, sendText: send, busy: isStreaming }),
    [organizationId, sessionId, send, isStreaming]
  );

  const stage = sessionStage ?? turn?.done?.nextStage ?? chatState?.stage ?? "interview";
  const preview = <DraftPreviewPanel draft={draft} ctx={blockCtx} />;
  const pendingIntent = intent?.message && !intentSentRef.current ? intent.message : null;

  const baseProps = {
    formHref: WIZARD_HREF,
    onPreferForm,
    composerValue: composer,
    onComposerChange: setComposer,
    onSubmit: send,
    onChip: send,
    blockCtx,
  };

  if (access.kind === "forbidden" || access.kind === "error") {
    return (
      <OnboardingChatView
        {...baseProps}
        stage="interview"
        intro={
          <>
            {orgPicker}
            <CopilotNote>
              {access.kind === "error"
                ? access.message
                : "Só quem administra a organização pode montar a operação por aqui. Peça a um administrador ou abra o CRM."}
            </CopilotNote>
          </>
        }
        timeline={[]}
        typing={false}
        chips={[]}
        composerDisabled
        composerPlaceholder="Conversa indisponível"
      />
    );
  }

  if (!ready && !pendingMeta) {
    return (
      <OnboardingChatView
        {...baseProps}
        stage={sessionStage ?? "interview"}
        intro={
          <>
            {orgPicker}
            {pendingIntent && <IntentBubble message={pendingIntent} />}
          </>
        }
        timeline={timeline}
        typing
        chips={[]}
        composerDisabled
        composerPlaceholder="Abrindo a conversa…"
        preview={preview}
      />
    );
  }

  const isEmpty = timeline.length === 0 && !pending;
  const chips = currentChips(timeline, isEmpty ? [...GREETING_CHIPS] : (chatState?.lastChips ?? []));
  const turnText = turn?.replyText ?? "";

  return (
    <OnboardingChatView
      {...baseProps}
      stage={stage}
      intro={
        <>
          {orgPicker}
          {isEmpty && !pendingIntent && (
            <CopilotNote>
              Oi! Vou montar o seu CRM com você em poucos minutos. Me conta: o que a sua empresa vende e como você atende os
              clientes hoje?
            </CopilotNote>
          )}
        </>
      }
      timeline={timeline}
      typing={isStreaming}
      status={turn?.status}
      showTypingBubble={isStreaming && !turnText}
      chips={chips}
      error={streamError?.message ?? null}
      onRetry={lastFailedText && streamError?.code !== "forbidden" ? () => send(lastFailedText) : undefined}
      onDismissError={clearError}
      canLoadMore={history.status === "CanLoadMore"}
      loadingMore={history.status === "LoadingMore"}
      onLoadMore={() => history.loadMore(HISTORY_PAGE)}
      preview={preview}
    />
  );
}
