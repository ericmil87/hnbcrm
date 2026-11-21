import { CalendarPage } from "@/components/calendar/CalendarPage";

/**
 * Página da Agenda com o módulo `scheduling` LIGADO (ver `../AgendaEntry.tsx`).
 *
 * PROVISÓRIA (B0): hoje só repete a página de compromissos. O PR B3 substitui este arquivo pelo container
 * da v2 (visão por recurso, lista do dia, fila de pendências), com os compromissos internos entrando como
 * camada. Mantenha o export `AgendaPage` (o lazy de `AgendaEntry` o importa).
 */
export function AgendaPage() {
  return <CalendarPage />;
}
