import { describe, expect, it } from "vitest";
import { ROUND2 } from "../../src/test/schedConfirmParserTables";
import { matchesProposal, normalizeConfirmationText, parseConfirmation } from "./schedConfirmParser";

// Rodada 2 da revisão adversarial do PR #175 (184 frases escritas pelo revisor).
//  - cls "txt": o próprio texto mostra que não é confirmação -> o parser TEM de pegar (nunca completo).
//  - cls "ctx": o texto é idêntico a uma confirmação verdadeira ("Agendado pra quinta 10h" sobre uma entrega);
//    só a conversa mostra que não é. Aqui documentamos o limite: o parser as vê como confirmação (podem sair
//    "completo") e a BARREIRA é a terceira condição do plano §8.1: `matchesProposal` exige uma proposta aberta
//    com o mesmo dia e a mesma hora. Sem proposta coincidente, `ok` é sempre false.
//  - cls ausente: confirmações verdadeiras; act/data/hora exatos.
const { CASES, CLK } = ROUND2;

describe("schedConfirmParser: rodada 2 (184 frases do revisor)", () => {
  it("são 184", () => expect(CASES.length).toBe(184));

  it.each(CASES.map((c) => [`[${c.cat}${c.cls ? "/" + c.cls : ""}] ${c.t}${c.ctx ? ` (${c.ctx})` : ""}`, c] as const))("%s", (_n, c) => {
    const now = c.now ?? CLK.SAT;
    const r = parseConfirmation(c.t, { now, tz: c.tz ?? "America/Sao_Paulo", proposal: c.proposal });
    const norm = normalizeConfirmationText(c.t);
    for (const e of [...r.evidence.act, ...r.evidence.date, ...r.evidence.time, ...r.evidence.blocked]) expect(norm).toContain(e);
    if (c.exp === "NOCOMP") {
      if (c.cls === "txt") {
        expect(r.level === "completo" && r.act === "confirmou", JSON.stringify(r)).toBe(false);
      } else {
        // ctx: o parser pode ver confirmação; a barreira é a terceira condição (sem proposta coincidente, ok=false)
        const noProposal = matchesProposal(r, undefined, now);
        expect(noProposal.ok).toBe(false);
        if (c.proposal) {
          // proposta aberta mas recusada/inconclusiva: "ok" curto só com proposta do cliente e aceita; aqui o
          // contexto (recusa, outro assunto) não está no texto, então documentamos que o parser confirma e o
          // chamador precisa checar que a proposta é a ÚLTIMA mensagem do cliente.
          expect(["confirmou", "nenhum"]).toContain(r.act);
        }
        // proposta de outro dia/hora nunca coincide
        const other = matchesProposal(r, { localDate: "2030-01-01", timeMin: 7 * 60 + 13, by: "cliente", at: now - 1000 }, now);
        expect(other.ok).toBe(false);
      }
    } else {
      expect(r.act, JSON.stringify(r)).toBe(c.exp.act);
      expect(r.localDate, JSON.stringify(r)).toBe(c.exp.date);
      expect(r.timeMin, JSON.stringify(r)).toBe(c.exp.time);
    }
  });
});
