import { describe, expect, it } from "vitest";
import { ROUND1, SAT } from "../../src/test/schedConfirmParserTables";
import { normalizeConfirmationText, parseConfirmation } from "./schedConfirmParser";

// Tabela de regressão PERMANENTE da revisão adversarial rodada 1 do PR #175 (171 frases escritas pelo
// revisor, não por quem escreveu as regras). Os dados ficam em src/test/schedConfirmParserTables.ts.
// Não apague frases para fazer teste passar: corrija o parser.
const CASES = ROUND1;

describe("schedConfirmParser: regressão da revisão adversarial (171 frases)", () => {
  it.each(CASES.map((c) => [`[${c.cat}] ${c.t}${c.proposal ? " (+proposta)" : ""}`, c] as const))("%s", (_n, c) => {
    const r = parseConfirmation(c.t, { now: c.now ?? SAT, tz: c.tz ?? "America/Sao_Paulo", proposal: c.proposal });
    const norm = normalizeConfirmationText(c.t);
    for (const e of [...r.evidence.act, ...r.evidence.date, ...r.evidence.time, ...r.evidence.service, ...r.evidence.blocked]) expect(norm).toContain(e);
    if (c.exp === "NC") expect(r.act, JSON.stringify(r)).not.toBe("confirmou");
    else {
      expect(r.act, JSON.stringify(r)).toBe(c.exp.act);
      expect(r.localDate, JSON.stringify(r)).toBe(c.exp.date);
      expect(r.timeMin, JSON.stringify(r)).toBe(c.exp.time);
    }
  });

  it("nenhuma frase negativa (NC) devolve level completo", () => {
    for (const c of CASES) {
      if (c.exp !== "NC") continue;
      const r = parseConfirmation(c.t, { now: c.now ?? SAT, tz: c.tz ?? "America/Sao_Paulo", proposal: c.proposal });
      expect(r.level, c.t).not.toBe("completo");
    }
  });
});
