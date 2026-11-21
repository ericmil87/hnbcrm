import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { CalendarX } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { formatPhone } from "@/components/campaigns/campaignUtils";
import { mutationErrorMessage } from "@/lib/errors";
import { fillVocab } from "@/lib/agendaCopy";
import { BOOKING_COPY } from "@/lib/bookingCopy";
import { VOCAB } from "@/lib/vocab";
import { zonedToday, type LocalDate } from "@/lib/agendaZone";
import {
  bookingReducer,
  buildBookArgs,
  buildFindSlotsArgs,
  chosenDurationMin,
  clientLabel,
  hasWho,
  initialBookingState,
  interpretPreview,
  mergeRefreshedSlots,
  newIdempotencyKey,
  normalizeOffered,
  partySizeOf,
  pickedFromOffered,
  submitBooking,
  undoFreshBooking,
  undoRefusedText,
  type BookingState,
  type BookingWho,
  type OfferedSlot,
  type ServiceLike,
} from "@/lib/bookingFlow";
import { useRoundedNow } from "./useRoundedNow";
import { BookingFlowView, type FailureView, type ManualPreviewResult, type SlotsState } from "./BookingFlowView";

const t = BOOKING_COPY;

export interface BookingSheetWho extends BookingWho {
  /** Nome (ou telefone formatado) para a revisão; sem ele a tela mostra "Cliente desta conversa". */
  name?: string;
  /** Telefone cru; sem nome, a revisão mostra o telefone formatado. */
  phone?: string;
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
  /** Modo remarcar: o horário atual deixa de contar como ocupado na busca; `startTime` alimenta "De X para Y". */
  reschedule?: { appointmentId: Id<"schedAppointments">; serviceId: Id<"schedServices">; variantKey?: string; startTime?: number };
  /** Serviço (e variação) já decididos ao marcar de novo uma proposta vencida; o passo de serviço não é repetido. */
  initialService?: { serviceId: Id<"schedServices">; variantKey?: string };
  /** Abre num dia (`YYYY-MM-DD`), ex.: "+ livre" da Agenda. */
  initialDate?: LocalDate;
  /** Hora pedida (minutos do dia no fuso da org); só vale junto de `initialDate`: destaca a sugestão mais próxima e pré-preenche "Outro horário". */
  initialTimeMin?: number;
  /** Sala/profissional já fixados por tipo (`room`, `person`), ex.: coluna da Agenda. */
  initialPinned?: Record<string, string>;
  /** Abrir um agendamento (o "Ver horário" do aviso de duplicado). Ausente = sem o atalho. */
  onOpenAppointment?: (appointmentId: Id<"schedAppointments">) => void;
  onDone?: (info: BookingDoneInfo) => void;
}

/**
 * Marcar horário em 3 passos (serviço, horário, confirmar), folha inferior no celular e modal no
 * computador. Contêiner: fala com o Convex; a tela é `BookingFlowView` (por props) e a lógica,
 * `lib/bookingFlow.ts`. O corpo só monta aberto, então o estado (e a chave de idempotência) nasce a cada
 * abertura. Esc é ignorado enquanto envia.
 */
export function BookingSheet(props: BookingSheetProps) {
  const { open, onClose, reschedule } = props;
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title={reschedule ? t.rescheduleTitle : t.title} className="sm:max-w-xl">
      <BookingSheetLoader {...props} busy={busy} setBusy={setBusy} />
    </Modal>
  );
}

interface LoaderProps extends BookingSheetProps {
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

function BookingSheetLoader(props: LoaderProps) {
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

interface FlowProps extends LoaderProps {
  tz: string;
  services: ServiceLike[];
  resources: Array<{ _id: Id<"schedResources">; name: string; kind: string; capacity?: number; active?: boolean }>;
  preferredServiceId: string | null;
}

const EMPTY_SLOTS: SlotsState = { status: "loading", slots: [], hasMore: false, reason: "ok", firstPossible: null };

/**
 * Busca de horários (chamada avulsa, sem assinatura). Mudou o filtro (serviço, dia, período, recursos):
 * limpa e mostra o carregando. Rebusca silenciosa (a cada minuto, "Ver mais horários"): a lista exibida
 * não pisca nem reordena (`mergeRefreshedSlots`). O relógio é lido NA HORA do pedido.
 */
function useSlotSearch(input: {
  organizationId: Id<"organizations">;
  state: BookingState;
  tz: string;
  rescheduleAppointmentId?: Id<"schedAppointments">;
  durationMin: number | undefined;
}) {
  const convex = useConvex();
  const { organizationId, state, tz, rescheduleAppointmentId } = input;
  const [slots, setSlots] = useState<SlotsState>(EMPTY_SLOTS);
  const [nonce, setNonce] = useState(0);
  const [tick, setTick] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const durationRef = useRef(input.durationMin);
  durationRef.current = input.durationMin;
  const lastFilter = useRef<string | null>(null);
  const requestId = useRef(0);
  const onSlotStep = state.step === "slot";
  const filterKey = JSON.stringify([state.serviceId, state.variantKey, state.dayPreset, state.otherDate, state.period, state.pinned, partySizeOf(state)]);

  useEffect(() => {
    if (!onSlotStep) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [onSlotStep]);

  useEffect(() => {
    if (!onSlotStep) return;
    const now = Date.now();
    const args = buildFindSlotsArgs({ organizationId, state: stateRef.current, tz, now, rescheduleAppointmentId });
    if (!args) return;
    const filterChanged = lastFilter.current !== filterKey;
    lastFilter.current = filterKey;
    const id = ++requestId.current;
    if (filterChanged) setSlots(EMPTY_SLOTS);
    convex
      .query(api.scheduling.findSlots, args)
      .then((res) => {
        if (id !== requestId.current) return;
        const ctx = { tz, durationMin: durationRef.current };
        const incoming = res.slots.map((s) => normalizeOffered(s, ctx)).filter((s): s is OfferedSlot => s !== null);
        setSlots((prev) => ({
          status: "ready",
          slots: mergeRefreshedSlots(prev.slots, incoming, Date.now()),
          hasMore: res.hasMore,
          reason: res.reason,
          firstPossible: res.firstPossible ? normalizeOffered(res.firstPossible, ctx) : null,
        }));
      })
      .catch(() => {
        if (id !== requestId.current) return;
        // Rebusca silenciosa que falha mantém a lista; só a carga inicial mostra erro.
        setSlots((prev) => (prev.slots.length > 0 ? prev : { ...prev, status: "error" }));
      });
  }, [convex, onSlotStep, filterKey, state.expanded, tick, nonce, organizationId, tz, rescheduleAppointmentId]);

  /** Recarrega do zero (tentar de novo; horário tomado). */
  const reload = useCallback(() => {
    lastFilter.current = null;
    setNonce((n) => n + 1);
  }, []);
  return { slots, reload };
}

function BookingFlow({ organizationId, onClose, who, reschedule, initialService, initialDate, initialTimeMin, initialPinned, onOpenAppointment, onDone, tz, services, resources, preferredServiceId, busy, setBusy }: FlowProps) {
  const bookAppointment = useMutation(api.schedulingMutations.bookAppointment);
  const rescheduleAppointment = useMutation(api.schedulingMutations.rescheduleAppointment);
  const undoBooking = useMutation(api.schedulingMutations.undoBooking);
  const previewBooking = useMutation(api.schedulingMutations.previewBooking);
  const now = useRoundedNow("minute");
  const today = zonedToday(now, tz);

  const [state, dispatch] = useReducer(
    bookingReducer,
    undefined,
    (): BookingState =>
      initialBookingState({
        services,
        preferredServiceId,
        serviceId: reschedule?.serviceId ?? initialService?.serviceId,
        variantKey: reschedule?.variantKey ?? initialService?.variantKey,
        idempotencyKey: newIdempotencyKey(),
        date: initialDate,
        pinned: initialPinned,
      })
  );
  const service = services.find((s) => s._id === state.serviceId);
  const durationMin = chosenDurationMin(service, state.variantKey);
  const clientName = clientLabel(who.name, who.phone ? formatPhone(who.phone) : undefined);
  const whoOk = Boolean(reschedule) || hasWho(who);
  const { slots, reload } = useSlotSearch({ organizationId, state, tz, rescheduleAppointmentId: reschedule?.appointmentId, durationMin });
  const [failure, setFailure] = useState<FailureView | null>(null);
  const resourceList = useMemo(() => resources.map((r) => ({ _id: r._id as string, name: r.name, kind: r.kind, capacity: r.capacity, active: r.active })), [resources]);

  /** Toast "Desfazer": tudo ou nada; recusa mostra o motivo e abre o painel do horário. */
  const runUndo = async (ids: readonly string[]) => {
    const out = await undoFreshBooking(undoBooking, { organizationId, appointmentIds: ids });
    if (out.kind === "ok") toast.success(t.toast.undone);
    else if (out.kind === "refused") {
      const first = ids[0] as Id<"schedAppointments">;
      toast.error(undoRefusedText(out.message), {
        action: onOpenAppointment ? { label: t.slot.openExisting, onClick: () => onOpenAppointment(first) } : undefined,
      });
    } else toast.error(mutationErrorMessage(out.error, t.toast.undoFailed));
  };

  const submit = async (force?: string[]) => {
    if (busy) return;
    setBusy(true);
    try {
      const out = await submitBooking(
        { book: bookAppointment, reschedule: rescheduleAppointment },
        { organizationId, state, who, rescheduleAppointmentId: reschedule?.appointmentId, force, tz, now: Date.now(), durationMin }
      );
      switch (out.kind) {
        case "invalid":
          return;
        case "rescheduled":
          toast.success(VOCAB.scheduling.toast.rescheduled, out.newAppointmentId ? { action: { label: VOCAB.scheduling.undo, onClick: () => void runUndo([out.newAppointmentId!]) } } : undefined);
          onDone?.({ appointmentIds: [out.appointmentId], rescheduled: true });
          setFailure(null);
          onClose();
          return;
        case "booked": {
          const ids = out.appointmentIds;
          toast.success(VOCAB.scheduling.toast.booked, {
            action: {
              label: VOCAB.scheduling.undo,
              onClick: () => {
                void runUndo(ids);
              },
            },
          });
          onDone?.({ appointmentIds: ids, rescheduled: false });
          setFailure(null);
          onClose();
          return;
        }
        case "duplicate": {
          // Já existia: nada foi criado, então NÃO há "Desfazer" (cancelaria o horário verdadeiro).
          const existing = out.appointmentId as Id<"schedAppointments"> | undefined;
          toast.info(fillVocab(t.slot.duplicate, { nome: clientName }), {
            action: existing && onOpenAppointment ? { label: t.slot.openExisting, onClick: () => onOpenAppointment(existing) } : undefined,
          });
          setFailure(null);
          onClose();
          return;
        }
        case "rules":
          setFailure({ violations: out.violations, alternatives: out.alternatives, source: state.slot?.manual ? "manual" : "suggestion" });
          // Bloqueio (horário tomado, capacidade): volta ao passo 2 com a busca refeita.
          if (out.blocked) {
            dispatch({ type: "goto", step: "slot" });
            reload();
          }
          return;
        case "error":
          toast.error(mutationErrorMessage(out.error, VOCAB.scheduling.toast.failed));
          return;
      }
    } finally {
      setBusy(false);
    }
  };

  const previewManual = async (startTime: number): Promise<ManualPreviewResult> => {
    // Remarcar: a prévia é a da REMARCAÇÃO (o servidor ignora as alocações do próprio agendamento).
    const args = buildBookArgs({
      organizationId,
      state: { ...state, slot: { startTime, endTime: null, resourceIds: [], resourceNames: [], reasons: [], manual: true, warnings: [] } },
      who,
      mode: "preview",
      rescheduleAppointmentId: reschedule?.appointmentId,
    });
    if (!args) return { kind: "error", message: t.slot.manualInvalid };
    try {
      return interpretPreview(await previewBooking(args), { tz, now: Date.now(), durationMin });
    } catch (e) {
      return { kind: "error", message: mutationErrorMessage(e, VOCAB.scheduling.toast.failed) };
    }
  };

  return (
    <BookingFlowView
      state={state}
      dispatch={dispatch}
      services={services}
      resources={resourceList}
      tz={tz}
      today={today}
      slots={slots}
      clientName={clientName}
      whoOk={whoOk}
      initialTimeMin={initialDate ? initialTimeMin : undefined}
      reschedule={reschedule ? { fromStartTime: reschedule.startTime } : null}
      busy={busy}
      failure={failure}
      onRetry={reload}
      onSubmit={() => void submit()}
      onForce={(codes) => void submit(codes)}
      onPickOffered={(slot) => {
        setFailure(null);
        dispatch({ type: "pickSlot", slot: pickedFromOffered(slot) });
      }}
      onDismissFailure={() => setFailure(null)}
      onPreviewManual={previewManual}
      onOpenExisting={onOpenAppointment ? (id) => onOpenAppointment(id as Id<"schedAppointments">) : undefined}
    />
  );
}
