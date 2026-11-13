import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OnboardingDraft } from "../../../convex/lib/onboardingDraft";
import { coherentChips, type ApprovalSection, type RoadmapFacts } from "../../../convex/lib/onboardingRoadmap";
import { useOnboardingStream, type OnboardingTurnResult } from "@/hooks/useOnboardingStream";
import {
  blockKindOf,
  plainModelText,
  buildTimeline,
  CRM_HOME_HREF,
  chatProgress,
  currentChips,
  isBareEmailCode,
  nextStepFor,
  nextStepMode,
  timelineHasCard,
  pendingFileDrain,
  shouldProcessPending,
  type HistoryMessage,
  type PendingTurn,
} from "@/lib/onboardingChat";
import { confirmResultMessage, markNotifiedOnce, type ConfirmReason } from "@/lib/onboardingAccount";
import { clearOnboardingIntent, type OnboardingIntent } from "@/lib/onboardingIntent";
import { CopilotNote, IntentBubble } from "./ConversationIntro";
import { DraftPreviewPanel } from "./DraftPreviewPanel";
import { OnboardingChatView } from "./OnboardingChatView";
import type { NextStepBarProps } from "./NextStepBar";
import { Button } from "@/components/ui/Button";
import { MATERIALS_NOTICE_TEXT } from "../../../convex/lib/onboardingBlocks";
import {
  UPLOAD_ERROR_MESSAGE,
  attachmentTurnLabel,
  gateForErrorCode,
  toStreamAttachment,
  type AttachmentDraft,
} from "@/lib/onboardingAttachments";
import { onboardingEventKey, type OnboardingAttachment, type OnboardingEvent } from "@/lib/onboardingStream";
import { AttachmentSheet, type SubmitAttachmentResult, type UploadPhase } from "./attachments/AttachmentSheet";
import { VoiceSheet } from "./attachments/VoiceSheet";
import { RestartConversationDialog } from "./RestartConversationDialog";
import { revealInScroller, scrollParentOf } from "@/lib/onboardingScroll";
import { OnboardingBlockView } from "./blocks/registry";
import type { BlockContext, LiveFacts } from "./blocks/types";

export const WIZARD_HREF = "/app/configuracao-inicial";
/** Saída da conversa para o CRM (organização já existe neste ponto). */
export const APP_HREF = CRM_HOME_HREF;
export const HISTORY_PAGE = 30;

/** Chips da conversa VAZIA (sem mensagem do hero): neutros e úteis para qualquer negócio. */
export const GREETING_CHIPS = ["Vendo serviços", "Tenho uma loja", "Tenho uma clínica", "Trabalho com turismo"] as const;

type PendingMeta = Pick<PendingTurn, "userText" | "baselineId" | "startedAt" | "attachmentLabel"> & { turnId: number };

export type ConversationAccess = { kind: "loading" } | { kind: "ready" } | { kind: "forbidden" } | { kind: "error"; message: string };

export interface ConversationHistory {
  /** Mais NOVO primeiro (como `listMessages`). */
  results: readonly HistoryMessage[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (numItems: number) => void;
}

/** `getChatState` (fatos vivos da sessão; o que o servidor ainda não manda fica ausente = desconhecido). */
export interface ChatStateFacts {
  stage: string | null;
  lastChips: readonly string[];
  /** E-mail confirmado (D2). Ausente = desconhecido: o servidor decide. */
  materialsUnlocked?: boolean;
  /** Ciência do aviso de materiais dada nesta sessão. Ausente = desconhecido. */
  materialsNoticeAcknowledged?: boolean;
  emailVerified?: boolean;
  maskedEmail?: string | null;
  /** Materiais guardados no servidor à espera da confirmação do e-mail. */
  pendingMaterials?: number;
  approvals?: Partial<Record<ApprovalSection, string>>;
  /** Etapa mais avançada já alcançada (a barra nunca regride). */
  reachedStep?: number;
  aiActive?: boolean;
  applied?: boolean;
  tested?: boolean;
  connected?: boolean;
  /** A operação já foi montada por uma conversa anterior (recomeçada). */
  priorApplied?: boolean;
}

export interface TestScreenRenderProps {
  /** Perguntas sugeridas do segmento (do cartão final do servidor). */
  suggestions: string[];
  onClose: () => void;
  /** "Está bom, conectar o WhatsApp": fecha e abre a conexão no cartão final. */
  onConnect: () => void;
  /** Primeira resposta da IA no teste (marca o passo como feito; NÃO fecha a tela). */
  onTested: () => void;
  tested: boolean;
  connected: boolean;
}

/** Resultado de "Recomeçar a conversa" (o container chama `restartConversation`). */
export type RestartResult = { ok: true } | { ok: false; message: string };

export interface OnboardingConversationControllerProps {
  organizationId: string;
  /** Permissão e abertura da sessão (o container resolve). */
  access: ConversationAccess;
  sessionId: string | null;
  history: ConversationHistory;
  chatState: ChatStateFacts | null;
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
  /**
   * Confirma o código de e-mail digitado direto no campo de mensagem (exatamente 6 dígitos com o
   * e-mail por confirmar). Sem ela, os 6 dígitos seguem como uma mensagem comum.
   */
  confirmEmailCode?: (code: string) => Promise<{ verified: boolean; reason?: ConfirmReason; attemptsLeft?: number }>;
  /** Bloco de conta/aviso mostrado quando um anexo precisa de e-mail confirmado ou de ciência. Padrão: o registro de blocos. */
  renderGateBlock?: (gate: "cartaoConta" | "avisoMateriais", ctx: BlockContext) => ReactNode;
  /** Cartão compacto do código de e-mail no começo da conversa. Padrão: o registro de blocos. */
  renderEmailCard?: (ctx: BlockContext) => ReactNode;
  /**
   * "Recomeçar a conversa" (menu do cabeçalho, com confirmação). O container arquiva a sessão e
   * troca o `sessionId` (a conversa remonta na saudação). Sem ela, o menu não aparece.
   */
  onRestart?: () => Promise<RestartResult>;
  /** Foca o campo de mensagem quando a conversa ficar pronta (depois de recomeçar). */
  focusComposerOnReady?: boolean;
  /**
   * Tela dedicada de teste da IA (o container liga o simulador). Fica na conversa, fora das
   * mensagens: nenhuma mensagem nova (inclusive a do `tested`) a fecha. Sem ela, o teste fica no cartão.
   */
  renderTestScreen?: (p: TestScreenRenderProps) => ReactNode;
  /** Injeções para teste. */
  fetchImpl?: typeof fetch;
  siteUrl?: string;
}

/** Último anexo que falhou (para "Tentar de novo" sem subir o arquivo outra vez). */
interface FailedAttachment {
  attachment: OnboardingAttachment;
  label: string;
}

/** Arquivo guardado em memória até o e-mail ser confirmado (o servidor recusa arquivo antes disso). */
interface QueuedFile {
  id: number;
  draft: Exclude<AttachmentDraft, { kind: "url" }>;
}

function fileLabel(draft: AttachmentDraft): string {
  return draft.kind === "url" ? "o link" : draft.kind === "audio" ? "o áudio gravado" : draft.name;
}

/** Rola até o cartão mais recente de um tipo (o da última mensagem, a mais abaixo). */
function latestCardNode(kind: string | null): HTMLElement | null {
  if (!kind || typeof document === "undefined") return null;
  const nodes = document.querySelectorAll<HTMLElement>(`[data-onboarding-card="${kind}"]`);
  return nodes[nodes.length - 1] ?? null;
}

/**
 * Rola até o cartão mais recente de um tipo (o topo à vista) e o destaca por um instante (anel; o
 * pulso só sem movimento reduzido). Devolve se achou o cartão.
 */
function goToCard(kind: string | null): boolean {
  const node = latestCardNode(kind);
  if (!node) return false;
  revealInScroller(node);
  node.dataset.highlight = "on";
  window.setTimeout(() => {
    if (node.dataset.highlight === "on") delete node.dataset.highlight;
  }, 1600);
  return true;
}

/**
 * Conversa com org, sem Convex (o container `OnboardingConversation` liga as
 * queries): envia turnos E eventos de cartão pelo SSE, junta histórico e turno
 * em andamento, manda a mensagem do hero uma vez, guarda arquivos em memória
 * até o e-mail ser confirmado, e mantém sempre à vista o botão do próximo passo.
 */
export function OnboardingConversationController({
  organizationId,
  access,
  sessionId,
  history,
  chatState,
  draft,
  token,
  intent,
  onIntentConsumed,
  onSession,
  onPreferForm,
  orgPicker,
  uploadFile,
  confirmEmailCode,
  renderGateBlock,
  renderEmailCard,
  onRestart,
  focusComposerOnReady = false,
  renderTestScreen,
  fetchImpl,
  siteUrl,
}: OnboardingConversationControllerProps) {
  const [composer, setComposer] = useState("");
  const [pendingMeta, setPendingMeta] = useState<PendingMeta | null>(null);
  const [lastFailedText, setLastFailedText] = useState<string | null>(null);
  const [lastFailedEvent, setLastFailedEvent] = useState<OnboardingEvent | null>(null);
  const [failedAttachment, setFailedAttachment] = useState<FailedAttachment | null>(null);
  const [sheet, setSheet] = useState<"attach" | "voice" | null>(null);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>(null);
  // Anexo barrado ANTES de subir (sem ciência do aviso): mostra o bloco e guarda o rascunho.
  const [retryState, setRetryState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [blocked, setBlocked] = useState<{ gate: "cartaoConta" | "avisoMateriais"; draft: AttachmentDraft } | null>(null);
  const [queuedFiles, setQueuedFiles] = useState<QueuedFile[]>([]);
  const [drainTick, setDrainTick] = useState(0);
  const [localNotes, setLocalNotes] = useState<Array<{ id: number; text: string }>>([]);
  const turnIdRef = useRef(0);
  const noteIdRef = useRef(0);
  const queueIdRef = useRef(0);

  const stream = useOnboardingStream({ organizationId, sessionId, token, onSession, fetchImpl, siteUrl });
  const { send: streamSend, isStreaming, turn, error: streamError, clearError, abort: abortStream } = stream;

  // Histórico ainda carregando conta como "não pronto": nada de saudação, chips nem envio.
  const ready = access.kind === "ready" && sessionId !== null && history.status !== "LoadingFirstPage" && !!token;

  // Lidos DEPOIS de um await (upload): o valor do render que criou o callback pode estar velho.
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const historyRef = useRef(history.results);
  historyRef.current = history.results;

  const addNote = useCallback((text: string) => setLocalNotes((cur) => [...cur, { id: ++noteIdRef.current, text }]), []);

  // ── Fatos vivos ───────────────────────────────────────────────────────────
  const emailVerified = chatState?.emailVerified ?? chatState?.materialsUnlocked ?? true;
  const noticeOk = chatState?.materialsNoticeAcknowledged !== false;
  const pendingMaterials = chatState?.pendingMaterials ?? 0;
  const facts: LiveFacts = useMemo(
    () => ({
      draft,
      approvals: chatState?.approvals ?? {},
      aiActive: chatState?.aiActive ?? false,
      applied: chatState?.applied ?? false,
      tested: chatState?.tested ?? false,
      connected: chatState?.connected ?? false,
      emailVerified,
      maskedEmail: chatState?.maskedEmail ?? null,
      pendingMaterials,
      priorApplied: chatState?.priorApplied ?? false,
    }),
    [
      chatState?.priorApplied,
      draft,
      chatState?.approvals,
      chatState?.aiActive,
      chatState?.applied,
      chatState?.tested,
      chatState?.connected,
      chatState?.maskedEmail,
      emailVerified,
      pendingMaterials,
    ]
  );
  const roadmapFacts: RoadmapFacts = useMemo(() => ({ ...facts, reachedStep: chatState?.reachedStep }), [facts, chatState?.reachedStep]);

  // A barra NUNCA regride: o servidor guarda `reachedStep` e a tela guarda o maior já visto.
  const seenRef = useRef(0);
  const progress = chatProgress(roadmapFacts, seenRef.current);
  seenRef.current = Math.max(seenRef.current, progress.index);

  // Visto "e-mail por confirmar" nesta sessão: o cartão compacto do começo fica (depois como linha de sucesso).
  const emailIntroRef = useRef(false);
  if (emailVerified === false) emailIntroRef.current = true;

  // ── Envio de turnos e eventos ─────────────────────────────────────────────
  const runTurn = useCallback(
    (input: { text: string; attachment?: OnboardingAttachment; label?: string }): Promise<OnboardingTurnResult> | null => {
      const text = input.text.trim();
      const shown = input.attachment ? (input.label ?? "Anexo") : text;
      if (!shown || isStreamingRef.current || !readyRef.current) return null;
      const meta = input.attachment ? { userText: text, attachmentLabel: shown } : { userText: text };
      const turnId = ++turnIdRef.current;
      setLastFailedText(null);
      setLastFailedEvent(null);
      setFailedAttachment(null);
      setBlocked(null);
      setLocalNotes([]);
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
   * Evento de cartão (sem LLM, sem bolha da pessoa: só o "digitando…" curto).
   * Devolve null quando NÃO começou (turno em andamento ou conversa não pronta).
   */
  const runEvent = useCallback(
    (event: OnboardingEvent): Promise<OnboardingTurnResult> | null => {
      if (isStreamingRef.current || !readyRef.current) return null;
      const turnId = ++turnIdRef.current;
      setLastFailedText(null);
      setLastFailedEvent(null);
      setLocalNotes([]);
      setPendingMeta({ turnId, userText: "", baselineId: historyRef.current[0]?._id ?? null, startedAt: Date.now() });
      return streamSend({ event }).then((result) => {
        if (result === "failed" && turnIdRef.current === turnId) {
          setPendingMeta((cur) => (cur?.turnId === turnId ? null : cur));
          setLastFailedEvent(event);
        }
        return result;
      });
    },
    [streamSend]
  );

  // Evento pedido durante um turno (ou antes de a conversa estar pronta): espera e sai quando ocioso, sem perder a ação.
  const eventQueueRef = useRef<OnboardingEvent[]>([]);
  const sendEvent = useCallback(
    (event: OnboardingEvent) => {
      if (runEvent(event)) return;
      const key = onboardingEventKey(event);
      if (!eventQueueRef.current.some((e) => onboardingEventKey(e) === key)) eventQueueRef.current.push(event);
    },
    [runEvent]
  );
  useEffect(() => {
    if (isStreaming || !ready) return;
    const next = eventQueueRef.current.shift();
    if (next) void runEvent(next);
  }, [isStreaming, ready, runEvent]);

  /**
   * Começa um turno de texto. Devolve null quando NÃO começou (não pronto, turno em
   * andamento, texto vazio); senão a promessa do resultado.
   */
  // `ready` entra nas dependências de propósito: a mensagem do hero reenvia quando a conversa fica pronta.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const startTurn = useCallback((raw: string) => runTurn({ text: raw }), [runTurn, ready]);

  const send = useCallback((raw: string) => void startTurn(raw), [startTurn]);

  /** Campo de mensagem: exatamente 6 dígitos com o e-mail por confirmar valem como o código. */
  const submitComposer = useCallback(
    (raw: string) => {
      if (confirmEmailCode && emailVerified === false && isBareEmailCode(raw)) {
        const code = raw.trim();
        setComposer("");
        void confirmEmailCode(code)
          .then((r) => {
            if (r.verified) {
              addNote("E-mail confirmado.");
              if (sessionId && markNotifiedOnce(`email_verified:${sessionId}`)) sendEvent({ kind: "notify", what: "email_verified" });
            } else {
              addNote(confirmResultMessage(r));
            }
          })
          .catch(() => addNote(confirmResultMessage({ verified: false })));
        return;
      }
      send(raw);
    },
    [confirmEmailCode, emailVerified, addNote, sessionId, sendEvent, send]
  );

  // ── Anexos ────────────────────────────────────────────────────────────────
  /** Sobe (se for arquivo) e envia o turno do anexo. Devolve a promessa do turno, ou null se não começou. */
  const uploadAndSend = useCallback(
    async (draft: AttachmentDraft): Promise<{ started: Promise<OnboardingTurnResult> | null } | { error: string }> => {
      let storageId: string | undefined;
      if (draft.kind !== "url") {
        if (!uploadFile) return { error: UPLOAD_ERROR_MESSAGE };
        try {
          storageId = await uploadFile({ blob: draft.file, name: draft.name, mimeType: draft.mimeType }, setUploadPhase);
        } catch {
          return { error: UPLOAD_ERROR_MESSAGE };
        } finally {
          setUploadPhase(null);
        }
      }
      // O upload demorou: o turno pode ter começado por outro caminho nesse meio tempo.
      if (isStreamingRef.current) return { started: null };
      return { started: runTurn({ text: "", attachment: toStreamAttachment(draft, storageId), label: attachmentTurnLabel(draft) }) };
    },
    [uploadFile, runTurn]
  );

  /**
   * Anexo da folha do clipe/microfone. Link: segue (o servidor guarda como pendente e responde).
   * Arquivo sem e-mail confirmado: NÃO sobe; fica na fila em memória e sai sozinho depois da
   * confirmação. Sem a ciência do aviso, mostra o aviso e espera o clique.
   */
  const submitAttachment = useCallback(
    async (draft: AttachmentDraft): Promise<SubmitAttachmentResult> => {
      if (isStreamingRef.current || !readyRef.current) {
        return { ok: false, message: "Espere o Copiloto terminar de responder para enviar." };
      }
      if (draft.kind !== "url" && emailVerified === false) {
        setQueuedFiles((cur) => [...cur, { id: ++queueIdRef.current, draft }]);
        addNote(
          `Guardei ${fileLabel(draft)} aqui no seu navegador. Assim que você confirmar o e-mail eu leio (mantenha esta página aberta).`
        );
        // Fecha a folha: a conversa mostra o cartão do e-mail (e o aviso, se faltar a ciência).
        return { ok: true };
      }
      if (!noticeOk) {
        setBlocked({ gate: "avisoMateriais", draft });
        setRetryState({ busy: false, error: null });
        return { ok: true };
      }
      const r = await uploadAndSend(draft);
      if ("error" in r) return { ok: false, message: r.error };
      return r.started ? { ok: true } : { ok: false, message: "Não foi possível enviar agora. Tente de novo." };
    },
    [emailVerified, noticeOk, addNote, uploadAndSend]
  );

  // Fila de arquivos: com o e-mail confirmado e a ciência dada, sai um por vez (conversa ociosa).
  const drainingRef = useRef(false);
  useEffect(() => {
    if (drainingRef.current) return;
    if (!pendingFileDrain({ emailVerified, noticeOk, idle: ready && !isStreaming, queued: queuedFiles.length })) return;
    const first = queuedFiles[0];
    drainingRef.current = true;
    void (async () => {
      let done = true;
      try {
        const r = await uploadAndSend(first.draft);
        if ("error" in r) addNote(`Não consegui enviar ${fileLabel(first.draft)}. Anexe de novo para tentar outra vez.`);
        else if (!r.started) done = false;
      } finally {
        drainingRef.current = false;
        if (done) setQueuedFiles((cur) => cur.filter((q) => q.id !== first.id));
        else window.setTimeout(() => setDrainTick((t) => t + 1), 300);
      }
    })();
  }, [emailVerified, noticeOk, ready, isStreaming, queuedFiles, drainTick, uploadAndSend, addNote]);

  // Materiais que o servidor guardou (links): `process_pending` até zerar, um por vez, sem laço se o número não cair.
  const pendingAttemptRef = useRef<number | null>(null);
  useEffect(() => {
    if (pendingMaterials <= 0) {
      pendingAttemptRef.current = null;
      return;
    }
    if (
      !shouldProcessPending({
        emailVerified,
        noticeOk,
        idle: ready && !isStreaming,
        queued: queuedFiles.length,
        pending: pendingMaterials,
        lastAttempt: pendingAttemptRef.current,
      })
    ) {
      return;
    }
    pendingAttemptRef.current = pendingMaterials;
    sendEvent({ kind: "process_pending" });
  }, [pendingMaterials, emailVerified, noticeOk, ready, isStreaming, queuedFiles.length, sendEvent]);

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

  // ── Recomeçar a conversa ──────────────────────────────────────────────────
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartState, setRestartState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const confirmRestart = useCallback(async () => {
    if (!onRestart) return;
    setRestartState({ busy: true, error: null });
    // O streaming em andamento é cancelado ANTES: nada dele entra na conversa nova.
    abortStream();
    turnIdRef.current++;
    eventQueueRef.current = [];
    setPendingMeta(null);
    setQueuedFiles([]);
    setLocalNotes([]);
    setBlocked(null);
    setFailedAttachment(null);
    setLastFailedText(null);
    setLastFailedEvent(null);
    clearError();
    const r = await onRestart().catch((): RestartResult => ({ ok: false, message: "Não foi possível recomeçar a conversa. Tente de novo." }));
    if (!r.ok) {
      setRestartState({ busy: false, error: r.message });
      return;
    }
    // A mensagem do hero guardada também sai (recomeçar = saudação inicial).
    intentSentRef.current = true;
    clearOnboardingIntent();
    onIntentConsumed?.();
    setComposer("");
    setRestartState({ busy: false, error: null });
    setRestartOpen(false);
  }, [onRestart, abortStream, clearError, onIntentConsumed]);

  // Depois de recomeçar: foco no campo assim que a conversa nova estiver pronta.
  const focusPendingRef = useRef(focusComposerOnReady);
  useEffect(() => {
    if (!ready || !focusPendingRef.current) return;
    focusPendingRef.current = false;
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mensagem para o Copiloto"]')?.focus();
  }, [ready]);

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

  // ── Ação da pessoa (a conversa mostra o que chegar em seguida, mesmo que ela tenha rolado) ──
  const [actionTick, setActionTick] = useState(0);
  const bumpAction = useCallback(() => setActionTick((t) => t + 1), []);
  const userSend = useCallback(
    (raw: string) => {
      bumpAction();
      send(raw);
    },
    [bumpAction, send]
  );
  const userSendEvent = useCallback(
    (event: OnboardingEvent) => {
      bumpAction();
      sendEvent(event);
    },
    [bumpAction, sendEvent]
  );

  // ── Teste da IA em tela dedicada (estado da conversa: mensagem nova não o fecha) ──
  const [testOpen, setTestOpen] = useState(false);
  const [connectSignal, setConnectSignal] = useState(0);
  const canOpenTest = !!renderTestScreen;
  const openTest = useCallback(() => setTestOpen(true), []);
  const testedSentRef = useRef(false);

  const hasUserMessage = timeline.some((t) => t.role === "user");

  // Estável entre deltas: os blocos não re-renderizam a cada pedaço de texto.
  const blockCtx = useMemo(
    () => ({
      organizationId,
      sessionId,
      sendText: userSend,
      sendEvent: userSendEvent,
      busy: isStreaming,
      facts,
      ...(canOpenTest ? { openTest } : {}),
      connectSignal,
      collapseEmailCard: hasUserMessage,
    }),
    [organizationId, sessionId, userSend, userSendEvent, isStreaming, facts, canOpenTest, openTest, connectSignal, hasUserMessage]
  );

  // ── Próximo passo: SEMPRE um efeito visível; some quando o cartão do passo está na tela ──
  const next = nextStepFor(roadmapFacts);
  const cardInTimeline = timelineHasCard(timeline, next.cardKind);
  const [cardVisible, setCardVisible] = useState(false);
  useEffect(() => {
    setCardVisible(false);
    const node = latestCardNode(next.cardKind);
    if (!node || typeof IntersectionObserver === "undefined") return;
    // "À vista" = a parte de baixo do cartão (onde ficam os botões) está dentro da área de mensagens.
    const io = new IntersectionObserver(
      ([entry]) => {
        const rb = entry.rootBounds;
        const r = entry.boundingClientRect;
        setCardVisible(entry.isIntersecting && (!rb || (r.bottom <= rb.bottom + 1 && r.bottom >= rb.top + 48)));
      },
      { root: scrollParentOf(node), threshold: Array.from({ length: 21 }, (_, i) => i / 20) }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [next.cardKind, timeline]);
  const mode = nextStepMode({ task: next.task, cardKind: next.cardKind, cardInTimeline, cardVisible, canOpenTest });

  // Pedido ao servidor (o cartão não está na conversa): rola até ele quando chegar.
  const revealWhenArrivesRef = useRef<string | null>(null);
  useEffect(() => {
    const kind = revealWhenArrivesRef.current;
    if (!kind || !timelineHasCard(timeline, kind)) return;
    revealWhenArrivesRef.current = null;
    window.setTimeout(() => goToCard(kind), 0);
  }, [timeline]);

  const onNextStep = useCallback(() => {
    if (next.task === "describe_business" || !next.cardKind) {
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mensagem para o Copiloto"]')?.focus();
      return;
    }
    if (next.task === "test" && canOpenTest) {
      openTest();
      return;
    }
    // O cartão está na conversa (mesmo longe, mais acima): rola até ele e destaca.
    if (cardInTimeline && goToCard(next.cardKind)) return;
    // Não está: pede ao servidor e rola quando ele chegar.
    revealWhenArrivesRef.current = next.cardKind;
    userSendEvent({ kind: "next" });
  }, [next.task, next.cardKind, canOpenTest, openTest, cardInTimeline, userSendEvent]);
  const nextStep: NextStepBarProps = {
    label: next.label,
    ...(next.task === "done" ? { href: APP_HREF } : { onPress: onNextStep }),
  };

  // Perguntas de teste do segmento: as do cartão final mais recente (montadas pelo servidor).
  const testSuggestions = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      for (const b of timeline[i].blocks) {
        if (blockKindOf(b) === "operacaoPronta") {
          const prompts = (b as { prompts?: unknown }).prompts;
          return Array.isArray(prompts) ? prompts.filter((p): p is string => typeof p === "string").map((p) => plainModelText(p)).filter(Boolean).slice(0, 4) : [];
        }
      }
    }
    return [];
  }, [timeline]);

  const preview = <DraftPreviewPanel draft={draft} ctx={blockCtx} progress={progress} nextStep={nextStep} />;
  const previewSheet = <DraftPreviewPanel draft={draft} ctx={blockCtx} progress={progress} nextStep={nextStep} inSheet />;
  const pendingIntent = intent?.message && !intentSentRef.current ? intent.message : null;

  // Anexo recusado por conta/aviso: mostra o bloco certo (e "Enviar de novo") em vez do erro genérico.
  const streamGate = gateForErrorCode(streamError?.code);
  const gate = streamGate ?? blocked?.gate ?? null;
  const retryAttachment = failedAttachment
    ? () => void runTurn({ text: "", attachment: failedAttachment.attachment, label: failedAttachment.label })
    : blocked
      ? () => {
          setRetryState({ busy: true, error: null });
          void submitAttachment(blocked.draft).then((r) => setRetryState({ busy: false, error: r.ok ? null : r.message }));
        }
      : null;
  const gateCtx: BlockContext = { ...blockCtx, isLatest: true };
  const renderGate = (g: "cartaoConta" | "avisoMateriais") =>
    renderGateBlock ? (
      renderGateBlock(g, gateCtx)
    ) : (
      <OnboardingBlockView
        block={
          g === "cartaoConta"
            ? { kind: "cartaoConta", emailVerified: false, materialsUnlocked: false }
            : { kind: "avisoMateriais", text: MATERIALS_NOTICE_TEXT, acknowledged: false }
        }
        ctx={gateCtx}
      />
    );
  // Arquivos na fila: o cartão do e-mail (e o aviso, se faltar a ciência) aparecem enquanto esperam.
  const queueGates: Array<"cartaoConta" | "avisoMateriais"> = [];
  if (queuedFiles.length > 0 && emailVerified === false) queueGates.push("cartaoConta");
  if (queuedFiles.length > 0 && !noticeOk) queueGates.push("avisoMateriais");
  const tailGates = gate ? [gate] : queueGates.filter((g) => g !== gate);
  const hasTail = tailGates.length > 0 || localNotes.length > 0 || retryAttachment !== null;
  const tail = hasTail ? (
    <div className="flex flex-col items-start gap-2">
      {localNotes.map((n) => (
        <CopilotNote key={`note:${n.id}`}>{n.text}</CopilotNote>
      ))}
      {tailGates.map((g) => (
        <div key={`gate:${g}`} className="pl-2">
          {renderGate(g)}
        </div>
      ))}
      {gate && retryAttachment && (
        <Button type="button" variant="secondary" size="sm" loading={retryState.busy} disabled={isStreaming || retryState.busy} onClick={retryAttachment}>
          Enviar de novo
        </Button>
      )}
      <div aria-live="polite">
        {retryState.busy && uploadPhase && <p className="text-caption text-text-secondary">Enviando o arquivo…</p>}
        {retryState.error && (
          <p role="alert" className="text-sm text-semantic-error">
            {retryState.error}
          </p>
        )}
      </div>
    </div>
  ) : null;
  const canAttach = !!uploadFile && access.kind === "ready" && ready && !isStreaming;

  const baseProps = {
    onAttach: canAttach ? () => setSheet("attach") : undefined,
    onMic: canAttach ? () => setSheet("voice") : undefined,
    tail,
    formHref: WIZARD_HREF,
    appHref: APP_HREF,
    onPreferForm,
    composerValue: composer,
    onComposerChange: setComposer,
    onSubmit: (raw: string) => {
      bumpAction();
      submitComposer(raw);
    },
    onChip: userSend,
    blockCtx,
    progress,
  };

  if (access.kind === "forbidden" || access.kind === "error") {
    return (
      <OnboardingChatView
        {...baseProps}
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
        previewSheet={previewSheet}
      />
    );
  }

  const isEmpty = timeline.length === 0 && !pending;
  const chips = coherentChips(currentChips(timeline, isEmpty ? [...GREETING_CHIPS] : (chatState?.lastChips ?? [])), roadmapFacts);
  const turnText = turn?.replyText ?? "";

  // O código de e-mail já foi enviado: a conversa mostra desde o começo uma versão compacta do cartão, enquanto
  // não confirmado (e depois como linha de sucesso). Se o servidor já trouxe o cartão na conversa, não repete.
  const timelineHasAccountCard = timeline.some((t) => t.blocks.some((b) => blockKindOf(b) === "cartaoConta"));
  const emailIntro =
    emailIntroRef.current && !timelineHasAccountCard ? (
      <div className="pl-2">
        {renderEmailCard ? (
          renderEmailCard({ ...blockCtx, isLatest: true, compact: true })
        ) : (
          <OnboardingBlockView
            block={{ kind: "cartaoConta", emailVerified: false, materialsUnlocked: false, ...(facts.maskedEmail ? { maskedEmail: facts.maskedEmail } : {}) }}
            ctx={{ ...blockCtx, isLatest: true, compact: true }}
          />
        )}
      </div>
    ) : null;

  return (
    <>
    <OnboardingChatView
      {...baseProps}
      intro={
        <>
          {orgPicker}
          {isEmpty && !pendingIntent && (
            <CopilotNote>
              Oi! Vou montar o seu CRM com você em poucos minutos. Me conta em uma frase: o que você vende?
            </CopilotNote>
          )}
          {emailIntro}
        </>
      }
      timeline={timeline}
      typing={isStreaming}
      status={turn?.status}
      showTypingBubble={isStreaming && !turnText}
      chips={chips}
      error={streamGate ? null : (streamError?.message ?? null)}
      onRetry={
        streamError?.code === "forbidden"
          ? undefined
          : retryAttachment && !gate
            ? retryAttachment
            : lastFailedText
              ? () => send(lastFailedText)
              : lastFailedEvent
                ? () => sendEvent(lastFailedEvent)
                : undefined
      }
      onDismissError={clearError}
      canLoadMore={history.status === "CanLoadMore"}
      loadingMore={history.status === "LoadingMore"}
      onLoadMore={() => history.loadMore(HISTORY_PAGE)}
      preview={preview}
      previewSheet={previewSheet}
      nextStep={mode === "hidden" ? undefined : nextStep}
      onRestart={onRestart ? () => setRestartOpen(true) : undefined}
      userActionTick={actionTick}
      takeover={
        testOpen && renderTestScreen
          ? renderTestScreen({
              suggestions: testSuggestions,
              tested: facts.tested,
              connected: facts.connected,
              onClose: () => setTestOpen(false),
              onConnect: () => {
                setTestOpen(false);
                setConnectSignal((n) => n + 1);
                window.setTimeout(() => goToCard("operacaoPronta"), 50);
              },
              onTested: () => {
                if (testedSentRef.current || facts.tested) return;
                testedSentRef.current = true;
                sendEvent({ kind: "notify", what: "tested" });
              },
            })
          : undefined
      }
    />
    {onRestart && (
      <RestartConversationDialog
        open={restartOpen}
        onClose={() => {
          setRestartOpen(false);
          setRestartState({ busy: false, error: null });
        }}
        onConfirm={() => void confirmRestart()}
        applied={facts.applied || facts.priorApplied === true}
        busy={restartState.busy}
        error={restartState.error}
      />
    )}
    <AttachmentSheet open={sheet === "attach"} onClose={() => setSheet(null)} onSubmit={submitAttachment} phase={uploadPhase} />
    <VoiceSheet open={sheet === "voice"} onClose={() => setSheet(null)} onSubmit={submitAttachment} phase={uploadPhase} />
    </>
  );
}
