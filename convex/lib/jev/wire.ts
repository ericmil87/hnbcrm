/**
 * Formato de FIO das perguntas entre quem chama `internalDecide` e a action.
 *
 * Por que não passar `JevQuestions` direto: argumento de função do Convex é valor Convex, e nome de
 * CAMPO de objeto só aceita ASCII imprimível. As opções de um `choice` serão nomes de etapa do funil
 * ("Inscrição em andamento", "Retorno / recorrente"): como chave de objeto, o `ctx.runAction` do
 * chamador lançaria ANTES de o fail-open valer (achado da revisão do PR #157). Em lista de
 * `{key, description}` a chave é VALOR. A action reconstrói o objeto e `validateQuestions` valida.
 */
import { v } from "convex/values";
import { JevValidationError, type JevQuestions } from "./types";
import { validateQuestions } from "./validate";

export const jevQuestionWireValidator = v.object({
  id: v.string(),
  type: v.union(v.literal("choice"), v.literal("score"), v.literal("noul")),
  instructions: v.string(),
  /** choice: opção → descrição, na ordem. */
  options: v.optional(v.array(v.object({ key: v.string(), description: v.string() }))),
  /** score: níveis ordenados. */
  levels: v.optional(v.array(v.string())),
});

export interface JevQuestionWire {
  id: string;
  type: "choice" | "score" | "noul";
  instructions: string;
  options?: Array<{ key: string; description: string }>;
  levels?: string[];
}

export function questionsToWire(questions: JevQuestions): JevQuestionWire[] {
  return Object.entries(questions).map(([id, q]): JevQuestionWire => {
    if (q.type === "choice") {
      return { id, type: "choice", instructions: q.instructions, options: Object.entries(q.criteria).map(([key, description]) => ({ key, description })) };
    }
    if (q.type === "score") return { id, type: "score", instructions: q.instructions, levels: [...q.criteria] };
    return { id, type: "noul", instructions: q.instructions };
  });
}

const bad = (message: string) => new JevValidationError("invalid_questions", message);

/** Lista de fio → `JevQuestions` JÁ validado (ids/opções duplicados lançam). */
export function questionsFromWire(list: JevQuestionWire[]): JevQuestions {
  const raw: Record<string, unknown> = Object.create(null);
  for (const w of list) {
    if (w.id in raw) throw bad(`id de pergunta repetido: "${w.id}"`);
    if (w.type === "choice") {
      const criteria: Record<string, string> = Object.create(null);
      for (const o of w.options ?? []) {
        if (o.key in criteria) throw bad(`${w.id}: opção repetida`);
        criteria[o.key] = o.description;
      }
      raw[w.id] = { type: "choice", instructions: w.instructions, criteria };
    } else if (w.type === "score") {
      raw[w.id] = { type: "score", instructions: w.instructions, criteria: w.levels ?? [] };
    } else {
      raw[w.id] = { type: "noul", instructions: w.instructions };
    }
  }
  return validateQuestions(raw);
}
