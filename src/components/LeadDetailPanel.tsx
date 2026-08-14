import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { TAB_ROUTES } from "@/lib/routes";
import { SlideOver } from "@/components/ui/SlideOver";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  X,
  Search,
  ChevronDown,
  User,
  UserPlus,
  Link as LinkIcon,
  ExternalLink,
  Info,
  CheckSquare,
  Plus,
  Phone,
  Mail,
  CalendarClock,
  Users,
  Microscope,
  ClipboardList,
  Send,
  Reply,
} from "lucide-react";
import { MentionTextarea } from "@/components/ui/MentionTextarea";
import { EmojiPickerButton } from "@/components/inbox/EmojiPickerButton";
import { useQuickReplies, QuickReplyDropdown, QuickRepliesModal } from "@/components/inbox/QuickReplies";
import { extractMentionIds } from "@/lib/mentions";
import { CreateTaskModal } from "./CreateTaskModal";
import { LeadDocuments } from "./LeadDocuments";
import { FileUploadButton, UploadedFile } from "@/components/ui/FileUploadButton";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { AiDraftCard, getAiDraft } from "@/components/inbox/AiDraftCard";
import { ForwardModal } from "@/components/inbox/ForwardModal";
import {
  getReactions,
  isMediaPlaceholder,
  isVoiceNote,
  type InboxMessage,
} from "@/components/inbox/types";

interface LeadDetailPanelProps {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  onClose: () => void;
}

type Tab = "conversation" | "details" | "tasks" | "activity";

export function LeadDetailPanel({ leadId, organizationId, onClose }: LeadDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>("conversation");

  const tabLabels: Record<Tab, string> = {
    conversation: "Conversa",
    details: "Detalhes",
    tasks: "Tarefas",
    activity: "Atividade",
  };

  return (
    <SlideOver
      open={true}
      onClose={onClose}
      title="Detalhes do Lead"
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
    >
      {/* Tab Bar */}
      <div className="flex shrink-0 border-b border-border bg-surface-raised">
        {(["conversation", "details", "tasks", "activity"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex-1 px-4 py-3 text-sm font-medium text-center transition-colors",
              activeTab === tab
                ? "text-brand-500 border-b-2 border-brand-500"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0">
        {activeTab === "conversation" && (
          <ConversationTab
            leadId={leadId}
            organizationId={organizationId}
          />
        )}
        {activeTab === "details" && (
          <div className="h-full overflow-y-auto">
            <DetailsTab leadId={leadId} organizationId={organizationId} />
          </div>
        )}
        {activeTab === "tasks" && (
          <div className="h-full overflow-y-auto">
            <TasksTab leadId={leadId} organizationId={organizationId} />
          </div>
        )}
        {activeTab === "activity" && (
          <div className="h-full overflow-y-auto">
            <ActivityTab leadId={leadId} />
          </div>
        )}
      </div>
    </SlideOver>
  );
}

/* ------------------------------------------------------------------ */
/*  Conversation Tab                                                   */
/* ------------------------------------------------------------------ */

function ConversationTab({
  leadId,
  organizationId,
}: {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
}) {
  const { can, member } = usePermissions(organizationId);
  const currentMemberId = member?._id ?? null;
  const canInteract = can("inbox", "reply");

  const [messageText, setMessageText] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<UploadedFile[]>([]);

  // Inbox-parity interaction state.
  const [replyTo, setReplyTo] = useState<InboxMessage | null>(null);
  const [forwardTarget, setForwardTarget] = useState<InboxMessage | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  const conversations = useQuery(api.conversations.getConversations, {
    organizationId,
    leadId,
  });

  const firstConversation = conversations && conversations.length > 0 ? conversations[0] : null;

  const messages = useQuery(
    api.conversations.getMessages,
    firstConversation ? { conversationId: firstConversation._id } : "skip"
  ) as InboxMessage[] | undefined;

  const sendMessage = useMutation(api.conversations.sendMessage);
  const createConversation = useMutation(api.conversations.createConversation);
  const reactToMessage = useMutation(api.conversations.reactToMessage);
  const markConversationRead = useMutation(api.conversations.markConversationRead);
  const sendTypingState = useMutation(api.conversations.sendTypingState);
  const transcribe = useAction(api.transcription.transcribe);

  const channelIsWhatsapp = firstConversation?.channel === "whatsapp";
  const contactName =
    `${firstConversation?.contact?.firstName ?? ""} ${firstConversation?.contact?.lastName ?? ""}`.trim();

  // ── Paridade com o Inbox: markread + presença nossa + "digitando…" do contato ──

  // Marca inbound como lida quando o painel está aberto e chega inbound novo
  // (mesma guarda por assinatura do Inbox, para não re-disparar no próprio patch).
  const lastReadSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!firstConversation || !messages) return;
    let newestInbound: InboxMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].direction === "inbound") {
        newestInbound = messages[i];
        break;
      }
    }
    if (!newestInbound) return;
    const sig = `${firstConversation._id}:${newestInbound._id}`;
    if (lastReadSigRef.current === sig) return;
    lastReadSigRef.current = sig;
    const conversationId = firstConversation._id as Id<"conversations">;
    const timer = window.setTimeout(() => {
      markConversationRead({ conversationId }).catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [firstConversation, messages, markConversationRead]);

  // Nossa presença: "composing" ao digitar (throttle 4s), "paused" após 3s parado.
  const typingLastSentRef = useRef(0);
  const typingPauseTimerRef = useRef<number | null>(null);

  const stopTyping = () => {
    if (typingPauseTimerRef.current !== null) {
      window.clearTimeout(typingPauseTimerRef.current);
      typingPauseTimerRef.current = null;
    }
    if (typingLastSentRef.current !== 0 && firstConversation && channelIsWhatsapp) {
      typingLastSentRef.current = 0;
      sendTypingState({
        conversationId: firstConversation._id as Id<"conversations">,
        state: "paused",
      }).catch(() => {});
    }
  };

  const handleComposerActivity = () => {
    if (!firstConversation || !channelIsWhatsapp || isInternal) return;
    const ts = Date.now();
    if (ts - typingLastSentRef.current > 4000) {
      typingLastSentRef.current = ts;
      sendTypingState({
        conversationId: firstConversation._id as Id<"conversations">,
        state: "composing",
      }).catch(() => {});
    }
    if (typingPauseTimerRef.current !== null) window.clearTimeout(typingPauseTimerRef.current);
    typingPauseTimerRef.current = window.setTimeout(() => {
      typingLastSentRef.current = 0;
      typingPauseTimerRef.current = null;
      sendTypingState({
        conversationId: firstConversation._id as Id<"conversations">,
        state: "paused",
      }).catch(() => {});
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (typingPauseTimerRef.current !== null) window.clearTimeout(typingPauseTimerRef.current);
    };
  }, []);

  // "digitando…" do contato — TTL de 12s (mesmo comportamento do Inbox).
  const contactPresence = firstConversation?.contactPresence as
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

  // Auto-scroll bookkeeping mirroring the Inbox thread (WhatsApp-style anchoring).
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const scrolledConvRef = useRef<string | null>(null);

  // Composer textarea — usado para inserir emoji na posição do cursor.
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);

  const insertEmoji = (emoji: string) => {
    const el = composerInputRef.current;
    if (!el) {
      setMessageText((v) => v + emoji);
      return;
    }
    const start = el.selectionStart ?? messageText.length;
    const end = el.selectionEnd ?? start;
    setMessageText(messageText.slice(0, start) + emoji + messageText.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // Respostas rápidas — "/" no composer (fora do modo nota interna).
  const quickReplies = useQuickReplies({
    organizationId,
    value: messageText,
    enabled: !isInternal,
    onApply: (content) => {
      setMessageText(content);
      requestAnimationFrame(() => composerInputRef.current?.focus());
    },
  });

  const handleMessagesScroll = () => {
    const el = messagesScrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // On conversation switch: force-scroll to newest. On new messages: only stick
  // to the bottom when the user was already near it.
  useLayoutEffect(() => {
    const el = messagesScrollRef.current;
    if (!el || !messages) return;
    const convId = firstConversation?._id ?? null;
    const switched = scrolledConvRef.current !== convId;
    if (switched) {
      scrolledConvRef.current = convId;
      nearBottomRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, firstConversation?._id]);

  const handleSend = async () => {
    if ((!messageText.trim() && stagedFiles.length === 0) || sending) return;
    setSending(true);

    try {
      let conversationId: Id<"conversations">;

      if (firstConversation) {
        conversationId = firstConversation._id;
      } else {
        conversationId = await createConversation({
          organizationId,
          leadId,
          channel: "internal",
        });
      }

      const trimmed = messageText.trim();
      const mentionedUserIds = isInternal ? extractMentionIds(trimmed) : undefined;
      const attachmentIds = stagedFiles.length > 0
        ? stagedFiles.map((f) => f.fileId)
        : undefined;

      // Determine content type based on attachments
      let contentType: "text" | "image" | "file" | "audio" = "text";
      if (stagedFiles.length > 0) {
        const firstMime = stagedFiles[0].mimeType;
        if (firstMime.startsWith("image/")) contentType = "image";
        else if (firstMime.startsWith("audio/")) contentType = "audio";
        else contentType = "file";
      }

      await sendMessage({
        conversationId,
        content: trimmed || (stagedFiles.length > 0 ? `${stagedFiles.length} arquivo(s) anexado(s)` : ""),
        contentType,
        isInternal,
        attachments: attachmentIds,
        mentionedUserIds: mentionedUserIds?.length ? mentionedUserIds : undefined,
        replyToMessageId: !isInternal && replyTo ? (replyTo._id as Id<"messages">) : undefined,
      });

      setMessageText("");
      setStagedFiles([]);
      setReplyTo(null);
      stopTyping();
    } catch (error) {
      console.error("Failed to send message:", error);
      toast.error("Falha ao enviar mensagem");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (quickReplies.handleKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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
    <div className="flex flex-col h-full">
      {contactTyping && (
        <div className="shrink-0 px-4 py-1.5 border-b border-border bg-surface-raised">
          <span className="text-xs text-brand-500 animate-pulse">
            {contactName || "Contato"} está digitando…
          </span>
        </div>
      )}
      {/* Messages List */}
      <div
        ref={messagesScrollRef}
        onScroll={handleMessagesScroll}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        <div className="min-h-full flex flex-col justify-end p-4 space-y-4">
          {!conversations && (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          )}

          {conversations && conversations.length === 0 && (
            <div className="text-center py-12 text-text-muted text-sm">
              Nenhuma conversa ainda. Envie uma mensagem para iniciar.
            </div>
          )}

          {messages?.map((message) =>
            getAiDraft(message) ? (
              // Rascunho do atendente IA (modo sugestão): revisão humana
              <AiDraftCard key={message._id} message={message} />
            ) : (
              <MessageBubble
                key={message._id}
                message={message}
                channelIsWhatsapp={!!channelIsWhatsapp}
                canInteract={canInteract}
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

      {/* Composer */}
      <div className="shrink-0 border-t border-border p-4 bg-surface-raised">
        <div className="flex items-center gap-2 mb-2">
          <Checkbox
            checked={isInternal}
            onChange={(e) => setIsInternal(e.target.checked)}
            label={<span className="text-xs">Nota interna</span>}
            className="peer-checked:border-semantic-warning peer-checked:bg-semantic-warning"
          />
          {isInternal && (
            <Badge variant="warning" className="text-[10px]">Visível apenas para a equipe</Badge>
          )}
        </div>

        {/* Reply citation bar */}
        {replyTo && !isInternal && (
          <div className="flex items-center gap-2 mb-2 pl-2 pr-1 py-1.5 border-l-2 border-brand-500 bg-surface-sunken rounded-r-lg">
            <Reply size={15} className="shrink-0 text-brand-400" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-brand-400">Respondendo {replyAuthor}</p>
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

        {/* Staged file previews */}
        {stagedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {stagedFiles.map((file) => (
              <div
                key={file.fileId}
                className="flex items-center gap-1.5 px-2 py-1 bg-surface-sunken border border-border rounded-lg text-xs max-w-[200px]"
              >
                <span className="truncate text-text-secondary">{file.name}</span>
                <button
                  type="button"
                  onClick={() => setStagedFiles((prev) => prev.filter((f) => f.fileId !== file.fileId))}
                  className="shrink-0 p-0.5 rounded hover:bg-surface-raised text-text-muted hover:text-semantic-error transition-colors"
                  aria-label={`Remover ${file.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative flex gap-2 items-end">
          <QuickReplyDropdown
            open={quickReplies.open}
            items={quickReplies.items}
            activeIndex={quickReplies.activeIndex}
            onPick={quickReplies.pick}
            onManage={() => quickReplies.setManageOpen(true)}
          />
          <FileUploadButton
            organizationId={organizationId}
            uploadedFiles={stagedFiles}
            onFilesUploaded={(newFiles) => setStagedFiles((prev) => [...prev, ...newFiles])}
            onFilesRemoved={(fileId) => setStagedFiles((prev) => prev.filter((f) => f.fileId !== fileId))}
            disabled={sending}
            className="shrink-0"
          />
          <EmojiPickerButton onPick={insertEmoji} disabled={sending} />
          <MentionTextarea
            inputRef={composerInputRef}
            value={messageText}
            onChange={(value) => {
              setMessageText(value);
              handleComposerActivity();
            }}
            onKeyDown={handleKeyDown}
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
          <Button
            onClick={handleSend}
            disabled={(!messageText.trim() && stagedFiles.length === 0) || sending}
            variant={isInternal ? "secondary" : "primary"}
            size="md"
            className={cn("shrink-0", isInternal && "bg-semantic-warning hover:bg-amber-600 text-white")}
            aria-label={isInternal ? "Adicionar Nota" : "Enviar"}
          >
            <Send size={16} />
            <span className="hidden sm:inline">{isInternal ? "Adicionar Nota" : "Enviar"}</span>
          </Button>
        </div>
      </div>

      <ForwardModal
        open={!!forwardTarget}
        organizationId={organizationId}
        message={forwardTarget}
        currentConversationId={firstConversation?._id ?? null}
        onClose={() => setForwardTarget(null)}
      />
      <QuickRepliesModal
        organizationId={organizationId}
        open={quickReplies.manageOpen}
        onClose={() => quickReplies.setManageOpen(false)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BANT Info Tooltip                                                  */
/* ------------------------------------------------------------------ */

function BantInfoTooltip() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-0.5 rounded-full text-text-muted hover:text-brand-400 hover:bg-brand-500/10 transition-colors"
        aria-label="O que é BANT?"
      >
        <Info size={14} />
      </button>

      {open && (
        <>
          {/* Mobile: fixed overlay */}
          <div className="fixed inset-0 z-40 bg-black/40 sm:hidden" onClick={() => setOpen(false)} />

          {/* Mobile: bottom sheet style */}
          <div className="fixed inset-x-0 bottom-0 z-50 sm:hidden animate-in slide-in-from-bottom">
            <div className="bg-surface-overlay border-t border-border rounded-t-2xl p-5 pb-8 safe-bottom">
              <div className="w-10 h-1 bg-border rounded-full mx-auto mb-4" />
              <BantInfoContent />
              <button
                onClick={() => setOpen(false)}
                className="mt-4 w-full py-2.5 bg-surface-raised text-text-secondary rounded-full text-sm font-medium hover:bg-surface-sunken transition-colors"
              >
                Entendi
              </button>
            </div>
          </div>

          {/* Desktop: popover (opens upward) */}
          <div className="hidden sm:block absolute left-0 bottom-full mb-2 w-72 bg-surface-overlay border border-border rounded-card shadow-elevated z-50 p-4">
            <div className="absolute -bottom-1.5 left-3 w-3 h-3 bg-surface-overlay border-r border-b border-border rotate-45" />
            <BantInfoContent />
          </div>
        </>
      )}
    </div>
  );
}

function BantInfoContent() {
  const items = [
    { letter: "B", label: "Budget", desc: "O prospect tem verba para comprar?" },
    { letter: "A", label: "Authority", desc: "Está falando com quem decide?" },
    { letter: "N", label: "Need", desc: "Existe uma dor real que seu produto resolve?" },
    { letter: "T", label: "Timeline", desc: "Há urgência ou prazo definido?" },
  ];

  return (
    <div>
      <h4 className="text-sm font-semibold text-text-primary mb-1">O que é BANT?</h4>
      <p className="text-xs text-text-secondary mb-3 leading-relaxed">
        Framework de qualificação de leads usado em vendas B2B. Quanto mais critérios atendidos, maior a chance de fechamento.
      </p>
      <div className="space-y-2.5">
        {items.map(({ letter, label, desc }) => (
          <div key={letter} className="flex items-start gap-2.5">
            <span className="flex-shrink-0 w-6 h-6 rounded-md bg-brand-600 text-white text-xs font-bold flex items-center justify-center">
              {letter}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-semibold text-text-primary">{label}</span>
              <p className="text-xs text-text-muted leading-tight">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Custom Fields Section                                              */
/* ------------------------------------------------------------------ */

type FieldDefinition = {
  _id: string;
  name: string;
  key: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "multiselect";
  entityType?: "lead" | "contact";
  options?: string[];
  isRequired: boolean;
  order: number;
};

// `customFields` guarda datas como timestamp (ms) OU string — aceita os dois
// na leitura; a escrita sempre grava timestamp (ms).
function toDateInputValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const d = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function CustomFieldEditor({
  field,
  value,
  onChange,
  onToggleOption,
}: {
  field: FieldDefinition;
  value: unknown;
  onChange: (v: unknown) => void;
  onToggleOption: (option: string) => void;
}) {
  const label = (
    <label className="block text-[13px] font-medium text-text-secondary mb-1">
      {field.name}
      {field.isRequired && <span className="text-semantic-error"> *</span>}
    </label>
  );

  if (field.type === "text") {
    return (
      <div>
        {label}
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          style={{ fontSize: "16px" }}
        />
      </div>
    );
  }

  if (field.type === "number") {
    return (
      <div>
        {label}
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          style={{ fontSize: "16px" }}
        />
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <Checkbox
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        label={<span className="text-sm font-medium text-text-primary">{field.name}</span>}
      />
    );
  }

  if (field.type === "date") {
    return (
      <div>
        {label}
        <input
          type="date"
          value={toDateInputValue(value)}
          onChange={(e) => {
            if (!e.target.value) {
              onChange(undefined);
              return;
            }
            const [y, m, d] = e.target.value.split("-").map(Number);
            onChange(new Date(y, m - 1, d).getTime());
          }}
          className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          style={{ fontSize: "16px" }}
        />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div>
        {label}
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
          style={{ fontSize: "16px" }}
        >
          <option value="">—</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // multiselect
  const selected: string[] = Array.isArray(value) ? (value as string[]) : [];
  return (
    <div>
      {label}
      {(field.options ?? []).length === 0 ? (
        <p className="text-xs text-text-muted">Sem opções configuradas.</p>
      ) : (
        <div className="space-y-1.5">
          {(field.options ?? []).map((opt) => (
            <Checkbox
              key={opt}
              checked={selected.includes(opt)}
              onChange={() => onToggleOption(opt)}
              label={<span className="text-sm text-text-primary">{opt}</span>}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CustomFieldsSection({
  leadId,
  organizationId,
  customFields,
}: {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  customFields: Record<string, unknown>;
}) {
  const navigate = useNavigate();
  // Sem entityType no filtro: traz "lead" + legado (fieldDefinitions antigas,
  // criadas sem entityType, que também valem para lead).
  const allFieldDefs = useQuery(api.fieldDefinitions.getFieldDefinitions, { organizationId }) as
    | FieldDefinition[]
    | undefined;
  const updateLead = useMutation(api.leads.updateLead);
  const [values, setValues] = useState<Record<string, unknown>>(customFields ?? {});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValues(customFields ?? {});
  }, [customFields]);

  const leadFieldDefs = (allFieldDefs ?? [])
    .filter((f) => f.entityType === "lead" || f.entityType === undefined)
    .sort((a, b) => a.order - b.order);

  const setFieldValue = (key: string, value: unknown) => {
    setValues((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const toggleMultiselectOption = (key: string, option: string) => {
    setValues((prev) => {
      const current = Array.isArray(prev[key]) ? (prev[key] as string[]) : [];
      const nextArr = current.includes(option)
        ? current.filter((o) => o !== option)
        : [...current, option];
      const next = { ...prev };
      if (nextArr.length > 0) next[key] = nextArr;
      else delete next[key];
      return next;
    });
  };

  const handleSaveCustomFields = async () => {
    setSaving(true);
    try {
      await updateLead({ leadId, customFields: values });
      toast.success("Campos personalizados atualizados");
    } catch (error: any) {
      toast.error(error?.message || "Falha ao salvar campos personalizados");
    } finally {
      setSaving(false);
    }
  };

  if (allFieldDefs === undefined) {
    return (
      <div>
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Campos Personalizados
        </h3>
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      </div>
    );
  }

  if (leadFieldDefs.length === 0) {
    return (
      <div>
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Campos Personalizados
        </h3>
        <button
          type="button"
          onClick={() => navigate(TAB_ROUTES.settings)}
          className="text-sm text-text-muted hover:text-brand-500 transition-colors"
        >
          Nenhum campo personalizado — criar em Configurações
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
        Campos Personalizados
      </h3>
      <div className="space-y-4">
        {leadFieldDefs.map((field) => (
          <CustomFieldEditor
            key={field._id}
            field={field}
            value={values[field.key]}
            onChange={(v) => setFieldValue(field.key, v)}
            onToggleOption={(option) => toggleMultiselectOption(field.key, option)}
          />
        ))}
        <Button
          onClick={handleSaveCustomFields}
          disabled={saving}
          variant="primary"
          size="md"
          className="w-full"
        >
          {saving ? "Salvando..." : "Salvar Campos"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Details Tab                                                        */
/* ------------------------------------------------------------------ */

function DetailsTab({ leadId, organizationId }: { leadId: Id<"leads">; organizationId: Id<"organizations"> }) {
  const { can } = usePermissions(organizationId);
  const lead = useQuery(api.leads.getLead, { leadId });
  const updateLead = useMutation(api.leads.updateLead);
  const updateQualification = useMutation(api.leads.updateLeadQualification);
  const linkContactMutation = useMutation(api.leads.linkContact);
  const assignLeadMutation = useMutation(api.leads.assignLead);
  const moveLeadToStageMutation = useMutation(api.leads.moveLeadToStage);

  // Contact picker state
  const [showContactPicker, setShowContactPicker] = useState(false);
  const [contactSearchText, setContactSearchText] = useState("");
  const contacts = useQuery(api.contacts.getContacts, { organizationId });

  // Assignee picker state
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  // Stage picker state
  const [showStagePicker, setShowStagePicker] = useState(false);
  const boards = useQuery(api.boards.getBoards, { organizationId });
  const [selectedBoardId, setSelectedBoardId] = useState<Id<"boards"> | null>(null);
  const stages = useQuery(
    api.boards.getStages,
    selectedBoardId ? { boardId: selectedBoardId } : "skip"
  );

  const [title, setTitle] = useState("");
  const [value, setValue] = useState(0);
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [temperature, setTemperature] = useState<"cold" | "warm" | "hot">("cold");
  const [tags, setTags] = useState("");

  const [budget, setBudget] = useState(false);
  const [authority, setAuthority] = useState(false);
  const [need, setNeed] = useState(false);
  const [timeline, setTimeline] = useState(false);
  const bantScore = [budget, authority, need, timeline].filter(Boolean).length;

  const [saving, setSaving] = useState(false);
  const [savingBant, setSavingBant] = useState(false);

  // Populate form when lead data loads
  useEffect(() => {
    if (lead) {
      setTitle(lead.title);
      setValue(lead.value);
      setPriority(lead.priority);
      setTemperature(lead.temperature);
      setTags((lead.tags || []).join(", "));
      setBudget(lead.qualification?.budget ?? false);
      setAuthority(lead.qualification?.authority ?? false);
      setNeed(lead.qualification?.need ?? false);
      setTimeline(lead.qualification?.timeline ?? false);
    }
  }, [lead]);

  if (!lead) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  const handleSaveDetails = async () => {
    setSaving(true);
    try {
      await updateLead({
        leadId,
        title,
        value,
        priority,
        temperature,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
    } catch (error) {
      console.error("Failed to update lead:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBant = async () => {
    setSavingBant(true);
    try {
      const score = [budget, authority, need, timeline].filter(Boolean).length;
      await updateQualification({
        leadId,
        qualification: { budget, authority, need, timeline, score },
      });
    } catch (error) {
      console.error("Failed to update qualification:", error);
    } finally {
      setSavingBant(false);
    }
  };

  // Contact handlers
  const handleLinkContact = async (contactId: Id<"contacts">) => {
    try {
      await linkContactMutation({ leadId, contactId });
      setShowContactPicker(false);
      setContactSearchText("");
      toast.success("Contato vinculado com sucesso");
    } catch (error: any) {
      toast.error(error.message || "Falha ao vincular contato");
    }
  };

  const handleUnlinkContact = async () => {
    try {
      await linkContactMutation({ leadId });
      toast.success("Contato desvinculado com sucesso");
    } catch (error: any) {
      toast.error(error.message || "Falha ao desvincular contato");
    }
  };

  // Assignee handlers
  const handleAssignLead = async (assignedTo?: Id<"teamMembers">) => {
    try {
      await assignLeadMutation({ leadId, assignedTo });
      setShowAssigneePicker(false);
      toast.success(assignedTo ? "Lead atribuído com sucesso" : "Lead desatribuído com sucesso");
    } catch (error: any) {
      toast.error(error.message || "Falha ao atribuir lead");
    }
  };

  // Stage handlers
  const handleMoveToStage = async (stageId: Id<"stages">) => {
    try {
      await moveLeadToStageMutation({ leadId, stageId });
      setShowStagePicker(false);
      setSelectedBoardId(null);
      toast.success("Lead movido com sucesso");
    } catch (error: any) {
      toast.error(error.message || "Falha ao mover lead");
    }
  };

  // Filter contacts by search text
  const filteredContacts = contacts?.filter((contact) => {
    if (!contactSearchText.trim()) return true;
    const searchLower = contactSearchText.toLowerCase();
    const fullName = `${contact.firstName || ""} ${contact.lastName || ""}`.toLowerCase();
    const email = contact.email?.toLowerCase() || "";
    const company = contact.company?.toLowerCase() || "";
    return fullName.includes(searchLower) || email.includes(searchLower) || company.includes(searchLower);
  });

  return (
    <div className="p-4 space-y-6">
      {/* Contact Section - Interactive */}
      <div>
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Contato Vinculado
        </h3>
        {lead.contact ? (
          <div className="bg-surface-sunken rounded-card p-4 space-y-3">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-muted">Nome</span>
                <span className="text-text-primary font-medium">
                  {`${lead.contact.firstName || ""} ${lead.contact.lastName || ""}`.trim() || "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Email</span>
                <span className="text-text-primary">{lead.contact.email || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Telefone</span>
                <span className="text-text-primary">{lead.contact.phone || "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Empresa</span>
                <span className="text-text-primary">{lead.contact.company || "—"}</span>
              </div>
            </div>
            <div className="flex gap-2 pt-2 border-t border-border">
              <Button
                onClick={() => setShowContactPicker(true)}
                variant="secondary"
                size="sm"
                className="flex-1"
              >
                <ExternalLink size={16} />
                Alterar
              </Button>
              <Button
                onClick={handleUnlinkContact}
                variant="ghost"
                size="sm"
                aria-label="Desvincular contato"
              >
                <X size={16} />
              </Button>
            </div>
          </div>
        ) : (
          <div className="bg-surface-sunken rounded-card p-4 text-center">
            <p className="text-sm text-text-muted mb-3">Nenhum contato vinculado</p>
            <Button
              onClick={() => setShowContactPicker(true)}
              variant="primary"
              size="sm"
            >
              <LinkIcon size={16} />
              Vincular Contato
            </Button>
          </div>
        )}

        {/* Contact Picker Dropdown */}
        {showContactPicker && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => {
                setShowContactPicker(false);
                setContactSearchText("");
              }}
            />
            <div className="relative z-50 mt-2 bg-surface-overlay border border-border rounded-xl shadow-xl max-h-80 overflow-hidden">
              <div className="p-3 border-b border-border">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
                  <input
                    type="text"
                    value={contactSearchText}
                    onChange={(e) => setContactSearchText(e.target.value)}
                    placeholder="Buscar contato..."
                    className="w-full pl-9 pr-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
                    style={{ fontSize: "16px" }}
                    autoFocus
                  />
                </div>
                {contacts && contacts.length >= 500 && (
                  <p className="text-xs text-text-muted mt-2">
                    Mostrando os primeiros 500 contatos.
                  </p>
                )}
              </div>
              <div className="overflow-y-auto max-h-64">
                {filteredContacts && filteredContacts.length > 0 ? (
                  filteredContacts.map((contact) => (
                    <button
                      key={contact._id}
                      onClick={() => handleLinkContact(contact._id)}
                      className="w-full px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle last:border-0"
                    >
                      <div className="font-medium text-sm text-text-primary">
                        {`${contact.firstName || ""} ${contact.lastName || ""}`.trim() || "Sem nome"}
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">
                        {contact.email}
                        {contact.company && ` • ${contact.company}`}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">
                    {contacts === undefined ? (
                      <Spinner size="sm" />
                    ) : (
                      "Nenhum contato encontrado"
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Assignee Section */}
      <div className="relative">
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Atribuído a
        </h3>
        {can("leads", "edit_all") ? (
          <button
            onClick={() => setShowAssigneePicker(!showAssigneePicker)}
            className="w-full px-4 py-3 bg-surface-sunken rounded-card text-left hover:bg-surface-raised transition-colors flex items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <User size={16} className="text-text-muted" />
              <span className="text-sm text-text-primary font-medium">
                {lead.assignee ? lead.assignee.name : "Não atribuído"}
              </span>
              {lead.assignee && (
                <Badge variant="default" className="text-xs">
                  {lead.assignee.type === "ai" ? "IA" : lead.assignee.role === "admin" ? "Admin" : lead.assignee.role === "manager" ? "Gerente" : "Agente"}
                </Badge>
              )}
            </div>
            <ChevronDown size={16} className="text-text-muted" />
          </button>
        ) : (
          <div className="w-full px-4 py-3 bg-surface-sunken rounded-card text-left flex items-center gap-2">
            <User size={16} className="text-text-muted" />
            <span className="text-sm text-text-primary font-medium">
              {lead.assignee ? lead.assignee.name : "Não atribuído"}
            </span>
            {lead.assignee && (
              <Badge variant="default" className="text-xs">
                {lead.assignee.type === "ai" ? "IA" : lead.assignee.role === "admin" ? "Admin" : lead.assignee.role === "manager" ? "Gerente" : "Agente"}
              </Badge>
            )}
          </div>
        )}

        {/* Assignee Picker Dropdown */}
        {showAssigneePicker && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowAssigneePicker(false)}
            />
            <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-surface-overlay border border-border rounded-xl shadow-xl max-h-80 overflow-y-auto">
              <button
                onClick={() => handleAssignLead()}
                className={cn(
                  "w-full px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle",
                  !lead.assignedTo && "bg-brand-500/10"
                )}
              >
                <div className="flex items-center gap-2">
                  <UserPlus size={16} className="text-text-muted" />
                  <span className="text-sm text-text-primary font-medium">Não atribuído</span>
                </div>
              </button>
              {teamMembers?.map((member) => (
                <button
                  key={member._id}
                  onClick={() => handleAssignLead(member._id)}
                  className={cn(
                    "w-full px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle last:border-0",
                    lead.assignedTo === member._id && "bg-brand-500/10"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-primary font-medium">{member.name}</span>
                      <Badge variant="default" className="text-xs">
                        {member.type === "ai" ? "IA" : member.role === "admin" ? "Admin" : member.role === "manager" ? "Gerente" : "Agente"}
                      </Badge>
                    </div>
                  </div>
                  {member.email && (
                    <div className="text-xs text-text-muted mt-0.5">{member.email}</div>
                  )}
                </button>
              ))}
              {!teamMembers && (
                <div className="px-4 py-8 text-center">
                  <Spinner size="sm" />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Stage Section */}
      <div className="relative">
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Pipeline e Etapa
        </h3>
        <button
          onClick={() => {
            setShowStagePicker(!showStagePicker);
            if (!showStagePicker && lead.board) {
              setSelectedBoardId(lead.board._id);
            }
          }}
          className="w-full px-4 py-3 bg-surface-sunken rounded-card text-left hover:bg-surface-raised transition-colors flex items-center justify-between"
        >
          <div>
            <div className="text-xs text-text-muted">{lead.board?.name || "Pipeline"}</div>
            <div className="text-sm text-text-primary font-medium mt-0.5">
              {lead.stage?.name || "Sem etapa"}
            </div>
          </div>
          <ChevronDown size={16} className="text-text-muted" />
        </button>

        {/* Stage Picker Dropdown */}
        {showStagePicker && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => {
                setShowStagePicker(false);
                setSelectedBoardId(null);
              }}
            />
            <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-surface-overlay border border-border rounded-xl shadow-xl max-h-96 overflow-hidden">
              {/* Board selector */}
              <div className="p-3 border-b border-border bg-surface-raised">
                <label className="block text-xs text-text-muted mb-1.5">Pipeline</label>
                <select
                  value={selectedBoardId || ""}
                  onChange={(e) => setSelectedBoardId(e.target.value as Id<"boards">)}
                  className="w-full px-3 py-2 bg-surface-sunken border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  style={{ fontSize: "16px" }}
                >
                  <option value="">Selecione um pipeline</option>
                  {boards?.map((board) => (
                    <option key={board._id} value={board._id}>
                      {board.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Stages list */}
              <div className="overflow-y-auto max-h-64">
                {stages && stages.length > 0 ? (
                  stages.map((stage) => (
                    <button
                      key={stage._id}
                      onClick={() => handleMoveToStage(stage._id)}
                      className={cn(
                        "w-full px-4 py-3 text-left hover:bg-surface-raised transition-colors border-b border-border-subtle last:border-0",
                        lead.stageId === stage._id && "bg-brand-500/10"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-text-primary font-medium">{stage.name}</span>
                        {(stage.isClosedWon || stage.isClosedLost) && (
                          <Badge variant={stage.isClosedWon ? "success" : "error"} className="text-xs">
                            {stage.isClosedWon ? "Ganho" : "Perdido"}
                          </Badge>
                        )}
                      </div>
                    </button>
                  ))
                ) : selectedBoardId ? (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">
                    {stages === undefined ? (
                      <Spinner size="sm" />
                    ) : (
                      "Nenhuma etapa encontrada"
                    )}
                  </div>
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-text-muted">
                    Selecione um pipeline acima
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Editable Fields */}
      <div>
        <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">
          Detalhes do Lead
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Título</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Valor</label>
            <input
              type="number"
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Prioridade</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as typeof priority)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="low">Baixa</option>
              <option value="medium">Média</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Temperatura</label>
            <select
              value={temperature}
              onChange={(e) => setTemperature(e.target.value as typeof temperature)}
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              style={{ fontSize: "16px" }}
            >
              <option value="cold">Frio</option>
              <option value="warm">Morno</option>
              <option value="hot">Quente</option>
            </select>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">
              Tags <span className="text-text-muted font-normal">(separadas por vírgula)</span>
            </label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="ex: enterprise, urgente, follow-up"
              className="w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted"
              style={{ fontSize: "16px" }}
            />
          </div>

          <Button
            onClick={handleSaveDetails}
            disabled={saving}
            variant="primary"
            size="md"
            className="w-full"
          >
            {saving ? "Salvando..." : "Salvar Detalhes"}
          </Button>
        </div>
      </div>

      {/* Custom Fields */}
      <CustomFieldsSection
        leadId={leadId}
        organizationId={organizationId}
        customFields={(lead.customFields ?? {}) as Record<string, unknown>}
      />

      {/* BANT Qualification */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide">
            Qualificação BANT
          </h3>
          <BantInfoTooltip />
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 auto-rows-fr">
            {([
              { key: "budget" as const, label: "Orçamento", desc: "O prospect tem verba disponível?", checked: budget, setter: setBudget },
              { key: "authority" as const, label: "Autoridade", desc: "Está falando com o decisor?", checked: authority, setter: setAuthority },
              { key: "need" as const, label: "Necessidade", desc: "Existe uma dor real a resolver?", checked: need, setter: setNeed },
              { key: "timeline" as const, label: "Prazo", desc: "Há urgência ou prazo definido?", checked: timeline, setter: setTimeline },
            ] as const).map(({ key, label, desc, checked, setter }) => (
              <Checkbox
                key={key}
                checked={checked}
                onChange={(e) => setter(e.target.checked)}
                containerClassName={cn(
                  "flex h-full w-full rounded-lg border p-3 transition-colors",
                  checked
                    ? "border-brand-500/40 bg-brand-500/5"
                    : "border-border bg-surface-sunken hover:border-border-strong"
                )}
                label={
                  <span className="text-sm font-medium text-text-primary">{label}</span>
                }
                description={desc}
              />
            ))}
          </div>

          {/* Score bar */}
          <div className="pt-1">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-text-muted">Pontuação</span>
              <span className={cn(
                "text-xs font-semibold tabular-nums",
                bantScore === 4 ? "text-semantic-success" :
                bantScore >= 2 ? "text-semantic-warning" :
                "text-text-muted"
              )}>
                {bantScore}/4
              </span>
            </div>
            <div className="flex gap-1">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={cn(
                    "h-1.5 flex-1 rounded-full transition-colors",
                    i < bantScore
                      ? bantScore === 4 ? "bg-semantic-success"
                        : bantScore >= 2 ? "bg-semantic-warning"
                        : "bg-semantic-error"
                      : "bg-surface-raised"
                  )}
                />
              ))}
            </div>
          </div>

          <Button
            onClick={handleSaveBant}
            disabled={savingBant}
            variant="primary"
            size="md"
            className="w-full"
          >
            {savingBant ? "Salvando..." : "Salvar Qualificação"}
          </Button>
        </div>
      </div>

      {/* Documents */}
      <LeadDocuments leadId={leadId} organizationId={organizationId} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tasks Tab                                                          */
/* ------------------------------------------------------------------ */

const LEAD_TASK_ACTIVITY_ICONS: Record<string, React.ElementType> = {
  todo: ClipboardList,
  call: Phone,
  email: Mail,
  follow_up: CalendarClock,
  meeting: Users,
  research: Microscope,
};

const LEAD_TASK_PRIORITY_BADGE: Record<string, { variant: "default" | "info" | "warning" | "error"; label: string }> = {
  low: { variant: "default", label: "Baixa" },
  medium: { variant: "info", label: "Média" },
  high: { variant: "warning", label: "Alta" },
  urgent: { variant: "error", label: "Urgente" },
};

function TasksTab({
  leadId,
  organizationId,
}: {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
}) {
  const navigate = useNavigate();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const leadTasks = useQuery(api.tasks.getTasksByLead, { leadId });
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const lead = useQuery(api.leads.getLead, { leadId });
  const completeTask = useMutation(api.tasks.completeTask);

  const memberMap = new Map<string, { name: string; type: "human" | "ai" }>();
  teamMembers?.forEach((m) => memberMap.set(m._id, { name: m.name, type: m.type }));

  const now = Date.now();

  const handleComplete = async (taskId: Id<"tasks">) => {
    try {
      await completeTask({ taskId });
      toast.success("Tarefa concluída!");
    } catch {
      toast.error("Falha ao concluir tarefa");
    }
  };

  if (leadTasks === undefined) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          Tarefas ({leadTasks.length})
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowCreateModal(true)}
        >
          <Plus size={14} />
          Nova Tarefa
        </Button>
      </div>

      {leadTasks.length === 0 ? (
        <div className="text-center py-8">
          <CheckSquare size={32} className="mx-auto text-text-muted mb-2" />
          <p className="text-sm text-text-muted">Nenhuma tarefa para este lead</p>
        </div>
      ) : (
        <div className="space-y-1">
          {leadTasks.map((task) => {
            const isCompleted = task.status === "completed" || task.status === "cancelled";
            const ActivityIcon = task.activityType
              ? LEAD_TASK_ACTIVITY_ICONS[task.activityType] || ClipboardList
              : ClipboardList;
            const assignee = task.assignedTo ? memberMap.get(task.assignedTo) : null;
            const pb = LEAD_TASK_PRIORITY_BADGE[task.priority] || LEAD_TASK_PRIORITY_BADGE.medium;

            return (
              <div
                key={task._id}
                className="flex items-center gap-2 px-2 rounded-lg hover:bg-surface-sunken transition-colors"
              >
                {/* Complete checkbox */}
                <button
                  onClick={() => {
                    if (!isCompleted) handleComplete(task._id);
                  }}
                  className={cn(
                    "shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
                    isCompleted
                      ? "border-semantic-success bg-semantic-success"
                      : "border-border-strong hover:border-brand-500"
                  )}
                  aria-label={isCompleted ? "Concluída" : "Concluir"}
                >
                  {isCompleted && (
                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="text-white">
                      <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>

                {/* A linha inteira abre o detalhe completo em Tarefas; voltar
                    no browser traz de volta para este painel (`?lead=`). */}
                <button
                  type="button"
                  onClick={() => navigate(`${TAB_ROUTES.tasks}?task=${task._id}`)}
                  aria-label={`Abrir a tarefa ${task.title}`}
                  className="flex flex-1 min-w-0 items-center gap-2 min-h-[44px] rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <ActivityIcon size={14} className="shrink-0 text-text-muted" aria-hidden="true" />

                  <span
                    className={cn(
                      "flex-1 text-sm truncate",
                      isCompleted ? "text-text-muted line-through" : "text-text-primary"
                    )}
                  >
                    {task.title}
                  </span>

                  <Badge variant={pb.variant} className="text-[10px] shrink-0">{pb.label}</Badge>

                  {assignee && (
                    <Avatar name={assignee.name} type={assignee.type} size="sm" className="shrink-0" />
                  )}

                  {task.dueDate && (
                    <span
                      className={cn(
                        "text-xs font-medium tabular-nums shrink-0",
                        !isCompleted && task.dueDate < now ? "text-semantic-error" : "text-text-muted"
                      )}
                    >
                      {new Date(task.dueDate).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <CreateTaskModal
        organizationId={organizationId}
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        defaultLeadId={leadId}
        defaultContactId={lead?.contactId ?? undefined}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Activity Tab                                                       */
/* ------------------------------------------------------------------ */

const activityTypeConfig: Record<string, { color: string; letter: string }> = {
  created: { color: "bg-semantic-success", letter: "C" },
  stage_change: { color: "bg-purple-500", letter: "S" },
  assignment: { color: "bg-indigo-500", letter: "A" },
  message_sent: { color: "bg-brand-500", letter: "M" },
  message_received: { color: "bg-cyan-500", letter: "R" },
  handoff: { color: "bg-brand-600", letter: "H" },
  qualification_update: { color: "bg-semantic-warning", letter: "Q" },
  note: { color: "bg-surface-overlay", letter: "N" },
  call: { color: "bg-teal-500", letter: "P" },
  email_sent: { color: "bg-semantic-info", letter: "E" },
};

function ActivityTab({ leadId }: { leadId: Id<"leads"> }) {
  const activities = useQuery(api.activities.getActivities, {
    leadId,
  });

  if (!activities) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="text-center py-12 text-text-muted text-sm">
        Nenhuma atividade registrada ainda.
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />

        <div className="space-y-6">
          {activities.map((activity) => {
            const config = activityTypeConfig[activity.type] || {
              color: "bg-text-muted",
              letter: "?",
            };

            return (
              <div key={activity._id} className="relative flex items-start gap-3 pl-1">
                {/* Icon */}
                <div
                  className={cn(
                    "relative z-10 w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold",
                    config.color
                  )}
                >
                  {config.letter}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-text-primary">
                      {activity.actorName}
                    </span>
                    <span className="text-xs text-text-muted whitespace-nowrap">
                      {new Date(activity.createdAt).toLocaleString("pt-BR", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="text-sm text-text-secondary mt-0.5">
                    {activity.content || activity.type.replace(/_/g, " ")}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
