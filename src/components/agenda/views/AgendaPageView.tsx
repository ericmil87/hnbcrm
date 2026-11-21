import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext } from "react-router";
import { useQuery } from "convex/react";
import { Plus, Settings2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { CalendarEventModal } from "@/components/calendar/CalendarEventModal";
import { EventDetailSlideOver } from "@/components/calendar/EventDetailSlideOver";
import { TaskQuickView } from "@/components/calendar/TaskQuickView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterChips } from "@/components/ui/FilterChips";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { useRoundedNow } from "@/components/agenda/booking/useRoundedNow";
import { useAgendaAccess } from "@/hooks/useAgendaAccess";
import { useKeepPrevious } from "@/hooks/useKeepPrevious";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import { buildDayList, summarizeResources } from "@/lib/agendaDayList";
import {
  buildDayGridModel,
  toInternalItems,
  type DayInput,
  type DayResource,
  type InternalItem,
} from "@/lib/agendaGrid";
import { buildMonthCells } from "@/lib/agendaMonth";
import { pendingBadgeLabel, pendingTotal } from "@/lib/agendaPending";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import {
  dateKeyParam,
  defaultView,
  groupByOf,
  groupParam,
  groupParamOf,
  idParam,
  listModeParam,
  monthRange,
  periodLabel,
  shiftDate,
  viewParam,
  type GroupParam,
} from "@/lib/agendaViewParams";
import { minutesLabel, shortDateLabel, zonedDayBounds, zonedToday, type LocalDate } from "@/lib/agendaZone";
import { TAB_ROUTES } from "@/lib/routes";
import { booleanParam } from "@/lib/searchParamState";
import { VOCAB } from "@/lib/vocab";
import { AgendaHeader } from "./AgendaHeader";
import { AgendaDayList } from "./AgendaDayList";
import type { ColumnAction } from "./ResourceDayGrid";
import type { PendingData } from "./PendingQueueView";
import type { PickedClient } from "./ClientPickerSheet";

const t = VIEWS_COPY;

// Pedaços pesados ou raros: só baixam quando a visão ou a folha aparece.
const ResourceDayGrid = lazy(() => import("./ResourceDayGrid").then((m) => ({ default: m.ResourceDayGrid })));
const AgendaMonthView = lazy(() => import("./AgendaMonthView").then((m) => ({ default: m.AgendaMonthView })));
const PendingQueuePanel = lazy(() => import("./PendingQueuePanel").then((m) => ({ default: m.PendingQueuePanel })));
const ClientPickerSheet = lazy(() => import("./ClientPickerSheet").then((m) => ({ default: m.ClientPickerSheet })));
const AgendaSetupWizard = lazy(() =>
  import("@/components/agenda/onboarding/AgendaSetupWizard").then((m) => ({ default: m.AgendaSetupWizard }))
);

// A folha de marcar horário e o painel do agendamento entram por lazy DIRETO (não pelos `Lazy*` das entradas
// da conversa e do lead): importar esses módulos daqui os tirava do chunk onde estão e pendurava um chunk
// compartilhado novo em Entrada, Lead e Contatos (cresciam todos alguns bytes).
const BookingSheet = lazy(() => import("@/components/agenda/booking/BookingSheet").then((m) => ({ default: m.BookingSheet })));
const AppointmentDetailPanel = lazy(() =>
  import("@/components/agenda/detail/AppointmentDetailPanel").then((m) => ({ default: m.AppointmentDetailPanel }))
);

const DAY_MS = 86_400_000;

type Booking =
  | { stage: "pick"; date: LocalDate; minute?: number; resource?: DayResource }
  | { stage: "sheet"; date: LocalDate; resource?: DayResource; who: PickedClient };

function ContentSkeleton() {
  return (
    <div className="space-y-2" role="status" aria-label={t.loading}>
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={`sk:${i}`} className="h-14 rounded-card" />
      ))}
    </div>
  );
}

/** Fallback do `?event=` inválido: limpa o parâmetro (mesmo comportamento da página de compromissos). */
function ClearParam({ onClear }: { onClear: () => void }) {
  useEffect(() => {
    onClear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/**
 * Corpo da página da Agenda com o módulo `scheduling` LIGADO (o `AgendaPage` é só o casco lazy; ver lá). Contêiner: lê a URL
 * (`?visao= ?data= ?por= ?lista= ?appt= ?pendencias=`, mais `?event=` dos compromissos), assina só as
 * queries da visão aberta e entrega modelos prontos às telas por props (`ResourceDayGrid`, `AgendaDayList`,
 * `AgendaMonthView`, `PendingQueueView`). Compromissos e tarefas entram junto, em estilo próprio, e o
 * criar/editar/ver compromisso é o mesmo de `components/calendar/`.
 */
export function AgendaPageView() {
  usePageTitle(VOCAB.agenda.title);
  const navigate = useNavigate();
  const { organizationId } = useOutletContext<AppOutletContext>();
  const tz = useOrgTimezone(organizationId);
  const access = useAgendaAccess(organizationId);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const now = useRoundedNow("minute");
  const hourNow = useRoundedNow("hour");
  const today = zonedToday(now, tz);

  // --- URL ---
  const viewState = useSearchParamState("visao", viewParam);
  const dateState = useSearchParamState("data", dateKeyParam);
  const groupState = useSearchParamState("por", groupParam);
  const listState = useSearchParamState("lista", listModeParam);
  const apptState = useSearchParamState("appt", idParam, { history: "push" });
  const pendingState = useSearchParamState("pendencias", booleanParam, { history: "push" });
  const eventState = useSearchParamState("event", idParam, { history: "push" });

  const view = viewState.value ?? defaultView(isMobile);
  const date = dateState.value ?? today;
  const group: GroupParam = groupState.value;
  const groupBy = groupByOf(group);
  const listMode = listState.value;

  // --- estado local ---
  const [booking, setBooking] = useState<Booking | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [eventModal, setEventModal] = useState<{ eventId?: string; date: Date } | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [mobileColumn, setMobileColumn] = useState<string | null>(null);

  // --- dados ---
  const config = useQuery(api.schedulingConfig.getConfig, access.canView ? { organizationId, closuresFrom: today } : "skip");
  const dayArgs = access.canView && view !== "mes" ? { organizationId, localDate: date } : "skip";
  const rawDay = useQuery(api.scheduling.listAgendaDay, dayArgs);
  const day = useKeepPrevious(rawDay, organizationId);
  const monthArgs = useMemo(() => {
    const { from, to } = monthRange(date);
    return { organizationId, fromLocalDate: from, toLocalDate: to };
  }, [organizationId, date]);
  const rawRange = useQuery(api.scheduling.listAgendaRange, access.canView && view === "mes" ? monthArgs : "skip");
  const range = useKeepPrevious(rawRange, organizationId);
  const pending = useQuery(api.scheduling.listPending, access.canView ? { organizationId, now: hourNow } : "skip");

  const eventArgs = useMemo(() => {
    const b = zonedDayBounds(date, tz);
    // Como na página de compromissos: recua um dia para trazer o que começou ontem e cruza a meia-noite.
    return { organizationId, startDate: b.start - DAY_MS, endDate: b.end, includeTasks: true };
  }, [organizationId, date, tz]);
  const rawEvents = useQuery(api.calendar.getEvents, access.canView && view !== "mes" ? eventArgs : "skip");
  const events = useKeepPrevious(rawEvents, organizationId);
  const internal = useMemo(() => toInternalItems(events), [events]);

  // --- modelos ---
  const dayInput: DayInput | null = useMemo(() => {
    if (!day || !day.enabled) return null;
    return {
      timezone: day.timezone || tz,
      localDate: day.localDate,
      resources: day.resources,
      appointments: day.appointments,
      busy: day.busy,
      exceptions: day.exceptions,
    };
  }, [day, tz]);
  const dayStale = dayInput !== null && dayInput.localDate !== date;

  const grid = useMemo(
    () => (dayInput ? buildDayGridModel({ day: dayInput, internal, groupBy, now }) : null),
    [dayInput, internal, groupBy, now]
  );
  const groups = useMemo(
    () => (dayInput ? buildDayList({ day: dayInput, internal, groupBy, mode: listMode, now, withFree: access.canEdit }) : []),
    [dayInput, internal, groupBy, listMode, now, access.canEdit]
  );
  const summaries = useMemo(() => (grid ? summarizeResources(grid) : []), [grid]);
  const resourceCount = config?.resources.length;
  const cells = useMemo(
    () => buildMonthCells(monthArgs.fromLocalDate, monthArgs.toLocalDate, range?.enabled ? range : undefined, resourceCount),
    [monthArgs, range, resourceCount]
  );

  const pendingData = pending?.enabled ? (pending as PendingData) : undefined;
  const pendingTotals = pendingData
    ? pendingTotal(
        {
          approvals: pendingData.approvals.length,
          conflicts: pendingData.conflicts.length,
          noOutcome: pendingData.noOutcome.length,
          suggestions: pendingData.suggestions.length,
        },
        pendingData.capped
      )
    : null;

  // --- ações ---
  const setView = (next: typeof view) => viewState.set(next);
  const goToDay = (d: LocalDate) => viewState.set("dia", { also: { data: d === today ? null : d } });
  const openAppointment = useCallback((id: string) => apptState.set(id, { history: "push", preventScrollReset: true }), [apptState]);
  const closeAppointment = () => apptState.set(null, { history: "replace", preventScrollReset: true });
  const openConversation = (id: string) => navigate(`${TAB_ROUTES.inbox}?conversation=${id}`);

  const bookingDate = date < today ? today : date;
  const startBooking = (opts: { minute?: number; resource?: DayResource } = {}) =>
    setBooking({ stage: "pick", date: bookingDate, ...opts });
  const onColumnAction = (resource: DayResource, action: ColumnAction) => {
    if (action === "book") startBooking({ resource });
    // "closeToday", "closePeriod" e "reopen" ganham a folha de fechar na sequência deste PR.
  };
  const onInternalClick = (item: InternalItem) => {
    if (item.source === "task") setTaskId(item.id);
    else eventState.set(item.id, { history: "push" });
  };
  const newEvent = () => {
    const [y, m, d] = date.split("-").map(Number);
    setEventModal({ date: new Date(y, m - 1, d, 12) });
  };

  // --- estados especiais ---
  const noResources = config != null && config.enabled && config.resources.length === 0;
  const noServices = config != null && config.enabled && config.services.length === 0;
  const setupIncomplete = noResources || noServices;

  // Coluna do celular: a escolhida, ou a primeira.
  const columnKeys = grid?.columns.map((c) => c.key) ?? [];
  const activeColumn = mobileColumn && columnKeys.includes(mobileColumn) ? mobileColumn : (columnKeys[0] ?? null);

  const bookingContext = (b: Booking) => {
    const when = b.stage === "pick" && b.minute !== undefined ? `${shortDateLabel(b.date)} às ${minutesLabel(b.minute)}` : shortDateLabel(b.date);
    return b.resource ? `${when} em ${b.resource.name}` : when;
  };

  const periodText = periodLabel(date, view);
  const isToday = date === today;

  const renderDay = () => {
    if (!dayInput || !grid) return day && !day.enabled ? <EmptyState icon={Settings2} title={t.noModule.title} description={t.noModule.hint} /> : <ContentSkeleton />;
    if (noResources) return null;
    if (view === "lista") {
      return (
        <AgendaDayList
          groups={groups}
          summaries={summaries}
          tz={dayInput.timezone}
          mode={listMode}
          groupBy={groupBy}
          canBook={access.canEdit}
          canClose={access.canEdit}
          resources={dayInput.resources}
          onAppointmentClick={openAppointment}
          onInternalClick={onInternalClick}
          onFreeClick={(resourceId, minute) => startBooking({ minute, resource: dayInput.resources.find((r) => r._id === resourceId) })}
          onResourceAction={onColumnAction}
          onBook={() => startBooking()}
        />
      );
    }
    if (grid.columns.filter((c) => c.kind === "resource").length === 0) {
      const other = group === "sala" ? "profissional" : "sala";
      return (
        <EmptyState
          icon={Settings2}
          size="sm"
          title={t.noColumns[groupBy].title}
          description={t.noColumns[groupBy].hint}
          action={{ label: t.noColumns.switchTo[groupBy], onClick: () => groupState.set(other) }}
        />
      );
    }
    return (
      <div className="space-y-3">
        {isMobile && grid.columns.length > 1 && (
          <FilterChips
            ariaLabel={t.groupLabel}
            chips={grid.columns.map((c) => ({ id: c.key, label: c.label, pressed: c.key === activeColumn }))}
            onToggle={setMobileColumn}
          />
        )}
        {grid.allDay.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label={t.grid.allDay}>
            {grid.allDay.map((e) => (
              <li key={`allday:${e.id}`}>
                <button
                  type="button"
                  onClick={() => onInternalClick(e)}
                  className="min-h-11 rounded-full border border-dashed border-ai-500 bg-ai-500/10 px-3 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {e.title}
                </button>
              </li>
            ))}
          </ul>
        )}
        {grid.noPlace.length > 0 && (
          <section aria-label={t.grid.noPlace} className="rounded-card border border-semantic-warning/40 bg-semantic-warning/10 p-3">
            <h2 className="text-sm font-semibold text-text-primary">{t.grid.noPlace}</h2>
            <p className="text-caption text-text-secondary">{t.grid.noPlaceHint}</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {grid.noPlace.map((a) => (
                <li key={`noplace:${a._id}`}>
                  <Button size="sm" variant="secondary" onClick={() => openAppointment(a._id)}>
                    {t.grid.resolve}: {a.contactName ?? a.guestName ?? a.serviceName}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {grid.empty && !setupIncomplete && <p className="px-1 text-sm text-text-secondary">{t.list.empty.hint}</p>}
        <Suspense fallback={<ContentSkeleton />}>
          <ResourceDayGrid
            model={grid}
            tz={dayInput.timezone}
            groupLabel={t.groups[group].toLowerCase()}
            canBook={access.canEdit}
            canClose={access.canEdit}
            visibleKeys={isMobile && activeColumn ? [activeColumn] : undefined}
            onSlotClick={(resource, minute) => startBooking({ resource: resource ?? undefined, minute })}
            onAppointmentClick={openAppointment}
            onInternalClick={onInternalClick}
            onColumnAction={onColumnAction}
          />
        </Suspense>
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 p-3 pb-24 md:p-6 md:pb-6">
      <AgendaHeader
        view={view}
        onViewChange={setView}
        group={group}
        onGroupChange={(g) => groupState.set(g)}
        listMode={listMode}
        onListModeChange={(m) => listState.set(m)}
        dateLabel={periodText}
        isToday={isToday}
        onPrev={() => dateState.set(shiftDate(date, view, -1))}
        onNext={() => dateState.set(shiftDate(date, view, 1))}
        onToday={() => dateState.set(null)}
        canBook={access.canEdit && !setupIncomplete}
        onBook={() => startBooking()}
        canCreateEvent={access.canEdit}
        onNewEvent={newEvent}
        pendingLabel={pendingTotals ? pendingBadgeLabel(pendingTotals) : null}
        pendingTotal={pendingTotals?.total ?? 0}
        onOpenPending={() => pendingState.set(true, { history: "push", preventScrollReset: true })}
      />

      {setupIncomplete && (
        <section className="rounded-card border border-border bg-surface-raised p-4">
          {noResources ? (
            <EmptyState
              icon={Settings2}
              size="sm"
              title={t.setup.title}
              description={access.canManage ? t.setup.hint : t.setup.noAccess}
              action={access.canManage ? { label: t.setup.cta, onClick: () => setWizardOpen(true) } : undefined}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-text-secondary">{t.setup.compact}</p>
              {access.canManage && (
                <Button size="sm" variant="secondary" onClick={() => setWizardOpen(true)}>
                  {t.setup.cta}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      <div aria-busy={dayStale} className={dayStale ? "opacity-60 transition-opacity" : undefined}>
        {view === "mes" ? (
          <Suspense fallback={<ContentSkeleton />}>
            <AgendaMonthView
              cells={cells}
              today={today}
              selected={date}
              loading={rawRange === undefined}
              partialFrom={range?.enabled && range.capped ? { through: range.completeThrough } : null}
              onPickDay={goToDay}
            />
          </Suspense>
        ) : (
          renderDay()
        )}
      </div>

      {access.canEdit && !setupIncomplete && (
        <button
          type="button"
          onClick={() => startBooking()}
          aria-label={VOCAB.scheduling.book}
          className="fixed bottom-20 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-elevated transition-all hover:bg-brand-700 active:scale-95 md:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
        >
          <Plus size={24} aria-hidden="true" />
        </button>
      )}

      {/* Escolha de cliente e folha de marcar horário. */}
      {booking?.stage === "pick" && (
        <Suspense fallback={null}>
          <ClientPickerSheet
            organizationId={organizationId}
            open
            context={bookingContext(booking)}
            onClose={() => setBooking(null)}
            onPick={(who) => setBooking({ stage: "sheet", date: booking.date, resource: booking.resource, who })}
          />
        </Suspense>
      )}
      {booking?.stage === "sheet" && (
        <Suspense fallback={null}>
          <BookingSheet
            organizationId={organizationId}
            open
            onClose={() => setBooking(null)}
            onDone={() => setBooking(null)}
            who={{ contactId: booking.who.contactId as Id<"contacts">, name: booking.who.name }}
            initialDate={booking.date}
            initialPinned={booking.resource ? { [booking.resource.kind]: booking.resource._id } : undefined}
            onOpenAppointment={(id) => {
              setBooking(null);
              openAppointment(id);
            }}
          />
        </Suspense>
      )}

      {apptState.value && (
        <Suspense fallback={null}>
          <AppointmentDetailPanel
            organizationId={organizationId}
            appointmentId={apptState.value as Id<"schedAppointments">}
            onClose={closeAppointment}
            onOpenConversation={(id) => openConversation(id)}
          />
        </Suspense>
      )}

      {pendingState.value && (
        <Suspense fallback={null}>
          <PendingQueuePanel
            organizationId={organizationId}
            open
            onClose={() => pendingState.set(false, { history: "replace", preventScrollReset: true })}
            data={pendingData}
            tz={tz}
            now={hourNow}
            canEdit={access.canEdit}
            onOpenAppointment={openAppointment}
            onResolveConflict={(_conflictId, appointmentId) => appointmentId && openAppointment(appointmentId)}
            onOpenConversation={openConversation}
          />
        </Suspense>
      )}

      {wizardOpen && (
        <Suspense fallback={null}>
          <AgendaSetupWizard organizationId={organizationId} open onClose={() => setWizardOpen(false)} />
        </Suspense>
      )}

      {/* Compromissos internos e tarefas: os mesmos componentes da página de hoje. */}
      <CalendarEventModal
        open={eventModal !== null}
        onClose={() => setEventModal(null)}
        organizationId={organizationId}
        eventId={eventModal?.eventId}
        initialDate={eventModal?.date}
      />
      {eventState.value && (
        <ErrorBoundary key={eventState.value} fallback={<ClearParam onClear={() => eventState.set(null, { preventScrollReset: true })} />}>
          <EventDetailSlideOver
            open
            onClose={() => eventState.set(null, { preventScrollReset: true })}
            eventId={eventState.value}
            onEdit={(eventId) => setEventModal({ eventId, date: new Date() })}
          />
        </ErrorBoundary>
      )}
      {taskId && <TaskQuickView open onClose={() => setTaskId(null)} taskId={taskId} />}

    </div>
  );
}
