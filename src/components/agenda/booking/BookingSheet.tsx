import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { CalendarX, Plus, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Stepper } from "@/components/ui/Stepper";
import { FilterChips } from "@/components/ui/FilterChips";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { mutationErrorMessage } from "@/lib/errors";
import { fillVocab } from "@/lib/agendaCopy";
import { VOCAB } from "@/lib/vocab";
import { zonedAtMinutes, parseMinutes, zonedToday, zonedDateTimeLabel, isValidLocalDate, type LocalDate } from "@/lib/agendaZone";
import {
  BOOKING_STEPS,
  SLOT_PERIODS,
  bookingReducer,
  buildBookArgs,
  buildFindSlotsArgs,
  buildRescheduleArgs,
  canAdvance,
  chosenDurationMin,
  hasWho,
  initialBookingState,
  joinNames,
  longRangePhrase,
  newIdempotencyKey,
  normalizeOffered,
  parseSchedRulesError,
  parseViolations,
  pickedFromOffered,
  pinnableKinds,
  classifyViolations,
  readAlternatives,
  splitSuggestions,
  violationText,
  type BookingState,
  type BookingWho,
  type DayPreset,
  type OfferedSlot,
  type PickedSlot,
  type ServiceLike,
  type SlotPeriod,
  type ViolationView,
} from "@/lib/bookingFlow";
import { useRoundedNow } from "./useRoundedNow";
import { SlotSuggestionList } from "./SlotSuggestionList";
import { RuleWarningsDialog } from "./RuleWarningsDialog";

const t = VOCAB.scheduling.booking;

export interface BookingSheetWho extends BookingWho {
  /** Nome para mostrar no passo 3. */
  name?: string;
}

export interface BookingDoneInfo {
  appointmentIds: string[];
  rescheduled: boolean;
}

export interface BookingSheetProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
  /** Quem será marcado (contato, lead e/ou conversa). Obrigatório para marcar; remarcar dispensa. */
  who: BookingSheetWho;
  /** Modo remarcar: o horário atual deixa de contar como ocupado na busca. */
  reschedule?: { appointmentId: Id<"schedAppointments">; serviceId: Id<"schedServices">; variantKey?: string };
  /** Abre num dia (`YYYY-MM-DD`), ex.: "+ livre" da Agenda. */
  initialDate?: LocalDate;
  /** Sala/profissional já fixados por tipo (`room`, `person`), ex.: coluna da Agenda. */
  initialPinned?: Record<string, string>;
  onDone?: (info: BookingDoneInfo) => void;
}

/**
 * Marcar horário em 3 passos (serviço, horário, confirmar), folha inferior no celular e modal no
 * computador. A lógica é de `lib/bookingFlow.ts`; aqui só há tela e chamadas ao Convex. O corpo é montado
 * só aberto, então o estado (e a chave de idempotência) nasce a cada abertura.
 */
export function BookingSheet(props: BookingSheetProps) {
  const { open, onClose, reschedule } = props;
  return (
    <Modal open={open} onClose={onClose} title={reschedule ? t.rescheduleTitle : t.title} className="sm:max-w-xl">
      <BookingSheetLoader {...props} />
    </Modal>
  );
}

function BookingSheetLoader(props: BookingSheetProps) {
  const tz = useOrgTimezone(props.organizationId);
  const now = useRoundedNow("minute");
  const today = zonedToday(now, tz);
  const config = useQuery(api.schedulingConfig.getConfig, { organizationId: props.organizationId, closuresFrom: today });
  if (config === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size="md" />
      </div>
    );
  }
  const services = (config?.services ?? []).filter((s) => s.active);
  const resources = (config?.resources ?? []).filter((r) => r.active);
  if (services.length === 0) {
    return <EmptyState icon={CalendarX} size="sm" title={t.service.none.title} description={t.service.none.hint} />;
  }
  return (
    <BookingFlow
      {...props}
      tz={tz}
      services={services}
      resources={resources}
      preferredServiceId={config?.settings.humanConfirm?.defaultServiceId ?? null}
    />
  );
}

type ConfigService = ServiceLike & { _id: Id<"schedServices"> };
type ConfigResource = { _id: Id<"schedResources">; name: string; kind: string };

interface BookingFlowProps extends BookingSheetProps {
  tz: string;
  services: ConfigService[];
  resources: ConfigResource[];
  preferredServiceId: string | null;
}

interface SlotsState {
  status: "loading" | "ready" | "error";
  slots: OfferedSlot[];
  hasMore: boolean;
  reason: string;
  firstPossible: OfferedSlot | null;
}

interface RulesFailureState {
  violations: ViolationView[];
  alternatives: OfferedSlot[];
}

function BookingFlow({
  organizationId,
  onClose,
  who,
  reschedule,
  initialDate,
  initialPinned,
  onDone,
  tz,
  services,
  resources,
  preferredServiceId,
}: BookingFlowProps) {
  const convex = useConvex();
  const bookAppointment = useMutation(api.schedulingMutations.bookAppointment);
  const rescheduleAppointment = useMutation(api.schedulingMutations.rescheduleAppointment);
  const cancelAppointment = useMutation(api.schedulingMutations.cancelAppointment);
  const now = useRoundedNow("minute");
  const today = zonedToday(now, tz);

  const [state, dispatch] = useReducer(
    bookingReducer,
    undefined,
    (): BookingState =>
      initialBookingState({
        services,
        preferredServiceId,
        serviceId: reschedule?.serviceId,
        variantKey: reschedule?.variantKey,
        idempotencyKey: newIdempotencyKey(),
        date: initialDate,
        pinned: initialPinned,
      })
  );
  const service = services.find((s) => s._id === state.serviceId);
  const durationMin = chosenDurationMin(service, state.variantKey);
  const resourceNames = useMemo(() => new Map(resources.map((r) => [r._id as string, r.name])), [resources]);

  // --- horários (chamada avulsa, sem assinatura) ---
  const [slotsState, setSlotsState] = useState<SlotsState>({ status: "loading", slots: [], hasMore: false, reason: "ok", firstPossible: null });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), []);
  const findArgs = useMemo(
    () =>
      buildFindSlotsArgs({
        organizationId,
        state: { ...state, slot: null },
        tz,
        now,
        rescheduleAppointmentId: reschedule?.appointmentId,
      }),
    // `state.slot`/`step`/`companions`/`notes` não mudam a busca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organizationId, state.serviceId, state.variantKey, state.dayPreset, state.otherDate, state.period, state.pinned, state.expanded, tz, now, reschedule?.appointmentId]
  );
  const findKey = findArgs ? JSON.stringify(findArgs) : "";
  const requestId = useRef(0);
  const onSlotStep = state.step === "slot";
  useEffect(() => {
    if (!findArgs || !onSlotStep) return;
    const id = ++requestId.current;
    setSlotsState((s) => ({ ...s, status: "loading" }));
    convex
      .query(api.scheduling.findSlots, findArgs)
      .then((res) => {
        if (id !== requestId.current) return;
        const ctx = { tz, durationMin };
        setSlotsState({
          status: "ready",
          slots: res.slots.map((s) => normalizeOffered(s, ctx)).filter((s): s is OfferedSlot => s !== null),
          hasMore: res.hasMore,
          reason: res.reason,
          firstPossible: res.firstPossible ? normalizeOffered(res.firstPossible, ctx) : null,
        });
      })
      .catch(() => {
        if (id === requestId.current) setSlotsState((s) => ({ ...s, status: "error" }));
      });
    // `findKey` resume `findArgs`; o `now` do minuto já está dentro dele.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findKey, onSlotStep, refreshNonce, convex]);

  // --- envio ---
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<RulesFailureState | null>(null);
  const whoOk = Boolean(reschedule) || hasWho(who);

  const submit = async (force?: string[]) => {
    if (busy) return;
    setBusy(true);
    try {
      if (reschedule) {
        const args = buildRescheduleArgs({ organizationId, appointmentId: reschedule.appointmentId, state, force });
        if (!args) return;
        await rescheduleAppointment(args);
        toast.success(VOCAB.scheduling.toast.rescheduled);
        onDone?.({ appointmentIds: [reschedule.appointmentId], rescheduled: true });
      } else {
        const args = buildBookArgs({ organizationId, state, who, force });
        if (!args) return;
        const res = await bookAppointment(args);
        const ids = res.appointmentIds;
        toast.success(VOCAB.scheduling.toast.booked, {
          action: {
            label: VOCAB.scheduling.undo,
            onClick: () => {
              void Promise.all(ids.map((appointmentId) => cancelAppointment({ organizationId, appointmentId })))
                .then(() => toast.success(t.toast.undone))
                .catch((e) => toast.error(mutationErrorMessage(e, t.toast.undoFailed)));
            },
          },
        });
        onDone?.({ appointmentIds: ids, rescheduled: false });
      }
      setFailure(null);
      onClose();
    } catch (e) {
      const rules = parseSchedRulesError(e);
      if (rules) {
        const alternatives = readAlternatives(rules.alternatives, { tz, now, durationMin });
        setFailure({ violations: rules.violations, alternatives });
        // Bloqueio (horário tomado, capacidade): volta ao passo 2 com a busca atualizada.
        if (!classifyViolations(rules.violations).canForce) {
          dispatch({ type: "goto", step: "slot" });
          refresh();
        }
      } else {
        toast.error(mutationErrorMessage(e, VOCAB.scheduling.toast.failed));
      }
    } finally {
      setBusy(false);
    }
  };

  const pickOffered = (slot: OfferedSlot) => {
    setFailure(null);
    dispatch({ type: "pickSlot", slot: pickedFromOffered(slot) });
  };

  // --- tela ---
  const completed = BOOKING_STEPS.slice(0, BOOKING_STEPS.indexOf(state.step));
  const stepper = (
    <Stepper
      ariaLabel={t.stepsLabel}
      steps={BOOKING_STEPS.map((id) => ({ id, label: t.steps[id] }))}
      current={state.step}
      completed={completed}
      onStepClick={(id) => dispatch({ type: "goto", step: id as BookingState["step"] })}
    />
  );

  return (
    <div className="space-y-4">
      {stepper}
      {state.step === "service" && (
        <ServiceStep services={services} state={state} onPickService={(id) => dispatch({ type: "pickService", serviceId: id, services })} onPickVariant={(key) => dispatch({ type: "pickVariant", variantKey: key })} />
      )}
      {state.step === "slot" && (
        <SlotStep
          state={state}
          service={service}
          services={services}
          resources={resources}
          tz={tz}
          today={today}
          slots={slotsState}
          reschedule={Boolean(reschedule)}
          organizationId={organizationId}
          who={who}
          dispatch={dispatch}
          onPick={pickOffered}
          onRetry={refresh}
        />
      )}
      {state.step === "review" && (
        <ReviewStep
          state={state}
          service={service}
          tz={tz}
          who={who}
          whoOk={whoOk}
          reschedule={Boolean(reschedule)}
          busy={busy}
          resourceNames={resourceNames}
          dispatch={dispatch}
          onSubmit={() => void submit()}
        />
      )}
      <RuleWarningsDialog
        open={failure !== null}
        violations={failure?.violations ?? []}
        alternatives={failure?.alternatives ?? []}
        resourceNames={resourceNames}
        tz={tz}
        busy={busy}
        onForce={(codes) => void submit(codes)}
        onPickAlternative={pickOffered}
        onClose={() => setFailure(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Passo 1: serviço
// ---------------------------------------------------------------------------

function ServiceStep({
  services,
  state,
  onPickService,
  onPickVariant,
}: {
  services: ConfigService[];
  state: BookingState;
  onPickService: (id: string) => void;
  onPickVariant: (key: string | null) => void;
}) {
  const picked = services.find((s) => s._id === state.serviceId);
  const variants = picked?.variants ?? [];
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-text-primary">{t.service.heading}</h3>
      <ul className="space-y-2">
        {services.map((s) => (
          <li key={s._id}>
            <button
              type="button"
              onClick={() => onPickService(s._id)}
              aria-pressed={state.serviceId === s._id}
              className={`flex min-h-14 w-full items-center justify-between gap-3 rounded-card border px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                state.serviceId === s._id ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface-raised hover:bg-surface-overlay"
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{s.name}</span>
              <span className="shrink-0 text-caption tabular-nums text-text-muted">{fillVocab(t.service.minutes, { min: s.durationMin })}</span>
            </button>
          </li>
        ))}
      </ul>
      {picked && variants.length > 0 && (
        <div className="space-y-2" role="group" aria-label={t.service.variantHeading}>
          <h3 className="text-sm font-semibold text-text-primary">{t.service.variantHeading}</h3>
          <ul className="space-y-2">
            {[{ key: null as string | null, name: t.service.baseVariant, durationMin: picked.durationMin }, ...variants.map((v) => ({ ...v }))].map((v) => (
              <li key={v.key ?? "base"}>
                <Button type="button" variant="secondary" className="w-full justify-between" onClick={() => onPickVariant(v.key)}>
                  <span className="truncate">{v.name}</span>
                  <span className="tabular-nums text-text-muted">{fillVocab(t.service.minutes, { min: v.durationMin })}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Passo 2: horário
// ---------------------------------------------------------------------------

type Dispatch = (action: Parameters<typeof bookingReducer>[1]) => void;

const DAY_CHIPS: Array<{ id: DayPreset; label: string }> = [
  { id: "today", label: t.slot.today },
  { id: "tomorrow", label: t.slot.tomorrow },
  { id: "week", label: t.slot.week },
  { id: "other", label: t.slot.otherDay },
];

function SlotStep({
  state,
  service,
  services,
  resources,
  tz,
  today,
  slots,
  reschedule,
  organizationId,
  who,
  dispatch,
  onPick,
  onRetry,
}: {
  state: BookingState;
  service: ConfigService | undefined;
  services: ConfigService[];
  resources: ConfigResource[];
  tz: string;
  today: LocalDate;
  slots: SlotsState;
  reschedule: boolean;
  organizationId: Id<"organizations">;
  who: BookingSheetWho;
  dispatch: Dispatch;
  onPick: (slot: OfferedSlot) => void;
  onRetry: () => void;
}) {
  const [showPeople, setShowPeople] = useState(Object.keys(state.pinned).length > 0);
  const [showManual, setShowManual] = useState(false);
  const kinds = pinnableKinds(service);
  const { suggested, others } = splitSuggestions(slots.slots);
  const selectedStart = state.slot?.startTime ?? null;
  const canChangeService = !reschedule && services.length > 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-base font-semibold text-text-primary">{service?.name ?? t.slot.heading}</h3>
        {canChangeService && (
          <Button type="button" variant="ghost" size="sm" onClick={() => dispatch({ type: "goto", step: "service" })}>
            {t.service.change}
          </Button>
        )}
      </div>

      <FilterChips
        ariaLabel={t.slot.dayLabel}
        chips={DAY_CHIPS.map((c) => ({ ...c, pressed: state.dayPreset === c.id }))}
        onToggle={(id) => dispatch({ type: "setDay", preset: id as DayPreset, date: id === "other" ? (state.otherDate ?? today) : undefined })}
      />
      {state.dayPreset === "other" && (
        <Input
          type="date"
          label={t.slot.dayLabel}
          min={today}
          value={state.otherDate ?? today}
          onChange={(e) => isValidLocalDate(e.target.value) && dispatch({ type: "setDay", preset: "other", date: e.target.value })}
        />
      )}
      <FilterChips
        ariaLabel={t.slot.periodLabel}
        chips={SLOT_PERIODS.map((p) => ({ id: p, label: t.slot.periods[p], pressed: state.period === p }))}
        onToggle={(id) => dispatch({ type: "setPeriod", period: id as SlotPeriod })}
      />

      {kinds.length > 0 && (
        <div className="space-y-2">
          <Button type="button" variant="ghost" size="sm" aria-expanded={showPeople} onClick={() => setShowPeople((v) => !v)}>
            {t.slot.choosePeople}
          </Button>
          {showPeople &&
            kinds.map((kind) => {
              const meta = VOCAB.scheduling.resource[kind as "person" | "room" | "equipment"];
              return (
                <Select
                  key={kind}
                  label={meta.title}
                  value={state.pinned[kind] ?? ""}
                  onValueChange={(v) => dispatch({ type: "pin", kind, resourceId: v || null })}
                  options={[
                    { value: "", label: fillVocab(t.slot.anyResource, { recurso: meta.one }) },
                    ...resources.filter((r) => r.kind === kind).map((r) => ({ value: r._id, label: r.name })),
                  ]}
                />
              );
            })}
        </div>
      )}

      {slots.status === "loading" && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-text-secondary" role="status">
          <Spinner size="sm" />
          {t.slot.loading}
        </div>
      )}
      {slots.status === "error" && (
        <div className="space-y-2 py-2 text-sm text-text-secondary" role="alert">
          <p>{t.slot.failed}</p>
          <Button type="button" variant="secondary" onClick={onRetry}>
            {t.slot.retry}
          </Button>
        </div>
      )}
      {slots.status === "ready" && slots.slots.length > 0 && (
        <SlotSuggestionList
          suggested={suggested}
          others={others}
          tz={tz}
          selectedStart={selectedStart}
          onPick={onPick}
          canExpand={slots.hasMore && !state.expanded}
          onExpand={() => dispatch({ type: "expand" })}
        />
      )}
      {slots.status === "ready" && slots.slots.length === 0 && (
        <div className="space-y-2">
          <EmptyState
            icon={CalendarX}
            size="sm"
            title={VOCAB.scheduling.empty.slots.title}
            description={slots.reason === "unverifiable" ? t.slot.unverifiable : VOCAB.scheduling.empty.slots.hint}
          />
          {slots.firstPossible && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => dispatch({ type: "setDay", preset: "other", date: slots.firstPossible!.localDate })}
            >
              {fillVocab(t.slot.firstPossible, { quando: zonedDateTimeLabel(slots.firstPossible.startTime, tz) })}
            </Button>
          )}
        </div>
      )}

      <Button type="button" variant="ghost" className="w-full" aria-expanded={showManual} onClick={() => setShowManual((v) => !v)}>
        <Plus size={16} aria-hidden="true" />
        {t.slot.manualCta}
      </Button>
      {showManual && (
        <ManualSlotForm
          organizationId={organizationId}
          state={state}
          who={who}
          tz={tz}
          today={today}
          reschedule={reschedule}
          onPick={(slot) => dispatch({ type: "pickSlot", slot })}
          onPickAlternative={onPick}
        />
      )}
    </div>
  );
}

/** "Outro horário": dia e hora digitados; passa por `previewBooking` antes de seguir (sem gravar). */
function ManualSlotForm({
  organizationId,
  state,
  who,
  tz,
  today,
  reschedule,
  onPick,
  onPickAlternative,
}: {
  organizationId: Id<"organizations">;
  state: BookingState;
  who: BookingSheetWho;
  tz: string;
  today: LocalDate;
  reschedule: boolean;
  onPick: (slot: PickedSlot) => void;
  onPickAlternative: (slot: OfferedSlot) => void;
}) {
  const previewBooking = useMutation(api.schedulingMutations.previewBooking);
  const [date, setDate] = useState<string>(state.otherDate ?? today);
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ violations: ViolationView[]; alternatives: OfferedSlot[] } | null>(null);

  const check = async () => {
    const minutes = parseMinutes(time);
    if (minutes === null || !isValidLocalDate(date)) {
      setMessage(t.slot.manualInvalid);
      return;
    }
    const startTime = zonedAtMinutes(date, minutes, tz);
    const slot: PickedSlot = { startTime, endTime: null, resourceIds: [], resourceNames: [], reasons: [], manual: true, warnings: [] };
    setMessage(null);
    setBlocked(null);
    // Remarcar: a prévia contaria o próprio horário como ocupado; o servidor confere ao remarcar.
    if (reschedule) {
      onPick(slot);
      return;
    }
    const args = buildBookArgs({ organizationId, state: { ...state, slot }, who, mode: "preview" });
    if (!args) return;
    setBusy(true);
    try {
      const res = await previewBooking(args);
      if (res.ok) {
        const warnings = parseViolations(res.warnings);
        onPick({ ...slot, warnings, resourceNames: res.plan.map((p) => p.resourceName ?? "").filter(Boolean) });
        return;
      }
      const violations = parseViolations(res.violations);
      const outcome = classifyViolations(violations);
      if (outcome.canForce) {
        onPick({ ...slot, warnings: outcome.warnings });
      } else {
        setBlocked({ violations, alternatives: readAlternatives(res.alternatives, { tz, now: Date.now(), durationMin: undefined }) });
        setMessage(t.slot.manualBlocked);
      }
    } catch (e) {
      setMessage(mutationErrorMessage(e, VOCAB.scheduling.toast.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-card border border-border bg-surface-sunken p-3">
      <h3 className="text-sm font-semibold text-text-primary">{t.slot.manualTitle}</h3>
      <div className="grid grid-cols-2 gap-3">
        <Input type="date" label={t.slot.manualDate} min={today} value={date} onChange={(e) => setDate(e.target.value)} />
        <Input type="time" label={t.slot.manualTime} step={300} value={time} onChange={(e) => setTime(e.target.value)} />
      </div>
      <Button type="button" variant="secondary" className="w-full" loading={busy} onClick={() => void check()}>
        {t.slot.manualCheck}
      </Button>
      {message && (
        <p role="status" className="text-sm text-text-secondary">
          {message}
        </p>
      )}
      {blocked && (
        <>
          <ul className="space-y-1 text-sm text-text-primary">
            {blocked.violations.map((v, i) => (
              <li key={`${v.code}:${i}`}>{violationText(v)}</li>
            ))}
          </ul>
          {blocked.alternatives.length > 0 && (
            <ul className="space-y-2">
              {blocked.alternatives.map((s) => (
                <li key={`${s.startTime}:${s.resourceIds.join(",")}`}>
                  <Button type="button" variant="secondary" className="w-full" onClick={() => onPickAlternative(s)}>
                    {zonedDateTimeLabel(s.startTime, tz)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Passo 3: revisar e confirmar
// ---------------------------------------------------------------------------

function ReviewStep({
  state,
  service,
  tz,
  who,
  whoOk,
  reschedule,
  busy,
  resourceNames,
  dispatch,
  onSubmit,
}: {
  state: BookingState;
  service: ConfigService | undefined;
  tz: string;
  who: BookingSheetWho;
  whoOk: boolean;
  reschedule: boolean;
  busy: boolean;
  resourceNames: ReadonlyMap<string, string>;
  dispatch: Dispatch;
  onSubmit: () => void;
}) {
  const slot = state.slot;
  if (!slot) return null;
  const names = slot.resourceNames.length > 0 ? slot.resourceNames : slot.resourceIds.map((id) => resourceNames.get(id) ?? "");
  const where = joinNames(names) ?? t.review.anyWhere;
  const variant = service?.variants?.find((v) => v.key === state.variantKey);
  const duration = chosenDurationMin(service, state.variantKey);
  const rows: Array<[string, string]> = [
    ...(who.name ? ([[t.review.who, who.name]] as Array<[string, string]>) : []),
    [t.review.service, `${service?.name ?? ""}${variant ? ` · ${variant.name}` : ""}${duration ? ` · ${fillVocab(t.service.minutes, { min: duration })}` : ""}`],
    [t.review.when, longRangePhrase(slot.startTime, slot.endTime ?? (duration ? slot.startTime + duration * 60_000 : null), tz)],
    [t.review.where, where],
  ];
  const canSubmit = canAdvance(state, whoOk);
  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-text-primary">{t.review.heading}</h3>
      <dl className="space-y-2 rounded-card border border-border bg-surface-raised p-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-caption text-text-muted">{label}</dt>
            <dd className="text-sm font-medium text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>

      {slot.warnings.length > 0 && (
        <div className="rounded-card border border-semantic-warning/40 bg-semantic-warning/5 p-3" role="status">
          <p className="text-sm font-medium text-semantic-warning">{t.review.warningsTitle}</p>
          <ul className="mt-1 space-y-1 text-sm text-text-primary">
            {slot.warnings.map((w, i) => (
              <li key={`${w.code}:${i}`}>{violationText(w, resourceNames)}</li>
            ))}
          </ul>
        </div>
      )}

      {!reschedule && (
        <div className="space-y-2">
          {state.companions.map((name, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  label={t.review.companion.name}
                  value={name}
                  maxLength={80}
                  onChange={(e) => dispatch({ type: "setCompanion", index: i, name: e.target.value })}
                />
              </div>
              <Button type="button" variant="ghost" iconOnly aria-label={t.review.companion.remove} onClick={() => dispatch({ type: "removeCompanion", index: i })}>
                <X size={16} aria-hidden="true" />
              </Button>
            </div>
          ))}
          {state.companions.length < 3 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => dispatch({ type: "addCompanion" })}>
              <UserPlus size={16} aria-hidden="true" />
              {t.review.companion.add}
            </Button>
          )}
          {state.companions.length > 0 && <p className="text-caption text-text-muted">{t.review.companion.hint}</p>}
        </div>
      )}

      <Textarea
        label={t.review.notes}
        rows={2}
        maxLength={500}
        value={state.notes}
        onChange={(e) => dispatch({ type: "setNotes", notes: e.target.value })}
      />

      {!whoOk && <p className="text-sm text-semantic-warning">{t.review.noWho}</p>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="secondary" className="flex-1" onClick={() => dispatch({ type: "back" })}>
          {t.review.back}
        </Button>
        <Button type="button" size="lg" className="flex-1" disabled={!canSubmit} loading={busy} onClick={onSubmit}>
          {reschedule ? t.review.submitReschedule : t.review.submit}
        </Button>
      </div>
    </div>
  );
}
