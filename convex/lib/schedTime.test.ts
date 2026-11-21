import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  assertValidTimezone,
  atLocalMinutes,
  dayBounds,
  diffLocalDays,
  formatLocalDateLabel,
  formatSlotLabel,
  isValidLocalDate,
  localDateOf,
  minutesOfDay,
  weekdayOf,
} from "./schedTime";

const H = 60 * 60 * 1000;
const iso = (s: string) => Date.parse(s);

describe("assertValidTimezone", () => {
  it("devolve o fuso válido e lança nos inválidos (nunca cai em São Paulo)", () => {
    expect(assertValidTimezone("America/Sao_Paulo")).toBe("America/Sao_Paulo");
    expect(assertValidTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(() => assertValidTimezone("Mars/Olympus")).toThrow(/Fuso horário inválido/);
    expect(() => assertValidTimezone("")).toThrow(/Fuso horário inválido/);
    expect(() => localDateOf(0, "Nope/Nope")).toThrow();
    expect(() => atLocalMinutes("2026-11-21", 600, "Nope/Nope")).toThrow();
    expect(() => dayBounds("2026-11-21", "Nope/Nope")).toThrow();
    expect(() => minutesOfDay(0, "Nope/Nope")).toThrow();
  });
});

describe("calendário puro", () => {
  it("valida datas, soma dias entre meses e anos e dá o dia da semana", () => {
    expect(isValidLocalDate("2026-02-28")).toBe(true);
    expect(isValidLocalDate("2026-02-30")).toBe(false);
    expect(isValidLocalDate("2026-13-01")).toBe(false);
    expect(isValidLocalDate("26-1-1")).toBe(false);
    expect(addLocalDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addLocalDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addLocalDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(weekdayOf("2026-11-22")).toBe(0); // domingo
    expect(weekdayOf("2026-11-27")).toBe(5); // sexta
    expect(diffLocalDays("2026-12-30", "2027-01-02")).toBe(3);
    expect(() => addLocalDays("2026-02-30", 1)).toThrow(/Data local inválida/);
    expect(formatLocalDateLabel("2026-11-27")).toBe("sex, 27/11/2026");
  });
});

describe("America/Sao_Paulo (sem horário de verão)", () => {
  const tz = "America/Sao_Paulo";
  it("converte nos dois sentidos e o dia tem 24 h", () => {
    const t = atLocalMinutes("2026-11-21", 14 * 60 + 30, tz);
    expect(t).toBe(iso("2026-11-21T17:30:00Z"));
    expect(localDateOf(t, tz)).toBe("2026-11-21");
    expect(minutesOfDay(t, tz)).toBe(14 * 60 + 30);
    const b = dayBounds("2026-11-21", tz);
    expect(b.end - b.start).toBe(24 * H);
    expect(b.start).toBe(iso("2026-11-21T03:00:00Z"));
  });
  it("endMin = 1440 é a meia-noite seguinte; virada do dia UTC (22h local)", () => {
    expect(atLocalMinutes("2026-12-31", 1440, tz)).toBe(atLocalMinutes("2027-01-01", 0, tz));
    const t = atLocalMinutes("2026-11-21", 22 * 60, tz); // 22h local = 01:00Z do dia seguinte
    expect(t).toBe(iso("2026-11-22T01:00:00Z"));
    expect(localDateOf(t, tz)).toBe("2026-11-21");
    expect(minutesOfDay(t, tz)).toBe(1320);
    expect(minutesOfDay(t + 3 * H, tz)).toBe(60); // 01:00 do dia 22 local
    expect(localDateOf(t + 3 * H, tz)).toBe("2026-11-22");
  });
  it("recusa minutos fora de 0..1440", () => {
    expect(() => atLocalMinutes("2026-11-21", 1441, tz)).toThrow();
    expect(() => atLocalMinutes("2026-11-21", -1, tz)).toThrow();
    expect(() => atLocalMinutes("2026-11-21", 10.5, tz)).toThrow();
  });
});

describe("America/New_York (23 h e 25 h)", () => {
  const tz = "America/New_York";
  it("dia da virada de primavera tem 23 h; a hora inexistente avança", () => {
    const b = dayBounds("2026-03-08", tz);
    expect(b.end - b.start).toBe(23 * H);
    expect(b.start).toBe(iso("2026-03-08T05:00:00Z"));
    expect(b.end).toBe(iso("2026-03-09T04:00:00Z"));
    // 02:30 não existe em 08/03: segue localToEpoch -> 03:30 EDT
    expect(atLocalMinutes("2026-03-08", 150, tz)).toBe(iso("2026-03-08T07:30:00Z"));
    expect(minutesOfDay(iso("2026-03-08T07:30:00Z"), tz)).toBe(210);
    expect(dayBounds("2026-03-07", tz).end - dayBounds("2026-03-07", tz).start).toBe(24 * H);
  });
  it("dia da virada de outono tem 25 h; a hora duplicada é a primeira ocorrência", () => {
    const b = dayBounds("2026-11-01", tz);
    expect(b.end - b.start).toBe(25 * H);
    expect(b.start).toBe(iso("2026-11-01T04:00:00Z"));
    expect(b.end).toBe(iso("2026-11-02T05:00:00Z"));
    // 01:30 ocorre duas vezes: EDT (05:30Z) e EST (06:30Z); vale a primeira
    expect(atLocalMinutes("2026-11-01", 90, tz)).toBe(iso("2026-11-01T05:30:00Z"));
    expect(minutesOfDay(iso("2026-11-01T06:30:00Z"), tz)).toBe(90); // a segunda ocorrência também lê 01:30
  });
  it("somar 24 h ao epoch erra nesses dias; o calendário local não", () => {
    const start = dayBounds("2026-03-08", tz).start;
    expect(localDateOf(start + 24 * H, tz)).toBe("2026-03-09");
    expect(atLocalMinutes("2026-03-09", 0, tz)).toBe(start + 23 * H);
  });
});

describe("Europe/Lisbon", () => {
  const tz = "Europe/Lisbon";
  it("23 h em 29/03/2026 (hora inexistente 01:30) e 25 h em 25/10/2026 (01:30 duplicada)", () => {
    const spring = dayBounds("2026-03-29", tz);
    expect(spring.end - spring.start).toBe(23 * H);
    expect(spring.start).toBe(iso("2026-03-29T00:00:00Z"));
    // 01:30 local não existe (01:00 -> 02:00): segue localToEpoch (offset anterior) = 01:30Z = 02:30 WEST
    expect(atLocalMinutes("2026-03-29", 90, tz)).toBe(iso("2026-03-29T01:30:00Z"));
    const fall = dayBounds("2026-10-25", tz);
    expect(fall.end - fall.start).toBe(25 * H);
    expect(fall.start).toBe(iso("2026-10-24T23:00:00Z"));
    // 01:30 duplicada: WEST 00:30Z (primeira) e WET 01:30Z
    expect(atLocalMinutes("2026-10-25", 90, tz)).toBe(iso("2026-10-25T00:30:00Z"));
  });
  it("no inverno o offset é zero", () => {
    expect(atLocalMinutes("2026-01-15", 600, tz)).toBe(iso("2026-01-15T10:00:00Z"));
  });
});

describe("Asia/Kolkata (meia hora)", () => {
  const tz = "Asia/Kolkata";
  it("converte com offset +05:30 e o dia local começa às 18:30Z da véspera", () => {
    const t = atLocalMinutes("2026-11-21", 9 * 60 + 30, tz);
    expect(t).toBe(iso("2026-11-21T04:00:00Z"));
    expect(minutesOfDay(t, tz)).toBe(570);
    expect(minutesOfDay(iso("2026-11-21T18:29:00Z"), tz)).toBe(1439);
    expect(localDateOf(iso("2026-11-21T18:29:00Z"), tz)).toBe("2026-11-21");
    expect(localDateOf(iso("2026-11-21T18:30:00Z"), tz)).toBe("2026-11-22");
    const b = dayBounds("2026-11-21", tz);
    expect(b.start).toBe(iso("2026-11-20T18:30:00Z"));
    expect(b.end - b.start).toBe(24 * H);
  });
});

describe("formatSlotLabel", () => {
  const tz = "America/Sao_Paulo";
  const now = iso("2026-11-27T12:00:00Z"); // sexta 09:00 local
  it("rótulo com dia da semana, data, hora e sufixo hoje/amanhã", () => {
    expect(formatSlotLabel(atLocalMinutes("2026-11-28", 870, tz), now, tz)).toBe("sáb, 28/11/2026 às 14:30 (amanhã)");
    expect(formatSlotLabel(atLocalMinutes("2026-11-27", 870, tz), now, tz)).toBe("sex, 27/11/2026 às 14:30 (hoje)");
    expect(formatSlotLabel(atLocalMinutes("2026-12-03", 540, tz), now, tz)).toBe("qui, 03/12/2026 às 09:00");
  });
  it("o sufixo usa o dia LOCAL, não o dia UTC", () => {
    const lateNow = iso("2026-11-28T01:30:00Z"); // ainda 27/11 22:30 em São Paulo
    expect(formatSlotLabel(atLocalMinutes("2026-11-28", 600, tz), lateNow, tz)).toContain("(amanhã)");
  });
});

describe("fusos extras (regressão da revisão)", () => {
  it("America/Santiago: dia de 23 h com meia-noite inexistente (06/09/2026) e dia de 25 h (04/04/2026)", () => {
    const spring = dayBounds("2026-09-06", "America/Santiago");
    expect(spring.end - spring.start).toBe(23 * H);
    expect(spring.start).toBe(iso("2026-09-06T04:00:00Z")); // 00:00 não existe: o dia começa às 01:00 locais
    expect(minutesOfDay(spring.start, "America/Santiago")).toBe(60);
    expect(localDateOf(spring.start, "America/Santiago")).toBe("2026-09-06");
    const fall = dayBounds("2026-04-04", "America/Santiago");
    expect(fall.end - fall.start).toBe(25 * H);
    // 23:30 local duplicada: vale a primeira ocorrência (offset -3)
    expect(atLocalMinutes("2026-04-04", 1410, "America/Santiago")).toBe(iso("2026-04-05T02:30:00Z"));
  });
  it("America/Sao_Paulo em 04/11/2018: meia-noite inexistente, dia de 23 h", () => {
    const tz = "America/Sao_Paulo";
    const b = dayBounds("2018-11-04", tz);
    expect(b.start).toBe(iso("2018-11-04T03:00:00Z"));
    expect(b.end - b.start).toBe(23 * H);
    expect(minutesOfDay(b.start, tz)).toBe(60);
    expect(localDateOf(b.start, tz)).toBe("2018-11-04");
    expect(atLocalMinutes("2018-11-04", 1440, tz)).toBe(atLocalMinutes("2018-11-05", 0, tz));
    const fall = dayBounds("2019-02-16", tz);
    expect(fall.end - fall.start).toBe(25 * H);
  });
  it("Asia/Kathmandu (+05:45): ida e volta de todos os minutos do dia", () => {
    const tz = "Asia/Kathmandu";
    const b = dayBounds("2026-12-31", tz);
    expect(b.start).toBe(iso("2026-12-30T18:15:00Z"));
    expect(atLocalMinutes("2026-12-31", 540, tz)).toBe(iso("2026-12-31T03:15:00Z"));
    for (let m = 0; m < 1440; m += 15) {
      const ms = atLocalMinutes("2026-12-31", m, tz);
      expect(minutesOfDay(ms, tz)).toBe(m);
      expect(localDateOf(ms, tz)).toBe("2026-12-31");
    }
  });
});
