import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { CalendarClock, Plus } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { AppointmentStatusChip } from "@/components/agenda/AppointmentStatusChip";
import { LazyAppointmentDetailPanel } from "@/components/agenda/detail/LazyAppointmentDetailPanel";
import { LazyBookingSheet } from "@/components/agenda/booking/LazyBookingSheet";
import { useRoundedNow } from "@/components/agenda/booking/useRoundedNow";
import { useOrgTimezone } from "@/hooks/useOrgTimezone";
import { zonedDateTimeLabel } from "@/lib/agendaZone";
import { TAB_ROUTES } from "@/lib/routes";
import { VOCAB } from "@/lib/vocab";

export interface AppointmentsBlockProps {
  organizationId: Id<"organizations">;
  /** Um dos dois: o bloco do lead lista também os do contato dele (o servidor junta). */
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  /** Nome (ou telefone formatado) para o passo 3 de "Marcar horário". */
  name?: string;
  /** Telefone cru (a folha formata se faltar nome). */
  phone?: string;
}

export function AppointmentsBlockInner({ organizationId, leadId, contactId, name, phone, canBook }: AppointmentsBlockProps & { canBook: boolean }) {
  const tz = useOrgTimezone(organizationId);
  const navigate = useNavigate();
  const now = useRoundedNow("hour");
  const forLead = useQuery(api.scheduling.listForLead, leadId ? { leadId, now } : "skip");
  const forContact = useQuery(api.scheduling.listForContact, !leadId && contactId ? { contactId, now } : "skip");
  const related = leadId ? forLead : forContact;
  const [openId, setOpenId] = useState<Id<"schedAppointments"> | null>(null);
  const [booking, setBooking] = useState(false);

  return (
    <>
      <AppointmentsBlockView
        headingId={`appointments-${leadId ?? contactId}`}
        tz={tz}
        upcoming={related?.upcoming ?? []}
        recent={(related?.recent ?? []).filter((r) => !related?.upcoming.some((u) => u._id === r._id))}
        loaded={related !== undefined}
        canBook={canBook}
        onOpen={(id) => setOpenId(id as Id<"schedAppointments">)}
        onBook={() => setBooking(true)}
      />
      <LazyAppointmentDetailPanel
        organizationId={organizationId}
        appointmentId={openId}
        onClose={() => setOpenId(null)}
        onOpenConversation={(conversationId) => navigate(`${TAB_ROUTES.inbox}?conversation=${conversationId}`)}
      />
      <LazyBookingSheet
        organizationId={organizationId}
        open={booking}
        onClose={() => setBooking(false)}
        who={{ leadId, contactId, name, phone }}
        onOpenAppointment={(id) => {
          setBooking(false);
          setOpenId(id);
        }}
      />
    </>
  );
}

export interface BlockRow {
  _id: string;
  serviceName: string;
  startTime: number;
  status: string;
}

export interface AppointmentsBlockViewProps {
  headingId: string;
  tz: string;
  upcoming: BlockRow[];
  recent: BlockRow[];
  loaded: boolean;
  canBook: boolean;
  onOpen: (id: string) => void;
  onBook: () => void;
}

/** Aparência do bloco (testável sem Convex). */
export function AppointmentsBlockView({ headingId, tz, upcoming, recent, loaded, canBook, onOpen, onBook }: AppointmentsBlockViewProps) {
  const t = VOCAB.scheduling.block;
  const list = (title: string, rows: BlockRow[]) =>
    rows.length === 0 ? null : (
      <div className="space-y-1.5">
        <h4 className="text-caption font-semibold uppercase tracking-wide text-text-muted">{title}</h4>
        <ul className="space-y-1.5">
          {rows.map((a) => (
            <li key={a._id}>
              <button
                type="button"
                onClick={() => onOpen(a._id)}
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
    <section aria-labelledby={headingId} className="mb-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          <CalendarClock size={14} aria-hidden="true" />
          {t.title}
        </h3>
        {canBook && (
          <Button type="button" variant="ghost" size="sm" onClick={onBook}>
            <Plus size={14} aria-hidden="true" />
            {VOCAB.scheduling.book}
          </Button>
        )}
      </div>
      {loaded && upcoming.length === 0 && recent.length === 0 && <p className="text-sm text-text-secondary">{VOCAB.scheduling.empty.forContact.title}</p>}
      {list(t.upcoming, upcoming)}
      {list(t.recent, recent)}
    </section>
  );
}
