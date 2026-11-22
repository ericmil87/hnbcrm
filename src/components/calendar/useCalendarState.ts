import { useState, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  defaultCalendarView,
  formatDateParam,
  parseCalendarParams,
  parseDateParam,
  type CalendarView,
} from "@/lib/calendarParams";
import { addDays, addMonthsClamped, visibleRange } from "@/lib/agendaDates";

/**
 * Estado da Agenda guardado na URL: `?view=day|week|month&date=YYYY-MM-DD&event=<id>`.
 * `view`/`date` trocam a entrada do histórico (replace); `event` empilha (push),
 * para o Voltar fechar o detalhe. `forcedView` fixa a visão (página embutida, sem seletor próprio).
 */
export function useCalendarState(options: { forcedView?: CalendarView } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const parsed = parseCalendarParams(searchParams, defaultCalendarView(isMobile));
  // Embutida na Agenda nova a visão é a que a página de fora escolheu (ela tem o seletor; `?view=` é dela).
  const view = options.forcedView ?? parsed.view;
  const eventParam = parsed.event;
  // `parseCalendarParams` devolve um Date novo a cada render: memoiza pela string do parâmetro.
  const dateParam = searchParams.get("date");
  const date = useMemo(() => parseDateParam(dateParam), [dateParam]);
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
