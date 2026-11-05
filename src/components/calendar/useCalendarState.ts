import { useState, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  defaultCalendarView,
  formatDateParam,
  parseCalendarParams,
  type CalendarView,
} from "@/lib/calendarParams";

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

  const dateRange = useMemo(() => {
    const start = new Date(currentDate);
    const end = new Date(currentDate);

    if (view === "month") {
      // Get first day of month, then go back to start of week (Monday)
      start.setDate(1);
      const dayOfWeek = start.getDay();
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Monday is 0
      start.setDate(start.getDate() - diff);
      start.setHours(0, 0, 0, 0);

      // Get last day of month, then go forward to end of week (Sunday)
      end.setMonth(end.getMonth() + 1, 0); // Last day of current month
      const lastDayOfWeek = end.getDay();
      const daysToAdd = lastDayOfWeek === 0 ? 0 : 7 - lastDayOfWeek;
      end.setDate(end.getDate() + daysToAdd);
      end.setHours(23, 59, 59, 999);
    } else if (view === "week") {
      // Get Monday of current week
      const dayOfWeek = start.getDay();
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      start.setDate(start.getDate() - diff);
      start.setHours(0, 0, 0, 0);

      // Get Sunday of current week
      end.setTime(start.getTime());
      end.setDate(end.getDate() + 6);
      end.setHours(23, 59, 59, 999);
    } else {
      // Day view
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    }

    return { startDate: start.getTime(), endDate: end.getTime() };
  }, [currentDate, view]);

  const navigatePrev = () => {
    const newDate = new Date(currentDate);
    if (view === "month") {
      newDate.setMonth(newDate.getMonth() - 1);
    } else if (view === "week") {
      newDate.setDate(newDate.getDate() - 7);
    } else {
      newDate.setDate(newDate.getDate() - 1);
    }
    setCurrentDate(newDate);
  };

  const navigateNext = () => {
    const newDate = new Date(currentDate);
    if (view === "month") {
      newDate.setMonth(newDate.getMonth() + 1);
    } else if (view === "week") {
      newDate.setDate(newDate.getDate() + 7);
    } else {
      newDate.setDate(newDate.getDate() + 1);
    }
    setCurrentDate(newDate);
  };

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
