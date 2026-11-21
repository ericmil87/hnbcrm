import { describe, expect, it } from "vitest";
import {
  type AllocationLite,
  capacityCheck,
  assertBlockWithinCap,
  assertUnits,
  capacityReadRange,
  MAX_BLOCK_MIN,
  validateIntervals,
  validateWeekly,
  computeDayAvailability,
  type ExceptionLite,
  mergeIntervals,
  openIntervalsForDay,
  peakUnits,
  type ResourceLite,
  rowsInCapacityWindow,
  subtractIntervals,
  usableIntervals,
} from "./schedAvailability";
import { atLocalMinutes, dayBounds } from "./schedTime";

const tz = "America/Sao_Paulo";
const MIN = 60_000;
const MON = "2026-11-23"; // segunda
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return atLocalMinutes(date, h * 60 + m, tz);
};

function res(over: Partial<ResourceLite> & { _id: string }): ResourceLite {
  return {
    kind: "room",
    name: over._id,
    capacity: 1,
    weekly: [{ weekday: 1, startMin: 480, endMin: 1080 }],
    sortOrder: 0,
    active: true,
    ...over,
  };
}
function alloc(over: Partial<AllocationLite> & { blockStart: number; blockEnd: number }): AllocationLite {
  return {
    appointmentId: "ap1",
    resourceId: "r1",
    coreStart: over.blockStart,
    coreEnd: over.blockEnd,
    units: 1,
    ...over,
  };
}
describe("intervalos", () => {
  it("mergeIntervals funde sobrepostos e encostados; subtractIntervals corta", () => {
    expect(mergeIntervals([{ start: 5, end: 10 }, { start: 0, end: 5 }, { start: 8, end: 12 }, { start: 20, end: 20 }])).toEqual([
      { start: 0, end: 12 },
    ]);
    expect(subtractIntervals([{ start: 0, end: 100 }], [{ start: 10, end: 20 }, { start: 90, end: 200 }])).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 90 },
    ]);
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 0, end: 10 }])).toEqual([]);
  });
});

describe("openIntervalsForDay — precedência e modos", () => {
  const r = res({ _id: "r1", weekly: [
    { weekday: 1, startMin: 480, endMin: 720 },
    { weekday: 1, startMin: 840, endMin: 1080 }, // dois turnos com almoço
    { weekday: 2, startMin: 480, endMin: 1080 },
  ] });
  const ex = (e: Partial<ExceptionLite> & Pick<ExceptionLite, "mode">): ExceptionLite => ({ localDate: MON, ...e });

  it("regra semanal: dois turnos com almoço; dia sem regra = vazio", () => {
    expect(openIntervalsForDay(r, [], MON, tz)).toEqual([
      { start: at(MON, "08:00"), end: at(MON, "12:00") },
      { start: at(MON, "14:00"), end: at(MON, "18:00") },
    ]);
    expect(openIntervalsForDay(r, [], "2026-11-22", tz)).toEqual([]); // domingo
  });
  it("closed zera; custom substitui; extra soma", () => {
    expect(openIntervalsForDay(r, [ex({ mode: "closed", resourceId: "r1" })], MON, tz)).toEqual([]);
    expect(
      openIntervalsForDay(r, [ex({ mode: "custom", resourceId: "r1", intervals: [{ startMin: 600, endMin: 660 }] })], MON, tz)
    ).toEqual([{ start: at(MON, "10:00"), end: at(MON, "11:00") }]);
    expect(
      openIntervalsForDay(r, [ex({ mode: "extra", resourceId: "r1", intervals: [{ startMin: 720, endMin: 840 }] })], MON, tz)
    ).toEqual([{ start: at(MON, "08:00"), end: at(MON, "18:00") }]); // almoço coberto, funde tudo
  });
  it("exceção de outra data não vale", () => {
    expect(openIntervalsForDay(r, [{ localDate: "2026-11-24", mode: "closed", resourceId: "r1" }], MON, tz)).toHaveLength(2);
  });
  it("fechamento da org vale para todos; exceção do recurso vence o fechamento da org", () => {
    const org = ex({ mode: "closed" });
    expect(openIntervalsForDay(r, [org], MON, tz)).toEqual([]);
    const reopened = ex({ mode: "custom", resourceId: "r1", intervals: [{ startMin: 540, endMin: 600 }] });
    expect(openIntervalsForDay(r, [org, reopened], MON, tz)).toEqual([{ start: at(MON, "09:00"), end: at(MON, "10:00") }]);
    // recurso `closed` + org custom: o do recurso ainda zera
    expect(
      openIntervalsForDay(r, [ex({ mode: "custom", intervals: [{ startMin: 540, endMin: 600 }] }), ex({ mode: "closed", resourceId: "r1" })], MON, tz)
    ).toEqual([]);
  });
  it("fechamento por resourceKind atinge só aquele tipo", () => {
    const person = res({ _id: "p1", kind: "person" });
    const closeRooms = ex({ mode: "closed", resourceKind: "room" });
    expect(openIntervalsForDay(r, [closeRooms], MON, tz)).toEqual([]);
    expect(openIntervalsForDay(person, [closeRooms], MON, tz)).toEqual([{ start: at(MON, "08:00"), end: at(MON, "18:00") }]);
  });
  it("endMin = 1440 vai até a meia-noite seguinte", () => {
    const night = res({ _id: "n1", weekly: [{ weekday: 1, startMin: 1200, endMin: 1440 }] });
    expect(openIntervalsForDay(night, [], MON, tz)).toEqual([{ start: at(MON, "20:00"), end: at("2026-11-24", "00:00") }]);
  });
});

describe("computeDayAvailability", () => {
  const rooms = [res({ _id: "r1" }), res({ _id: "r2", capacity: 2 })];
  const person = res({ _id: "p1", kind: "person", teamMemberId: "tm1" });

  it("block tem precedência sobre extra: o horário aparece em `blocks` e some de `usableIntervals`", () => {
    const day = computeDayAvailability({
      date: MON, tz, resources: [rooms[0]],
      exceptions: [
        { localDate: MON, mode: "extra", resourceId: "r1", intervals: [{ startMin: 1080, endMin: 1200 }] },
        { localDate: MON, mode: "block", resourceId: "r1", intervals: [{ startMin: 1100, endMin: 1140 }, { startMin: 600, endMin: 660 }] },
      ],
      allocations: [], internalEvents: [],
    }).get("r1")!;
    expect(day.closed).toBe(false);
    expect(day.blocks.map((b) => b.source)).toEqual(["block", "block"]);
    expect(day.open).toEqual([{ start: at(MON, "08:00"), end: at(MON, "20:00") }]);
    expect(usableIntervals(day)).toEqual([
      { start: at(MON, "08:00"), end: at(MON, "10:00") },
      { start: at(MON, "11:00"), end: at(MON, "18:20") },
      { start: at(MON, "19:00"), end: at(MON, "20:00") },
    ]);
  });
  it("bloqueio da org vale para todos os recursos do dia", () => {
    const map = computeDayAvailability({
      date: MON, tz, resources: rooms, exceptions: [{ localDate: MON, mode: "block", intervals: [{ startMin: 720, endMin: 780 }] }],
      allocations: [], internalEvents: [],
    });
    expect(map.get("r1")!.blocks).toHaveLength(1);
    expect(map.get("r2")!.blocks).toHaveLength(1);
  });
  it("closed = true só com fechamento em vigor", () => {
    const closed = computeDayAvailability({ date: MON, tz, resources: rooms, exceptions: [{ localDate: MON, mode: "closed", resourceId: "r1" }], allocations: [], internalEvents: [] });
    expect(closed.get("r1")!.closed).toBe(true);
    expect(closed.get("r2")!.closed).toBe(false);
    const noHours = computeDayAvailability({ date: "2026-11-22", tz, resources: rooms, exceptions: [], allocations: [], internalEvents: [] });
    expect(noHours.get("r1")!.closed).toBe(false);
    expect(noHours.get("r1")!.open).toEqual([]);
    const reopened = computeDayAvailability({
      date: MON, tz, resources: [rooms[0]],
      exceptions: [{ localDate: MON, mode: "closed" }, { localDate: MON, mode: "extra", resourceId: "r1", intervals: [{ startMin: 600, endMin: 660 }] }],
      allocations: [], internalEvents: [],
    });
    expect(reopened.get("r1")!.closed).toBe(false);
  });
  it("compromisso interno vira bloco só para o recurso-pessoa do membro", () => {
    const map = computeDayAvailability({
      date: MON, tz, resources: [person, rooms[0]], exceptions: [], allocations: [],
      internalEvents: [
        { teamMemberId: "tm1", start: at(MON, "10:00"), end: at(MON, "11:00") },
        { teamMemberId: "tm2", start: at(MON, "12:00"), end: at(MON, "13:00") },
        { teamMemberId: "tm1", start: at("2026-11-25", "10:00"), end: at("2026-11-25", "11:00") }, // outro dia
      ],
    });
    expect(map.get("p1")!.blocks).toEqual([{ start: at(MON, "10:00"), end: at(MON, "11:00"), source: "internal_event" }]);
    expect(map.get("r1")!.blocks).toEqual([]);
  });
  it("distribui alocações por recurso e ignora o agendamento em remarcação", () => {
    const rows = [
      alloc({ resourceId: "r1", appointmentId: "a1", blockStart: at(MON, "10:00"), blockEnd: at(MON, "11:00") }),
      alloc({ resourceId: "r1", appointmentId: "a2", blockStart: at(MON, "09:00"), blockEnd: at(MON, "10:00") }),
      alloc({ resourceId: "r2", appointmentId: "a1", blockStart: at(MON, "10:00"), blockEnd: at(MON, "11:00") }),
    ];
    const base = { date: MON, tz, resources: rooms, exceptions: [], allocations: rows, internalEvents: [] };
    expect(computeDayAvailability(base).get("r1")!.allocations.map((a) => a.appointmentId)).toEqual(["a2", "a1"]);
    const ignoring = computeDayAvailability({ ...base, ignoreAppointmentId: "a1" });
    expect(ignoring.get("r1")!.allocations.map((a) => a.appointmentId)).toEqual(["a2"]);
    expect(ignoring.get("r2")!.allocations).toEqual([]);
  });
  it("limites do dia seguem o fuso (dia de 25 h em Nova York)", () => {
    const ny = computeDayAvailability({ date: "2026-11-01", tz: "America/New_York", resources: [res({ _id: "r1", weekly: [{ weekday: 0, startMin: 0, endMin: 1440 }] })], exceptions: [], allocations: [], internalEvents: [] }).get("r1")!;
    expect(ny.bounds.end - ny.bounds.start).toBe(25 * 60 * MIN);
    expect(ny.open[0].end - ny.open[0].start).toBe(25 * 60 * MIN);
  });
});

describe("peakUnits — capacidade por PICO (não soma)", () => {
  const T = (m: number) => m * MIN;
  const row = (s: number, e: number, units = 1, extra: Partial<AllocationLite> = {}) =>
    alloc({ blockStart: T(s), blockEnd: T(e), units, ...extra });

  it("dois de 30 min em sequência dentro de 60 = pico 1; sobrepostos = 2", () => {
    expect(peakUnits([row(0, 30), row(30, 60)], T(0), T(60), "core")).toBe(1);
    expect(peakUnits([row(0, 40), row(30, 60)], T(0), T(60), "core")).toBe(2);
  });
  it("encostar (fim = início) não conflita; a faixa consultada também é semiaberta", () => {
    expect(peakUnits([row(0, 30)], T(30), T(60), "core")).toBe(0);
    expect(peakUnits([row(60, 90)], T(30), T(60), "core")).toBe(0);
    expect(peakUnits([row(0, 31)], T(30), T(60), "core")).toBe(1);
  });
  it("soma unidades simultâneas e ignora linhas fora da faixa", () => {
    expect(peakUnits([row(0, 60, 2), row(10, 20, 1), row(200, 300, 5)], T(0), T(60), "core")).toBe(3);
    expect(peakUnits([], T(0), T(60), "core")).toBe(0);
    expect(peakUnits([row(0, 60)], T(30), T(30), "core")).toBe(0);
  });
  it("núcleo × bloco: a folga conta só no bloco", () => {
    // outro agendamento: bloco 10:00-11:00 com núcleo 10:10-10:50
    const other = alloc({ blockStart: T(600), blockEnd: T(660), coreStart: T(610), coreEnd: T(650) });
    // novo núcleo 10:50-11:10
    expect(peakUnits([other], T(650), T(670), "core")).toBe(0); // encosta no núcleo
    expect(peakUnits([other], T(650), T(670), "block")).toBe(1); // folga sobrepõe
    // novo núcleo 10:40-11:10 sobrepõe o núcleo
    expect(peakUnits([other], T(640), T(670), "core")).toBe(1);
  });
  it("pico real dentro da faixa, não na linha toda: dois de 1 unidade que não se sobrepõem na faixa", () => {
    expect(peakUnits([row(0, 50), row(40, 100)], T(0), T(40), "core")).toBe(1); // sobreposição só depois de 40
    expect(peakUnits([row(0, 50), row(40, 100)], T(0), T(45), "core")).toBe(2);
  });
  it("capacityCheck: pico + novas <= capacidade", () => {
    const rows = [row(0, 60)];
    expect(capacityCheck({ rows, capacity: 2, units: 1, start: T(10), end: T(20), which: "core" })).toEqual({ ok: true, peak: 1 });
    expect(capacityCheck({ rows, capacity: 1, units: 1, start: T(10), end: T(20), which: "core" })).toEqual({ ok: false, peak: 1 });
    expect(capacityCheck({ rows, capacity: 2, units: 2, start: T(10), end: T(20), which: "core" }).ok).toBe(false);
    expect(capacityCheck({ rows, capacity: 1, units: 1, start: T(60), end: T(90), which: "core" }).ok).toBe(true);
  });
});

describe("lookback L da faixa de leitura", () => {
  const L = MAX_BLOCK_MIN; // min
  const bs = at(MON, "12:00");
  const be = bs + 60 * MIN;
  it("a faixa é [bs − L, be)", () => {
    expect(capacityReadRange(bs, be)).toEqual({ from: bs - L * MIN, to: be });
    expect(capacityReadRange(bs, be)).toEqual({ from: bs - 480 * MIN, to: be }); // default 480
  });
  it("bloco que começa L − 1 min antes entra; L + 1 min antes não (e não poderia sobrepor)", () => {
    const inside = alloc({ blockStart: bs - (L - 1) * MIN, blockEnd: bs - (L - 1) * MIN + L * MIN }); // dura L, termina 1 min depois de bs
    const outside = alloc({ blockStart: bs - (L + 1) * MIN, blockEnd: bs - (L + 1) * MIN + L * MIN }); // dura L, termina 1 min antes de bs
    expect(rowsInCapacityWindow([inside, outside], bs, be)).toEqual([inside]);
    expect(peakUnits([inside], bs, be, "block")).toBe(1);
    expect(peakUnits([outside], bs, be, "block")).toBe(0); // fora da faixa também não conflitaria
    // borda exata: começa em bs − L (entra) e termina exatamente em bs (não sobrepõe: sai pelo filtro blockEnd > bs)
    const edge = alloc({ blockStart: bs - L * MIN, blockEnd: bs });
    expect(rowsInCapacityWindow([edge], bs, be)).toEqual([]);
  });
  it("linha que começa em `be` (encostada depois) fica fora da faixa", () => {
    expect(rowsInCapacityWindow([alloc({ blockStart: be, blockEnd: be + 30 * MIN })], bs, be)).toEqual([]);
  });
});

describe("teto de bloco e unidades (regressão da revisão)", () => {
  it("assertBlockWithinCap: L passa, L + 1 min lança, bloco invertido ou nulo lança", () => {
    const t0 = at(MON, "08:00");
    expect(() => assertBlockWithinCap(t0, t0 + MAX_BLOCK_MIN * MIN)).not.toThrow();
    expect(() => assertBlockWithinCap(t0, t0 + (MAX_BLOCK_MIN + 1) * MIN)).toThrow(/limite de 480/);
    expect(() => assertBlockWithinCap(t0, t0)).toThrow();
    expect(() => assertBlockWithinCap(t0 + 1, t0)).toThrow();
    expect(() => assertBlockWithinCap(NaN, t0)).toThrow();
  });
  it("alocação de L + 1 min ficaria invisível na faixa lida (por isso o guard antes do insert)", () => {
    const bs = at(MON, "12:00");
    const be = bs + 60 * MIN;
    // começa 1 min antes da faixa [bs − L, be) e dura L + 31 min: invade [bs, be) sem ser lida
    const long = alloc({ blockStart: bs - (MAX_BLOCK_MIN + 1) * MIN, blockEnd: bs + 30 * MIN });
    expect(long.blockEnd - long.blockStart).toBe((MAX_BLOCK_MIN + 31) * MIN);
    expect(peakUnits([long], bs, be, "block")).toBe(1);
    expect(rowsInCapacityWindow([long], bs, be)).toEqual([]); // fora da faixa [bs − L, be)
    expect(() => assertBlockWithinCap(long.blockStart, long.blockEnd)).toThrow();
  });
  it("unidades 0, negativas ou fracionárias lançam em peakUnits (linha sobreposta) e capacityCheck", () => {
    const T = (m: number) => m * MIN;
    for (const units of [0, -1, 1.5, NaN]) {
      expect(() => peakUnits([alloc({ blockStart: T(0), blockEnd: T(60), units })], T(0), T(60), "core")).toThrow(/Unidades/);
    }
    // linha que não sobrepõe a consulta não é lida
    expect(peakUnits([alloc({ blockStart: T(100), blockEnd: T(160), units: -5 })], T(0), T(60), "core")).toBe(0);
    for (const units of [0, -1, 2.5]) {
      expect(() => capacityCheck({ rows: [], capacity: 1, units, start: T(0), end: T(60), which: "core" })).toThrow(/Unidades/);
    }
    for (const capacity of [0, -1, 1.5]) {
      expect(() => capacityCheck({ rows: [], capacity, units: 1, start: T(0), end: T(60), which: "core" })).toThrow(/Capacidade/);
    }
    expect(() => assertUnits(1)).not.toThrow();
  });
});

describe("turno que cruza a meia-noite não é suportado (regressão da revisão)", () => {
  const night = res({ _id: "n1", weekly: [{ weekday: 1, startMin: 1320, endMin: 120 }] });
  it("openIntervalsForDay lança em vez de devolver 'fechado'", () => {
    expect(() => openIntervalsForDay(night, [], MON, tz)).toThrow(/Intervalo inválido/);
    expect(() => openIntervalsForDay(res({ _id: "x", weekly: [{ weekday: 1, startMin: 0, endMin: 1500 }] }), [], MON, tz)).toThrow();
    expect(() =>
      openIntervalsForDay(res({ _id: "x" }), [{ localDate: MON, mode: "custom", resourceId: "x", intervals: [{ startMin: 600, endMin: 600 }] }], MON, tz)
    ).toThrow();
    // a regra de outro dia da semana não interfere
    expect(openIntervalsForDay(night, [], "2026-11-24", tz)).toEqual([]);
  });
  it("validateIntervals: limites, ordem, sobreposição, inteiros", () => {
    expect(validateIntervals([{ startMin: 480, endMin: 720 }, { startMin: 720, endMin: 1080 }])).toEqual({ ok: true });
    expect(validateIntervals([])).toEqual({ ok: true });
    expect(validateIntervals([{ startMin: 1320, endMin: 120 }])).toMatchObject({ ok: false, error: expect.stringContaining("meia-noite") });
    expect(validateIntervals([{ startMin: 600, endMin: 600 }]).ok).toBe(false);
    expect(validateIntervals([{ startMin: -1, endMin: 60 }]).ok).toBe(false);
    expect(validateIntervals([{ startMin: 0, endMin: 1441 }]).ok).toBe(false);
    expect(validateIntervals([{ startMin: 0.5, endMin: 60 }]).ok).toBe(false);
    expect(validateIntervals([{ startMin: 480, endMin: 720 }, { startMin: 700, endMin: 800 }]).ok).toBe(false);
    expect(validateIntervals([{ startMin: 840, endMin: 900 }, { startMin: 480, endMin: 720 }]).ok).toBe(false); // fora de ordem
  });
  it("validateWeekly valida por dia da semana, o teto de 28 itens e o weekday", () => {
    expect(validateWeekly([{ weekday: 1, startMin: 480, endMin: 720 }, { weekday: 2, startMin: 480, endMin: 720 }])).toEqual({ ok: true });
    expect(validateWeekly([{ weekday: 1, startMin: 480, endMin: 720 }, { weekday: 1, startMin: 600, endMin: 900 }]).ok).toBe(false);
    expect(validateWeekly([{ weekday: 7, startMin: 480, endMin: 720 }]).ok).toBe(false);
    expect(validateWeekly([{ weekday: 1, startMin: 1320, endMin: 120 }]).ok).toBe(false);
    expect(validateWeekly(Array.from({ length: 29 }, () => ({ weekday: 0, startMin: 0, endMin: 1 }))).ok).toBe(false);
  });
});
