import { test } from "vitest";
import { evaluateCorpus } from "./schedClaimGuard.corpus.test-helper";
test("rep", () => { throw new Error("REP " + JSON.stringify(evaluateCorpus())); });
