import { lazy, Suspense } from "react";
import type { BookingSheetProps } from "./BookingSheet";

export type { BookingSheetProps, BookingSheetWho, BookingDoneInfo } from "./BookingSheet";

const BookingSheetChunk = lazy(() => import("./BookingSheet").then((m) => ({ default: m.BookingSheet })));

/**
 * `BookingSheet` carregado sob demanda: as entradas (conversa, lead, contato) ficam no pacote de TODAS as
 * telas, e a folha (com `bookingFlow`, textos e listas) só baixa quando alguém pede "Marcar horário".
 * Importe esta, nunca `BookingSheet` direto, em pontos de entrada.
 */
export function LazyBookingSheet(props: BookingSheetProps) {
  if (!props.open) return null;
  return (
    <Suspense fallback={null}>
      <BookingSheetChunk {...props} />
    </Suspense>
  );
}
