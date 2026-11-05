import { describe, expect, it } from "vitest";
import { canReplaceDefaultBoard } from "./boardOps";


describe("canReplaceDefaultBoard", () => {
  const rows = (n: number) => Array.from({ length: n }, () => ({}));
  it("permite quando as listas não chegaram ao limite", () => {
    expect(canReplaceDefaultBoard({ forms: rows(199), campaigns: rows(0), limit: 200 })).toBe(true);
  });
  it("recusa (fail-closed) quando uma lista veio cheia", () => {
    expect(canReplaceDefaultBoard({ forms: rows(200), campaigns: rows(0), limit: 200 })).toBe(false);
    expect(canReplaceDefaultBoard({ forms: rows(0), campaigns: rows(200), limit: 200 })).toBe(false);
  });
});
