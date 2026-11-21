import { CalendarClock } from "lucide-react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { fillVocab } from "@/lib/agendaCopy";
import { zonedWhenPhrase } from "@/lib/agendaZone";
import { VOCAB } from "@/lib/vocab";

interface NextAppointmentChipProps {
  organizationId: Id<"organizations">;
  /** Início do próximo agendamento (UTC ms). */
  startTime: number;
  /** Quantos outros vêm depois (o "+2"). */
  extra: number;
  onOpen: () => void;
}

/** Chip "Próximo: qui, 26/11 às 10:00" no cabeçalho da conversa (os dados vêm de `useConversationBooking`). */
export function NextAppointmentChip({ organizationId, startTime, extra, onOpen }: NextAppointmentChipProps) {
  const tz = useOrgTimezone(organizationId);
  const label = fillVocab(VOCAB.scheduling.block.chipNext, { quando: zonedWhenPhrase(startTime, tz) });
  return <NextAppointmentChipView label={label} extra={extra} onOpen={onOpen} />;
}

/** Só a aparência (testável sem Convex). */
export function NextAppointmentChipView({ label, extra, onOpen }: { label: string; extra: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-brand-500/10 px-2.5 text-xs font-medium text-brand-400 transition-colors hover:bg-brand-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 coarse:h-9"
    >
      <CalendarClock size={12} aria-hidden="true" />
      {label}
      {extra > 0 && <span className="tabular-nums text-text-muted">+{extra}</span>}
    </button>
  );
}
