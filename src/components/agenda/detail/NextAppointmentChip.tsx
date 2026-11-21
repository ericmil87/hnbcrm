import { useQuery } from "convex/react";
import { CalendarClock } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useRoundedNow } from "@/components/agenda/booking/useRoundedNow";
import { useSchedulingGate } from "@/components/agenda/booking/useSchedulingGate";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { fillVocab } from "@/lib/agendaCopy";
import { zonedWhenPhrase } from "@/lib/agendaZone";
import { VOCAB } from "@/lib/vocab";

interface NextAppointmentChipProps {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  /** Abre o painel do agendamento. */
  onOpen: (appointmentId: Id<"schedAppointments">) => void;
}

/**
 * Chip "Próximo: qui, 26/11 às 10:00" no cabeçalho da conversa. Módulo desligado (ou sem `agenda`): não
 * renderiza nada e não assina nada da agenda.
 */
export function NextAppointmentChip(props: NextAppointmentChipProps) {
  const gate = useSchedulingGate(props.organizationId);
  if (!gate.enabled) return null;
  return <NextAppointmentChipInner {...props} />;
}

function NextAppointmentChipInner({ organizationId, conversationId, onOpen }: NextAppointmentChipProps) {
  const tz = useOrgTimezone(organizationId);
  const now = useRoundedNow("hour");
  const related = useQuery(api.scheduling.listForConversation, { conversationId, now, limit: 5 });
  const next = related?.upcoming[0];
  if (!next) return null;
  const extra = related.upcoming.length - 1;
  const when = zonedWhenPhrase(next.startTime, tz);
  const label = fillVocab(VOCAB.scheduling.block.chipNext, { quando: when });
  return (
    <button
      type="button"
      onClick={() => onOpen(next._id)}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-brand-500/10 px-2.5 text-xs font-medium text-brand-400 transition-colors hover:bg-brand-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 coarse:h-9"
    >
      <CalendarClock size={12} aria-hidden="true" />
      {label}
      {extra > 0 && <span className="tabular-nums text-text-muted">+{extra}</span>}
    </button>
  );
}
