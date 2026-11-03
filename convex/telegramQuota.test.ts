/// <reference types="vite/client" />
/**
 * Copiloto no Telegram — F4 (D25): reserva/liberação de cota de arquivos,
 * pacing por chat e global, retenção de `telegramOrgQuota`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;
const T0 = Date.UTC(2026, 10, 3, 14, 30, 0); // 11:30 America/Sao_Paulo

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed(slug = "a") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", { email: `u-${slug}@x.test` });
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${slug}`, slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { telegram: true } },
      createdAt: now, updatedAt: now,
    } as any);
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Eric", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const linkId = await ctx.db.insert("telegramLinks", {
      organizationId, teamMemberId: memberId, userId, chatId: 4000, telegramUserId: 4000, status: "active",
      prefs: { relayAssignedConversations: true, mediaInbound: true },
      assistant: { mode: "suggest", suggestOnEvents: true, autoSendDelaySeconds: 15, autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false } },
      reports: { enabled: true, morningHour: 8, eveningHour: 18 }, linkedAt: now, lastSeenAt: now,
    });
    return { organizationId, linkId, memberId, userId };
  });
}

const reserve = (s: { linkId: Id<"telegramLinks">; organizationId: Id<"organizations"> }, bytes = 1024, now = Date.now()) =>
  t.mutation(internal.telegramQuota.internalReserveFileQuota, { linkId: s.linkId, organizationId: s.organizationId, bytes, now });

describe("internalReserveFileQuota", () => {
  test("o 31º arquivo da hora é recusado com a cópia; na hora seguinte passa", async () => {
    const s = await seed();
    for (let i = 0; i < 30; i++) expect((await reserve(s)).ok).toBe(true);
    const refused = await reserve(s);
    expect(refused).toMatchObject({
      ok: false,
      reason: "hour",
      copy: "⏳ Você já enviou 30 arquivos nesta hora pelo Telegram. Libera às 12:00. Enquanto isso, use o CRM.",
    });
    const link = await t.run((ctx) => ctx.db.get(s.linkId));
    expect(link?.quota?.filesThisHour).toBe(30);
    expect((await reserve(s, 1024, T0 + 3_600_000)).ok).toBe(true);
  });

  test("bytes do dia somam por vínculo e os contadores da org são gravados", async () => {
    const s = await seed();
    const big = 100 * 1024 * 1024;
    expect((await reserve(s, big)).ok).toBe(true);
    const refused = await reserve(s, 60 * 1024 * 1024);
    expect(refused).toMatchObject({ ok: false, reason: "day_bytes" });
    const org = await t.run((ctx) => ctx.db.query("telegramOrgQuota").collect());
    expect(org).toEqual([expect.objectContaining({ dayKey: "2026-11-03", files: 1, bytes: big })]);
  });

  test("o 501º arquivo da org no dia é recusado (vínculos diferentes)", async () => {
    const s = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("telegramOrgQuota", { organizationId: s.organizationId, dayKey: "2026-11-03", files: 500, bytes: 0 });
    });
    const refused = await reserve(s);
    expect(refused).toMatchObject({ ok: false, reason: "org_day" });
    expect((refused as { copy: string }).copy).toContain("500 arquivos hoje");
    // A refusal writes nothing: the link counters stay untouched.
    expect((await t.run((ctx) => ctx.db.get(s.linkId)))?.quota).toBeUndefined();
    // Next local day it is allowed again.
    expect((await reserve(s, 1024, Date.UTC(2026, 10, 4, 3, 5))).ok).toBe(true);
  });

  test("vínculo de outra org ou revogado é recusado sem gravar", async () => {
    const s = await seed();
    const other = await seed("b");
    const r = await t.mutation(internal.telegramQuota.internalReserveFileQuota, {
      linkId: s.linkId, organizationId: other.organizationId, bytes: 1, now: Date.now(),
    });
    expect(r).toMatchObject({ ok: false, reason: "link" });
    await t.run((ctx) => ctx.db.patch(s.linkId, { status: "revoked" }));
    expect(await reserve(s)).toMatchObject({ ok: false, reason: "link" });
    expect(await t.run((ctx) => ctx.db.query("telegramOrgQuota").collect())).toHaveLength(0);
  });

  test("liberar devolve o slot (hora, bytes e org)", async () => {
    const s = await seed();
    for (let i = 0; i < 30; i++) await reserve(s, 1000);
    expect((await reserve(s, 1000)).ok).toBe(false);
    await t.mutation(internal.telegramQuota.internalReleaseFileQuota, {
      linkId: s.linkId, organizationId: s.organizationId, bytes: 1000, dayKey: "2026-11-03", hourStart: Date.UTC(2026, 10, 3, 14, 0),
    });
    const link = await t.run((ctx) => ctx.db.get(s.linkId));
    expect(link?.quota).toMatchObject({ filesThisHour: 29, bytesToday: 29_000 });
    const [org] = await t.run((ctx) => ctx.db.query("telegramOrgQuota").collect());
    expect(org).toMatchObject({ files: 29, bytes: 29_000 });
    const again = await reserve(s, 1000);
    expect(again).toEqual({ ok: true, dayKey: "2026-11-03", hourStart: Date.UTC(2026, 10, 3, 14, 0) });
  });

  test("liberar de um balde que já virou não mexe no balde novo", async () => {
    const s = await seed();
    const first = await reserve(s, 500);
    expect(first.ok).toBe(true);
    await reserve(s, 500, T0 + 3_600_000); // next hour bucket
    await t.mutation(internal.telegramQuota.internalReleaseFileQuota, {
      linkId: s.linkId, organizationId: s.organizationId, bytes: 500, dayKey: "2026-11-03", hourStart: Date.UTC(2026, 10, 3, 14, 0),
    });
    const link = await t.run((ctx) => ctx.db.get(s.linkId));
    expect(link?.quota?.filesThisHour).toBe(1);
  });
});

describe("pacing (claim de slot)", () => {
  test("30 claims no mesmo instante: ≥ 40 ms no global e ≥ 1 s por chat", async () => {
    const chats = [5001, 5002, 5003];
    await t.run(async (ctx) => {
      for (const chatId of chats) await ctx.db.insert("telegramChats", { chatId, telegramUserId: chatId, updatedAt: T0 });
    });
    const slots: { chatId: number; sendAt: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const chatId = chats[i % 3];
      const { sendAt } = await t.mutation(internal.telegramQuota.internalClaimTelegramSendSlot, { chatId, now: T0 });
      slots.push({ chatId, sendAt });
    }
    const sorted = [...slots].sort((a, b) => a.sendAt - b.sendAt);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].sendAt - sorted[i - 1].sendAt).toBeGreaterThanOrEqual(40);
    for (const chatId of chats) {
      const own = slots.filter((s) => s.chatId === chatId).map((s) => s.sendAt);
      for (let i = 1; i < own.length; i++) expect(own[i] - own[i - 1]).toBeGreaterThanOrEqual(1000);
    }
    expect(slots[0].sendAt).toBe(T0);
  });

  test("chat ocioso: claim imediato; depois do cursor, sem espera", async () => {
    await t.run((ctx) => ctx.db.insert("telegramChats", { chatId: 5100, telegramUserId: 5100, updatedAt: T0 }));
    expect((await t.mutation(internal.telegramQuota.internalClaimTelegramSendSlot, { chatId: 5100, now: T0 })).sendAt).toBe(T0);
    expect((await t.mutation(internal.telegramQuota.internalClaimTelegramSendSlot, { chatId: 5100, now: T0 + 5000 })).sendAt).toBe(T0 + 5000);
    // Chat without a row (not linked yet): only the global cursor applies.
    const { sendAt } = await t.mutation(internal.telegramQuota.internalClaimTelegramSendSlot, { chatId: 5999, now: T0 + 5000 });
    expect(sendAt).toBe(T0 + 5040);
  });

  test("exemplo de reagendamento: claim uma vez, reenvia em sendAt sem novo claim", async () => {
    await t.run((ctx) => ctx.db.insert("telegramChats", { chatId: 5200, telegramUserId: 5200, updatedAt: T0 }));
    const a = await t.mutation(internal.telegramQuota.internalClaimTelegramSendSlot, { chatId: 5200, now: T0 });
    const b = await t.mutation(internal.telegramQuota.internalClaimTelegramSendSlot, { chatId: 5200, now: T0 });
    expect(b.sendAt).toBe(a.sendAt + 1000);
    // The caller of `b` reschedules itself at b.sendAt and sends WITHOUT claiming again:
    // the chat cursor stays at b.sendAt + 1000, so the next message queues behind it.
    const chat = await t.run((ctx) => ctx.db.query("telegramChats").withIndex("by_chat_id", (q) => q.eq("chatId", 5200)).first());
    expect(chat?.pacingAt).toBe(b.sendAt + 1000);
    const c = await t.mutation(internal.telegramQuota.internalClaimTelegramSendSlot, { chatId: 5200, now: b.sendAt });
    expect(c.sendAt).toBe(b.sendAt + 1000);
  });
});

describe("retenção de telegramOrgQuota", () => {
  test("apaga linhas com mais de 7 dias e mantém as recentes", async () => {
    const s = await seed();
    await t.run((ctx) => ctx.db.insert("telegramOrgQuota", { organizationId: s.organizationId, dayKey: "2026-11-03", files: 1, bytes: 1 }));
    vi.setSystemTime(T0 + 8 * 86_400_000);
    await t.run((ctx) => ctx.db.insert("telegramOrgQuota", { organizationId: s.organizationId, dayKey: "2026-11-11", files: 2, bytes: 2 }));
    const dry = await t.mutation(internal.retention.internalRunRetentionNow, { table: "telegramOrgQuota" });
    expect(dry.plan[0]).toMatchObject({ table: "telegramOrgQuota", days: 7, count: 1 });
    await t.mutation(internal.retention.internalRunRetentionNow, { table: "telegramOrgQuota", dryRun: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await t.run((ctx) => ctx.db.query("telegramOrgQuota").collect());
    expect(rows.map((r) => r.dayKey)).toEqual(["2026-11-11"]);
  });
});
