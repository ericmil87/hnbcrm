// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORG_TIMEZONE,
  minutesLabel,
  parseMinutes,
  resolveOrgTimezone,
  shortDateLabel,
  weekDateKeys,
  weekStartOf,
  zonedAtMinutes,
  zonedDateKey,
  zonedDateTimeLabel,
  zonedDayBounds,
  zonedMinutes,
  zonedRangeLabel,
  zonedTimeLabel,
  zonedToday,
  zonedWeekBounds,
  zonedWhenPhrase,
} from "./agendaZone";
import { atLocalMinutes, dayBounds, localDateOf, minutesOfDay } from "../../convex/lib/schedTime";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";
const LISBON = "Europe/Lisbon";
const KOLKATA = "Asia/Kolkata";
const HOUR = 3_600_000;
const ORIGINAL_TZ = process.env.TZ;

function withProcessTz(tz: string, fn: () => void) {
  process.env.TZ = tz;
  fn();
}
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("fuso da org diferente do fuso do processo", () => {
  // 10:00 em São Paulo, quinta 26/11/2026 = 13:00Z.
  const slot = Date.UTC(2026, 10, 26, 13, 0);

  for (const processTz of ["UTC", "Asia/Tokyo", "Pacific/Auckland", "America/Los_Angeles"]) {
    it(`processo em ${processTz}: tudo continua em São Paulo`, () => {
      withProcessTz(processTz, () => {
        expect(zonedDateKey(slot, SP)).toBe("2026-11-26");
        expect(zonedMinutes(slot, SP)).toBe(600);
        expect(zonedAtMinutes("2026-11-26", 600, SP)).toBe(slot);
        expect(zonedDateTimeLabel(slot, SP)).toBe("qui, 26/11 · 10:00");
        expect(zonedWhenPhrase(slot, SP)).toBe("qui, 26/11 às 10:00");
        expect(zonedDayBounds("2026-11-26", SP)).toEqual({ start: Date.UTC(2026, 10, 26, 3, 0), end: Date.UTC(2026, 10, 27, 3, 0) });
      });
    });
  }

  it("o mesmo instante tem outra data no fuso de quem olha, mas a org manda", () => {
    // 01:00Z do dia 27 = 22:00 do dia 26 em São Paulo; em Tóquio já é 10:00 do dia 27.
    const ms = Date.UTC(2026, 10, 27, 1, 0);
    withProcessTz("Asia/Tokyo", () => {
      expect(new Date(ms).getDate()).toBe(27);
      expect(zonedDateKey(ms, SP)).toBe("2026-11-26");
      expect(zonedMinutes(ms, SP)).toBe(22 * 60);
      expect(zonedDateKey(ms, "Asia/Tokyo")).toBe("2026-11-27");
    });
  });

  it("ida e volta: data + minutos -> epoch -> data + minutos", () => {
    for (const tz of [SP, NY, LISBON, KOLKATA, "Pacific/Auckland"]) {
      for (const minutes of [0, 30, 600, 1439]) {
        const ms = zonedAtMinutes("2026-07-15", minutes, tz);
        expect(zonedDateKey(ms, tz), `${tz} ${minutes}`).toBe("2026-07-15");
        expect(zonedMinutes(ms, tz), `${tz} ${minutes}`).toBe(minutes);
      }
    }
  });

  it("zonedToday usa o `now` recebido, no fuso da org", () => {
    const now = Date.UTC(2026, 10, 27, 2, 30); // 23:30 de 26/11 em SP
    expect(zonedToday(now, SP)).toBe("2026-11-26");
    expect(zonedToday(now, "Asia/Tokyo")).toBe("2026-11-27");
  });
});

describe("mesma semântica do servidor (convex/lib/schedTime)", () => {
  it("devolve exatamente o que a lib do servidor devolve", () => {
    const ms = Date.UTC(2026, 2, 8, 12, 15);
    for (const tz of [SP, NY, LISBON, KOLKATA]) {
      expect(zonedDateKey(ms, tz)).toBe(localDateOf(ms, tz));
      expect(zonedMinutes(ms, tz)).toBe(minutesOfDay(ms, tz));
      expect(zonedAtMinutes("2026-03-08", 150, tz)).toBe(atLocalMinutes("2026-03-08", 150, tz));
      expect(zonedDayBounds("2026-03-08", tz)).toEqual(dayBounds("2026-03-08", tz));
    }
  });
});

describe("horário de verão", () => {
  it("New York: o dia da primavera dura 23 h e o do outono 25 h", () => {
    const spring = zonedDayBounds("2026-03-08", NY);
    expect(spring.start).toBe(Date.UTC(2026, 2, 8, 5, 0));
    expect(spring.end).toBe(Date.UTC(2026, 2, 9, 4, 0));
    expect((spring.end - spring.start) / HOUR).toBe(23);
    const fall = zonedDayBounds("2026-11-01", NY);
    expect(fall.start).toBe(Date.UTC(2026, 10, 1, 4, 0));
    expect(fall.end).toBe(Date.UTC(2026, 10, 2, 5, 0));
    expect((fall.end - fall.start) / HOUR).toBe(25);
  });

  it("New York: 02:30 de 08/03/2026 não existe e vira 03:30 de verão", () => {
    const ms = zonedAtMinutes("2026-03-08", 150, NY);
    expect(ms).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(zonedTimeLabel(ms, NY)).toBe("03:30");
  });

  it("New York: 01:30 de 01/11/2026 acontece duas vezes e fica a primeira", () => {
    expect(zonedAtMinutes("2026-11-01", 90, NY)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it("Lisboa: 23 h na primavera (29/03/2026) e 25 h no outono (25/10/2026)", () => {
    const spring = zonedDayBounds("2026-03-29", LISBON);
    expect(spring).toEqual({ start: Date.UTC(2026, 2, 29, 0, 0), end: Date.UTC(2026, 2, 29, 23, 0) });
    const fall = zonedDayBounds("2026-10-25", LISBON);
    expect(fall).toEqual({ start: Date.UTC(2026, 9, 24, 23, 0), end: Date.UTC(2026, 9, 26, 0, 0) });
    expect((fall.end - fall.start) / HOUR).toBe(25);
  });

  it("a semana que atravessa a mudança não tem 168 h", () => {
    // Semana de segunda 02/03 a domingo 08/03/2026 em New York: 167 h.
    const week = zonedWeekBounds("2026-03-05", NY);
    expect(week.start).toBe(Date.UTC(2026, 2, 2, 5, 0));
    expect(week.end).toBe(Date.UTC(2026, 2, 9, 4, 0));
    expect((week.end - week.start) / HOUR).toBe(167);
  });
});

describe("fuso de meia hora e meia-noite inexistente", () => {
  it("Kolkata (+05:30): 10:00 local = 04:30Z e a data vira no fim do dia local", () => {
    const ms = zonedAtMinutes("2026-11-26", 600, KOLKATA);
    expect(ms).toBe(Date.UTC(2026, 10, 26, 4, 30));
    expect(zonedMinutes(ms, KOLKATA)).toBe(600);
    expect(zonedMinutes(Date.UTC(2026, 10, 26, 4, 0), KOLKATA)).toBe(570);
    expect(zonedDateKey(Date.UTC(2026, 10, 26, 18, 29), KOLKATA)).toBe("2026-11-26");
    expect(zonedDateKey(Date.UTC(2026, 10, 26, 18, 30), KOLKATA)).toBe("2026-11-27");
    expect(zonedDayBounds("2026-11-26", KOLKATA)).toEqual({
      start: Date.UTC(2026, 10, 25, 18, 30),
      end: Date.UTC(2026, 10, 26, 18, 30),
    });
  });

  it("São Paulo, 04/11/2018: o dia começa à 01:00 (meia-noite não existe) e dura 23 h", () => {
    const { start, end } = zonedDayBounds("2018-11-04", SP);
    expect(start).toBe(Date.UTC(2018, 10, 4, 3, 0));
    expect(zonedDateKey(start, SP)).toBe("2018-11-04");
    expect(zonedMinutes(start, SP)).toBe(60);
    expect(end).toBe(Date.UTC(2018, 10, 5, 2, 0));
    expect((end - start) / HOUR).toBe(23);
    // O dia anterior termina exatamente onde este começa.
    expect(zonedDayBounds("2018-11-03", SP).end).toBe(start);
  });
});

describe("semana", () => {
  it("semana começa na segunda e traz 7 dias", () => {
    expect(weekStartOf("2026-11-26")).toBe("2026-11-23");
    expect(weekStartOf("2026-11-23")).toBe("2026-11-23");
    expect(weekStartOf("2026-11-29")).toBe("2026-11-23");
    expect(weekDateKeys("2026-11-26")).toEqual([
      "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29",
    ]);
  });

  it("domingo como primeiro dia, quando pedido", () => {
    expect(weekStartOf("2026-11-26", 0)).toBe("2026-11-22");
  });

  it("limites da semana em São Paulo", () => {
    expect(zonedWeekBounds("2026-11-26", SP)).toEqual({
      start: Date.UTC(2026, 10, 23, 3, 0),
      end: Date.UTC(2026, 10, 30, 3, 0),
    });
  });

  it("atravessa virada de mês e de ano", () => {
    expect(weekStartOf("2027-01-01")).toBe("2026-12-28");
    expect(weekDateKeys("2027-01-01")[6]).toBe("2027-01-03");
  });
});

describe("rótulos", () => {
  it("minutesLabel e parseMinutes", () => {
    expect(minutesLabel(0)).toBe("00:00");
    expect(minutesLabel(570)).toBe("09:30");
    expect(minutesLabel(1440)).toBe("24:00");
    expect(minutesLabel(-5)).toBe("00:00");
    expect(minutesLabel(2000)).toBe("24:00");
    expect(parseMinutes("09:30")).toBe(570);
    expect(parseMinutes("9:05")).toBe(545);
    expect(parseMinutes("24:00")).toBe(1440);
    expect(parseMinutes("24:30")).toBeNull();
    expect(parseMinutes("10:60")).toBeNull();
    expect(parseMinutes("abc")).toBeNull();
    expect(parseMinutes("")).toBeNull();
  });

  it("data curta sem ano e intervalo", () => {
    expect(shortDateLabel("2026-11-26")).toBe("qui, 26/11");
    expect(shortDateLabel("2026-11-29")).toBe("dom, 29/11");
    expect(shortDateLabel("2026-11-28")).toBe("sáb, 28/11");
    const start = zonedAtMinutes("2026-11-26", 600, SP);
    expect(zonedRangeLabel(start, start + 50 * 60_000, SP)).toBe("10:00 - 10:50");
  });
});

describe("fuso inválido", () => {
  it("lança em vez de cair em São Paulo", () => {
    expect(() => zonedDateKey(0, "America/Sao_Pualo")).toThrow(/Fuso horário inválido/);
    expect(() => zonedDayBounds("2026-11-26", "")).toThrow(/Fuso horário inválido/);
    expect(() => zonedAtMinutes("2026-02-30", 0, SP)).toThrow(/Data local inválida/);
  });

  it("resolveOrgTimezone é a única porta tolerante", () => {
    expect(resolveOrgTimezone(undefined)).toBe(DEFAULT_ORG_TIMEZONE);
    expect(resolveOrgTimezone("  ")).toBe(DEFAULT_ORG_TIMEZONE);
    expect(resolveOrgTimezone("Nope/Nada")).toBe(DEFAULT_ORG_TIMEZONE);
    expect(resolveOrgTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });
});
