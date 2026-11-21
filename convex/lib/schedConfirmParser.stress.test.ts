import { describe, expect, it } from "vitest";
import { OWN100, SAT } from "../../src/test/schedConfirmParserTables";
import { CONFIRM_MAX_CHARS, normalizeConfirmationText, parseConfirmation, prefilterConfirmation } from "./schedConfirmParser";

// 100 frases adversariais próprias (classes que a rodada 1 não cobre); dados em src/test/schedConfirmParserTables.ts.
const ROWS = OWN100;

const run = (t: string) => parseConfirmation(t, { now: SAT, tz: "America/Sao_Paulo" });

describe("schedConfirmParser: 100 frases adversariais próprias", () => {
  it("são 100", () => expect(ROWS.length).toBe(100));

  it.each(ROWS.map((r) => [r.t.replace(/\n/g, "⏎"), r] as const))("%s", (_n, row) => {
    const r = run(row.t);
    if (row.exp === "NC") {
      expect(r.act, JSON.stringify(r)).not.toBe("confirmou");
      expect(r.level, JSON.stringify(r)).not.toBe("completo");
    } else {
      expect(r.act, JSON.stringify(r)).toBe(row.exp.act);
      expect(r.localDate, JSON.stringify(r)).toBe(row.exp.date);
      expect(r.timeMin, JSON.stringify(r)).toBe(row.exp.time);
    }
    if (row.lvl) expect(r.level, JSON.stringify(r)).toBe("completo");
    const norm = normalizeConfirmationText(row.t);
    for (const e of [...r.evidence.act, ...r.evidence.date, ...r.evidence.time, ...r.evidence.service, ...r.evidence.blocked]) expect(norm).toContain(e);
  });

  it("zero falso positivo; 'completo' só em confirmação com dia e hora resolvidos", () => {
    let completos = 0;
    for (const row of ROWS) {
      const r = run(row.t);
      if (row.exp === "NC") expect(r.act, row.t).not.toBe("confirmou");
      if (r.level === "completo") {
        completos++;
        expect(r.act, row.t).toBe("confirmou");
        expect(r.resolved.date && r.resolved.time, row.t).toBe(true);
      }
    }
    expect(completos).toBeGreaterThanOrEqual(12);
  });
});

describe("schedConfirmParser: robustez", () => {
  const ctx = { now: SAT, tz: "America/Sao_Paulo" };
  it("5.000 caracteres repetitivos em menos de 5 ms (média de 20 chamadas)", () => {
    for (const unit of ["a ", "1 a ", "as 1 ", "das 1 e ", "seg a ", "dia ", "10h", "confirmado quinta 10h ", "👍", "11/", "vou x ", "depois de "]) {
      const text = unit.repeat(Math.ceil(5000 / unit.length)).slice(0, 5000);
      parseConfirmation(text, ctx);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) {
        parseConfirmation(text, ctx);
        prefilterConfirmation(text);
      }
      expect((performance.now() - t0) / 20, unit).toBeLessThan(5);
    }
  });

  it("599 caracteres adversariais não explodem (backtracking)", () => {
    for (const unit of ["as 1 ", "das 1 e ", "seg a ", "1h1 ", "a ", "dia 1 de ", "depois de ", "vou x ", "1/1/1 "]) {
      const text = unit.repeat(Math.ceil(CONFIRM_MAX_CHARS / unit.length)).slice(0, CONFIRM_MAX_CHARS - 1);
      const t0 = performance.now();
      parseConfirmation(text, ctx);
      prefilterConfirmation(text);
      expect(performance.now() - t0, unit).toBeLessThan(50);
    }
  });

  it("entradas estranhas não lançam e a evidência é substring do texto normalizado (NFC)", () => {
    const entradas = ["", "   \n\t ", "👍🏽🙏✅", "👨‍👩‍👧 confirmado amanhã 10h", "Confirmado amanhã às 10h".normalize("NFD"), "Confirmado quinta 10h", "Confir​mado quinta 10h", "CONFİRMADO quinta 10h", "\ud83d confirmado amanhã 10h", "‮confirmado amanhã 10h"];
    for (const e of entradas) {
      const r = run(e);
      const norm = normalizeConfirmationText(e);
      for (const ev of [...r.evidence.act, ...r.evidence.date, ...r.evidence.time, ...r.evidence.blocked]) expect(norm).toContain(ev);
      prefilterConfirmation(e);
    }
    expect(() => parseConfirmation(null as unknown as string, ctx)).not.toThrow();
    expect(() => parseConfirmation(42 as unknown as string, ctx)).not.toThrow();
  });
});
