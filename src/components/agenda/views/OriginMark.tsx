// Cópia de `agenda/AppointmentOriginBadge` de propósito: importar o original daqui o tornava um chunk compartilhado
// com o painel do agendamento, que o Inbox pré-carrega (cresciam alguns bytes para quem tem o módulo desligado).
import { Bot, Link2, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { originBadgeKind, originHint, originLabel, type OriginBadgeKind } from "@/lib/agendaStatus";
import type { AppointmentOrigin } from "@/lib/agendaTypes";

const ICON: Record<OriginBadgeKind, LucideIcon> = { ai: Bot, staff: Users, link: Link2 };

const TONE: Record<OriginBadgeKind, string> = {
  ai: "bg-brand-500/10 text-brand-400",
  staff: "bg-surface-overlay text-text-secondary",
  link: "bg-semantic-info/10 text-semantic-info",
};

interface OriginMarkProps {
  origin: AppointmentOrigin | string;
  /** Só o ícone (linhas e blocos apertados); o rótulo vai para leitor de tela. */
  compact?: boolean;
  className?: string;
}

/** Selo de origem do agendamento: "IA", "Equipe" ou "Link". */
export function OriginMark({ origin, compact = false, className }: OriginMarkProps) {
  const kind = originBadgeKind(origin);
  const Icon = ICON[kind];
  return (
    <span
      title={originHint(origin)}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        TONE[kind],
        className
      )}
      data-origin={kind}
    >
      <Icon size={12} aria-hidden="true" />
      {compact ? <span className="sr-only">{originLabel(origin)}</span> : originLabel(origin)}
    </span>
  );
}
