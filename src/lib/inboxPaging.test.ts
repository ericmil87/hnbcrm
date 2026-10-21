import { describe, expect, test } from "vitest";
import {
  canLoadMore,
  limitForKey,
  nextLimit,
  scrollTopAfterPrepend,
  MESSAGES_MAX_LIMIT,
} from "./inboxPaging";

describe("inboxPaging", () => {
  test("canLoadMore: lote cheio abaixo do teto", () => {
    expect(canLoadMore(50, 50, 500)).toBe(true);
    expect(canLoadMore(49, 50, 500)).toBe(false);
    expect(canLoadMore(500, 500, 500)).toBe(false);
  });

  test("nextLimit não passa do teto", () => {
    expect(nextLimit(50, 50, 500)).toBe(100);
    expect(nextLimit(450, 100, MESSAGES_MAX_LIMIT)).toBe(500);
    expect(nextLimit(500, 50, 500)).toBe(500);
  });

  test("limitForKey: chave diferente volta ao default", () => {
    expect(limitForKey({ key: "a", limit: 150 }, "a", 50)).toBe(150);
    expect(limitForKey({ key: "a", limit: 150 }, "b", 50)).toBe(50);
    expect(limitForKey({ key: null, limit: 150 }, null, 50)).toBe(150);
  });

  test("scrollTopAfterPrepend mantém o conteúdo visível no lugar", () => {
    expect(scrollTopAfterPrepend({ scrollTop: 10, scrollHeight: 1000 }, 1600)).toBe(610);
  });
});
