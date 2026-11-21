import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatLocalDate, formatLocalTime } from "./agendaDates";
import { buildEventTimes, endDateFieldValue } from "./agendaForm";

const original = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Sao_Paulo";
});
afterAll(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

const base = { startDate: "2026-11-21", startTime: "10:00", endDate: "", endTime: "11:00", allDay: false };
const ok = (r: ReturnType<typeof buildEventTimes>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("buildEventTimes", () => {
  it("evento comum no mesmo dia", () => {
    const r = ok(buildEventTimes(base));
    expect(formatLocalDate(r.startTime)).toBe("2026-11-21");
    expect(formatLocalTime(r.endTime)).toBe("11:00");
    expect(formatLocalDate(r.endTime)).toBe("2026-11-21");
  });

  it("fim antes do início sem data de término cruza a meia-noite (23:30 → 00:30)", () => {
    const r = ok(buildEventTimes({ ...base, startTime: "23:30", endTime: "00:30" }));
    expect(formatLocalDate(r.endTime)).toBe("2026-11-22");
    expect(formatLocalTime(r.endTime)).toBe("00:30");
  });

  it("editar e salvar um evento que cruza a meia-noite preserva início e fim", () => {
    const first = ok(buildEventTimes({ ...base, startTime: "23:30", endTime: "00:30" }));
    const second = ok(
      buildEventTimes({
        startDate: formatLocalDate(first.startTime),
        startTime: formatLocalTime(first.startTime),
        endDate: endDateFieldValue(first.startTime, first.endTime),
        endTime: formatLocalTime(first.endTime),
        allDay: false,
      })
    );
    expect(second).toEqual(first);
  });

  it("vários dias com data de término explícita", () => {
    const r = ok(buildEventTimes({ ...base, endDate: "2026-11-23", endTime: "18:00" }));
    expect(formatLocalDate(r.endTime)).toBe("2026-11-23");
    expect(formatLocalTime(r.endTime)).toBe("18:00");
  });

  it("data de término explícita anterior ao início é erro", () => {
    expect(buildEventTimes({ ...base, endDate: "2026-11-20" })).toEqual({ ok: false, error: "end_before_start" });
    expect(buildEventTimes({ ...base, endDate: "2026-11-21", startTime: "12:00", endTime: "11:00" }).ok).toBe(true);
  });

  it("duração zero é aceita", () => {
    const r = ok(buildEventTimes({ ...base, endTime: "10:00" }));
    expect(r.endTime).toBe(r.startTime);
  });

  it("dia inteiro: 00:00 até 23:59:59.999 do último dia", () => {
    const one = ok(buildEventTimes({ ...base, allDay: true }));
    expect(formatLocalTime(one.startTime)).toBe("00:00");
    expect(formatLocalTime(one.endTime)).toBe("23:59");
    expect(formatLocalDate(one.endTime)).toBe("2026-11-21");
    expect(one.endTime % 1000).toBe(999);
    const multi = ok(buildEventTimes({ ...base, allDay: true, endDate: "2026-11-24" }));
    expect(formatLocalDate(multi.endTime)).toBe("2026-11-24");
    expect(buildEventTimes({ ...base, allDay: true, endDate: "2026-11-20" })).toEqual({
      ok: false,
      error: "end_before_start",
    });
  });

  it("campos inválidos", () => {
    expect(buildEventTimes({ ...base, startDate: "" })).toEqual({ ok: false, error: "invalid" });
    expect(buildEventTimes({ ...base, endTime: "" })).toEqual({ ok: false, error: "invalid" });
  });
});

describe("endDateFieldValue", () => {
  it("vazio quando termina no mesmo dia, data quando difere", () => {
    const s = new Date(2026, 10, 21, 22, 0).getTime();
    expect(endDateFieldValue(s, new Date(2026, 10, 21, 23, 0).getTime())).toBe("");
    expect(endDateFieldValue(s, new Date(2026, 10, 22, 1, 0).getTime())).toBe("2026-11-22");
  });
});
