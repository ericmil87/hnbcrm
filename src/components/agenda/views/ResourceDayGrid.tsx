import { AlertTriangle, CalendarDays, DoorOpen, Lock, MoreVertical, Plus, UserRound } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { useColumnWidth } from "./useColumnWidth";
import { AppointmentBlock, InternalBlock, type BlockBox, type QuickActions } from "./AgendaBlocks";
import { VacancyIndicator } from "@/components/agenda/VacancyIndicator";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { fillVocab } from "@/lib/agendaCopy";
import { appointmentTone, type ToneContext } from "@/lib/agendaColors";
import { initialScrollMinute, scrollTopFor } from "@/lib/agendaScroll";
import {
  blockGeometry,
  gridHeight,
  HOUR_PX,
  hourLabels,
  minuteFromOffset,
  nowLineTop,
  type DayGridModel,
  type DayResource,
  type GridColumn,
  type InternalItem,
  type PlacedItem,
} from "@/lib/agendaGrid";
import { vacancyOf } from "@/lib/agendaStatus";
import { dayLabels, VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { minutesLabel } from "@/lib/agendaZone";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";

const t = VIEWS_COPY.grid;

/** Ação do menu da coluna; o contêiner decide o que cada uma abre. */
export type ColumnAction = "book" | "closeToday" | "closePeriod" | "reopen" | "reopenPeriod";

export interface ResourceDayGridProps {
  model: DayGridModel;
  tz: string;
  /** Rótulo do agrupamento para o leitor de tela ("sala" ou "profissional"). */
  groupLabel: string;
  canBook: boolean;
  /** `agenda:edit`: fechar e abrir recurso no dia. */
  canClose: boolean;
  /** O dia aberto é hoje: rótulos "hoje"; senão "neste dia" (a ação vale para o dia aberto, não para hoje). */
  isToday: boolean;
  /** Mostra só estas colunas (celular: uma por vez). */
  visibleKeys?: readonly string[];
  onSlotClick: (resource: DayResource | null, minute: number) => void;
  onAppointmentClick: (appointmentId: string) => void;
  onInternalClick: (item: InternalItem) => void;
  onColumnAction: (resource: DayResource, action: ColumnAction) => void;
  /** Altura de uma hora em px (densidade); padrão 60. */
  hourPx?: number;
  /** Cores dos blocos; padrão: pela situação. */
  tone?: ToneContext;
  /** Ações rápidas do cartão do passar do mouse. */
  quick?: QuickActions;
  /** Muda quando a grade deve voltar à posição inicial (dia, agrupamento, densidade). */
  scrollKey?: string;
  className?: string;
}

const DEFAULT_TONE: ToneContext = { scheme: "status", resourceOrder: [], serviceOrder: [] };
/** Largura do eixo de horas. */
const GUTTER = "2.75rem";

const HATCH = {
  backgroundImage: "repeating-linear-gradient(135deg, var(--border-default) 0 1px, transparent 1px 9px)",
} as const;

const KIND_ICON = { room: DoorOpen, person: UserRound, equipment: DoorOpen } as const;

function ColumnHeader({
  col,
  canBook,
  canClose,
  isToday,
  onColumnAction,
}: {
  col: GridColumn;
  isToday: boolean;
  canBook: boolean;
  canClose: boolean;
  onColumnAction: ResourceDayGridProps["onColumnAction"];
}) {
  const r = col.resource;
  const Icon = col.kind === "internal" ? CalendarDays : r ? KIND_ICON[r.kind] : DoorOpen;
  const v = vacancyOf(col.load.used, col.capacity);
  const showVacancy = col.kind === "resource" && (col.capacity > 1 || v.over);
  const labels = dayLabels(isToday);
  const items: MenuItem[] = [];
  if (r && canBook && !col.closed) {
    items.push({ id: "book", label: t.bookHere, icon: <Plus size={16} aria-hidden="true" />, onSelect: () => onColumnAction(r, "book") });
  }
  if (r && canClose) {
    if (col.closed) {
      items.push({ id: "reopen", label: labels.reopen, icon: <DoorOpen size={16} aria-hidden="true" />, onSelect: () => onColumnAction(r, "reopen") });
      items.push({ id: "reopen-period", label: t.reopenPeriod, icon: <DoorOpen size={16} aria-hidden="true" />, onSelect: () => onColumnAction(r, "reopenPeriod") });
    } else {
      items.push({ id: "close-today", label: labels.close, icon: <Lock size={16} aria-hidden="true" />, onSelect: () => onColumnAction(r, "closeToday") });
    }
    items.push({ id: "close-period", label: t.closePeriod, icon: <Lock size={16} aria-hidden="true" />, onSelect: () => onColumnAction(r, "closePeriod") });
  }
  const overPeak = col.kind === "resource" && col.peak > col.capacity;
  const closedText = col.kind === "resource" && r?.kind === "room" ? labels.closed.fem : labels.closed.masc;
  const iconBtn =
    "flex h-7 w-7 coarse:h-11 coarse:w-11 shrink-0 items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";
  // Uma linha: nome, ocupação "2/2", avisos e as ações (marcar aqui, menu). O motivo do fechamento fica na faixa da coluna.
  return (
    <div className="flex min-h-9 coarse:min-h-11 items-center gap-1.5 border-l border-border-subtle px-2 py-0.5" title={col.closedReason ?? undefined}>
      <Icon size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
      <p className="min-w-0 truncate text-sm font-semibold text-text-primary">{col.label}</p>
      {showVacancy && (
        <span className="inline-flex shrink-0 items-center gap-1">
          <VacancyIndicator used={col.load.used} capacity={col.capacity} />
          <span className="sr-only">{fillVocab(col.load.basis === "now" ? t.loadNow : t.loadPeak, { label: v.label })}</span>
        </span>
      )}
      {col.closed && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-semantic-error/10 px-1.5 py-0.5 text-micro font-medium text-semantic-error">
          <Lock size={11} aria-hidden="true" />
          {closedText}
        </span>
      )}
      {overPeak && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-semantic-error/10 px-1.5 py-0.5 text-micro font-medium text-semantic-error">
          <AlertTriangle size={11} aria-hidden="true" />
          {fillVocab(t.peakOver, { label: `${col.peak}/${col.capacity}` })}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center">
        {r && canBook && !col.closed && (
          <button
            type="button"
            onClick={() => onColumnAction(r, "book")}
            aria-label={fillVocab(t.bookInColumn, { nome: col.label })}
            className={cn(iconBtn, "text-brand-500 hover:bg-brand-500/10")}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
        {items.length > 0 && (
          <Menu
            ariaLabel={fillVocab(t.columnMenu, { nome: col.label })}
            items={items}
            trigger={(props) => (
              <button
                type="button"
                {...props}
                aria-label={fillVocab(t.columnMenu, { nome: col.label })}
                className={cn(iconBtn, "text-text-muted hover:bg-surface-overlay hover:text-text-primary")}
              >
                <MoreVertical size={16} aria-hidden="true" />
              </button>
            )}
          />
        )}
      </span>
    </div>
  );
}

function boxOf(p: PlacedItem, windowStartHour: number, hourPx: number): BlockBox {
  const { top, height } = blockGeometry(p.item.startMin, p.item.endMin, windowStartHour, hourPx);
  return { top, height, left: `calc(${(p.column / p.columns) * 100}% + 2px)`, width: `calc(${100 / p.columns}% - 4px)` };
}

/**
 * Dia por recurso (computador e tablet): uma coluna por sala ou profissional, as 24 horas com o fora do expediente
 * esmaecido (a grade abre rolada no começo do expediente ou em "agora"), faixas lado a lado até a capacidade (sala
 * dupla), coluna fechada hachurada, linha vermelha do "agora". Ocupa a altura que o contêiner der: só a grade rola e o
 * cabeçalho das colunas fica fixo no topo. Toque ou clique num vazio marca horário ali; o menu da coluna é o caminho
 * por teclado. Sem arrasto. Apresentacional: o contêiner entrega o modelo pronto (`buildDayGridModel`).
 */
export function ResourceDayGrid({
  model,
  tz,
  groupLabel,
  canBook,
  canClose,
  isToday,
  visibleKeys,
  onSlotClick,
  onAppointmentClick,
  onInternalClick,
  onColumnAction,
  hourPx = HOUR_PX,
  tone = DEFAULT_TONE,
  quick,
  scrollKey,
  className,
}: ResourceDayGridProps) {
  const columns = visibleKeys ? model.columns.filter((c) => visibleKeys.includes(c.key)) : model.columns;
  const height = gridHeight(model.window, hourPx);
  const nowTop = nowLineTop(model.nowMin, model.window, hourPx);
  const hours = hourLabels(model.window);
  const template: CSSProperties = { gridTemplateColumns: `${GUTTER} repeat(${columns.length}, minmax(${visibleKeys ? "0px" : "10rem"}, 1fr))` };
  const scroller = useRef<HTMLDivElement>(null);
  const colW = useColumnWidth(scroller, "[data-col]", columns.length);
  // Largura do bloco = faixa da coluna (menos a folga); decide o texto sem quebrar palavra.
  const widthOf = (p: PlacedItem) => (colW === undefined ? undefined : colW / p.columns - 4);

  // Posição inicial: começo do expediente (ou "agora"); só quando o dia, o agrupamento ou a densidade mudam.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const minute = initialScrollMinute({ nowMin: model.nowMin, openStartMin: model.openStartMin, openEndMin: model.openEndMin, firstItemMin: model.firstItemMin });
    el.scrollTop = scrollTopFor(minute - model.window.startHour * 60, hourPx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, hourPx]);

  const clickColumn = (col: GridColumn, e: MouseEvent<HTMLDivElement>) => {
    // Evento vindo de um portal (cartão, menu) sobe pela árvore do React mas não está dentro da coluna.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (!canBook || col.closed || col.kind === "internal") return;
    const rect = e.currentTarget.getBoundingClientRect();
    onSlotClick(col.resource, minuteFromOffset(e.clientY - rect.top, model.window.startHour, model.window.endHour, hourPx));
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface-raised", className)}>
      <div ref={scroller} data-grid-scroller className="relative min-h-0 flex-1 overflow-auto overscroll-contain">
        <div role="group" aria-label={fillVocab(t.ariaLabel, { por: groupLabel })} className="min-w-fit">
          <div className="sticky top-0 z-30 grid border-b border-border bg-surface-raised" style={template}>
            <div aria-hidden="true" className="sticky left-0 z-20 bg-surface-raised" />
            {columns.map((col) => (
              <ColumnHeader key={`head:${col.key}`} col={col} canBook={canBook} canClose={canClose} isToday={isToday} onColumnAction={onColumnAction} />
            ))}
          </div>

          <div className="relative grid" style={template}>
            <div className="sticky left-0 z-20 bg-surface-raised" style={{ height }} aria-hidden="true">
              {hours.map((h, i) => (
                <span
                  key={`hour:${h}`}
                  className="absolute right-1.5 text-micro tabular-nums text-text-muted"
                  style={{ top: i * hourPx, transform: i === 0 ? "translateY(2px)" : "translateY(-50%)" }}
                >
                  {minutesLabel(h * 60)}
                </span>
              ))}
            </div>
            {columns.map((col) => (
              <div
                key={`col:${col.key}`}
                role="group"
                aria-label={col.label}
                data-col=""
                className={cn("relative border-l border-border-subtle", canBook && !col.closed && col.kind !== "internal" && "cursor-pointer")}
                style={{ height }}
                onClick={(e) => clickColumn(col, e)}
              >
                {hours.map((h, i) => (
                  <div key={`line:${h}`} aria-hidden="true" className="absolute inset-x-0 border-t border-border-subtle" style={{ top: i * hourPx }} />
                ))}
                {col.offHours.map((s) => (
                  <div
                    key={`off:${s.startMin}`}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bg-surface-sunken/70"
                    style={{ top: blockGeometry(s.startMin, s.endMin, model.window.startHour, hourPx).top, height: ((s.endMin - s.startMin) / 60) * hourPx }}
                  />
                ))}
                {col.blocked.map((s) => (
                  <div
                    key={`blk:${s.startMin}`}
                    className="pointer-events-none absolute inset-x-0 flex items-start justify-center bg-surface-sunken/70 pt-1 text-caption text-text-muted"
                    style={{ ...HATCH, top: blockGeometry(s.startMin, s.endMin, model.window.startHour, hourPx).top, height: ((s.endMin - s.startMin) / 60) * hourPx }}
                  >
                    <span className="rounded-full bg-surface-raised px-2">{t.blocked}</span>
                  </div>
                ))}
                {col.allDayBands.length > 0 && (
                  <>
                    <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-ai-500 bg-ai-500/10" aria-hidden="true" />
                    <ul className="absolute inset-x-1 top-1 z-10 space-y-1" aria-label={t.allDay}>
                      {col.allDayBands.map((e) => (
                        <li key={`band:${e.source}:${e.id}`}>
                          <button
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onInternalClick(e);
                            }}
                            aria-label={fillVocab(t.allDayBand, { titulo: e.title })}
                            className="flex min-h-9 coarse:min-h-11 w-full items-center gap-1.5 rounded-field border border-dashed border-ai-500 bg-surface-raised px-2 text-left text-xs text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                          >
                            <CalendarDays size={12} className="shrink-0 text-ai-400" aria-hidden="true" />
                            <span className="shrink-0 font-semibold">{t.allDayShort}</span>
                            <span className="truncate">{e.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {col.closed && <div className="pointer-events-none absolute inset-0 bg-surface-sunken/60" style={HATCH} aria-hidden="true" />}
                {col.closed && (
                  <div className="pointer-events-none absolute inset-x-1 top-2 flex flex-col items-center rounded-field bg-surface-raised px-2 py-1 text-center shadow-card">
                    <span className="flex items-center gap-1 text-xs font-semibold text-text-primary">
                      <Lock size={12} aria-hidden="true" />
                      {col.resource?.kind === "room" ? dayLabels(isToday).closed.fem : dayLabels(isToday).closed.masc}
                    </span>
                    {col.closedReason && <span className="text-caption text-text-secondary">{col.closedReason}</span>}
                  </div>
                )}
                {col.placed.map((p) => {
                  const item = p.item;
                  const box = boxOf(p, model.window.startHour, hourPx);
                  if (item.kind === "busy") {
                    return (
                      <div
                        key={`blk:${item.id}`}
                        role="img"
                        aria-label={t.busy}
                        style={{ top: box.top, height: Math.max(box.height - 2, 20), left: box.left, width: box.width }}
                        className="absolute flex items-start gap-1 overflow-hidden rounded-md border border-border-subtle bg-surface-overlay px-1.5 py-0.5 text-xs text-text-muted"
                      >
                        <Lock size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{t.busy}</span>
                      </div>
                    );
                  }
                  if (item.kind === "internal") {
                    return <InternalBlock key={`blk:${item.id}`} item={item.internal} tz={tz} box={box} widthPx={widthOf(p)} onOpen={onInternalClick} />;
                  }
                  const a = item.appointment;
                  return (
                    <AppointmentBlock
                      key={`blk:${item.id}`}
                      appointment={a}
                      expired={item.expired}
                      conflict={item.conflict}
                      over={p.over}
                      tz={tz}
                      box={box}
                      tone={appointmentTone(a, tone)}
                      exceptResourceId={col.resource?._id ?? null}
                      widthPx={widthOf(p)}
                      onOpen={onAppointmentClick}
                      quick={quick}
                    />
                  );
                })}
              </div>
            ))}
            {nowTop !== null && (
              <div aria-hidden="true" className="pointer-events-none absolute right-0 z-10 flex items-center" style={{ top: nowTop, left: GUTTER }}>
                <span className="-ml-[5px] h-2.5 w-2.5 rounded-full bg-semantic-error" />
                <span className="h-0.5 flex-1 bg-semantic-error" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
