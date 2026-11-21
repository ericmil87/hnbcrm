import {
  Ban,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  CalendarSync,
  CheckCheck,
  Hourglass,
  UserCheck,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { statusMeta } from "@/lib/agendaStatus";
import { VOCAB } from "@/lib/vocab";
import type { AppointmentStatus } from "@/lib/agendaTypes";

/** Ícone por status: a cor nunca é o único sinal (daltonismo, tema). */
export const APPOINTMENT_STATUS_ICON: Record<AppointmentStatus, LucideIcon> = {
  pending_approval: Hourglass,
  scheduled: CalendarClock,
  confirmed: CalendarCheck,
  checked_in: UserCheck,
  completed: CheckCheck,
  no_show: UserX,
  cancelled: Ban,
  rescheduled: CalendarSync,
};

interface AppointmentStatusChipProps {
  /** Aceita `string` para tolerar um status novo do backend (cai em "Marcado"). */
  status: AppointmentStatus | string;
  /** Só o ícone com o rótulo para leitor de tela (blocos pequenos da grade). */
  compact?: boolean;
  /** Proposta vencida (`isExpiredProposal`): mostra "Vencida" com ícone próprio no lugar de "Aguardando aprovação". */
  expired?: boolean;
  className?: string;
}

/** Chip de status do agendamento: rótulo PT-BR + ícone + cor semântica (4 temas). Aguardando aprovação é tracejado. */
export function AppointmentStatusChip({ status, compact = false, expired = false, className }: AppointmentStatusChipProps) {
  const meta = statusMeta(status);
  const label = expired ? VOCAB.scheduling.proposalExpired : meta.label;
  const Icon = expired ? CalendarX : (APPOINTMENT_STATUS_ICON[status as AppointmentStatus] ?? APPOINTMENT_STATUS_ICON.scheduled);
  return (
    <Badge
      variant={meta.tone}
      className={cn("gap-1", meta.dashed && "border border-dashed border-semantic-warning/60", className)}
      data-status={expired ? "expired" : status}
    >
      <Icon size={12} aria-hidden="true" />
      {compact ? <span className="sr-only">{label}</span> : label}
    </Badge>
  );
}
