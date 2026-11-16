/**
 * Estado e pergunta FIXOS do diagnóstico (`pingJev`): sintéticos, sem dado de
 * ninguém, ~350 tokens. É o kill-switch de diagnóstico: "Jev ok / alpha mudou /
 * sem crédito / chave inválida" sem tocar em conversa real.
 */
import type { JevQuestions } from "./types";

export const JEV_PING_STATE = { mensagem: "quero saber o preço do plano anual" } as const;

export const JEV_PING_QUESTIONS: JevQuestions = {
  pede_preco: { type: "noul", instructions: "`mensagem` pede um preço ou valor?" },
};
