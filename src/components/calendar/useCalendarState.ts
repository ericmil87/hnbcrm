import { useState, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  defaultCalendarView,
  formatDateParam,
  parseCalendarParams,
  type CalendarView,
} from "@/lib/calendarParams";
import { addDays, addMonthsClamped, visibleRange } from "@/lib/agendaDates";

/**
 * Estado da Agenda guardado na URL: `?view=day|week|month&date=YYYY-MM-DD&event=<id>`.
 * `view`/`date` trocam a entrada do histórico (replace); `event` empilha (push),
 * para o Voltar fechar o detalhe.
 */
export function useCalendarState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const { view, date, event: eventParam } = parseCalendarParams(searchParams, defaultCalendarView(isMobile));
  // Sem `?date=`, a Agenda abre em "agora" (fixado na montagem).
  const [fallbackDate] = useState(() => new Date());
  const currentDate = useMemo(() => date ?? fallbackDate, [date, fallbackDate]);

  const update = useCallback(
    (changes: Record<string, string | null>, push: boolean, keepScroll = false) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(changes)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: !push, preventScrollReset: keepScroll }
      );
    },
    [setSearchParams]
  );

  const setView = (next: CalendarView) => update({ view: next }, false);
  const setCurrentDate = (next: Date) => update({ date: formatDateParam(next) }, false);
  const setSelectedEvent = (id: string | null) =>
    id === null ? update({ event: null }, false, true) : update({ event: id }, true);

  // Janela buscada = exatamente o que a visão desenha (mês: as 6 linhas da grade).
  const dateRange = useMemo(() => visibleRange(view, currentDate), [currentDate, view]);

  const navigate = (direction: 1 | -1) => {
    const next =
      view === "month"
        ? addMonthsClamped(currentDate, direction)
        : addDays(currentDate, (view === "week" ? 7 : 1) * direction);
    setCurrentDate(next);
  };
  const navigatePrev = () => navigate(-1);
  const navigateNext = () => navigate(1);

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const selectDay = (day: Date) => {
    update({ date: formatDateParam(day), view: "day" }, false);
  };

  return {
    view,
    setView,
    currentDate,
    dateRange,
    navigatePrev,
    navigateNext,
    goToToday,
    selectDay,
    eventParam,
    setSelectedEvent,
  };
}
