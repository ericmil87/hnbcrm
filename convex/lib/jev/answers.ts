/**
 * Forma ENXUTA das respostas gravadas em `jevDecisions` (1 escrita por decisão,
 * poucos bytes) e de volta ao formato de `JevAnswer` para re-rodar a política
 * offline (re-calibrar threshold sem pagar chamada nova — D5).
 *
 * Por que lista e não `Record`: nomes de campo do Convex só aceitam ASCII e as
 * opções de `choice` podem ser nomes de etapa ("Inscrição em andamento"); como
 * chave de objeto isso quebraria a escrita. Sem `legend` (texto nosso, já
 * conhecido pelo `questionsVersion`) e com no máximo `MAX_STORED_PROBS`
 * probabilidades por pergunta (as maiores).
 */
import { v } from "convex/values";
import type { JevAnswer } from "./types";

export const MAX_STORED_PROBS = 12;

export const jevAnswerRowValidator = v.object({
  id: v.string(),
  type: v.union(v.literal("choice"), v.literal("score"), v.literal("noul")),
  choice: v.optional(v.string()),
  score: v.optional(v.number()),
  noul: v.optional(v.number()),
  confidence: v.optional(v.number()),
  probs: v.optional(v.array(v.object({ k: v.string(), p: v.number() }))),
});

export interface JevAnswerRow {
  id: string;
  type: "choice" | "score" | "noul";
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  probs?: Array<{ k: string; p: number }>;
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function toAnswerRows(answers: Record<string, JevAnswer>): JevAnswerRow[] {
  return Object.entries(answers).map(([id, a]): JevAnswerRow => {
    if (a.type === "noul") return { id, type: "noul", noul: r4(a.noul) };
    const probs = Object.entries(a.probabilities)
      .sort((x, y) => y[1] - x[1])
      .slice(0, MAX_STORED_PROBS)
      .map(([k, p]) => ({ k, p: r4(p) }));
    return {
      id,
      type: a.type,
      ...(a.type === "choice" ? { choice: a.choice } : { score: r4(a.score) }),
      ...(a.confidence !== undefined ? { confidence: r4(a.confidence) } : {}),
      probs,
    };
  });
}

export function fromAnswerRows(rows: JevAnswerRow[]): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  for (const r of rows) {
    if (r.type === "noul") {
      out[r.id] = { type: "noul", noul: r.noul ?? 0 };
      continue;
    }
    const probabilities = Object.fromEntries((r.probs ?? []).map((x) => [x.k, x.p]));
    const conf = r.confidence !== undefined ? { confidence: r.confidence } : {};
    out[r.id] =
      r.type === "choice"
        ? { type: "choice", choice: r.choice ?? "", ...conf, probabilities }
        : { type: "score", score: r.score ?? 0, ...conf, probabilities };
  }
  return out;
}
