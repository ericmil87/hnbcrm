import { describe, expect, it } from "vitest";
import { MAX_STORED_PROBS, fromAnswerRows, toAnswerRows } from "./answers";
import type { JevAnswer } from "./types";

describe("respostas enxutas (jevDecisions)", () => {
  const answers: Record<string, JevAnswer> = {
    etapa: { type: "choice", choice: "Inscrição em andamento", confidence: 0.81234, probabilities: { "Inscrição em andamento": 0.9, "Retorno / recorrente": 0.1 } },
    urgencia: { type: "score", score: 0.61, probabilities: { "0": 0.39, "1": 0.61 } },
    pede_humano: { type: "noul", noul: 0.03 },
  };
  it("ida e volta preserva decisão e probabilidades (opção com acento/espaço vira valor, não chave)", () => {
    const rows = toAnswerRows(answers);
    expect(rows.find((r) => r.id === "etapa")!.probs![0]).toEqual({ k: "Inscrição em andamento", p: 0.9 });
    const back = fromAnswerRows(rows);
    expect(back.etapa).toEqual({ type: "choice", choice: "Inscrição em andamento", confidence: 0.8123, probabilities: { "Inscrição em andamento": 0.9, "Retorno / recorrente": 0.1 } });
    expect(back.pede_humano).toEqual({ type: "noul", noul: 0.03 });
    expect(back.urgencia).toEqual({ type: "score", score: 0.61, probabilities: { "0": 0.39, "1": 0.61 } });
  });
  it("guarda só as MAX_STORED_PROBS maiores e sem legend; confidence ausente fica ausente", () => {
    const probabilities = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`o${i}`, i === 7 ? 0.5 : 0.5 / 39]));
    const [row] = toAnswerRows({ x: { type: "choice", choice: "o7", probabilities } });
    expect(row.probs).toHaveLength(MAX_STORED_PROBS);
    expect(row.probs![0]).toEqual({ k: "o7", p: 0.5 });
    expect(row).not.toHaveProperty("confidence");
    expect(row).not.toHaveProperty("legend");
  });
});
