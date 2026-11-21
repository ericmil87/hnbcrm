import { describe, expect, it } from "vitest";
import { periodWindow, resolveDateRef } from "./schedRelativeDates";
import { atLocalMinutes, diffLocalDays } from "./schedTime";

const tz = "America/Sao_Paulo";
const noon = (date: string, zone = tz) => atLocalMinutes(date, 12 * 60, zone);
const ok = (ref: string, date: string, zone = tz) => {
  const r = resolveDateRef(ref, noon(date, zone), zone);
  if (!r.ok) throw new Error(r.error);
  return r;
};
type Row = [string, string, string, string]; // ref, from, to, echo

describe("numa sexta (2026-11-27)", () => {
  const rows: Row[] = [
    ["hoje", "2026-11-27", "2026-11-27", "sex, 27/11/2026"],
    ["amanha", "2026-11-28", "2026-11-28", "sáb, 28/11/2026"],
    ["depois_de_amanha", "2026-11-29", "2026-11-29", "dom, 29/11/2026"],
    ["esta_semana", "2026-11-27", "2026-11-29", "sex, 27/11/2026 a dom, 29/11/2026"],
    ["proxima_semana", "2026-11-30", "2026-12-06", "seg, 30/11/2026 a dom, 06/12/2026"],
    ["proximos_dias", "2026-11-27", "2026-12-03", "sex, 27/11/2026 a qui, 03/12/2026"],
  ];
  it.each(rows)("%s", (ref, from, to, echo) => {
    expect(ok(ref, "2026-11-27")).toEqual({ ok: true, from, to, echo });
  });
});

describe("num domingo (2026-11-29)", () => {
  const rows: Row[] = [
    ["hoje", "2026-11-29", "2026-11-29", "dom, 29/11/2026"],
    ["amanha", "2026-11-30", "2026-11-30", "seg, 30/11/2026"],
    ["depois_de_amanha", "2026-12-01", "2026-12-01", "ter, 01/12/2026"],
    ["esta_semana", "2026-11-29", "2026-11-29", "dom, 29/11/2026"], // domingo: só hoje
    ["proxima_semana", "2026-11-30", "2026-12-06", "seg, 30/11/2026 a dom, 06/12/2026"],
    ["proximos_dias", "2026-11-29", "2026-12-05", "dom, 29/11/2026 a sáb, 05/12/2026"],
  ];
  it.each(rows)("%s", (ref, from, to, echo) => {
    expect(ok(ref, "2026-11-29")).toEqual({ ok: true, from, to, echo });
  });
});

describe("virada de mês (dia 31) e de ano (31/12)", () => {
  it("31/10/2026 (sábado): amanhã é 01/11 e a próxima semana começa em 02/11", () => {
    expect(ok("amanha", "2026-10-31").from).toBe("2026-11-01");
    expect(ok("depois_de_amanha", "2026-10-31").from).toBe("2026-11-02");
    expect(ok("esta_semana", "2026-10-31")).toMatchObject({ from: "2026-10-31", to: "2026-11-01" });
    expect(ok("proxima_semana", "2026-10-31")).toMatchObject({ from: "2026-11-02", to: "2026-11-08" });
    expect(ok("proximos_dias", "2026-10-31")).toMatchObject({ from: "2026-10-31", to: "2026-11-06" });
  });
  it("31/12/2026 (quinta): atravessa para 2027", () => {
    expect(ok("hoje", "2026-12-31").echo).toBe("qui, 31/12/2026");
    expect(ok("amanha", "2026-12-31")).toMatchObject({ from: "2027-01-01", echo: "sex, 01/01/2027" });
    expect(ok("depois_de_amanha", "2026-12-31").from).toBe("2027-01-02");
    expect(ok("esta_semana", "2026-12-31")).toMatchObject({ from: "2026-12-31", to: "2027-01-03" });
    expect(ok("proxima_semana", "2026-12-31")).toMatchObject({ from: "2027-01-04", to: "2027-01-10" });
    expect(ok("proximos_dias", "2026-12-31")).toMatchObject({ from: "2026-12-31", to: "2027-01-06" });
  });
  it("29/02 em ano bissexto (2028) e 28/02 em ano comum", () => {
    expect(ok("amanha", "2028-02-28").from).toBe("2028-02-29");
    expect(ok("amanha", "2026-02-28").from).toBe("2026-03-01");
  });
});

describe("fuso da org e teto de 7 dias", () => {
  it("o 'hoje' segue o fuso: 22:30 de sexta em São Paulo já é sábado em Lisboa", () => {
    const instant = Date.parse("2026-11-28T01:30:00Z");
    const sp = resolveDateRef("hoje", instant, "America/Sao_Paulo");
    const lis = resolveDateRef("hoje", instant, "Europe/Lisbon");
    expect(sp).toMatchObject({ ok: true, from: "2026-11-27" });
    expect(lis).toMatchObject({ ok: true, from: "2026-11-28" });
    const kol = resolveDateRef("hoje", Date.parse("2026-11-27T19:00:00Z"), "Asia/Kolkata"); // 00:30 do dia 28 na Índia
    expect(kol).toMatchObject({ ok: true, from: "2026-11-28" });
  });
  it("nenhuma janela passa de 7 dias", () => {
    for (const ref of ["hoje", "amanha", "depois_de_amanha", "esta_semana", "proxima_semana", "proximos_dias"]) {
      for (const d of ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]) {
        const r = ok(ref, d);
        expect(diffLocalDays(r.from, r.to) + 1).toBeLessThanOrEqual(7);
        expect(r.from <= r.to).toBe(true);
      }
    }
  });
  it("dia de 25 h em Nova York não desloca a data (1º/11/2026)", () => {
    const r = resolveDateRef("amanha", atLocalMinutes("2026-11-01", 23 * 60 + 30, "America/New_York"), "America/New_York");
    expect(r).toMatchObject({ ok: true, from: "2026-11-02" });
  });
  it("tz inválida lança", () => {
    expect(() => resolveDateRef("hoje", 0, "Mars/Base")).toThrow();
  });
});

describe("datas explícitas, acentos e erros", () => {
  it("aceita AAAA-MM-DD de hoje em diante e devolve o eco com o dia da semana", () => {
    expect(ok("2026-12-03", "2026-11-27")).toEqual({ ok: true, from: "2026-12-03", to: "2026-12-03", echo: "qui, 03/12/2026" });
    expect(ok("2026-11-27", "2026-11-27").from).toBe("2026-11-27");
    expect(ok("2027-06-01", "2026-11-27").from).toBe("2027-06-01"); // longe vale; o teto é por janela
  });
  it("recusa data no passado e data impossível, com mensagem PT-BR", () => {
    const past = resolveDateRef("2026-11-26", noon("2026-11-27"), tz);
    expect(past).toEqual({ ok: false, error: expect.stringContaining("já passou") });
    expect(resolveDateRef("2026-02-30", noon("2026-11-27"), tz).ok).toBe(false);
    expect(resolveDateRef("2026-13-01", noon("2026-11-27"), tz).ok).toBe(false);
  });
  it("normaliza caixa, acento e separador", () => {
    expect(ok("Amanhã", "2026-11-27").from).toBe("2026-11-28");
    expect(ok("depois de amanhã", "2026-11-27").from).toBe("2026-11-29");
    expect(ok(" PRÓXIMA-SEMANA ", "2026-11-27").from).toBe("2026-11-30");
  });
  it("referência desconhecida lista os valores aceitos", () => {
    const r = resolveDateRef("semana que vem", noon("2026-11-27"), tz);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("proxima_semana");
    expect(resolveDateRef("", noon("2026-11-27"), tz).ok).toBe(false);
  });
});

describe("periodWindow", () => {
  it("manhã 0–720, tarde 720–1080, noite 1080–1440, qualquer o dia todo", () => {
    expect(periodWindow("manha")).toEqual({ startMin: 0, endMin: 720 });
    expect(periodWindow("tarde")).toEqual({ startMin: 720, endMin: 1080 });
    expect(periodWindow("noite")).toEqual({ startMin: 1080, endMin: 1440 });
    expect(periodWindow("qualquer")).toEqual({ startMin: 0, endMin: 1440 });
  });
});
