import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { useOnboardingStream } from "@/hooks/useOnboardingStream";
import { mutationErrorMessage } from "@/lib/errors";
import { buildTimeline, currentChips, type HistoryMessage, type PendingTurn } from "@/lib/onboardingChat";
import { clearOnboardingIntent, type OnboardingIntent } from "@/lib/onboardingIntent";
import { writeSelectedOrgId } from "@/lib/selectedOrg";
import { CopilotNote, IntentBubble } from "./ConversationIntro";
import { DraftPreviewPanel } from "./DraftPreviewPanel";
import { OnboardingChatView } from "./OnboardingChatView";

export const WIZARD_HREF = "/app/configuracao-inicial";
const HISTORY_PAGE = 30;

/** Chips da saudação (conversa nova, sem mensagem do hero): texto fixo do app. */
export const GREETING_CHIPS = [
  "Tenho uma imobiliária",
  "Tenho uma clínica",
  "Vendo serviços",
  "Tenho uma loja online",
] as const;

type PendingMeta = Pick<PendingTurn, "userText" | "baselineId" | "startedAt">;

export interface OnboardingConversationProps {
  organizationId: Id<"organizations">;
  /** Mensagem guardada do hero: vira o primeiro turno quando a sessão abre. */
  intent: OnboardingIntent | null;
  /** A mensagem do hero foi enviada (quem guarda a intenção a descarta). */
  onIntentConsumed?: () => void;
  /** Conteúdo antes do histórico (ex.: seletor de organização). */
  orgPicker?: ReactNode;
}

/**
 * Conversa com org: abre a sessão (`getOrCreateSession`), retoma pelo histórico
 * (`listMessages` paginado + `getChatState`), envia turnos pelo SSE
 * (`useOnboardingStream`) e mostra a prévia do rascunho (`getSession`).
 */
export function OnboardingConversation({ organizationId, intent, onIntentConsumed, orgPicker }: OnboardingConversationProps) {
  const { can, isLoading: permsLoading } = usePermissions(organizationId);
  const canManage = can("settings", "manage");
  const getOrCreateSession = useMutation(api.onboardingSessions.getOrCreateSession);
  const token = useAuthToken();

  const [sessionId, setSessionId] = useState<Id<"onboardingSessions"> | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [pendingMeta, setPendingMeta] = useState<PendingMeta | null>(null);
  const [lastFailedText, setLastFailedText] = useState<string | null>(null);

  // Abre (ou cria) a sessão uma vez por org.
  const openedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (permsLoading || !canManage || openedForRef.current === organizationId) return;
    openedForRef.current = organizationId;
    setSessionId(null);
    setSessionError(null);
    getOrCreateSession({ organizationId })
      .then((s) => setSessionId(s._id))
      .catch((err) => setSessionError(mutationErrorMessage(err, "Não foi possível abrir a conversa. Recarregue a página.")));
  }, [organizationId, permsLoading, canManage, getOrCreateSession]);

  const ready = sessionId !== null;
  const chatState = useQuery(api.onboardingChat.getChatState, ready ? { organizationId } : "skip");
  const session = useQuery(api.onboardingSessions.getSession, ready ? { organizationId } : "skip");
  const history = usePaginatedQuery(
    api.onboardingChat.listMessages,
    sessionId ? { organizationId, sessionId } : "skip",
    { initialNumItems: HISTORY_PAGE }
  );

  const stream = useOnboardingStream({
    organizationId,
    sessionId,
    token: token ?? null,
    onSession: (id) => setSessionId(id as Id<"onboardingSessions">),
  });

  const historyRef = useRef<readonly HistoryMessage[]>([]);
  historyRef.current = history.results as readonly HistoryMessage[];

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || stream.isStreaming || !sessionId) return;
      setLastFailedText(null);
      setPendingMeta({ userText: text, baselineId: historyRef.current[0]?._id ?? null, startedAt: Date.now() });
      setComposer("");
      const ok = await stream.send({ text });
      if (!ok) {
        setPendingMeta(null);
        setLastFailedText(text);
        // Devolve o texto ao campo para a pessoa não perder o que escreveu.
        setComposer((current) => (current.trim() ? current : text));
      }
    },
    [stream, sessionId]
  );

  // Mensagem do hero: primeiro turno assim que a sessão e o histórico carregam (uma vez).
  const intentSentRef = useRef(false);
  const historyLoaded = history.status !== "LoadingFirstPage";
  useEffect(() => {
    if (intentSentRef.current || !sessionId || !historyLoaded || !intent?.message) return;
    intentSentRef.current = true;
    clearOnboardingIntent();
    onIntentConsumed?.();
    void send(intent.message);
  }, [sessionId, historyLoaded, intent, send, onIntentConsumed]);

  const pending: PendingTurn | null = useMemo(() => {
    if (!pendingMeta) return null;
    const t = stream.turn;
    return {
      ...pendingMeta,
      replyText: t?.replyText ?? "",
      blocks: t?.blocks ?? [],
      chips: t?.chips ?? [],
      status: t?.status ?? null,
      ...(t?.audio ? { audio: t.audio } : {}),
      streaming: stream.isStreaming,
    };
  }, [pendingMeta, stream.turn, stream.isStreaming]);

  const timeline = useMemo(
    () => buildTimeline(history.results as readonly HistoryMessage[], pending),
    [history.results, pending]
  );

  const blockCtx = useMemo(
    () => ({ organizationId, sessionId, sendText: (t: string) => void send(t), busy: stream.isStreaming }),
    [organizationId, sessionId, send, stream.isStreaming]
  );

  const stage = stream.turn?.done?.nextStage ?? session?.stage ?? chatState?.stage ?? "interview";
  const preview = <DraftPreviewPanel draft={session?.draft ?? null} />;
  const onPreferForm = () => writeSelectedOrgId(organizationId);
  const loadingIntent = intent?.message && !intentSentRef.current ? intent.message : null;

  const baseProps = {
    formHref: WIZARD_HREF,
    onPreferForm,
    composerValue: composer,
    onComposerChange: setComposer,
    onSubmit: (t: string) => void send(t),
    onChip: (t: string) => void send(t),
    blockCtx,
  };

  if (permsLoading || (canManage && !ready && !sessionError)) {
    return (
      <OnboardingChatView
        {...baseProps}
        stage="interview"
        intro={
          <>
            {orgPicker}
            {loadingIntent && <IntentBubble message={loadingIntent} />}
          </>
        }
        timeline={[]}
        typing
        chips={[]}
        composerDisabled
        composerPlaceholder="Abrindo a conversa…"
        preview={preview}
      />
    );
  }

  if (!canManage || sessionError) {
    return (
      <OnboardingChatView
        {...baseProps}
        stage="interview"
        intro={
          <>
            {orgPicker}
            <CopilotNote>
              {sessionError ??
                "Só quem administra a organização pode montar a operação por aqui. Peça a um administrador ou abra o CRM."}
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

  const isEmpty = timeline.length === 0 && !pending;
  const chips = currentChips(timeline, isEmpty ? [...GREETING_CHIPS] : (chatState?.lastChips ?? []));
  const turnText = stream.turn?.replyText ?? "";

  return (
    <OnboardingChatView
      {...baseProps}
      stage={stage}
      intro={
        <>
          {orgPicker}
          {isEmpty && !intent?.message && (
            <CopilotNote>
              Oi! Vou montar o seu CRM com você em poucos minutos. Me conta: o que a sua empresa vende e como você atende os
              clientes hoje?
            </CopilotNote>
          )}
        </>
      }
      timeline={timeline}
      typing={stream.isStreaming}
      status={stream.turn?.status}
      showTypingBubble={stream.isStreaming && !turnText}
      chips={chips}
      error={stream.error?.message ?? null}
      onRetry={lastFailedText && stream.error?.code !== "forbidden" ? () => void send(lastFailedText) : undefined}
      onDismissError={stream.clearError}
      canLoadMore={history.status === "CanLoadMore"}
      loadingMore={history.status === "LoadingMore"}
      onLoadMore={() => history.loadMore(HISTORY_PAGE)}
      preview={preview}
    />
  );
}
