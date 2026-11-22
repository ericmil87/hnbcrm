/**
 * Agenda v2 (B3): ponto ÚNICO que liga o horário clicado na grade (ou o "+ livre") à folha de marcar horário.
 * O minuto (do dia, no fuso da org) fica no estado da página até a folha abrir e vira a prop
 * `initialTimeMin` do `BookingSheet` (que só a usa junto de `initialDate`).
 */
import { minutesLabel, zonedDateKey, zonedToday, type LocalDate } from "./agendaZone";

export function bookingSheetExtraProps(minute: number | undefined): { initialTimeMin?: number } {
  return minute === undefined ? {} : { initialTimeMin: minute };
}

/** Texto do seletor de cliente: dia, hora clicada (quando houve) e lugar: "seg, 14/12 · 15:00 · Sala 1". */
export function bookingContextParts(dateLabel: string, resourceName: string | undefined, minute?: number): string {
  return [dateLabel, minute !== undefined ? minutesLabel(minute) : undefined, resourceName].filter(Boolean).join(" · ");
}

/**
 * Onde a folha de REMARCAR abre: no dia do agendamento (se ainda é hoje ou futuro; se já passou, em hoje) e com
 * a sala/profissional atuais fixados (um por tipo; recurso sem lugar não entra). O serviço já vem do agendamento.
 */
export function rescheduleDefaults(input: {
  startTime: number | undefined;
  now: number;
  tz: string;
  resourceIds: readonly string[] | undefined;
  resources: ReadonlyArray<{ _id: string; kind: string }>;
}): { date: LocalDate; pinned: Record<string, string> } {
  const today = zonedToday(input.now, input.tz);
  const day = input.startTime !== undefined ? zonedDateKey(input.startTime, input.tz) : today;
  const kindOf = new Map(input.resources.map((r) => [r._id, r.kind]));
  const pinned: Record<string, string> = {};
  for (const id of input.resourceIds ?? []) {
    const kind = kindOf.get(id);
    if (kind && pinned[kind] === undefined) pinned[kind] = id;
  }
  return { date: day >= today ? day : today, pinned };
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
