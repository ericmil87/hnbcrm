import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { CalendarDays, Lock } from "lucide-react";
import { AppointmentBlock, InternalBlock, type BlockBox, type QuickActions } from "./AgendaBlocks";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { isCalendarItemDraggable } from "@/lib/agendaPermissions";
import { appointmentTone, type ToneContext } from "@/lib/agendaColors";
import { blockGeometry, gridHeight, hourLabels, HOUR_PX, minuteFromOffset, nowLineTop, type InternalItem } from "@/lib/agendaGrid";
import { initialScrollMinute, scrollTopFor } from "@/lib/agendaScroll";
import { fillVocab } from "@/lib/agendaCopy";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import type { WeekModel, WeekPlaced } from "@/lib/agendaWeekGrid";
import { minutesLabel, shortDateLabel, weekdayOf } from "@/lib/agendaZone";
import { cn } from "@/lib/utils";

const w = VIEWS_COPY.dense.weekGrid;
const blk = VIEWS_COPY.dense.block;
const WINDOW = { startHour: 0, endHour: 24 } as const;
const GUTTER = "2.75rem";

export interface DayStatus {
  /** Recursos fechados neste dia e se é a agenda toda. */
  closed: number;
  all: boolean;
}

export interface AgendaWeekViewProps {
  model: WeekModel;
  tz: string;
  hourPx?: number;
  tone: ToneContext;
  /** Pode marcar horário neste dia (permissão e dia que não passou). */
  canBookOn: (localDate: string) => boolean;
  quick?: QuickActions;
  /** Fechamentos por dia (do mesmo `listAgendaRange` do mês); ausente = sem dado. */
  dayStatus?: Readonly<Record<string, DayStatus>>;
  /** Largura mínima de cada dia (celular rola na horizontal). */
  compact?: boolean;
  scrollKey?: string;
  onSlotClick: (localDate: string, minute: number) => void;
  onAppointmentClick: (appointmentId: string) => void;
  onInternalClick: (item: InternalItem) => void;
  onOpenDay: (localDate: string) => void;
  /** Arrastar um compromisso da equipe para outro dia e hora (computador). Ausente = sem arrastar. */
  onMoveEvent?: (item: InternalItem, localDate: string, minute: number) => void;
  className?: string;
}

/** Arrastar compromisso: o gesto só vale depois de mover este tanto (px), para o clique abrir o painel. */
const DRAG_THRESHOLD_PX = 5;

interface DragState {
  item: InternalItem;
  /** Distância (px) do ponteiro ao topo do bloco quando o gesto começou. */
  grabOffset: number;
  startX: number;
  startY: number;
  active: boolean;
  /** Destino atual (dia e minuto), se o ponteiro está sobre uma coluna. */
  target: { localDate: string; minute: number } | null;
}

function boxOf(p: Pick<WeekPlaced, "column" | "columns">, startMin: number, endMin: number, hourPx: number): BlockBox {
  const { top, height } = blockGeometry(startMin, endMin, WINDOW.startHour, hourPx);
  return { top, height, left: `calc(${(p.column / p.columns) * 100}% + 1px)`, width: `calc(${100 / p.columns}% - 3px)` };
}

/**
 * Semana de verdade (estilo Google Agenda): sete colunas (dias) com os agendamentos com cliente e os compromissos e
 * tarefas da equipe JUNTOS, sobreposição lado a lado, as 24 horas com o fora do expediente esmaecido (abre rolada no
 * começo do expediente ou em "agora"), cabeçalho dos dias e faixa "Dia inteiro" fixos no topo. Clique no vazio marca
 * horário naquele dia e hora; clique no bloco abre o painel. Apresentacional: o contêiner entrega o modelo.
 */
export function AgendaWeekView({
  model,
  tz,
  hourPx = HOUR_PX,
  tone,
  canBookOn,
  quick,
  dayStatus,
  compact = false,
  scrollKey,
  onSlotClick,
  onAppointmentClick,
  onInternalClick,
  onOpenDay,
  onMoveEvent,
  className,
}: AgendaWeekViewProps) {
  const height = gridHeight(WINDOW, hourPx);
  const hours = hourLabels(WINDOW);
  const template: CSSProperties = { gridTemplateColumns: `${GUTTER} repeat(7, minmax(${compact ? "11rem" : "6.5rem"}, 1fr))` };
  const scroller = useRef<HTMLDivElement>(null);
  const nowTop = nowLineTop(model.nowMin, WINDOW, hourPx);
  const hasAllDay = model.days.some((d) => d.allDay.length > 0);
  const finePointer = useMediaQuery("(hover: hover) and (pointer: fine)");
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /** O clique que o navegador dispara logo depois de soltar o arrasto não deve abrir o painel. */
  const justDragged = useRef(false);
  const moveRef = useRef(onMoveEvent);
  moveRef.current = onMoveEvent;
  const hourPxRef = useRef(hourPx);
  hourPxRef.current = hourPx;

  const startDrag = useCallback((item: InternalItem, e: ReactPointerEvent<HTMLButtonElement>, blockTop: number) => {
    if (e.button !== 0) return;
    const col = e.currentTarget.closest("[data-day]");
    const rect = col?.getBoundingClientRect();
    if (!rect) return;
    const st: DragState = { item, grabOffset: e.clientY - rect.top - blockTop, startX: e.clientX, startY: e.clientY, active: false, target: null };
    dragRef.current = st;
    setDrag(st);
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const st = dragRef.current;
      if (!st) return;
      if (!st.active && Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < DRAG_THRESHOLD_PX) return;
      const colEl = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-day]");
      let target: DragState["target"] = null;
      if (colEl?.dataset.day) {
        const rect = colEl.getBoundingClientRect();
        target = { localDate: colEl.dataset.day, minute: minuteFromOffset(e.clientY - rect.top - st.grabOffset, WINDOW.startHour, WINDOW.endHour, hourPxRef.current) };
      }
      const next = { ...st, active: true, target };
      dragRef.current = next;
      setDrag(next);
    };
    const finish = (commit: boolean) => {
      const st = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (st?.active) {
        justDragged.current = true;
        window.setTimeout(() => (justDragged.current = false), 80);
        if (commit && st.target) moveRef.current?.(st.item, st.target.localDate, st.target.minute);
      }
    };
    const onUp = () => finish(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
    };
    // Só reassina ao começar e terminar um gesto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag === null]);

  const canDrag = (e: InternalItem) => !!onMoveEvent && finePointer && e.source === "event" && !e.allDay && isCalendarItemDraggable(e);
  const openInternal = (e: InternalItem) => {
    if (justDragged.current) return;
    onInternalClick(e);
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const minute = initialScrollMinute({ nowMin: model.nowMin, openStartMin: model.openStartMin, openEndMin: model.openEndMin, firstItemMin: model.firstItemMin });
    el.scrollTop = scrollTopFor(minute, hourPx);
    // Celular (colunas largas, rolagem na horizontal): começa no dia de hoje, se a semana o tem.
    const todayCol = compact ? el.querySelector<HTMLElement>('[data-today="true"]') : null;
    if (todayCol) el.scrollLeft = Math.max(0, todayCol.offsetLeft - 44);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, hourPx]);

  const clickDay = (localDate: string, e: MouseEvent<HTMLDivElement>) => {
    if (justDragged.current || !canBookOn(localDate)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSlotClick(localDate, minuteFromOffset(e.clientY - rect.top, WINDOW.startHour, WINDOW.endHour, hourPx));
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface-raised", className)}>
      <div ref={scroller} data-grid-scroller className="relative min-h-0 flex-1 overflow-auto overscroll-contain">
        <div role="group" aria-label={w.ariaLabel} className="min-w-fit">
          <div className="sticky top-0 z-30 border-b border-border bg-surface-raised">
            <div className="grid" style={template}>
              <div aria-hidden="true" className="sticky left-0 z-20 bg-surface-raised" />
              {model.days.map((d) => {
                const status = dayStatus?.[d.localDate];
                const dow = VIEWS_COPY.month.weekdays[(weekdayOf(d.localDate) + 6) % 7];
                return (
                  <button
                    key={`head:${d.localDate}`}
                    type="button"
                    onClick={() => onOpenDay(d.localDate)}
                    aria-current={d.isToday ? "date" : undefined}
                    className="flex min-h-12 flex-col items-center justify-center gap-0.5 border-l border-border-subtle px-1 py-1 hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                  >
                    <span className={cn("text-micro font-medium uppercase tracking-wide", d.isToday ? "text-brand-500 light-theme:text-brand-600" : "text-text-muted")}>{dow}</span>
                    <span
                      className={cn(
                        "flex h-8 min-w-8 items-center justify-center rounded-full px-1 text-lg font-medium leading-none tabular-nums",
                        d.isToday ? "bg-brand-600 text-white" : "text-text-primary"
                      )}
                    >
                      {Number(d.localDate.slice(8))}
                    </span>
                    {status && status.closed > 0 && (
                      <span
                        className="flex items-center gap-0.5 text-micro text-semantic-error"
                        title={status.all ? w.dayClosed : fillVocab(w.someClosed, { n: status.closed })}
                      >
                        <Lock size={10} aria-hidden="true" />
                        <span>{status.all ? w.dayClosed : status.closed}</span>
                        <span className="sr-only">{status.all ? w.dayClosed : fillVocab(w.someClosed, { n: status.closed })}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {hasAllDay && (
              <div className="grid border-t border-border-subtle" style={template}>
                <div className="sticky left-0 z-20 flex items-start justify-end bg-surface-raised px-1 py-1 text-micro text-text-muted">{w.allDay}</div>
                {model.days.map((d) =>
                  d.allDay.length === 0 ? (
                    <div key={`allday:${d.localDate}`} aria-hidden="true" className="border-l border-border-subtle" />
                  ) : (
                  <ul key={`allday:${d.localDate}`} className="min-w-0 space-y-0.5 border-l border-border-subtle p-0.5" aria-label={w.allDay}>
                    {d.allDay.map((e) => (
                      <li key={`${e.source}:${e.id}`}>
                        <button
                          type="button"
                          title={e.title}
                          onClick={() => onInternalClick(e)}
                          className="flex min-h-5 w-full items-center gap-1 rounded-md border border-dashed border-ai-500 bg-ai-500/10 px-1 text-left text-xs text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                        >
                          <CalendarDays size={11} className="shrink-0 text-ai-400" aria-hidden="true" />
                          <span className="truncate">{e.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  )
                )}
              </div>
            )}
          </div>

          <div className="relative grid" style={template}>
            <div className="sticky left-0 z-20 bg-surface-raised" style={{ height }} aria-hidden="true">
              {hours.map((h, i) => (
                <span key={`hour:${h}`} className="absolute right-1.5 text-micro tabular-nums text-text-muted" style={{ top: i * hourPx, transform: i === 0 ? "translateY(2px)" : "translateY(-50%)" }}>
                  {minutesLabel(h * 60)}
                </span>
              ))}
            </div>
            {model.days.map((d) => {
              const bookable = canBookOn(d.localDate);
              return (
                <div
                  key={`col:${d.localDate}`}
                  role="group"
                  aria-label={shortDateLabel(d.localDate)}
                  data-day={d.localDate}
                  data-today={d.isToday ? "true" : undefined}
                  className={cn("relative border-l border-border-subtle", bookable && "cursor-pointer", d.isToday && "bg-brand-500/5")}
                  style={{ height }}
                  onClick={(e) => clickDay(d.localDate, e)}
                >
                  {hours.map((h, i) => (
                    <div key={`line:${h}`} aria-hidden="true" className="absolute inset-x-0 border-t border-border-subtle" style={{ top: i * hourPx }} />
                  ))}
                  {d.offHours.map((s) => (
                    <div
                      key={`off:${s.startMin}`}
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 bg-surface-sunken/70"
                      style={{ top: blockGeometry(s.startMin, s.endMin, 0, hourPx).top, height: ((s.endMin - s.startMin) / 60) * hourPx }}
                    />
                  ))}
                  {d.placed.map((p) => {
                    const box = boxOf(p, p.item.startMin, p.item.endMin, hourPx);
                    if (p.item.kind === "internal") {
                      const ev = p.item.internal;
                      return (
                        <InternalBlock
                          key={p.item.id}
                          item={ev}
                          tz={tz}
                          box={box}
                          lanes={p.columns}
                          dragging={drag?.active && drag.item.id === ev.id}
                          onDragStart={canDrag(ev) ? (pe, top) => startDrag(ev, pe, top) : undefined}
                          onOpen={openInternal}
                        />
                      );
                    }
                    const a = p.item.appointment;
                    return (
                      <AppointmentBlock
                        key={p.item.id}
                        appointment={a}
                        expired={p.item.expired}
                        conflict={a.resources.some((r) => !r.allocated)}
                        tz={tz}
                        box={box}
                        tone={appointmentTone(a, tone)}
                        lanes={p.columns}
                        onOpen={onAppointmentClick}
                        quick={quick}
                      />
                    );
                  })}
                  {d.overflow.map((o) => {
                    const box = boxOf(o, o.startMin, o.endMin, hourPx);
                    return (
                      <button
                        key={o.id}
                        type="button"
                        title={fillVocab(blk.more, { n: o.hidden })}
                        aria-label={fillVocab(blk.more, { n: o.hidden })}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDay(d.localDate);
                        }}
                        style={{ top: box.top, height: Math.max(box.height - 2, 20), left: box.left, width: box.width }}
                        className="absolute flex items-start justify-center overflow-hidden rounded-md border border-border bg-surface-overlay px-0.5 py-0.5 text-xs font-semibold text-text-secondary hover:bg-surface-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      >
                        {fillVocab(blk.moreLabel, { n: o.hidden })}
                      </button>
                    );
                  })}
                  {drag?.active && drag.target?.localDate === d.localDate && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0.5 z-20 overflow-hidden rounded-md border-2 border-dashed border-brand-500 bg-brand-500/15 px-1 text-xs font-semibold text-text-primary"
                      style={{
                        top: (drag.target.minute / 60) * hourPx,
                        height: Math.max(((drag.item.endTime - drag.item.startTime) / 60000 / 60) * hourPx, 22),
                      }}
                    >
                      {minutesLabel(drag.target.minute)} {drag.item.title}
                    </div>
                  )}
                  {d.isToday && nowTop !== null && (
                    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowTop }}>
                      <span className="-ml-[5px] h-2.5 w-2.5 rounded-full bg-semantic-error" />
                      <span className="h-0.5 flex-1 bg-semantic-error" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
