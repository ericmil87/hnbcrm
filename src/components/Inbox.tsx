import { usePageTitle } from "@/hooks/usePageTitle";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOutletContext, useNavigate } from "react-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { TAB_ROUTES } from "@/lib/routes";
import { VOCAB } from "@/lib/vocab";
import { toast } from "sonner";
import { Send, ArrowLeft, ArrowLeftRight, Clock, X, Reply } from "lucide-react";
import { cn } from "@/lib/utils";
import { assignableMembers } from "@/lib/teamMembers";
import { mutationErrorMessage } from "@/lib/errors";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Badge } from "@/components/ui/Badge";
import { shouldShowAccount } from "@/lib/channelAccounts";
import {
  channelSupports,
  formatTextCounter,
  measureText,
  textLimitFor,
  textNeedsSplit,
  textPartsCount,
  mediaSendBlocked,
  MEDIA_BLOCKED_HINT,
} from "@/lib/channelCapabilities";
import {
  STANDBY_BANNER_TEXT,
  type ServiceWindowKind,
  getServiceWindowInfo,
  isComposerBlockedByWindow,
} from "@/lib/serviceWindow";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { useKeepPrevious } from "@/hooks/useKeepPrevious";
import { useInfiniteSentinel } from "@/hooks/useInfiniteSentinel";
import { useInboxFilters } from "@/hooks/useInboxFilters";
import { useConversationList } from "@/hooks/useConversationList";
import { useConversationSelection } from "@/hooks/useConversationSelection";
import { useBulkConversationSelection } from "@/hooks/useBulkConversationSelection";
import {
  MESSAGES_DEFAULT_LIMIT,
  MESSAGES_MAX_LIMIT,
  LOAD_MORE_STEP,
  SEARCH_JUMP_STEP,
  canLoadMore,
  limitForKey,
  nextLimit,
  scrollTopAfterPrepend,
} from "@/lib/inboxPaging";
import { MentionTextarea } from "@/components/ui/MentionTextarea";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { extractMentionIds } from "@/lib/mentions";
import { filterConversations } from "@/lib/inboxState";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";
import { FileUploadButton, type UploadedFile } from "@/components/ui/FileUploadButton";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { ForwardModal } from "@/components/inbox/ForwardModal";
import { NewConversationModal } from "@/components/inbox/NewConversationModal";
import { VoiceRecorder } from "@/components/inbox/VoiceRecorder";
import { EmojiPickerButton } from "@/components/inbox/EmojiPickerButton";
import { useQuickReplies, QuickReplyDropdown, QuickRepliesModal } from "@/components/inbox/QuickReplies";
import { AiDraftCard, getAiDraft } from "@/components/inbox/AiDraftCard";
import { AttentionBanner, usePendingAttentionCount } from "@/components/inbox/AttentionBanner";
import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import { ConversationList } from "@/components/inbox/ConversationList";
import type { ConversationListEntry } from "@/components/inbox/ConversationListItem";
import { GroupConversationPanels, useGroupPanels } from "@/components/inbox/GroupConversationPanels";
import { useGroupMode } from "@/components/inbox/useGroupMode";
import { ScheduledPendingRow } from "@/components/inbox/ScheduledPendingRow";
import { LeadDetailPanel } from "@/components/LeadDetailPanel";
import { ContactDetailPanel } from "@/components/ContactDetailPanel";
import { mentionTokensFor } from "@/components/inbox/GroupMentionText";
import { useGroupMentions, GroupMentionDropdown } from "@/components/inbox/GroupMentionComposer";
import { InboxQueueBar } from "@/components/inbox/central/InboxQueueBar";
import { ConversationRoutingBar } from "@/components/inbox/central/ConversationRoutingBar";
import { TransferEvent } from "@/components/inbox/central/CentralChips";
import { getReactions, isMediaPlaceholder, isVoiceNote, type InboxMessage } from "@/components/inbox/types";

/**
 * Resolve o `?conversation=` que não está na lista carregada (fora do lote carregado
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
  usePageTitle(VOCAB.conversations.title);
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const { can, member } = usePermissions(organizationId);
  const currentMemberId = member?._id ?? null;
  const canStartConversation = can("inbox", "reply");
  const sendableChannels = useQuery(
    api.startConversation.listSendableWhatsappChannels,
    canStartConversation ? { organizationId } : "skip"
  );
  const showNewConversation = canStartConversation && (sendableChannels?.length ?? 0) > 0;
  const [newMessage, setNewMessage] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<UploadedFile[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Busca em mensagens (a lista vira lista de resultados). O termo já chega
  // com debounce do SearchInput.
  const [searchTerm, setSearchTerm] = useState("");
  const [searchMonth, setSearchMonth] = useState(""); // "YYYY-MM" ou ""
  const isSearching = searchTerm.trim().length >= 2;

  // Filtros (URL: arquivadas e etiqueta; localStorage: tipo e canal; Central: fila),
  // lista em lotes, conversa aberta (`?conversation=`, `?nova=`) e seleção em lote.
  const filters = useInboxFilters(organizationId);
  const { showArchived, kindFilter, filterLabelId, conversationLabels, centralModules, centralEnabled } = filters;
  const list = useConversationList({
    organizationId,
    showArchived,
    queueArgs: filters.queueArgs,
    channelArgs: filters.channelArgs,
    isSearching,
  });
  const { validConversations } = list;
  const selection = useConversationSelection({
    validConversations,
    listLoaded: list.conversations !== undefined,
    showArchived,
    setShowArchived: filters.setShowArchived,
    kindFilter,
    onSelectionChange: () => resetConversationState(),
    onDraft: setNewMessage,
  });
  const { selectedConversation, showMessages, currentConversation } = selection;
  const bulk = useBulkConversationSelection({ organizationId, showArchived });
  const attentionCount = usePendingAttentionCount(organizationId, can("inbox", "view_own"));

  // Onda 2 interaction state.
  const [replyTo, setReplyTo] = useState<InboxMessage | null>(null);
  const [forwardTarget, setForwardTarget] = useState<InboxMessage | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());
  const [describingIds, setDescribingIds] = useState<Set<string>>(() => new Set());
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(() => new Set());
  const [recorderActive, setRecorderActive] = useState(false);

  // Painéis sobrepostos à conversa (lead / contato) — trocar de conversa fecha.
  const [showLeadPanel, setShowLeadPanel] = useState(false);
  const [showContactPanel, setShowContactPanel] = useState(false);
  useEffect(() => {
    setShowLeadPanel(false);
    setShowContactPanel(false);
  }, [selectedConversation]);
  // Grupo: membros, resumo, contato de um membro e confirmações (também fecham ao trocar).
  const groupPanels = useGroupPanels(selectedConversation);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  // IA da org (opt-in): controla os controles de IA no header + rascunhos.
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  // Thread: as 50 mensagens mais RECENTES; "Carregar mensagens anteriores"
  // sobe de 50 em 50 até 500. O limite é por conversa (trocar volta a 50).
  const [messagePage, setMessagePage] = useState<{ key: string | null; limit: number }>(() => ({
    key: null,
    limit: MESSAGES_DEFAULT_LIMIT,
  }));
  const messageLimit = limitForKey(messagePage, selectedConversation, MESSAGES_DEFAULT_LIMIT);
  const messagesRaw = useQuery(
    api.conversations.getMessages,
    selectedConversation
      ? { conversationId: selectedConversation as Id<"conversations">, limit: messageLimit }
      : "skip"
  );
  const messages = useKeepPrevious(messagesRaw, selectedConversation);
  const loadingOlderMessages = messagesRaw === undefined && messages !== undefined;

  // Recorte do mês selecionado → range [início, fim] em ms.
  const monthRange = (() => {
    if (!/^\d{4}-\d{2}$/.test(searchMonth)) return null;
    const [y, m] = searchMonth.split("-").map(Number);
    return {
      dateFrom: new Date(y, m - 1, 1).getTime(),
      dateTo: new Date(y, m, 1).getTime() - 1,
    };
  })();

  const searchResults = useQuery(
    api.conversations.searchMessages,
    isSearching
      ? {
          organizationId,
          searchQuery: searchTerm,
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

  const sendMessage = useMutation(api.conversations.sendMessage);
  const reactToMessage = useMutation(api.conversations.reactToMessage);
  const markConversationRead = useMutation(api.conversations.markConversationRead);
  const sendTypingState = useMutation(api.conversations.sendTypingState);
  const transcribe = useAction(api.transcription.transcribe);
  const describeImage = useAction(api.vision.describeImage);
  const downloadDeferredMedia = useAction(api.groupChats.downloadDeferredMedia);
  // Visão é um AND (D10 do plano): IA ativa na org E leitura de imagens ligada.
  const visionEnabled = Boolean(aiStatus?.active && aiStatus?.visionEnabled);
  // IA em grupos (F4): o mestre da org + o interruptor do produto. Os recursos
  // POR GRUPO (responder, radar, digest) ficam na política de cada sala.
  const groupAiEnabled = Boolean(aiStatus?.active && aiStatus?.groupAgentEnabled);

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
      // Menção também no agendado: o "@fulano" sobrevivia como TEXTO mas não
      // notificava ninguém na entrega (achado menor do review de correção).
      const trimmed = newMessage.trim();
      const memberMentions = isGroupConversation ? groupMentions.mentionsFor(trimmed) : [];
      await scheduleMessage({
        conversationId: selectedConversation as Id<"conversations">,
        content: trimmed,
        scheduledAt,
        ...(memberMentions.length ? { mentions: memberMentions } : {}),
      });
      toast.success(
        `Mensagem agendada para ${new Date(scheduledAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
      );
      setNewMessage("");
      setScheduleOpen(false);
      groupMentions.reset();
      stopTyping();
    } catch (err) {
      toast.error(err instanceof Error ? err.message.split("\n")[0].replace(/^.*Error: /, "") : "Não foi possível agendar.");
    }
  };

  const handleCancelScheduled = async (id: string) => {
    try {
      await cancelScheduled({ scheduledMessageId: id as Id<"scheduledMessages"> });
      toast.success("Agendamento cancelado");
    } catch {
      toast.error("Não foi possível cancelar o agendamento.");
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

  // Rolagem guardada ao pedir o lote de mensagens anteriores: quando ele
  // chega (conteúdo inserido ACIMA), a tela é compensada pela altura nova —
  // sem isso ela pularia para o topo do histórico.
  const prependAnchorRef = useRef<{
    conversationId: string;
    limit: number;
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);

  const handleLoadOlderMessages = () => {
    const el = messagesScrollRef.current;
    if (!selectedConversation) return;
    const limit = nextLimit(messageLimit, LOAD_MORE_STEP, MESSAGES_MAX_LIMIT);
    if (el) {
      prependAnchorRef.current = {
        conversationId: selectedConversation,
        limit,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
      };
    }
    setMessagePage({ key: selectedConversation, limit });
  };

  // Scroll infinito no TOPO da thread: rolar até lá chama o mesmo handler do
  // botão (que tira o snapshot da rolagem ANTES de mudar o limite). A thread
  // abre no fim, então o sentinela nasce fora de vista e não dispara no mount;
  // depois do lote a rolagem é compensada e ele sai de vista de novo.
  const canLoadOlderMessages =
    !!messages && canLoadMore(messages.length, messageLimit, MESSAGES_MAX_LIMIT);
  const olderMessagesSentinelRef = useInfiniteSentinel({
    enabled: canLoadOlderMessages && !loadingOlderMessages,
    loading: loadingOlderMessages,
    onReach: handleLoadOlderMessages,
    root: messagesScrollRef,
    resetKey: selectedConversation,
  });

  // On conversation switch: force-scroll to the newest message. On new messages:
  // only stick to the bottom if the user was already near it (reading history stays put).
  useLayoutEffect(() => {
    const el = messagesScrollRef.current;
    if (!el || !messages) return;
    const anchor = prependAnchorRef.current;
    if (anchor && anchor.conversationId !== selectedConversation) prependAnchorRef.current = null;
    if (
      anchor &&
      anchor.conversationId === selectedConversation &&
      anchor.limit === messageLimit &&
      messagesRaw !== undefined
    ) {
      prependAnchorRef.current = null;
      el.scrollTop = scrollTopAfterPrepend(anchor, el.scrollHeight);
      return;
    }
    const switched = scrolledConvRef.current !== selectedConversation;
    if (switched) {
      scrolledConvRef.current = selectedConversation;
      nearBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, messagesRaw, messageLimit, selectedConversation]);

  const labelById = new Map((conversationLabels ?? []).map((l) => [l._id as string, l]));
  // Os chips aparecem quando há grupo na lista OU quando o filtro guardado não
  // é "Todas" (review de correção nº 17). Sem a segunda condição, um filtro
  // "Grupos" persistido numa sessão anterior escondia os próprios chips assim
  // que a org parava de acompanhar as salas: a caixa ficava vazia para sempre,
  // sem controle na tela para voltar.
  const hasGroupConversations =
    validConversations.some((c) => c.kind === "group") || kindFilter !== "all";
  const filteredConversations = filterConversations(validConversations, {
    kind: kindFilter,
    labelId: filterLabelId,
  });
  const listedConversations: ConversationListEntry[] = selection.pinnedConversation
    ? [selection.pinnedConversation as ConversationListEntry, ...filteredConversations]
    : filteredConversations;
  // Capacidades do canal da conversa aberta (matriz em lib/channelCapabilities).
  const convChannel: string | undefined = currentConversation?.channel;
  const convTransport: string | undefined = currentConversation?.channelProvider;
  const canSendTyping = channelSupports(convChannel, convTransport, "typingIndicator");
  const canUseAiAttendant = channelSupports(convChannel, convTransport, "aiAttendant");
  const canRecordVoice = channelSupports(convChannel, convTransport, "voiceRecorder");
  const isWhatsappConversation = convChannel === "whatsapp";
  const mediaBlocked = mediaSendBlocked(convChannel, convTransport) && !isInternal;
  const textLimit = textLimitFor(convChannel, convTransport);
  const contactName =
    `${currentConversation?.contact?.firstName ?? ""} ${currentConversation?.contact?.lastName ?? ""}`.trim();

  // ── Conversa de GRUPO (v0.57): sala, assunto, membros e nomes por JID ──
  const {
    isGroupConversation,
    groupChatId,
    groupChat,
    groupSubject,
    groupParticipantsCount,
    groupNameByKey,
  } = useGroupMode(currentConversation, messages);
  // Mexer na sala (acompanhar, entrar, sair) é `settings:manage` (D11).
  const canManageGroups = can("settings", "manage");
  // Disparar para os membros é campanha (F5), não configuração de canal.
  const canManageCampaigns = can("campaigns", "manage");

  /** Abre o wizard de campanha já preenchido com este grupo (F5). */
  const dispatchToGroupMembers = (source: "group_members" | "manual", phones?: string[]) => {
    if (!groupChatId) return;
    const params =
      source === "manual" && phones && phones.length > 0
        ? `source=manual&sourceGroupChatId=${groupChatId}&phones=${encodeURIComponent(phones.join(","))}`
        : `source=group_members&groupChatId=${groupChatId}`;
    navigate(`${TAB_ROUTES.campaigns}?novo=1&${params}`);
  };

  // Menção a membro no grupo: o "@" busca os membros no servidor, o texto
  // recebe "@<nome>" e os JIDs escolhidos viajam em `mentions[]` no envio.
  const groupMentions = useGroupMentions({
    groupChatId: isGroupConversation ? groupChatId : undefined,
    value: newMessage,
    enabled: isGroupConversation && !isInternal,
    onChange: (next, cursorPosition) => {
      setNewMessage(next);
      requestAnimationFrame(() => {
        const el = composerInputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(cursorPosition, cursorPosition);
      });
    },
  });

  const openContactId = currentConversation?.contact?._id as Id<"contacts"> | undefined;
  const openLeadId = currentConversation?.leadId as Id<"leads"> | undefined;

  // Com um rascunho já aguardando revisão, pedir outra sugestão não faz
  // sentido (o backend recusa um segundo turno enfileirado na mesma conversa).
  const hasPendingDraft = ((messages ?? []) as InboxMessage[]).some(
    (m) => getAiDraft(m)?.status === "pending"
  );

  // "digitando..." do contato — TTL de 12s no cliente (o "paused" pode se perder).
  // Fase 4b: a presença saiu do doc da conversa (cada "digitando" reexecutava a
  // lista e o thread); só a conversa ABERTA assina a query leve de presença.
  const contactPresence =
    useQuery(
      api.conversations.getConversationPresence,
      currentConversation?._id
        ? { conversationId: currentConversation._id as Id<"conversations"> }
        : "skip"
    ) ?? undefined;
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
    if (typingLastSentRef.current !== 0 && selectedConversation && canSendTyping) {
      typingLastSentRef.current = 0;
      sendTypingState({
        conversationId: selectedConversation as Id<"conversations">,
        state: "paused",
      }).catch(() => {});
    }
  };

  // Throttled "composing" on keystroke; "paused" after 3s idle. WhatsApp only.
  const handleComposerActivity = () => {
    if (!selectedConversation || !canSendTyping || isInternal) return;
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
    if (composerBlocked) return;

    try {
      const mentionedUserIds = isInternal ? extractMentionIds(trimmed) : undefined;
      const attachments = stagedFiles.map((f) => f.fileId);
      // Só os JIDs cujo "@<nome>" sobreviveu no texto — quem apagou a menção
      // não quer mais notificar aquela pessoa.
      const memberMentions =
        isGroupConversation && !isInternal ? groupMentions.mentionsFor(trimmed) : [];

      await sendMessage({
        conversationId: selectedConversation as Id<"conversations">,
        content: trimmed,
        contentType: attachments.length ? deriveContentType(stagedFiles) : "text",
        isInternal,
        attachments: attachments.length ? attachments : undefined,
        mentionedUserIds: mentionedUserIds?.length ? mentionedUserIds : undefined,
        replyToMessageId: !isInternal && replyTo ? (replyTo._id as Id<"messages">) : undefined,
        mentions: memberMentions.length ? memberMentions : undefined,
      });
      setNewMessage("");
      setStagedFiles([]);
      setReplyTo(null);
      groupMentions.reset();
      stopTyping();
    } catch (error) {
      toast.error("Não foi possível enviar a mensagem. Tente de novo.");
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
      toast.error("Não foi possível reagir à mensagem.");
    }
  };

  const handleTranscribe = async (message: InboxMessage) => {
    setTranscribingIds((prev) => new Set(prev).add(message._id));
    try {
      const result = await transcribe({ organizationId, messageId: message._id as Id<"messages"> });
      if (result.status === "failed") toast.error("Não foi possível transcrever o áudio.");
    } catch {
      toast.error("Não foi possível transcrever o áudio.");
    } finally {
      setTranscribingIds((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(message._id);
        return nextSet;
      });
    }
  };

  const handleDescribeImage = async (message: InboxMessage) => {
    setDescribingIds((prev) => new Set(prev).add(message._id));
    try {
      const result = await describeImage({
        organizationId,
        messageId: message._id as Id<"messages">,
      });
      if (result.status === "failed") toast.error("Não foi possível ler a imagem");
    } catch {
      toast.error("Não foi possível ler a imagem");
    } finally {
      setDescribingIds((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(message._id);
        return nextSet;
      });
    }
  };

  // Mídia de grupo que a política não baixou (v0.62): o servidor devolve o
  // motivo em PT-BR pronto (vencida, quota…); o sucesso aparece sozinho, pela
  // query reativa trocando o placeholder pelo arquivo.
  const handleDownloadMedia = async (message: InboxMessage) => {
    setDownloadingIds((prev) => new Set(prev).add(message._id));
    try {
      const result = await downloadDeferredMedia({
        organizationId,
        messageId: message._id as Id<"messages">,
      });
      if (!result.ok) toast.error(result.reason);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível baixar a mídia"));
    } finally {
      setDownloadingIds((prev) => {
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
    // Só decide com o lote do limite ATUAL na tela (não com o anterior que
    // fica visível enquanto o maior carrega).
    if (!target || !messagesRaw || !selectedConversation) return;
    const el = document.getElementById(`msg-${target}`);
    if (!el) {
      // Fora do lote carregado: sobe o limite (de 100 em 100) e tenta de novo
      // quando o lote chegar; lote incompleto ou teto = não há mais o que buscar.
      if (canLoadMore(messagesRaw.length, messageLimit, MESSAGES_MAX_LIMIT)) {
        setMessagePage({
          key: selectedConversation,
          limit: nextLimit(messageLimit, SEARCH_JUMP_STEP, MESSAGES_MAX_LIMIT),
        });
      } else {
        pendingJumpRef.current = null;
        toast(
          messageLimit >= MESSAGES_MAX_LIMIT
            ? "Mensagem antiga demais para exibir aqui"
            : "A mensagem original não está carregada"
        );
      }
      return;
    }
    pendingJumpRef.current = null;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(target);
    window.setTimeout(() => {
      setHighlightId((cur) => (cur === target ? null : cur));
    }, 2000);
  }, [messagesRaw, messageLimit, selectedConversation]);

  const handleJumpToMessage = (messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) {
      // Fora do lote carregado: o efeito do salto pendente sobe o limite e
      // tenta de novo quando o lote chegar.
      if (
        selectedConversation &&
        messages &&
        canLoadMore(messages.length, messageLimit, MESSAGES_MAX_LIMIT)
      ) {
        pendingJumpRef.current = messageId;
        setMessagePage({
          key: selectedConversation,
          limit: nextLimit(messageLimit, SEARCH_JUMP_STEP, MESSAGES_MAX_LIMIT),
        });
      } else {
        toast(
          messageLimit >= MESSAGES_MAX_LIMIT
            ? "Mensagem antiga demais para exibir aqui"
            : "A mensagem original não está carregada"
        );
      }
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
    groupMentions.reset();
    stopTyping();
    lastReadSigRef.current = null;
  };

  const handleSelectConversation = (conversationId: string) => selection.select(conversationId);
  const handleBackToList = selection.close;

  // Conversa iniciada/reaberta: abre no mesmo caminho do deep-link, inclusive
  // no mobile (lista → mensagens). A aba volta para "ativas" (na mesma escrita
  // da URL) e um filtro "Grupos" é desfeito — senão a conversa abriria sem
  // aparecer na lista.
  const handleNewConversationStarted = (conversationId: Id<"conversations">) => {
    if (kindFilter === "group") filters.setKindFilter("all");
    selection.select(conversationId, { archived: null });
  };

  const handleOpenSearchResult = (result: { _id: string; conversationId: string }) => {
    if (result.conversationId === selectedConversation) {
      selection.setShowMessages(true);
      handleJumpToMessage(result._id);
      return;
    }
    pendingJumpRef.current = result._id;
    handleSelectConversation(result.conversationId);
  };

  if (!list.conversations) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  // Janela de serviço por canal. `template` = WhatsApp Cloud API (24h, requer
  // template); `wait` = Instagram/Messenger (só o cliente reabre). Bridge
  // (não oficial) reporta serviceWindowApplies === false — sem janela. Sem o
  // campo novo do backend, WhatsApp com janela cai em `template` como antes.
  const windowKind: ServiceWindowKind =
    !currentConversation || currentConversation.serviceWindowApplies === false
      ? null
      : (currentConversation as { serviceWindowKind?: ServiceWindowKind }).serviceWindowKind ??
        (convChannel === "whatsapp" ? "template" : null);
  const windowExpiresAt: number | null = currentConversation?.serviceWindowExpiresAt ?? null;
  const windowResult = getServiceWindowInfo(windowKind, windowExpiresAt, now);
  const windowInfo = windowResult
    ? {
        text: windowResult.text,
        tone: windowResult.closed ? ("text-semantic-warning" as const) : ("text-text-secondary" as const),
      }
    : null;
  // Instagram/Messenger com janela fechada: o composer fica bloqueado (nota interna segue livre).
  const composerBlocked = isComposerBlockedByWindow(windowKind, windowExpiresAt, now) && !isInternal;

  // Outro app (ex.: Caixa de entrada do Business Suite) controla a conversa
  // quando a última mensagem recebida veio em standby.
  const lastInboundMessage = (messages ?? []).reduce<any>(
    (acc, m: any) =>
      m.direction === "inbound" && !m.isInternal && (!acc || m.createdAt >= acc.createdAt) ? m : acc,
    null
  );
  const standbyActive = lastInboundMessage?.metadata?.standby === true;

  // Contador de texto (Instagram: bytes; Messenger: caracteres). Não bloqueia.
  const textCounter =
    textLimit && !isInternal && newMessage.length > 0
      ? {
          label: formatTextCounter(measureText(newMessage, textLimit.unit), textLimit),
          parts: textPartsCount(newMessage, textLimit),
          over: textNeedsSplit(newMessage, textLimit),
        }
      : null;

  // Controles de IA (pausar/retomar) aparecem em canais oficiais sempre, e em
  // canais bridge (não-oficiais) só depois do aceite de risco específico do
  // atendente — não mexe na janela de 24h/templates do composer acima.
  const aiControlsAllowed =
    currentConversation?.serviceWindowApplies !== false || aiStatus?.bridgeAiAckDone === true;
  const showAiControls = Boolean(
    aiStatus?.active && canUseAiAttendant && aiControlsAllowed && !isGroupConversation
  );

  const canReply = can("inbox", "reply");
  // Voice recorder / mic replaces the send button when there's nothing typed.
  const composerEmpty = newMessage.trim() === "" && stagedFiles.length === 0;
  const showVoice =
    canRecordVoice && !isInternal && canReply && (recorderActive || composerEmpty);

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

  // O container fixo começa ABAIXO do header sticky do AppShell (h-14/h-16) —
  // top-0 deixava o topo da página (spotlight) atrás do sino de notificações.
  return (
    <div className="fixed top-14 md:top-16 left-0 right-0 h-[calc(100dvh-3.5rem-64px-env(safe-area-inset-bottom,0px))] md:left-16 lg:left-56 md:h-[calc(100dvh-4rem)] flex flex-col bg-surface-base">
      {/* Onboarding spotlight — wrapper colapsa (empty:hidden) quando não há dica */}
      <div className="shrink-0 px-4 pt-4 md:px-6 empty:hidden">
        <SpotlightTooltip spotlightId="inbox" organizationId={organizationId} />
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
      <ConversationList
        className={cn(
          // Central ligada: a coluna não encolhe (a barra de filas e a de
          // roteamento disputavam espaço e a lista caía para ~230 px).
          centralEnabled && "md:shrink-0",
          showMessages && "hidden md:flex"
        )}
        conversations={listedConversations}
        selectedId={selectedConversation}
        labelById={labelById}
        accountFor={(c) => (c.channelConfigId ? filters.accountById.get(c.channelConfigId) ?? null : null)}
        showAccountFor={(c) => shouldShowAccount(filters.channelAccounts, c.channel)}
        centralFor={
          centralEnabled
            ? (c) => {
                if (c.kind === "group") return undefined;
                return {
                  unit: centralModules.units && c.unitId ? filters.unitById.get(c.unitId) : undefined,
                  department:
                    centralModules.departments && c.departmentId
                      ? filters.departmentById.get(c.departmentId)
                      : undefined,
                  attribution: centralModules.attribution ? c.lead?.attribution ?? undefined : undefined,
                };
              }
            : undefined
        }
        onSelect={handleSelectConversation}
        onNewConversation={showNewConversation ? selection.openNewConversation : undefined}
        attentionBanner={<AttentionBanner count={attentionCount} />}
        queueBar={
          filters.queuesEnabled ? (
            <InboxQueueBar
              queues={filters.inboxQueues}
              showDepartments={centralModules.departments}
              showUnits={centralModules.units}
              value={filters.queueFilter}
              onChange={filters.setQueueFilter}
            />
          ) : undefined
        }
        search={{
          term: searchTerm,
          onTermChange: (term) => {
            setSearchTerm(term);
            if (!term) setSearchMonth("");
          },
          active: isSearching,
          month: searchMonth,
          onMonthChange: setSearchMonth,
          results: searchResults,
          onOpenResult: handleOpenSearchResult,
        }}
        filters={{
          showArchived,
          onShowArchivedChange: filters.setShowArchived,
          kind: kindFilter,
          onKindChange: filters.setKindFilter,
          showKindFilter: hasGroupConversations,
          channel: filters.channelFilter,
          onChannelChange: filters.updateChannelFilter,
          channelChipVisible: filters.channelChipVisible,
          channelOptions: filters.channelOptions,
          accountChoices: filters.accountChoices,
          labels: conversationLabels ?? [],
          labelId: filterLabelId,
          onLabelChange: filters.setFilterLabelId,
          queueFilterActive: filters.queueFilterActive,
        }}
        selection={{
          mode: bulk.selectionMode,
          onToggleMode: () => (bulk.selectionMode ? bulk.exitSelection() : bulk.setSelectionMode(true)),
          selectedIds: bulk.selectedIds,
          onToggle: bulk.toggleSelected,
          onArchive: bulk.handleBulkArchiveClick,
          onLabel: bulk.handleBulkLabelClick,
        }}
        paging={{
          canLoadMore: list.canLoadMore,
          loadingMore: list.loadingMore,
          reachedMax: list.reachedMax,
          maxLimit: list.maxLimit,
          onLoadMore: list.loadMore,
          scrollRef: list.scrollRef,
          sentinelRef: list.sentinelRef,
        }}
        onChooseGroups={() => navigate(TAB_ROUTES.groups)}
      />

      {/* Messages */}
      <div
        className={cn(
          "flex-1 flex flex-col bg-surface-base min-h-0",
          centralEnabled && "min-w-0",
          !showMessages && "hidden md:flex"
        )}
      >
        {selectedConversation ? (
          <>
            {currentConversation ? (
              <ConversationHeader
                key={currentConversation._id}
                organizationId={organizationId}
                conversation={currentConversation}
                canReply={canReply}
                isGroup={isGroupConversation}
                groupSubject={groupSubject}
                groupParticipantsCount={groupParticipantsCount}
                groupMenu={
                  isGroupConversation
                    ? {
                        canManageGroups,
                        canManageCampaigns,
                        canReply,
                        groupAiEnabled,
                        onOpenMembers: () => groupPanels.setShowMembersPanel(true),
                        onOpenSummary: () => groupPanels.setShowGroupSummary(true),
                        onUnmonitor: () => groupPanels.setConfirmGroupAction("unmonitor"),
                        onLeave: () => groupPanels.setConfirmGroupAction("leave"),
                        onDispatch: () => dispatchToGroupMembers("group_members"),
                      }
                    : undefined
                }
                channelAccounts={filters.channelAccounts}
                accountById={filters.accountById}
                aiActive={Boolean(aiStatus?.active)}
                showAiControls={showAiControls}
                hasPendingDraft={hasPendingDraft}
                contactTyping={contactTyping}
                windowInfo={windowInfo}
                onBack={handleBackToList}
                onOpenContact={() => setShowContactPanel(true)}
                onOpenLead={() => setShowLeadPanel(true)}
                onOpenMembers={() => groupPanels.setShowMembersPanel(true)}
                onArchivedChange={(archived) => {
                  if (archived && !showArchived) handleBackToList();
                }}
                onLeadDeleted={handleBackToList}
              >
            {/* Central (opcional): unidade/setor/responsável/tipo/desfecho + origem */}
            {centralEnabled && currentConversation && !isGroupConversation && (
              <ConversationRoutingBar
                key={currentConversation._id}
                organizationId={organizationId}
                conversationId={currentConversation._id as Id<"conversations">}
                modules={centralModules}
                lead={
                  currentConversation.lead
                    ? {
                        _id: currentConversation.lead._id as Id<"leads">,
                        boardId: currentConversation.lead.boardId as Id<"boards">,
                        value: currentConversation.lead.value as number | undefined,
                        customFields: currentConversation.lead.customFields as
                          | Record<string, unknown>
                          | undefined,
                      }
                    : null
                }
                canReply={canReply}
                canEditLead={can("leads", "edit_own")}
                teamMembers={assignableMembers(teamMembers ?? [])}
              />
            )}

            {/* Outro app controla a conversa (standby): só recebemos, composer livre */}
            {standbyActive && !isGroupConversation && (
              <div className="shrink-0 border-b border-semantic-warning/40 bg-semantic-warning/5 px-4 py-2.5">
                <p className="max-w-4xl mx-auto w-full flex items-start gap-2 text-sm text-text-secondary">
                  <ArrowLeftRight size={16} className="mt-0.5 shrink-0 text-semantic-warning" />
                  <span className="min-w-0">{STANDBY_BANNER_TEXT}</span>
                </p>
              </div>
            )}

              </ConversationHeader>
            ) : (
              <div className="md:hidden shrink-0 p-2 border-b border-border bg-chat-header">
                <button
                  type="button"
                  onClick={handleBackToList}
                  className="flex h-11 w-11 items-center justify-center text-text-primary hover:bg-surface-overlay rounded-full transition-colors"
                  aria-label="Voltar"
                >
                  <ArrowLeft size={20} />
                </button>
              </div>
            )}

            {/* Messages List */}
            <div
              ref={messagesScrollRef}
              onScroll={handleMessagesScroll}
              className="flex-1 min-h-0 overflow-y-auto bg-chat-bg chat-wallpaper"
            >
              <div className="min-h-full flex flex-col justify-end max-w-4xl mx-auto w-full p-4 space-y-4">
                {messages &&
                (loadingOlderMessages ||
                  canLoadMore(messages.length, messageLimit, MESSAGES_MAX_LIMIT)) ? (
                  <div className="text-center py-2 mb-2">
                    <div ref={olderMessagesSentinelRef} aria-hidden="true" className="h-px" />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleLoadOlderMessages}
                      disabled={loadingOlderMessages}
                      aria-busy={loadingOlderMessages}
                    >
                      {loadingOlderMessages ? (
                        <span className="inline-flex items-center gap-2">
                          <Spinner size="sm" />
                          Carregando mensagens anteriores…
                        </span>
                      ) : (
                        "Carregar mensagens anteriores"
                      )}
                    </Button>
                  </div>
                ) : messages && messages.length >= MESSAGES_MAX_LIMIT ? (
                  <div className="text-center py-2 mb-2">
                    <span className="text-xs text-bubble-system-fg bg-bubble-system inline-block px-3 py-1.5 rounded-full">
                      Exibindo as últimas {MESSAGES_MAX_LIMIT} mensagens
                    </span>
                  </div>
                ) : null}
                {(messages as InboxMessage[] | undefined)?.map((message) =>
                  message.metadata?.kind === "transfer" && message.metadata?.transfer ? (
                    // Transferência de setor (Central): evento de sistema, não bolha
                    <TransferEvent
                      key={message._id}
                      actorName={message.sender?.name ?? null}
                      transfer={message.metadata.transfer}
                      createdAt={message.createdAt}
                    />
                  ) : getAiDraft(message) ? (
                    // Rascunho do atendente IA (modo sugestão): revisão humana
                    <AiDraftCard key={message._id} message={message} />
                  ) : (
                    <MessageBubble
                      key={message._id}
                      message={message}
                      channel={convChannel}
                      transport={convTransport}
                      canInteract={canReply}
                      currentMemberId={currentMemberId}
                      contactName={contactName}
                      transcribing={transcribingIds.has(message._id)}
                      describing={describingIds.has(message._id)}
                      downloadingMedia={downloadingIds.has(message._id)}
                      visionEnabled={visionEnabled}
                      highlighted={highlightId === message._id}
                      group={
                        isGroupConversation
                          ? {
                              mentionTokens: mentionTokensFor(message.mentions, groupNameByKey),
                              onOpenContact: (contactId) =>
                                groupPanels.setMemberContactId(contactId as Id<"contacts">),
                            }
                          : undefined
                      }
                      onReply={setReplyTo}
                      onReact={handleReact}
                      onForward={setForwardTarget}
                      onTranscribe={handleTranscribe}
                      onDescribeImage={(m) => void handleDescribeImage(m)}
                      {...(canReply
                        ? { onDownloadMedia: (m: InboxMessage) => void handleDownloadMedia(m) }
                        : {})}
                      onJumpToMessage={handleJumpToMessage}
                    />
                  )
                )}
              </div>
            </div>

            {/* Message Input */}
            {canReply ? (
              <form onSubmit={handleSendMessage} className="shrink-0 border-t border-border bg-composer">
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
                {stagedFiles.length > 1 && isWhatsappConversation && (
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
                  <GroupMentionDropdown
                    open={groupMentions.open}
                    items={groupMentions.items}
                    activeIndex={groupMentions.activeIndex}
                    onPick={groupMentions.pick}
                    pending={groupMentions.pending}
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
                        disabled={composerBlocked || mediaBlocked}
                        disabledHint={mediaBlocked ? MEDIA_BLOCKED_HINT : undefined}
                        channel={convChannel}
                        transport={convTransport}
                      />
                      <EmojiPickerButton onPick={insertEmoji} />
                      <MentionTextarea
                        inputRef={composerInputRef}
                        value={newMessage}
                        onChange={(value) => {
                          setNewMessage(value);
                          // O "@" do grupo depende da posição do cursor, que só
                          // existe no DOM depois que o React aplica o valor.
                          requestAnimationFrame(() =>
                            groupMentions.setCursor(
                              composerInputRef.current?.selectionStart ?? value.length
                            )
                          );
                          handleComposerActivity();
                        }}
                        onKeyDown={(e) => {
                          if (groupMentions.handleKeyDown(e)) return;
                          if (quickReplies.handleKeyDown(e)) return;
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            if (newMessage.trim() || stagedFiles.length > 0) {
                              handleSendMessage(e as unknown as React.FormEvent);
                            }
                          }
                        }}
                        teamMembers={assignableMembers(teamMembers)}
                        mentionEnabled={isInternal}
                        disabled={composerBlocked}
                        placeholder={
                          isInternal
                            ? "Escreva uma nota interna... Use @ para mencionar"
                            : composerBlocked
                              ? "Janela fechada — aguarde o cliente escrever de novo"
                              : isGroupConversation
                              ? "Mensagem para o grupo... Use @ para mencionar um membro"
                              : "Digite uma mensagem..."
                        }
                        rows={1}
                        className={cn(
                          "bg-composer-field",
                          isInternal
                            ? "border-semantic-warning/30 focus:border-semantic-warning focus:ring-semantic-warning/20"
                            : "border-border-strong focus:border-brand-500 focus:ring-brand-500/20"
                        )}
                      />
                    </>
                  )}

                  {!showVoice && !isInternal && !composerBlocked && newMessage.trim() && (
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
                      disabled={composerBlocked || (!newMessage.trim() && stagedFiles.length === 0)}
                      variant={isInternal ? "secondary" : "primary"}
                      size="md"
                      className={cn(
                        "shrink-0",
                        isInternal && "bg-semantic-warning hover:bg-semantic-warning/90 text-white"
                      )}
                      aria-label={isInternal ? "Adicionar Nota" : "Enviar"}
                    >
                      <Send size={16} />
                      <span className="hidden sm:inline">{isInternal ? "Adicionar Nota" : "Enviar"}</span>
                    </Button>
                  )}
                </div>
                {textCounter && (
                  <p
                    className={cn(
                      "mt-1 text-right text-xs tabular-nums",
                      textCounter.over ? "text-semantic-warning" : "text-text-muted"
                    )}
                    aria-live="polite"
                  >
                    {textCounter.label}
                    {textCounter.over && ` — a mensagem será enviada em cerca de ${textCounter.parts} partes`}
                  </p>
                )}
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
      {selection.deepLinkId && (
        <ErrorBoundary key={selection.deepLinkId} fallback={<></>}>
          <ConversationDeepLinkResolver
            conversationId={selection.deepLinkId as Id<"conversations">}
            onResolve={selection.handleResolveLinkedConversation}
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
        open={!!bulk.confirmBulk}
        onClose={() => bulk.setConfirmBulk(null)}
        onConfirm={bulk.confirmPending}
        title={
          bulk.confirmBulk?.action === "archive"
            ? `${showArchived ? "Desarquivar" : "Arquivar"} ${bulk.selectedIds.size} conversas?`
            : `Etiquetar ${bulk.selectedIds.size} conversas?`
        }
        description={
          bulk.confirmBulk?.action === "archive"
            ? showArchived
              ? "As conversas selecionadas voltam para a lista de ativas."
              : "As conversas selecionadas saem da lista de ativas. Dá para desarquivar depois."
            : "A etiqueta será aplicada a todas as conversas selecionadas."
        }
        confirmLabel="Confirmar"
      />

      {showNewConversation && (
        <NewConversationModal
          organizationId={organizationId}
          open={selection.novaOpen}
          onClose={selection.closeNewConversation}
          initialContactId={selection.novaContactId}
          onStarted={handleNewConversationStarted}
        />
      )}

      {/* Painéis sobrepostos à conversa */}
      {showLeadPanel && openLeadId && (
        <LeadDetailPanel
          leadId={openLeadId}
          organizationId={organizationId}
          onClose={() => setShowLeadPanel(false)}
          initialTab="details"
        />
      )}
      {showContactPanel && openContactId && (
        <ContactDetailPanel
          contactId={openContactId}
          onClose={() => setShowContactPanel(false)}
        />
      )}

      {/* Grupo: resumo por IA, membros (e o contato de um membro) e confirmações */}
      {isGroupConversation && groupChatId && (
        <GroupConversationPanels
          organizationId={organizationId}
          groupChatId={groupChatId}
          groupSubject={groupSubject}
          groupChat={groupChat}
          panels={groupPanels}
          onDispatchSelected={
            canManageCampaigns ? (phones) => dispatchToGroupMembers("manual", phones) : undefined
          }
          onLeft={handleBackToList}
        />
      )}
    </div>
  );
}
