import type { ReactNode } from "react";
import {
  Calendar,
  CalendarCheck,
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  DoorOpen,
  ListChecks,
  List,
  Lock,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { fillVocab } from "@/lib/agendaCopy";
import { COLOR_SCHEMES, type ColorScheme } from "@/lib/agendaColors";
import { DENSITIES, type Density } from "@/lib/agendaPrefs";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import type { AgendaView, GroupParam, ListMode } from "@/lib/agendaViewParams";
import { VOCAB } from "@/lib/vocab";
import { cn } from "@/lib/utils";

const t = VIEWS_COPY;
const d = VIEWS_COPY.dense;

/** Ordem do seletor (como no Google Agenda): Dia, Semana, Mês, Lista. */
const VIEW_ORDER: readonly AgendaView[] = ["dia", "semana", "mes", "lista"];
const VIEW_ICON: Record<AgendaView, LucideIcon> = { dia: CalendarDays, semana: CalendarRange, mes: Calendar, lista: List };

export interface WeekFilterOption {
  id: string;
  label: string;
  kind: "room" | "person" | "equipment";
}

export interface AgendaToolbarProps {
  view: AgendaView;
  onViewChange: (view: AgendaView) => void;
  group: GroupParam;
  onGroupChange: (group: GroupParam) => void;
  listMode: ListMode;
  onListModeChange: (mode: ListMode) => void;
  /** Título do período ("26 de novembro de 2026", "23 – 29 de nov. de 2026", "Novembro de 2026"). */
  dateLabel: string;
  /** O período mostrado já contém hoje (o "Hoje" fica sem efeito). */
  atToday: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  canBook: boolean;
  onBook: () => void;
  canCreateEvent: boolean;
  onNewEvent: () => void;
  /** `agenda:manage`: fechar e reabrir a agenda inteira (feriado, recesso). */
  canManage: boolean;
  onCloseAll: () => void;
  onReopenAll: () => void;
  /** Rótulo do contador ("3", "50+"); `null` = ainda carregando ou módulo sem leitura. */
  pendingLabel: string | null;
  pendingTotal: number;
  onOpenPending: () => void;
  /** Filtro da Semana: recursos para escolher e o escolhido (`null` = todos). */
  weekFilter: { options: readonly WeekFilterOption[]; value: string | null; onChange: (id: string | null) => void } | null;
  color: ColorScheme;
  onColorChange: (c: ColorScheme) => void;
  density: Density;
  onDensityChange: (d: Density) => void;
  isMobile: boolean;
}

/**
 * Barra única da Agenda (estilo Google Agenda): [Hoje] [‹][›] título … agrupamento, visão, Pendências, ⋯ e
 * "Marcar horário". No celular cabe numa linha de 44 px: setas e título à esquerda; Hoje, Pendências, visão (menu) e ⋯
 * à direita; "Marcar horário" vira o botão flutuante da página.
 */
export function AgendaToolbar(p: AgendaToolbarProps) {
  const month = p.view === "mes";
  const week = p.view === "semana";
  const prevLabel = month ? t.prevMonth : week ? d.prevWeek : t.prevDay;
  const nextLabel = month ? t.nextMonth : week ? d.nextWeek : t.nextDay;
  const showGroup = p.view === "dia" || p.view === "lista";

  const viewItems: MenuItem[] = VIEW_ORDER.map((v) => {
    const Icon = VIEW_ICON[v];
    return { id: `view:${v}`, label: t.views[v], icon: <Icon size={16} aria-hidden="true" />, checked: p.view === v, onSelect: () => p.onViewChange(v) };
  });
  const groupItems: MenuItem[] = showGroup
    ? (["sala", "profissional"] as const).map((g, i) => ({
        id: `group:${g}`,
        label: `${t.groupLabel}: ${t.groups[g].toLowerCase()}`,
        checked: p.group === g,
        separatorBefore: i === 0,
        onSelect: () => p.onGroupChange(g),
      }))
    : [];
  const listItems: MenuItem[] =
    p.view === "lista"
      ? (["hora", "recurso"] as const).map((m, i) => ({ id: `list:${m}`, label: t.listModes[m], checked: p.listMode === m, separatorBefore: i === 0, onSelect: () => p.onListModeChange(m) }))
      : [];
  const filterItems: MenuItem[] =
    week && p.weekFilter
      ? [
          { id: "filter:all", label: d.filter.all, checked: p.weekFilter.value === null, onSelect: () => p.weekFilter!.onChange(null) },
          ...p.weekFilter.options.map((o) => ({ id: `filter:${o.id}`, label: o.label, checked: p.weekFilter!.value === o.id, onSelect: () => p.weekFilter!.onChange(o.id) })),
        ]
      : [];

  const colorItems: MenuItem[] = COLOR_SCHEMES.map((c, i) => ({ id: `color:${c}`, label: d.colors[c], checked: p.color === c, separatorBefore: i === 0, onSelect: () => p.onColorChange(c) }));
  const densityItems: MenuItem[] = DENSITIES.map((x, i) => ({ id: `density:${x}`, label: d.density[x], checked: p.density === x, separatorBefore: i === 0, onSelect: () => p.onDensityChange(x) }));
  const actionItems: MenuItem[] = [
    ...(p.canCreateEvent ? [{ id: "new-event", label: t.newEvent, icon: <CalendarPlus size={16} aria-hidden="true" />, onSelect: p.onNewEvent }] : []),
    ...(p.canManage
      ? [
          { id: "close-all", label: t.closeAll, icon: <Lock size={16} aria-hidden="true" />, onSelect: p.onCloseAll, separatorBefore: p.canCreateEvent },
          { id: "reopen-all", label: t.reopenAll, icon: <DoorOpen size={16} aria-hidden="true" />, onSelect: p.onReopenAll },
        ]
      : []),
  ];

  const pendingBadge = p.pendingTotal > 0 && (
    <span className="rounded-full bg-semantic-warning/15 px-1.5 text-micro font-semibold tabular-nums text-semantic-warning">{p.pendingLabel}</span>
  );
  const pendingAria = p.pendingTotal > 0 ? fillVocab(t.pending.aria, { n: p.pendingLabel ?? "" }) : t.pending.none;

  const nav: ReactNode = (
    <div className="flex items-center">
      <Button variant="ghost" iconOnly aria-label={prevLabel} onClick={p.onPrev} className="!h-11 !w-11 md:!h-9 md:!w-9">
        <ChevronLeft size={20} aria-hidden="true" />
      </Button>
      <Button variant="ghost" iconOnly aria-label={nextLabel} onClick={p.onNext} className="!h-11 !w-11 md:!h-9 md:!w-9">
        <ChevronRight size={20} aria-hidden="true" />
      </Button>
    </div>
  );
  const title = (
    <h1 className="min-w-0 truncate text-sm font-semibold text-text-primary md:text-lg" aria-live="polite">
      {p.dateLabel}
    </h1>
  );

  if (p.isMobile) {
    const mobileItems = [...viewItems, ...groupItems, ...listItems, ...filterItems.map((i, k) => ({ ...i, separatorBefore: k === 0 }))];
    const CurrentIcon = VIEW_ICON[p.view];
    const menuItems = [...actionItems, ...colorItems];
    return (
      <div role="toolbar" aria-label={t.title} className="flex items-center gap-0.5">
        {nav}
        <div className="min-w-0 flex-1 px-1">{title}</div>
        {!p.atToday && (
          <Button variant="ghost" iconOnly aria-label={d.goToday} onClick={p.onToday} className="!h-11 !w-11">
            <CalendarCheck size={20} aria-hidden="true" />
          </Button>
        )}
        {p.pendingLabel !== null && (
          <Button variant="ghost" iconOnly aria-label={pendingAria} onClick={p.onOpenPending} className="relative !h-11 !w-11">
            <ListChecks size={20} aria-hidden="true" />
            {p.pendingTotal > 0 && (
              <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-semantic-warning px-1 text-center text-micro font-bold leading-4 text-surface-base" aria-hidden="true">
                {p.pendingLabel}
              </span>
            )}
          </Button>
        )}
        <Menu
          ariaLabel={d.viewMenu}
          items={mobileItems}
          trigger={(props) => (
            <Button variant="ghost" iconOnly aria-label={fillVocab(d.viewMenuNow, { nome: t.views[p.view] })} {...props} className="!h-11 !w-11">
              <CurrentIcon size={20} aria-hidden="true" />
            </Button>
          )}
        />
        <Menu
          ariaLabel={t.menu}
          items={menuItems}
          trigger={(props) => (
            <Button variant="ghost" iconOnly aria-label={t.menu} {...props} className="!h-11 !w-11">
              <MoreHorizontal size={20} aria-hidden="true" />
            </Button>
          )}
        />
      </div>
    );
  }

  const selectedFilter = p.weekFilter?.options.find((o) => o.id === p.weekFilter?.value);
  return (
    <div role="toolbar" aria-label={t.title} className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button variant="secondary" size="sm" onClick={p.onToday} disabled={p.atToday}>
        {t.today}
      </Button>
      {nav}
      <div className="min-w-0 flex-1 basis-40 pr-2">{title}</div>

      {showGroup && (
        <SegmentedControl
          ariaLabel={t.groupLabel}
          size="sm"
          value={p.group}
          onValueChange={(v) => p.onGroupChange(v as GroupParam)}
          options={[
            { value: "sala", label: t.groups.sala },
            { value: "profissional", label: t.groups.profissional },
          ]}
        />
      )}
      {p.view === "lista" && (
        <SegmentedControl
          ariaLabel={t.listModeLabel}
          size="sm"
          value={p.listMode}
          onValueChange={(v) => p.onListModeChange(v as ListMode)}
          options={[
            { value: "hora", label: t.listModes.hora },
            { value: "recurso", label: t.listModes.recurso },
          ]}
        />
      )}
      {week && p.weekFilter && p.weekFilter.options.length > 0 && (
        <Menu
          ariaLabel={d.filter.label}
          items={filterItems}
          align="end"
          trigger={(props) => (
            <Button variant="secondary" size="sm" {...props} className="max-w-[14rem]">
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span className="truncate">{selectedFilter ? selectedFilter.label : d.filter.allShort}</span>
            </Button>
          )}
        />
      )}
      <SegmentedControl
        ariaLabel={t.viewsLabel}
        size="sm"
        value={p.view}
        onValueChange={(v) => p.onViewChange(v as AgendaView)}
        options={VIEW_ORDER.map((v) => ({ value: v, label: t.views[v] }))}
      />
      {p.pendingLabel !== null && (
        <Button variant="secondary" size="sm" onClick={p.onOpenPending} aria-label={pendingAria}>
          <ListChecks size={16} aria-hidden="true" />
          <span className="hidden xl:inline">{t.pending.button}</span>
          {pendingBadge}
        </Button>
      )}
      <Menu
        ariaLabel={t.menu}
        items={[...actionItems, ...colorItems, ...densityItems]}
        trigger={(props) => (
          <Button variant="secondary" size="sm" iconOnly aria-label={t.menu} {...props}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
        )}
      />
      {p.canBook && (
        <Button size="sm" onClick={p.onBook} className={cn("shrink-0")}>
          <Plus size={16} aria-hidden="true" />
          {VOCAB.scheduling.book}
        </Button>
      )}
    </div>
  );
}
