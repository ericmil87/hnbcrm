import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";

const card = VIEWS_COPY.dense.card;
const q = VIEWS_COPY.dense.quick;

/**
 * Telefone do contato no cartão rápido. O cartão só existe ao passar o mouse, então a leitura (`getAppointmentContactPhone`,
 * 2 documentos) só acontece ali: a grade não lê contato por linha. Com `conversationId`, "Abrir conversa".
 */
export function QuickContactPhone({
  appointmentId,
  conversationId,
  onOpenConversation,
  onDone,
}: {
  appointmentId: string;
  conversationId?: string;
  onOpenConversation?: (conversationId: string) => void;
  onDone: () => void;
}) {
  const phone = useQuery(api.scheduling.getAppointmentContactPhone, { appointmentId: appointmentId as Id<"schedAppointments"> });
  if (!phone) return null;
  return (
    <div>
      <dt className="sr-only">{card.phone}</dt>
      <dd className="flex items-center justify-between gap-2">
        <span className="tabular-nums text-text-primary">{phone}</span>
        {conversationId && onOpenConversation && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onOpenConversation(conversationId);
              onDone();
            }}
          >
            {q.openConversation}
          </Button>
        )}
      </dd>
    </div>
  );
}
