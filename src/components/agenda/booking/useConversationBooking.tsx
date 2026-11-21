import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { CalendarPlus } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { LazyAppointmentDetailPanel } from "@/components/agenda/detail/LazyAppointmentDetailPanel";
import { LazyNextAppointmentChip } from "@/components/agenda/detail/LazyNextAppointmentChip";
import { LazyBookingSheet } from "@/components/agenda/booking/LazyBookingSheet";
import { useRoundedNow } from "@/components/agenda/booking/useRoundedNow";
import { useSchedulingGate } from "@/components/agenda/booking/useSchedulingGate";
import { countUpcoming, pickNextAppointment } from "@/lib/nextAppointment";
import { gatedArgs } from "@/lib/schedulingGate";
import { VOCAB } from "@/lib/vocab";

interface ConversationBookingInput {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  /** Nome (ou telefone formatado) do cliente, para a revisão. */
  name?: string;
  /** Telefone cru (a folha formata se faltar nome). */
  phone?: string;
  /** Grupo não tem lead nem contato: sem entrada. */
  isGroup: boolean;
}

export interface ConversationBooking {
  /** Há um próximo agendamento: só então o chip entra na faixa de detalhes (faixa vazia não aparece). */
  hasNext: boolean;
  chip: ReactNode;
  /** Item "Marcar horário" para o menu da conversa (recebe o fechador do menu). `undefined` = sem permissão. */
  menuItem: ((close: () => void) => ReactNode) | undefined;
  /** Folha de marcar e painel do agendamento (montar uma vez no cabeçalho). */
  overlays: ReactNode;
}

const OFF: ConversationBooking = { hasNext: false, chip: null, menuItem: undefined, overlays: null };

/**
 * Entradas da Agenda v2 na conversa: chip do próximo horário, "Marcar horário" no menu e as camadas.
 * Dono da assinatura `listForConversation` (`"skip"` com o módulo desligado, sem permissão ou em grupo).
 * A folha e o painel são lazy: com o módulo desligado nada disso baixa.
 */
export function useConversationBooking({ organizationId, conversationId, leadId, contactId, name, phone, isGroup }: ConversationBookingInput): ConversationBooking {
  const gate = useSchedulingGate(organizationId);
  const active = gate.enabled && !isGroup;
  const hourNow = useRoundedNow("hour", active);
  const minuteNow = useRoundedNow("minute", active);
  const related = useQuery(api.scheduling.listForConversation, gatedArgs({ enabled: active }, { conversationId, now: hourNow, limit: 5 }));
  const [booking, setBooking] = useState(false);
  const [openId, setOpenId] = useState<Id<"schedAppointments"> | null>(null);
  if (!active) return OFF;

  const upcoming = related?.upcoming ?? [];
  const next = pickNextAppointment(upcoming, minuteNow);
  return {
    hasNext: next !== undefined,
    chip: next ? (
      <LazyNextAppointmentChip
        organizationId={organizationId}
        startTime={next.startTime}
        extra={Math.max(0, countUpcoming(upcoming, minuteNow) - 1)}
        onOpen={() => setOpenId(next._id)}
      />
    ) : null,
    menuItem: gate.canBook
      ? (close) => (
          <button
            type="button"
            onClick={() => {
              close();
              setBooking(true);
            }}
            className="w-full coarse:min-h-11 flex items-center gap-2.5 px-3 py-2 text-left text-sm text-text-primary hover:bg-surface-raised transition-colors"
          >
            <CalendarPlus size={15} aria-hidden="true" />
            {VOCAB.scheduling.book}
          </button>
        )
      : undefined,
    overlays: (
      <>
        <LazyBookingSheet
          organizationId={organizationId}
          open={booking}
          onClose={() => setBooking(false)}
          who={{ conversationId, leadId, contactId, name, phone }}
          onOpenAppointment={(id) => {
            setBooking(false);
            setOpenId(id);
          }}
        />
        <LazyAppointmentDetailPanel organizationId={organizationId} appointmentId={openId} onClose={() => setOpenId(null)} />
      </>
    ),
  };
}
