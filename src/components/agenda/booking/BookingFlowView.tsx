import { useState } from "react";
import { CalendarX, Plus, UserPlus, X } from "lucide-react";
import { Stepper } from "@/components/ui/Stepper";
import { FilterChips } from "@/components/ui/FilterChips";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { BOOKING_COPY } from "@/lib/bookingCopy";
import { fillVocab } from "@/lib/agendaCopy";
import { VOCAB } from "@/lib/vocab";
import { isValidLocalDate, parseMinutes, zonedAtMinutes, zonedDateTimeLabel, type LocalDate } from "@/lib/agendaZone";
import {
  BOOKING_STEPS,
  MAX_COMPANIONS,
  SLOT_PERIODS,
  chosenDurationMin,
  canAdvance,
  joinNames,
  longRangePhrase,
  longWhenPhrase,
  nearestSlotStart,
  partySizeOf,
  pinnableKinds,
  splitSuggestions,
  supportsGroup,
  timeInputValue,
  violationText,
  type BookingAction,
  type BookingState,
  type DayPreset,
  type OfferedSlot,
  type PickedSlot,
  type PreviewVerdict,
  type ServiceLike,
  type SlotPeriod,
  type ViolationView,
} from "@/lib/bookingFlow";
import { SlotSuggestionList } from "./SlotSuggestionList";
import { RuleWarningsDialog } from "./RuleWarningsDialog";

const t = BOOKING_COPY;

export interface SlotsState {
  status: "loading" | "ready" | "error";
  slots: OfferedSlot[];
  hasMore: boolean;
  reason: string;
  firstPossible: OfferedSlot | null;
}

export interface ViewResource {
  _id: string;
  name: string;
  kind: string;
  capacity?: number;
  active?: boolean;
}

export interface FailureView {
  violations: ViolationView[];
  alternatives: OfferedSlot[];
  /** Horário veio de sugestão (`suggestion`) ou foi digitado (`manual`). */
  source: "suggestion" | "manual";
}

export type ManualPreviewResult = PreviewVerdict | { kind: "error"; message: string };

export interface BookingFlowViewProps {
  state: BookingState;
  dispatch: (action: BookingAction) => void;
  services: ServiceLike[];
  resources: ViewResource[];
  tz: string;
  today: LocalDate;
  slots: SlotsState;
  /** Nome (ou telefone, ou texto genérico) do cliente; nunca vazio. */
  clientName: string;
  whoOk: boolean;
  /** Modo remarcar; `fromStartTime` mostra "De X para Y" na revisão. */
  reschedule?: { fromStartTime?: number } | null;
  busy: boolean;
  failure: FailureView | null;
  onRetry: () => void;
  onSubmit: () => void;
  onForce: (codes: string[]) => void;
  onPickOffered: (slot: OfferedSlot) => void;
  onDismissFailure: () => void;
  /** "Outro horário": confere o horário digitado (prévia, sem gravar). */
  onPreviewManual: (startTime: number) => Promise<ManualPreviewResult>;
  /** Abrir o agendamento que já existia (duplicado). */
  onOpenExisting?: (appointmentId: string) => void;
  /** Hora pedida pela Agenda (minutos do dia no fuso da org; vale com o dia já aberto): destaca a sugestão mais próxima e pré-preenche "Outro horário". */
  initialTimeMin?: number;
}

/**
 * Corpo da folha "Marcar horário", só por props: passos, lista de horários, revisão e o diálogo de regras.
 * Estado do fluxo (`bookingReducer`), busca e envio ficam no contêiner (`BookingSheet`).
 */
export function BookingFlowView(props: BookingFlowViewProps) {
  const { state, dispatch, services, resources, tz } = props;
  const service = services.find((s) => s._id === state.serviceId);
  const resourceNames = new Map(resources.map((r) => [r._id, r.name]));
  const completed = BOOKING_STEPS.slice(0, BOOKING_STEPS.indexOf(state.step));
  return (
    <div className="space-y-4">
      <Stepper
        ariaLabel={t.stepsLabel}
        steps={BOOKING_STEPS.map((id) => ({ id, label: t.steps[id] }))}
        current={state.step}
        completed={completed}
        onStepClick={(id) => dispatch({ type: "goto", step: id as BookingState["step"] })}
      />
      {state.step === "service" && (
        <ServiceStep
          services={services}
          state={state}
          onPickService={(id) => dispatch({ type: "pickService", serviceId: id, services })}
          onPickVariant={(key) => dispatch({ type: "pickVariant", variantKey: key })}
        />
      )}
      {state.step === "slot" && <SlotStep {...props} service={service} />}
      {state.step === "review" && <ReviewStep {...props} service={service} resourceNames={resourceNames} />}
      <RuleWarningsDialog
        open={props.failure !== null}
        violations={props.failure?.violations ?? []}
        alternatives={props.failure?.alternatives ?? []}
        resourceNames={resourceNames}
        tz={tz}
        slotSource={props.failure?.source}
        busy={props.busy}
        onForce={props.onForce}
        onPickAlternative={props.onPickOffered}
        onClose={props.onDismissFailure}
      />
    </div>
  );
}

// --- passo 1 ---

function ServiceStep({
  services,
  state,
  onPickService,
  onPickVariant,
}: {
  services: ServiceLike[];
  state: BookingState;
  onPickService: (id: string) => void;
  onPickVariant: (key: string | null) => void;
}) {
  const picked = services.find((s) => s._id === state.serviceId);
  const variants = picked?.variants ?? [];
  const options = picked ? [{ key: null as string | null, name: t.service.baseVariant, durationMin: picked.durationMin }, ...variants.map((v) => ({ ...v }))] : [];
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
            {options.map((v) => (
              <li key={v.key ?? "base"}>
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full justify-between"
                  aria-pressed={state.variantKey === v.key}
                  onClick={() => onPickVariant(v.key)}
                >
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

// --- passo 2 ---

const DAY_CHIPS: Array<{ id: DayPreset; label: string }> = [
  { id: "today", label: t.slot.today },
  { id: "tomorrow", label: t.slot.tomorrow },
  { id: "week", label: t.slot.week },
  { id: "other", label: t.slot.otherDay },
];

function SlotStep({
  state,
  dispatch,
  service,
  services,
  resources,
  tz,
  today,
  slots,
  reschedule,
  clientName,
  onPickOffered,
  onRetry,
  onPreviewManual,
  onOpenExisting,
  initialTimeMin,
}: BookingFlowViewProps & { service: ServiceLike | undefined }) {
  const [showPeople, setShowPeople] = useState(Object.keys(state.pinned).length > 0);
  const prefill = timeInputValue(initialTimeMin);
  const [showManual, setShowManual] = useState(prefill !== "");
  const highlightStart = initialTimeMin !== undefined ? nearestSlotStart(slots.slots, { timeMin: initialTimeMin, tz, date: state.otherDate }) : null;
  const kinds = pinnableKinds(service);
  const { suggested, others } = splitSuggestions(slots.slots);
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
      {supportsGroup(service, resources) && (
        <FilterChips
          ariaLabel={t.slot.partyLabel}
          chips={[1, 2, 3, 4].map((n) => ({ id: String(n), label: n === 1 ? t.slot.partyOne : fillVocab(t.slot.partyOption, { n: String(n) }), pressed: partySizeOf(state) === n }))}
          onToggle={(id) => dispatch({ type: "setPartySize", size: Number(id) })}
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

      {slots.status === "loading" && slots.slots.length === 0 && (
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
      {slots.slots.length > 0 && slots.status !== "error" && (
        <SlotSuggestionList
          suggested={suggested}
          others={others}
          tz={tz}
          selectedStart={state.slot?.startTime ?? null}
          highlightStart={highlightStart}
          onPick={onPickOffered}
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
            description={
              slots.reason === "unverifiable"
                ? t.slot.unverifiable
                : partySizeOf(state) > 1 && state.pinned.person
                  ? t.slot.partyPinned
                  : VOCAB.scheduling.empty.slots.hint
            }
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
          tz={tz}
          today={today}
          initialDate={state.otherDate ?? today}
          initialTime={prefill}
          clientName={clientName}
          onPreview={onPreviewManual}
          onPick={(slot) => dispatch({ type: "pickSlot", slot })}
          onPickAlternative={onPickOffered}
          onOpenExisting={onOpenExisting}
        />
      )}
    </div>
  );
}

/** "Outro horário": dia e hora digitados; a prévia (sem gravar) diz se está livre, com avisos ou bloqueado. */
function ManualSlotForm({
  tz,
  today,
  initialDate,
  initialTime,
  clientName,
  onPreview,
  onPick,
  onPickAlternative,
  onOpenExisting,
}: {
  tz: string;
  today: LocalDate;
  initialDate: string;
  initialTime: string;
  clientName: string;
  onPreview: (startTime: number) => Promise<ManualPreviewResult>;
  onPick: (slot: PickedSlot) => void;
  onPickAlternative: (slot: OfferedSlot) => void;
  onOpenExisting?: (id: string) => void;
}) {
  const [date, setDate] = useState<string>(initialDate);
  const [time, setTime] = useState(initialTime);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
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
    setExisting(null);
    setBusy(true);
    try {
      const verdict = await onPreview(startTime);
      if (verdict.kind === "duplicate") {
        setExisting(verdict.appointmentId);
        setMessage(fillVocab(t.slot.duplicate, { nome: clientName }));
      } else if (verdict.kind === "ok") {
        onPick({ ...slot, warnings: verdict.warnings, resourceNames: verdict.resourceNames });
      } else if (verdict.kind === "warn") {
        onPick({ ...slot, warnings: verdict.warnings });
      } else if (verdict.kind === "blocked") {
        setBlocked({ violations: verdict.violations, alternatives: verdict.alternatives });
        setMessage(t.slot.manualBlocked);
      } else {
        setMessage(verdict.message);
      }
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
      {existing && onOpenExisting && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenExisting(existing)}>
          {t.slot.openExisting}
        </Button>
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

// --- passo 3 ---

function ReviewStep({
  state,
  dispatch,
  service,
  tz,
  clientName,
  whoOk,
  reschedule,
  busy,
  onSubmit,
  resourceNames,
}: BookingFlowViewProps & { service: ServiceLike | undefined; resourceNames: ReadonlyMap<string, string> }) {
  const slot = state.slot;
  if (!slot) return null;
  const names = slot.resourceNames.length > 0 ? slot.resourceNames : slot.resourceIds.map((id) => resourceNames.get(id) ?? "");
  const where = joinNames(names) ?? t.review.anyWhere;
  const variant = service?.variants?.find((v) => v.key === state.variantKey);
  const duration = chosenDurationMin(service, state.variantKey);
  const end = slot.endTime ?? (duration ? slot.startTime + duration * 60_000 : null);
  const whenRows: Array<[string, string]> =
    reschedule?.fromStartTime !== undefined
      ? [
          [t.review.from, longWhenPhrase(reschedule.fromStartTime, tz)],
          [t.review.to, longRangePhrase(slot.startTime, end, tz)],
        ]
      : [[t.review.when, longRangePhrase(slot.startTime, end, tz)]];
  const rows: Array<[string, string]> = [
    // O cliente nunca some da revisão: `clientName` já traz o fallback.
    [t.review.who, clientName],
    [t.review.service, `${service?.name ?? ""}${variant ? ` · ${variant.name}` : ""}${duration ? ` · ${fillVocab(t.service.minutes, { min: duration })}` : ""}`],
    ...whenRows,
    [t.review.where, where],
  ];
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
          {state.companions.length < MAX_COMPANIONS && (
            <Button type="button" variant="ghost" size="sm" onClick={() => dispatch({ type: "addCompanion" })}>
              <UserPlus size={16} aria-hidden="true" />
              {t.review.companion.add}
            </Button>
          )}
          {state.companions.length > 0 && <p className="text-caption text-text-muted">{t.review.companion.hint}</p>}
        </div>
      )}

      <Textarea label={t.review.notes} rows={2} maxLength={500} value={state.notes} onChange={(e) => dispatch({ type: "setNotes", notes: e.target.value })} />

      {!whoOk && <p className="text-sm text-semantic-warning">{t.review.noWho}</p>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button type="button" variant="secondary" className="flex-1" onClick={() => dispatch({ type: "back" })}>
          {t.review.back}
        </Button>
        <Button type="button" size="lg" className="flex-1" disabled={!canAdvance(state, whoOk)} loading={busy} onClick={onSubmit}>
          {reschedule ? t.review.submitReschedule : t.review.submit}
        </Button>
      </div>
    </div>
  );
}
