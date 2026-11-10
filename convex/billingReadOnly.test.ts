/// <reference types="vite/client" />
/**
 * B7: modo leitura (teste vencido, `read_only`, `canceled`). Prova que IA e envio param, que
 * inbound e exportação seguem, que agendadas ficam pending e que org legacy/sem plano
 * não muda nada.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { spendBlockedNow } from "./aiSpend";
import { scheduleOutboundDispatch } from "./lib/outboundDispatch";
import { READ_ONLY_SEND_MESSAGE } from "./lib/readOnly";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const NOW = Date.UTC(2026, 10, 10, 12);
const MONTH = "2026-11";
type Billing = Doc<"organizations">["billing"];

const READ_ONLY: Billing = { plan: "profissional", status: "read_only", updatedAt: 1 };
const CANCELED: Billing = { plan: "essencial", status: "canceled", updatedAt: 1 };
const TRIAL_EXPIRED: Billing = { plan: "profissional", status: "trial", trialEndsAt: NOW - 1, updatedAt: 1 };
const TRIAL_VALID: Billing = { plan: "profissional", status: "trial", trialEndsAt: NOW + 86_400_000, updatedAt: 1 };
const ACTIVE: Billing = { plan: "profissional", status: "active", updatedAt: 1 };
const PAST_DUE: Billing = { plan: "profissional", status: "past_due", updatedAt: 1 };
const LEGACY: Billing = { status: "legacy", updatedAt: 1 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed(billing?: Billing) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Leitura",
      slug: "org-leitura",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      ...(billing ? { billing } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "admin@empresa-teste.com.br" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número",
      phoneNumberId: "555000111",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "V", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", { organizationId, boardId, name: "N", color: "#000", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Cliente", phone: "5585999990001", tags: [], createdAt: now, updatedAt: now });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Cliente", contactId, boardId, stageId, assignedTo: adminId, value: 0, currency: "BRL", priority: "medium",
      temperature: "warm", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active", lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
    });
    return { organizationId, adminUserId, adminId, configId, leadId, conversationId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;
const admin = (s: Seed) => t.withIdentity({ subject: `${s.adminUserId}|s1` });
const setBilling = (id: Id<"organizations">, billing: Billing) => t.run((ctx) => ctx.db.patch(id, { billing }));

describe("gate de IA dos demais produtos (internalSpendGate / spendBlockedNow)", () => {
  test("read_only, canceled e teste vencido bloqueiam com readOnly; o resto passa", async () => {
    const cases: Array<[string, Billing | undefined, boolean]> = [
      ["read_only", READ_ONLY, true],
      ["canceled", CANCELED, true],
      ["trial vencido", TRIAL_EXPIRED, true],
      ["trial válido", TRIAL_VALID, false],
      ["active", ACTIVE, false],
      ["past_due", PAST_DUE, false],
      ["legacy", LEGACY, false],
      ["sem billing", undefined, false],
    ];
    for (const [label, billing, blocked] of cases) {
      const s = await seed(billing);
      const gate = await t.query(internal.aiSpend.internalSpendGate, { organizationId: s.organizationId, month: MONTH, now: NOW });
      expect(gate.blocked, label).toBe(blocked);
      expect(gate.readOnly, label).toBe(blocked);
      expect(gate.reason, label).toBe(blocked ? "plano_inativo" : null);
      const org = (await t.run((ctx) => ctx.db.get(s.organizationId)))!;
      expect(await t.run((ctx) => spendBlockedNow(ctx, org, NOW)), label).toBe(blocked);
    }
  });
});

describe("envio humano em modo leitura", () => {
  test("sendMessage recusa com a mensagem PT-BR; nota interna segue liberada", async () => {
    const s = await seed(READ_ONLY);
    await expect(admin(s).mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: "Oi" })).rejects.toThrow(
      READ_ONLY_SEND_MESSAGE
    );
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
    const note = await admin(s).mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: "nota", isInternal: true });
    expect(note).toBeTruthy();
  });

  test("REST/Telegram/Copiloto (internalSendMessage) e template também recusam", async () => {
    const s = await seed(CANCELED);
    await expect(
      t.mutation(internal.conversations.internalSendMessage, { conversationId: s.conversationId, content: "Oi", teamMemberId: s.adminId })
    ).rejects.toThrow(READ_ONLY_SEND_MESSAGE);
    await expect(
      t.mutation(internal.conversations.internalSendTemplate, {
        conversationId: s.conversationId,
        teamMemberId: s.adminId,
        templateName: "boas_vindas",
        languageCode: "pt_BR",
      })
    ).rejects.toThrow(READ_ONLY_SEND_MESSAGE);
  });

  test("legacy e active continuam enviando (regressão)", async () => {
    for (const billing of [LEGACY, ACTIVE, undefined]) {
      const s = await seed(billing);
      const id = await admin(s).mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: "Oi" });
      expect(id).toBeTruthy();
    }
  });

  test("porta scheduleOutboundDispatch: mensagem que chega em modo leitura falha com o motivo (defesa)", async () => {
    const s = await seed(READ_ONLY);
    const result = await t.run(async (ctx) => {
      const conversation = (await ctx.db.get(s.conversationId))!;
      const messageId = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, direction: "outbound", senderId: s.adminId,
        senderType: "human", content: "Oi", contentType: "text", isInternal: false, createdAt: Date.now(),
      });
      await scheduleOutboundDispatch(ctx, conversation, messageId);
      return await ctx.db.get(messageId);
    });
    expect(result?.deliveryStatus).toBe("failed");
    expect(result?.metadata?.deliveryError).toBe(READ_ONLY_SEND_MESSAGE);
  });

  test("a porta aceita a org já carregada pelo chamador (sem leitura extra) e respeita legacy", async () => {
    const s = await seed(LEGACY);
    const result = await t.run(async (ctx) => {
      const conversation = (await ctx.db.get(s.conversationId))!;
      const org = (await ctx.db.get(s.organizationId))!;
      const messageId = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, direction: "outbound", senderId: s.adminId,
        senderType: "human", content: "Oi", contentType: "text", isInternal: false, createdAt: Date.now(),
      });
      await scheduleOutboundDispatch(ctx, conversation, messageId, { org });
      return await ctx.db.get(messageId);
    });
    expect(result?.deliveryStatus).not.toBe("failed");
  });
});

describe("o que o modo leitura NÃO bloqueia", () => {
  test("inbound SEMPRE entra", async () => {
    for (const billing of [READ_ONLY, CANCELED, TRIAL_EXPIRED]) {
      const s = await seed(billing);
      const id = await t.mutation(internal.conversations.internalReceiveMessage, {
        organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId, content: "Oi, tudo bem?",
        externalId: `wamid.${String(billing?.status)}`,
      });
      expect(id).not.toBeNull();
      const msg = await t.run((ctx) => ctx.db.get(id!));
      expect(msg).toMatchObject({ direction: "inbound", content: "Oi, tudo bem?" });
    }
  });

  test("exportação segue liberada", async () => {
    const s = await seed(CANCELED);
    const jobId = await admin(s).mutation(api.exports.createExportJob, {
      organizationId: s.organizationId, format: "csv", scope: "entity", entity: "contacts",
    });
    expect(jobId).toBeTruthy();
  });

  test("leitura e organização interna seguem (query de entitlements e nota)", async () => {
    const s = await seed(READ_ONLY);
    const ent = await admin(s).query(api.billing.getMyEntitlements, { organizationId: s.organizationId });
    expect(ent).toMatchObject({ mode: "read_only", readOnly: true });
  });
});

describe("criar canal, API key e webhook em modo leitura", () => {
  test("webhook e API key novos são recusados; legacy segue", async () => {
    const s = await seed(READ_ONLY);
    await expect(
      admin(s).mutation(api.webhooks.createWebhook, { organizationId: s.organizationId, name: "W", url: "https://example.com/h", events: ["*"], secret: "fake-secret-1" })
    ).rejects.toThrow(/modo leitura/);
    await expect(
      t.mutation(internal.apiKeys.insertApiKey, { organizationId: s.organizationId, teamMemberId: s.adminId, name: "K", keyHash: "hash-fake-1", actorId: s.adminId })
    ).rejects.toThrow(/modo leitura/);

    const ok = await seed(LEGACY);
    expect(
      await admin(ok).mutation(api.webhooks.createWebhook, { organizationId: ok.organizationId, name: "W", url: "https://example.com/h", events: ["*"], secret: "fake-secret-2" })
    ).toBeTruthy();
    expect(
      await t.mutation(internal.apiKeys.insertApiKey, { organizationId: ok.organizationId, teamMemberId: ok.adminId, name: "K", keyHash: "hash-fake-2", actorId: ok.adminId })
    ).toBeTruthy();
  });

  test("canal novo (internalInsertConfig) é recusado em modo leitura", async () => {
    const s = await seed(READ_ONLY);
    await expect(
      admin(s).mutation(internal.channelConfigs.internalInsertConfig, {
        organizationId: s.organizationId, channel: "whatsapp", provider: "meta", displayName: "Novo",
        phoneNumberId: "999888777", wabaId: "waba-1", verifyToken: "verify-fake-1",
        appSecretEncrypted: "enc", accessTokenEncrypted: "enc", appSecretLast4: "1234",
      } as never)
    ).rejects.toThrow(/modo leitura/);
  });
});

describe("mensagens agendadas em modo leitura", () => {
  async function scheduled(s: Seed) {
    return await t.run(async (ctx) =>
      ctx.db.insert("scheduledMessages", {
        organizationId: s.organizationId, conversationId: s.conversationId, content: "Lembrete", scheduledAt: Date.now() + 60_000,
        status: "pending", createdBy: s.adminId, createdAt: Date.now(),
      } as never)
    );
  }

  test("deliver em modo leitura NÃO vira failed: fica pending e é reagendada", async () => {
    const s = await seed(READ_ONLY);
    const id = await scheduled(s);
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: id });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("pending");
    expect(row?.scheduledFunctionId).toBeTruthy();
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
  });

  test("criar agendada nova em modo leitura é recusado", async () => {
    const s = await seed(READ_ONLY);
    await expect(
      admin(s).mutation(api.scheduledMessages.schedule, { conversationId: s.conversationId, content: "x", scheduledAt: Date.now() + 3_600_000 })
    ).rejects.toThrow(READ_ONLY_SEND_MESSAGE);
  });

  test("ao sair do modo leitura (ops), as agendadas pendentes são re-armadas; legacy entrega normal", async () => {
    const s = await seed(READ_ONLY);
    const id = await scheduled(s);
    await t.run((ctx) => ctx.db.patch(id, { scheduledFunctionId: "antigo" }));
    await t.mutation(internal.opsBilling.internalSetOrgPlan, { organizationId: s.organizationId, plan: "profissional", status: "active", dryRun: false });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.scheduledFunctionId).not.toBe("antigo");
    expect(row?.status).toBe("pending");
    await setBilling(s.organizationId, ACTIVE);
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: id });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("sent");
  });
});
