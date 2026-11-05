import { describe, expect, it } from "vitest";
import { formatDateParam, parseCalendarParams, parseDateParam } from "./calendarParams";

describe("parseDateParam", () => {
  it("lê YYYY-MM-DD como data local", () => {
    const d = parseDateParam("2025-03-09")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2025, 2, 9]);
  });

  it("rejeita formato e dias inexistentes", () => {
    expect(parseDateParam(null)).toBeNull();
    expect(parseDateParam("")).toBeNull();
    expect(parseDateParam("09/03/2025")).toBeNull();
    expect(parseDateParam("2025-3-9")).toBeNull();
    expect(parseDateParam("2025-02-30")).toBeNull();
    expect(parseDateParam("2025-13-01")).toBeNull();
  });

  it("aceita 29/02 em ano bissexto", () => {
    expect(parseDateParam("2024-02-29")).not.toBeNull();
    expect(parseDateParam("2025-02-29")).toBeNull();
  });
});

describe("formatDateParam", () => {
  it("faz ida e volta", () => {
    expect(formatDateParam(parseDateParam("2025-12-01")!)).toBe("2025-12-01");
    expect(formatDateParam(new Date(2025, 0, 5, 23, 59))).toBe("2025-01-05");
  });
});

describe("parseCalendarParams", () => {
  it("usa o padrão sem parâmetros", () => {
    expect(parseCalendarParams("")).toEqual({ view: "day", date: null, event: null });
  });

  it("lê view, date e event", () => {
    const p = parseCalendarParams("?view=week&date=2025-03-09&event=ev1");
    expect(p.view).toBe("week");
    expect(formatDateParam(p.date!)).toBe("2025-03-09");
    expect(p.event).toBe("ev1");
  });

  it("ignora valores inválidos", () => {
    const p = parseCalendarParams("?view=year&date=abc&event=");
    expect(p).toEqual({ view: "day", date: null, event: null });
  });

  it("aceita URLSearchParams", () => {
    expect(parseCalendarParams(new URLSearchParams("view=month")).view).toBe("month");
  });
});
