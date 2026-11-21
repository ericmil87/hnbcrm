/**
 * Agenda v2 (B3): ponto ÚNICO que liga o horário clicado na grade (ou o "+ livre") à folha de marcar horário.
 * O minuto (do dia, no fuso da org) fica no estado da página até a folha abrir e vira a prop
 * `initialTimeMin` do `BookingSheet` (que só a usa junto de `initialDate`).
 */
export function bookingSheetExtraProps(minute: number | undefined): { initialTimeMin?: number } {
  return minute === undefined ? {} : { initialTimeMin: minute };
}

/** Texto do seletor de cliente: dia e lugar, sem prometer a hora enquanto a folha não a recebe. */
export function bookingContextParts(dateLabel: string, resourceName: string | undefined): string {
  return resourceName ? `${dateLabel} · ${resourceName}` : dateLabel;
}

export interface RebookSource {
  serviceId?: string;
  variantKey?: string;
  contactId?: string;
  leadId?: string;
  conversationId?: string;
  contactName?: string;
  guestName?: string;
}

/**
 * "Marcar de novo" de uma proposta vencida: o mesmo cliente (contato, lead e/ou conversa) e o mesmo serviço.
 * `null` quando falta o serviço ou não há quem marcar (agendamento de convidado sem contato).
 */
export function rebookTarget(a: RebookSource): {
  who: { contactId?: string; leadId?: string; conversationId?: string; name?: string };
  service: { serviceId: string; variantKey?: string };
} | null {
  if (!a.serviceId || !(a.contactId || a.leadId || a.conversationId)) return null;
  const name = (a.contactName ?? a.guestName)?.trim();
  return {
    who: {
      ...(a.contactId ? { contactId: a.contactId } : {}),
      ...(a.leadId ? { leadId: a.leadId } : {}),
      ...(a.conversationId ? { conversationId: a.conversationId } : {}),
      ...(name ? { name } : {}),
    },
    service: { serviceId: a.serviceId, ...(a.variantKey ? { variantKey: a.variantKey } : {}) },
  };
}
