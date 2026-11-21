import { describe, expect, it } from "vitest";
import { buildMonthCells, fillLevel, fillRatio, truncationNote, type RangeDay } from "./agendaMonth";

const day = (localDate: string, over: Partial<RangeDay> = {}): RangeDay => ({ localDate, active: 0, pending: 0, closedResources: 0, occupancy: [], ...over });

describe("fillRatio / fillLevel", () => {
  it("pega o tipo mais apertado", () => {
    expect(fillRatio({ occupancy: [{ kind: "room", bookedMinutes: 100, openMinutes: 400 }, { kind: "person", bookedMinutes: 300, openMinutes: 400 }] })).toBe(0.75);
  });
  it("sem minutos abertos: null; marcado sem aberto: cheio", () => {
    expect(fillRatio({ occupancy: [] })).toBeNull();
    expect(fillRatio({ occupancy: [{ kind: "room", bookedMinutes: 0, openMinutes: 0 }] })).toBeNull();
    expect(fillRatio({ occupancy: [{ kind: "room", bookedMinutes: 30, openMinutes: 0 }] })).toBe(Infinity);
  });
  it("níveis", () => {
    expect(fillLevel(null, 0)).toBe("empty");
    expect(fillLevel(null, 2)).toBe("some");
    expect(fillLevel(0.3, 1)).toBe("some");
    expect(fillLevel(0.8, 5)).toBe("high");
    expect(fillLevel(1, 5)).toBe("full");
    expect(fillLevel(1.4, 5)).toBe("full");
    expect(fillLevel(0, 0)).toBe("empty");
  });
});

describe("buildMonthCells", () => {
  it("novembro de 2026 (dia 1 é domingo): 6 espaços antes, 30 dias", () => {
    const cells = buildMonthCells("2026-11-01", "2026-11-30", undefined);
    expect(cells.slice(0, 6).every((c) => c === null)).toBe(true);
    expect(cells.filter(Boolean)).toHaveLength(30);
    expect(cells[6]?.localDate).toBe("2026-11-01");
  });
  it("junta os dados do servidor por data", () => {
    const range = { days: [day("2026-11-03", { active: 4, pending: 1, closedResources: 1, occupancy: [{ kind: "room", bookedMinutes: 480, openMinutes: 480 }] })], capped: false, completeThrough: null };
    const c = buildMonthCells("2026-11-01", "2026-11-30", range).find((x) => x?.localDate === "2026-11-03")!;
    expect(c).toMatchObject({ active: 4, pending: 1, closedResources: 1, level: "full", incomplete: false, day: 3 });
  });
  it("dia fechado só quando todos os recursos estão fechados", () => {
    const range = { days: [day("2026-11-03", { closedResources: 3 }), day("2026-11-04", { closedResources: 1 })], capped: false, completeThrough: null };
    const cells = buildMonthCells("2026-11-01", "2026-11-30", range, 3);
    expect(cells.find((x) => x?.localDate === "2026-11-03")?.allClosed).toBe(true);
    expect(cells.find((x) => x?.localDate === "2026-11-04")?.allClosed).toBe(false);
    expect(buildMonthCells("2026-11-01", "2026-11-30", range).find((x) => x?.localDate === "2026-11-03")?.allClosed).toBe(false);
  });
  it("corte do servidor: dias depois de completeThrough ficam incompletos", () => {
    const range = { days: [day("2026-11-10"), day("2026-11-11")], capped: true, completeThrough: "2026-11-10" };
    const cells = buildMonthCells("2026-11-01", "2026-11-30", range);
    expect(cells.find((x) => x?.localDate === "2026-11-10")?.incomplete).toBe(false);
    expect(cells.find((x) => x?.localDate === "2026-11-11")?.incomplete).toBe(true);
    expect(truncationNote(range)).toEqual({ through: "2026-11-10" });
    expect(truncationNote({ days: [], capped: false, completeThrough: null })).toBeNull();
  });
  it("capped com completeThrough null: o mês todo é incompleto", () => {
    const cells = buildMonthCells("2026-11-01", "2026-11-30", { days: [], capped: true, completeThrough: null });
    expect(cells.filter(Boolean).every((c) => c!.incomplete)).toBe(true);
  });
});
