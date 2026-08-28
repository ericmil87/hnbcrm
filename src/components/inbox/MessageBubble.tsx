import { useState } from "react";
import { Check, CheckCheck, AlertCircle, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { MentionRenderer } from "@/components/ui/MentionRenderer";
import { MessageAttachments } from "./MessageAttachments";
import { MessageActionsBar } from "./MessageActionsBar";
import { ReactionChips } from "./ReactionChips";
import { QuotedBlock } from "./QuotedBlock";
import { VoiceTranscription } from "./VoiceTranscription";
import { ImageDescription } from "./ImageDescription";
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
  /** Org has AI vision on — sem isso a imagem não ganha CTA de leitura. */
  visionEnabled?: boolean;
  /** Transient highlight after jumping to this message from a quote. */
  highlighted?: boolean;
  onReply: (message: InboxMessage) => void;
  onReact: (message: InboxMessage, emoji: string) => void;
  onForward: (message: InboxMessage) => void;
  onTranscribe: (message: InboxMessage) => void;
  onDescribeImage: (message: InboxMessage) => void;
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

function DeliveryTick({ message }: { message: InboxMessage }) {
  const status = message.deliveryStatus;
  if (!status) return null;
  if (status === "failed") {
    return <AlertCircle className="size-3.5 text-semantic-error shrink-0" />;
  }
  if (status === "read") {
    return <CheckCheck className="size-3.5 text-brand-400 shrink-0" />;
  }
  if (status === "delivered") {
    return <CheckCheck className="size-3.5 text-current opacity-70 shrink-0" />;
  }
  return <Check className="size-3.5 text-current opacity-70 shrink-0" />;
}

export function MessageBubble({
  message,
  channelIsWhatsapp,
  canInteract,
  currentMemberId,
  contactName,
  transcribing = false,
  describing = false,
  visionEnabled = false,
  highlighted = false,
  onReply,
  onReact,
  onForward,
  onTranscribe,
  onDescribeImage,
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
    voiceNote && (!transcription || (transcription.status !== "done" && transcription.status !== "pending"));
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
    (hasAttachments || voiceNote || mediaProblem);
  const visibleText =
    !message.isInternal && message.content && !suppressPlaceholder
      ? message.content
      : null;

  // A lone sticker renders without a bubble background, WhatsApp-style.
  const bubbleless =
    sticker && !visibleText && !message.isInternal && !mediaProblem && !quoted;

  const timestamp = new Date(message.createdAt).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });

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
            onForward={() => {
              setMenuOpen(false);
              onForward(message);
            }}
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

  const footer = (
    <div className={cn("flex items-center justify-end gap-1 mt-1", style.footerText)}>
      <span className="text-[10px] tabular-nums">{timestamp}</span>
      {showDeliveryTick && <DeliveryTick message={message} />}
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
          <div className={cn("text-xs font-medium", style.labelColor)}>
            {/* Mensagem de contato não tem sender (team member) — usa o nome do
                contato (pushName do WhatsApp ou nome editado no lead) e só cai
                no rótulo genérico "Contato" quando o nome não está disponível. */}
            {message.sender?.name ||
              (!message.isInternal &&
              (message.direction === "inbound" || message.senderType === "contact")
                ? contactName || style.label
                : style.label)}
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

          {mediaProblem && (
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

          {hasAttachments && (
            <MessageAttachments
              files={attachments}
              variant={style.variant}
              sticker={sticker}
              voiceNote={voiceNote}
            />
          )}

          {voiceNote && (
            <VoiceTranscription
              transcription={transcription}
              variant={style.variant}
              transcribing={transcribing}
              onTranscribe={() => onTranscribe(message)}
            />
          )}

          {imageMessage && !message.isInternal && (
            <ImageDescription
              vision={vision}
              variant={style.variant}
              describing={describing}
              canDescribe={canDescribeImage}
              onDescribe={() => onDescribeImage(message)}
            />
          )}

          {message.isInternal ? (
            <MentionRenderer content={message.content} className="text-sm" />
          ) : (
            visibleText && <p className="text-sm whitespace-pre-wrap break-words">{visibleText}</p>
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
