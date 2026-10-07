import { useState } from "react";
import { Check, CheckCheck, AlertCircle, MoreHorizontal, Megaphone, UserRound, Bot, Ban, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { MentionRenderer } from "@/components/ui/MentionRenderer";
import { FormattedMessageText } from "./FormattedMessageText";
import { GroupMentionText } from "./GroupMentionText";
import {
  groupSenderColor,
  initialsOf,
  maskPhone,
  participantDisplayName,
} from "@/lib/groupDisplay";
import { MessageAttachments } from "./MessageAttachments";
import { MessageActionsBar } from "./MessageActionsBar";
import { ReactionChips } from "./ReactionChips";
import { QuotedBlock } from "./QuotedBlock";
import { VoiceTranscription } from "./VoiceTranscription";
import { ImageDescription } from "./ImageDescription";
import { DeferredMedia } from "./DeferredMedia";
import { SpecialMessageCard } from "./SpecialMessageCard";
import { describeSpecialMessage, isEdited, isRevoked, isViewOnce } from "@/lib/bridgeSpecialMessage";
import { getMessageMediaState } from "@/lib/groupMedia";
import { formatMessageTimestamp } from "@/lib/messageTime";
import {
  InboxMessage,
  getQuoted,
  getQuotedMessageId,
  getReactions,
  getTranscription,
  getVision,
  hasMediaProblem,
  isImageMessage,
  isMediaPlaceholder,
  isSticker,
  isVoiceNote,
} from "./types";

interface MessageBubbleProps {
  message: InboxMessage;
  /** Delivery ticks + reply/react/forward only apply to the WhatsApp channel. */
  channelIsWhatsapp: boolean;
  /** Whether the current user can reply/react/forward. */
  canInteract: boolean;
  /** Current team member id — highlights the user's own reactions. */
  currentMemberId?: string | null;
  /** Contact display name, used in quoted blocks. */
  contactName?: string;
  /** True while a transcribe request for this message is in flight. */
  transcribing?: boolean;
  /** True while a "ler imagem" request for this message is in flight. */
  describing?: boolean;
  /** True while an on-demand download of deferred group media is in flight. */
  downloadingMedia?: boolean;
  /** Org has AI vision on — sem isso a imagem não ganha CTA de leitura. */
  visionEnabled?: boolean;
  /** Transient highlight after jumping to this message from a quote. */
  highlighted?: boolean;
  /**
   * Conversa de GRUPO: o autor de uma mensagem recebida é um membro da sala, e
   * não o contato da conversa. Ausente = conversa 1:1 (comportamento de antes).
   */
  group?: {
    /** Rótulos que a menção pode assumir no texto (ver `mentionTokensFor`). */
    mentionTokens: string[];
    /** Abre o contato do membro, quando ele já existe na org (D3). */
    onOpenContact?: (contactId: string) => void;
  };
  onReply: (message: InboxMessage) => void;
  onReact: (message: InboxMessage, emoji: string) => void;
  onForward: (message: InboxMessage) => void;
  onTranscribe: (message: InboxMessage) => void;
  onDescribeImage: (message: InboxMessage) => void;
  /**
   * Baixa sob demanda a mídia que a política de grupo não baixou (v0.62).
   * Ausente = sem o botão (sem `inbox:reply`, ou tela só de leitura).
   */
  onDownloadMedia?: (message: InboxMessage) => void;
  /** Jump to the original message a reply quotes (if it's on screen). */
  onJumpToMessage: (messageId: string) => void;
}

type BubbleStyle = {
  align: "justify-start" | "justify-end";
  side: "start" | "end";
  bg: string;
  rounded: string;
  label: string;
  labelColor: string;
  variant: "inbound" | "outbound";
  footerText: string;
};

function getBubbleStyle(message: InboxMessage): BubbleStyle {
  if (message.isInternal) {
    return {
      align: "justify-end",
      side: "end",
      bg: "bg-surface-overlay border border-dashed border-semantic-warning/30 text-text-primary",
      rounded: "rounded-lg rounded-br-none",
      label: "Nota Interna",
      labelColor: "text-semantic-warning",
      variant: "inbound",
      footerText: "text-text-muted",
    };
  }
  if (message.direction === "inbound" || message.senderType === "contact") {
    return {
      align: "justify-start",
      side: "start",
      bg: "bg-surface-raised text-text-primary",
      rounded: "rounded-lg rounded-bl-none",
      label: "Contato",
      labelColor: "text-text-secondary",
      variant: "inbound",
      footerText: "text-text-muted",
    };
  }
  if (message.senderType === "ai") {
    return {
      align: "justify-end",
      side: "end",
      bg: "bg-purple-600/80 text-white",
      rounded: "rounded-lg rounded-br-none",
      label: "Agente IA",
      labelColor: "text-purple-300",
      variant: "outbound",
      footerText: "text-white/75",
    };
  }
  return {
    align: "justify-end",
    side: "end",
    bg: "bg-brand-600 text-white",
    rounded: "rounded-lg rounded-br-none",
    label: "Equipe",
    labelColor: "text-brand-200",
    variant: "outbound",
    footerText: "text-white/75",
  };
}

const DELIVERY_LABELS: Record<string, string> = {
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};

function DeliveryTick({ message }: { message: InboxMessage }) {
  const status = message.deliveryStatus;
  if (!status) return null;
  // Em grupo o recibo é por MEMBRO (`Receipt.MessageSender`): o tique mostra o
  // primeiro que entregou/leu, e o tooltip conta quantos já leram — que é a
  // única leitura honesta de "lido" numa sala de N pessoas.
  const readCount = message.readBy?.length ?? 0;
  const title =
    readCount > 0
      ? `${DELIVERY_LABELS[status] ?? status} · Lido por ${readCount}`
      : DELIVERY_LABELS[status] ?? status;
  if (status === "failed") {
    return <AlertCircle className="size-3.5 text-semantic-error shrink-0" aria-label={title} />;
  }
  if (status === "read") {
    return <CheckCheck className="size-3.5 text-brand-400 shrink-0" aria-label={title} />;
  }
  if (status === "delivered") {
    return <CheckCheck className="size-3.5 text-current opacity-70 shrink-0" aria-label={title} />;
  }
  return <Check className="size-3.5 text-current opacity-70 shrink-0" aria-label={title} />;
}

export function MessageBubble({
  message,
  channelIsWhatsapp,
  canInteract,
  currentMemberId,
  contactName,
  transcribing = false,
  describing = false,
  downloadingMedia = false,
  visionEnabled = false,
  highlighted = false,
  group,
  onReply,
  onReact,
  onForward,
  onTranscribe,
  onDescribeImage,
  onDownloadMedia,
  onJumpToMessage,
}: MessageBubbleProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const style = getBubbleStyle(message);
  const attachments = message.attachmentFiles ?? [];
  const hasAttachments = attachments.length > 0;
  const sticker = isSticker(message);
  const voiceNote = isVoiceNote(message);
  const imageMessage = isImageMessage(message);
  const mediaProblem = hasMediaProblem(message);
  // Mídia de grupo não baixada (ou vencida/apagada) — placeholder neutro.
  const mediaState = getMessageMediaState(message.metadata);
  const deferredMedia = mediaState.state === "none" ? null : mediaState;
  // Sem o arquivo não há o que transcrever/ler; mas mídia APAGADA já pode ter
  // sido lida antes, e o texto (transcrição/descrição) continua valendo.
  const mediaPurged = mediaState.state === "purged";

  const revoked = isRevoked(message.metadata) && !message.isInternal;
  const edited = isEdited(message.metadata) && !revoked;
  const viewOnce = isViewOnce(message.metadata) && !revoked;
  const special = message.isInternal || revoked ? null : describeSpecialMessage(message.metadata, message.content);
  const quoted = getQuoted(message);
  const reactions = getReactions(message);
  const transcription = getTranscription(message);
  const vision = getVision(message);
  const quotedMessageId = getQuotedMessageId(message);

  // Reactions/reply/forward are whatsapp-channel actions; internal notes and
  // other channels don't push to a provider, so keep the bar off there.
  const actionsEnabled = channelIsWhatsapp && !message.isInternal;
  const activeEmoji =
    currentMemberId != null
      ? reactions.find((r) => r.sender === currentMemberId)?.emoji ?? null
      : null;
  // The bar's Transcribe entry only appears for a voice note still lacking text.
  const needsTranscription =
    voiceNote && !deferredMedia && (!transcription || (transcription.status !== "done" && transcription.status !== "pending"));
  // Ler imagem é pago por imagem e só vale para o que o cliente mandou: exige o
  // toggle mestre ligado, mídia presente e nenhuma leitura em cache/em voo.
  const canDescribeImage =
    visionEnabled &&
    imageMessage &&
    message.direction === "inbound" &&
    !message.isInternal &&
    hasAttachments &&
    !mediaProblem;
  const needsVision =
    canDescribeImage && (!vision || (vision.status !== "done" && vision.status !== "pending"));

  const showDeliveryTick =
    !message.isInternal && message.direction === "outbound" && channelIsWhatsapp;
  const isFailed = showDeliveryTick && message.deliveryStatus === "failed";

  // Suppress server-side placeholders like "[imagem]" when the real media is
  // present (or expected). Real captions still render below the media.
  const suppressPlaceholder =
    isMediaPlaceholder(message.content) &&
    (hasAttachments || voiceNote || mediaProblem || deferredMedia !== null);
  const visibleText =
    !message.isInternal && !revoked && message.content && !suppressPlaceholder
      && !(special && special.kind !== "interactive_reply")
      ? message.content
      : null;

  // Autor da mensagem numa sala: só faz sentido no que CHEGA do grupo. O que
  // sai continua sendo "Equipe"/"Agente IA", e a mensagem vinda do aparelho
  // (v0.56, `metadata.via:"device"`) também — ela é nossa.
  const groupSender =
    group && !message.isInternal && message.direction === "inbound"
      ? (() => {
          const name = participantDisplayName({
            name: message.senderName,
            phone: message.senderPhone,
          });
          const contactFullName = message.senderContact
            ? [message.senderContact.firstName, message.senderContact.lastName]
                .filter(Boolean)
                .join(" ")
                .trim()
            : "";
          const label = contactFullName || name;
          return {
            name: label || maskPhone(message.senderPhone) || "Membro",
            initials: initialsOf(label || "?"),
            color: groupSenderColor(message.senderLid ?? message.senderPhone),
            contactId: message.senderContactId ?? null,
          };
        })()
      : null;

  // A lone sticker renders without a bubble background, WhatsApp-style.
  const bubbleless =
    sticker &&
    !visibleText &&
    !message.isInternal &&
    !mediaProblem &&
    !deferredMedia &&
    !quoted;

  const timestamp = formatMessageTimestamp(message.createdAt);

  const canShowActions = actionsEnabled && (canInteract || needsTranscription || needsVision);

  const handleReactToggle = (emoji: string) => onReact(message, emoji);

  const actions = canShowActions ? (
    <div
      className={cn(
        "absolute z-20 top-0",
        style.side === "end" ? "right-full mr-1" : "left-full ml-1"
      )}
    >
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className={cn(
            "flex items-center justify-center h-7 w-7 rounded-full text-text-muted",
            "hover:text-text-primary hover:bg-surface-raised transition-all focus:outline-none focus:ring-2 focus:ring-brand-500",
            "opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100",
            menuOpen && "opacity-100 text-text-primary bg-surface-raised"
          )}
          aria-label="Ações da mensagem"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <MoreHorizontal size={16} />
        </button>
        {menuOpen && (
          <MessageActionsBar
            className={cn("absolute top-8", style.side === "end" ? "right-0" : "left-0")}
            canInteract={canInteract}
            activeEmoji={activeEmoji}
            align={style.side}
            onReply={() => {
              setMenuOpen(false);
              onReply(message);
            }}
            onReact={(emoji) => {
              setMenuOpen(false);
              onReact(message, emoji);
            }}
            onForward={
              // Numa sala de grupo não há encaminhar: o conteúdo é de dezenas
              // de terceiros e o servidor recusa (review de correção nº 1).
              group
                ? undefined
                : () => {
                    setMenuOpen(false);
                    onForward(message);
                  }
            }
            onTranscribe={
              needsTranscription
                ? () => {
                    setMenuOpen(false);
                    onTranscribe(message);
                  }
                : undefined
            }
            onDescribeImage={
              needsVision
                ? () => {
                    setMenuOpen(false);
                    onDescribeImage(message);
                  }
                : undefined
            }
          />
        )}
      </div>
    </div>
  ) : null;

  const readCount = message.readBy?.length ?? 0;
  const footer = (
    <div className={cn("flex items-center justify-end gap-1 mt-1", style.footerText)}>
      {edited && (
        <span
          className="text-[10px] italic"
          title={
            typeof message.metadata?.previousContent === "string"
              ? `Texto anterior: ${message.metadata.previousContent.slice(0, 500)}`
              : "Mensagem editada"
          }
        >
          editada
        </span>
      )}
      <span className="text-[10px] tabular-nums">{timestamp}</span>
      {showDeliveryTick && (
        <span
          className="inline-flex items-center"
          title={readCount > 0 ? `Lido por ${readCount}` : undefined}
        >
          <DeliveryTick message={message} />
        </span>
      )}
    </div>
  );

  const reactionChips = reactions.length > 0 && (
    <ReactionChips
      reactions={reactions}
      currentMemberId={currentMemberId}
      align={style.side}
      onToggle={canInteract && actionsEnabled ? handleReactToggle : undefined}
    />
  );

  if (bubbleless) {
    return (
      <div id={`msg-${message._id}`} className={cn("group flex scroll-mt-4", style.align)}>
        <div className="relative max-w-xs lg:max-w-md flex flex-col gap-1">
          {actions}
          <MessageAttachments files={attachments} variant={style.variant} sticker />
          {footer}
          {reactionChips}
        </div>
      </div>
    );
  }

  return (
    <div id={`msg-${message._id}`} className={cn("group flex scroll-mt-4", style.align)}>
      <div className="relative flex flex-col gap-1 max-w-xs lg:max-w-md">
        {actions}
        <div
          className={cn(
            "px-3 py-2 flex flex-col gap-1.5",
            style.bg,
            style.rounded,
            isFailed && "ring-1 ring-semantic-error/60",
            highlighted && "ring-2 ring-brand-500 ring-offset-2 ring-offset-surface-base transition-shadow"
          )}
        >
          <div className={cn("flex items-center gap-1.5 text-xs font-medium", style.labelColor)}>
            {groupSender ? (
              <>
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ backgroundColor: groupSender.color }}
                  aria-hidden
                >
                  {groupSender.initials}
                </span>
                <span className="truncate" style={{ color: groupSender.color }}>
                  {groupSender.name}
                </span>
                {groupSender.contactId && group?.onOpenContact && (
                  <button
                    type="button"
                    onClick={() => group.onOpenContact?.(groupSender.contactId!)}
                    className="inline-flex items-center gap-0.5 rounded-full bg-brand-500/15 px-1.5 py-px text-[10px] font-medium text-brand-400 transition-colors hover:bg-brand-500/25"
                    title="Abrir contato"
                  >
                    <UserRound size={9} />
                    Contato
                  </button>
                )}
              </>
            ) : (
              /* Mensagem de contato não tem sender (team member) — usa o nome do
                 contato (pushName do WhatsApp ou nome editado no lead) e só cai
                 no rótulo genérico "Contato" quando o nome não está disponível. */
              message.sender?.name ||
              (!message.isInternal &&
              (message.direction === "inbound" || message.senderType === "contact")
                ? contactName || style.label
                : style.label)
            )}
            {message.metadata?.campaign && (
              <span
                className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/15 px-1.5 py-px text-[10px] font-medium opacity-80"
                title="Enviada por campanha"
              >
                <Megaphone size={9} /> Campanha
              </span>
            )}
            {message.metadata?.followUp && (
              <span
                className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/15 px-1.5 py-px text-[10px] font-medium opacity-80"
                title="Follow-up executado pela IA"
              >
                <Bot size={9} /> follow-up
              </span>
            )}
          </div>

          {quoted && (
            <QuotedBlock
              quoted={quoted}
              contactName={contactName}
              variant={style.variant}
              onJump={
                quotedMessageId ? () => onJumpToMessage(quotedMessageId) : undefined
              }
            />
          )}

          {!revoked && mediaProblem && (
            <div
              className={cn(
                "flex items-center gap-1.5 text-xs italic",
                style.variant === "outbound" ? "text-white/80" : "text-text-muted"
              )}
            >
              <AlertCircle size={14} className="shrink-0" />
              Mídia indisponível
            </div>
          )}

          {!revoked && deferredMedia && !hasAttachments && (
            <DeferredMedia
              media={deferredMedia}
              variant={style.variant}
              downloading={downloadingMedia}
              onDownload={onDownloadMedia ? () => onDownloadMedia(message) : undefined}
            />
          )}

          {!revoked && hasAttachments && (
            <MessageAttachments
              files={attachments}
              variant={style.variant}
              sticker={sticker}
              voiceNote={voiceNote}
            />
          )}

          {!revoked && voiceNote && (!deferredMedia || (mediaPurged && transcription?.status === "done")) && (
            <VoiceTranscription
              transcription={transcription}
              variant={style.variant}
              transcribing={transcribing}
              onTranscribe={() => onTranscribe(message)}
            />
          )}

          {imageMessage &&
            !revoked &&
            !message.isInternal &&
            (!deferredMedia || (mediaPurged && vision?.status === "done")) && (
            <ImageDescription
              vision={vision}
              variant={style.variant}
              describing={describing}
              canDescribe={canDescribeImage}
              onDescribe={() => onDescribeImage(message)}
            />
          )}

          {viewOnce && hasAttachments && (
            <span
              className={cn(
                "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                style.variant === "outbound" ? "bg-white/15 text-white/90" : "bg-surface-sunken text-text-secondary"
              )}
            >
              <Eye size={10} aria-hidden /> Visualização única
            </span>
          )}

          {revoked && (
            <div
              className={cn(
                "flex items-center gap-1.5 text-sm italic",
                style.variant === "outbound" ? "text-white/80" : "text-text-muted"
              )}
            >
              <Ban size={14} className="shrink-0" aria-hidden />
              Mensagem apagada
            </div>
          )}

          {special && special.kind !== "interactive_reply" && (
            <SpecialMessageCard info={special} variant={style.variant} />
          )}

          {special?.kind === "interactive_reply" && (
            <span
              className={cn("text-[10px] font-medium uppercase tracking-wide", style.variant === "outbound" ? "text-white/70" : "text-text-muted")}
            >
              resposta de botão
            </span>
          )}

          {message.isInternal ? (
            <MentionRenderer content={message.content} className="text-sm" />
          ) : visibleText && group && group.mentionTokens.length > 0 ? (
            <GroupMentionText text={visibleText} tokens={group.mentionTokens} />
          ) : (
            visibleText && (
              <FormattedMessageText text={visibleText} variant={style.variant} className="text-sm" />
            )
          )}

          {footer}

          {isFailed && message.metadata?.deliveryError && (
            <p className="text-[10px] text-semantic-error">{message.metadata.deliveryError}</p>
          )}
        </div>
        {reactionChips}
      </div>
    </div>
  );
}
