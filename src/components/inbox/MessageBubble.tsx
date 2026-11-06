import { Tooltip } from "@/components/ui/Tooltip";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Check, CheckCheck, AlertCircle, AlertTriangle, ChevronDown, Megaphone, Bot, Ban, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { MentionRenderer } from "@/components/ui/MentionRenderer";
import { FormattedMessageText } from "./FormattedMessageText";
import { GroupMentionText } from "./GroupMentionText";
import {
  groupSenderColor,
  maskPhone,
  participantDisplayName,
} from "@/lib/groupDisplay";
import { MessageAttachments } from "./MessageAttachments";
import { MessageActionsBar, type CopyItem } from "./MessageActionsBar";
import { useLongPress } from "./useLongPress";
import { ReactionChips } from "./ReactionChips";
import { QuotedBlock } from "./QuotedBlock";
import { VoiceTranscription } from "./VoiceTranscription";
import { ImageDescription } from "./ImageDescription";
import { MessageTranslation } from "./MessageTranslation";
import type { TranslationView } from "@/lib/translationRules";
import { DeferredMedia } from "./DeferredMedia";
import { SpecialMessageCard } from "./SpecialMessageCard";
import { MediaUnavailablePlaceholder, MetaSpecialCard, StoryReplyStrip } from "./MetaSpecialCard";
import {
  DELETED_BY_CUSTOMER_LABEL,
  describeMetaCard,
  describeStoryReply,
  editHistoryOf,
  isDeletedByCustomer,
  mediaUnavailableDetail,
  mediaUnavailableLabel,
  metaTypeOf,
  reactionNoteOf,
} from "@/lib/metaSpecialMessage";
import { describeSpecialMessage, isEdited, isRevoked, isViewOnce } from "@/lib/bridgeSpecialMessage";
import { getMessageMediaState } from "@/lib/groupMedia";
import { formatDateTime, formatTime } from "@/lib/format";
import { senderLabelKind } from "@/lib/threadLayout";
import { allowedReactionEmojis, channelSupports, deliveryTicksMode } from "@/lib/channelCapabilities";
import { deviceViaLabel } from "@/lib/serviceWindow";
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
  /** Canal + transporte da conversa: a matriz de capacidades decide ticks/reply/react/forward. */
  channel: string | null | undefined;
  transport?: string | null;
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
   * Posição no bloco de mensagens consecutivas do mesmo remetente
   * (`lib/threadLayout.ts`). Ausente = bolha avulsa (1ª e última do bloco, com
   * o rótulo que o remetente pedir).
   */
  run?: { first: boolean; last: boolean; showSender: boolean };
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
  /**
   * Tradução automática (v0.80), já decidida pelo thread (`translationView`).
   * Ausente = conversa sem tradução (bolha igual a antes).
   */
  translation?: {
    view: TranslationView;
    /** Menu "Traduzir mesmo assim". */
    canRequest: boolean;
    /** Preferência "mostrar original junto". */
    showBoth: boolean;
    /** Pedido manual em voo. */
    busy: boolean;
  };
  onTranslate?: (message: InboxMessage) => void;
  /** F3, idioma incerto: fixa o idioma da conversa e traduz a mensagem. */
  onTranslateAs?: (message: InboxMessage, lang: string) => void;
  onRetryOutbound?: (message: InboxMessage) => void;
  onSendUntranslated?: (message: InboxMessage) => void;
}

async function copyText(value: string, done: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(done);
  } catch {
    toast.error("Não foi possível copiar.");
  }
}

type BubbleStyle = {
  align: "justify-start" | "justify-end";
  side: "start" | "end";
  bg: string;
  /** Raio da bolha; a cauda (`.bubble-tail-*` em index.css) endireita o canto de cima. */
  rounded: string;
  label: string;
  labelColor: string;
  variant: "inbound" | "outbound";
  footerText: string;
};

export function getBubbleStyle(message: InboxMessage): BubbleStyle {
  if (message.isInternal) {
    return {
      align: "justify-end",
      side: "end",
      bg: "bg-bubble-note border border-dashed border-bubble-note-border/30 text-text-primary",
      rounded: "rounded-lg",
      label: "Nota interna",
      labelColor: "text-bubble-note-label",
      variant: "inbound",
      footerText: "text-text-muted",
    };
  }
  if (message.direction === "inbound" || message.senderType === "contact") {
    return {
      align: "justify-start",
      side: "start",
      bg: "bg-bubble-in text-text-primary shadow-bubble",
      rounded: "rounded-lg",
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
      bg: "bg-bubble-ai text-bubble-out-fg shadow-bubble",
      rounded: "rounded-lg",
      label: "Agente de IA",
      labelColor: "text-bubble-ai-label",
      variant: "outbound",
      footerText: "text-bubble-out-fg/75",
    };
  }
  return {
    align: "justify-end",
    side: "end",
    bg: "bg-bubble-out text-bubble-out-fg shadow-bubble",
    rounded: "rounded-lg",
    label: "Equipe",
    labelColor: "text-bubble-out-label",
    variant: "outbound",
    footerText: "text-bubble-out-fg/75",
  };
}

const DELIVERY_LABELS: Record<string, string> = {
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};

function DeliveryTick({ message, readOnly = false }: { message: InboxMessage; readOnly?: boolean }) {
  const status = message.deliveryStatus;
  if (!status) return null;
  // Instagram só informa "lida": sem tique de enviada/entregue (seria promessa falsa).
  if (readOnly && status !== "read" && status !== "failed") return null;
  // Em grupo o recibo é por MEMBRO (`Receipt.MessageSender`): o tique mostra o
  // primeiro que entregou/leu, e o tooltip conta quantos já leram — que é a
  // única leitura honesta de "lido" numa sala de N pessoas.
  const readCount = message.readBy?.length ?? 0;
  const title =
    readCount > 0
      ? `${DELIVERY_LABELS[status] ?? status} · Lido por ${readCount}`
      : DELIVERY_LABELS[status] ?? status;
  if (status === "failed") {
    return <AlertCircle className="size-3.5 text-bubble-out-fg shrink-0" aria-label={title} />;
  }
  if (status === "read") {
    return <CheckCheck className="size-3.5 text-tick-read shrink-0" aria-label={title} />;
  }
  if (status === "delivered") {
    return <CheckCheck className="size-3.5 text-current opacity-70 shrink-0" aria-label={title} />;
  }
  return <Check className="size-3.5 text-current opacity-70 shrink-0" aria-label={title} />;
}

/** Texto da bolha: 15px no celular (leitura de WhatsApp), 14px no desktop. */
const BODY_TEXT = "text-[15px] leading-5 md:text-sm";

export function MessageBubble({
  message,
  channel,
  transport,
  canInteract,
  currentMemberId,
  contactName,
  transcribing = false,
  describing = false,
  downloadingMedia = false,
  visionEnabled = false,
  highlighted = false,
  run,
  group,
  onReply,
  onReact,
  onForward,
  onTranscribe,
  onDescribeImage,
  onDownloadMedia,
  onJumpToMessage,
  translation,
  onTranslate,
  onTranslateAs,
  onRetryOutbound,
  onSendUntranslated,
}: MessageBubbleProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Toque longo ancora na bolha; o botão do hover ancora nele mesmo.
  const [menuAnchor, setMenuAnchor] = useState<"trigger" | "bubble">("trigger");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const style = getBubbleStyle(message);
  const attachments = message.attachmentFiles ?? [];
  const hasAttachments = attachments.length > 0;
  const sticker = isSticker(message) || (metaTypeOf(message.metadata) === "sticker" && hasAttachments);
  const voiceNote = isVoiceNote(message);
  const imageMessage = isImageMessage(message);
  const mediaProblem = hasMediaProblem(message);
  // Mídia de grupo não baixada (ou vencida/apagada) — placeholder neutro.
  const mediaState = getMessageMediaState(message.metadata);
  const deferredMedia = mediaState.state === "none" ? null : mediaState;
  // Sem o arquivo não há o que transcrever/ler; mas mídia APAGADA já pode ter
  // sido lida antes, e o texto (transcrição/descrição) continua valendo.
  const mediaPurged = mediaState.state === "purged";

  const deletedByCustomer = isDeletedByCustomer(message.metadata) && !message.isInternal;
  const revoked = (isRevoked(message.metadata) || deletedByCustomer) && !message.isInternal;
  const [historyOpen, setHistoryOpen] = useState(false);
  const metaCard = message.isInternal || revoked ? null : describeMetaCard(message.metadata);
  // Sticker com imagem vira figurinha; o card só aparece quando não há anexo.
  const showMetaCard = !!metaCard && !(metaCard.kind === "sticker" && hasAttachments);
  const storyReply = message.isInternal || revoked ? null : describeStoryReply(message.metadata);
  const unavailableLabel = message.isInternal || revoked ? null : mediaUnavailableLabel(message.metadata);
  const editHistory = editHistoryOf(message.metadata);
  const reactionNote = reactionNoteOf(message.metadata);
  const reactionEmojis = allowedReactionEmojis(channel, transport);
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
  // Reply/react/forward vêm da matriz de capacidades (WhatsApp, Instagram, Messenger).
  const canReplyQuote = channelSupports(channel, transport, "replyQuote");
  const canForward = channelSupports(channel, transport, "forward");
  const canReactSend = channelSupports(channel, transport, "reactionsSend");
  const actionsEnabled = (canReplyQuote || canForward || canReactSend) && !message.isInternal;
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

  const ticksMode = deliveryTicksMode(channel, transport);
  const showDeliveryTick =
    !message.isInternal && message.direction === "outbound" && ticksMode !== false;
  const viaDevice = !message.isInternal && message.metadata?.via === "device";
  const isFailed = showDeliveryTick && message.deliveryStatus === "failed";
  // "Traduzindo e enviando…": nada saiu ainda, então nada de tique.
  const translationPending = message.metadata?.translation?.role === "outbound" && message.metadata.translation.status === "pending";
  const translationFailed = message.metadata?.translation?.role === "outbound" && message.metadata.translation.status === "failed";

  // Suppress server-side placeholders like "[imagem]" when the real media is
  // present (or expected). Real captions still render below the media.
  const suppressPlaceholder =
    isMediaPlaceholder(message.content) &&
    (hasAttachments || voiceNote || mediaProblem || deferredMedia !== null);
  const visibleText =
    !message.isInternal && !revoked && message.content && !suppressPlaceholder
      && !(special && special.kind !== "interactive_reply")
      && !(metaCard && ["like_heart", "sticker", "ig_post", "ig_reel"].includes(metaCard.kind) && isMediaPlaceholder(message.content))
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

  // Tradução: só texto visível de conversa 1 a 1 (o thread já tirou grupo e nota).
  const tview: TranslationView =
    translation && visibleText && !group ? translation.view : { kind: "none" };
  const translated = tview.kind === "translated" ? tview : null;
  const canTranslate = !!translation?.canRequest && !!visibleText && !group && !!onTranslate;
  const hasHistory = edited && editHistory.length > 0;

  // Copiar: as duas versões de uma tradução, ou o texto da bolha (no celular o
  // toque longo abre as ações, então a seleção nativa de texto fica desligada).
  const copyableText = message.isInternal ? message.content : visibleText;
  const copyItems: CopyItem[] | undefined = translated
    ? translated.role === "inbound"
      ? [
          { label: "Copiar tradução", value: translated.primary, done: "Tradução copiada" },
          { label: "Copiar original", value: translated.secondary, done: "Original copiado" },
        ]
      : [
          { label: "Copiar o que foi enviado", value: translated.primary, done: "Texto copiado" },
          { label: "Copiar versão da equipe", value: translated.secondary, done: "Texto copiado" },
        ]
    : copyableText
      ? [{ label: "Copiar texto", value: copyableText, done: "Texto copiado" }]
      : undefined;

  const canShowActions =
    (actionsEnabled && (canInteract || needsTranscription || needsVision || canTranslate || !!translated)) ||
    !!copyItems ||
    hasHistory;

  const openMenu = (anchor: "trigger" | "bubble") => {
    setMenuAnchor(anchor);
    setMenuOpen(true);
  };
  const longPress = useLongPress(() => openMenu("bubble"), canShowActions);

  // ── Rótulo do remetente: só quando informa (grupo, IA, outro membro, nota) ──
  const labelKind = senderLabelKind(message, { isGroup: !!group, currentMemberId });
  const showSender = (run?.showSender ?? labelKind !== null) && labelKind !== null;
  const senderName = message.sender?.name ?? null;
  const senderLabel: ReactNode = !showSender ? null : labelKind === "group" && groupSender ? (
    groupSender.contactId && group?.onOpenContact ? (
      <button
        type="button"
        onClick={() => group.onOpenContact?.(groupSender.contactId!)}
        aria-label={`Abrir contato de ${groupSender.name}`}
        className="relative min-w-0 truncate rounded-sm text-left hover:underline after:absolute after:-inset-y-3 after:inset-x-0 after:content-[''] md:after:-inset-y-1"
        style={{ color: groupSender.color }}
      >
        {groupSender.name}
      </button>
    ) : (
      <span className="truncate" style={{ color: groupSender.color }}>
        {groupSender.name}
      </span>
    )
  ) : labelKind === "ai" ? (
    <span className="truncate">{senderName ? `IA · ${senderName}` : "Atendente IA"}</span>
  ) : labelKind === "note" ? (
    <span className="truncate">{senderName ? `${style.label} · ${senderName}` : style.label}</span>
  ) : labelKind === "team" ? (
    <span className="truncate">{senderName || style.label}</span>
  ) : null;
  const badges = (message.metadata?.campaign || message.metadata?.followUp) && (
    <>
      {message.metadata?.campaign && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-black/15 px-1.5 py-px text-micro font-medium opacity-80"
          title="Enviada por campanha"
        >
          <Megaphone size={9} aria-hidden /> Campanha
        </span>
      )}
      {message.metadata?.followUp && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-black/15 px-1.5 py-px text-micro font-medium opacity-80"
          title="Follow-up executado pela IA"
        >
          <Bot size={9} aria-hidden /> follow-up
        </span>
      )}
    </>
  );
  const labelRow = (senderLabel || badges) && (
    <div className={cn("flex min-w-0 items-center gap-1.5 text-caption font-medium", style.labelColor, canShowActions && "pr-5")}>
      {senderLabel}
      {badges}
    </div>
  );

  // ── Hora + tiques (dentro da bolha, canto de baixo) ──
  const readCount = message.readBy?.length ?? 0;
  const time = formatTime(message.createdAt);
  /** `live`: a cópia visível; a outra é o espaçador invisível que reserva a largura no fim do texto. */
  const metaContent = (live: boolean) => (
    <>
      {edited && (
        <span
          className="italic"
          title={
            live
              ? typeof message.metadata?.previousContent === "string"
                ? `Texto anterior: ${message.metadata.previousContent.slice(0, 500)}`
                : "Mensagem editada"
              : undefined
          }
        >
          editada
        </span>
      )}
      {viaDevice && <span>{deviceViaLabel(message.metadata?.viaApp, channel)}</span>}
      <time dateTime={live ? new Date(message.createdAt).toISOString() : undefined} className="tabular-nums">
        {time}
      </time>
      {showDeliveryTick && !translationPending && (
        live && readCount > 0 ? (
          <Tooltip content={`Lido por ${readCount}`}>
            <DeliveryTick message={message} readOnly={ticksMode === "read"} />
          </Tooltip>
        ) : (
          <DeliveryTick message={message} readOnly={ticksMode === "read"} />
        )
      )}
    </>
  );
  const META = "inline-flex items-center gap-1 whitespace-nowrap leading-4";

  const failureNote = isFailed && !translationFailed && message.metadata?.deliveryError;
  const dispatchNote =
    !message.isInternal && typeof message.metadata?.dispatchNote === "string" && message.metadata.dispatchNote
      ? message.metadata.dispatchNote
      : null;
  const hasText = message.isInternal ? !!message.content : !!visibleText;
  // Hora na última linha do texto (truque do WhatsApp): só quando o texto é o
  // último bloco da bolha; senão ela ganha a própria linha, à direita.
  const metaInline = hasText && !failureNote && !dispatchNote && !(hasHistory && historyOpen);
  const spacer = metaInline ? (
    <span aria-hidden className={cn("text-caption", META, "invisible ml-2 align-bottom")}>
      {metaContent(false)}
    </span>
  ) : null;

  const historyList = hasHistory && historyOpen && (
    <ol
      aria-label="Versões anteriores"
      className={cn("text-caption", 
        "flex flex-col gap-1 rounded-md px-2 py-1.5",
        style.variant === "outbound" ? "bg-bubble-out-fg/10 text-bubble-out-fg/85" : "bg-text-primary/5 text-text-secondary"
      )}
    >
      {editHistory.map((v, i) => (
        <li key={i} className="break-words">
          {v.at ? <span className="mr-1 tabular-nums opacity-75">{formatDateTime(v.at)}</span> : null}
          {v.content.slice(0, 500)}
        </li>
      ))}
    </ol>
  );

  const reactionChips = reactions.length > 0 && (
    <ReactionChips
      reactions={reactions}
      currentMemberId={currentMemberId}
      align={style.side}
      onToggle={
        canInteract && actionsEnabled && canReactSend
          ? (emoji) => {
              if (reactionEmojis && !reactionEmojis.includes(emoji)) return;
              onReact(message, emoji);
            }
          : undefined
      }
    />
  );

  const menu = canShowActions && (
    <MessageActionsBar
      open={menuOpen}
      onClose={() => setMenuOpen(false)}
      anchor={menuAnchor === "bubble" ? bubbleRef : triggerRef}
      align={style.side}
      canInteract={canInteract && actionsEnabled}
      activeEmoji={activeEmoji}
      reactionEmojis={reactionEmojis}
      onReply={canReplyQuote ? () => onReply(message) : undefined}
      onReact={canReactSend ? (emoji) => onReact(message, emoji) : undefined}
      // Numa sala de grupo não há encaminhar: o conteúdo é de dezenas de
      // terceiros e o servidor recusa (review de correção nº 1).
      onForward={group || !canForward ? undefined : () => onForward(message)}
      onTranscribe={actionsEnabled && needsTranscription ? () => onTranscribe(message) : undefined}
      onDescribeImage={actionsEnabled && needsVision ? () => onDescribeImage(message) : undefined}
      onTranslate={actionsEnabled && canTranslate ? () => onTranslate?.(message) : undefined}
      onToggleHistory={hasHistory ? () => setHistoryOpen((v) => !v) : undefined}
      historyOpen={historyOpen}
      copyItems={copyItems}
      onCopy={(item) => void copyText(item.value, item.done)}
    />
  );

  /** Botão das ações: aparece no hover/foco (desktop); no toque fica só para leitor de tela. */
  const trigger = canShowActions && (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => (menuOpen ? setMenuOpen(false) : openMenu("trigger"))}
      aria-label="Ações da mensagem"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      className={cn(
        "absolute right-1 top-1 z-10 flex size-6 items-center justify-center rounded-full shadow-sm",
        bubbleless ? "bg-surface-overlay text-text-secondary" : cn("bg-inherit", style.footerText),
        "opacity-0 transition-opacity group-hover/bubble:opacity-100 focus-visible:opacity-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        menuOpen && "opacity-100",
        "coarse:sr-only coarse:focus-visible:not-sr-only"
      )}
    >
      <ChevronDown size={16} aria-hidden />
    </button>
  );

  const first = run?.first ?? true;
  const tail = first && !message.isInternal && !bubbleless ? (style.side === "end" ? "bubble-tail-end" : "bubble-tail-start") : null;
  const column = "relative flex min-w-0 max-w-[80%] flex-col md:max-w-[65%] xl:max-w-xl";

  if (bubbleless) {
    return (
      <div id={`msg-${message._id}`} className={cn("flex scroll-mt-4 px-2", style.align)}>
        <div className={column}>
          <div
            ref={bubbleRef}
            {...longPress}
            className={cn("bubble-touch group/bubble relative flex flex-col gap-1", highlighted && "rounded-lg ring-2 ring-brand-500")}
          >
            {trigger}
            <MessageAttachments files={attachments} variant={style.variant} sticker />
            <span className={cn("text-caption", META, "self-end rounded-full bg-surface-overlay/80 px-1.5 text-text-muted shadow-bubble")}>
              {metaContent(true)}
            </span>
            {historyList}
          </div>
          {reactionChips}
          {menu}
        </div>
      </div>
    );
  }

  return (
    <div id={`msg-${message._id}`} className={cn("flex scroll-mt-4 px-2", style.align)}>
      <div className={column}>
        <div
          ref={bubbleRef}
          {...longPress}
          className={cn(
            "bubble-touch group/bubble relative flex min-w-0 flex-col gap-1 px-2.5 py-1.5",
            style.bg,
            style.rounded,
            tail,
            quoted && "min-w-56",
            isFailed && "ring-1 ring-semantic-error/60",
            highlighted && "ring-2 ring-brand-500 ring-offset-2 ring-offset-chat-bg transition-shadow"
          )}
        >
          {trigger}
          {labelRow}

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

          {storyReply && <StoryReplyStrip href={storyReply.href} variant={style.variant} />}

          {showMetaCard && metaCard && (
            <MetaSpecialCard info={metaCard} variant={style.variant} hasMedia={hasAttachments} />
          )}

          {unavailableLabel && !hasAttachments && (
            <MediaUnavailablePlaceholder label={unavailableLabel} detail={mediaUnavailableDetail(message.metadata)} variant={style.variant} />
          )}

          {!revoked && mediaProblem && !unavailableLabel && (
            <div
              className={cn(
                "flex items-center gap-1.5 text-xs italic",
                style.variant === "outbound" ? "text-bubble-out-fg/80" : "text-text-muted"
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
                "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-micro font-medium",
                style.variant === "outbound" ? "bg-bubble-out-fg/15 text-bubble-out-fg/90" : "bg-surface-sunken text-text-secondary"
              )}
            >
              <Eye size={10} aria-hidden /> Visualização única
            </span>
          )}

          {revoked && (
            <div
              className={cn(
                "flex items-center gap-1.5 text-sm italic",
                style.variant === "outbound" ? "text-bubble-out-fg/80" : "text-text-muted"
              )}
            >
              <Ban size={14} className="shrink-0" aria-hidden />
              {deletedByCustomer ? DELETED_BY_CUSTOMER_LABEL : "Mensagem apagada"}
            </div>
          )}

          {special && special.kind !== "interactive_reply" && (
            <SpecialMessageCard info={special} variant={style.variant} />
          )}

          {special?.kind === "interactive_reply" && (
            <span
              className={cn("text-caption", "font-medium uppercase tracking-wide", style.variant === "outbound" ? "text-bubble-out-fg/75" : "text-text-muted")}
            >
              resposta de botão
            </span>
          )}

          {message.isInternal ? (
            <div className={`${BODY_TEXT} [&>p]:inline`}>
              <MentionRenderer content={message.content} className={cn(BODY_TEXT, "whitespace-pre-wrap break-words")} />
              {spacer}
            </div>
          ) : visibleText && group && group.mentionTokens.length > 0 ? (
            <div className={`${BODY_TEXT} [&>p]:inline`}>
              <GroupMentionText text={visibleText} tokens={group.mentionTokens} className={BODY_TEXT} />
              {spacer}
            </div>
          ) : visibleText && tview.kind !== "none" ? (
            <MessageTranslation
              view={tview}
              text={visibleText}
              variant={style.variant}
              showBoth={translation?.showBoth}
              busy={translation?.busy}
              onRetry={onTranslate ? () => onTranslate(message) : undefined}
              onRetryOutbound={canInteract && onRetryOutbound ? () => onRetryOutbound(message) : undefined}
              onSendUntranslated={canInteract && onSendUntranslated ? () => onSendUntranslated(message) : undefined}
              onTranslateAs={onTranslateAs ? (lang) => onTranslateAs(message, lang) : undefined}
              textClassName={BODY_TEXT}
              trailing={spacer}
            />
          ) : (
            visibleText && (
              <div className={`${BODY_TEXT} [&>p]:inline`}>
                <FormattedMessageText text={visibleText} variant={style.variant} className={BODY_TEXT} />
                {spacer}
              </div>
            )
          )}

          {failureNote && (
            <p className={cn("text-caption", style.variant === "outbound" ? "text-bubble-out-fg" : "text-semantic-error")}>
              {message.metadata?.deliveryError}
            </p>
          )}
          {/* Falha parcial / "só o texto saiu": aparece mesmo sem status failed. */}
          {dispatchNote && (
            <p className={cn("text-caption", "flex items-start gap-1", style.variant === "outbound" ? "text-bubble-out-fg" : "text-semantic-warning")}>
              <AlertTriangle className="size-3 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{dispatchNote}</span>
            </p>
          )}
          {historyList}

          {metaInline ? (
            <span className={cn("text-caption", META, "absolute bottom-1 right-2.5", style.footerText)}>{metaContent(true)}</span>
          ) : (
            <span className={cn("text-caption", META, "-mt-0.5 self-end", style.footerText)}>{metaContent(true)}</span>
          )}
        </div>
        {reactionChips}
        {reactionNote && reactions.length > 0 && (
          <p className="px-1 text-caption text-text-muted">{reactionNote}</p>
        )}
        {menu}
      </div>
    </div>
  );
}
