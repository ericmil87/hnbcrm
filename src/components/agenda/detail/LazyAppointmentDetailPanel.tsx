import { lazy, Suspense } from "react";
import type { AppointmentDetailPanelProps } from "./AppointmentDetailPanel";

export type { AppointmentDetailPanelProps } from "./AppointmentDetailPanel";

const PanelChunk = lazy(() => import("./AppointmentDetailPanel").then((m) => ({ default: m.AppointmentDetailPanel })));

/**
 * `AppointmentDetailPanel` carregado sob demanda (ver `LazyBookingSheet`): só baixa ao abrir um agendamento.
 * Pontos de entrada importam esta, nunca o painel direto.
 */
export function LazyAppointmentDetailPanel(props: AppointmentDetailPanelProps) {
  if (props.appointmentId === null) return null;
  return (
    <Suspense fallback={null}>
      <PanelChunk {...props} />
    </Suspense>
  );
}
