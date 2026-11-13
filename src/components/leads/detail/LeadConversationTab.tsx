import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { channelLabel } from "@/lib/channelAccounts";
import { formatDate } from "@/lib/format";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Composer } from "@/components/inbox/Composer";
import { ConversationThread } from "@/components/inbox/ConversationThread";
import {
  ConversationInteractionProvider,
  useInteractionState,
} from "@/components/inbox/conversationInteraction";

interface LeadConversationTabProps {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
}

/**
 * Aba "Conversa" do painel do lead: o mesmo thread e composer de Conversas,
 * sem voz nem agendamento (decisão do plano; ligar é um flag de `features`).
 * Lead com conversas em mais de um canal ganha um seletor; com uma, igual a antes.
 * Sem conversa, o primeiro envio cria uma conversa interna.
 */
export function LeadConversationTab({ leadId, organizationId }: LeadConversationTabProps) {
  const { can } = usePermissions(organizationId);
  const canReply = can("inbox", "reply");
  const createConversation = useMutation(api.conversations.createConversation);
  const [chosenId, setChosenId] = useState<string | null>(null);

  // Só as conversas deste lead, da mais recente para a mais antiga (a query não
  // põe mais as não lidas na frente; a escolha inicial abaixo cuida disso). O ramo
  // por lead lê o índice por canal+criação e ordena DEPOIS do take: 20 dá folga.
  const conversations = useQuery(api.conversations.getConversations, {
    organizationId,
    leadId,
    limit: 20,
  });

  if (!conversations) {
    return (
      <div className="flex h-full justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  const leadConversations = conversations.filter((c): c is NonNullable<typeof c> => c !== null);
  // Sem escolha: a conversa com mensagem não lida, senão a mais recente.
  const selected =
    leadConversations.find((c) => c._id === chosenId) ??
    leadConversations.find((c) => (c.unreadCount ?? 0) > 0) ??
    leadConversations[0] ??
    null;

  return (
    <div className="flex flex-col h-full">
      {leadConversations.length > 1 && selected && (
        <div className="shrink-0 border-b border-border bg-surface-raised px-4 py-2">
          <Select
            size="sm"
            aria-label="Conversa do lead"
            value={selected._id}
            onValueChange={setChosenId}
            options={leadConversations.map((c) => ({
              value: c._id,
              label: `${channelLabel(c.channel)} · ${formatDate(c.lastMessageAt ?? c.createdAt)}`,
            }))}
          />
        </div>
      )}
      {/* Remonta por conversa: citação, rascunho e anexos pertencem a ela. */}
      <LeadConversation
        key={selected?._id ?? "none"}
        organizationId={organizationId}
        conversationId={selected?._id ?? null}
        canReply={canReply}
        ensureConversation={() =>
          createConversation({ organizationId, leadId, channel: "internal" })
        }
      />
    </div>
  );
}

function LeadConversation({
  organizationId,
  conversationId,
  canReply,
  ensureConversation,
}: {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations"> | null;
  canReply: boolean;
  ensureConversation: () => Promise<Id<"conversations">>;
}) {
  const interaction = useInteractionState();
  return (
    <ConversationInteractionProvider value={interaction}>
      {conversationId ? (
        <ConversationThread
          organizationId={organizationId}
          conversationId={conversationId}
          variant="embedded"
        />
      ) : (
        <div className="flex-1 min-h-0 flex items-center justify-center p-4 text-center text-text-muted text-sm">
          Nenhuma conversa ainda. Envie uma mensagem para iniciar.
        </div>
      )}
      <Composer
        organizationId={organizationId}
        conversationId={conversationId}
        canReply={canReply}
        features={{ voice: false, schedule: false }}
        variant="embedded"
        ensureConversation={ensureConversation}
      />
    </ConversationInteractionProvider>
  );
}
