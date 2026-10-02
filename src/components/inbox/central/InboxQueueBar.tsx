import type { FunctionReturnType } from "convex/server";
import { Inbox as InboxIcon, UserRound, CircleDashed, Building2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { hexAlpha } from "./centralMeta";

/** Fila escolhida no inbox: "all" | "mine" | "none" (sem setor) | id do setor. */
export type QueueSelection = "all" | "mine" | "none" | Id<"departments">;

export interface InboxQueueFilter {
  queue: QueueSelection;
  unitId: Id<"units"> | null;
}

export const EMPTY_QUEUE_FILTER: InboxQueueFilter = { queue: "all", unitId: null };

/** Filtro da barra → args opcionais do `conversations.getConversations`. */
export function queueFilterArgs(filter: InboxQueueFilter, enabled: { departments: boolean; units: boolean }) {
  const args: {
    departmentId?: Id<"departments">;
    noDepartment?: boolean;
    assignedToMe?: boolean;
    unitId?: Id<"units">;
  } = {};
  if (enabled.departments) {
    if (filter.queue === "mine") args.assignedToMe = true;
    else if (filter.queue === "none") args.noDepartment = true;
    else if (filter.queue !== "all") args.departmentId = filter.queue;
  }
  if (enabled.units && filter.unitId) args.unitId = filter.unitId;
  return args;
}

function countLabel(n: number, cap = 500) {
  return n >= cap ? `${cap}+` : String(n);
}

interface ChipProps {
  active: boolean;
  onClick: () => void;
  color?: string;
  icon?: React.ReactNode;
  label: string;
  count?: number;
  unread?: number;
}

function QueueChip({ active, onClick, color, icon, label, count, unread }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-full text-xs border transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        active && color
          ? "text-text-primary font-medium"
          : active
            ? "border-brand-500 bg-brand-500/15 text-brand-500 font-medium"
            : "border-border-strong text-text-secondary hover:text-text-primary hover:bg-surface-overlay"
      )}
      style={
        active && color
          ? { borderColor: color, backgroundColor: hexAlpha(color, 0.18) }
          : undefined
      }
    >
      {color ? (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      ) : (
        icon
      )}
      <span className="whitespace-nowrap">{label}</span>
      {count !== undefined && (
        <span
          className={cn(
            "tabular-nums",
            unread && unread > 0 ? "text-brand-500 font-semibold" : "text-text-muted"
          )}
          aria-label={
            unread && unread > 0 ? `${count} abertas, ${unread} não lidas` : `${count} abertas`
          }
        >
          {countLabel(count)}
        </span>
      )}
    </button>
  );
}

export type InboxQueues = FunctionReturnType<typeof api.conversationRouting.getInboxQueues>;

interface InboxQueueBarProps {
  /** Resultado de `conversationRouting.getInboxQueues` (o Inbox também usa nos chips). */
  queues: InboxQueues | undefined;
  showDepartments: boolean;
  showUnits: boolean;
  value: InboxQueueFilter;
  onChange: (next: InboxQueueFilter) => void;
}

/**
 * Filas da Central acima da lista de conversas: "Todas · Minhas · Sem setor ·
 * <setores>" (módulo departments) e chips de unidade (módulo units). Uma linha
 * por grupo, com rolagem horizontal no mobile.
 */
export function InboxQueueBar({
  queues,
  showDepartments,
  showUnits,
  value,
  onChange,
}: InboxQueueBarProps) {
  if (!queues) return null;
  const units = showUnits ? queues.units : [];
  const departments = showDepartments ? queues.departments : [];
  const setQueue = (queue: QueueSelection) => onChange({ ...value, queue });
  const rowClass =
    // Celular: uma linha com rolagem horizontal. Desktop: quebra em linhas —
    // na coluna de 320/384 px a rolagem escondia metade dos setores.
    "flex items-center gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:overflow-visible";

  return (
    <div className="space-y-1.5">
      {showDepartments && (
        <div role="group" aria-label="Filas de atendimento" className={rowClass}>
          <QueueChip
            active={value.queue === "all"}
            onClick={() => setQueue("all")}
            icon={<InboxIcon size={12} aria-hidden />}
            label="Todas"
          />
          <QueueChip
            active={value.queue === "mine"}
            onClick={() => setQueue("mine")}
            icon={<UserRound size={12} aria-hidden />}
            label="Minhas"
            count={queues.mineCount}
          />
          <QueueChip
            active={value.queue === "none"}
            onClick={() => setQueue("none")}
            icon={<CircleDashed size={12} aria-hidden />}
            label="Sem setor"
            count={queues.noDepartmentCount}
          />
          {departments.length > 0 && <span className="shrink-0 h-4 w-px bg-border-strong mx-0.5" />}
          {departments.map((d) => (
            <QueueChip
              key={d._id}
              active={value.queue === d._id}
              onClick={() => setQueue(value.queue === d._id ? "all" : d._id)}
              color={d.color}
              label={d.name}
              count={d.openCount}
              unread={d.unreadCount}
            />
          ))}
        </div>
      )}
      {units.length > 0 && (
        <div role="group" aria-label="Filtrar por unidade" className={rowClass}>
          <Building2 size={13} className="shrink-0 text-text-muted" aria-hidden />
          <QueueChip
            active={value.unitId === null}
            onClick={() => onChange({ ...value, unitId: null })}
            label="Todas as unidades"
          />
          {units.map((u) => (
            <QueueChip
              key={u._id}
              active={value.unitId === u._id}
              onClick={() => onChange({ ...value, unitId: value.unitId === u._id ? null : u._id })}
              color={u.color}
              label={u.name}
              count={u.openCount}
            />
          ))}
        </div>
      )}
    </div>
  );
}
