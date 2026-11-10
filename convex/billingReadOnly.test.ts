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
import { releaseFollowUpFromQueue } from "./lib/followUpOps";
import { acceptAiDraftCore } from "./attendant";

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

  test("ao sair do modo leitura (ops), só as RETIDAS são re-armadas e perdem o heldSince; a entrega respeita o scheduledAt", async () => {
    const s = await seed(READ_ONLY);
    const id = await scheduled(s); // vence em 60 s
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: id }); // retida
    expect((await t.run((ctx) => ctx.db.get(id)))?.heldSince).toBe(NOW);
    await t.run((ctx) => ctx.db.patch(id, { scheduledFunctionId: "antigo" }));
    await t.mutation(internal.opsBilling.internalSetOrgPlan, { organizationId: s.organizationId, plan: "profissional", status: "active", dryRun: false });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.scheduledFunctionId).not.toBe("antigo");
    expect(row?.heldSince).toBeUndefined();
    expect(row?.status).toBe("pending");
    // Defesa do deliver: executado ANTES do scheduledAt, reagenda em vez de enviar adiantado.
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: id });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("pending");
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
    // Chegada a hora, entrega.
    vi.setSystemTime(NOW + 2 * 60_000);
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: id });
    const sent = await t.run((ctx) => ctx.db.get(id));
    expect(sent?.status).toBe("sent");
    expect(sent?.heldSince).toBeUndefined();
  });

  test("org bloqueada com agendada FUTURA sem retenção: reativar não a adianta", async () => {
    const s = await seed(READ_ONLY);
    const id = await scheduled(s); // nunca passou pelo deliver em modo leitura (sem heldSince)
    await t.run((ctx) => ctx.db.patch(id, { scheduledFunctionId: "original", scheduledAt: NOW + 3 * 3_600_000 }));
    await t.mutation(internal.opsBilling.internalSetOrgPlan, { organizationId: s.organizationId, plan: "profissional", status: "active", dryRun: false });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.scheduledFunctionId).toBe("original"); // não re-armada: a função original continua valendo
    // Mesmo que um job antigo dispare agora, o deliver não envia antes do scheduledAt.
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: id });
    expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe("pending");
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
  });

  test("re-arme: retida e vencida há < 24 h sai; > 24 h expira (no próprio re-arme)", async () => {
    const s = await seed(READ_ONLY);
    const fresh = await t.run((ctx) =>
      ctx.db.insert("scheduledMessages", {
        organizationId: s.organizationId, conversationId: s.conversationId, content: "Recente", scheduledAt: NOW - 3 * 3_600_000,
        status: "pending", createdBy: s.adminId, createdAt: NOW - 4 * 3_600_000, heldSince: NOW - 3 * 3_600_000,
      } as never)
    );
    const stale = await t.run((ctx) =>
      ctx.db.insert("scheduledMessages", {
        organizationId: s.organizationId, conversationId: s.conversationId, content: "Velha", scheduledAt: NOW - 2 * 86_400_000,
        status: "pending", createdBy: s.adminId, createdAt: NOW - 3 * 86_400_000, heldSince: NOW - 2 * 86_400_000,
      } as never)
    );
    await t.mutation(internal.opsBilling.internalSetOrgPlan, { organizationId: s.organizationId, plan: "profissional", status: "active", dryRun: false });
    expect(await t.run((ctx) => ctx.db.get(stale))).toMatchObject({ status: "canceled", error: "Expirou durante o modo leitura" });
    const recent = await t.run((ctx) => ctx.db.get(fresh));
    expect(recent).toMatchObject({ status: "pending" });
    expect(recent?.heldSince).toBeUndefined();
    vi.setSystemTime(NOW + 10_000);
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: fresh });
    expect((await t.run((ctx) => ctx.db.get(fresh)))?.status).toBe("sent");
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(1); // só a recente saiu
  });
});

describe("revisão do B7: canais que não despacham, follow-up, agendadas vencidas, encaminhar e aceitar", () => {
  test("lead REST em org canceled mantém o texto do cliente (webchat não despacha: sem recusa)", async () => {
    const s = await seed(CANCELED);
    const conversationId = await t.mutation(internal.conversations.internalCreateConversation, {
      organizationId: s.organizationId, leadId: s.leadId, channel: "webchat",
    });
    // É o ramo legado de `POST /inbound/lead`: o texto do formulário entra como mensagem não interna.
    const id = await t.mutation(internal.conversations.internalSendMessage, {
      conversationId, content: "Quero um orçamento", isInternal: false, teamMemberId: s.adminId,
    });
    const msg = await t.run((ctx) => ctx.db.get(id));
    expect(msg).toMatchObject({ content: "Quero um orçamento" });
    expect(msg?.deliveryStatus).not.toBe("failed");
    // O mesmo texto num canal que despacha (WhatsApp) segue recusado.
    await expect(
      t.mutation(internal.conversations.internalSendMessage, { conversationId: s.conversationId, content: "Oi", teamMemberId: s.adminId })
    ).rejects.toThrow(READ_ONLY_SEND_MESSAGE);
  });

  test("follow-up em org bloqueada CANCELA (sem needs_human nem tarefa de gente)", async () => {
    const s = await seed(READ_ONLY);
    const result = await t.run(async (ctx) => {
      const now = Date.now();
      const taskId = await ctx.db.insert("tasks", {
        organizationId: s.organizationId, title: "Retomar contato", type: "task", status: "pending", priority: "medium",
        createdBy: s.adminId, createdAt: now, updatedAt: now,
      } as never);
      const followUpId = await ctx.db.insert("aiFollowUps", {
        organizationId: s.organizationId, taskId, conversationId: s.conversationId, leadId: s.leadId, agentMemberId: s.adminId,
        status: "queued", dueAt: now, chainIndex: 0, deferrals: 0, createdAt: now, updatedAt: now,
      } as never);
      const queueItemId = await ctx.db.insert("aiReplyQueue", {
        organizationId: s.organizationId, conversationId: s.conversationId, triggerMessageId: await ctx.db.insert("messages", {
          organizationId: s.organizationId, conversationId: s.conversationId, direction: "inbound", senderType: "contact",
          content: "x", contentType: "text", isInternal: false, createdAt: now,
        }),
        agentMemberId: s.adminId, status: "pending", attempts: 0, nextAttemptAt: now, origin: "follow_up", followUpId, createdAt: now, updatedAt: now,
      } as never);
      const item = (await ctx.db.get(queueItemId))!;
      await releaseFollowUpFromQueue(ctx, item, "plano_inativo");
      return await ctx.db.get(followUpId);
    });
    expect(result?.status).toBe("canceled");
    expect(result?.reasonCode).toBe("plano_inativo");
    expect(result?.status).not.toBe("needs_human");
  });

  async function scheduledRow(s: Seed, fields: Record<string, unknown>) {
    return await t.run((ctx) =>
      ctx.db.insert("scheduledMessages", {
        organizationId: s.organizationId, conversationId: s.conversationId, content: "Lembrete", scheduledAt: Date.now() - 1000,
        status: "pending", createdBy: s.adminId, createdAt: Date.now() - 2000, ...fields,
      } as never)
    );
  }
  const DAY = 86_400_000;

  test("agendada retida e vencida há mais de 24 h NÃO sai ao voltar o plano: expira com motivo e audit", async () => {
    const s = await seed(READ_ONLY);
    const id = await scheduledRow(s, { scheduledAt: NOW - 2 * DAY });
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: id }); // retida
    expect((await t.run((ctx) => ctx.db.get(id)))?.heldSince).toBe(NOW);
    await setBilling(s.organizationId, ACTIVE);
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: id });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ status: "canceled", error: "Expirou durante o modo leitura" });
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.entityType === "scheduledMessage" && a.metadata?.reason === "read_only_expired")).toBe(true);
  });

  test("agendada retida há menos de 24 h de atraso sai normalmente quando o plano volta; a não retida segue o fluxo antigo", async () => {
    const s = await seed(READ_ONLY);
    const held = await scheduledRow(s, { scheduledAt: NOW - 3 * 3_600_000, heldSince: NOW - 3 * 3_600_000 });
    await setBilling(s.organizationId, ACTIVE);
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: held });
    expect((await t.run((ctx) => ctx.db.get(held)))?.status).toBe("sent");
    // Sem `heldSince` (nunca foi retida, ex.: re-arme pós-restore): comportamento de sempre, sem expirar.
    const old = await scheduledRow(s, { scheduledAt: NOW - 5 * DAY });
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: old });
    expect((await t.run((ctx) => ctx.db.get(old)))?.status).toBe("sent");
  });

  test("teto de 30 dias retida em modo leitura: expira e o loop de 6 h para", async () => {
    const s = await seed(READ_ONLY);
    const id = await scheduledRow(s, { scheduledAt: NOW - 40 * DAY, heldSince: NOW - 31 * DAY, scheduledFunctionId: "antigo" });
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: id });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ status: "canceled", error: "Expirou durante o modo leitura" });
    expect(row?.scheduledFunctionId).toBeUndefined();
    // Nada novo foi agendado (o `antigo` era só um valor; o loop não rearmou).
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.filter((j) => j.name.includes("scheduledMessages:deliver"))).toHaveLength(0);
  });

  test("encaminhar e aceitar rascunho da IA são envios: recusados em modo leitura", async () => {
    const s = await seed(CANCELED);
    const messageId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, direction: "inbound", senderType: "contact",
        content: "Comprovante", contentType: "text", isInternal: false, createdAt: Date.now(),
      })
    );
    await expect(
      admin(s).mutation(api.conversations.forwardMessage, { messageId, targetConversationId: s.conversationId })
    ).rejects.toThrow(READ_ONLY_SEND_MESSAGE);

    await expect(
      t.run(async (ctx) => {
        const conversation = (await ctx.db.get(s.conversationId))!;
        const member = (await ctx.db.get(s.adminId))!;
        const draft = (await ctx.db.get(messageId))!;
        return await acceptAiDraftCore(ctx, { draft, conversation, member });
      })
    ).rejects.toThrow(READ_ONLY_SEND_MESSAGE);
  });

  test("provisionar canal checa o plano ANTES de tocar o gateway (query de pré-checagem)", async () => {
    const blocked = await seed(READ_ONLY);
    await expect(
      t.query(internal.channelConfigs.internalAssertPlanWritable, { organizationId: blocked.organizationId, now: NOW })
    ).rejects.toThrow(/modo leitura/);
    const ok = await seed(LEGACY);
    expect(await t.query(internal.channelConfigs.internalAssertPlanWritable, { organizationId: ok.organizationId, now: NOW })).toBeNull();
  });
});
