import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router";
import { useQuery } from "convex/react";
import { Plus, Settings2, TriangleAlert } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { CalendarPage } from "@/components/calendar/CalendarPage";
import { CalendarEventModal } from "@/components/calendar/CalendarEventModal";
import { EventDetailSlideOver } from "@/components/calendar/EventDetailSlideOver";
import { TaskQuickView } from "@/components/calendar/TaskQuickView";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterChips } from "@/components/ui/FilterChips";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { useRoundedNow } from "@/components/agenda/booking/useRoundedNow";
import { usePermissions } from "@/hooks/usePermissions";
import { agendaAccess } from "@/lib/agendaAccess";
import { useKeepPrevious } from "@/hooks/useKeepPrevious";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import { buildDayList, summarizeResources } from "@/lib/agendaDayList";
import {
  buildDayGridModel,
  filterInternalForDay,
  internalCountsByDay,
  nextHalfHour,
  toInternalItems,
  type DayInput,
  type DayResource,
  type InternalItem,
} from "@/lib/agendaGrid";
import { buildMonthCells } from "@/lib/agendaMonth";
import { pendingBadgeLabel, pendingTotal } from "@/lib/agendaPending";
import { fillVocab } from "@/lib/agendaCopy";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import {
  dateKeyParam,
  defaultView,
  groupByOf,
  groupParam,
  groupParamOf,
  idParam,
  listModeParam,
  migrateLegacyParams,
  monthRange,
  periodLabel,
  shiftDate,
  viewParam,
  type GroupParam,
} from "@/lib/agendaViewParams";
import { shortDateLabel, zonedDayBounds, zonedToday, type LocalDate } from "@/lib/agendaZone";
import { TAB_ROUTES } from "@/lib/routes";
import { booleanParam } from "@/lib/searchParamState";
import { VOCAB } from "@/lib/vocab";
import { AgendaHeader } from "./AgendaHeader";
import { AgendaDayList } from "./AgendaDayList";
import type { ColumnAction } from "./ResourceDayGrid";
import type { PendingConflict, PendingData } from "./PendingQueueView";
import type { ClosureTarget } from "./ResourceDaySheet";
import { isManualNoPlace } from "@/lib/agendaConflict";
import { bookingContextParts, bookingSheetExtraProps } from "@/lib/agendaBooking";
import type { PickedClient } from "./ClientPickerSheet";

const t = VIEWS_COPY;

// Pedaços pesados ou raros: só baixam quando a visão ou a folha aparece.
const ResourceDayGrid = lazy(() => import("./ResourceDayGrid").then((m) => ({ default: m.ResourceDayGrid })));
const AgendaMonthView = lazy(() => import("./AgendaMonthView").then((m) => ({ default: m.AgendaMonthView })));
const PendingQueuePanel = lazy(() => import("./PendingQueuePanel").then((m) => ({ default: m.PendingQueuePanel })));
const ClientPickerSheet = lazy(() => import("./ClientPickerSheet").then((m) => ({ default: m.ClientPickerSheet })));
const ResourceDaySheet = lazy(() => import("./ResourceDaySheet").then((m) => ({ default: m.ResourceDaySheet })));
const ConflictResolverSheet = lazy(() => import("./ConflictResolverSheet").then((m) => ({ default: m.ConflictResolverSheet })));
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
  | { stage: "sheet"; date: LocalDate; minute?: number; resource?: DayResource; who: PickedClient };

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
 * `AgendaMonthView`, `PendingQueueView`). Compromissos e tarefas entram junto, em estilo próprio, filtrados UMA vez
 * pelo dia da org; a visão Semana é a `CalendarPage` de hoje por inteira (filtros, arrastar, criar com hora).
 */
export function AgendaPageView() {
  usePageTitle(VOCAB.agenda.title);
  const navigate = useNavigate();
  const { organizationId } = useOutletContext<AppOutletContext>();
  const tz = useOrgTimezone(organizationId);
  // O mesmo que `useAgendaAccess` (dois passos); não o importa porque isso o separava num chunk compartilhado com o painel.
  const perms = usePermissions(organizationId);
  const access = { ...agendaAccess(perms.can), isLoading: perms.isLoading };
  const isMobile = useMediaQuery("(max-width: 767px)");
  const now = useRoundedNow("minute");
  const hourNow = useRoundedNow("hour");
  const today = zonedToday(now, tz);
  const [searchParams, setSearchParams] = useSearchParams();

  // --- URL ---
  const viewState = useSearchParamState("visao", viewParam);
  const dateState = useSearchParamState("data", dateKeyParam);
  const groupState = useSearchParamState("por", groupParam);
  const listState = useSearchParamState("lista", listModeParam);
  const apptState = useSearchParamState("appt", idParam, { history: "push" });
  const pendingState = useSearchParamState("pendencias", booleanParam, { history: "push" });
  const eventState = useSearchParamState("event", idParam, { history: "push" });

  // Parâmetros antigos (`?date=`, `?view=`) viram os novos uma vez (replace).
  useEffect(() => {
    const writes = migrateLegacyParams(searchParams);
    if (!writes) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(writes)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true }
    );
  }, [searchParams, setSearchParams]);

  const view = viewState.value ?? defaultView(isMobile);
  const date = dateState.value ?? today;
  const group: GroupParam = groupState.value;
  const groupBy = groupByOf(group);
  const listMode = listState.value;
  const week = view === "semana";
  const isToday = date === today;
  const isPast = date < today;

  // --- estado local ---
  const [booking, setBooking] = useState<Booking | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [eventModal, setEventModal] = useState<{ eventId?: string; date: Date; hour?: number; minute?: number } | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [mobileColumn, setMobileColumn] = useState<string | null>(null);
  const [closure, setClosure] = useState<ClosureTarget | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<PendingConflict | null>(null);

  // --- dados ---
  const canQuery = access.canView && !week;
  const config = useQuery(api.schedulingConfig.getConfig, access.canView ? { organizationId, closuresFrom: today } : "skip");
  const rawDay = useQuery(api.scheduling.listAgendaDay, canQuery && view !== "mes" ? { organizationId, localDate: date } : "skip");
  const day = useKeepPrevious(rawDay, organizationId);
  const monthArgs = useMemo(() => {
    const { from, to } = monthRange(date);
    return { organizationId, fromLocalDate: from, toLocalDate: to };
  }, [organizationId, date]);
  const rawRange = useQuery(api.scheduling.listAgendaRange, canQuery && view === "mes" ? monthArgs : "skip");
  const range = useKeepPrevious(rawRange, organizationId);
  const pending = useQuery(api.scheduling.listPending, access.canView ? { organizationId, now: hourNow } : "skip");

  const eventArgs = useMemo(() => {
    // Como na página de compromissos: recua um dia para trazer o que começou ontem e cruza a meia-noite
    // (o recorte pelo dia da org é feito depois, uma vez só, em `filterInternalForDay`).
    const { from, to } = view === "mes" ? { from: monthArgs.fromLocalDate, to: monthArgs.toLocalDate } : { from: date, to: date };
    return { organizationId, startDate: zonedDayBounds(from, tz).start - DAY_MS, endDate: zonedDayBounds(to, tz).end, includeTasks: true };
  }, [organizationId, date, tz, view, monthArgs]);
  const rawEvents = useQuery(api.calendar.getEvents, canQuery ? eventArgs : "skip");
  const events = useKeepPrevious(rawEvents, organizationId);
  const allInternal = useMemo(() => toInternalItems(events), [events]);

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
  const shownDate = dayInput?.localDate ?? date;
  // Filtro pelo dia: UMA vez aqui; a mesma lista vai para a grade, a lista e os chips "Dia inteiro".
  const internal = useMemo(() => filterInternalForDay(allInternal, shownDate, tz), [allInternal, shownDate, tz]);
  const internalCounts = useMemo(
    () => (view === "mes" ? internalCountsByDay(allInternal, monthArgs.fromLocalDate, monthArgs.toLocalDate, tz) : {}),
    [view, allInternal, monthArgs, tz]
  );

  const grid = useMemo(() => (dayInput ? buildDayGridModel({ day: dayInput, internal, groupBy, now }) : null), [dayInput, internal, groupBy, now]);
  const hasColumns = !!grid && grid.columns.some((c) => c.kind === "resource");
  const groups = useMemo(
    () =>
      dayInput
        ? buildDayList({ day: dayInput, internal, groupBy, mode: hasColumns ? listMode : "hora", now, withFree: access.canEdit && !isPast })
        : [],
    [dayInput, internal, groupBy, listMode, hasColumns, now, access.canEdit, isPast]
  );
  const summaries = useMemo(() => (grid ? summarizeResources(grid) : []), [grid]);
  const activeResources = useMemo(() => (config?.resources ?? []).filter((r) => r.active), [config]);
  const activeServices = useMemo(() => (config?.services ?? []).filter((s) => s.active), [config]);
  const cells = useMemo(
    () => buildMonthCells(monthArgs.fromLocalDate, monthArgs.toLocalDate, range?.enabled ? range : undefined, config ? activeResources.length : undefined),
    [monthArgs, range, config, activeResources]
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
  const changeView = (next: typeof view) => {
    if (next === view) return;
    if (next === "semana") {
      // A `CalendarPage` lê `?date=` e `?view=` dela.
      viewState.set("semana", { also: { view: null, date: isToday ? null : date } });
    } else if (week) {
      const cal = dateKeyParam.parse(searchParams.get("date"));
      viewState.set(next, { also: { view: null, date: null, data: cal && cal !== today ? cal : null } });
    } else viewState.set(next);
  };
  const goToDay = (d: LocalDate) => viewState.set("dia", { also: { data: d === today ? null : d } });
  const openAppointment = useCallback((id: string) => apptState.set(id, { history: "push", preventScrollReset: true }), [apptState]);
  const closeAppointment = () => apptState.set(null, { history: "replace", preventScrollReset: true });
  const openConversation = (id: string) => navigate(`${TAB_ROUTES.inbox}?conversation=${id}`);
  const closeEvent = () => eventState.set(null, { history: "replace", preventScrollReset: true });

  const bookingDate = isPast ? today : date;
  const startBooking = (opts: { minute?: number; resource?: DayResource } = {}) => setBooking({ stage: "pick", date: bookingDate, ...opts });
  const onColumnAction = (resource: DayResource, action: ColumnAction) => {
    if (action === "book") startBooking({ resource });
    else {
      setClosure({
        resourceId: resource._id,
        name: resource.name,
        kind: resource.kind,
        mode: action === "reopen" || action === "reopenPeriod" ? "reopen" : "close",
        period: action === "closePeriod" || action === "reopenPeriod",
      });
    }
  };
  const resolving = pendingData?.conflicts.find((c) => c._id === resolvingId);
  const onInternalClick = (item: InternalItem) => {
    if (item.source === "task") setTaskId(item.id);
    else eventState.set(item.id, { history: "push" });
  };
  const newEvent = () => {
    const [y, m, d] = date.split("-").map(Number);
    const { hour, minute } = nextHalfHour(now, tz);
    setEventModal({ date: new Date(y, m - 1, d, hour, minute), hour, minute });
  };

  // --- estados especiais ---
  const noResources = config != null && config.enabled && activeResources.length === 0;
  const noServices = config != null && config.enabled && activeServices.length === 0;
  const setupIncomplete = noResources || noServices;
  const canBookDay = access.canEdit && !isPast && !setupIncomplete;

  // Coluna do celular: a escolhida, ou a primeira.
  const columnKeys = grid?.columns.map((c) => c.key) ?? [];
  const activeColumn = mobileColumn && columnKeys.includes(mobileColumn) ? mobileColumn : (columnKeys[0] ?? null);

  const bookingContext = (b: Booking) => bookingContextParts(shortDateLabel(b.date), b.resource?.name);
  const periodText = periodLabel(date, view);

  const renderDay = () => {
    if (!dayInput || !grid) {
      return day && !day.enabled ? <EmptyState icon={Settings2} title={t.noModule.title} description={t.noModule.hint} /> : <ContentSkeleton />;
    }
    const listProps = {
      groups,
      summaries,
      tz: dayInput.timezone,
      mode: hasColumns ? listMode : ("hora" as const),
      groupBy,
      canBook: canBookDay,
      canClose: access.canEdit,
      isToday,
      resources: dayInput.resources,
      onAppointmentClick: openAppointment,
      onInternalClick,
      onFreeClick: (resourceId: string, minute: number) =>
        startBooking({ minute, resource: dayInput.resources.find((r) => r._id === resourceId) }),
      onResourceAction: onColumnAction,
      onBook: () => startBooking(),
    };
    if (view === "lista" || !hasColumns) {
      // Sem recurso do tipo agrupado (agenda recém-ligada, por exemplo): os compromissos e tarefas aparecem do mesmo jeito.
      const hasOtherKind = !hasColumns && dayInput.resources.length > 0;
      const other = group === "sala" ? "profissional" : "sala";
      return (
        <div className="space-y-3">
          {view !== "lista" && hasOtherKind && (
            <EmptyState
              icon={Settings2}
              size="sm"
              title={t.noColumns[groupBy].title}
              description={t.noColumns[groupBy].hint}
              action={{ label: t.noColumns.switchTo[groupBy], onClick: () => groupState.set(other) }}
            />
          )}
          <AgendaDayList {...listProps} />
        </div>
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
                    {isManualNoPlace(a) ? t.conflict.undefinedPlace[group] : t.grid.resolve}: {a.contactName ?? a.guestName ?? a.serviceName}
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
            canBook={canBookDay}
            canClose={access.canEdit}
            isToday={isToday}
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

  const header = (
    <AgendaHeader
      view={view}
      onViewChange={changeView}
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
      canManage={access.canManage}
      onCloseAll={() => setClosure({ resourceId: null, name: t.closure.orgName, kind: null, mode: "close", period: true })}
      onReopenAll={() => setClosure({ resourceId: null, name: t.closure.orgName, kind: null, mode: "reopen", period: true })}
      pendingLabel={pendingTotals ? pendingBadgeLabel(pendingTotals) : null}
      pendingTotal={pendingTotals?.total ?? 0}
      onOpenPending={() => pendingState.set(true, { history: "push", preventScrollReset: true })}
    />
  );

  // Folhas e painéis comuns a todas as visões.
  const overlays = (
    <>
      {booking?.stage === "pick" && (
        <Suspense fallback={null}>
          <ClientPickerSheet
            organizationId={organizationId}
            open
            context={bookingContext(booking)}
            onClose={() => setBooking(null)}
            onPick={(who) => setBooking({ stage: "sheet", date: booking.date, minute: booking.minute, resource: booking.resource, who })}
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
            {...bookingSheetExtraProps(booking.minute)}
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
            now={now}
            canEdit={access.canEdit}
            onOpenAppointment={openAppointment}
            onResolveConflict={(conflictId, appointmentId) => {
              if (appointmentId) setResolvingId(conflictId);
            }}
            onOpenConversation={openConversation}
          />
        </Suspense>
      )}

      {closure && (
        <Suspense fallback={null}>
          <ResourceDaySheet
            organizationId={organizationId}
            target={closure}
            tz={tz}
            date={date}
            today={today}
            onClose={() => setClosure(null)}
            onOpenPending={() => pendingState.set(true, { history: "push", preventScrollReset: true })}
          />
        </Suspense>
      )}

      {resolving?.appointment && (
        <Suspense fallback={null}>
          <ConflictResolverSheet
            organizationId={organizationId}
            conflict={{ ...resolving, appointment: resolving.appointment }}
            resources={config?.resources ?? []}
            tz={tz}
            onClose={() => setResolvingId(null)}
            onReschedule={(c) => {
              setResolvingId(null);
              setRescheduling(c);
            }}
          />
        </Suspense>
      )}
      {rescheduling?.appointment?.serviceId && (
        <Suspense fallback={null}>
          <BookingSheet
            organizationId={organizationId}
            open
            onClose={() => setRescheduling(null)}
            onDone={() => setRescheduling(null)}
            who={{}}
            reschedule={{
              appointmentId: rescheduling.appointment._id,
              serviceId: rescheduling.appointment.serviceId,
              variantKey: rescheduling.appointment.variantKey,
              startTime: rescheduling.appointment.startTime,
            }}
          />
        </Suspense>
      )}

      {wizardOpen && (
        <Suspense fallback={null}>
          <AgendaSetupWizard organizationId={organizationId} open onClose={() => setWizardOpen(false)} />
        </Suspense>
      )}
    </>
  );

  if (!access.isLoading && !access.canView) {
    return (
      <div className="mx-auto w-full max-w-[1600px] p-3 md:p-6">
        <EmptyState icon={Settings2} title={t.noAccess.title} description={t.noAccess.hint} />
      </div>
    );
  }

  if (week) {
    // Visão Semana: a `CalendarPage` de hoje por inteira. Ela mostra só compromissos e tarefas da equipe.
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="space-y-3 p-3 md:px-6 md:pt-4">
          {header}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary">
            <span>
              <span className="font-medium text-text-primary">{t.week.title}.</span> {t.week.hint}
            </span>
            <Button size="sm" variant="ghost" onClick={() => changeView("dia")}>
              {t.week.back}
            </Button>
          </p>
        </div>
        <div className="min-h-0 flex-1">
          <CalendarPage />
        </div>
        {overlays}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-4 p-3 pb-28 md:p-6 md:pb-6">
      {header}

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

      {day?.enabled && day.capped && view !== "mes" && (
        <p role="status" className="flex items-start gap-2 rounded-card border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2 text-sm text-text-primary">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
          {t.capped}
        </p>
      )}

      <div aria-busy={dayStale} className={dayStale ? "opacity-60 transition-opacity" : undefined}>
        {view === "mes" ? (
          <Suspense fallback={<ContentSkeleton />}>
            <AgendaMonthView
              cells={cells}
              today={today}
              selected={date}
              loading={rawRange === undefined}
              internalCounts={internalCounts}
              partialFrom={range?.enabled && range.capped ? { through: range.completeThrough } : null}
              onPickDay={goToDay}
            />
          </Suspense>
        ) : (
          renderDay()
        )}
      </div>

      {canBookDay && (
        <button
          type="button"
          onClick={() => startBooking()}
          aria-label={VOCAB.scheduling.book}
          style={{ bottom: "calc(5rem + env(safe-area-inset-bottom))" }}
          className="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-elevated transition-all hover:bg-brand-700 active:scale-95 md:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
        >
          <Plus size={24} aria-hidden="true" />
        </button>
      )}

      {overlays}

      {/* Compromissos internos e tarefas: os mesmos componentes da página de hoje. */}
      <CalendarEventModal
        open={eventModal !== null}
        onClose={() => setEventModal(null)}
        organizationId={organizationId}
        eventId={eventModal?.eventId}
        initialDate={eventModal?.date}
        initialHour={eventModal?.hour}
        initialMinute={eventModal?.minute}
      />
      {eventState.value && (
        <ErrorBoundary key={eventState.value} fallback={<ClearParam onClear={closeEvent} />}>
          <EventDetailSlideOver
            open
            onClose={closeEvent}
            eventId={eventState.value}
            onEdit={(eventId) => setEventModal({ eventId, date: new Date() })}
          />
        </ErrorBoundary>
      )}
      {taskId && <TaskQuickView open onClose={() => setTaskId(null)} taskId={taskId} />}
    </div>
  );
}
