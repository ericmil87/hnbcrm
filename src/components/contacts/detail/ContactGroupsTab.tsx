import { MessageSquare, ShieldCheck, Users } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { formatDate } from "@/lib/format";

export type ContactGroupRow = {
  _id: string;
  subject: string;
  conversationId: string | null;
  participantsCount: number;
  lastMessageAt: number | null;
  isAdmin: boolean;
};

interface ContactGroupsTabProps {
  groups: ContactGroupRow[] | undefined;
  onOpenConversation: (conversationId: string) => void;
}

/** Aba "Grupos": salas monitoradas em que o contato participa. */
export function ContactGroupsTab({ groups, onOpenConversation }: ContactGroupsTabProps) {
  if (groups === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size="md" />
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={Users}
        size="sm"
        title="Nenhum grupo em comum"
        description="Aparecem aqui os grupos de WhatsApp acompanhados pelo CRM em que este contato é participante."
      />
    );
  }
  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group._id} className="rounded-card border border-border bg-surface-sunken p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Users size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
            <span className="truncate text-sm font-medium text-text-primary">{group.subject}</span>
            {group.isAdmin && (
              <Badge variant="info">
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck size={10} aria-hidden="true" /> admin
                </span>
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-muted tabular-nums">
            {group.participantsCount} {group.participantsCount === 1 ? "membro" : "membros"}
            {group.lastMessageAt ? ` · ativo em ${formatDate(group.lastMessageAt)}` : ""}
          </p>
          {group.conversationId && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => onOpenConversation(group.conversationId!)}
            >
              <MessageSquare size={14} aria-hidden="true" />
              Abrir conversa do grupo
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
