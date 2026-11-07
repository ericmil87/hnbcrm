import {
  ArrowLeftRight,
  BarChart3,
  Bot,
  Calendar,
  Check,
  FileText,
  HelpCircle,
  Image as ImageIcon,
  Images,
  Link2,
  MapPin,
  Mic,
  MousePointerClick,
  Phone,
  UserRound,
  Users,
  Video,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { ChannelOriginBadge } from "@/components/inbox/ChannelOriginBadge";
import { ColorChip, AttributionIcon } from "@/components/inbox/central/CentralChips";
import type { LeadAttribution } from "@/components/inbox/central/centralMeta";
import { useLongPress } from "@/components/inbox/useLongPress";
import { conversationPreviewText } from "@/lib/bridgeSpecialMessage";
import { accountBadgeLabel, channelIcon, channelLabel, type InboxChannelAccount } from "@/lib/channelAccounts";
import { formatDate, formatListTime } from "@/lib/format";
import { activeBotSuspicion, isHandoffPending, type BotSuspicion, type LeadHandoffState } from "@/lib/inboxState";
import { cn } from "@/lib/utils";

/** Campos de uma linha de `conversations.getConversations` que a lista usa. */
export interface ConversationListEntry {
  _id: string;
  kind?: string;
  channel: string;
  channelProvider?: string | null;
  channelConfigId?: string | null;
  groupChat?: { subject?: string; participantsCount?: number } | null;
  contact?: { firstName?: string | null; lastName?: string | null } | null;
  lead?: {
    title?: string | null;
    handoffState?: LeadHandoffState;
    attribution?: LeadAttribution | null;
  } | null;
  labelIds?: readonly string[] | null;
  botSuspicion?: BotSuspicion;
  unitId?: string | null;
  departmentId?: string | null;
  assignee?: { name?: string | null; type?: string | null } | null;
  lastMessagePreview?: string | null;
  lastMessageContentType?: string | null;
  lastMessageBridgeType?: string | null;
  lastMessageDirection?: string | null;
  lastMessageRevoked?: boolean | null;
  lastMessageAt?: number | null;
  messageCount: number;
  unreadCount?: number | null;
}

export interface ConversationListLabel {
  name: string;
  color: string;
}

export interface ConversationListCentralChips {
  unit?: { name: string; color?: string };
  department?: { name: string; color?: string };
  attribution?: LeadAttribution;
}

interface ConversationListItemProps {
  conversation: ConversationListEntry;
  /** É a conversa aberta ao lado. */
  selected: boolean;
  selectionMode: boolean;
  /** Marcada na seleção múltipla. */
  checked: boolean;
  labelById: ReadonlyMap<string, ConversationListLabel>;
  account?: InboxChannelAccount | null;
  showAccount: boolean;
  /** Unidade/departamento/origem (módulo Central); só em conversa 1 a 1. */
  central?: ConversationListCentralChips;
  onClick: () => void;
  /**
   * `compact` = celular (< md), estilo WhatsApp: avatar com o canal no canto,
   * 2 linhas (nome + hora | prévia + não lidas), separador depois do avatar.
   * `default` = a linha do desktop, igual a antes.
   */
  variant?: "default" | "compact";
  /** Tocar e segurar (só toque/caneta): entra na seleção com este item. */
  onLongPress?: () => void;
  /** "Agora" da hora do `compact` (prop para a linha seguir pura). */
  now?: number;
}

// Ícone de mídia da prévia da última mensagem.
function previewIcon(contentType: string | null, bridgeType: string | null) {
  if (contentType === "audio" || bridgeType === "audio") return Mic;
  if (contentType === "image" || bridgeType === "sticker" || bridgeType === "image") return ImageIcon;
  if (bridgeType === "video") return Video;
  if (contentType === "file") return FileText;
  switch (bridgeType) {
    case "album":
      return Images;
    case "poll":
      return BarChart3;
    case "location":
    case "live_location":
      return MapPin;
    case "contact":
      return UserRound;
    case "event":
      return Calendar;
    case "group_invite":
      return Link2;
    case "call_log":
      return Phone;
    case "interactive_reply":
      return MousePointerClick;
    case "unknown":
      return HelpCircle;
  }
  return null;
}

/** Nome exibido: assunto do grupo ou nome do contato. */
export function conversationDisplayName(c: ConversationListEntry): string {
  if (c.kind === "group") return c.groupChat?.subject ?? "Grupo";
  return `${c.contact?.firstName ?? ""} ${c.contact?.lastName ?? ""}`.trim() || "Sem nome";
}

/**
 * Título do lead na lista (D2): só quando diz algo além do nome do contato
 * (diferente, ignorando caixa e espaços); grupo não mostra.
 */
export function leadTitleToShow(c: ConversationListEntry): string | null {
  if (c.kind === "group") return null;
  const title = c.lead?.title?.trim();
  if (!title) return null;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");
  return norm(title) === norm(conversationDisplayName(c)) ? null : title;
}

/** Uma linha da lista de conversas (apresentacional: tudo por props). */
export function ConversationListItem(props: ConversationListItemProps) {
  return props.variant === "compact" ? <CompactItem {...props} /> : <DefaultItem {...props} />;
}

const BADGE_CLASS =
  "flex shrink-0 items-center justify-center rounded-full bg-badge-unread text-badge-unread-fg text-micro font-semibold leading-none tabular-nums";

/** Celular: 2 linhas estilo WhatsApp. */
function CompactItem({
  conversation,
  selected,
  selectionMode,
  checked,
  labelById,
  account,
  showAccount,
  central,
  onClick,
  onLongPress,
  now,
}: ConversationListItemProps) {
  // Sempre ligado (com `onLongPress`) e decide dentro: desligar ao entrar na
  // seleção tirava o `onClickCapture` antes do dedo sair, e o clique do iOS ao
  // soltar desmarcava o item recém-selecionado ("0 selecionadas").
  const longPress = useLongPress(() => {
    if (!selectionMode) onLongPress?.();
  }, Boolean(onLongPress));
  const unread = conversation.unreadCount ?? 0;
  const isGroup = conversation.kind === "group";
  const name = conversationDisplayName(conversation);
  const leadTitle = leadTitleToShow(conversation);
  const PreviewIcon = conversation.lastMessagePreview
    ? previewIcon(conversation.lastMessageContentType ?? null, conversation.lastMessageBridgeType ?? null)
    : null;
  const ChannelIcon = channelIcon(conversation.channel, conversation.channelProvider);
  const accountLabel = showAccount && account ? accountBadgeLabel(account) : "";
  const hasCentral = Boolean(central && (central.unit || central.department || central.attribution));

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      {...longPress}
      aria-current={!selectionMode && selected ? "true" : undefined}
      aria-pressed={selectionMode ? checked : undefined}
      className={cn(
        "flex items-center gap-3 pl-4 cursor-pointer select-none transition-colors [-webkit-touch-callout:none]",
        "hover:bg-surface-overlay active:bg-surface-overlay",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
        ((!selectionMode && selected) || (selectionMode && checked)) && "bg-brand-500/10"
      )}
    >
      {selectionMode && (
        <span
          data-testid="selection-box"
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
            checked ? "bg-brand-600 border-brand-600 text-white" : "border-border-strong"
          )}
          aria-hidden
        >
          {checked && <Check size={12} />}
        </span>
      )}

      {/* Avatar com o canal no canto (no lugar da pílula "WhatsApp"). */}
      <span className="relative shrink-0" aria-hidden="true">
        {isGroup ? (
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-sunken text-text-secondary">
            <Users size={22} />
          </span>
        ) : (
          <Avatar name={name} size="lg" />
        )}
        <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface-base text-brand-500 ring-1 ring-border">
          <ChannelIcon size={12} />
        </span>
      </span>

      {/* Separador começa depois do avatar, como no WhatsApp. */}
      <div className="min-w-0 flex-1 border-b border-border py-3 pr-4">
        <div className="flex items-center gap-2">
          <h3 className="flex min-w-0 flex-1 items-center gap-1.5 text-base font-semibold leading-tight text-text-primary">
            <span className="truncate">{name}</span>
            {(conversation.labelIds ?? []).map((labelId) => {
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
          <span className="sr-only">
            {isGroup ? "Conversa de grupo, " : ""}
            {channelLabel(conversation.channel)}
          </span>
          {conversation.lastMessageAt && (
            <span
              className={cn(
                "shrink-0 text-caption tabular-nums",
                unread > 0 ? "font-semibold text-brand-500" : "text-text-muted"
              )}
            >
              {formatListTime(conversation.lastMessageAt, now ?? Date.now())}
            </span>
          )}
        </div>

        <div className="mt-1 flex items-center gap-2">
          <p
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1 text-sm leading-tight",
              unread > 0 ? "text-text-secondary" : "text-text-muted"
            )}
          >
            {accountLabel && <span className="shrink-0 text-caption">{accountLabel} ·</span>}
            {leadTitle && (
              <span className="max-w-[45%] shrink-0 truncate text-caption font-medium text-text-secondary" title={leadTitle}>
                {leadTitle} ·
              </span>
            )}
            {conversation.lastMessagePreview ? (
              <>
                {PreviewIcon ? <PreviewIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
                <span className="truncate">
                  {conversation.lastMessageDirection === "outbound" ? "Você: " : ""}
                  {conversationPreviewText(
                    conversation.lastMessagePreview,
                    conversation.lastMessageBridgeType ?? null,
                    conversation.lastMessageRevoked === true
                  )}
                </span>
              </>
            ) : (
              <span className="truncate tabular-nums">
                {conversation.messageCount} {conversation.messageCount === 1 ? "mensagem" : "mensagens"}
              </span>
            )}
          </p>
          {isHandoffPending(conversation.lead?.handoffState) && (
            <span
              role="img"
              aria-label="Pediu ajuda"
              className="shrink-0 inline-flex items-center rounded-full bg-semantic-warning/10 p-1 text-semantic-warning"
            >
              <ArrowLeftRight size={12} aria-hidden="true" />
            </span>
          )}
          {activeBotSuspicion(conversation) && (
            <span
              role="img"
              aria-label="Suspeita de robô"
              className="shrink-0 inline-flex items-center rounded-full bg-semantic-warning/10 p-1 text-semantic-warning"
            >
              <Bot size={12} aria-hidden />
            </span>
          )}
          {unread > 0 && (
            <span className={cn(BADGE_CLASS, "h-5 min-w-[20px] px-1.5")} aria-label={`${unread} mensagens não lidas`}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>

        {hasCentral && central && (
          <div className="mt-1 flex min-w-0 items-center gap-1">
            {central.attribution && <AttributionIcon attribution={central.attribution} />}
            {central.unit && (
              <ColorChip name={central.unit.name} color={central.unit.color} title={`Unidade: ${central.unit.name}`} />
            )}
            {central.department && (
              <ColorChip
                name={central.department.name}
                color={central.department.color}
                title={`Departamento: ${central.department.name}`}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Desktop (md+): a linha de sempre. */
function DefaultItem({
  conversation,
  selected,
  selectionMode,
  checked,
  labelById,
  account,
  showAccount,
  central,
  onClick,
}: ConversationListItemProps) {
  const unread = conversation.unreadCount ?? 0;
  const PreviewIcon = conversation.lastMessagePreview
    ? previewIcon(conversation.lastMessageContentType ?? null, conversation.lastMessageBridgeType ?? null)
    : null;
  const membersCount = conversation.groupChat?.participantsCount ?? 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      aria-current={!selectionMode && selected ? "true" : undefined}
      aria-pressed={selectionMode ? checked : undefined}
      className={cn(
        "p-4 border-b border-border cursor-pointer transition-colors",
        "hover:bg-surface-overlay active:bg-surface-overlay",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
        unread > 0 && !selected && "bg-brand-500/5",
        !selectionMode && selected && "bg-brand-500/10 border-l-2 border-l-brand-500",
        selectionMode && checked && "bg-brand-500/10"
      )}
    >
      <div className="flex items-center justify-between mb-2">
        {selectionMode && (
          <span
            data-testid="selection-box"
            className={cn(
              "mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
              checked ? "bg-brand-500 border-brand-500 text-white" : "border-border-strong"
            )}
            aria-hidden
          >
            {checked && <Check size={11} />}
          </span>
        )}
        <h3
          className={cn(
            "flex items-center gap-1.5 min-w-0 flex-1 text-text-primary truncate",
            unread > 0 ? "font-semibold" : "font-medium"
          )}
        >
          {conversation.kind === "group" && (
            <Users size={14} className="shrink-0 text-text-muted" aria-label="Conversa de grupo" />
          )}
          <span className="truncate">{conversationDisplayName(conversation)}</span>
          {(conversation.labelIds ?? []).map((labelId) => {
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
        <ChannelOriginBadge
          channel={conversation.channel}
          transport={conversation.channelProvider}
          account={account}
          showAccount={showAccount}
        />
      </div>

      {conversation.kind === "group" && (
        <p className="mb-1 text-sm text-text-secondary tabular-nums">
          {membersCount} membro{membersCount === 1 ? "" : "s"}
        </p>
      )}

      {conversation.lead && (
        <div className="flex items-center gap-1.5 mb-1 min-w-0">
          <p className="flex-1 min-w-0 text-sm text-text-secondary truncate">{conversation.lead.title}</p>
          {isHandoffPending(conversation.lead.handoffState) && (
            <span
              className="shrink-0 inline-flex items-center gap-1 rounded-full bg-semantic-warning/10 px-1.5 py-0.5 text-micro font-medium text-semantic-warning"
              title="Pedido de ajuda pendente: aguardando alguém da equipe assumir"
            >
              <ArrowLeftRight size={12} aria-hidden="true" />
              Pediu ajuda
            </span>
          )}
          {activeBotSuspicion(conversation) && (
            <span
              className="shrink-0 inline-flex items-center rounded-full bg-semantic-warning/10 p-1 text-semantic-warning"
              title="Suspeita de robô"
              aria-label="Suspeita de robô"
              role="img"
            >
              <Bot size={12} aria-hidden />
            </span>
          )}
        </div>
      )}

      {central && (central.unit || central.department || central.attribution) && (
        <div className="mb-1.5 flex min-w-0 items-center gap-1">
          {central.attribution && <AttributionIcon attribution={central.attribution} />}
          {central.unit && (
            <ColorChip name={central.unit.name} color={central.unit.color} title={`Unidade: ${central.unit.name}`} />
          )}
          {central.department && (
            <ColorChip
              name={central.department.name}
              color={central.department.color}
              title={`Departamento: ${central.department.name}`}
            />
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        {conversation.lastMessagePreview ? (
          <span
            className={cn(
              "flex items-center gap-1 min-w-0 text-xs",
              unread > 0 ? "text-text-primary font-medium" : "text-text-muted"
            )}
          >
            {PreviewIcon ? <PreviewIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : null}
            <span className="truncate">
              {conversation.lastMessageDirection === "outbound" ? "Você: " : ""}
              {conversationPreviewText(
                conversation.lastMessagePreview,
                conversation.lastMessageBridgeType ?? null,
                conversation.lastMessageRevoked === true
              )}
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
            <span className={cn("text-xs tabular-nums", unread > 0 ? "text-brand-500 font-medium" : "text-text-muted")}>
              {formatDate(conversation.lastMessageAt)}
            </span>
          )}
          {unread > 0 && (
            <span
              className="min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-badge-unread text-badge-unread-fg text-micro font-semibold leading-none tabular-nums"
              aria-label={`${unread} mensagens não lidas`}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
