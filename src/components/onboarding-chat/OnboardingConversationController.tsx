import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OnboardingDraft } from "../../../convex/lib/onboardingDraft";
import { useOnboardingStream, type OnboardingTurnResult } from "@/hooks/useOnboardingStream";
import { buildTimeline, currentChips, type HistoryMessage, type PendingTurn } from "@/lib/onboardingChat";
import { clearOnboardingIntent, type OnboardingIntent } from "@/lib/onboardingIntent";
import { CopilotNote, IntentBubble } from "./ConversationIntro";
import { DraftPreviewPanel } from "./DraftPreviewPanel";
import { OnboardingChatView } from "./OnboardingChatView";
import { Button } from "@/components/ui/Button";
import { MATERIALS_NOTICE_TEXT } from "../../../convex/lib/onboardingBlocks";
import {
  UPLOAD_ERROR_MESSAGE,
  attachmentTurnLabel,
  gateForErrorCode,
  toStreamAttachment,
  type AttachmentDraft,
} from "@/lib/onboardingAttachments";
import type { OnboardingAttachment } from "@/lib/onboardingStream";
import { AttachmentSheet, type SubmitAttachmentResult, type UploadPhase } from "./attachments/AttachmentSheet";
import { VoiceSheet } from "./attachments/VoiceSheet";
import { OnboardingBlockView } from "./blocks/registry";
import type { BlockContext } from "./blocks/types";

export const WIZARD_HREF = "/app/configuracao-inicial";
export const HISTORY_PAGE = 30;

/** Chips da saudação (conversa nova, sem mensagem do hero): texto fixo do app. */
export const GREETING_CHIPS = [
  "Tenho uma imobiliária",
  "Tenho uma clínica",
  "Vendo serviços",
  "Tenho uma loja online",
] as const;

type PendingMeta = Pick<PendingTurn, "userText" | "baselineId" | "startedAt" | "attachmentLabel"> & { turnId: number };

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
  chatState: {
    stage: string | null;
    lastChips: readonly string[];
    /** E-mail confirmado (D2). Ausente = desconhecido: o servidor decide. */
    materialsUnlocked?: boolean;
    /** Ciência do aviso de materiais dada nesta sessão. Ausente = desconhecido. */
    materialsNoticeAcknowledged?: boolean;
  } | null;
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
  /**
   * Sobe um arquivo para o storage da org (`generateUploadUrl` + `saveFile`) e devolve o
   * `storageId`. Sem ela, clipe e microfone ficam desligados.
   */
  uploadFile?: (file: { blob: Blob; name: string; mimeType: string }, onPhase: (phase: "uploading" | "saving") => void) => Promise<string>;
  /** Bloco de conta/aviso mostrado quando um anexo precisa de e-mail confirmado ou de ciência. Padrão: o registro de blocos. */
  renderGateBlock?: (gate: "cartaoConta" | "avisoMateriais", ctx: BlockContext) => ReactNode;
  /** Injeções para teste. */
  fetchImpl?: typeof fetch;
  siteUrl?: string;
}

/** Último anexo que falhou (para "Tentar de novo" sem subir o arquivo outra vez). */
interface FailedAttachment {
  attachment: OnboardingAttachment;
  label: string;
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
  uploadFile,
  renderGateBlock,
  fetchImpl,
  siteUrl,
}: OnboardingConversationControllerProps) {
  const [composer, setComposer] = useState("");
  const [pendingMeta, setPendingMeta] = useState<PendingMeta | null>(null);
  const [lastFailedText, setLastFailedText] = useState<string | null>(null);
  const [failedAttachment, setFailedAttachment] = useState<FailedAttachment | null>(null);
  const [sheet, setSheet] = useState<"attach" | "voice" | null>(null);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>(null);
  // Anexo barrado ANTES de subir (sem e-mail confirmado / sem ciência): mostra o bloco e guarda o rascunho.
  const [blocked, setBlocked] = useState<{ gate: "cartaoConta" | "avisoMateriais"; draft: AttachmentDraft } | null>(null);
  const turnIdRef = useRef(0);

  const stream = useOnboardingStream({ organizationId, sessionId, token, onSession, fetchImpl, siteUrl });
  const { send: streamSend, isStreaming, turn, error: streamError, clearError } = stream;

  // Histórico ainda carregando conta como "não pronto": nada de saudação, chips nem envio.
  const ready = access.kind === "ready" && sessionId !== null && history.status !== "LoadingFirstPage" && !!token;

  // Lidos DEPOIS de um await (upload): o valor do render que criou o callback pode estar velho.
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const historyRef = useRef(history.results);
  historyRef.current = history.results;

  const runTurn = useCallback(
    (input: { text: string; attachment?: OnboardingAttachment; label?: string }): Promise<OnboardingTurnResult> | null => {
      const text = input.text.trim();
      const shown = input.attachment ? (input.label ?? "Anexo") : text;
      if (!shown || isStreamingRef.current || !readyRef.current) return null;
      const meta = input.attachment ? { userText: text, attachmentLabel: shown } : { userText: text };
      const turnId = ++turnIdRef.current;
      setLastFailedText(null);
      setFailedAttachment(null);
      setPendingMeta({ turnId, ...meta, baselineId: historyRef.current[0]?._id ?? null, startedAt: Date.now() });
      if (!input.attachment) setComposer("");
      return streamSend({ ...(text ? { text } : {}), ...(input.attachment ? { attachment: input.attachment } : {}) }).then((result) => {
        // Turno substituído por outro (ou desmontagem): o estado já é do seguinte.
        if (result === "failed" && turnIdRef.current === turnId) {
          setPendingMeta((cur) => (cur?.turnId === turnId ? null : cur));
          if (input.attachment) {
            setFailedAttachment({ attachment: input.attachment, label: shown });
          } else {
            setLastFailedText(text);
            // Devolve o texto ao campo para a pessoa não perder o que escreveu.
            setComposer((current) => (current.trim() ? current : text));
          }
        }
        return result;
      });
    },
    [streamSend]
  );

  /**
   * Começa um turno de texto. Devolve null quando NÃO começou (não pronto, turno em
   * andamento, texto vazio); senão a promessa do resultado.
   */
  // `ready` entra nas dependências de propósito: a mensagem do hero reenvia quando a conversa fica pronta.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const startTurn = useCallback((raw: string) => runTurn({ text: raw }), [runTurn, ready]);

  const send = useCallback((raw: string) => void startTurn(raw), [startTurn]);

  /**
   * Anexo da folha do clipe/microfone: arquivo sobe primeiro (fases para a folha),
   * depois vem o turno com o `storageId`. Um anexo por turno.
   */
  const submitAttachment = useCallback(
    async (draft: AttachmentDraft): Promise<SubmitAttachmentResult> => {
      if (isStreamingRef.current || !readyRef.current) {
        return { ok: false, message: "Espere o Copiloto terminar de responder para enviar." };
      }
      // Portões ANTES de subir qualquer arquivo (o servidor continua sendo a garantia).
      const closed =
        chatState?.materialsUnlocked === false
          ? "cartaoConta"
          : chatState?.materialsNoticeAcknowledged === false
            ? "avisoMateriais"
            : null;
      if (closed) {
        setBlocked({ gate: closed, draft });
        // Fecha a folha: o bloco certo aparece na conversa.
        return { ok: true };
      }
      setBlocked(null);
      let storageId: string | undefined;
      if (draft.kind !== "url") {
        if (!uploadFile) return { ok: false, message: UPLOAD_ERROR_MESSAGE };
        try {
          storageId = await uploadFile({ blob: draft.file, name: draft.name, mimeType: draft.mimeType }, setUploadPhase);
        } catch {
          return { ok: false, message: UPLOAD_ERROR_MESSAGE };
        } finally {
          setUploadPhase(null);
        }
      }
      // O upload demorou: o turno pode ter começado por outro caminho nesse meio tempo.
      if (isStreamingRef.current) return { ok: false, message: "Espere o Copiloto terminar de responder para enviar." };
      const started = runTurn({ text: "", attachment: toStreamAttachment(draft, storageId), label: attachmentTurnLabel(draft) });
      return started ? { ok: true } : { ok: false, message: "Não foi possível enviar agora. Tente de novo." };
    },
    [chatState?.materialsUnlocked, chatState?.materialsNoticeAcknowledged, uploadFile, runTurn]
  );

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
      ...(pendingMeta.attachmentLabel ? { attachmentLabel: pendingMeta.attachmentLabel } : {}),
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

  // Anexo recusado por conta/aviso: mostra o bloco certo (e "Enviar de novo") em vez do erro genérico.
  const gate = gateForErrorCode(streamError?.code) ?? blocked?.gate ?? null;
  const retryAttachment = failedAttachment
    ? () => void runTurn({ text: "", attachment: failedAttachment.attachment, label: failedAttachment.label })
    : blocked
      ? () => void submitAttachment(blocked.draft)
      : null;
  const gateCtx = { ...blockCtx, isLatest: true };
  const tail = gate ? (
    <div className="flex flex-col items-start gap-2">
      {renderGateBlock ? (
        renderGateBlock(gate, gateCtx)
      ) : (
        <OnboardingBlockView
          block={
            gate === "cartaoConta"
              ? { kind: "cartaoConta", emailVerified: false, materialsUnlocked: false }
              : { kind: "avisoMateriais", text: MATERIALS_NOTICE_TEXT, acknowledged: false }
          }
          ctx={gateCtx}
        />
      )}
      {retryAttachment && (
        <Button type="button" variant="secondary" size="sm" disabled={isStreaming} onClick={retryAttachment}>
          Enviar de novo
        </Button>
      )}
    </div>
  ) : null;
  const canAttach = !!uploadFile && access.kind === "ready" && ready && !isStreaming;

  const baseProps = {
    onAttach: canAttach ? () => setSheet("attach") : undefined,
    onMic: canAttach ? () => setSheet("voice") : undefined,
    tail,
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
    <>
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
      error={gate ? null : (streamError?.message ?? null)}
      onRetry={
        streamError?.code === "forbidden"
          ? undefined
          : retryAttachment && !gate
            ? retryAttachment
            : lastFailedText
              ? () => send(lastFailedText)
              : undefined
      }
      onDismissError={clearError}
      canLoadMore={history.status === "CanLoadMore"}
      loadingMore={history.status === "LoadingMore"}
      onLoadMore={() => history.loadMore(HISTORY_PAGE)}
      preview={preview}
    />
    <AttachmentSheet open={sheet === "attach"} onClose={() => setSheet(null)} onSubmit={submitAttachment} phase={uploadPhase} />
    <VoiceSheet open={sheet === "voice"} onClose={() => setSheet(null)} onSubmit={submitAttachment} phase={uploadPhase} />
    </>
  );
}

