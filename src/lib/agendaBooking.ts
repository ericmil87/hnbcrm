/**
 * Agenda v2 (B3): ponto ÚNICO que liga o horário clicado na grade (ou o "+ livre") à folha de marcar horário.
 * O minuto (do dia, no fuso da org) fica no estado da página até a folha abrir; a prop `initialTimeMin` do
 * `BookingSheet` chega em outro PR e é ligada só aqui (hoje devolve `{}`: a folha abre no dia e no recurso).
 */
export function bookingSheetExtraProps(_minute: number | undefined): Record<string, never> {
  return {};
}

/** Texto do seletor de cliente: dia e lugar, sem prometer a hora enquanto a folha não a recebe. */
export function bookingContextParts(dateLabel: string, resourceName: string | undefined): string {
  return resourceName ? `${dateLabel} · ${resourceName}` : dateLabel;
}
