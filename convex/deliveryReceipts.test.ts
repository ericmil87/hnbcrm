/// <reference types="vite/client" />
// Recibos de entrega/leitura só escrevem quando algo MUDA (perf Convex I/O,
// fase 3): toda escrita numa mensagem reexecuta as queries reativas do Inbox
// que a leram, em todas as abas abertas.
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  return convexTest(schema, modules);
}

const A = "111111111111111@lid";
const B = "222222222222222@lid";

async function seed(t: TestConvex<typeof schema>, opts: { campaign?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org-receipts",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Humano",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      channel: "whatsapp",
      status: "active",
      messageCount: 1,
      createdAt: now,
      updatedAt: now,
    } as any);

    let campaignId: Id<"campaigns"> | undefined;
    if (opts.campaign) {
      const channelConfigId = await ctx.db.insert("channelConfigs", {
        organizationId,
        channel: "whatsapp",
        provider: "bridge",
        displayName: "WhatsApp",
        status: "active",
        createdAt: now,
        updatedAt: now,
      } as any);
      campaignId = await ctx.db.insert("campaigns", {
        organizationId,
        name: "Aviso",
        status: "running",
        channelConfigId,
        provider: "bridge",
        content: { kind: "text", variants: [{ text: "aviso" }] },
        audience: { source: "manual" },
        schedule: {
          timezone: "America/Sao_Paulo",
          windowStartHour: 0,
          windowEndHour: 24,
          days: [0, 1, 2, 3, 4, 5, 6],
        },
        pacing: {
          minDelaySec: 60,
          maxDelaySec: 90,
          batchSize: 0,
          batchPauseMin: 0,
          maxPerHour: 8,
          maxPerDay: 20,
        },
        safeMode: true,
        safety: { checkNumbersFirst: false },
        stats: {
          total: 1,
          pending: 0,
          queued: 0,
          sent: 1,
          delivered: 0,
          read: 0,
          replied: 0,
          failed: 0,
          skipped: 0,
          optedOut: 0,
          consecutiveFailures: 0,
        },
        createdBy: memberId,
        createdAt: now,
        updatedAt: now,
      } as any);
    }

    const messageId = await ctx.db.insert("messages", {
      organizationId,
      conversationId,
      direction: "outbound",
      senderId: memberId,
      senderType: "human",
      externalId: "EXT1",
      content: "oi",
      contentType: "text",
      isInternal: false,
      deliveryStatus: "sent",
      ...(campaignId ? { metadata: { campaign: { campaignId } } } : {}),
      createdAt: now,
    });

    let recipientId: Id<"campaignRecipients"> | undefined;
    if (campaignId) {
      recipientId = await ctx.db.insert("campaignRecipients", {
        organizationId,
        campaignId,
        phone: "5585999990000",
        conversationId,
        messageId,
        status: "sent",
        attempts: 1,
        sentAt: now,
        createdAt: now,
      } as any);
    }
    return { organizationId, messageId, recipientId };
  });
}

function getMsg(t: TestConvex<typeof schema>, id: Id<"messages">) {
  return t.run(async (ctx) => ctx.db.get(id));
}

function getRecipient(t: TestConvex<typeof schema>, id: Id<"campaignRecipients">) {
  return t.run(async (ctx) => ctx.db.get(id));
}

describe("internalApplyGroupReceipt — só grava o que mudou", () => {
  const receipt = (
    organizationId: Id<"organizations">,
    status: "delivered" | "read" | "failed",
    readerJid?: string,
    at = 1000
  ) => ({ organizationId, externalIds: ["EXT1"], status, readerJid, at });

  test("delivered repetido (2º membro) não altera o doc", async () => {
    const t = setup();
    const { organizationId, messageId } = await seed(t);
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "delivered", A));
    const before = await getMsg(t, messageId);
    expect(before!.deliveryStatus).toBe("delivered");
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "delivered", B));
    expect(await getMsg(t, messageId)).toStrictEqual(before);
  });

  test("read repetido do mesmo jid não altera (primeira leitura vence)", async () => {
    const t = setup();
    const { organizationId, messageId } = await seed(t);
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "read", A, 1000));
    const before = await getMsg(t, messageId);
    expect(before!.readBy).toEqual([{ jid: A, at: 1000 }]);
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "read", A, 5000));
    expect(await getMsg(t, messageId)).toStrictEqual(before);
  });

  test("read de jid novo acrescenta", async () => {
    const t = setup();
    const { organizationId, messageId } = await seed(t);
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "read", A, 1000));
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "read", B, 2000));
    const msg = await getMsg(t, messageId);
    expect(msg!.deliveryStatus).toBe("read");
    expect(msg!.readBy).toEqual([
      { jid: A, at: 1000 },
      { jid: B, at: 2000 },
    ]);
  });

  test("failed depois de read ainda vence", async () => {
    const t = setup();
    const { organizationId, messageId } = await seed(t);
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "read", A));
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "failed"));
    expect((await getMsg(t, messageId))!.deliveryStatus).toBe("failed");
  });

  test("hook de campanha só na transição do status da mensagem", async () => {
    const t = setup();
    const { organizationId, recipientId } = await seed(t, { campaign: true });
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "delivered", A));
    expect((await getRecipient(t, recipientId!))!.status).toBe("delivered");

    // Volta o destinatário à mão: se o hook rodasse de novo no recibo do 2º
    // membro, ele subiria outra vez para "delivered".
    await t.run((ctx) => ctx.db.patch(recipientId!, { status: "sent" }));
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "delivered", B));
    expect((await getRecipient(t, recipientId!))!.status).toBe("sent");

    // "read" é transição nova → o hook roda.
    await t.mutation(internal.conversations.internalApplyGroupReceipt, receipt(organizationId, "read", B));
    expect((await getRecipient(t, recipientId!))!.status).toBe("read");
  });
});

describe("internalUpdateDeliveryStatus — nunca rebaixa, nunca reescreve igual", () => {
  const upd = (
    organizationId: Id<"organizations">,
    status: "sent" | "delivered" | "read" | "failed",
    extra: { errorDetail?: string; errorCode?: number } = {}
  ) => ({ organizationId, externalId: "EXT1", status, ...extra });

  test("delivered depois de read não rebaixa e não escreve", async () => {
    const t = setup();
    const { organizationId, messageId } = await seed(t);
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, upd(organizationId, "read"));
    const before = await getMsg(t, messageId);
    expect(before!.deliveryStatus).toBe("read");
    const r = await t.mutation(internal.conversations.internalUpdateDeliveryStatus, upd(organizationId, "delivered"));
    expect(r).toEqual(messageId);
    expect(await getMsg(t, messageId)).toStrictEqual(before);
  });

  test("delivered repetido não escreve", async () => {
    const t = setup();
    const { organizationId, messageId } = await seed(t);
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, upd(organizationId, "delivered"));
    const before = await getMsg(t, messageId);
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, upd(organizationId, "delivered"));
    expect(await getMsg(t, messageId)).toStrictEqual(before);
  });

  test("sent após delivered é ignorado", async () => {
    const t = setup();
    const { organizationId, messageId } = await seed(t);
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, upd(organizationId, "delivered"));
    const before = await getMsg(t, messageId);
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, upd(organizationId, "sent"));
    expect(await getMsg(t, messageId)).toStrictEqual(before);
  });

  test("failed após read grava (com o detalhe do erro)", async () => {
    const t = setup();
    const { organizationId, messageId } = await seed(t);
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, upd(organizationId, "read"));
    await t.mutation(
      internal.conversations.internalUpdateDeliveryStatus,
      upd(organizationId, "failed", { errorDetail: "boom", errorCode: 131026 })
    );
    const msg = await getMsg(t, messageId);
    expect(msg!.deliveryStatus).toBe("failed");
    expect(msg!.metadata).toMatchObject({ deliveryError: "boom", deliveryErrorCode: 131026 });
  });

  test("hook de campanha não roda em recibo que não muda nada", async () => {
    const t = setup();
    const { organizationId, recipientId } = await seed(t, { campaign: true });
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, upd(organizationId, "delivered"));
    expect((await getRecipient(t, recipientId!))!.status).toBe("delivered");
    await t.run((ctx) => ctx.db.patch(recipientId!, { status: "sent" }));
    await t.mutation(internal.conversations.internalUpdateDeliveryStatus, upd(organizationId, "delivered"));
    expect((await getRecipient(t, recipientId!))!.status).toBe("sent");
  });
});
