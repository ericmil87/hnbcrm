import { describe, expect, it } from "vitest";
import type { GridAppointment } from "./agendaGrid";
import { buildWeekModel, isContinuationPiece, movedEventStart } from "./agendaWeekGrid";
import { closedDaysFromServer, mergeClosedDays } from "./agendaClosedDays";
import { zonedAtMinutes } from "./agendaZone";

const TZ = "America/Sao_Paulo";
const at = (date: string, h: number, m = 0) => zonedAtMinutes(date, h * 60 + m, TZ);

describe("arrastar o compromisso que cruza a meia-noite", () => {
  const night = { startTime: at("2026-11-25", 22), endTime: at("2026-11-26", 2) };
  it("pedaço do dia de início: o destino é o instante absoluto (como sempre)", () => {
    expect(isContinuationPiece(night, "2026-11-25", TZ)).toBe(false);
    expect(movedEventStart(night, "2026-11-25", "2026-11-27", 8 * 60, TZ)).toBe(at("2026-11-27", 8));
  });
  it("segundo pedaço: move pela diferença; a duração se mantém", () => {
    expect(isContinuationPiece(night, "2026-11-26", TZ)).toBe(true);
    // pedaço (topo = 00:00 de 26) solto em 28/11 às 03:00: +2 dias e 3 h, então 22:00 de 25/11 vira 01:00 de 28/11
    const start = movedEventStart(night, "2026-11-26", "2026-11-28", 3 * 60, TZ);
    expect(start).toBe(night.startTime + (at("2026-11-28", 3) - at("2026-11-26", 0)));
    expect(start).toBe(at("2026-11-28", 1));
    // soltar no mesmo lugar não muda nada
    expect(movedEventStart(night, "2026-11-26", "2026-11-26", 0, TZ)).toBe(night.startTime);
  });
});

describe("dom 23:00 -> seg 01:00 na primeira coluna da Semana", () => {
  it("o pedaço aparece na segunda a partir de 00:00 (a leitura traz o que começou antes)", () => {
    const a: GridAppointment = {
      _id: "a" as never, serviceName: "Plantão", startTime: at("2026-11-22", 23), endTime: at("2026-11-23", 1), status: "scheduled",
      origin: "staff", localDate: "2026-11-22", resources: [], contactName: "Ana",
    };
    const dates = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"];
    const model = buildWeekModel({ dates, tz: TZ, now: at("2026-11-24", 10), appointments: [a], internal: [], resources: [], filterResourceId: null });
    const placed = model.days[0].placed;
    expect(placed).toHaveLength(1);
    expect(placed[0].item.startMin).toBe(0);
    expect(placed[0].item.endMin).toBe(60);
  });
});

describe("closedDaysFromServer", () => {
  it("converte a resposta; `all` só com todos os recursos ativos fechados", () => {
    expect(closedDaysFromServer([{ localDate: "2026-06-02", closedResources: 1 }, { localDate: "2026-06-16", closedResources: 4 }], 4)).toEqual({
      "2026-06-02": { closed: 1, all: false },
      "2026-06-16": { closed: 4, all: true },
    });
    expect(closedDaysFromServer([], 0)).toEqual({});
  });
});

describe("arrastar o segundo pedaço em fuso com horário de verão", () => {
  const NY = "America/New_York";
  it("a diferença é em hora de parede: cruza a troca de março sem errar uma hora", () => {
    // Plantão sáb 07/03/2026 22:00 -> dom 08/03 02:00 (a troca é 08/03 às 02:00 em NY; o domingo tem 23 h)
    const item = { startTime: zonedAtMinutes("2026-03-07", 22 * 60, NY), endTime: zonedAtMinutes("2026-03-08", 3 * 60, NY) };
    expect(isContinuationPiece(item, "2026-03-08", NY)).toBe(true);
    // Pedaço de domingo (topo 00:00 de 08/03) solto na quarta 11/03 às 01:00: 22:00 + 1 h = 23:00 de terça 10/03
    expect(movedEventStart(item, "2026-03-08", "2026-03-11", 60, NY)).toBe(zonedAtMinutes("2026-03-10", 23 * 60, NY));
    // soltar no mesmo lugar não muda nada, nem no dia de 23 h
    expect(movedEventStart(item, "2026-03-08", "2026-03-08", 0, NY)).toBe(item.startTime);
    // passa de 24 h somadas: 22:00 + 3 h = 01:00 do dia seguinte
    expect(movedEventStart(item, "2026-03-08", "2026-03-15", 180, NY)).toBe(zonedAtMinutes("2026-03-15", 60, NY));
  });
});

describe("mergeClosedDays", () => {
  const dates = ["2026-06-01", "2026-06-02", "2026-06-03"];
  const approx = { "2026-06-02": { closed: 1, all: false }, "2026-06-03": { closed: 2, all: true } };
  it("sem resposta do servidor usa a aproximação; com resposta completa vale só o servidor", () => {
    expect(mergeClosedDays(dates, undefined, approx)).toEqual(approx);
    expect(mergeClosedDays(dates, { days: [{ localDate: "2026-06-01", closedResources: 2 }], totalResources: 2 }, approx)).toEqual({ "2026-06-01": { closed: 2, all: true } });
  });
  it("com o teto cortado, os dias depois de `completeThrough` caem na aproximação", () => {
    const server = { days: [{ localDate: "2026-06-01", closedResources: 1 }], totalResources: 2, completeThrough: "2026-06-01" };
    expect(mergeClosedDays(dates, server, approx)).toEqual({ "2026-06-01": { closed: 1, all: false }, ...approx });
  });
});
