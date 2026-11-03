/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { PACING_CHAT_GAP_MS, PACING_GLOBAL_GAP_MS, claimTelegramSendSlot } from "./telegramPacing";

const modules = import.meta.glob("../**/!(*.*.*)*.*s");

describe("claimTelegramSendSlot", () => {
  test("constantes do D25: 1 msg/s por chat, 25 msg/s global", () => {
    expect(PACING_CHAT_GAP_MS).toBe(1000);
    expect(1000 / PACING_GLOBAL_GAP_MS).toBe(25);
  });

  test("claims na mesma transação avançam os dois cursores", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("telegramChats", { chatId: 1, telegramUserId: 1, updatedAt: 0 });
      const a = await claimTelegramSendSlot(ctx, { chatId: 1, now: 10_000 });
      const b = await claimTelegramSendSlot(ctx, { chatId: 1, now: 10_000 });
      const c = await claimTelegramSendSlot(ctx, { chatId: 2, now: 10_000 });
      expect([a.sendAt, b.sendAt, c.sendAt]).toEqual([10_000, 11_000, 11_040]);
      const global = await ctx.db.query("telegramPacing").first();
      expect(global).toMatchObject({ key: "platform", windowStart: 11_080, sentInWindow: 3 });
    });
  });
});
