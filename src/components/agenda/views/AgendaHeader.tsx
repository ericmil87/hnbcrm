import { ChevronLeft, ChevronRight, CalendarPlus, DoorOpen, Lock, ListChecks, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { fillVocab } from "@/lib/agendaCopy";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import type { AgendaView, GroupParam, ListMode } from "@/lib/agendaViewParams";
import { VOCAB } from "@/lib/vocab";
import { cn } from "@/lib/utils";

const t = VIEWS_COPY;

export interface AgendaHeaderProps {
  view: AgendaView;
  onViewChange: (view: AgendaView) => void;
  group: GroupParam;
  onGroupChange: (group: GroupParam) => void;
  listMode: ListMode;
  onListModeChange: (mode: ListMode) => void;
  /** Rótulo do período ("seg, 23/11" ou "Novembro de 2026"). */
  dateLabel: string;
  isToday: boolean;
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
}

/** Cabeçalho da Agenda v2: título, navegação por data, visão, agrupamento, "Marcar horário" e pendências. */
export function AgendaHeader(p: AgendaHeaderProps) {
  const month = p.view === "mes";
  const prevLabel = month ? t.prevMonth : t.prevDay;
  const nextLabel = month ? t.nextMonth : t.nextDay;
  const week = p.view === "semana";
  const menuItems = [
    ...(p.canCreateEvent && !week ? [{ id: "new-event", label: t.newEvent, icon: <CalendarPlus size={16} aria-hidden="true" />, onSelect: p.onNewEvent }] : []),
    ...(p.canManage
      ? [
          { id: "close-all", label: t.closeAll, icon: <Lock size={16} aria-hidden="true" />, onSelect: p.onCloseAll, separatorBefore: p.canCreateEvent && !week },
          { id: "reopen-all", label: t.reopenAll, icon: <DoorOpen size={16} aria-hidden="true" />, onSelect: p.onReopenAll },
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        title={t.title}
        actions={
          <>
            {p.pendingLabel !== null && (
              <Button
                variant="secondary"
                onClick={p.onOpenPending}
                aria-label={p.pendingTotal > 0 ? fillVocab(t.pending.aria, { n: p.pendingLabel }) : t.pending.none}
                className="relative"
              >
                <ListChecks size={18} aria-hidden="true" />
                <span>{t.pending.button}</span>
                {p.pendingTotal > 0 && (
                  <span className="rounded-full bg-semantic-warning/10 px-1.5 text-micro font-semibold tabular-nums text-semantic-warning">
                    {p.pendingLabel}
                  </span>
                )}
              </Button>
            )}
            {menuItems.length > 0 && (
              <Menu
                ariaLabel={t.menu}
                items={menuItems}
                trigger={(props) => (
                  <Button variant="secondary" iconOnly aria-label={t.menu} {...props}>
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </Button>
                )}
              />
            )}
            {p.canBook && !week && (
              <Button onClick={p.onBook} className="hidden md:inline-flex">
                <Plus size={18} aria-hidden="true" />
                {VOCAB.scheduling.book}
              </Button>
            )}
          </>
        }
      />

      {!week && (
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="secondary" iconOnly aria-label={prevLabel} onClick={p.onPrev}>
            <ChevronLeft size={18} aria-hidden="true" />
          </Button>
          <p className="min-w-[8.5rem] px-2 text-center text-base font-semibold text-text-primary" aria-live="polite">
            {p.dateLabel}
          </p>
          <Button variant="secondary" iconOnly aria-label={nextLabel} onClick={p.onNext}>
            <ChevronRight size={18} aria-hidden="true" />
          </Button>
        </div>
        <Button variant="secondary" onClick={p.onToday} disabled={p.isToday && !month}>
          {t.today}
        </Button>
      </div>
      )}

      <div className={cn("flex flex-wrap items-center gap-2")}>
        <SegmentedControl
          ariaLabel={t.viewsLabel}
          value={p.view}
          onValueChange={(v) => p.onViewChange(v as AgendaView)}
          options={[
            { value: "dia", label: t.views.dia },
            { value: "semana", label: t.views.semana },
            { value: "lista", label: t.views.lista },
            { value: "mes", label: t.views.mes },
          ]}
        />
        {!month && !week && (
          <SegmentedControl
            ariaLabel={t.groupLabel}
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
            value={p.listMode}
            onValueChange={(v) => p.onListModeChange(v as ListMode)}
            options={[
              { value: "hora", label: t.listModes.hora },
              { value: "recurso", label: t.listModes.recurso },
            ]}
          />
        )}
      </div>
    </div>
  );
}
