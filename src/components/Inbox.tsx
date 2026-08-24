import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOutletContext, useNavigate, useSearchParams } from "react-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { TAB_ROUTES } from "@/lib/routes";
import { toast } from "sonner";
import { Send, ArrowLeft, ArrowLeftRight, Clock, X, Reply, Mic, Image as ImageIcon, Video, FileText, Search, Check, CheckSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { MentionTextarea } from "@/components/ui/MentionTextarea";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { extractMentionIds } from "@/lib/mentions";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";
import { FileUploadButton, type UploadedFile } from "@/components/ui/FileUploadButton";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { ForwardModal } from "@/components/inbox/ForwardModal";
import { VoiceRecorder } from "@/components/inbox/VoiceRecorder";
import { EmojiPickerButton } from "@/components/inbox/EmojiPickerButton";
import { useQuickReplies, QuickReplyDropdown, QuickRepliesModal } from "@/components/inbox/QuickReplies";
import { ConversationActionsMenu } from "@/components/inbox/ConversationActionsMenu";
import { AiDraftCard, AiConversationControls, ReturnToAiButton, getAiDraft } from "@/components/inbox/AiDraftCard";
import { getReactions, isMediaPlaceholder, isVoiceNote, type InboxMessage } from "@/components/inbox/types";

// v4.2: motivo (aiReplyQueue.error) → texto PT-BR amigável para o chip de
// estado da IA no header da conversa.
const AI_STATE_REASON_LABELS: Record<string, string> = {
  fora_do_horario: "fora do horário de atendimento",
  lead_de_humano: "lead atribuído a um humano",
  ia_pausada: "IA pausada nesta conversa",
  handoff_pendente: "aguardando atendimento humano (repasse)",
  opt_out: "contato optou por não falar com IA",
  teto_hora: "limite de respostas por hora atingido",
  teto_conversa: "limite de respostas da conversa atingido",
  janela_24h: "janela de 24h fechada",
  bridge_sem_aceite: "canal não-oficial sem aceite de risco",
  atendente_desativado: "atendente desativado",
  ia_desativada: "IA desativada",
  sem_atendente: "sem atendente configurado",
  budget_mensal: "limite mensal de conversas atingido",
};

// `lead.handoffState` some quando nunca houve repasse; "completed" é repasse
// já resolvido. Qualquer outro estado = alguém precisa assumir a conversa.
type LeadHandoffState = { status: string; reason?: string } | undefined | null;

function isHandoffPending(state: LeadHandoffState): boolean {
  return !!state && state.status !== "completed";
}

type AiConvState = {
  status: string;
  reason: string | null;
  at: number;
  afterLastInbound: boolean;
} | null | undefined;

// "done" ou item antigo (já superado por uma mensagem inbound mais nova) → sem chip.
function aiStateChipInfo(state: AiConvState): { label: string; tone: "processing" | "waiting" } | null {
  if (!state || state.status === "done") return null;
  if (state.status === "pending" || state.status === "processing") {
    return { label: "IA preparando resposta…", tone: "processing" };
  }
  if ((state.status === "skipped" || state.status === "failed") && state.afterLastInbound) {
    const reasonLabel = state.reason ? AI_STATE_REASON_LABELS[state.reason] ?? state.reason : "motivo desconhecido";
    return { label: `IA em espera: ${reasonLabel}`, tone: "waiting" };
  }
  return null;
}

/**
 * Resolve o `?conversation=` que não está na lista carregada (fora do take(200)
 * ou arquivada). Fica isolado num filho sob ErrorBoundary porque a query
 * quebra para id malformado ou de outra org — nesse caso o deep-link é
 * simplesmente ignorado, sem derrubar a caixa de entrada.
 */
function ConversationDeepLinkResolver({
  conversationId,
  onResolve,
}: {
  conversationId: Id<"conversations">;
  onResolve: (conversation: Record<string, any> | null) => void;
}) {
  const conversation = useQuery(api.conversations.getConversationById, { conversationId });
  useEffect(() => {
    if (conversation === undefined) return;
    onResolve(conversation as Record<string, any> | null);
  }, [conversation, onResolve]);
  return null;
}

export function Inbox() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const conversationParam = searchParams.get("conversation");
  const { can, member } = usePermissions(organizationId);
  const currentMemberId = member?._id ?? null;
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<UploadedFile[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Arquivadas + filtro por etiqueta na lista de conversas.
  const [showArchived, setShowArchived] = useState(false);
  const [filterLabelId, setFilterLabelId] = useState<string | null>(null);

  // Conversa alcançada por deep-link que não está na lista carregada — o
  // resolver abaixo mantém este estado em dia (o documento continua reativo).
  const [linkedConversation, setLinkedConversation] = useState<Record<string, any> | null>(null);

  // Seleção múltipla na lista (arquivar/etiquetar em lote).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkLabelOpen, setBulkLabelOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState<
    null | { action: "archive" | "label"; labelId?: string }
  >(null);

  // Busca em mensagens (lista de conversas vira lista de resultados).
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const [searchMonth, setSearchMonth] = useState(""); // "YYYY-MM" ou ""

  // Onda 2 interaction state.
  const [replyTo, setReplyTo] = useState<InboxMessage | null>(null);
  const [forwardTarget, setForwardTarget] = useState<InboxMessage | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());
  const [recorderActive, setRecorderActive] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Debounce da busca para não disparar uma query por tecla.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedTerm(searchTerm), 300);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  // IA da org (opt-in): controla os controles de IA no header + rascunhos.
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  // Estado do atendente nesta conversa (v4.2): alimenta o chip "IA em espera / preparando".
  const aiConvState = useQuery(
    api.attendant.getConversationAiState,
    selectedConversation && aiStatus?.active
      ? { conversationId: selectedConversation as Id<"conversations"> }
      : "skip"
  );

  const conversations = useQuery(api.conversations.getConversations, {
    organizationId,
    ...(showArchived ? { archived: true } : {}),
  });

  const conversationLabels = useQuery(api.conversations.listLabels, { organizationId });

  const messages = useQuery(
    api.conversations.getMessages,
    selectedConversation ? { conversationId: selectedConversation as Id<"conversations"> } : "skip"
  );

  // Recorte do mês selecionado → range [início, fim] em ms.
  const monthRange = (() => {
    if (!/^\d{4}-\d{2}$/.test(searchMonth)) return null;
    const [y, m] = searchMonth.split("-").map(Number);
    return {
      dateFrom: new Date(y, m - 1, 1).getTime(),
      dateTo: new Date(y, m, 1).getTime() - 1,
    };
  })();

  const isSearching = debouncedTerm.trim().length >= 2;
  const searchResults = useQuery(
    api.conversations.searchMessages,
    isSearching
      ? {
          organizationId,
          searchQuery: debouncedTerm,
          ...(monthRange ?? {}),
        }
      : "skip"
  );

  const scheduledPending = useQuery(
    api.scheduledMessages.listPending,
    selectedConversation ? { conversationId: selectedConversation as Id<"conversations"> } : "skip"
  );
  const scheduleMessage = useMutation(api.scheduledMessages.schedule);
  const cancelScheduled = useMutation(api.scheduledMessages.cancel);

  const bulkArchiveConversations = useMutation(api.conversations.bulkSetConversationsArchived);
  const bulkLabelConversations = useMutation(api.conversations.bulkApplyConversationLabel);

  const sendMessage = useMutation(api.conversations.sendMessage);
  const reactToMessage = useMutation(api.conversations.reactToMessage);
  const markConversationRead = useMutation(api.conversations.markConversationRead);
  const sendTypingState = useMutation(api.conversations.sendTypingState);
  const transcribe = useAction(api.transcription.transcribe);

  // Typing indicator throttle bookkeeping.
  const typingLastSentRef = useRef(0);
  const typingPauseTimerRef = useRef<number | null>(null);
  // markConversationRead de-dupe: last "conversationId:newestInboundId" acted on.
  const lastReadSigRef = useRef<string | null>(null);

  // Composer textarea — usado para inserir emoji na posição do cursor.
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);

  const insertEmoji = (emoji: string) => {
    const el = composerInputRef.current;
    if (!el) {
      setNewMessage((v) => v + emoji);
      return;
    }
    const start = el.selectionStart ?? newMessage.length;
    const end = el.selectionEnd ?? start;
    setNewMessage(newMessage.slice(0, start) + emoji + newMessage.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // Agendamento de mensagem — popover com datetime no composer.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState("");

  const toLocalInputValue = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const openSchedule = () => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(0, 0, 0);
    setScheduleValue(toLocalInputValue(d));
    setScheduleOpen(true);
  };

  const handleSchedule = async () => {
    if (!selectedConversation || !newMessage.trim() || !scheduleValue) return;
    const scheduledAt = new Date(scheduleValue).getTime();
    if (Number.isNaN(scheduledAt)) return;
    try {
      await scheduleMessage({
        conversationId: selectedConversation as Id<"conversations">,
        content: newMessage.trim(),
        scheduledAt,
      });
      toast.success(
        `Mensagem agendada para ${new Date(scheduledAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
      );
      setNewMessage("");
      setScheduleOpen(false);
      stopTyping();
    } catch (err) {
      toast.error(err instanceof Error ? err.message.split("\n")[0].replace(/^.*Error: /, "") : "Falha ao agendar");
    }
  };

  const handleCancelScheduled = async (id: string) => {
    try {
      await cancelScheduled({ scheduledMessageId: id as Id<"scheduledMessages"> });
      toast.success("Agendamento cancelado");
    } catch {
      toast.error("Falha ao cancelar agendamento");
    }
  };

  // Respostas rápidas — "/" no composer (fora do modo nota interna).
  const quickReplies = useQuickReplies({
    organizationId,
    value: newMessage,
    enabled: !isInternal,
    onApply: (content) => {
      setNewMessage(content);
      requestAnimationFrame(() => composerInputRef.current?.focus());
    },
  });

  // Auto-scroll bookkeeping for the message thread (WhatsApp-style anchoring).
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const scrolledConvRef = useRef<string | null>(null);

  const handleMessagesScroll = () => {
    const el = messagesScrollRef.current;
    if (!el) return;
    // Considera "perto do fim" quando falta menos de 120px para o rodapé.
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // On conversation switch: force-scroll to the newest message. On new messages:
  // only stick to the bottom if the user was already near it (reading history stays put).
  useLayoutEffect(() => {
    const el = messagesScrollRef.current;
    if (!el || !messages) return;
    const switched = scrolledConvRef.current !== selectedConversation;
    if (switched) {
      scrolledConvRef.current = selectedConversation;
      nearBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, selectedConversation]);

  const validConversations = (conversations ?? []).filter(
    (c): c is NonNullable<typeof c> => c !== null
  );
  const labelById = new Map((conversationLabels ?? []).map((l) => [l._id as string, l]));
  const filteredConversations = filterLabelId
    ? validConversations.filter((c) => ((c.labelIds ?? []) as string[]).includes(filterLabelId))
    : validConversations;

  // A conversa do deep-link entra no topo da lista enquanto estiver aberta e
  // fora da lista carregada (fora do take(200), ou arquivada ainda carregando).
  const conversationInList =
    conversationParam !== null && validConversations.some((c) => c._id === conversationParam);
  const pinnedConversation =
    linkedConversation &&
    linkedConversation._id === selectedConversation &&
    !validConversations.some((c) => c._id === linkedConversation._id)
      ? linkedConversation
      : null;
  const listedConversations = pinnedConversation
    ? [pinnedConversation, ...filteredConversations]
    : filteredConversations;
  const currentConversation =
    validConversations.find((c) => c._id === selectedConversation) ??
    (linkedConversation?._id === selectedConversation ? linkedConversation : undefined);
  const channelIsWhatsapp = currentConversation?.channel === "whatsapp";
  const contactName =
    `${currentConversation?.contact?.firstName ?? ""} ${currentConversation?.contact?.lastName ?? ""}`.trim();

  // Funil do lead da conversa aberta (C2): "Funil: <board> → <estágio>" com link.
  const leadBoardId = currentConversation?.lead?.boardId as Id<"boards"> | undefined;
  const leadStageId = currentConversation?.lead?.stageId as Id<"stages"> | undefined;
  const leadBoards = useQuery(api.boards.getBoards, leadBoardId ? { organizationId } : "skip") as
    | { _id: Id<"boards">; name: string }[]
    | undefined;
  const leadStages = useQuery(
    api.boards.getStages,
    leadBoardId ? { boardId: leadBoardId } : "skip"
  ) as { _id: Id<"stages">; name: string }[] | undefined;
  const leadBoardName = leadBoards?.find((b) => b._id === leadBoardId)?.name;
  const leadStageName = leadStages?.find((s) => s._id === leadStageId)?.name;
  const funnelLine = leadBoardId ? (
    <button
      type="button"
      onClick={() =>
        navigate(
          `${TAB_ROUTES.board}?board=${leadBoardId}` +
            (currentConversation?.leadId ? `&lead=${currentConversation.leadId}` : "")
        )
      }
      className="block text-left text-xs text-text-muted hover:text-brand-500 transition-colors truncate"
    >
      Funil: <span className="text-text-secondary font-medium">{leadBoardName ?? "…"}</span>
      {" → "}
      <span className="text-text-secondary font-medium">{leadStageName ?? "…"}</span>
      <span className="ml-1.5 text-brand-500">Ver no funil</span>
    </button>
  ) : null;

  // Repasse pendente do lead da conversa aberta → banner com ação inline.
  const openHandoffState = currentConversation?.lead?.handoffState as LeadHandoffState;
  const handoffPending = isHandoffPending(openHandoffState);
  const openLeadId = currentConversation?.leadId as Id<"leads"> | undefined;
  const pendingHandoff = useQuery(
    api.handoffs.getPendingHandoffForLead,
    handoffPending && openLeadId ? { leadId: openLeadId } : "skip"
  ) as { _id: string } | null | undefined;

  const acceptHandoff = useMutation(api.handoffs.acceptHandoff);

  const handleAcceptHandoff = () => {
    if (!pendingHandoff) return;
    toast.promise(acceptHandoff({ handoffId: pendingHandoff._id as Id<"handoffs"> }), {
      loading: "Assumindo conversa…",
      success: "Conversa assumida — IA pausada",
      error: (e) => mutationErrorMessage(e, "Falha ao assumir o repasse"),
    });
  };

  // Com um rascunho já aguardando revisão, pedir outra sugestão não faz
  // sentido (o backend recusa um segundo turno enfileirado na mesma conversa).
  const hasPendingDraft = ((messages ?? []) as InboxMessage[]).some(
    (m) => getAiDraft(m)?.status === "pending"
  );

  const aiChip = aiStateChipInfo(aiConvState);

  // "digitando..." do contato — TTL de 12s no cliente (o "paused" pode se perder).
  const contactPresence = currentConversation?.contactPresence as
    | { state: "composing" | "paused"; at: number }
    | undefined;
  const [presenceNow, setPresenceNow] = useState(() => Date.now());
  useEffect(() => {
    if (contactPresence?.state !== "composing") return;
    setPresenceNow(Date.now());
    const interval = setInterval(() => setPresenceNow(Date.now()), 4000);
    return () => clearInterval(interval);
  }, [contactPresence?.state, contactPresence?.at]);
  const contactTyping =
    contactPresence?.state === "composing" && presenceNow - contactPresence.at < 12_000;

  // Content type is derived from the first staged file; the bridge only sends
  // one attachment per message, so the first drives how it's classified.
  const deriveContentType = (
    files: UploadedFile[]
  ): "text" | "image" | "audio" | "file" => {
    const first = files[0];
    if (!first) return "text";
    if (first.mimeType.startsWith("image/")) return "image";
    if (first.mimeType.startsWith("audio/")) return "audio";
    return "file";
  };

  const stopTyping = () => {
    if (typingPauseTimerRef.current !== null) {
      window.clearTimeout(typingPauseTimerRef.current);
      typingPauseTimerRef.current = null;
    }
    if (typingLastSentRef.current !== 0 && selectedConversation && channelIsWhatsapp) {
      typingLastSentRef.current = 0;
      sendTypingState({
        conversationId: selectedConversation as Id<"conversations">,
        state: "paused",
      }).catch(() => {});
    }
  };

  // Throttled "composing" on keystroke; "paused" after 3s idle. WhatsApp only.
  const handleComposerActivity = () => {
    if (!selectedConversation || !channelIsWhatsapp || isInternal) return;
    const ts = Date.now();
    if (ts - typingLastSentRef.current > 4000) {
      typingLastSentRef.current = ts;
      sendTypingState({
        conversationId: selectedConversation as Id<"conversations">,
        state: "composing",
      }).catch(() => {});
    }
    if (typingPauseTimerRef.current !== null) window.clearTimeout(typingPauseTimerRef.current);
    typingPauseTimerRef.current = window.setTimeout(() => {
      typingLastSentRef.current = 0;
      typingPauseTimerRef.current = null;
      if (selectedConversation) {
        sendTypingState({
          conversationId: selectedConversation as Id<"conversations">,
          state: "paused",
        }).catch(() => {});
      }
    }, 3000);
  };

  // Mark inbound messages read when a conversation is open and a new newest
  // inbound arrives. The signature guard prevents re-firing on our own patch.
  useEffect(() => {
    if (!selectedConversation || !messages) return;
    const msgs = messages as InboxMessage[];
    let newestInbound: InboxMessage | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].direction === "inbound") {
        newestInbound = msgs[i];
        break;
      }
    }
    if (!newestInbound) return;
    const sig = `${selectedConversation}:${newestInbound._id}`;
    if (lastReadSigRef.current === sig) return;
    lastReadSigRef.current = sig;
    const conversationId = selectedConversation as Id<"conversations">;
    const timer = window.setTimeout(() => {
      markConversationRead({ conversationId }).catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [selectedConversation, messages, markConversationRead]);

  // Cancel any pending typing timer on unmount.
  useEffect(() => {
    return () => {
      if (typingPauseTimerRef.current !== null) window.clearTimeout(typingPauseTimerRef.current);
    };
  }, []);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newMessage.trim();
    if ((!trimmed && stagedFiles.length === 0) || !selectedConversation) return;

    try {
      const mentionedUserIds = isInternal ? extractMentionIds(trimmed) : undefined;
      const attachments = stagedFiles.map((f) => f.fileId);

      await sendMessage({
        conversationId: selectedConversation as Id<"conversations">,
        content: trimmed,
        contentType: attachments.length ? deriveContentType(stagedFiles) : "text",
        isInternal,
        attachments: attachments.length ? attachments : undefined,
        mentionedUserIds: mentionedUserIds?.length ? mentionedUserIds : undefined,
        replyToMessageId: !isInternal && replyTo ? (replyTo._id as Id<"messages">) : undefined,
      });
      setNewMessage("");
      setStagedFiles([]);
      setReplyTo(null);
      stopTyping();
    } catch (error) {
      toast.error("Falha ao enviar mensagem");
    }
  };

  const handleSendVoice = async (file: UploadedFile) => {
    if (!selectedConversation) throw new Error("no conversation");
    await sendMessage({
      conversationId: selectedConversation as Id<"conversations">,
      content: "",
      contentType: "audio",
      attachments: [file.fileId],
      replyToMessageId: replyTo ? (replyTo._id as Id<"messages">) : undefined,
    });
    setReplyTo(null);
    stopTyping();
  };

  const handleReact = async (message: InboxMessage, emoji: string) => {
    const mine = getReactions(message).find((r) => r.sender === currentMemberId)?.emoji ?? null;
    const next = mine === emoji ? "" : emoji;
    try {
      await reactToMessage({ messageId: message._id as Id<"messages">, emoji: next });
    } catch {
      toast.error("Falha ao reagir à mensagem");
    }
  };

  const handleTranscribe = async (message: InboxMessage) => {
    setTranscribingIds((prev) => new Set(prev).add(message._id));
    try {
      const result = await transcribe({ organizationId, messageId: message._id as Id<"messages"> });
      if (result.status === "failed") toast.error("Falha na transcrição");
    } catch {
      toast.error("Falha na transcrição");
    } finally {
      setTranscribingIds((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(message._id);
        return nextSet;
      });
    }
  };

  // Salto pendente para um resultado da busca — efetivado quando o thread carrega.
  const pendingJumpRef = useRef<string | null>(null);

  useEffect(() => {
    const target = pendingJumpRef.current;
    if (!target || !messages) return;
    const el = document.getElementById(`msg-${target}`);
    if (!el) return;
    pendingJumpRef.current = null;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(target);
    window.setTimeout(() => {
      setHighlightId((cur) => (cur === target ? null : cur));
    }, 2000);
  }, [messages]);

  const handleJumpToMessage = (messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) {
      toast("A mensagem original não está carregada");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(messageId);
    window.setTimeout(() => {
      setHighlightId((cur) => (cur === messageId ? null : cur));
    }, 2000);
  };

  const resetConversationState = () => {
    setStagedFiles([]);
    setReplyTo(null);
    setNewMessage("");
    setRecorderActive(false);
    stopTyping();
    lastReadSigRef.current = null;
  };

  // Escrita nossa no `?conversation=` ainda em voo: o router aplica o
  // `setSearchParams` de forma assíncrona, então existe pelo menos um render em
  // que `selectedConversation` já é a conversa nova e o param ainda é a antiga.
  // `target` é o valor que pedimos e `stale` o que estava na URL na hora —
  // enquanto a URL mostrar `stale`, o efeito URL → estado tem de ficar quieto
  // (reaplicar o valor antigo desfazia o clique e travava a caixa no link).
  const conversationParamSyncRef = useRef<{ target: string | null; stale: string | null } | null>(
    null
  );

  // A conversa aberta vive na URL (`?conversation=`), para dar/receber
  // deep-link de outras telas (detalhe da tarefa, painel do lead).
  const syncConversationParam = useCallback(
    (conversationId: string | null) => {
      conversationParamSyncRef.current = { target: conversationId, stale: conversationParam };
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (conversationId) next.set("conversation", conversationId);
          else next.delete("conversation");
          return next;
        },
        { replace: true }
      );
    },
    [conversationParam, setSearchParams]
  );

  const handleSelectConversation = (conversationId: string) => {
    stopTyping();
    setSelectedConversation(conversationId);
    setShowMessages(true);
    setStagedFiles([]);
    setReplyTo(null);
    setNewMessage("");
    setRecorderActive(false);
    lastReadSigRef.current = null;
    syncConversationParam(conversationId);
  };

  const handleBackToList = () => {
    resetConversationState();
    setShowMessages(false);
    setSelectedConversation(null);
    syncConversationParam(null);
  };

  // URL → estado. Quando o id está na lista carregada, abre direto. Fora dela
  // (arquivada ou além do take(200)), o resolver busca o documento avulso:
  // arquivada troca a aba da lista, ativa entra fixada no topo e um id
  // inexistente sai da URL em silêncio.
  useEffect(() => {
    // Antes de qualquer coisa: o param em mãos pode ser o eco velho de uma
    // escrita nossa que o router ainda não aplicou (ver `conversationParamSyncRef`).
    const pendingWrite = conversationParamSyncRef.current;
    if (pendingWrite) {
      if (conversationParam === pendingWrite.target) {
        conversationParamSyncRef.current = null; // a URL alcançou o que pedimos
      } else if (conversationParam === pendingWrite.stale) {
        return; // ainda em voo — o param é o valor antigo, ignorar
      } else {
        conversationParamSyncRef.current = null; // mudou por fora no meio do caminho
      }
    }

    if (!conversationParam || conversationParam === selectedConversation) return;
    if (conversations === undefined) return;

    if (conversationInList) {
      handleSelectConversation(conversationParam);
      return;
    }
    // aguarda o resolver responder sobre o id que está na URL
    if (!linkedConversation || linkedConversation._id !== conversationParam) return;
    // A aba da lista acompanha a conversa que chegou por link — só nesta
    // abertura, para não arrastar o filtro do usuário depois.
    const linkedArchived = Boolean(linkedConversation.archivedAt);
    if (linkedArchived !== showArchived) setShowArchived(linkedArchived);
    handleSelectConversation(conversationParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationParam, conversations, conversationInList, linkedConversation, selectedConversation, showArchived]);

  // O resolver responde para o id que está na URL agora; um `null` significa
  // conversa inexistente (ou apagada) — o param sai da URL.
  const handleResolveLinkedConversation = useCallback(
    (conversation: Record<string, any> | null) => {
      if (!conversation) {
        setLinkedConversation(null);
        syncConversationParam(null);
        return;
      }
      setLinkedConversation(conversation);
    },
    [syncConversationParam]
  );

  // ── Seleção múltipla: arquivar/etiquetar em lote ──

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkLabelOpen(false);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBulkArchive = async () => {
    const ids = Array.from(selectedIds) as Id<"conversations">[];
    try {
      await bulkArchiveConversations({
        organizationId,
        conversationIds: ids,
        archived: !showArchived,
      });
      toast.success(
        `${ids.length} conversa${ids.length === 1 ? "" : "s"} ${showArchived ? "desarquivada" : "arquivada"}${ids.length === 1 ? "" : "s"}`
      );
      exitSelection();
    } catch {
      toast.error("Falha na ação em lote");
    }
  };

  const runBulkLabel = async (labelId: string) => {
    const ids = Array.from(selectedIds) as Id<"conversations">[];
    try {
      await bulkLabelConversations({
        organizationId,
        conversationIds: ids,
        labelId: labelId as Id<"conversationLabels">,
      });
      toast.success(`Etiqueta aplicada a ${ids.length} conversa${ids.length === 1 ? "" : "s"}`);
      exitSelection();
    } catch {
      toast.error("Falha ao aplicar etiqueta");
    }
  };

  // Acima de 5 conversas, pede confirmação antes de executar.
  const handleBulkArchiveClick = () => {
    if (selectedIds.size > 5) setConfirmBulk({ action: "archive" });
    else void runBulkArchive();
  };

  const handleBulkLabelClick = (labelId: string) => {
    setBulkLabelOpen(false);
    if (selectedIds.size > 5) setConfirmBulk({ action: "label", labelId });
    else void runBulkLabel(labelId);
  };

  const handleOpenSearchResult = (result: { _id: string; conversationId: string }) => {
    if (result.conversationId === selectedConversation) {
      setShowMessages(true);
      handleJumpToMessage(result._id);
      return;
    }
    pendingJumpRef.current = result._id;
    handleSelectConversation(result.conversationId);
  };

  const clearSearch = () => {
    setSearchTerm("");
    setDebouncedTerm("");
    setSearchMonth("");
  };

  // Trecho do resultado com o termo destacado (janela em volta do 1º match).
  const renderSnippet = (content: string, term: string) => {
    const idx = content.toLowerCase().indexOf(term.toLowerCase());
    if (idx === -1) return content.slice(0, 90);
    const start = Math.max(0, idx - 24);
    return (
      <>
        {start > 0 ? "…" : ""}
        {content.slice(start, idx)}
        <mark className="bg-brand-500/30 text-text-primary rounded px-0.5">
          {content.slice(idx, idx + term.length)}
        </mark>
        {content.slice(idx + term.length, idx + term.length + 60)}
      </>
    );
  };

  if (!conversations) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  const getChannelBadgeVariant = (channel: string) => {
    switch (channel) {
      case "whatsapp":
        return "success";
      case "telegram":
        return "info";
      case "email":
        return "brand";
      default:
        return "default";
    }
  };

  // Media icon for the last-message preview in the conversation list
  const getPreviewIcon = (contentType: string | null, bridgeType: string | null) => {
    if (contentType === "audio" || bridgeType === "audio") return Mic;
    if (contentType === "image" || bridgeType === "sticker" || bridgeType === "image") return ImageIcon;
    if (bridgeType === "video") return Video;
    if (contentType === "file") return FileText;
    return null;
  };

  // 24h WhatsApp service window label for the conversation header
  const getServiceWindowInfo = (serviceWindowExpiresAt: number | null) => {
    if (!serviceWindowExpiresAt || serviceWindowExpiresAt <= now) {
      return {
        text: "Janela fechada — requer template",
        tone: "text-semantic-warning" as const,
      };
    }
    const remainingMs = serviceWindowExpiresAt - now;
    const remainingMinutes = Math.max(1, Math.round(remainingMs / 60_000));
    const label =
      remainingMinutes < 60
        ? `Janela fecha em ${remainingMinutes}min`
        : `Janela fecha em ${Math.round(remainingMinutes / 60)}h`;
    return { text: label, tone: "text-text-secondary" as const };
  };

  // The 24h window + template CTA only apply to the official Cloud API. Bridge
  // (unofficial) conversations report serviceWindowApplies === false — hide it.
  const windowInfo =
    currentConversation?.channel === "whatsapp" &&
    currentConversation.serviceWindowApplies !== false
      ? getServiceWindowInfo(currentConversation.serviceWindowExpiresAt)
      : null;

  // Controles de IA (pausar/retomar) aparecem em canais oficiais sempre, e em
  // canais bridge (não-oficiais) só depois do aceite de risco específico do
  // atendente — não mexe na janela de 24h/templates do composer acima.
  const aiControlsAllowed =
    currentConversation?.serviceWindowApplies !== false || aiStatus?.bridgeAiAckDone === true;

  const canReply = can("inbox", "reply");
  // Voice recorder / mic replaces the send button when there's nothing typed.
  const composerEmpty = newMessage.trim() === "" && stagedFiles.length === 0;
  const showVoice =
    channelIsWhatsapp && !isInternal && canReply && (recorderActive || composerEmpty);

  // Compact preview for the composer reply citation bar.
  const replyPreview = replyTo
    ? replyTo.content && !isMediaPlaceholder(replyTo.content)
      ? replyTo.content
      : isVoiceNote(replyTo)
        ? "Mensagem de voz"
        : "Mídia"
    : "";
  const replyAuthor =
    replyTo && (replyTo.direction === "inbound" || replyTo.senderType === "contact")
      ? contactName || "Contato"
      : "Você";

  return (
    <div className="fixed top-0 left-0 right-0 h-[calc(100dvh-64px-env(safe-area-inset-bottom,0px))] md:left-16 lg:left-56 md:h-[100dvh] flex flex-col bg-surface-base">
      {/* Onboarding spotlight — wrapper colapsa (empty:hidden) quando não há dica */}
      <div className="shrink-0 px-4 pt-4 md:px-6 empty:hidden">
        <SpotlightTooltip spotlightId="inbox" organizationId={organizationId} />
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
      {/* Conversations List */}
      <div
        className={cn(
          "w-full md:w-80 lg:w-96 bg-surface-raised md:border-r md:border-border flex flex-col min-h-0",
          showMessages && "hidden md:flex"
        )}
      >
        <div className="p-4 border-b border-border space-y-2.5">
          <h2 className="text-lg font-semibold text-text-primary">Conversas</h2>
          <div className="relative">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
            />
            <input
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Buscar nas mensagens..."
              className={cn(
                "w-full h-9 pl-9 pr-8 rounded-full text-sm bg-surface-sunken border border-border-strong",
                "text-text-primary placeholder:text-text-muted",
                "focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500",
                "[&::-webkit-search-cancel-button]:hidden"
              )}
              aria-label="Buscar nas mensagens"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
                aria-label="Limpar busca"
              >
                <X size={14} />
              </button>
            )}
          </div>
          {!isSearching && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <button
                type="button"
                onClick={() => setShowArchived(false)}
                className={cn(
                  "shrink-0 h-7 px-2.5 rounded-full text-xs border transition-colors",
                  !showArchived
                    ? "bg-brand-500/15 border-brand-500 text-brand-500 font-medium"
                    : "border-border-strong text-text-muted hover:text-text-primary"
                )}
              >
                Ativas
              </button>
              <button
                type="button"
                onClick={() => setShowArchived(true)}
                className={cn(
                  "shrink-0 h-7 px-2.5 rounded-full text-xs border transition-colors",
                  showArchived
                    ? "bg-brand-500/15 border-brand-500 text-brand-500 font-medium"
                    : "border-border-strong text-text-muted hover:text-text-primary"
                )}
              >
                Arquivadas
              </button>
              {conversationLabels && conversationLabels.length > 0 && (
                <span className="shrink-0 h-4 w-px bg-border-strong mx-0.5" />
              )}
              {(conversationLabels ?? []).map((label) => (
                <button
                  key={label._id}
                  type="button"
                  onClick={() =>
                    setFilterLabelId((cur) => (cur === label._id ? null : label._id))
                  }
                  className={cn(
                    "shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border transition-colors",
                    filterLabelId === label._id
                      ? "bg-surface-overlay border-border-strong text-text-primary font-medium"
                      : "border-border-strong text-text-muted hover:text-text-primary"
                  )}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  {label.name}
                </button>
              ))}
              <button
                type="button"
                onClick={() => (selectionMode ? exitSelection() : setSelectionMode(true))}
                className={cn(
                  "ml-auto shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border transition-colors",
                  selectionMode
                    ? "bg-brand-500/15 border-brand-500 text-brand-500 font-medium"
                    : "border-border-strong text-text-muted hover:text-text-primary"
                )}
                title="Selecionar várias conversas"
              >
                <CheckSquare size={12} />
                {selectionMode ? "Cancelar" : "Selecionar"}
              </button>
            </div>
          )}
          {isSearching && (
            <div className="flex items-center gap-2">
              <input
                type="month"
                value={searchMonth}
                onChange={(e) => setSearchMonth(e.target.value)}
                className={cn(
                  "h-8 px-2.5 rounded-full text-xs bg-surface-sunken border border-border-strong text-text-secondary",
                  "focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500",
                  searchMonth && "border-brand-500 text-text-primary"
                )}
                aria-label="Filtrar por mês"
              />
              {searchMonth && (
                <button
                  type="button"
                  onClick={() => setSearchMonth("")}
                  className="text-xs text-text-muted hover:text-text-primary transition-colors"
                >
                  Limpar mês
                </button>
              )}
              <span className="ml-auto text-xs text-text-muted tabular-nums">
                {searchResults === undefined ? "…" : `${searchResults.length} resultado${searchResults.length === 1 ? "" : "s"}`}
              </span>
            </div>
          )}
        </div>

        <div className="overflow-y-auto flex-1">
          {isSearching ? (
            searchResults === undefined ? (
              <div className="p-6 flex justify-center">
                <Spinner size="md" />
              </div>
            ) : searchResults.length === 0 ? (
              <div className="p-4 text-center text-text-muted text-sm">
                Nada encontrado{searchMonth ? " nesse mês" : ""} para "{debouncedTerm}"
              </div>
            ) : (
              searchResults.map((result) => (
                <button
                  key={result._id}
                  type="button"
                  onClick={() => handleOpenSearchResult(result)}
                  className="w-full text-left p-4 border-b border-border hover:bg-surface-overlay transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {result.contactName}
                      {result.direction !== "inbound" && (
                        <span className="text-text-muted font-normal"> · você</span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-text-muted tabular-nums">
                      {new Date(result.createdAt).toLocaleDateString("pt-BR", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="text-xs text-text-secondary truncate flex items-center gap-1">
                    {result.matchedTranscript && (
                      <Mic size={11} className="shrink-0 text-text-muted" aria-label="Encontrado na transcrição" />
                    )}
                    <span className="truncate">
                      {renderSnippet(result.snippetText, debouncedTerm.trim())}
                    </span>
                  </p>
                </button>
              ))
            )
          ) : listedConversations.length === 0 ? (
            <div className="p-4 text-center text-text-muted">
              {showArchived
                ? "Nenhuma conversa arquivada"
                : filterLabelId
                  ? "Nenhuma conversa com essa etiqueta"
                  : "Nenhuma conversa ainda"}
            </div>
          ) : (
            listedConversations.map((conversation) => (
              <div
                key={conversation._id}
                onClick={() =>
                  selectionMode
                    ? toggleSelected(conversation._id)
                    : handleSelectConversation(conversation._id)
                }
                className={cn(
                  "p-4 border-b border-border cursor-pointer transition-colors",
                  "hover:bg-surface-overlay active:bg-surface-overlay",
                  !selectionMode &&
                    selectedConversation === conversation._id &&
                    "bg-brand-500/10 border-l-2 border-l-brand-500",
                  selectionMode && selectedIds.has(conversation._id) && "bg-brand-500/10"
                )}
              >
                <div className="flex items-center justify-between mb-2">
                  {selectionMode && (
                    <span
                      className={cn(
                        "mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                        selectedIds.has(conversation._id)
                          ? "bg-brand-500 border-brand-500 text-white"
                          : "border-border-strong"
                      )}
                      aria-hidden
                    >
                      {selectedIds.has(conversation._id) && <Check size={11} />}
                    </span>
                  )}
                  <h3 className="flex items-center gap-1.5 min-w-0 flex-1 font-medium text-text-primary truncate">
                    <span className="truncate">
                      {conversation.contact?.firstName} {conversation.contact?.lastName}
                    </span>
                    {((conversation.labelIds ?? []) as string[]).map((labelId) => {
                      const label = labelById.get(labelId);
                      return label ? (
                        <span
                          key={labelId}
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: label.color }}
                          title={label.name}
                        />
                      ) : null;
                    })}
                  </h3>
                  <Badge variant={getChannelBadgeVariant(conversation.channel)}>
                    {conversation.channel}
                  </Badge>
                </div>

                {conversation.lead && (
                  <div className="flex items-center gap-1.5 mb-1 min-w-0">
                    <p className="flex-1 min-w-0 text-sm text-text-secondary truncate">
                      {conversation.lead.title}
                    </p>
                    {isHandoffPending(conversation.lead.handoffState) && (
                      <span
                        className="shrink-0 inline-flex items-center gap-1 rounded-full bg-semantic-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-semantic-warning"
                        title="Repasse pendente — aguardando um humano assumir"
                      >
                        <ArrowLeftRight size={12} />
                        Repasse
                      </span>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  {conversation.lastMessagePreview ? (
                    <span className="flex items-center gap-1 min-w-0 text-xs text-text-muted">
                      {(() => {
                        const PreviewIcon = getPreviewIcon(
                          conversation.lastMessageContentType ?? null,
                          conversation.lastMessageBridgeType ?? null
                        );
                        return PreviewIcon ? <PreviewIcon className="w-3.5 h-3.5 shrink-0" /> : null;
                      })()}
                      <span className="truncate">
                        {conversation.lastMessageDirection === "outbound" ? "Você: " : ""}
                        {conversation.lastMessagePreview}
                      </span>
                    </span>
                  ) : (
                    <span className="text-xs text-text-muted tabular-nums">
                      {conversation.messageCount} {conversation.messageCount === 1 ? "mensagem" : "mensagens"}
                    </span>
                  )}
                  <div className="flex items-center gap-2 shrink-0">
                    {conversation.assignee && (
                      <Avatar
                        name={conversation.assignee.name || "?"}
                        type={conversation.assignee.type === "ai" ? "ai" : "human"}
                        size="sm"
                      />
                    )}
                    {conversation.lastMessageAt && (
                      <span className="text-xs text-text-muted tabular-nums">
                        {new Date(conversation.lastMessageAt).toLocaleDateString("pt-BR")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
          {conversations && conversations.length === 200 && (
            <div className="text-center py-2">
              <span className="text-xs text-text-muted">
                Mostrando as 200 conversas mais recentes
              </span>
            </div>
          )}
        </div>

        {selectionMode && (
          <div className="shrink-0 border-t border-border bg-surface-raised p-3 flex items-center gap-2">
            <span className="flex-1 text-xs text-text-secondary tabular-nums">
              {selectedIds.size} selecionada{selectedIds.size === 1 ? "" : "s"}
            </span>
            <div className="relative">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={selectedIds.size === 0}
                onClick={() => setBulkLabelOpen((v) => !v)}
              >
                Etiquetar
              </Button>
              {bulkLabelOpen && (
                <div className="absolute bottom-full right-0 mb-1 z-40 w-52 py-1 bg-surface-overlay border border-border rounded-xl shadow-elevated">
                  {(conversationLabels ?? []).length === 0 ? (
                    <p className="px-3 py-2 text-xs text-text-muted">
                      Nenhuma etiqueta — crie uma no menu ⋯ de uma conversa
                    </p>
                  ) : (
                    (conversationLabels ?? []).map((label) => (
                      <button
                        key={label._id}
                        type="button"
                        onClick={() => handleBulkLabelClick(label._id)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-raised transition-colors"
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: label.color }}
                        />
                        {label.name}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              disabled={selectedIds.size === 0}
              onClick={handleBulkArchiveClick}
            >
              {showArchived ? "Desarquivar" : "Arquivar"}
            </Button>
          </div>
        )}
      </div>

      {/* Messages */}
      <div
        className={cn(
          "flex-1 flex flex-col bg-surface-base min-h-0",
          !showMessages && "hidden md:flex"
        )}
      >
        {selectedConversation ? (
          <>
            {/* Mobile header with back button */}
            <div className="md:hidden shrink-0 p-4 border-b border-border bg-surface-raised flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <button
                  onClick={handleBackToList}
                  className="p-2 -ml-2 text-text-primary hover:bg-surface-overlay rounded-full transition-colors"
                  aria-label="Voltar"
                >
                  <ArrowLeft size={20} />
                </button>
                <h2 className="flex-1 min-w-0 truncate text-base font-semibold text-text-primary">
                  {currentConversation?.contact?.firstName} {currentConversation?.contact?.lastName}
                </h2>
                {currentConversation && (
                  <ConversationActionsMenu
                    organizationId={organizationId}
                    conversationId={currentConversation._id as Id<"conversations">}
                    archivedAt={currentConversation.archivedAt}
                    labelIds={(currentConversation.labelIds ?? []) as string[]}
                    onArchivedChange={(archived) => {
                      if (archived && !showArchived) handleBackToList();
                    }}
                  />
                )}
              </div>
              {funnelLine && <div className="pl-11">{funnelLine}</div>}
              {contactTyping && (
                <span className="pl-11 text-xs text-brand-500 animate-pulse">digitando…</span>
              )}
              {aiStatus?.active && currentConversation && channelIsWhatsapp &&
                aiControlsAllowed && (
                <div className="pl-11 flex flex-wrap items-center gap-2">
                  <AiConversationControls
                    conversationId={currentConversation._id as Id<"conversations">}
                    aiPausedUntil={currentConversation.aiPausedUntil as number | undefined}
                    hasPendingDraft={hasPendingDraft}
                  />
                  {aiChip && (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                        aiChip.tone === "processing"
                          ? "bg-brand-500/10 text-brand-400"
                          : "bg-surface-overlay text-text-muted"
                      )}
                    >
                      {aiChip.label}
                    </span>
                  )}
                </div>
              )}
              {windowInfo && (
                <div className={cn("flex items-center gap-1 pl-11 text-xs", windowInfo.tone)}>
                  <Clock className="h-3.5 w-3.5 shrink-0" />
                  {windowInfo.text}
                </div>
              )}
            </div>

            {/* Desktop header */}
            <div className="hidden md:flex shrink-0 p-4 border-b border-border bg-surface-raised items-center justify-between">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-text-primary truncate">
                  {currentConversation?.contact?.firstName} {currentConversation?.contact?.lastName}
                </h2>
                {funnelLine}
                {contactTyping && (
                  <span className="text-xs text-brand-500 animate-pulse">digitando…</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {aiStatus?.active && currentConversation && channelIsWhatsapp &&
                aiControlsAllowed && (
                  <>
                    <AiConversationControls
                      conversationId={currentConversation._id as Id<"conversations">}
                      aiPausedUntil={currentConversation.aiPausedUntil as number | undefined}
                      hasPendingDraft={hasPendingDraft}
                    />
                    {aiChip && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                          aiChip.tone === "processing"
                            ? "bg-brand-500/10 text-brand-400"
                            : "bg-surface-overlay text-text-muted"
                        )}
                      >
                        {aiChip.label}
                      </span>
                    )}
                  </>
                )}
                {windowInfo && (
                  <div className={cn("flex items-center gap-1.5 text-sm", windowInfo.tone)}>
                    <Clock className="h-4 w-4 shrink-0" />
                    {windowInfo.text}
                  </div>
                )}
                {currentConversation && (
                  <ConversationActionsMenu
                    organizationId={organizationId}
                    conversationId={currentConversation._id as Id<"conversations">}
                    archivedAt={currentConversation.archivedAt}
                    labelIds={(currentConversation.labelIds ?? []) as string[]}
                    onArchivedChange={(archived) => {
                      if (archived && !showArchived) handleBackToList();
                    }}
                  />
                )}
              </div>
            </div>

            {/* Repasse pendente — uma vez só, abaixo dos dois headers */}
            {handoffPending && (
              <div className="shrink-0 border-b border-semantic-warning/40 bg-semantic-warning/5 px-4 py-2.5">
                <div className="max-w-4xl mx-auto w-full flex flex-col sm:flex-row sm:items-center gap-2">
                  <p className="flex items-start gap-2 flex-1 min-w-0 text-sm">
                    <ArrowLeftRight size={16} className="mt-0.5 shrink-0 text-semantic-warning" />
                    <span className="min-w-0">
                      <span className="font-medium text-semantic-warning">Repasse pendente</span>
                      {openHandoffState?.reason && (
                        <span className="text-text-secondary"> — {openHandoffState.reason}</span>
                      )}
                    </span>
                  </p>
                  {canReply && (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        disabled={!pendingHandoff}
                        onClick={handleAcceptHandoff}
                      >
                        Aceitar e assumir
                      </Button>
                      {pendingHandoff && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            navigate(`${TAB_ROUTES.handoffs}?handoff=${pendingHandoff._id}`)
                          }
                        >
                          Ver repasse
                        </Button>
                      )}
                      {currentConversation && (
                        <ReturnToAiButton
                          conversationId={currentConversation._id as Id<"conversations">}
                          variant="button"
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Messages List */}
            <div
              ref={messagesScrollRef}
              onScroll={handleMessagesScroll}
              className="flex-1 min-h-0 overflow-y-auto"
            >
              <div className="min-h-full flex flex-col justify-end max-w-4xl mx-auto w-full p-4 space-y-4">
                {messages && messages.length === 500 && (
                  <div className="text-center py-2 mb-2">
                    <span className="text-xs text-text-muted bg-surface-overlay inline-block px-3 py-1.5 rounded-full">
                      Exibindo as últimas 500 mensagens
                    </span>
                  </div>
                )}
                {(messages as InboxMessage[] | undefined)?.map((message) =>
                  getAiDraft(message) ? (
                    // Rascunho do atendente IA (modo sugestão): revisão humana
                    <AiDraftCard key={message._id} message={message} />
                  ) : (
                    <MessageBubble
                      key={message._id}
                      message={message}
                      channelIsWhatsapp={channelIsWhatsapp}
                      canInteract={canReply}
                      currentMemberId={currentMemberId}
                      contactName={contactName}
                      transcribing={transcribingIds.has(message._id)}
                      highlighted={highlightId === message._id}
                      onReply={setReplyTo}
                      onReact={handleReact}
                      onForward={setForwardTarget}
                      onTranscribe={handleTranscribe}
                      onJumpToMessage={handleJumpToMessage}
                    />
                  )
                )}
              </div>
            </div>

            {/* Message Input */}
            {canReply ? (
              <form onSubmit={handleSendMessage} className="shrink-0 border-t border-border bg-surface-raised">
                <div className="max-w-4xl mx-auto w-full p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Checkbox
                    checked={isInternal}
                    onChange={(e) => setIsInternal(e.target.checked)}
                    label="Nota interna"
                  />
                  {isInternal && (
                    <Badge variant="warning">Visível apenas para membros da equipe</Badge>
                  )}
                </div>

                {/* Reply citation bar */}
                {replyTo && !isInternal && (
                  <div className="flex items-center gap-2 mb-2 pl-2 pr-1 py-1.5 border-l-2 border-brand-500 bg-surface-sunken rounded-r-lg">
                    <Reply size={15} className="shrink-0 text-brand-400" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-brand-400">
                        Respondendo {replyAuthor}
                      </p>
                      <p className="text-xs text-text-secondary truncate">{replyPreview}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplyTo(null)}
                      className="shrink-0 p-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
                      aria-label="Cancelar resposta"
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}

                {scheduledPending && scheduledPending.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {scheduledPending.map((item) => (
                      <ScheduledPendingRow
                        key={item._id}
                        item={item}
                        onCancel={() => handleCancelScheduled(item._id)}
                      />
                    ))}
                  </div>
                )}
                {stagedFiles.length > 1 && channelIsWhatsapp && (
                  <p className="text-xs text-text-muted mb-2">
                    WhatsApp: apenas o primeiro anexo será enviado
                  </p>
                )}
                <div className="relative flex gap-2 items-end">
                  <QuickReplyDropdown
                    open={quickReplies.open}
                    items={quickReplies.items}
                    activeIndex={quickReplies.activeIndex}
                    onPick={quickReplies.pick}
                    onManage={() => quickReplies.setManageOpen(true)}
                  />
                  {!recorderActive && (
                    <>
                      <FileUploadButton
                        organizationId={organizationId}
                        uploadedFiles={stagedFiles}
                        onFilesUploaded={(newFiles) => setStagedFiles((prev) => [...prev, ...newFiles])}
                        onFilesRemoved={(fileId) =>
                          setStagedFiles((prev) => prev.filter((f) => f.fileId !== fileId))
                        }
                        className="shrink-0"
                      />
                      <EmojiPickerButton onPick={insertEmoji} />
                      <MentionTextarea
                        inputRef={composerInputRef}
                        value={newMessage}
                        onChange={(value) => {
                          setNewMessage(value);
                          handleComposerActivity();
                        }}
                        onKeyDown={(e) => {
                          if (quickReplies.handleKeyDown(e)) return;
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            if (newMessage.trim() || stagedFiles.length > 0) {
                              handleSendMessage(e as unknown as React.FormEvent);
                            }
                          }
                        }}
                        teamMembers={teamMembers ?? []}
                        mentionEnabled={isInternal}
                        placeholder={isInternal ? "Escreva uma nota interna... Use @ para mencionar" : "Digite uma mensagem..."}
                        rows={1}
                        className={cn(
                          "bg-surface-sunken",
                          isInternal
                            ? "border-semantic-warning/30 focus:border-semantic-warning focus:ring-semantic-warning/20"
                            : "border-border-strong focus:border-brand-500 focus:ring-brand-500/20"
                        )}
                      />
                    </>
                  )}

                  {!showVoice && !isInternal && newMessage.trim() && (
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => (scheduleOpen ? setScheduleOpen(false) : openSchedule())}
                        className={cn(
                          "p-2 rounded-full text-text-muted hover:text-brand-500 hover:bg-brand-500/10 transition-colors",
                          scheduleOpen && "text-brand-500 bg-brand-500/10"
                        )}
                        aria-label="Agendar mensagem"
                        title="Agendar mensagem"
                      >
                        <Clock size={18} />
                      </button>
                      {scheduleOpen && (
                        <div className="absolute bottom-full right-0 mb-2 z-40 w-64 p-3 bg-surface-overlay border border-border rounded-xl shadow-elevated space-y-2.5">
                          <p className="text-xs font-medium text-text-primary">Enviar em</p>
                          <input
                            type="datetime-local"
                            value={scheduleValue}
                            onChange={(e) => setScheduleValue(e.target.value)}
                            className="w-full h-9 px-2.5 rounded-lg text-sm bg-surface-sunken border border-border-strong text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
                          />
                          <div className="flex justify-end gap-2">
                            {/* type="button" obrigatório: dentro do form, o default
                                "submit" dispararia o envio imediato junto do agendamento */}
                            <Button type="button" variant="ghost" size="sm" onClick={() => setScheduleOpen(false)}>
                              Cancelar
                            </Button>
                            <Button type="button" size="sm" onClick={handleSchedule}>
                              Agendar
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {showVoice ? (
                    <VoiceRecorder
                      organizationId={organizationId}
                      onActiveChange={setRecorderActive}
                      onRecorded={handleSendVoice}
                    />
                  ) : (
                    <Button
                      type="submit"
                      disabled={!newMessage.trim() && stagedFiles.length === 0}
                      variant={isInternal ? "secondary" : "primary"}
                      size="md"
                      className={cn(
                        "shrink-0",
                        isInternal && "bg-semantic-warning hover:bg-amber-600 text-white"
                      )}
                      aria-label={isInternal ? "Adicionar Nota" : "Enviar"}
                    >
                      <Send size={16} />
                      <span className="hidden sm:inline">{isInternal ? "Adicionar Nota" : "Enviar"}</span>
                    </Button>
                  )}
                </div>
                </div>
              </form>
            ) : (
              <div className="shrink-0 p-4 border-t border-border bg-surface-raised text-center">
                <p className="text-sm text-text-muted">Você não tem permissão para enviar mensagens.</p>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-text-muted">
            Selecione uma conversa para ver as mensagens
          </div>
        )}
      </div>
    </div>

      {/* Deep-link ?conversation= fora da lista carregada (arquivada ou antiga) */}
      {conversationParam && !conversationInList && (
        <ErrorBoundary key={conversationParam} fallback={<></>}>
          <ConversationDeepLinkResolver
            conversationId={conversationParam as Id<"conversations">}
            onResolve={handleResolveLinkedConversation}
          />
        </ErrorBoundary>
      )}

      <ForwardModal
        open={!!forwardTarget}
        organizationId={organizationId}
        message={forwardTarget}
        currentConversationId={selectedConversation}
        onClose={() => setForwardTarget(null)}
      />
      <QuickRepliesModal
        organizationId={organizationId}
        open={quickReplies.manageOpen}
        onClose={() => quickReplies.setManageOpen(false)}
      />
      <ConfirmDialog
        open={!!confirmBulk}
        onClose={() => setConfirmBulk(null)}
        onConfirm={() => {
          const pending = confirmBulk;
          setConfirmBulk(null);
          if (!pending) return;
          if (pending.action === "archive") void runBulkArchive();
          else if (pending.labelId) void runBulkLabel(pending.labelId);
        }}
        title={
          confirmBulk?.action === "archive"
            ? `${showArchived ? "Desarquivar" : "Arquivar"} ${selectedIds.size} conversas?`
            : `Etiquetar ${selectedIds.size} conversas?`
        }
        description={
          confirmBulk?.action === "archive"
            ? showArchived
              ? "As conversas selecionadas voltam para a lista de ativas."
              : "As conversas selecionadas saem da lista de ativas. Dá para desarquivar depois."
            : "A etiqueta será aplicada a todas as conversas selecionadas."
        }
        confirmLabel="Confirmar"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Mensagem agendada pendente — linha com contagem regressiva         */
/* ------------------------------------------------------------------ */

function ScheduledPendingRow({
  item,
  onCancel,
}: {
  item: { _id: string; content: string; scheduledAt: number; createdAt: number };
  onCancel: () => void;
}) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const total = Math.max(1, item.scheduledAt - item.createdAt);
  const elapsed = Math.min(total, Math.max(0, tick - item.createdAt));
  const progress = (elapsed / total) * 100;
  const remainingMs = Math.max(0, item.scheduledAt - tick);

  const remainingLabel = (() => {
    const s = Math.ceil(remainingMs / 1000);
    if (s <= 0) return "enviando…";
    if (s < 60) return `em ${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `em ${m}min ${String(s % 60).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    return `em ${h}h${String(m % 60).padStart(2, "0")}`;
  })();

  return (
    <div className="rounded-lg bg-surface-sunken border border-border overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <Clock size={12} className="shrink-0 text-brand-500" />
        <span className="shrink-0 text-text-secondary tabular-nums">
          {new Date(item.scheduledAt).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <span className="flex-1 min-w-0 truncate text-text-muted">{item.content}</span>
        <span className="shrink-0 text-brand-500 font-medium tabular-nums">{remainingLabel}</span>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 p-1 rounded-full text-text-muted hover:text-semantic-error hover:bg-surface-raised transition-colors"
          aria-label="Cancelar agendamento"
        >
          <X size={12} />
        </button>
      </div>
      <div className="h-0.5 bg-surface-raised">
        <div
          className="h-full bg-brand-500 transition-[width] duration-1000 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
