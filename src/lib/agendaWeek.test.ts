import { describe, expect, it } from "vitest";
import { addShift, copyDayTo, emptyWeek, splitWithLunch, weekErrors, weekFromWeekly, weekSummary, weeklyFromWeek, weekWith, WEEK_GENERAL_ERROR } from "./agendaWeek";

describe("agendaWeek", () => {
  it("converte ida e volta, ordenado", () => {
    const weekly = [
      { weekday: 1, startMin: 840, endMin: 1080 },
      { weekday: 1, startMin: 540, endMin: 720 },
    ];
    const r = weeklyFromWeek(weekFromWeekly(weekly));
    expect(r).toEqual({ ok: true, weekly: [{ weekday: 1, startMin: 540, endMin: 720 }, { weekday: 1, startMin: 840, endMin: 1080 }] });
  });
  it("recusa turno que cruza a meia-noite e sobreposição", () => {
    expect(weekErrors(weekWith([1], [{ start: "22:00", end: "02:00" }]))[1]).toMatch(/meia-noite/);
    expect(weekErrors(weekWith([2], [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }]))[2]).toMatch(/sobrepor/);
    expect(weeklyFromWeek(weekWith([1], [{ start: "", end: "10:00" }])).ok).toBe(false);
  });
  it("limita 28 turnos", () => {
    const w = weekWith([0, 1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5].map((i) => ({ start: `0${i}:00`, end: `0${i}:30` })));
    expect(weekErrors(w)[WEEK_GENERAL_ERROR]).toMatch(/28/);
  });
  it("copia dia, adiciona turno e divide com almoço", () => {
    const w = weekWith([1], [{ start: "09:00", end: "18:00" }]);
    expect(copyDayTo(w, 1, [2, 3])[3]).toEqual([{ start: "09:00", end: "18:00" }]);
    expect(splitWithLunch(w, 1)[1]).toEqual([{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }]);
    expect(addShift(emptyWeek(), 4)[4]).toEqual([{ start: "09:00", end: "18:00" }]);
    expect(addShift(splitWithLunch(w, 1), 1)[1]).toHaveLength(3);
  });
  it("resume dias iguais", () => {
    const w = weekWith([1, 2, 3, 4, 5], [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }]);
    w[6] = [{ start: "09:00", end: "12:00" }];
    expect(weekSummary(w)).toBe("Seg a sex: 09:00–12:00 e 14:00–18:00 · Sáb: 09:00–12:00");
    expect(weekSummary(emptyWeek())).toBe("Sem horário");
  });
  it("preserva 24:00 na ida e na volta", () => {
    const weekly = [{ weekday: 5, startMin: 1200, endMin: 1440 }];
    const w = weekFromWeekly(weekly);
    expect(w[5][0].end).toBe("24:00");
    expect(weeklyFromWeek(w)).toEqual({ ok: true, weekly });
  });
});
