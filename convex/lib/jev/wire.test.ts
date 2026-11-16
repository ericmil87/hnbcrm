import { describe, expect, it } from "vitest";
import { questionsFromWire, questionsToWire } from "./wire";
import { JevValidationError, type JevQuestions } from "./types";

const Q: JevQuestions = {
  etapa: { type: "choice", instructions: "Em qual etapa?", criteria: { "Inscrição em andamento": "a", "Retorno / recorrente": "b", "Não agendou": "c" } },
  urgencia: { type: "score", instructions: "Urgência?", criteria: ["baixa", "alta"] },
  pede_humano: { type: "noul", instructions: "Pede uma pessoa?" },
};

describe("formato de fio das perguntas", () => {
  it("ida e volta preserva ids, ordem das opções, acento e barra", () => {
    const back = questionsFromWire(questionsToWire(Q));
    expect(back).toEqual(Q);
    expect(Object.keys((back.etapa as { criteria: Record<string, string> }).criteria)).toEqual(["Inscrição em andamento", "Retorno / recorrente", "Não agendou"]);
  });
  it("na lista a opção é VALOR (nome de campo do Convex só aceita ASCII; chave de objeto quebraria o runAction)", () => {
    const wire = questionsToWire(Q);
    const etapa = wire.find((w) => w.id === "etapa")!;
    expect(etapa.options).toEqual([
      { key: "Inscrição em andamento", description: "a" },
      { key: "Retorno / recorrente", description: "b" },
      { key: "Não agendou", description: "c" },
    ]);
    // nenhuma CHAVE de objeto do payload tem caractere fora do ASCII
    const keys = JSON.stringify(wire).match(/"([^"\\]+)":/g) ?? [];
    for (const k of keys) expect(k).toMatch(/^[\x20-\x7e]+$/);
  });
  it("id ou opção repetida e `__proto__` são recusados; a validação de faixa continua valendo", () => {
    const bad = (f: () => unknown) => expect(f).toThrow(JevValidationError);
    bad(() => questionsFromWire([{ id: "a", type: "noul", instructions: "?" }, { id: "a", type: "noul", instructions: "?" }]));
    bad(() => questionsFromWire([{ id: "a", type: "choice", instructions: "?", options: [{ key: "x", description: "d" }, { key: "x", description: "d" }] }]));
    bad(() => questionsFromWire([{ id: "a", type: "choice", instructions: "?", options: [{ key: "__proto__", description: "d" }, { key: "y", description: "d" }] }]));
    bad(() => questionsFromWire([{ id: "a", type: "choice", instructions: "?", options: [{ key: "so", description: "uma" }] }]));
    bad(() => questionsFromWire([{ id: "a", type: "score", instructions: "?", levels: ["um"] }]));
    bad(() => questionsFromWire([]));
  });
});
