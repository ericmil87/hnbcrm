import { useState, type ReactNode } from "react";
import { CalendarPlus } from "lucide-react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { AppointmentDetailPanel } from "@/components/agenda/detail/AppointmentDetailPanel";
import { NextAppointmentChip } from "@/components/agenda/detail/NextAppointmentChip";
import { BookingSheet } from "@/components/agenda/booking/BookingSheet";
import { useSchedulingGate } from "@/components/agenda/booking/useSchedulingGate";
import { VOCAB } from "@/lib/vocab";

interface ConversationBookingInput {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  leadId?: Id<"leads">;
  contactId?: Id<"contacts">;
  name?: string;
  /** Grupo não tem lead nem contato: sem entrada. */
  isGroup: boolean;
}

export interface ConversationBooking {
  /** Há alguma peça visível (chip depende de dados; o menu, da permissão). */
  enabled: boolean;
  /** Chip do próximo horário (para a faixa de detalhes). */
  chip: ReactNode;
  /** Item "Marcar horário" para o menu da conversa (recebe o fechador do menu). `undefined` = sem permissão. */
  menuItem: ((close: () => void) => ReactNode) | undefined;
  /** Folha de marcar e painel do agendamento (montar uma vez no cabeçalho). */
  overlays: ReactNode;
}

/**
 * Entradas da Agenda v2 na conversa: chip do próximo horário, "Marcar horário" no menu e as camadas.
 * Módulo desligado: `enabled` falso, nada para renderizar e nenhuma query da agenda.
 */
export function useConversationBooking({ organizationId, conversationId, leadId, contactId, name, isGroup }: ConversationBookingInput): ConversationBooking {
  const gate = useSchedulingGate(organizationId);
  const [booking, setBooking] = useState(false);
  const [openId, setOpenId] = useState<Id<"schedAppointments"> | null>(null);
  const active = gate.enabled && !isGroup;
  if (!active) return { enabled: false, chip: null, menuItem: undefined, overlays: null };
  return {
    enabled: true,
    chip: <NextAppointmentChip organizationId={organizationId} conversationId={conversationId} onOpen={setOpenId} />,
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
        {booking && (
          <BookingSheet organizationId={organizationId} open onClose={() => setBooking(false)} who={{ conversationId, leadId, contactId, name }} />
        )}
        <AppointmentDetailPanel organizationId={organizationId} appointmentId={openId} onClose={() => setOpenId(null)} />
      </>
    ),
  };
}
