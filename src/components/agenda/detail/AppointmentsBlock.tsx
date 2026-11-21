import { useState } from "react";
import { useQuery } from "convex/react";
import { CalendarClock, Plus } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { AppointmentStatusChip } from "@/components/agenda/AppointmentStatusChip";
import { AppointmentDetailPanel } from "@/components/agenda/detail/AppointmentDetailPanel";
import { BookingSheet } from "@/components/agenda/booking/BookingSheet";
import { useRoundedNow } from "@/components/agenda/booking/useRoundedNow";
import { useSchedulingGate } from "@/components/agenda/booking/useSchedulingGate";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { zonedDateTimeLabel } from "@/lib/agendaZone";
import { VOCAB } from "@/lib/vocab";

interface AppointmentsBlockProps {
  organizationId: Id<"organizations">;
  /** Um dos dois: o bloco do lead lista também os do contato dele (o servidor junta). */
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  /** Nome para o passo 3 de "Marcar horário". */
  name?: string;
}

/** Bloco "Agendamentos" do lead/contato: próximos e recentes, abrir o painel e "Marcar horário". Módulo desligado = nada. */
export function AppointmentsBlock(props: AppointmentsBlockProps) {
  const gate = useSchedulingGate(props.organizationId);
  if (!gate.enabled) return null;
  return <AppointmentsBlockInner {...props} canBook={gate.canBook} />;
}

function AppointmentsBlockInner({ organizationId, leadId, contactId, name, canBook }: AppointmentsBlockProps & { canBook: boolean }) {
  const tz = useOrgTimezone(organizationId);
  const now = useRoundedNow("hour");
  const forLead = useQuery(api.scheduling.listForLead, leadId ? { leadId, now } : "skip");
  const forContact = useQuery(api.scheduling.listForContact, !leadId && contactId ? { contactId, now } : "skip");
  const related = leadId ? forLead : forContact;
  const [openId, setOpenId] = useState<Id<"schedAppointments"> | null>(null);
  const [booking, setBooking] = useState(false);
  const t = VOCAB.scheduling.block;

  const list = (title: string, rows: NonNullable<typeof related>["upcoming"]) =>
    rows.length === 0 ? null : (
      <div className="space-y-1.5">
        <h4 className="text-caption font-semibold uppercase tracking-wide text-text-muted">{title}</h4>
        <ul className="space-y-1.5">
          {rows.map((a) => (
            <li key={a._id}>
              <button
                type="button"
                onClick={() => setOpenId(a._id)}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-field px-2 text-left transition-colors hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-text-primary">{a.serviceName}</span>
                  <span className="block text-caption tabular-nums text-text-secondary">{zonedDateTimeLabel(a.startTime, tz)}</span>
                </span>
                <AppointmentStatusChip status={a.status} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <section aria-labelledby={`appointments-${leadId ?? contactId}`} className="mb-4 space-y-3 md:mb-0">
      <div className="flex items-center justify-between gap-2">
        <h3 id={`appointments-${leadId ?? contactId}`} className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          <CalendarClock size={14} aria-hidden="true" />
          {t.title}
        </h3>
        {canBook && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setBooking(true)}>
            <Plus size={14} aria-hidden="true" />
            {VOCAB.scheduling.book}
          </Button>
        )}
      </div>
      {related && related.upcoming.length === 0 && related.recent.length === 0 && (
        <p className="text-sm text-text-secondary">{VOCAB.scheduling.empty.forContact.title}</p>
      )}
      {related && (
        <>
          {list(t.upcoming, related.upcoming)}
          {list(t.recent, related.recent.filter((r) => !related.upcoming.some((u) => u._id === r._id)))}
        </>
      )}
      <AppointmentDetailPanel organizationId={organizationId} appointmentId={openId} onClose={() => setOpenId(null)} />
      {booking && (
        <BookingSheet organizationId={organizationId} open onClose={() => setBooking(false)} who={{ leadId, contactId, name }} />
      )}
    </section>
  );
}
