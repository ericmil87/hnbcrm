import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { assignableMembers } from "@/lib/teamMembers";
import { extractMentionIds } from "@/lib/mentions";
import { formatDateTime } from "@/lib/format";
import {
  MEDIA_BLOCKED_HINT,
  channelSupports,
  formatTextCounter,
  measureText,
  mediaSendBlocked,
  textLimitFor,
  textNeedsSplit,
  textPartsCount,
} from "@/lib/channelCapabilities";
import {
  conversationWindowKind,
  getServiceWindowInfo,
  isComposerBlockedByWindow,
} from "@/lib/serviceWindow";
import {
  defaultScheduleValue,
  deriveContentType,
  hasContentToSend,
  placeholderFor,
  replyAuthorLabel,
  replyPreviewText,
} from "@/lib/composerRules";
import { FileUploadButton, type UploadedFile } from "@/components/ui/FileUploadButton";
import { ComposerView } from "@/components/inbox/ComposerView";
import { useConversationInteraction } from "@/components/inbox/conversationInteraction";
import { EmojiPickerButton } from "@/components/inbox/EmojiPickerButton";
import { GroupMentionDropdown, useGroupMentions } from "@/components/inbox/GroupMentionComposer";
import { QuickReplyDropdown, QuickRepliesModal, useQuickReplies } from "@/components/inbox/QuickReplies";
import { ScheduledPendingRow } from "@/components/inbox/ScheduledPendingRow";
import { useConversationDoc } from "@/components/inbox/useConversationDoc";
import { useGroupMode } from "@/components/inbox/useGroupMode";
import { useTypingBroadcast } from "@/components/inbox/useMarkReadAndPresence";
import { VoiceRecorder } from "@/components/inbox/VoiceRecorder";

export interface ComposerFeatures {
  /** Gravar nota de voz (padrão: ligado). O painel do lead desliga. */
  voice?: boolean;
  /** Agendar mensagem (padrão: ligado). O painel do lead desliga. */
  schedule?: boolean;
  /** Alternar "Nota interna" (padrão: ligado). */
  internalNote?: boolean;
  /** "/" abre as respostas rápidas (padrão: ligado). */
  quickReplies?: boolean;
}

export interface ComposerProps {
  organizationId: Id<"organizations">;
  /** `null` só no painel do lead sem conversa: `ensureConversation` cria antes do 1º envio. */
  conversationId: Id<"conversations"> | null;
  canReply: boolean;
  features?: ComposerFeatures;
  onSent?: () => void;
  /** `embedded` mostra a janela de serviço aqui (no Inbox ela fica no cabeçalho). */
  variant?: "page" | "embedded";
  ensureConversation?: () => Promise<Id<"conversations">>;
}

/**
 * Composer compartilhado: texto, nota interna, respostas rápidas ("/"), emoji,
 * anexos, voz, agendamento, janela de 24 h e menção em grupo. Remonte-o por
 * conversa (`key={conversationId}`): o rascunho e os anexos pertencem a ela.
 */
export function Composer({
  organizationId,
  conversationId,
  canReply,
  features,
  onSent,
  variant = "page",
  ensureConversation,
}: ComposerProps) {
  const voiceOn = features?.voice !== false;
  const scheduleOn = features?.schedule !== false;
  const internalNoteOn = features?.internalNote !== false;
  const quickRepliesOn = features?.quickReplies !== false;

  const interaction = useConversationInteraction();
  const { replyTo, setReplyTo, draft, consumeDraft } = interaction;
  const conversation = useConversationDoc(conversationId);
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });
  const { isGroupConversation, groupChatId } = useGroupMode(conversation, undefined);

  const [text, setText] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<UploadedFile[]>([]);
  const [recorderActive, setRecorderActive] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const sendMessage = useMutation(api.conversations.sendMessage);
  const scheduleMessage = useMutation(api.scheduledMessages.schedule);
  const cancelScheduled = useMutation(api.scheduledMessages.cancel);
  const scheduledPending = useQuery(
    api.scheduledMessages.listPending,
    conversationId && scheduleOn ? { conversationId } : "skip"
  );

  // Capacidades do canal e janela de serviço (relógio só roda com janela).
  const channel: string | undefined = conversation?.channel;
  const transport: string | undefined = conversation?.channelProvider;
  const canSendTyping = channelSupports(channel, transport, "typingIndicator");
  const canRecordVoice = channelSupports(channel, transport, "voiceRecorder");
  const windowKind = conversationWindowKind(conversation);
  const windowExpiresAt: number | null = conversation?.serviceWindowExpiresAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!windowKind) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [windowKind]);
  const windowResult = getServiceWindowInfo(windowKind, windowExpiresAt, now);
  const blocked = isComposerBlockedByWindow(windowKind, windowExpiresAt, now) && !isInternal;
  const mediaBlocked = mediaSendBlocked(channel, transport) && !isInternal;
  const textLimit = textLimitFor(channel, transport);
  const textCounter =
    textLimit && !isInternal && text.length > 0
      ? {
          label: formatTextCounter(measureText(text, textLimit.unit), textLimit),
          parts: textPartsCount(text, textLimit),
          over: textNeedsSplit(text, textLimit),
        }
      : null;
  const contactName =
    `${conversation?.contact?.firstName ?? ""} ${conversation?.contact?.lastName ?? ""}`.trim();

  const typing = useTypingBroadcast(conversationId, canSendTyping);

  // Rascunho vindo de `location.state` (Nova conversa, handoff): aplica uma vez.
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    consumeDraft();
  }, [draft, consumeDraft]);

  const focusInput = () => requestAnimationFrame(() => inputRef.current?.focus());

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    if (!el) {
      setText((v) => v + emoji);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const quickReplies = useQuickReplies({
    organizationId,
    value: text,
    enabled: quickRepliesOn && !isInternal,
    onApply: (content) => {
      setText(content);
      focusInput();
    },
  });

  // Menção a membro no grupo: o "@" busca os membros no servidor, o texto
  // recebe "@<nome>" e os JIDs escolhidos viajam em `mentions[]` no envio.
  const groupMentions = useGroupMentions({
    groupChatId: isGroupConversation ? groupChatId : undefined,
    value: text,
    enabled: isGroupConversation && !isInternal,
    onChange: (next, cursorPosition) => {
      setText(next);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(cursorPosition, cursorPosition);
      });
    },
  });

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!hasContentToSend(text, stagedFiles.length) || blocked || sending) return;
    setSending(true);
    try {
      const id = conversationId ?? (await ensureConversation?.());
      if (!id) return;
      const attachments = stagedFiles.map((f) => f.fileId);
      const mentionedUserIds = isInternal ? extractMentionIds(trimmed) : undefined;
      // Só os JIDs cujo "@<nome>" sobreviveu no texto — quem apagou a menção
      // não quer mais notificar aquela pessoa.
      const memberMentions =
        isGroupConversation && !isInternal ? groupMentions.mentionsFor(trimmed) : [];
      await sendMessage({
        conversationId: id,
        content: trimmed,
        contentType: attachments.length ? deriveContentType(stagedFiles) : "text",
        isInternal,
        attachments: attachments.length ? attachments : undefined,
        mentionedUserIds: mentionedUserIds?.length ? mentionedUserIds : undefined,
        replyToMessageId: !isInternal && replyTo ? (replyTo._id as Id<"messages">) : undefined,
        mentions: memberMentions.length ? memberMentions : undefined,
      });
      setText("");
      setStagedFiles([]);
      setReplyTo(null);
      groupMentions.reset();
      typing.stop();
      onSent?.();
    } catch {
      toast.error("Não foi possível enviar a mensagem. Tente de novo.");
    } finally {
      setSending(false);
    }
  };

  const handleSendVoice = async (file: UploadedFile) => {
    if (!conversationId) throw new Error("no conversation");
    await sendMessage({
      conversationId,
      content: "",
      contentType: "audio",
      attachments: [file.fileId],
      replyToMessageId: replyTo ? (replyTo._id as Id<"messages">) : undefined,
    });
    setReplyTo(null);
    typing.stop();
    onSent?.();
  };

  // Agendamento — popover com datetime no composer.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState("");

  const handleSchedule = async () => {
    if (!conversationId || !text.trim() || !scheduleValue) return;
    const scheduledAt = new Date(scheduleValue).getTime();
    if (Number.isNaN(scheduledAt)) return;
    try {
      // Menção também no agendado: o "@fulano" sobrevivia como TEXTO mas não
      // notificava ninguém na entrega.
      const trimmed = text.trim();
      const memberMentions = isGroupConversation ? groupMentions.mentionsFor(trimmed) : [];
      await scheduleMessage({
        conversationId,
        content: trimmed,
        scheduledAt,
        ...(memberMentions.length ? { mentions: memberMentions } : {}),
      });
      toast.success(`Mensagem agendada para ${formatDateTime(scheduledAt)}`);
      setText("");
      setScheduleOpen(false);
      groupMentions.reset();
      typing.stop();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message.split("\n")[0].replace(/^.*Error: /, "")
          : "Não foi possível agendar."
      );
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

  if (!canReply) {
    return (
      <div className="shrink-0 p-4 border-t border-border bg-surface-raised text-center">
        <p className="text-sm text-text-muted">Você não tem permissão para enviar mensagens.</p>
      </div>
    );
  }

  const composerEmpty = text.trim() === "" && stagedFiles.length === 0;
  const showVoice =
    voiceOn && canRecordVoice && !isInternal && !!conversationId && (recorderActive || composerEmpty);
  const showSchedule =
    scheduleOn && !showVoice && !isInternal && !blocked && !!conversationId && text.trim() !== "";

  return (
    <>
      <ComposerView
        variant={variant}
        text={text}
        onTextChange={(value) => {
          setText(value);
          // O "@" do grupo depende da posição do cursor, que só existe no DOM
          // depois que o React aplica o valor.
          requestAnimationFrame(() =>
            groupMentions.setCursor(inputRef.current?.selectionStart ?? value.length)
          );
          typing.notifyActivity(isInternal);
        }}
        isInternal={isInternal}
        onInternalChange={setIsInternal}
        showInternalToggle={internalNoteOn}
        placeholder={placeholderFor({ internal: isInternal, blocked, group: isGroupConversation })}
        blocked={blocked}
        canSend={hasContentToSend(text, stagedFiles.length)}
        sending={sending}
        onSend={handleSend}
        onKeyDownBefore={(e) => groupMentions.handleKeyDown(e) || quickReplies.handleKeyDown(e)}
        inputRef={inputRef}
        teamMembers={assignableMembers(teamMembers)}
        windowInfo={
          variant === "embedded" && windowResult
            ? { text: windowResult.text, closed: windowResult.closed }
            : null
        }
        replyBar={
          replyTo
            ? {
                author: replyAuthorLabel(replyTo, contactName),
                preview: replyPreviewText(replyTo),
                onCancel: () => setReplyTo(null),
              }
            : null
        }
        attachmentNotice={
          stagedFiles.length > 1 && channel === "whatsapp"
            ? "WhatsApp: apenas o primeiro anexo será enviado"
            : null
        }
        textCounter={textCounter}
        hideField={recorderActive}
        pendingRows={
          scheduledPending && scheduledPending.length > 0 ? (
            <div className="mb-2 space-y-1">
              {scheduledPending.map((item) => (
                <ScheduledPendingRow
                  key={item._id}
                  item={item}
                  onCancel={() => handleCancelScheduled(item._id)}
                />
              ))}
            </div>
          ) : null
        }
        dropdowns={
          <>
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
          </>
        }
        attachButton={
          <FileUploadButton
            organizationId={organizationId}
            uploadedFiles={stagedFiles}
            onFilesUploaded={(newFiles) => setStagedFiles((prev) => [...prev, ...newFiles])}
            onFilesRemoved={(fileId) => setStagedFiles((prev) => prev.filter((f) => f.fileId !== fileId))}
            className="shrink-0"
            disabled={sending || blocked || mediaBlocked}
            disabledHint={mediaBlocked ? MEDIA_BLOCKED_HINT : undefined}
            channel={channel}
            transport={transport}
          />
        }
        emojiButton={<EmojiPickerButton onPick={insertEmoji} disabled={sending} />}
        schedule={
          showSchedule
            ? {
                open: scheduleOpen,
                value: scheduleValue,
                onToggle: () => {
                  if (scheduleOpen) {
                    setScheduleOpen(false);
                    return;
                  }
                  setScheduleValue(defaultScheduleValue(Date.now()));
                  setScheduleOpen(true);
                },
                onChange: setScheduleValue,
                onSubmit: handleSchedule,
                onClose: () => setScheduleOpen(false),
              }
            : null
        }
        voice={
          showVoice ? (
            <VoiceRecorder
              organizationId={organizationId}
              onActiveChange={setRecorderActive}
              onRecorded={handleSendVoice}
            />
          ) : undefined
        }
      />
      <QuickRepliesModal
        organizationId={organizationId}
        open={quickReplies.manageOpen}
        onClose={() => quickReplies.setManageOpen(false)}
      />
    </>
  );
}
