import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { Plus, Settings2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
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
  nextHalfHour,
  toInternalItems,
  type DayInput,
  type DayResource,
  type InternalItem,
} from "@/lib/agendaGrid";
import { isExpiredProposal } from "@/lib/agendaStatus";
import { buildMonthCells } from "@/lib/agendaMonth";
import { closedResourcesByDay, mergeClosedDays, syntheticRange } from "@/lib/agendaClosedDays";
import { UNDO_TARGETS, type SchedStatus } from "../../../../convex/lib/schedStatus";
import { buildMonthGrid, buildMonthLines, monthGridDates } from "@/lib/agendaMonthLines";
import { pendingBadgeLabel, pendingTotal } from "@/lib/agendaPending";
import { DENSITY_HOUR_PX, readPrefs, writePrefs, type AgendaPrefs, type Density } from "@/lib/agendaPrefs";
import type { ColorScheme, ToneContext } from "@/lib/agendaColors";
import { buildWeekModel, LANES_DESKTOP, LANES_MOBILE, movedEventStart, type WeekResource } from "@/lib/agendaWeekGrid";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import {
  dateKeyParam,
  defaultView,
  groupByOf,
  groupParam,
  idParam,
  listModeParam,
  migrateLegacyParams,
  monthRange,
  periodLabel,
  shiftDate,
  viewParam,
  type AgendaView,
  type GroupParam,
} from "@/lib/agendaViewParams";
import { shortDateLabel, weekDateKeys, zonedDayBounds, zonedToday, type LocalDate } from "@/lib/agendaZone";
import { mutationErrorMessage } from "@/lib/errors";
import { TAB_ROUTES } from "@/lib/routes";
import { booleanParam } from "@/lib/searchParamState";
import { VOCAB } from "@/lib/vocab";
import { AgendaToolbar, type WeekFilterOption } from "./AgendaToolbar";
import { AgendaColorLegend } from "./AgendaColorLegend";
import { AgendaDayList } from "./AgendaDayList";
import type { QuickActions } from "./AgendaBlocks";
import type { ColumnAction } from "./ResourceDayGrid";
import type { PendingAppointment, PendingConflict, PendingData } from "./PendingQueueView";
import type { ClosureTarget } from "./ResourceDaySheet";
import { QuickContactPhone } from "./QuickContactPhone";
import { useRangeAppointments } from "./useRangeAppointments";
import { useFillHeight } from "./useFillHeight";
import { shortcutBlocked } from "@/lib/agendaShortcuts";
import { isManualNoPlace, noPlaceTarget } from "@/lib/agendaConflict";
import { bookingContextParts, bookingSheetExtraProps, rebookTarget } from "@/lib/agendaBooking";
import type { PickedClient } from "./ClientPickerSheet";

const t = VIEWS_COPY;

// Pedaços pesados ou raros: só baixam quando a visão ou a folha aparece.
const ResourceDayGrid = lazy(() => import("./ResourceDayGrid").then((m) => ({ default: m.ResourceDayGrid })));
const AgendaWeekView = lazy(() => import("./AgendaWeekView").then((m) => ({ default: m.AgendaWeekView })));
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
 * `AgendaWeekView`, `AgendaMonthView`, `PendingQueueView`). Compromissos e tarefas entram junto, em estilo próprio, filtrados
 * UMA vez pelo dia da org. Semana e Mês leem o intervalo inteiro com uma leitura por página (nunca uma por bloco). A página
 * ocupa a altura da tela: barra única no topo e só a grade rola. Visão, agrupamento, cores e densidade ficam lembrados.
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
  // A altura vem da posição real na tela (aviso de plano ou termos no topo empurra a página; a grade encolhe).
  const pageRef = useRef<HTMLDivElement>(null);
  const fillH = useFillHeight(pageRef, isMobile ? 80 : 0);

  // --- preferências deste aparelho (visão, agrupamento, cores, densidade, filtro da Semana) ---
  const [prefs, setPrefs] = useState<AgendaPrefs>(() => readPrefs(organizationId));
  const savePref = useCallback(
    (patch: Parameters<typeof writePrefs>[1]) => setPrefs(writePrefs(organizationId, patch)),
    [organizationId]
  );
  const color: ColorScheme = prefs.color ?? "status";
  const density: Density = prefs.density ?? "padrao";
  const hourPx = DENSITY_HOUR_PX[density];

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

  const view: AgendaView = viewState.value ?? prefs.view ?? defaultView(isMobile);
  const date = dateState.value ?? today;
  const group: GroupParam = searchParams.has("por") ? groupState.value : (prefs.group ?? "sala");
  const groupBy = groupByOf(group);
  const listMode = listState.value;
  const week = view === "semana";
  const month = view === "mes";
  const rangeView = week || month;
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
  const [rebooking, setRebooking] = useState<NonNullable<ReturnType<typeof rebookTarget>> | null>(null);

  // --- período visível ---
  const weekDates = useMemo(() => weekDateKeys(date), [date]);
  const monthDates = useMemo(() => monthGridDates(date), [date]);
  const monthArgs = useMemo(() => {
    const { from, to } = monthRange(date);
    return { organizationId, fromLocalDate: from, toLocalDate: to };
  }, [organizationId, date]);
  /** Dias cobertos pelas leituras de Semana e Mês (Mês: semanas inteiras, com os dias vizinhos). */
  const span = useMemo(() => {
    if (week) return { from: weekDates[0], to: weekDates[6] };
    // Mês: semanas inteiras, com os dias vizinhos esmaecidos (a leitura é só dos status da grade, então o teto aguenta).
    if (month) return { from: monthDates[0], to: monthDates[monthDates.length - 1] };
    return { from: date, to: date };
  }, [week, month, weekDates, monthDates, date]);

  // --- dados ---
  const canQuery = access.canView;
  const config = useQuery(api.schedulingConfig.getConfig, access.canView ? { organizationId, closuresFrom: today } : "skip");
  const rawDay = useQuery(api.scheduling.listAgendaDay, canQuery && !rangeView ? { organizationId, localDate: date } : "skip");
  const day = useKeepPrevious(rawDay, organizationId);
  const rangeAppts = useRangeAppointments(organizationId, span.from, span.to, canQuery && rangeView);
  // `listAgendaRange` só quando a leitura do mês foi cortada (precisa da contagem do servidor para o "+N"); fechamentos
  // de hoje em diante vêm de `getConfig`, e o resto da contagem sai do que já foi lido.
  const needRange = month && !!rangeAppts.data?.truncated;
  const rawRange = useQuery(api.scheduling.listAgendaRange, canQuery && needRange ? monthArgs : "skip");
  const range = useKeepPrevious(rawRange, organizationId);
  const pending = useQuery(api.scheduling.listPending, access.canView ? { organizationId, now: hourNow } : "skip");

  const eventArgs = useMemo(() => {
    // Como na página de compromissos: recua um dia para trazer o que começou ontem e cruza a meia-noite
    // (o recorte pelo dia da org é feito depois, uma vez só, em `filterInternalForDay`).
    return { organizationId, startDate: zonedDayBounds(span.from, tz).start - DAY_MS, endDate: zonedDayBounds(span.to, tz).end, includeTasks: true };
  }, [organizationId, tz, span]);
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

  const grid = useMemo(() => (dayInput ? buildDayGridModel({ day: dayInput, internal, groupBy, now, fullDay: true }) : null), [dayInput, internal, groupBy, now]);
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
  const apptsInRange = rangeAppts.data?.appointments;
  // Cadeado de dia fechado: o servidor diz (passado inclusive, reabertura parcial descontada); até chegar, a aproximação
  // de `getConfig.closures` (hoje em diante, só `closed`).
  const closedArgs = useMemo(() => {
    const dates = week ? weekDates : monthDates;
    return { organizationId, fromLocalDate: dates[0], toLocalDate: dates[dates.length - 1] };
  }, [week, weekDates, monthDates, organizationId]);
  const closedDates = week ? weekDates : monthDates;
  // Só a resposta do intervalo ATUAL vale (nunca a anterior, que esconderia o cadeado ao trocar de semana).
  const serverClosed = useQuery(api.scheduling.listClosedDays, canQuery && rangeView ? closedArgs : "skip");
  const closedByDay = useMemo(
    () =>
      mergeClosedDays(
        closedDates,
        serverClosed?.enabled ? serverClosed : undefined,
        closedResourcesByDay(config?.closures ?? [], activeResources, closedDates.filter((d) => d >= today))
      ),
    [closedDates, today, config, activeResources, serverClosed]
  );
  const monthRangeData = useMemo(() => {
    if (!month) return undefined;
    if (range?.enabled && rangeAppts.data?.truncated) return range;
    const days = monthDates.filter((d) => d >= monthArgs.fromLocalDate && d <= monthArgs.toLocalDate);
    return syntheticRange(days, apptsInRange ?? [], closedByDay);
  }, [month, range, rangeAppts.data?.truncated, monthDates, monthArgs, apptsInRange, closedByDay]);
  const cells = useMemo(
    () => buildMonthCells(monthArgs.fromLocalDate, monthArgs.toLocalDate, monthRangeData, config ? activeResources.length : undefined),
    [monthArgs, monthRangeData, config, activeResources]
  );

  // Cores: a ordem da configuração fixa a cor de cada sala, profissional e serviço.
  const tone: ToneContext = useMemo(
    () => ({ scheme: color, resourceOrder: activeResources.map((r) => r._id as string), serviceOrder: activeServices.map((s) => s._id as string) }),
    [color, activeResources, activeServices]
  );

  // Semana: filtro por sala/profissional (lembrado), modelo de 7 colunas e fechamentos por dia.
  const weekFilterOptions: WeekFilterOption[] = useMemo(
    () => activeResources.map((r) => ({ id: r._id as string, label: r.name, kind: r.kind })),
    [activeResources]
  );
  const weekFilter = prefs.resource && weekFilterOptions.some((o) => o.id === prefs.resource) ? prefs.resource : null;
  const weekModel = useMemo(
    () =>
      week
        ? buildWeekModel({
            dates: weekDates,
            tz,
            now,
            appointments: apptsInRange ?? [],
            internal: allInternal,
            resources: activeResources as unknown as WeekResource[],
            filterResourceId: weekFilter,
            maxLanes: isMobile ? LANES_MOBILE : LANES_DESKTOP,
          })
        : null,
    [week, weekDates, tz, now, apptsInRange, allInternal, activeResources, weekFilter, isMobile]
  );
  // Mês: linhas por dia (uma leitura por intervalo) completadas pela contagem do servidor quando cortou.
  const monthWeeks = useMemo(() => {
    if (!month) return [];
    const lines = buildMonthLines({ dates: monthDates, tz, appointments: apptsInRange ?? [], internal: allInternal });
    const loadedThrough = (apptsInRange ?? []).reduce<string | null>((m, a) => (m === null || a.localDate > m ? a.localDate : m), null);
    return buildMonthGrid({ date, cells, lines, truncated: !!rangeAppts.data?.truncated, loadedThrough });
  }, [month, monthDates, tz, apptsInRange, allInternal, date, cells, rangeAppts.data?.truncated]);

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
  const changeView = (next: AgendaView) => {
    if (next === view) return;
    viewState.set(next);
    savePref({ view: next });
  };
  const changeGroup = (g: GroupParam) => {
    groupState.set(g);
    savePref({ group: g });
  };
  const goToDay = (d: LocalDate) => {
    viewState.set("dia", { also: { data: d === today ? null : d } });
    savePref({ view: "dia" });
  };
  const openAppointment = useCallback((id: string) => apptState.set(id, { history: "push", preventScrollReset: true }), [apptState]);
  const closeAppointment = () => apptState.set(null, { history: "replace", preventScrollReset: true });
  const openConversation = (id: string) => navigate(`${TAB_ROUTES.inbox}?conversation=${id}`);
  const closeEvent = () => eventState.set(null, { history: "replace", preventScrollReset: true });

  // Ações rápidas do cartão do passar do mouse (Confirmar, Chegou): a mesma mutation do painel.
  const setStatus = useMutation(api.schedulingMutations.setAppointmentStatus);
  const undoStatus = useMutation(api.schedulingMutations.undoAppointmentStatus);
  const canOpenInbox = perms.can("inbox", "view_own");
  const quick: QuickActions = useMemo(
    () => ({
      contact: (a, onDone) => (
        <QuickContactPhone appointmentId={a._id} conversationId={canOpenInbox ? a.conversationId : undefined} onOpenConversation={(id) => navigate(`${TAB_ROUTES.inbox}?conversation=${id}`)} onDone={onDone} />
      ),
      canEdit: access.canEdit,
      onStatus: (appointmentId, to) => {
        const id = appointmentId as Id<"schedAppointments">;
        // Como no painel: o toast oferece "Desfazer" (só onde o servidor aceita).
        const undo =
          (UNDO_TARGETS[to as SchedStatus] ?? []).length > 0
            ? {
                action: {
                  label: VOCAB.scheduling.undo,
                  onClick: () => {
                    undoStatus({ organizationId, appointmentId: id }).then(
                      () => toast.success(VIEWS_COPY.pendingQueue.toast.undone),
                      (e) => toast.error(mutationErrorMessage(e, t.dense.quick.failed))
                    );
                  },
                },
              }
            : undefined;
        setStatus({ organizationId, appointmentId: id, to }).then(
          () => toast.success(to === "confirmed" ? t.dense.quick.confirmed : t.dense.quick.arrivedDone, undo),
          (e) => toast.error(mutationErrorMessage(e, t.dense.quick.failed))
        );
      },
    }),
    [access.canEdit, organizationId, setStatus, undoStatus, navigate, canOpenInbox]
  );

  // Arrastar um compromisso da equipe na Semana: a mesma mutation da página de compromissos (mantém a duração).
  const rescheduleEvent = useMutation(api.calendar.rescheduleEvent);
  const moveEvent = (item: InternalItem, localDate: LocalDate, minute: number, pieceDate: LocalDate) => {
    // Pedaço que continua da véspera: move pela diferença (`startTime + delta`); a duração se mantém.
    rescheduleEvent({ eventId: item.id as Id<"calendarEvents">, newStartTime: movedEventStart(item, pieceDate, localDate, minute, tz) }).then(
      () => toast.success(t.dense.weekGrid.moved),
      (e) => toast.error(mutationErrorMessage(e, t.dense.weekGrid.moveFailed))
    );
  };

  const bookingDate = isPast ? today : date;
  const startBooking = (opts: { minute?: number; resource?: DayResource; date?: LocalDate } = {}) => {
    const { date: on, ...rest } = opts;
    const target = on ?? bookingDate;
    setBooking({ stage: "pick", date: target < today ? today : target, ...rest });
  };
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
  // Faixa "Sem lugar": abre o resolvedor do conflito (não o painel); sem conflito aberto ou vencida, o painel.
  const openNoPlace = (a: { _id: string; status: string; startTime: number; needsAttention?: { code: string } }) => {
    const target = noPlaceTarget(a._id, pendingData?.conflicts ?? [], isExpiredProposal(a, now));
    if (target.kind === "resolve") setResolvingId(target.conflictId);
    else openAppointment(a._id);
  };
  const conflictOf = (appointmentId: string) => {
    const target = noPlaceTarget(appointmentId, pendingData?.conflicts ?? [], false);
    return target.kind === "resolve" ? target.conflictId : null;
  };
  const onInternalClick = (item: InternalItem) => {
    if (item.source === "task") setTaskId(item.id);
    else eventState.set(item.id, { history: "push" });
  };
  const newEvent = () => {
    const [y, m, d] = date.split("-").map(Number);
    const { hour, minute } = nextHalfHour(now, tz);
    setEventModal({ date: new Date(y, m - 1, d, hour, minute), hour, minute });
  };
  /** Marcar horário num dia e hora da Semana; com um filtro de sala ou profissional, ele já vem fixado. */
  const bookFromWeek = (localDate: LocalDate, minute: number) => {
    const r = weekFilter ? activeResources.find((x) => x._id === weekFilter) : undefined;
    const resource: DayResource | undefined = r
      ? { _id: r._id, kind: r.kind, name: r.name, capacity: r.capacity, sortOrder: r.sortOrder, open: [], closed: false, blocks: [] }
      : undefined;
    startBooking({ date: localDate, minute, resource });
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
  const periodText = periodLabel(date, view, isMobile);
  const atToday = week ? weekDates.includes(today) : isToday;

  // Atalhos de teclado (computador): T hoje, D/S/M/L visão, setas anterior e próximo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Quem já tratou a tecla (o seletor de visão usa as setas e dá `preventDefault`) ou camada aberta: não é com a página.
      const layerOpen = !!(apptState.value || pendingState.value || eventState.value || eventModal || taskId || booking || closure || rebooking || rescheduling || resolvingId || wizardOpen);
      if (shortcutBlocked(e, layerOpen)) return;
      const k = e.key.toLowerCase();
      if (k === "t") dateState.set(null);
      else if (k === "d") changeView("dia");
      else if (k === "s") changeView("semana");
      else if (k === "m") changeView("mes");
      else if (k === "l") changeView("lista");
      else if (e.key === "ArrowLeft") dateState.set(shiftDate(date, view, -1));
      else if (e.key === "ArrowRight") dateState.set(shiftDate(date, view, 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, view, apptState.value, pendingState.value, eventState.value, eventModal, taskId, booking, closure, rebooking, rescheduling, resolvingId, wizardOpen]);

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
        <div className="relative min-h-0 flex-1 space-y-3 overflow-y-auto pb-24 md:pb-2">
          {view !== "lista" && hasOtherKind && (
            <EmptyState
              icon={Settings2}
              size="sm"
              title={t.noColumns[groupBy].title}
              description={t.noColumns[groupBy].hint}
              action={{ label: t.noColumns.switchTo[groupBy], onClick: () => changeGroup(other) }}
            />
          )}
          <AgendaDayList {...listProps} />
        </div>
      );
    }
    return (
      <>
        {isMobile && grid.columns.length > 1 && (
          <FilterChips
            ariaLabel={t.groupLabel}
            chips={grid.columns.map((c) => ({ id: c.key, label: c.label, pressed: c.key === activeColumn }))}
            onToggle={setMobileColumn}
          />
        )}
        {(grid.allDay.length > 0 || grid.noPlace.length > 0 || (grid.empty && !setupIncomplete)) && (
          <div className="shrink-0 space-y-1.5">
            {grid.allDay.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label={t.grid.allDay}>
                {grid.allDay.map((e) => (
                  <li key={`allday:${e.id}`}>
                    <button
                      type="button"
                      onClick={() => onInternalClick(e)}
                      className="min-h-8 coarse:min-h-11 rounded-full border border-dashed border-ai-500 bg-ai-500/10 px-3 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      {t.grid.allDayShort}: {e.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {grid.noPlace.length > 0 && (
              <section aria-label={t.grid.noPlace} className="rounded-card border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-2">
                <h2 className="text-sm font-semibold text-text-primary">{t.grid.noPlace}</h2>
                <p className="text-caption text-text-secondary">{t.grid.noPlaceHint}</p>
                <ul className="mt-1.5 flex flex-wrap gap-2">
                  {grid.noPlace.map((a) => (
                    <li key={`noplace:${a._id}`}>
                      <Button size="sm" variant="secondary" onClick={() => openNoPlace(a)}>
                        {isExpiredProposal(a, now) ? VOCAB.scheduling.proposalExpired : isManualNoPlace(a) ? t.conflict.undefinedPlace[group] : t.grid.resolve}: {a.contactName ?? a.guestName ?? a.serviceName}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {grid.empty && !setupIncomplete && <p className="px-1 text-sm text-text-secondary">{t.list.empty.hint}</p>}
          </div>
        )}
        <Suspense fallback={<ContentSkeleton />}>
          <ResourceDayGrid
            model={grid}
            tz={dayInput.timezone}
            groupLabel={t.groups[group].toLowerCase()}
            canBook={canBookDay}
            canClose={access.canEdit}
            isToday={isToday}
            visibleKeys={isMobile && activeColumn ? [activeColumn] : undefined}
            hourPx={hourPx}
            tone={tone}
            quick={quick}
            scrollKey={`${shownDate}:${groupBy}`}
            onSlotClick={(resource, minute) => startBooking({ resource: resource ?? undefined, minute })}
            onAppointmentClick={openAppointment}
            onInternalClick={onInternalClick}
            onColumnAction={onColumnAction}
          />
        </Suspense>
      </>
    );
  };

  const header = (
    <AgendaToolbar
      view={view}
      onViewChange={changeView}
      group={group}
      onGroupChange={changeGroup}
      listMode={listMode}
      onListModeChange={(m) => listState.set(m)}
      dateLabel={periodText}
      atToday={atToday}
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
      weekFilter={week ? { options: weekFilterOptions, value: weekFilter, onChange: (id) => savePref({ resource: id }) } : null}
      color={color}
      onColorChange={(c) => savePref({ color: c })}
      density={density}
      onDensityChange={(x) => savePref({ density: x })}
      isMobile={isMobile}
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
            onResolveConflict={(id) => {
              const conflictId = conflictOf(id);
              if (conflictId) setResolvingId(conflictId);
            }}
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
            onRebook={(a: PendingAppointment) => {
              const target = rebookTarget(a);
              if (target) setRebooking(target);
              else openAppointment(a._id);
            }}
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

      {rebooking && (
        <Suspense fallback={null}>
          <BookingSheet
            organizationId={organizationId}
            open
            onClose={() => setRebooking(null)}
            onDone={() => setRebooking(null)}
            who={{
              contactId: rebooking.who.contactId as Id<"contacts"> | undefined,
              leadId: rebooking.who.leadId as Id<"leads"> | undefined,
              conversationId: rebooking.who.conversationId as Id<"conversations"> | undefined,
              name: rebooking.who.name,
            }}
            initialService={{ serviceId: rebooking.service.serviceId as Id<"schedServices">, variantKey: rebooking.service.variantKey }}
            onOpenAppointment={(id) => {
              setRebooking(null);
              openAppointment(id);
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

  const weekCapped = week && rangeAppts.data?.truncated;
  const stale = dayStale || rangeAppts.stale;

  return (
    // Ocupa a altura da tela (cancela o respiro da área de conteúdo): barra única no topo e só a grade rola.
    <div
      ref={pageRef}
      style={fillH === undefined ? undefined : { height: fillH }}
      className="-m-4 flex h-[calc(100vh-3.5rem-env(safe-area-inset-top)-5rem)] min-h-[28rem] flex-col gap-2 px-2 pb-1 pt-2 supports-[height:100dvh]:h-[calc(100dvh-3.5rem-env(safe-area-inset-top)-5rem)] md:-m-6 md:h-[calc(100vh-4rem)] md:px-3 md:pb-3 md:supports-[height:100dvh]:h-[calc(100dvh-4rem)]"
    >
      {header}

      {setupIncomplete && (
        <section className="shrink-0 rounded-card border border-border bg-surface-raised p-3">
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

      {((day?.enabled && day.capped && !rangeView) || weekCapped) && (
        <p role="status" className="flex shrink-0 items-start gap-2 rounded-card border border-semantic-warning/40 bg-semantic-warning/10 px-3 py-1.5 text-sm text-text-primary">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
          {weekCapped ? t.dense.weekGrid.capped : t.capped}
        </p>
      )}

      <div aria-busy={stale} className={`flex min-h-0 flex-1 flex-col gap-2 ${stale ? "opacity-60 transition-opacity" : ""}`}>
        {month ? (
          <Suspense fallback={<ContentSkeleton />}>
            <AgendaMonthView
              weeks={monthWeeks}
              tz={tz}
              now={now}
              today={today}
              selected={date}
              loading={rangeAppts.data === undefined}
              tone={tone}
              isMobile={isMobile}
              partialFrom={needRange && range?.enabled && range.capped ? { through: range.completeThrough } : null}
              truncated={rangeAppts.data?.truncated}
              onOpenDay={goToDay}
              onSelectDay={(d) => dateState.set(d === today ? null : d)}
              onAppointmentClick={openAppointment}
              onInternalClick={onInternalClick}
            />
          </Suspense>
        ) : week ? (
          weekModel && rangeAppts.data !== undefined ? (
            <Suspense fallback={<ContentSkeleton />}>
              <AgendaWeekView
                model={weekModel}
                tz={tz}
                hourPx={hourPx}
                tone={tone}
                canBookOn={(d) => access.canEdit && !setupIncomplete && d >= today && !closedByDay[d]?.all}
                quick={quick}
                dayStatus={closedByDay}
                compact={isMobile}
                scrollKey={`${weekDates[0]}:${weekFilter ?? "todos"}`}
                onSlotClick={bookFromWeek}
                onAppointmentClick={openAppointment}
                onInternalClick={onInternalClick}
                onOpenDay={goToDay}
                onMoveEvent={access.canEdit ? moveEvent : undefined}
              />
            </Suspense>
          ) : (
            <ContentSkeleton />
          )
        ) : (
          renderDay()
        )}
      </div>

      {(week || month || (view === "dia" && hasColumns)) && (
        <AgendaColorLegend scheme={color} resources={activeResources} services={activeServices} />
      )}

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
