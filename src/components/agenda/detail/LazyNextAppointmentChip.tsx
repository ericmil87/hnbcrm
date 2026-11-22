import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { NextAppointmentChip } from "./NextAppointmentChip";

const Chunk = lazy(() => import("./NextAppointmentChip").then((m) => ({ default: m.NextAppointmentChip })));

/** Chip do próximo horário sob demanda: a formatação no fuso da org só baixa quando há próximo agendamento. */
export function LazyNextAppointmentChip(props: ComponentProps<typeof NextAppointmentChip>) {
  return (
    <Suspense fallback={null}>
      <Chunk {...props} />
    </Suspense>
  );
}
