import { Avatar } from "@/components/ui/Avatar";
import { conversationPreviewText } from "@/lib/bridgeSpecialMessage";
import { channelLabel } from "@/lib/channelAccounts";
import { formatDate } from "@/lib/format";
import { contactResultName } from "@/lib/inboxSearch";

/** Linha de `conversations.searchConversationsByContact`. */
export interface InboxContactResult {
  conversationId: string;
  contactName: string;
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
}

/** Uma conversa achada pelo contato: avatar, nome, prévia da última mensagem e hora (apresentacional). */
export function ContactSearchRow({ result, onOpen }: ContactSearchRowProps) {
  const name = contactResultName(result);
  const unread = result.unreadCount;
  return (
    <button
      type="button"
      onClick={() => onOpen(result)}
      className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
    >
      <Avatar name={result.contactName.trim() || "?"} size="md" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{name}</span>
          <span className="sr-only">{channelLabel(result.channel)}</span>
          {result.archived && (
            <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-0.5 text-micro text-text-muted">
              Arquivada
            </span>
          )}
          {result.lastMessageAt !== null && (
            <span className="shrink-0 text-xs text-text-muted tabular-nums">{formatDate(result.lastMessageAt)}</span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
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
