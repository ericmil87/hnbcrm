/// <reference types="vite/client" />
/**
 * v0.69.1 — e-mail de repasse (broadcast) e de queda de canal.
 * Os testes não registram o componente Resend: o envio real lança dentro do
 * `sendTransactionalEmail` e é engolido ("nunca lança"); o agendamento se
 * verifica em `_scheduled_functions`.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { buildTemplate } from "./emailTemplates";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedOrg(t: TestConvex<typeof schema>, slug: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${slug}`,
      slug,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (name: string, role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", {});
      return await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: "human", status: "active",
        email: `${name.toLowerCase()}-${slug}@acme.com.br`,
        createdAt: now, updatedAt: now,
      });
    };
    const adminId = await mk("Admin", "admin");
    const sellerId = await mk("Vendedor", "agent");
    const optoutId = await mk("Optout", "agent");
    await ctx.db.insert("notificationPreferences", {
      organizationId, teamMemberId: optoutId,
      invite: true, handoffRequested: false, handoffResolved: true,
      taskOverdue: true, taskAssigned: true, leadAssigned: true,
      newMessage: true, dailyDigest: true, channelSessionLost: false,
      createdAt: now, updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Ana (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" },
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge", displayName: "WhatsApp Loja",
      bridgeBaseUrl: "https://wa-gw.example.test", bridgeInstanceId: `inst_${slug}`,
      bridgeTokenEncrypted: "cifrado", bridgeTokenLast4: "aaaa", bridgePhone: "5511944998753",
      bridgeSessionState: "connected", bridgeConnectedAt: now, status: "active",
      createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", phone: "5511988887777", tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "WhatsApp 5511988887777", contactId, boardId, stageId,
      assignedTo: agentId, value: 0, currency: "BRL", priority: "medium", temperature: "warm",
      tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now,
      createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active",
      lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
    });
    return { organizationId, adminId, sellerId, optoutId, agentId, configId, leadId, conversationId };
  });
}

async function cancelPendingJobs(t: TestConvex<typeof schema>) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

type Job = { eventType: string; recipientMemberId: string; templateData: Record<string, any> };
async function emailJobs(t: TestConvex<typeof schema>, eventType: string): Promise<Job[]> {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs
      .filter((j) => j.name.includes("dispatchNotification"))
      .map((j) => j.args[0] as Job)
      .filter((a) => a.eventType === eventType);
  });
}

/**
 * Sem o componente Resend, `sendTransactionalEmail` falha ao enfileirar e LOGA
 * (console.error "falha ao enfileirar"): quem chega ao envio loga; quem é
 * barrado antes (opt-out) não loga.
 */
async function dispatchReachesSend(
  t: TestConvex<typeof schema>,
  args: { organizationId: any; recipientMemberId: any; eventType: string; templateData: any },
): Promise<boolean> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await t.mutation(internal.email.dispatchNotification, args);
    return spy.mock.calls.some((c) => String(c[0]).includes("falha ao enfileirar"));
  } finally {
    spy.mockRestore();
  }
}

describe("repasse", () => {
  test("broadcast agenda e-mail para quem pode responder (mesma lista do sino); opt-out não envia no dispatch", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "a");
    const { busyId, removedId } = await t.run(async (ctx) => {
      const now = Date.now();
      const mk = async (extra: object) =>
        ctx.db.insert("teamMembers", {
          organizationId: s.organizationId, userId: await ctx.db.insert("users", {}),
          name: "X", role: "agent", type: "human", status: "active",
          createdAt: now, updatedAt: now, ...extra,
        });
      return { busyId: await mk({ status: "busy" }), removedId: await mk({ removedAt: now }) };
    });
    await t.mutation(internal.handoffs.internalRequestHandoff, {
      leadId: s.leadId, conversationId: s.conversationId, reason: "Cliente pediu humano",
      suggestedActions: [], teamMemberId: s.agentId, origin: "ai_tool",
    });
    const jobs = await emailJobs(t, "handoffRequested");
    const ids = jobs.map((j) => j.recipientMemberId);
    expect(ids).toContain(s.adminId);
    expect(ids).toContain(s.sellerId);
    expect(ids).not.toContain(s.agentId);
    expect(ids).toContain(busyId);
    expect(ids).not.toContain(removedId);
    const bell = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(bell.map((n) => n.memberId)).toContain(busyId);
    expect(bell.map((n) => n.memberId)).not.toContain(removedId);
    expect(jobs[0].templateData.leadUrl).toMatch(/\/app\/repasses\?handoff=/);
    const base = { organizationId: s.organizationId, eventType: "handoffRequested", templateData: jobs[0].templateData };
    expect(await dispatchReachesSend(t, { ...base, recipientMemberId: s.sellerId })).toBe(true);
    expect(await dispatchReachesSend(t, { ...base, recipientMemberId: s.optoutId })).toBe(false);
    await cancelPendingJobs(t);
  });

  test("com destinatário definido: 1 e-mail só para ele", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "b");
    await t.mutation(internal.handoffs.internalRequestHandoff, {
      leadId: s.leadId, conversationId: s.conversationId, reason: "x",
      suggestedActions: [], teamMemberId: s.agentId, toMemberId: s.sellerId, origin: "ai_tool",
    });
    const jobs = await emailJobs(t, "handoffRequested");
    expect(jobs.map((j) => j.recipientMemberId)).toEqual([s.sellerId]);
    await cancelPendingJobs(t);
  });

  test("duplicata com onDuplicate skip não agenda e-mail de novo", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "c");
    const args = {
      leadId: s.leadId, conversationId: s.conversationId, reason: "x",
      suggestedActions: [], teamMemberId: s.agentId, origin: "ai_tool" as const,
    };
    await t.mutation(internal.handoffs.internalRequestHandoff, args);
    const n1 = (await emailJobs(t, "handoffRequested")).length;
    await t.mutation(internal.handoffs.internalRequestHandoff, args).catch(() => {});
    expect((await emailJobs(t, "handoffRequested")).length).toBe(n1);
    await cancelPendingJobs(t);
  });

  test("throttle por org no broadcast: 2º em 1 min sem e-mail (sino segue); 16 min depois volta, com contagem", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "g");
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const mkLead = async (n: number) =>
      t.run(async (ctx) => {
        const lead = (await ctx.db.get(s.leadId))!;
        const { _id, _creationTime, ...rest } = lead;
        const leadId = await ctx.db.insert("leads", { ...rest, title: `Lead ${n}` });
        const conversationId = await ctx.db.insert("conversations", {
          organizationId: s.organizationId, leadId, channel: "whatsapp", channelConfigId: s.configId,
          status: "active", lastInboundAt: Date.now(), messageCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
        });
        return { leadId, conversationId };
      });
    const req = async (n: number) => {
      const l = await mkLead(n);
      await t.mutation(internal.handoffs.internalRequestHandoff, {
        ...l, reason: "x", suggestedActions: [], teamMemberId: s.agentId, origin: "ai_failure",
      });
    };
    await req(1);
    const n1 = (await emailJobs(t, "handoffRequested")).length;
    expect(n1).toBeGreaterThan(0);
    vi.setSystemTime(new Date("2026-10-03T12:01:00Z"));
    await req(2);
    expect((await emailJobs(t, "handoffRequested")).length).toBe(n1);
    const bell = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(bell.filter((n) => n.title.includes("Lead 2")).length).toBeGreaterThan(0);
    vi.setSystemTime(new Date("2026-10-03T12:17:00Z"));
    await req(3);
    const jobs = await emailJobs(t, "handoffRequested");
    expect(jobs.length).toBe(n1 * 2);
    expect(jobs[jobs.length - 1].templateData.pendingLabel).toBe("3");
    expect(buildTemplate("handoffRequested", { ...jobs[jobs.length - 1].templateData }).subject).toBe(
      "Novo repasse — 3 pendentes",
    );
    await cancelPendingJobs(t);
  });

  test("template: motivo livre só quando o membro de origem é humano", () => {
    const base = { leadTitle: "Lead", origin: "ai_tool", reason: "preciso de ajuda", fromMemberName: "X", leadUrl: "https://hnbcrm.com/app/repasses?handoff=a" };
    expect(buildTemplate("handoffRequested", { ...base, fromIsHuman: true }).html).toContain("preciso de ajuda");
    expect(buildTemplate("handoffRequested", { ...base, fromIsHuman: false }).html).not.toContain("preciso de ajuda");
  });

  test("template: sem texto da IA, telefone mascarado, origem legível", () => {
    const tpl = buildTemplate("handoffRequested", {
      orgName: "Org", leadTitle: "WhatsApp 5511988887777", origin: "bot_suspect",
      reason: "o cliente disse: meu cpf é 123", fromMemberName: "Ana (IA)",
      leadUrl: "https://hnbcrm.com/app/repasses?handoff=abc",
    });
    expect(tpl.html).not.toContain("5511988887777");
    expect(tpl.subject).not.toContain("5511988887777");
    expect(tpl.html).not.toContain("meu cpf");
    expect(tpl.html).toContain("Suspeita de robô");
    expect(tpl.html).toContain("/app/repasses?handoff=abc");
  });
});

describe("queda de canal", () => {
  test("agenda e-mail para admin da org, não para admin de outra org nem para agente", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "d");
    const b = await seedOrg(t, "e");
    const r = await t.mutation(internal.channelHealth.internalRecordSessionEvent, {
      configId: a.configId, event: "LoggedOut", code: 401,
    });
    expect(r.emitted).toBe(true);
    const jobs = await emailJobs(t, "channelSessionLost");
    const ids = jobs.map((j) => j.recipientMemberId);
    expect(ids).toContain(a.adminId);
    expect(ids).not.toContain(b.adminId);
    expect(ids).not.toContain(a.sellerId);
    const json = JSON.stringify(jobs);
    expect(json).not.toContain("5511944998753");
    expect(json).not.toContain("inst_d");
    expect(json).not.toContain("wa-gw.example.test");
    await t.mutation(internal.channelHealth.internalRecordSessionEvent, {
      configId: a.configId, event: "LoggedOut",
    });
    expect((await emailJobs(t, "channelSessionLost")).length).toBe(jobs.length);
    await cancelPendingJobs(t);
  });

  test("opt-out channelSessionLost:false → dispatch não envia", async () => {
    const t = convexTest(schema, modules);
    const s = await seedOrg(t, "f");
    const base = {
      organizationId: s.organizationId, eventType: "channelSessionLost",
      templateData: { orgName: "O", channelName: "C", state: "logged_out" },
    };
    expect(await dispatchReachesSend(t, { ...base, recipientMemberId: s.sellerId })).toBe(true);
    expect(await dispatchReachesSend(t, { ...base, recipientMemberId: s.optoutId })).toBe(false);
    await cancelPendingJobs(t);
  });

  test("template sem token/instância, com estado, pausas e link", () => {
    const tpl = buildTemplate("channelSessionLost", {
      orgName: "Org", channelName: "WhatsApp Loja", phoneDisplay: "••••8753",
      state: "temporarily_banned", expiresAt: Date.UTC(2026, 9, 4, 12), pausedCampaigns: 1, pausedGroupPosts: 2,
    });
    expect(tpl.subject).toContain("perdeu a conexão");
    expect(tpl.html).toContain("Banimento temporário");
    expect(tpl.html).toContain("1 campanha(s) e 2 publicação(ões)");
    expect(tpl.html).toContain("/app/configuracoes?secao=channels");
    expect(tpl.html).toContain("••••8753");
  });
});
