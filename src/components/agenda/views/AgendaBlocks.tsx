import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, Bot, CalendarCheck, CalendarDays, CalendarX, CheckCheck, CheckSquare, Hourglass, UserCheck, UserX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { AppointmentStatusChip } from "@/components/agenda/AppointmentStatusChip";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { appointmentTooltip, firstName, placeText, planBlock, quickStatusAction, statusFlags, timeRangeLabel, widthClass, type StatusFlag } from "@/lib/agendaBlockText";
import { PENDING_HATCH, type Tone } from "@/lib/agendaColors";
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

const BASE = "absolute isolate overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs leading-[15px] text-text-primary";
/** Fundo opaco por baixo da cor suave: as linhas da grade não aparecem através do bloco. */
function Underlay({ fill, hatch }: { fill?: string; hatch?: boolean }) {
  return (
    <>
      <span aria-hidden="true" className="absolute inset-0 -z-10 bg-surface-raised" />
      {fill && <span aria-hidden="true" className={cn("absolute inset-0 -z-10", fill)} style={hatch ? { backgroundImage: PENDING_HATCH } : undefined} />}
    </>
  );
}

/** Separa a classe do bloco em borda (fica no botão) e fundo `bg-*` (vai para a camada tingida sobre o fundo opaco). */
function splitTone(block: string): { rest: string; fill: string } {
  const parts = block.split(/\s+/).filter(Boolean);
  return { rest: parts.filter((c) => !c.startsWith("bg-")).join(" "), fill: parts.filter((c) => c.startsWith("bg-")).join(" ") };
}
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
  /** Largura do bloco em px (mede-se na grade): decide o texto sem nunca quebrar palavra. Ausente = larga. */
  widthPx?: number;
  onOpen: (appointmentId: string) => void;
  quick?: QuickActions;
}

/** Bloco de um agendamento com cliente: o texto muda com a altura (cliente, horário, serviço, lugar). */
export function AppointmentBlock({ appointment: a, expired, conflict, over, tz, box, tone, exceptResourceId, widthPx, onOpen, quick }: AppointmentBlockProps) {
  const hoverable = useMediaQuery("(hover: hover)");
  const hc = useHoverCard(hoverable);
  const st = style(box);
  const plan = planBlock(Number(st.height));
  const wc = widthClass(widthPx);
  const flags = wc === "tiny" || wc === "narrow" ? [] : statusFlags(a, expired);
  const title = appointmentLabel(a);
  const tip = appointmentTooltip(a, tz, expired, VOCAB.scheduling.proposalExpired) + (conflict ? ` · ${g.conflictMark}` : "") + (over ? ` · ${g.overCapacity}` : "");
  const place = placeText(a, exceptResourceId);
  const { rest: toneBorder, fill: toneFill } = splitTone(tone.block);
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
        className={cn(BASE, FOCUS, "transition-[filter] hover:brightness-95 dark:hover:brightness-110", toneBorder, (wc === "tiny" || wc === "narrow") && "px-1 text-micro", over && "ring-2 ring-inset ring-semantic-error")}
      >
        <Underlay fill={toneFill} hatch={tone.hatch} />
        {wc === "tiny" ? (
          <span className="block truncate font-semibold">{firstName(title)}</span>
        ) : plan.compact ? (
          <span className="flex items-center gap-1">
            <Flags flags={flags} />
            <span className="truncate">
              {wc !== "narrow" && <span className="font-semibold tabular-nums">{zonedTimeLabel(a.startTime, tz)} </span>}
              <span className="font-semibold">{wc === "narrow" ? firstName(title) : title}</span>
              {wc === "wide" && <span className="text-text-secondary">{a.serviceName ? ` · ${a.serviceName}` : ""}</span>}
            </span>
          </span>
        ) : wc === "narrow" ? (
          <>
            <span className="block truncate font-semibold">{title}</span>
            {plan.rows.length > 2 && <span className="block truncate tabular-nums text-text-secondary">{zonedTimeLabel(a.startTime, tz)}</span>}
          </>
        ) : wc === "medium" ? (
          <>
            {/* Até 2 linhas, quebrando só em espaço; a hora só aparece inteira. */}
            <span className={cn("block font-semibold [overflow-wrap:normal]", plan.rows.length > 2 ? "line-clamp-2" : "truncate")}>{title}</span>
            {plan.rows.length > 3 && (
              <span className="flex items-center gap-1 tabular-nums text-text-secondary">
                {zonedTimeLabel(a.startTime, tz)}
                <Flags flags={flags} />
              </span>
            )}
          </>
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
  /** Largura do bloco em px; ausente = larga. */
  widthPx?: number;
  /** Compromisso fora do filtro da Semana: fica esmaecido. */
  muted?: boolean;
  /** Arrastar para outro horário (só computador, só compromisso editável): recebe o início do gesto. */
  onDragStart?: (e: React.PointerEvent<HTMLButtonElement>, blockTopPx: number) => void;
  /** Está sendo arrastado (fica esmaecido onde estava). */
  dragging?: boolean;
  tz: string;
  box: BlockBox;
  onOpen: (item: InternalItem) => void;
}

/** Bloco de compromisso ou tarefa da equipe (tracejado em roxo, como no resto da Agenda). */
export function InternalBlock({ item: e, tz, box, widthPx, muted, onDragStart, dragging, onOpen }: InternalBlockProps) {
  const wc = widthClass(widthPx);
  const narrow = wc === "tiny" || wc === "narrow";
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
      onPointerDown={onDragStart ? (ev) => onDragStart(ev, box.top) : undefined}
      className={cn(
        BASE,
        FOCUS,
        "border border-dashed border-ai-500 transition-[filter] hover:brightness-95 dark:hover:brightness-110",
        narrow && "px-1 text-micro",
        muted && "opacity-50",
        onDragStart && "cursor-grab touch-none active:cursor-grabbing",
        dragging && "opacity-40"
      )}
    >
      <Underlay fill="bg-ai-500/20" />
      {wc === "tiny" ? (
        <span className="block truncate font-semibold">{firstName(e.title)}</span>
      ) : plan.compact ? (
        <span className="flex items-center gap-1">
          {!narrow && <Icon size={12} className="shrink-0 text-ai-400" aria-hidden="true" />}
          <span className="truncate">
            {!narrow && <span className="font-semibold tabular-nums">{time} </span>}
            <span className="font-semibold">{narrow ? firstName(e.title) : e.title}</span>
          </span>
        </span>
      ) : narrow ? (
        <>
          <span className="block truncate font-semibold">{e.title}</span>
          {plan.rows.length > 2 && <span className="block truncate tabular-nums text-text-secondary">{time}</span>}
        </>
      ) : wc === "medium" ? (
        <>
          <span className={cn("block font-semibold [overflow-wrap:normal]", plan.rows.length > 2 ? "line-clamp-2" : "truncate")}>{e.title}</span>
          {plan.rows.length > 3 && <span className="block truncate tabular-nums text-text-secondary">{time}</span>}
        </>
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
