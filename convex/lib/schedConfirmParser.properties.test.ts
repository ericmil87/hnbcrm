import { describe, expect, it } from "vitest";
import { MAIN, OWN100, ROUND1, ROUND2, SAT } from "../../src/test/schedConfirmParserTables";
import { type ConfirmProposal, matchesProposal, normalizeConfirmationText, parseConfirmation, prefilterConfirmation } from "./schedConfirmParser";

// Propriedades que valem sobre TODAS as tabelas juntas (original, rodada 1, 100 próprias, rodada 2).
// Rode também com TZ=Asia/Tokyo, America/Los_Angeles e Pacific/Kiritimati: a saída não pode mudar.
type Row = { t: string; now: number; tz: string; proposal?: ConfirmProposal; origin: string; neverConfirm: boolean; neverComplete: boolean };
const SP = "America/Sao_Paulo";
const ROWS: Row[] = [];
for (const r of [...MAIN.POSITIVAS, ...MAIN.PARCIAIS, ...MAIN.CALENDARIO]) ROWS.push({ t: r.t, now: r.now ?? SAT, tz: r.tz ?? SP, origin: "main", neverConfirm: false, neverComplete: false });
for (const r of MAIN.NEGATIVAS) ROWS.push({ t: r.t, now: r.now ?? SAT, tz: r.tz ?? SP, origin: "main-neg", neverConfirm: true, neverComplete: true });
for (const c of ROUND1) ROWS.push({ t: c.t, now: c.now ?? SAT, tz: c.tz ?? SP, proposal: c.proposal, origin: "round1", neverConfirm: c.exp === "NC", neverComplete: c.exp === "NC" });
for (const r of OWN100) ROWS.push({ t: r.t, now: SAT, tz: SP, origin: "own100", neverConfirm: r.exp === "NC", neverComplete: r.exp === "NC" });
for (const c of ROUND2.CASES) {
  // "ctx": só o contexto mostra que não é confirmação (limite documentado; barreira = matchesProposal)
  ROWS.push({ t: c.t, now: c.now ?? ROUND2.CLK.SAT, tz: c.tz ?? SP, proposal: c.proposal, origin: `round2-${c.cls ?? "ok"}`, neverConfirm: false, neverComplete: c.exp === "NOCOMP" && c.cls === "txt" });
}

const parse = (r: Row) => parseConfirmation(r.t, { now: r.now, tz: r.tz, proposal: r.proposal });

describe("schedConfirmParser: propriedades sobre todas as tabelas", () => {
  it(`cobre ${ROWS.length} frases (pelo menos 650)`, () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(650);
  });

  it("nenhuma não-confirmação devolve 'confirmou'; nenhuma não-confirmação de texto devolve 'completo'", () => {
    const f1 = ROWS.filter((r) => r.neverConfirm && parse(r).act === "confirmou").map((r) => `${r.origin}: ${r.t}`);
    const f2 = ROWS.filter((r) => r.neverComplete && parse(r).level === "completo").map((r) => `${r.origin}: ${r.t}`);
    expect(f1).toEqual([]);
    expect(f2).toEqual([]);
  });

  it("em toda confirmação 'completo' a evidência é substring do texto normalizado (NFC)", () => {
    for (const r of ROWS) {
      const p = parse(r);
      const norm = normalizeConfirmationText(r.t);
      for (const e of [...p.evidence.act, ...p.evidence.date, ...p.evidence.time, ...p.evidence.service, ...p.evidence.blocked]) expect(norm, `${r.origin}: ${r.t}`).toContain(e);
    }
  });

  it("'completo' implica confirmou + dia + hora + form; explícito = dia e hora da própria mensagem", () => {
    for (const r of ROWS) {
      const p = parse(r);
      if (p.level !== "completo") continue;
      const id = `${r.origin}: ${r.t}`;
      expect(p.act, id).toBe("confirmou");
      expect(p.resolved, id).toEqual({ act: true, date: true, time: true });
      expect(p.form, id).toBeDefined();
      if (p.form === "explicito") {
        expect(p.fromMessage, id).toEqual({ localDate: p.localDate, timeMin: p.timeMin });
        expect(p.fromProposal, id).toEqual({ date: false, time: false });
      } else {
        expect(p.fromProposal.date || p.fromProposal.time || r.proposal !== undefined, id).toBe(true);
      }
    }
  });

  it("sem proposta coincidente, matchesProposal nunca aprova (a barreira da terceira condição)", () => {
    for (const r of ROWS) {
      const p = parse(r);
      expect(matchesProposal(p, undefined, r.now).ok, `${r.origin}: ${r.t}`).toBe(false);
      const far: ConfirmProposal = { localDate: "2031-05-05", timeMin: 7 * 60 + 13, by: "cliente", at: r.now - 1000 };
      expect(matchesProposal(p, far, r.now).ok, `${r.origin}: ${r.t}`).toBe(false);
    }
  });

  it("é pura e determinística (duas chamadas iguais) e o pré-filtro não quebra", () => {
    for (const r of ROWS) {
      expect(parse(r), r.t).toEqual(parse(r));
      expect(prefilterConfirmation(r.t), r.t).toEqual(prefilterConfirmation(r.t));
    }
  });

  it("se o pré-filtro reprova, o parser nunca devolve confirmação 'completo' explícita", () => {
    const f = ROWS.filter((r) => !prefilterConfirmation(r.t).pass).filter((r) => {
      const p = parse(r);
      return p.act === "confirmou" && p.level === "completo" && p.form === "explicito";
    });
    expect(f.map((r) => r.t)).toEqual([]);
  });
});
