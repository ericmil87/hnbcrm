import { describe, expect, test } from "vitest";
import { computeGaps, saturatedIntervals, type GapResource } from "./schedGaps";
import { atLocalMinutes } from "./schedTime";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";
const MIN = 60_000;

const at = (date: string, hh: number, mm: number, tz = SP) => atLocalMinutes(date, hh * 60 + mm, tz);
const res = (over: Partial<GapResource> & { open: GapResource["open"] }): GapResource => ({
  resourceId: "r1",
  resourceName: "Sala 1",
  kind: "room",
  capacity: 1,
  busy: [],
  ...over,
});

describe("computeGaps", () => {
  test("buraco entre dois atendimentos, com o fuso da org nos minutos locais", () => {
    const day = "2026-06-15";
    const gaps = computeGaps({
      tz: SP,
      minMinutes: 30,
      resources: [
        res({
          open: [{ start: at(day, 9, 0), end: at(day, 18, 0) }],
          busy: [
            { start: at(day, 9, 0), end: at(day, 10, 0) },
            { start: at(day, 11, 30), end: at(day, 12, 30) },
          ],
        }),
      ],
    });
    const between = gaps.filter((g) => g.position === "between");
    expect(between).toHaveLength(1);
    expect(between[0]).toMatchObject({ startMin: 600, endMin: 690, minutes: 90, resourceName: "Sala 1" });
    // depois do último: sobra do fim do expediente
    expect(gaps.find((g) => g.position === "after_last")).toMatchObject({ startMin: 750, endMin: 1080 });
    expect(gaps.find((g) => g.position === "before_first")).toBeUndefined();
  });

  test("buraco menor que o mínimo não aparece; encostado não cria buraco", () => {
    const day = "2026-06-15";
    const gaps = computeGaps({
      tz: SP,
      minMinutes: 30,
      resources: [
        res({
          open: [{ start: at(day, 9, 0), end: at(day, 12, 0) }],
          busy: [
            { start: at(day, 9, 0), end: at(day, 10, 0) },
            { start: at(day, 10, 0), end: at(day, 11, 0) }, // encosta no anterior
            { start: at(day, 11, 20), end: at(day, 12, 0) }, // sobra 20 min entre 11:00 e 11:20
          ],
        }),
      ],
    });
    expect(gaps).toEqual([]);
  });

  test("dia sem atendimento é 'empty'; antes do primeiro é 'before_first'", () => {
    const day = "2026-06-15";
    const open = [{ start: at(day, 9, 0), end: at(day, 12, 0) }];
    const empty = computeGaps({ tz: SP, minMinutes: 30, resources: [res({ open })] });
    expect(empty).toHaveLength(1);
    expect(empty[0].position).toBe("empty");
    const first = computeGaps({ tz: SP, minMinutes: 30, resources: [res({ open, busy: [{ start: at(day, 10, 0), end: at(day, 12, 0) }] })] });
    expect(first[0]).toMatchObject({ position: "before_first", startMin: 540, endMin: 600 });
  });

  test("capacidade 2: só vira ocupado quando os dois lugares estão cheios", () => {
    const day = "2026-06-15";
    const open = [{ start: at(day, 9, 0), end: at(day, 12, 0) }];
    const one = computeGaps({
      tz: SP,
      minMinutes: 30,
      resources: [res({ capacity: 2, open, busy: [{ start: at(day, 9, 0), end: at(day, 10, 0) }] })],
    });
    expect(one).toHaveLength(1); // 1 de 2 ocupado: o dia inteiro segue livre
    expect(one[0]).toMatchObject({ startMin: 540, endMin: 720, position: "empty" });
    const two = computeGaps({
      tz: SP,
      minMinutes: 30,
      resources: [
        res({
          capacity: 2,
          open,
          busy: [
            { start: at(day, 9, 0), end: at(day, 10, 0) },
            { start: at(day, 9, 30), end: at(day, 10, 30) },
          ],
        }),
      ],
    });
    // cheio de 09:30 a 10:00
    expect(two.map((g) => [g.startMin, g.endMin])).toEqual([
      [540, 570],
      [600, 720],
    ]);
  });

  test("notBefore corta o passado e o buraco vira 'de agora em diante'", () => {
    const day = "2026-06-15";
    const gaps = computeGaps({
      tz: SP,
      minMinutes: 30,
      notBefore: at(day, 10, 15),
      resources: [res({ open: [{ start: at(day, 9, 0), end: at(day, 12, 0) }], busy: [{ start: at(day, 9, 0), end: at(day, 9, 30) }] })],
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ startMin: 615, endMin: 720, minutes: 105 });
  });

  test("vários recursos: ordem por início e depois pelo nome", () => {
    const day = "2026-06-15";
    const open = [{ start: at(day, 9, 0), end: at(day, 10, 0) }];
    const gaps = computeGaps({
      tz: SP,
      minMinutes: 30,
      resources: [res({ resourceId: "b", resourceName: "Sala B", open }), res({ resourceId: "a", resourceName: "Sala A", open })],
    });
    expect(gaps.map((g) => g.resourceName)).toEqual(["Sala A", "Sala B"]);
  });

  test("dia de horário de verão (23 h): os minutos locais seguem o relógio da parede", () => {
    // New York, 08/03/2026: 02:00 vira 03:00. Expediente 09:00-17:00 local, atendimento 09:00-10:00.
    const day = "2026-03-08";
    const gaps = computeGaps({
      tz: NY,
      minMinutes: 30,
      resources: [res({ open: [{ start: at(day, 9, 0, NY), end: at(day, 17, 0, NY) }], busy: [{ start: at(day, 9, 0, NY), end: at(day, 10, 0, NY) }] })],
    });
    expect(gaps[0]).toMatchObject({ startMin: 600, endMin: 1020, minutes: 420, position: "after_last" });
    // o mesmo expediente no dia seguinte (24 h) dá a mesma contagem em minutos locais
    const next = computeGaps({
      tz: NY,
      minMinutes: 30,
      resources: [res({ open: [{ start: at("2026-03-09", 9, 0, NY), end: at("2026-03-09", 17, 0, NY) }] })],
    });
    expect(next[0]).toMatchObject({ startMin: 540, endMin: 1020, minutes: 480 });
  });

  test("fuso diferente do navegador: o mesmo instante tem minutos locais distintos", () => {
    const start = at("2026-06-15", 9, 0, SP); // 12:00 UTC
    const sp = computeGaps({ tz: SP, minMinutes: 5, resources: [res({ open: [{ start, end: start + 60 * MIN }] })] });
    const ny = computeGaps({ tz: NY, minMinutes: 5, resources: [res({ open: [{ start, end: start + 60 * MIN }] })] });
    expect(sp[0].startMin).toBe(540);
    expect(ny[0].startMin).toBe(480); // 08:00 em Nova York (EDT)
  });

  test("janela que termina na meia-noite local fecha em 1440, não em 0", () => {
    const day = "2026-06-15";
    const gaps = computeGaps({ tz: SP, minMinutes: 30, resources: [res({ open: [{ start: at(day, 22, 0), end: atLocalMinutes(day, 1440, SP) }] })] });
    expect(gaps[0]).toMatchObject({ startMin: 1320, endMin: 1440 });
  });
});

describe("saturatedIntervals", () => {
  test("encostar (fim = início) não conta como sobrepor", () => {
    expect(saturatedIntervals([{ start: 0, end: 10 }, { start: 10, end: 20 }], 2)).toEqual([]);
    expect(saturatedIntervals([{ start: 0, end: 10 }, { start: 5, end: 20 }], 2)).toEqual([{ start: 5, end: 10 }]);
  });
});
