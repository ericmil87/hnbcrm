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
