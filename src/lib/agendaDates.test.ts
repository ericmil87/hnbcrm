import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  addMonthsClamped,
  endOfMonth,
  endOfWeek,
  formatLocalDate,
  formatLocalTime,
  isSameDay,
  localDateKey,
  monthGridDays,
  orderWeekdayLabels,
  overlapsDay,
  parseLocalDateTime,
  startOfWeek,
  visibleRange,
  weekDays,
} from "./agendaDates";

const ZONES = ["America/Sao_Paulo", "America/New_York", "Pacific/Auckland"];
const original = process.env.TZ;

afterAll(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

describe.each(ZONES)("agendaDates em %s", (zone) => {
  beforeAll(() => {
    process.env.TZ = zone;
  });

  it("o runtime respeitou o fuso do teste", () => {
    expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(
      { "America/Sao_Paulo": 180, "America/New_York": 240, "Pacific/Auckland": -720 }[zone]
    );
  });

  it("data + hora locais viram epoch e voltam sem deslocar o dia", () => {
    for (const [d, t] of [["2026-11-21", "10:00"], ["2026-11-21", "23:30"], ["2026-01-01", "00:00"]] as const) {
      const ms = parseLocalDateTime(d, t)!;
      expect(formatLocalDate(ms)).toBe(d);
      expect(formatLocalTime(ms)).toBe(t);
    }
  });

  it("editar e salvar sem mexer na data é idempotente (bug do dia a menos)", () => {
    let ms = parseLocalDateTime("2026-11-21", "22:30")!;
    for (let i = 0; i < 3; i++) {
      ms = parseLocalDateTime(formatLocalDate(ms), formatLocalTime(ms))!;
    }
    expect(localDateKey(ms)).toBe("2026-11-21");
    expect(formatLocalTime(ms)).toBe("22:30");
  });

  it("rejeita data/hora inválidas", () => {
    expect(parseLocalDateTime("2026-02-30", "10:00")).toBeNull();
    expect(parseLocalDateTime("2026-11-21", "25:00")).toBeNull();
    expect(parseLocalDateTime("21/11/2026", "10:00")).toBeNull();
    expect(parseLocalDateTime("2026-11-21", "")).toBeNull();
    expect(parseLocalDateTime("", "10:00")).toBeNull();
  });

  it("soma meses fixando no último dia", () => {
    expect(localDateKey(addMonthsClamped(new Date(2026, 0, 31, 12), 1))).toBe("2026-02-28");
    expect(localDateKey(addMonthsClamped(new Date(2026, 2, 31, 12), -1))).toBe("2026-02-28");
    expect(localDateKey(addMonthsClamped(new Date(2028, 0, 31, 12), 1))).toBe("2028-02-29");
    expect(localDateKey(addMonthsClamped(new Date(2026, 11, 15, 12), 1))).toBe("2027-01-15");
    expect(localDateKey(addMonthsClamped(new Date(2026, 0, 15, 12), -1))).toBe("2025-12-15");
  });

  it("semana começa na segunda e termina no domingo", () => {
    const sat = new Date(2026, 10, 21, 15); // sábado
    expect(localDateKey(startOfWeek(sat))).toBe("2026-11-16");
    expect(localDateKey(endOfWeek(sat))).toBe("2026-11-22");
    const sun = new Date(2026, 10, 22, 9);
    expect(localDateKey(startOfWeek(sun))).toBe("2026-11-16");
    expect(localDateKey(startOfWeek(sun, 0))).toBe("2026-11-22");
    expect(weekDays(sat).map(localDateKey)).toEqual([
      "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22",
    ]);
  });

  it("grade do mês tem 42 dias e a janela buscada cobre todos", () => {
    const days = monthGridDays(new Date(2026, 10, 10));
    expect(days).toHaveLength(42);
    expect(localDateKey(days[0])).toBe("2026-10-26");
    expect(localDateKey(days[41])).toBe("2026-12-06");
    const r = visibleRange("month", new Date(2026, 10, 10));
    expect(r.startDate).toBe(days[0].getTime());
    expect(localDateKey(r.endDate)).toBe("2026-12-06");
    expect(new Date(r.endDate).getHours()).toBe(23);
  });

  it("fim do mês e addDays atravessam virada de mês/ano", () => {
    expect(localDateKey(endOfMonth(new Date(2026, 1, 3)))).toBe("2026-02-28");
    expect(localDateKey(addDays(new Date(2026, 11, 31, 12), 1))).toBe("2027-01-01");
  });

  it("visibleRange de dia e semana", () => {
    const day = visibleRange("day", new Date(2026, 10, 21, 15));
    expect(localDateKey(day.startDate)).toBe("2026-11-21");
    expect(formatLocalTime(day.startDate)).toBe("00:00");
    expect(formatLocalTime(day.endDate)).toBe("23:59");
    const week = visibleRange("week", new Date(2026, 10, 21, 15));
    expect(localDateKey(week.startDate)).toBe("2026-11-16");
    expect(localDateKey(week.endDate)).toBe("2026-11-22");
  });

  it("overlapsDay é semiaberto e trata duração zero", () => {
    const s = parseLocalDateTime("2026-11-21", "22:00")!;
    const e = parseLocalDateTime("2026-11-22", "02:00")!;
    expect(overlapsDay(s, e, new Date(2026, 10, 21, 12))).toBe(true);
    expect(overlapsDay(s, e, new Date(2026, 10, 22, 12))).toBe(true);
    expect(overlapsDay(s, e, new Date(2026, 10, 23, 12))).toBe(false);
    const midnight = parseLocalDateTime("2026-11-22", "00:00")!;
    expect(overlapsDay(s, midnight, new Date(2026, 10, 22, 12))).toBe(false);
    expect(overlapsDay(s, s, new Date(2026, 10, 21, 1))).toBe(true);
    expect(overlapsDay(s, s, new Date(2026, 10, 22, 1))).toBe(false);
    expect(isSameDay(s, e)).toBe(false);
  });
});

describe("agendaDates e horário de verão (New York)", () => {
  beforeAll(() => {
    process.env.TZ = "America/New_York";
  });

  it("dia de virada tem 23h mas a semana e o mês continuam certos", () => {
    // 08/03/2026: início do horário de verão nos EUA.
    const week = weekDays(new Date(2026, 2, 8, 12));
    expect(week.map(localDateKey)).toContain("2026-03-08");
    expect(week.every((d) => d.getHours() === 0)).toBe(true);
    expect(localDateKey(addDays(new Date(2026, 2, 7, 12), 1))).toBe("2026-03-08");
    expect(monthGridDays(new Date(2026, 2, 8))).toHaveLength(42);
    expect(new Set(monthGridDays(new Date(2026, 2, 8)).map(localDateKey)).size).toBe(42);
  });
});

describe("orderWeekdayLabels", () => {
  const labels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
  it("começa na segunda por padrão e respeita o domingo", () => {
    expect(orderWeekdayLabels(labels)).toEqual(["Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"]);
    expect(orderWeekdayLabels(labels, 0)).toEqual(labels);
  });
});
