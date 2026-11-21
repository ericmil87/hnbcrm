import { describe, expect, it } from "vitest";
import { VOCAB, findBannedTerm, vocabLabels } from "./vocab";
import { APPOINTMENT_STATUSES } from "./agendaTypes";
import { fillVocab } from "./agendaCopy";
import { RULE_CODES } from "../../convex/lib/schedRules";

const labels = vocabLabels(VOCAB.scheduling);

describe("VOCAB.scheduling", () => {
  it("nunca usa o verbo Agendar (já significa programar o envio de uma mensagem)", () => {
    for (const label of labels) expect(label, label).not.toMatch(/\bagend(ar|e|ou|amos)\b/i);
  });

  it("tem rótulo para cada código de regra do servidor", () => {
    expect(Object.keys(VOCAB.scheduling.rules).sort()).toEqual([...RULE_CODES].sort());
  });

  it("verbo e substantivo do plano", () => {
    expect(VOCAB.scheduling.book).toBe("Marcar horário");
    expect(VOCAB.scheduling.name).toBe("Agendamento");
    expect(VOCAB.scheduling.one).toBe("agendamento");
  });

  it("tem rótulo PT-BR para cada status do schema", () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(VOCAB.scheduling.status[status], status).toBeTruthy();
    }
    expect(Object.keys(VOCAB.scheduling.status).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
    expect(Object.values(VOCAB.scheduling.status)).toEqual([
      "Aguardando aprovação", "Marcado", "Confirmado", "Chegou", "Atendido", "Faltou", "Cancelado", "Remarcado",
    ]);
  });

  it("nenhum texto usa termo banido nem tem emoji", () => {
    for (const label of labels) {
      expect(findBannedTerm(label), label).toBeNull();
      expect(label, label).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("os textos com variável preenchem todas as chaves", () => {
    expect(fillVocab(VOCAB.scheduling.aiProposal, { quando: "qui, 27/11 às 14:30" })).toBe(
      "A IA reservou qui, 27/11 às 14:30 e aguarda você."
    );
    expect(fillVocab(VOCAB.scheduling.createdFromMessage, { quando: "qui, 27/11 às 10:00" })).toBe(
      "Marquei qui, 27/11 às 10:00 a partir da sua mensagem."
    );
    expect(fillVocab(VOCAB.scheduling.oneTapSuggestion, { nome: "Ana", quando: "qui, 27/11 às 10:00" })).toBe(
      "Marcar Ana qui, 27/11 às 10:00?"
    );
    expect(fillVocab(VOCAB.scheduling.ruleWarning, { recurso: "Sala 1" })).toBe("Fora do horário de Sala 1. Marcar mesmo assim?");
    expect(fillVocab(VOCAB.scheduling.capacityFull, { recurso: "Sala 2" })).toMatch(/^Sala 2 /);
    expect(fillVocab("oi {x}", {})).toBe("oi {x}");
  });
});
