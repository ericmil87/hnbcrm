import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, Bot, CalendarCheck, CalendarDays, CalendarX, CheckCheck, CheckSquare, Hourglass, UserCheck, UserX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { AppointmentStatusChip } from "@/components/agenda/AppointmentStatusChip";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { appointmentTooltip, placeText, planBlock, quickStatusAction, statusFlags, timeRangeLabel, type StatusFlag } from "@/lib/agendaBlockText";
import type { Tone } from "@/lib/agendaColors";
import { appointmentLabel, type GridAppointment, type InternalItem } from "@/lib/agendaGrid";
import { originLabel } from "@/lib/agendaStatus";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { zonedTimeLabel } from "@/lib/agendaZone";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";

const q = VIEWS_COPY.dense.quick;
const card = VIEWS_COPY.dense.card;
const g = VIEWS_COPY.grid;

/** Posição absoluta do bloco dentro da coluna (px e %). */
export interface BlockBox {
  top: number;
  height: number;
  left: string;
  width: string;
}

const FLAG_ICON: Record<StatusFlag, { Icon: LucideIcon; className: string; label: string }> = {
  pending: { Icon: Hourglass, className: "text-semantic-warning", label: VOCAB.scheduling.status.pending_approval },
  expired: { Icon: CalendarX, className: "text-semantic-error", label: VOCAB.scheduling.proposalExpired },
  confirmed: { Icon: CalendarCheck, className: "text-semantic-success", label: VOCAB.scheduling.status.confirmed },
  checked_in: { Icon: UserCheck, className: "text-brand-500", label: VOCAB.scheduling.status.checked_in },
  done: { Icon: CheckCheck, className: "text-text-muted", label: VOCAB.scheduling.status.completed },
  no_show: { Icon: UserX, className: "text-semantic-error", label: VOCAB.scheduling.status.no_show },
  ai: { Icon: Bot, className: "text-brand-500", label: VOCAB.scheduling.origin.ai },
  conflict: { Icon: AlertTriangle, className: "text-semantic-warning", label: g.conflictMark },
};

/** Ícones pequenos de estado (a cor nunca é o único sinal); o texto fica para o leitor de tela. */
function Flags({ flags, className }: { flags: readonly StatusFlag[]; className?: string }) {
  if (flags.length === 0) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-0.5", className)}>
      {flags.map((f) => {
        const { Icon, className: c } = FLAG_ICON[f];
        return <Icon key={f} size={12} className={c} aria-hidden="true" />;
      })}
      <span className="sr-only">{flags.map((f) => FLAG_ICON[f].label).join(", ")}</span>
    </span>
  );
}

/** Hover com intenção (computador): abre o cartão rápido depois de uma pausa e deixa o mouse chegar até ele. */
function useHoverCard(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const clear = () => window.clearTimeout(timer.current);
  useEffect(() => clear, []);
  const show = useCallback(() => {
    if (!enabled) return;
    clear();
    timer.current = window.setTimeout(() => setOpen(true), 380);
  }, [enabled]);
  const hide = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => setOpen(false), 160);
  }, []);
  const close = useCallback(() => {
    clear();
    setOpen(false);
  }, []);
  return { open, setOpen, anchor, show, hide, keep: clear, close };
}

const BASE = "absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs leading-[15px] text-text-primary";
const FOCUS = "focus:outline-none focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-brand-500";

function style(box: BlockBox): CSSProperties {
  return { top: box.top, height: Math.max(box.height - 2, 20), left: box.left, width: box.width };
}

export interface QuickActions {
  canEdit: boolean;
  onStatus: (appointmentId: string, to: "confirmed" | "checked_in") => void;
}

export interface AppointmentBlockProps {
  appointment: GridAppointment;
  expired: boolean;
  conflict: boolean;
  over?: boolean;
  tz: string;
  box: BlockBox;
  tone: Tone;
  /** Recurso da coluna: não se repete na linha "onde". */
  exceptResourceId?: string | null;
  onOpen: (appointmentId: string) => void;
  quick?: QuickActions;
}

/** Bloco de um agendamento com cliente: o texto muda com a altura (cliente, horário, serviço, lugar). */
export function AppointmentBlock({ appointment: a, expired, conflict, over, tz, box, tone, exceptResourceId, onOpen, quick }: AppointmentBlockProps) {
  const hoverable = useMediaQuery("(hover: hover)");
  const hc = useHoverCard(hoverable);
  const st = style(box);
  const plan = planBlock(Number(st.height));
  const flags = statusFlags(a, expired);
  const title = appointmentLabel(a);
  const tip = appointmentTooltip(a, tz, expired, VOCAB.scheduling.proposalExpired) + (conflict ? ` · ${g.conflictMark}` : "") + (over ? ` · ${g.overCapacity}` : "");
  const place = placeText(a, exceptResourceId);
  return (
    <>
      <button
        ref={hc.anchor}
        type="button"
        data-block="appointment"
        title={hc.open ? undefined : tip}
        aria-label={tip}
        style={st}
        onClick={(e) => {
          e.stopPropagation();
          hc.close();
          onOpen(a._id);
        }}
        onMouseEnter={hc.show}
        onMouseLeave={hc.hide}
        className={cn(BASE, FOCUS, "transition-[filter] hover:brightness-95 dark:hover:brightness-110", tone.block, over && "ring-2 ring-inset ring-semantic-error")}
      >
        {plan.compact ? (
          <span className="flex items-center gap-1">
            <Flags flags={flags} />
            <span className="truncate">
              <span className="font-semibold tabular-nums">{zonedTimeLabel(a.startTime, tz)}</span> <span className="font-semibold">{title}</span>
              <span className="text-text-secondary">{a.serviceName ? ` · ${a.serviceName}` : ""}</span>
            </span>
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1">
              <span className="truncate font-semibold">{title}</span>
              <Flags flags={flags} className="ml-auto" />
            </span>
            {plan.rows.includes("time") && <span className="block truncate tabular-nums text-text-secondary">{timeRangeLabel(a.startTime, a.endTime, tz)}</span>}
            {plan.rows.includes("service") && <span className="block truncate">{a.serviceName}</span>}
            {plan.rows.includes("place") && place && <span className="block truncate text-text-muted">{place}</span>}
          </>
        )}
      </button>
      {hc.open && (
        <Popover open onOpenChange={hc.setOpen} anchor={hc.anchor} side="bottom" align="start" trapEscape={false} role="dialog" aria-label={title} className="w-72">
          <div onMouseEnter={hc.keep} onMouseLeave={hc.hide}>
            <AppointmentHoverCard
              appointment={a}
              tz={tz}
              expired={expired}
              quick={quick}
              onOpen={() => {
                hc.close();
                onOpen(a._id);
              }}
              onDone={hc.close}
            />
          </div>
        </Popover>
      )}
    </>
  );
}

/** Cartão rápido do passar do mouse: o essencial e as ações Confirmar / Abrir. */
export function AppointmentHoverCard({
  appointment: a,
  tz,
  expired,
  quick,
  onOpen,
  onDone,
}: {
  appointment: GridAppointment;
  tz: string;
  expired: boolean;
  quick?: QuickActions;
  onOpen: () => void;
  onDone: () => void;
}) {
  const action = quick?.canEdit ? quickStatusAction(a.status, expired) : null;
  const place = placeText(a);
  return (
    <div className="space-y-2 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-semibold text-text-primary">{appointmentLabel(a)}</p>
        <AppointmentStatusChip status={a.status} expired={expired} className="shrink-0" />
      </div>
      <dl className="space-y-0.5 text-text-secondary">
        <div>
          <dt className="sr-only">{card.when}</dt>
          <dd className="tabular-nums">{timeRangeLabel(a.startTime, a.endTime, tz)}</dd>
        </div>
        <div>
          <dd className="text-text-primary">{a.serviceName}</dd>
        </div>
        {place && (
          <div>
            <dt className="sr-only">{card.place}</dt>
            <dd>{place}</dd>
          </div>
        )}
        <div>
          <dt className="sr-only">{card.origin}</dt>
          <dd className="text-caption text-text-muted">{originLabel(a.origin)}</dd>
        </div>
      </dl>
      <div className="flex justify-end gap-2 pt-1">
        {action && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              quick?.onStatus(a._id, action.to);
              onDone();
            }}
          >
            {action.to === "confirmed" ? q.confirm : q.arrived}
          </Button>
        )}
        <Button size="sm" onClick={onOpen}>
          {q.open}
        </Button>
      </div>
    </div>
  );
}

export interface InternalBlockProps {
  item: InternalItem;
  tz: string;
  box: BlockBox;
  onOpen: (item: InternalItem) => void;
}

/** Bloco de compromisso ou tarefa da equipe (tracejado em roxo, como no resto da Agenda). */
export function InternalBlock({ item: e, tz, box, onOpen }: InternalBlockProps) {
  const st = style(box);
  const plan = planBlock(Number(st.height));
  const Icon = e.source === "task" ? CheckSquare : CalendarDays;
  const kind = e.source === "task" ? g.task : g.event;
  const time = zonedTimeLabel(e.startTime, tz);
  const tip = [e.title, `${time}${e.endTime > e.startTime ? ` – ${zonedTimeLabel(e.endTime, tz)}` : ""}`, kind, e.assigneeName].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      data-block="internal"
      title={tip}
      aria-label={`${kind}, ${tip}`}
      style={st}
      onClick={(ev) => {
        ev.stopPropagation();
        onOpen(e);
      }}
      className={cn(BASE, FOCUS, "border border-dashed border-ai-500 bg-ai-500/10 transition-[filter] hover:brightness-95 dark:hover:brightness-110")}
    >
      {plan.compact ? (
        <span className="flex items-center gap-1">
          <Icon size={12} className="shrink-0 text-ai-400" aria-hidden="true" />
          <span className="truncate">
            <span className="font-semibold tabular-nums">{time}</span> <span className="font-semibold">{e.title}</span>
          </span>
        </span>
      ) : (
        <>
          <span className="flex items-center gap-1">
            <Icon size={12} className="shrink-0 text-ai-400" aria-hidden="true" />
            <span className="truncate font-semibold">{e.title}</span>
          </span>
          {plan.rows.includes("time") && (
            <span className="block truncate tabular-nums text-text-secondary">
              {time}
              {e.endTime > e.startTime ? ` – ${zonedTimeLabel(e.endTime, tz)}` : ""}
            </span>
          )}
          {plan.rows.includes("service") && <span className="block truncate text-text-muted">{kind}</span>}
          {plan.rows.includes("place") && e.assigneeName && <span className="block truncate text-text-muted">{e.assigneeName}</span>}
        </>
      )}
    </button>
  );
}
