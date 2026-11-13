import { Avatar } from "@/components/ui/Avatar";
import { conversationPreviewText } from "@/lib/bridgeSpecialMessage";
import { channelIcon, channelLabel } from "@/lib/channelAccounts";
import { formatListTime } from "@/lib/format";
import { contactResultName } from "@/lib/inboxSearch";
import { cn } from "@/lib/utils";

/** Linha de `conversations.searchConversationsByContact`. */
export interface InboxContactResult {
  conversationId: string;
  contactName: string;
  /** Contato sem nome: @ do Instagram ou título do lead. */
  fallbackName?: string | null;
  avatarUrl?: string | null;
  phoneSuffix: string | null;
  channel: string;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  lastMessageDirection: string | null;
  lastMessageBridgeType: string | null;
  lastMessageRevoked: boolean;
  unreadCount: number;
  archived: boolean;
}

/** Cabeçalho pequeno e discreto de uma seção da busca ("Contatos", "Mensagens"). */
export function SearchSectionHeader({ children }: { children: string }) {
  return (
    <h3 className="px-4 pt-3 pb-1 text-caption font-semibold uppercase tracking-wide text-text-muted">{children}</h3>
  );
}

interface ContactSearchRowProps {
  result: InboxContactResult;
  onOpen: (result: InboxContactResult) => void;
  /** "Agora" da hora (prop para a linha seguir pura); ausente = relógio atual. */
  now?: number;
}

/**
 * Uma conversa achada pelo contato, na mesma linguagem da lista: avatar (foto)
 * com o canal no canto, nome + hora, prévia + não lidas (apresentacional).
 */
export function ContactSearchRow({ result, onOpen, now }: ContactSearchRowProps) {
  const name = contactResultName(result);
  const unread = result.unreadCount;
  const ChannelIcon = channelIcon(result.channel, null);
  return (
    <button
      type="button"
      onClick={() => onOpen(result)}
      className="flex w-full items-center gap-3 pl-4 text-left transition-colors hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
    >
      <span className="relative shrink-0" aria-hidden="true">
        <Avatar name={result.contactName.trim() || result.fallbackName?.trim() || "?"} size="lg" imageUrl={result.avatarUrl} />
        <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface-base text-brand-500 ring-1 ring-border">
          <ChannelIcon size={12} />
        </span>
      </span>
      <span className="min-w-0 flex-1 border-b border-border py-3 pr-4">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-base font-semibold leading-tight text-text-primary">{name}</span>
          <span className="sr-only">{channelLabel(result.channel)}</span>
          {result.archived && (
            <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-micro text-text-muted">
              Arquivada
            </span>
          )}
          {result.lastMessageAt !== null && (
            <span
              className={cn(
                "shrink-0 text-caption tabular-nums",
                unread > 0 ? "font-semibold text-brand-500" : "text-text-muted"
              )}
            >
              {formatListTime(result.lastMessageAt, now ?? Date.now())}
            </span>
          )}
        </span>
        <span className="mt-1 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm leading-tight text-text-muted">
            {result.lastMessagePreview
              ? `${result.lastMessageDirection === "outbound" ? "Você: " : ""}${conversationPreviewText(
                  result.lastMessagePreview,
                  result.lastMessageBridgeType,
                  result.lastMessageRevoked
                )}`
              : "Sem mensagens"}
          </span>
          {unread > 0 && (
            <span
              className="flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-badge-unread px-1.5 text-micro font-semibold leading-none text-badge-unread-fg tabular-nums"
              aria-label={`${unread} mensagens não lidas`}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
