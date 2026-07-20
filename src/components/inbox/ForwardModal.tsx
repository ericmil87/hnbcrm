import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Search, Forward, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import type { InboxMessage } from "./types";

interface ForwardModalProps {
  open: boolean;
  organizationId: Id<"organizations">;
  message: InboxMessage | null;
  /** Exclude the source conversation from the target list. */
  currentConversationId?: string | null;
  onClose: () => void;
}

function channelBadgeVariant(channel: string) {
  switch (channel) {
    case "whatsapp":
      return "success" as const;
    case "telegram":
      return "info" as const;
    case "email":
      return "brand" as const;
    default:
      return "default" as const;
  }
}

export function ForwardModal({
  open,
  organizationId,
  message,
  currentConversationId,
  onClose,
}: ForwardModalProps) {
  const [search, setSearch] = useState("");
  const [sendingTo, setSendingTo] = useState<string | null>(null);

  const forwardMessage = useMutation(api.conversations.forwardMessage);
  const conversations = useQuery(
    api.conversations.getConversations,
    open ? { organizationId } : "skip"
  );

  const valid = useMemo(() => {
    const list = (conversations ?? []).filter(
      (c: any): c is any => c && c._id !== currentConversationId
    );
    const term = search.trim().toLowerCase();
    if (!term) return list;
    return list.filter((c: any) => {
      const name = `${c.contact?.firstName ?? ""} ${c.contact?.lastName ?? ""}`.toLowerCase();
      const leadTitle = (c.lead?.title ?? "").toLowerCase();
      return name.includes(term) || leadTitle.includes(term);
    });
  }, [conversations, currentConversationId, search]);

  const handleForward = async (targetConversationId: string) => {
    if (!message || sendingTo) return;
    setSendingTo(targetConversationId);
    try {
      await forwardMessage({
        messageId: message._id as Id<"messages">,
        targetConversationId: targetConversationId as Id<"conversations">,
      });
      toast.success("Mensagem encaminhada");
      onClose();
    } catch {
      toast.error("Falha ao encaminhar mensagem");
    } finally {
      setSendingTo(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Encaminhar mensagem">
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar conversa..."
            className="w-full h-11 pl-9 pr-3 text-base md:text-sm bg-surface-sunken border border-border-strong text-text-primary rounded-lg focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            aria-label="Buscar conversa"
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
          {conversations === undefined ? (
            <div className="flex justify-center py-8">
              <Spinner size="md" />
            </div>
          ) : valid.length === 0 ? (
            <p className="text-center text-sm text-text-muted py-8">Nenhuma conversa encontrada</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {valid.map((c: any) => {
                const sending = sendingTo === c._id;
                return (
                  <li key={c._id}>
                    <button
                      type="button"
                      onClick={() => handleForward(c._id)}
                      disabled={!!sendingTo}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors",
                        "hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-500",
                        "disabled:opacity-60 disabled:cursor-not-allowed"
                      )}
                    >
                      <Avatar
                        name={`${c.contact?.firstName ?? "?"} ${c.contact?.lastName ?? ""}`.trim() || "?"}
                        size="sm"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">
                          {c.contact?.firstName} {c.contact?.lastName}
                        </p>
                        {c.lead?.title && (
                          <p className="text-xs text-text-muted truncate">{c.lead.title}</p>
                        )}
                      </div>
                      <Badge variant={channelBadgeVariant(c.channel)}>{c.channel}</Badge>
                      {sending ? (
                        <Loader2 size={16} className="animate-spin text-brand-500 shrink-0" />
                      ) : (
                        <Forward size={16} className="text-text-muted shrink-0" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
