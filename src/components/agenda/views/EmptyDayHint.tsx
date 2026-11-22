import { VIEWS_COPY } from "@/lib/agendaViewsCopy";

/**
 * Dica do dia vazio ("Toque em um horário livre..."). Fica SOBRE a grade (absoluta, sem capturar o toque) e não numa
 * faixa acima dela: aparecer e sumir empurrava a grade 28 px para baixo e para cima.
 */
export function EmptyDayHint() {
  return (
    <p
      role="status"
      data-empty-hint=""
      className="pointer-events-none absolute inset-x-2 top-16 z-40 mx-auto w-fit max-w-full rounded-full border border-border bg-surface-raised px-3 py-1 text-center text-sm text-text-secondary shadow-card"
    >
      {VIEWS_COPY.list.empty.hint}
    </p>
  );
}
