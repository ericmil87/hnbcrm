import { describe, expect, it } from "vitest";
import {
  dateKeyParam,
  defaultView,
  firstOfMonth,
  groupByOf,
  groupParam,
  groupParamOf,
  lastOfMonth,
  listModeParam,
  monthLeadingBlanks,
  monthRange,
  shiftDate,
  shiftMonth,
  viewParam,
} from "./agendaViewParams";
import { booleanParam, writeParams } from "./searchParamState";

describe("codecs da URL", () => {
  it("visão: válida passa, inválida ou ausente vira null (o padrão é do aparelho)", () => {
    expect(viewParam.parse("lista")).toBe("lista");
    expect(viewParam.parse("mes")).toBe("mes");
    expect(viewParam.parse("semana")).toBeNull();
    expect(viewParam.parse(null)).toBeNull();
    expect(viewParam.serialize("dia")).toBe("dia");
    expect(viewParam.serialize(null)).toBeNull();
  });
  it("padrão por aparelho: lista no celular, dia no computador", () => {
    expect(defaultView(true)).toBe("lista");
    expect(defaultView(false)).toBe("dia");
  });
  it("data: só 'YYYY-MM-DD' que existe", () => {
    expect(dateKeyParam.parse("2026-11-23")).toBe("2026-11-23");
    expect(dateKeyParam.parse("2026-02-30")).toBeNull();
    expect(dateKeyParam.parse("23/11/2026")).toBeNull();
    expect(dateKeyParam.parse(null)).toBeNull();
    expect(dateKeyParam.serialize("2026-13-01")).toBeNull();
  });
  it("agrupamento: sala é o padrão e não vai para a URL; profissional vai", () => {
    expect(groupParam.parse(null)).toBe("sala");
    expect(groupParam.parse("profissional")).toBe("profissional");
    expect(groupParam.parse("x")).toBe("sala");
    expect(groupParam.serialize("sala")).toBeNull();
    expect(groupParam.serialize("profissional")).toBe("profissional");
    expect(groupByOf("sala")).toBe("room");
    expect(groupByOf("profissional")).toBe("person");
    expect(groupParamOf("room")).toBe("sala");
    expect(groupParamOf("person")).toBe("profissional");
  });
  it("ordem da lista e marcador de pendências", () => {
    expect(listModeParam.parse("recurso")).toBe("recurso");
    expect(listModeParam.parse("?")).toBe("hora");
    expect(booleanParam.parse("1")).toBe(true);
    expect(booleanParam.parse(null)).toBe(false);
  });
  it("escrever vários parâmetros de uma vez preserva os do compromisso", () => {
    const next = writeParams(new URLSearchParams("event=e1&visao=dia"), { visao: "mes", data: "2026-12-01", pendencias: null });
    expect(next.toString()).toBe("event=e1&visao=mes&data=2026-12-01");
  });
});

describe("datas", () => {
  it("setas: um dia (Dia, Lista) ou um mês (Mês)", () => {
    expect(shiftDate("2026-11-30", "dia", 1)).toBe("2026-12-01");
    expect(shiftDate("2026-11-01", "lista", -1)).toBe("2026-10-31");
    expect(shiftDate("2026-01-31", "mes", 1)).toBe("2026-02-28");
    expect(shiftDate("2026-12-15", "mes", 1)).toBe("2027-01-15");
    expect(shiftDate("2026-01-15", "mes", -1)).toBe("2025-12-15");
  });
  it("mês bissexto e limites", () => {
    expect(shiftMonth("2028-01-31", 1)).toBe("2028-02-29");
    expect(firstOfMonth("2026-11-23")).toBe("2026-11-01");
    expect(lastOfMonth("2026-12-05")).toBe("2026-12-31");
    expect(lastOfMonth("2026-02-10")).toBe("2026-02-28");
  });
  it("período do mês cabe no teto de 35 dias do servidor", () => {
    for (const m of ["2026-01-10", "2026-02-10", "2026-12-10", "2028-02-10"]) {
      const { from, to } = monthRange(m);
      const days = Number(to.slice(8)) - Number(from.slice(8)) + 1;
      expect(days).toBeLessThanOrEqual(31);
    }
  });
  it("espaços antes do dia 1 (semana começa na segunda)", () => {
    expect(monthLeadingBlanks("2026-11-15")).toBe(6); // 1/11/2026 é domingo
    expect(monthLeadingBlanks("2026-06-10")).toBe(0); // 1/6/2026 é segunda
  });
});

describe("rótulo do período", () => {
  it("dia e mês", async () => {
    const { periodLabel } = await import("./agendaViewParams");
    expect(periodLabel("2026-11-23", "dia")).toBe("seg, 23/11");
    expect(periodLabel("2026-11-23", "lista")).toBe("seg, 23/11");
    expect(periodLabel("2026-03-05", "mes")).toBe("Março de 2026");
  });
});
