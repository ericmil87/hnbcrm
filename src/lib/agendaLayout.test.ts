import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLocalDateTime } from "./agendaDates";
import { capClusterColumns, clipToDay, gridHourRange, layoutOverlaps } from "./agendaLayout";

const original = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Sao_Paulo";
});
afterAll(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

const at = (d: string, t: string) => parseLocalDateTime(d, t)!;
const item = (id: string, s: number, e: number) => ({ id, startMin: s, endMin: e });
const byId = (xs: ReturnType<typeof layoutOverlaps>) => Object.fromEntries(xs.map((x) => [x.id, x]));

describe("layoutOverlaps", () => {
  it("evento sozinho ocupa a largura toda", () => {
    expect(layoutOverlaps([item("a", 600, 660)])).toEqual([{ id: "a", startMin: 600, endMin: 660, column: 0, columns: 1, clusterId: 0 }]);
  });

  it("dois eventos no mesmo horário dividem a largura", () => {
    const r = byId(layoutOverlaps([item("a", 600, 660), item("b", 600, 660)]));
    expect([r.a.column, r.b.column].sort()).toEqual([0, 1]);
    expect(r.a.columns).toBe(2);
    expect(r.b.columns).toBe(2);
  });

  it("eventos em sequência não dividem (fim == início)", () => {
    const r = byId(layoutOverlaps([item("a", 600, 660), item("b", 660, 720)]));
    expect(r.a.columns).toBe(1);
    expect(r.b.columns).toBe(1);
  });

  it("reaproveita coluna livre dentro do cluster", () => {
    // a: 10-12, b: 10:30-11, c: 11-12 -> c cabe sob b; cluster tem 2 colunas.
    const r = byId(layoutOverlaps([item("a", 600, 720), item("b", 630, 660), item("c", 660, 720)]));
    expect(r.a.columns).toBe(2);
    expect(r.b.column).toBe(1);
    expect(r.c.column).toBe(1);
  });

  it("clusters independentes não afetam a largura um do outro", () => {
    const r = byId(layoutOverlaps([item("a", 600, 660), item("b", 600, 660), item("c", 900, 960)]));
    expect(r.a.columns).toBe(2);
    expect(r.c.columns).toBe(1);
  });

  it("evento curto conta como 30 min para sobreposição (altura mínima)", () => {
    const r = byId(layoutOverlaps([item("a", 600, 605), item("b", 615, 660)]));
    expect(r.a.columns).toBe(2);
  });

  it("é determinístico e não perde itens", () => {
    const input = [item("c", 600, 700), item("a", 600, 700), item("b", 650, 800)];
    const one = layoutOverlaps(input);
    const two = layoutOverlaps([...input].reverse());
    expect(one).toHaveLength(3);
    expect(byId(one)).toEqual(byId(two));
  });

  it("lista vazia", () => {
    expect(layoutOverlaps([])).toEqual([]);
  });
});

describe("clipToDay", () => {
  const day = () => new Date(2026, 10, 21, 12);
  it("evento normal", () => {
    expect(clipToDay(at("2026-11-21", "10:00"), at("2026-11-21", "11:30"), day())).toEqual({ startMin: 600, endMin: 690 });
  });
  it("cruza a meia-noite: corta por dia", () => {
    const s = at("2026-11-21", "22:00");
    const e = at("2026-11-22", "02:00");
    expect(clipToDay(s, e, day())).toEqual({ startMin: 1320, endMin: 1440 });
    expect(clipToDay(s, e, new Date(2026, 10, 22, 12))).toEqual({ startMin: 0, endMin: 120 });
    expect(clipToDay(s, e, new Date(2026, 10, 23, 12))).toBeNull();
  });
  it("vários dias: dia do meio é o dia todo", () => {
    const s = at("2026-11-20", "10:00");
    const e = at("2026-11-22", "10:00");
    expect(clipToDay(s, e, day())).toEqual({ startMin: 0, endMin: 1440 });
  });
  it("termina à meia-noite exata: não vaza para o dia seguinte", () => {
    const s = at("2026-11-21", "23:00");
    const e = at("2026-11-22", "00:00");
    expect(clipToDay(s, e, day())).toEqual({ startMin: 1380, endMin: 1440 });
    expect(clipToDay(s, e, new Date(2026, 10, 22, 12))).toBeNull();
  });
  it("duração zero fica no dia do instante", () => {
    const s = at("2026-11-21", "09:15");
    expect(clipToDay(s, s, day())).toEqual({ startMin: 555, endMin: 555 });
  });
  it("fora do dia: null", () => {
    expect(clipToDay(at("2026-11-20", "10:00"), at("2026-11-20", "11:00"), day())).toBeNull();
  });
});

describe("gridHourRange", () => {
  it("padrão 06-23", () => {
    expect(gridHourRange([])).toEqual({ startHour: 6, endHour: 23 });
    expect(gridHourRange([{ startMin: 600, endMin: 660 }])).toEqual({ startHour: 6, endHour: 23 });
  });
  it("amplia para madrugada e noite", () => {
    expect(gridHourRange([{ startMin: 150, endMin: 210 }])).toEqual({ startHour: 2, endHour: 23 });
    expect(gridHourRange([{ startMin: 1380, endMin: 1440 }])).toEqual({ startHour: 6, endHour: 24 });
    expect(gridHourRange([{ startMin: 1400, endMin: 1400 }])).toEqual({ startHour: 6, endHour: 24 });
  });
});

describe("clipToDay com fuso sem meia-noite", () => {
  it("evento 01:00-02:00 no dia em que 00:00 não existe (Sao_Paulo, 04/11/2018) começa em 60", () => {
    process.env.TZ = "America/Sao_Paulo";
    const day = new Date(2018, 10, 4, 12);
    const s = new Date(2018, 10, 4, 1, 0).getTime();
    const e = new Date(2018, 10, 4, 2, 0).getTime();
    expect(new Date(2018, 10, 4).getHours()).toBe(1); // premissa: dia começa à 01:00
    expect(clipToDay(s, e, day)).toEqual({ startMin: 60, endMin: 120 });
    // evento que começou no dia anterior continua cortado em 0
    const prev = new Date(2018, 10, 3, 23, 0).getTime();
    expect(clipToDay(prev, e, day)).toEqual({ startMin: 0, endMin: 120 });
    process.env.TZ = "America/Sao_Paulo";
  });
});

describe("capClusterColumns", () => {
  const many = (n: number) => layoutOverlaps(Array.from({ length: n }, (_, i) => item(`e${i}`, 600, 660)));

  it("até 3 colunas não muda nada", () => {
    const { visible, overflow } = capClusterColumns(many(3));
    expect(visible).toHaveLength(3);
    expect(overflow).toEqual([]);
    expect(visible.every((v) => v.columns === 3)).toBe(true);
  });

  it("8 simultâneos: 3 visíveis, chip +5 numa coluna extra", () => {
    const { visible, overflow } = capClusterColumns(many(8));
    expect(visible).toHaveLength(3);
    expect(visible.every((v) => v.columns === 4)).toBe(true);
    expect(overflow).toHaveLength(1);
    expect(overflow[0].hiddenIds).toHaveLength(5);
    expect(overflow[0]).toMatchObject({ column: 3, columns: 4, startMin: 600, endMin: 660 });
  });

  it("clusters diferentes são limitados independentemente", () => {
    const input = [...many(5), item("solo", 900, 960)];
    const { visible, overflow } = capClusterColumns(layoutOverlaps(input));
    expect(overflow).toHaveLength(1);
    expect(visible.find((v) => v.id === "solo")?.columns).toBe(1);
  });
});
