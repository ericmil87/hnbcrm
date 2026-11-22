import { useEffect, useRef, useState } from "react";
import { CalendarDays, Hourglass, Lock, TriangleAlert } from "lucide-react";
import { AppointmentStatusChip } from "@/components/agenda/AppointmentStatusChip";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { Skeleton } from "@/components/ui/Skeleton";
import { fillVocab } from "@/lib/agendaCopy";
import { appointmentTooltip, placeText, statusFlags } from "@/lib/agendaBlockText";
import { appointmentTone, type ToneContext } from "@/lib/agendaColors";
import { isExpiredProposal } from "@/lib/agendaStatus";
import type { InternalItem } from "@/lib/agendaGrid";
import { cutMonthLines, dayNumberLabel, monthDaySummary, monthMaxLines, type MonthGridDay, type MonthLine } from "@/lib/agendaMonthLines";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { addLocalDays, minutesLabel, shortDateLabel, zonedTimeLabel } from "@/lib/agendaZone";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";

const t = VIEWS_COPY.month;
const d = VIEWS_COPY.dense.month;

const SUMMARY_COPY = { none: t.emptyDay, one: t.markedOne, many: t.marked, pending: t.pendingMark, closed: t.allClosed, someClosed: d.someClosed } as const;

/** Resumo do dia para leitor de tela. */
export function daySummary(day: MonthGridDay, internal = 0): string {
  const base = monthDaySummary(day, SUMMARY_COPY);
  return internal > 0 ? `${base}, ${(internal === 1 ? t.internalOne : fillVocab(t.internal, { n: internal })).toLowerCase()}` : base;
}

export interface AgendaMonthViewProps {
  /** Semanas inteiras (7 dias cada), com os dias vizinhos do mês marcados `inMonth: false`. */
  weeks: ReadonlyArray<ReadonlyArray<MonthGridDay>>;
  tz: string;
  now: number;
  today: string;
  selected?: string;
  loading: boolean;
  tone: ToneContext;
  isMobile: boolean;
  /** Último dia com contagem completa quando o servidor cortou; `undefined` = completo. */
  partialFrom?: { through: string | null } | null;
  /** O período todo tem mais agendamentos do que o que foi lido. */
  truncated?: boolean;
  /** Abre o dia (visão Dia). */
  onOpenDay: (localDate: string) => void;
  /** Celular: escolhe o dia para ver a lista embaixo. */
  onSelectDay: (localDate: string) => void;
  onAppointmentClick: (appointmentId: string) => void;
  onInternalClick: (item: InternalItem) => void;
  className?: string;
}

/** Altura (px) de um elemento, acompanhada por `ResizeObserver` (sem ele, o valor de reserva). Ref por função: o elemento pode montar depois (esqueleto antes). */
function useHeight<T extends HTMLElement>(fallback: number): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [h, setH] = useState(fallback);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setH(el.clientHeight || fallback));
    ro.observe(el);
    setH(el.clientHeight || fallback);
    return () => ro.disconnect();
  }, [el, fallback]);
  return [setEl, h];
}

function lineDot(line: MonthLine, tone: ToneContext): string {
  return line.appointment ? appointmentTone(line.appointment, tone).dot : "bg-ai-500";
}

function LineButton({ line, tz, now, tone, onAppointmentClick, onInternalClick }: { line: MonthLine; tz: string; now: number; tone: ToneContext } & Pick<AgendaMonthViewProps, "onAppointmentClick" | "onInternalClick">) {
  const a = line.appointment;
  const expired = a ? isExpiredProposal(a, now) : false;
  const time = line.startMin === null ? "" : minutesLabel(line.startMin);
  const tip = a ? appointmentTooltip(a, tz, expired, VOCAB.scheduling.proposalExpired) : `${line.label}${time ? ` · ${time}` : ""}`;
  return (
    <button
      type="button"
      title={tip}
      aria-label={tip}
      data-line={line.kind}
      onClick={(e) => {
        e.stopPropagation();
        if (line.appointment) onAppointmentClick(line.appointment._id);
        else if (line.internal) onInternalClick(line.internal);
      }}
      className={cn(
        "flex h-[18px] w-full items-center gap-1 rounded px-1 text-left text-xs leading-[18px] text-text-primary hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        a?.status === "pending_approval" && "italic"
      )}
    >
      <span className={cn("h-2 w-2 shrink-0 rounded-full", lineDot(line, tone), line.kind === "internal" && "ring-1 ring-inset ring-ai-500 bg-transparent")} aria-hidden="true" />
      {time ? <span className="shrink-0 tabular-nums text-text-secondary">{time}</span> : <CalendarDays size={11} className="shrink-0 text-ai-400" aria-hidden="true" />}
      <span className="truncate font-medium">{line.label}</span>
    </button>
  );
}

function DayCell({ day, today, selected, maxLines, tz, now, tone, onOpenDay, onAppointmentClick, onInternalClick, measureRef }: {
  day: MonthGridDay;
  today: string;
  selected: boolean;
  maxLines: number;
  tz: string;
  now: number;
  tone: ToneContext;
  measureRef?: React.Ref<HTMLDivElement>;
} & Pick<AgendaMonthViewProps, "onOpenDay" | "onAppointmentClick" | "onInternalClick">) {
  const isToday = day.localDate === today;
  const { shown, hidden } = cutMonthLines(day.lines, maxLines, day.unseen);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const summary = `${shortDateLabel(day.localDate)}: ${daySummary(day)}`;
  return (
    <div
      ref={measureRef}
      role="gridcell"
      data-day={day.localDate}
      onClick={() => onOpenDay(day.localDate)}
      className={cn(
        "flex min-h-0 min-w-0 cursor-pointer flex-col overflow-hidden border-b border-r border-border-subtle p-0.5",
        !day.inMonth && "bg-surface-sunken",
        day.allClosed && "bg-surface-sunken",
        selected && "outline outline-2 -outline-offset-2 outline-brand-500"
      )}
    >
      <div className="flex h-6 shrink-0 items-center justify-between px-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDay(day.localDate);
          }}
          aria-label={summary}
          aria-current={isToday ? "date" : undefined}
          className={cn(
            "flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-medium tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
            isToday ? "bg-brand-600 text-white" : day.inMonth ? "text-text-primary hover:bg-surface-overlay" : "text-text-muted hover:bg-surface-overlay"
          )}
        >
          {dayNumberLabel(day.localDate)}
        </button>
        <span className="flex items-center gap-1 text-text-muted" aria-hidden="true">
          {day.pending > 0 && (
            <span className="flex items-center gap-0.5 text-micro text-semantic-warning" title={fillVocab(t.pendingMark, { n: day.pending })}>
              <Hourglass size={11} />
              {day.pending}
            </span>
          )}
          {(day.allClosed || day.someClosed) && <Lock size={11} className={day.allClosed ? "text-semantic-error" : undefined} />}
        </span>
      </div>
      <ul className={cn("min-h-0 flex-1 space-y-px overflow-hidden", !day.inMonth && "opacity-70")}>
        {shown.map((line) => (
          <li key={line.id}>
            <LineButton line={line} tz={tz} now={now} tone={tone} onAppointmentClick={onAppointmentClick} onInternalClick={onInternalClick} />
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <button
              ref={moreRef}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMoreOpen(true);
              }}
              aria-haspopup="dialog"
              aria-label={fillVocab(d.moreAria, { n: hidden, data: shortDateLabel(day.localDate) })}
              className="flex h-[18px] w-full items-center rounded px-1 text-left text-xs font-medium leading-[18px] text-text-secondary hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {fillVocab(d.more, { n: hidden })}
            </button>
            {moreOpen && (
              <Popover open onOpenChange={setMoreOpen} anchor={moreRef} side="bottom" align="start" role="dialog" aria-label={fillVocab(d.dayList, { data: shortDateLabel(day.localDate) })} className="w-72">
                <div onClick={(e) => e.stopPropagation()}>
                  <p className="border-b border-border px-3 py-2 text-sm font-semibold text-text-primary">{shortDateLabel(day.localDate)}</p>
                  <ul className="max-h-72 space-y-px overflow-y-auto p-1">
                    {day.lines.map((line) => (
                      <li key={line.id}>
                        <LineButton
                          line={line}
                          tz={tz}
                          now={now}
                          tone={tone}
                          onAppointmentClick={(id) => {
                            setMoreOpen(false);
                            onAppointmentClick(id);
                          }}
                          onInternalClick={(it) => {
                            setMoreOpen(false);
                            onInternalClick(it);
                          }}
                        />
                      </li>
                    ))}
                    {day.unseen > 0 && <li className="px-1 py-1 text-caption text-text-muted">{fillVocab(d.unlisted, { n: day.unseen })}</li>}
                  </ul>
                  <div className="flex justify-end border-t border-border p-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setMoreOpen(false);
                        onOpenDay(day.localDate);
                      }}
                    >
                      {d.openDay}
                    </Button>
                  </div>
                </div>
              </Popover>
            )}
          </li>
        )}
      </ul>
    </div>
  );
}

/** Dia escolhido no celular: a lista embaixo da grade de pontos (padrão do app do Google Agenda). */
function SelectedDayList({ day, tz, now, onOpenDay, onAppointmentClick, onInternalClick }: { day: MonthGridDay; tz: string; now: number } & Pick<AgendaMonthViewProps, "onOpenDay" | "onAppointmentClick" | "onInternalClick">) {
  const label = shortDateLabel(day.localDate);
  return (
    <section aria-label={fillVocab(d.dayList, { data: label })} className="relative min-h-0 flex-1 overflow-y-auto border-t border-border bg-surface-base px-1 pb-24 pt-2">
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <h2 className="text-sm font-semibold text-text-primary">{label}</h2>
        <Button size="sm" variant="ghost" onClick={() => onOpenDay(day.localDate)}>
          {d.openDay}
        </Button>
      </div>
      {day.lines.length === 0 ? (
        <p className="px-2 py-3 text-sm text-text-secondary">{day.allClosed ? d.closedDay : d.emptyDay}</p>
      ) : (
        <ul className="space-y-1.5">
          {day.lines.map((line) => {
            const a = line.appointment;
            const expired = a ? isExpiredProposal(a, now) : false;
            return (
              <li key={line.id}>
                <button
                  type="button"
                  onClick={() => (a ? onAppointmentClick(a._id) : line.internal && onInternalClick(line.internal))}
                  className="flex min-h-11 w-full items-center gap-3 rounded-card border border-border bg-surface-raised px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <span className="w-11 shrink-0 text-sm font-semibold tabular-nums text-text-primary">
                    {a ? zonedTimeLabel(a.startTime, tz) : line.internal && !line.internal.allDay ? zonedTimeLabel(line.internal.startTime, tz) : d.allDayShort}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-text-primary">{line.label}</span>
                    <span className="block truncate text-caption text-text-secondary">
                      {a ? [a.serviceName, placeText(a)].filter(Boolean).join(" · ") : VIEWS_COPY.dense.weekGrid.eventTitle}
                    </span>
                  </span>
                  {a && statusFlags(a, expired).length > 0 && <AppointmentStatusChip status={a.status} expired={expired} compact />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Mês estilo Google: as células preenchem a altura e cada dia lista "09:00 Cliente" (ponto, hora e nome, truncado) até
 * onde cabe, com "+N mais" que abre o dia. Dias vizinhos esmaecidos, dia fechado com cadeado. No celular, pontos por dia
 * e a lista do dia escolhido embaixo.
 */
export function AgendaMonthView({
  weeks,
  tz,
  now,
  today,
  selected,
  loading,
  tone,
  isMobile,
  partialFrom,
  truncated,
  onOpenDay,
  onSelectDay,
  onAppointmentClick,
  onInternalClick,
  className,
}: AgendaMonthViewProps) {
  const [measureRef, cellH] = useHeight<HTMLDivElement>(110);
  const maxLines = monthMaxLines(cellH);
  const all = weeks.flat();
  const selectedDay = all.find((x) => x.localDate === selected) ?? all.find((x) => x.localDate === today) ?? all.find((x) => x.inMonth);
  const notice =
    partialFrom || truncated ? (
      <p role="status" className="flex items-start gap-2 border-b border-semantic-warning/40 bg-semantic-warning/10 px-3 py-1.5 text-xs text-text-primary">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
        {partialFrom?.through ? fillVocab(t.partial, { data: shortDateLabel(addLocalDays(partialFrom.through, 1)) }) : t.partialUnknown}
      </p>
    ) : null;

  if (loading && all.every((x) => x.lines.length === 0)) {
    return (
      <div role="status" aria-label={t.loading} className={cn("grid flex-1 grid-cols-7 gap-1 rounded-card border border-border bg-surface-raised p-1.5", className)}>
        {Array.from({ length: 35 }, (_, i) => (
          <Skeleton key={`sk:${i}`} className="h-full min-h-12 rounded-field" />
        ))}
      </div>
    );
  }

  const header = (
    <div role="row" className="grid shrink-0 grid-cols-7 border-b border-border bg-surface-raised">
      {t.weekdays.map((wd) => (
        <div key={`wd:${wd}`} role="columnheader" className="py-1 text-center text-micro font-medium uppercase tracking-wide text-text-muted">
          {wd}
        </div>
      ))}
    </div>
  );

  if (isMobile) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface-raised", className)}>
        {notice}
        <div role="grid" aria-label={t.ariaLabel} aria-busy={loading} className="shrink-0">
          {header}
          {weeks.map((week, w) => (
            <div key={`week:${w}`} role="row" className="grid grid-cols-7">
              {week.map((day) => {
                const isToday = day.localDate === today;
                const isSel = selectedDay?.localDate === day.localDate;
                const dots = day.lines.slice(0, 3);
                return (
                  <div key={day.localDate} role="gridcell" className="border-b border-border-subtle">
                    <button
                      type="button"
                      onClick={() => onSelectDay(day.localDate)}
                      aria-label={`${shortDateLabel(day.localDate)}: ${daySummary(day)}`}
                      aria-current={isToday ? "date" : undefined}
                      aria-pressed={isSel}
                      className={cn(
                        "flex h-12 w-full flex-col items-center justify-center gap-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
                        !day.inMonth && "text-text-muted",
                        day.allClosed && "bg-surface-sunken"
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-7 min-w-7 items-center justify-center rounded-full text-sm font-medium tabular-nums",
                          isToday ? "bg-brand-600 text-white" : isSel ? "bg-brand-500/15 text-text-primary ring-1 ring-brand-500" : day.inMonth ? "text-text-primary" : "text-text-muted"
                        )}
                      >
                        {day.day}
                      </span>
                      <span className="flex h-2 items-center gap-0.5" aria-hidden="true">
                        {dots.map((l) => (
                          <span key={l.id} className={cn("h-1.5 w-1.5 rounded-full", lineDot(l, tone))} />
                        ))}
                        {day.total > dots.length && <span className="text-micro leading-none text-text-muted">+</span>}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {selectedDay && (
          <SelectedDayList day={selectedDay} tz={tz} now={now} onOpenDay={onOpenDay} onAppointmentClick={onAppointmentClick} onInternalClick={onInternalClick} />
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface-raised", className)}>
      {notice}
      <div role="grid" aria-label={t.ariaLabel} aria-busy={loading} className="relative flex min-h-0 flex-1 flex-col overflow-auto">
        {header}
        <div className="grid min-h-0 flex-1 border-l border-border-subtle" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(6.5rem, 1fr))` }}>
          {weeks.map((week, w) => (
            <div key={`week:${w}`} role="row" className="grid min-h-0 grid-cols-7">
              {week.map((day, i) => (
                <DayCell
                  key={day.localDate}
                  day={day}
                  today={today}
                  selected={day.localDate === selected && day.localDate !== today}
                  maxLines={maxLines}
                  tz={tz}
                  now={now}
                  tone={tone}
                  measureRef={w === 0 && i === 0 ? measureRef : undefined}
                  onOpenDay={onOpenDay}
                  onAppointmentClick={onAppointmentClick}
                  onInternalClick={onInternalClick}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="sr-only">{t.legend}</p>
    </div>
  );
}
