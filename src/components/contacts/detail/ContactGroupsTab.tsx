import { Users, MessageSquare, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";

type ContactGroupRow = {
  _id: string;
  subject: string;
  conversationId: string | null;
  participantsCount: number;
  lastMessageAt: number | null;
  isAdmin: boolean;
};

export function ContactGroupsTab({
  groups,
  onOpenConversation,
}: {
  groups: ContactGroupRow[] | undefined;
  onOpenConversation: (conversationId: string) => void;
}) {
  if (groups === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size="md" />
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center text-center py-10">
        <div className="w-14 h-14 rounded-full bg-surface-overlay flex items-center justify-center mb-3">
          <Users size={26} className="text-text-muted" />
        </div>
        <p className="text-sm font-medium text-text-primary">Nenhum grupo em comum</p>
        <p className="text-sm text-text-secondary mt-1 max-w-xs">
          Aparecem aqui os grupos de WhatsApp acompanhados pelo CRM em que este
          contato é participante.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div
          key={group._id}
          className="rounded-card border border-border bg-surface-sunken p-3"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Users size={14} className="shrink-0 text-text-muted" aria-hidden />
            <span className="truncate text-sm font-medium text-text-primary">
              {group.subject}
            </span>
            {group.isAdmin && (
              <Badge variant="info">
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck size={10} /> admin
                </span>
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-muted tabular-nums">
            {group.participantsCount} membro{group.participantsCount === 1 ? "" : "s"}
            {group.lastMessageAt
              ? ` · ativo em ${new Date(group.lastMessageAt).toLocaleDateString("pt-BR")}`
              : ""}
          </p>
          {group.conversationId && (
            <button
              type="button"
              onClick={() => onOpenConversation(group.conversationId!)}
              className="mt-2 inline-flex items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400"
            >
              <MessageSquare size={11} />
              Abrir conversa do grupo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
