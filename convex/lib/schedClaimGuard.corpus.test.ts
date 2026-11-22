import { describe, expect, test } from "vitest";
import { evaluateCorpus } from "./schedClaimGuard.corpus.test-helper";

describe("schedClaimGuard — corpus rotulado (eventos reais + cego)", () => {
  test("relatório", () => {
    const r = evaluateCorpus();
    console.log(JSON.stringify(r, null, 1));
    expect(r.events.total).toBeGreaterThan(0);
  });
});
