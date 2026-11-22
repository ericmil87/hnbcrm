import { describe, expect, test } from "vitest";
import { detectUnbackedBookingClaim } from "./schedClaimGuard";
import { buildState } from "./schedClaimGuard.corpus.test-helper";
import { JUDGE_HOLDOUT_BAD, JUDGE_HOLDOUT_GOOD, JUDGE_NEW_BAD, JUDGE_NEW_GOOD } from "./schedClaimJudge.corpus.test-helper";
import { shouldJudge } from "./schedClaimJudge";

/**
 * Só o LÉXICO, em CI (o juiz precisa de modelo real e foi medido fora: `temp/agenda-v2/simulacoes-ia/juiz/`). Este teste fixa o motivo de o
 * juiz existir: afirmações indevidas que o léxico deixa passar. Se o léxico melhorar e uma delas passar a ser barrada, tire-a da lista.
 * Medição com `deepseek-flash-latest` (22/11/2026): léxico sozinho deixa passar 9 das 50 indevidas novas (18%); léxico + juiz, 0 de 50;
 * legítimas barradas 1 de 50 (a do léxico, `L14`) nos dois casos.
 */
const KNOWN_LEXICAL_LEAKS = ["N13", "N14", "N16", "N18", "N23", "N24", "H09", "H10", "H12"];
const KNOWN_LEXICAL_FALSE_POSITIVES = ["L14"];

describe("juiz de afirmação: corpus novo (60 + 40 holdout), só o léxico", () => {
  const blocked = (b: { text: string; state: Parameters<typeof buildState>[0] }) => detectUnbackedBookingClaim(b.text, buildState(b.state)) !== null;
  const bad = [...JUDGE_NEW_BAD, ...JUDGE_HOLDOUT_BAD];
  const good = [...JUDGE_NEW_GOOD, ...JUDGE_HOLDOUT_GOOD];

  test("tamanhos: 30 + 30 escritas antes de afinar o prompt, 20 + 20 de holdout", () => {
    expect([JUDGE_NEW_BAD.length, JUDGE_NEW_GOOD.length, JUDGE_HOLDOUT_BAD.length, JUDGE_HOLDOUT_GOOD.length]).toEqual([30, 30, 20, 20]);
  });
  test("as indevidas que o léxico deixa passar são exatamente as conhecidas (o juiz é a rede para elas)", () => {
    expect(bad.filter((b) => !blocked(b)).map((b) => b.id)).toEqual(KNOWN_LEXICAL_LEAKS);
  });
  test("as legítimas que o léxico barra são exatamente as conhecidas", () => {
    expect(good.filter(blocked).map((b) => b.id)).toEqual(KNOWN_LEXICAL_FALSE_POSITIVES);
  });
  test("todas as indevidas que o léxico deixa passar disparam o gatilho do juiz (senão ele nem seria chamado)", () => {
    for (const b of bad.filter((x) => KNOWN_LEXICAL_LEAKS.includes(x.id))) expect(shouldJudge(b.text), b.text).toBe(true);
  });
});
