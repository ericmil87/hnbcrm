/// <reference types="vite/client" />
/**
 * C1 — preferências por canal, pausa, silêncio e padrões da org (integração).
 * A matriz pura de `shouldDeliver` está em `lib/notificationPolicy.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { createNotification } from "./lib/notify";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// 2026-11-04 15:00 UTC: 12:00 em São Paulo, 08:00 em Denver (MST, UTC-7), 00:00 em Tóquio (dia 05).
const NOW = Date.UTC(2026, 10, 4, 15, 0, 0);
const HOUR = 3_600_000;

let t: TestConvex<typeof schema>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(async () => {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
  vi.useRealTimers();
});

async function seedOrg(slug: string, extra: { timezone?: string; telegram?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${slug}`,
      slug,
      settings: { timezone: extra.timezone ?? "America/Sao_Paulo", currency: "BRL", modules: { telegram: extra.telegram ?? true } },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const mk = async (name: string, role: "admin" | "agent", userId?: Id<"users">) => {
      const uid = userId ?? (await ctx.db.insert("users", {}));
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId: uid, name, email: `${name.toLowerCase()}@${slug}.com.br`, role, type: "human",
        status: "active", createdAt: NOW, updatedAt: NOW,
      });
      return { userId: uid, memberId };
    };
    return { organizationId, admin: await mk("Admin", "admin"), agent: await mk("Agente", "agent") };
  });
}
type Org = Awaited<ReturnType<typeof seedOrg>>;

const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function linkTelegram(org: Org, member: Org["admin"], extra: Record<string, unknown> = {}) {
  return await t.run((ctx) =>
    ctx.db.insert("telegramLinks", {
      organizationId: org.organizationId, teamMemberId: member.memberId, userId: member.userId,
      chatId: 7000, telegramUserId: 7000, status: "active",
      prefs: { relayAssignedConversations: true, mediaInbound: true },
      assistant: {
        mode: "suggest", suggestOnEvents: true, autoSendDelaySeconds: 15,
        autoAllowed: { instructAi: true, createTask: true, moveStage: true, acceptHandoff: true, replyCustomer: false },
      },
      reports: { enabled: true, morningHour: 8, eveningHour: 18 },
      linkedAt: NOW, lastSeenAt: NOW, ...extra,
    })
  );
}

async function notify(org: Org, member: Org["admin"], type: "task_assigned" | "handoff_requested" | "campaign_completed") {
  await t.run((ctx) =>
    createNotification(ctx, { organizationId: org.organizationId, memberId: member.memberId, type, title: "Aviso" })
  );
}
const bell = (memberId: Id<"teamMembers">) =>
  t.run((ctx) => ctx.db.query("notifications").withIndex("by_member_and_created", (q) => q.eq("memberId", memberId)).collect());
const telegramJobs = () =>
  t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.includes("internalDeliverNotification")));
const prefsOf = (org: Org, member: Org["admin"]) =>
  t.run((ctx) =>
    ctx.db.query("notificationPreferences")
      .withIndex("by_organization_and_member", (q) => q.eq("organizationId", org.organizationId).eq("teamMemberId", member.memberId))
      .first()
  );
async function dispatchReachesSend(org: Org, member: Org["admin"], eventType: string) {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await t.mutation(internal.email.dispatchNotification, {
      organizationId: org.organizationId, recipientMemberId: member.memberId, eventType,
      templateData: {
        taskTitle: "T", dueDate: "01/01", taskUrl: "https://x.com.br/app/tarefas?task=1",
        leadTitle: "Lead", fromMemberName: "IA", leadUrl: "https://x.com.br/app/leads?lead=1",
      },
    });
    return spy.mock.calls.some((c) => String(c[0]).includes("falha ao enfileirar"));
  } finally {
    spy.mockRestore();
  }
}

describe("compatibilidade com documentos antigos", () => {
  test("linha sem campos novos: leitura efetiva usa os padrões e as funções antigas seguem", async () => {
    const org = await seedOrg("compat");
    await t.run(async (ctx) => {
      await ctx.db.insert("notificationPreferences", {
        organizationId: org.organizationId, teamMemberId: org.admin.memberId, invite: true, handoffRequested: true,
        handoffResolved: true, taskOverdue: true, taskAssigned: false, leadAssigned: true, newMessage: true,
        dailyDigest: true, createdAt: NOW, updatedAt: NOW,
      });
    });
    const me = as(org.admin.userId);
    const eff = await me.query(api.notificationPreferences.getMyEffectivePreferences, { organizationId: org.organizationId });
    expect(eff).toMatchObject({ preset: "all", presetSource: "default", pausedUntil: null, urgentBypass: true, showPreview: true, effectiveShowPreview: true });
    expect(eff.quietHours).toMatchObject({ enabled: false, start: "21:00", end: "08:00", timeZone: "America/Sao_Paulo" });
    expect(eff.flags.taskAssigned).toBe(false);
    expect(eff.channels.email.taskAssigned).toBe(false);
    expect(eff.channels.email.taskOverdue).toBe(true);
    expect(eff.channels.push.campaignCompleted).toBe(true);
    expect(eff.actionableFlags).toContain("handoffRequested");
    // API antiga intacta
    const old = await me.query(api.notificationPreferences.getMyPreferences, { organizationId: org.organizationId });
    expect(old.taskAssigned).toBe(false);
    await me.mutation(api.notificationPreferences.updateMyPreferences, { organizationId: org.organizationId, taskAssigned: true });
    const after = await prefsOf(org, org.admin);
    expect(after?.taskAssigned).toBe(true);
    expect(after?.preset).toBeUndefined();
  });

  test("sem linha e sem padrão da org: e-mail e Telegram entregam como antes", async () => {
    const org = await seedOrg("sem-linha");
    await linkTelegram(org, org.admin);
    await notify(org, org.admin, "task_assigned");
    expect(await bell(org.admin.memberId)).toHaveLength(1);
    expect(await telegramJobs()).toHaveLength(1);
    expect(await dispatchReachesSend(org, org.admin, "taskAssigned")).toBe(true);
  });
});

describe("mutations do membro", () => {
  test("setPreset grava e zera personalizações; none deixa só o sino", async () => {
    const org = await seedOrg("preset");
    await linkTelegram(org, org.admin);
    const me = as(org.admin.userId);
    await me.mutation(api.notificationPreferences.setChannelPref, { organizationId: org.organizationId, channel: "email", flag: "taskAssigned", enabled: false });
    expect((await prefsOf(org, org.admin))?.channels?.email?.taskAssigned).toBe(false);
    await me.mutation(api.notificationPreferences.setPreset, { organizationId: org.organizationId, preset: "none" });
    const row = await prefsOf(org, org.admin);
    expect(row?.preset).toBe("none");
    expect(row?.channels).toBeUndefined();
    await notify(org, org.admin, "task_assigned");
    expect(await bell(org.admin.memberId)).toHaveLength(1);
    expect(await telegramJobs()).toHaveLength(0);
    expect(await dispatchReachesSend(org, org.admin, "taskAssigned")).toBe(false);
  });

  test("setChannelPref rejeita flag desconhecido e só mexe no canal pedido", async () => {
    const org = await seedOrg("canal");
    const me = as(org.admin.userId);
    await expect(
      me.mutation(api.notificationPreferences.setChannelPref, { organizationId: org.organizationId, channel: "push", flag: "naoExiste", enabled: false })
    ).rejects.toThrow();
    await me.mutation(api.notificationPreferences.setChannelPref, { organizationId: org.organizationId, channel: "telegram", flag: "taskAssigned", enabled: false });
    await linkTelegram(org, org.admin);
    await notify(org, org.admin, "task_assigned");
    expect(await telegramJobs()).toHaveLength(0);
    expect(await dispatchReachesSend(org, org.admin, "taskAssigned")).toBe(true); // e-mail segue
  });

  test("pauseFor: o sino registra, Telegram e e-mail seguram; expira; resume limpa", async () => {
    const org = await seedOrg("pausa");
    await linkTelegram(org, org.admin);
    const me = as(org.admin.userId);
    const { pausedUntil } = await me.mutation(api.notificationPreferences.pauseFor, { organizationId: org.organizationId, mode: "1h" });
    expect(pausedUntil).toBe(NOW + HOUR);
    await notify(org, org.admin, "task_assigned");
    expect(await bell(org.admin.memberId)).toHaveLength(1);
    expect(await telegramJobs()).toHaveLength(0);
    expect(await dispatchReachesSend(org, org.admin, "taskAssigned")).toBe(false);
    // expira
    vi.setSystemTime(NOW + HOUR + 1);
    await notify(org, org.admin, "task_assigned");
    expect(await telegramJobs()).toHaveLength(1);
    expect(await dispatchReachesSend(org, org.admin, "taskAssigned")).toBe(true);
    // resume
    vi.setSystemTime(NOW);
    await me.mutation(api.notificationPreferences.pauseFor, { organizationId: org.organizationId, mode: "4h" });
    await me.mutation(api.notificationPreferences.resume, { organizationId: org.organizationId });
    expect((await prefsOf(org, org.admin))?.pausedUntil).toBeUndefined();
  });

  test("pauseFor: amanhã 8h no fuso da org e limites do personalizado", async () => {
    const org = await seedOrg("pausa-amanha");
    const me = as(org.admin.userId);
    const r = await me.mutation(api.notificationPreferences.pauseFor, { organizationId: org.organizationId, mode: "tomorrow" });
    expect(r.pausedUntil).toBe(Date.UTC(2026, 10, 5, 11, 0)); // 08:00 BRT
    await expect(me.mutation(api.notificationPreferences.pauseFor, { organizationId: org.organizationId, mode: "custom", until: NOW - 1 })).rejects.toThrow();
    await expect(me.mutation(api.notificationPreferences.pauseFor, { organizationId: org.organizationId, mode: "custom", until: NOW + 40 * 24 * HOUR })).rejects.toThrow();
    await expect(me.mutation(api.notificationPreferences.pauseFor, { organizationId: org.organizationId, mode: "custom" })).rejects.toThrow();
    const ok = await me.mutation(api.notificationPreferences.pauseFor, { organizationId: org.organizationId, mode: "custom", until: NOW + 2 * HOUR });
    expect(ok.pausedUntil).toBe(NOW + 2 * HOUR);
  });

  test("pedido de ajuda fura a pausa; com urgentBypass desligado, não", async () => {
    const org = await seedOrg("urgente");
    await linkTelegram(org, org.admin);
    const me = as(org.admin.userId);
    await me.mutation(api.notificationPreferences.pauseFor, { organizationId: org.organizationId, mode: "1h" });
    await notify(org, org.admin, "handoff_requested");
    expect(await telegramJobs()).toHaveLength(1);
    expect(await dispatchReachesSend(org, org.admin, "handoffRequested")).toBe(true);
    await me.mutation(api.notificationPreferences.setUrgentBypass, { organizationId: org.organizationId, urgentBypass: false });
    await notify(org, org.admin, "handoff_requested");
    expect(await telegramJobs()).toHaveLength(1); // nenhum novo
    expect(await dispatchReachesSend(org, org.admin, "handoffRequested")).toBe(false);
    expect(await bell(org.admin.memberId)).toHaveLength(2);
  });

  test("silêncio: atravessa a meia-noite no fuso do membro e valida entradas", async () => {
    const org = await seedOrg("silencio");
    await linkTelegram(org, org.admin);
    const me = as(org.admin.userId);
    await expect(me.mutation(api.notificationPreferences.setQuietHours, { organizationId: org.organizationId, enabled: true, start: "9pm" })).rejects.toThrow();
    await expect(me.mutation(api.notificationPreferences.setQuietHours, { organizationId: org.organizationId, enabled: true, timeZone: "Marte/Olimpo" })).rejects.toThrow();
    // 12:00 BRT, janela 21h–08h em São Paulo: fora → entrega
    await me.mutation(api.notificationPreferences.setQuietHours, { organizationId: org.organizationId, enabled: true });
    expect((await prefsOf(org, org.admin))?.quietHours).toEqual({ enabled: true, start: "21:00", end: "08:00", timeZone: "America/Sao_Paulo" });
    await notify(org, org.admin, "task_assigned");
    expect(await telegramJobs()).toHaveLength(1);
    // 23:30 BRT (02:30Z do dia 5): dentro → segura
    vi.setSystemTime(Date.UTC(2026, 10, 5, 2, 30));
    await notify(org, org.admin, "task_assigned");
    expect(await telegramJobs()).toHaveLength(1);
    expect(await dispatchReachesSend(org, org.admin, "taskAssigned")).toBe(false);
    // mesmo instante, fuso de Tóquio (11:30): fora → entrega
    await me.mutation(api.notificationPreferences.setQuietHours, { organizationId: org.organizationId, enabled: true, timeZone: "Asia/Tokyo" });
    await notify(org, org.admin, "task_assigned");
    expect(await telegramJobs()).toHaveLength(2);
    expect(await dispatchReachesSend(org, org.admin, "taskAssigned")).toBe(true);
  });

  test("prévia: membro e política da org", async () => {
    const org = await seedOrg("previa");
    const me = as(org.admin.userId);
    await me.mutation(api.notificationPreferences.setShowPreview, { organizationId: org.organizationId, showPreview: false });
    let eff = await me.query(api.notificationPreferences.getMyEffectivePreferences, { organizationId: org.organizationId });
    expect(eff.showPreview).toBe(false);
    await me.mutation(api.notificationPreferences.setShowPreview, { organizationId: org.organizationId, showPreview: true });
    await me.mutation(api.organizations.setNotificationDefaults, { organizationId: org.organizationId, preset: "all", hidePreviewOnLockScreen: true });
    eff = await me.query(api.notificationPreferences.getMyEffectivePreferences, { organizationId: org.organizationId });
    expect(eff).toMatchObject({ showPreview: true, orgHidePreview: true, effectiveShowPreview: false });
  });

  test("/pausar legado: mutedUntil do vínculo ainda segura e aparece como pausa; resume limpa", async () => {
    const org = await seedOrg("legado");
    const linkId = await linkTelegram(org, org.admin, { mutedUntil: NOW + HOUR });
    await notify(org, org.admin, "task_assigned");
    expect(await telegramJobs()).toHaveLength(0);
    expect(await bell(org.admin.memberId)).toHaveLength(1);
    const me = as(org.admin.userId);
    const eff = await me.query(api.notificationPreferences.getMyEffectivePreferences, { organizationId: org.organizationId });
    expect(eff.pausedUntil).toBe(NOW + HOUR);
    await me.mutation(api.notificationPreferences.resume, { organizationId: org.organizationId });
    expect((await t.run((ctx) => ctx.db.get(linkId)))?.mutedUntil).toBeUndefined();
    await notify(org, org.admin, "task_assigned");
    expect(await telegramJobs()).toHaveLength(1);
  });
});

describe("padrões da org", () => {
  test("RBAC: só quem tem settings:manage altera; auditoria registrada", async () => {
    const org = await seedOrg("rbac");
    await expect(
      as(org.agent.userId).mutation(api.organizations.setNotificationDefaults, { organizationId: org.organizationId, preset: "none" })
    ).rejects.toThrow();
    expect((await t.run((ctx) => ctx.db.get(org.organizationId)))?.settings.notificationDefaults).toBeUndefined();
    await as(org.admin.userId).mutation(api.organizations.setNotificationDefaults, { organizationId: org.organizationId, preset: "mine" });
    expect((await t.run((ctx) => ctx.db.get(org.organizationId)))?.settings.notificationDefaults).toEqual({ preset: "mine", hidePreviewOnLockScreen: false });
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").withIndex("by_organization_and_created", (q) => q.eq("organizationId", org.organizationId)).collect());
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entityType: "organization", action: "update", actorId: org.admin.memberId });
    expect(JSON.stringify(logs[0].changes)).toContain("mine");
    // outras configurações da org continuam
    expect((await t.run((ctx) => ctx.db.get(org.organizationId)))?.settings.modules).toEqual({ telegram: true });
  });

  test("membro novo (sem linha) herda o preset da org; o do próprio membro vence", async () => {
    const org = await seedOrg("padrao");
    await linkTelegram(org, org.agent);
    await as(org.admin.userId).mutation(api.organizations.setNotificationDefaults, { organizationId: org.organizationId, preset: "none" });
    const novo = as(org.agent.userId);
    const eff = await novo.query(api.notificationPreferences.getMyEffectivePreferences, { organizationId: org.organizationId });
    expect(eff).toMatchObject({ preset: "none", presetSource: "org" });
    expect(eff.channels.telegram.taskAssigned).toBe(false);
    expect(eff.channels.bell.taskAssigned).toBe(true);
    await notify(org, org.agent, "task_assigned");
    expect(await bell(org.agent.memberId)).toHaveLength(1);
    expect(await telegramJobs()).toHaveLength(0);
    expect(await dispatchReachesSend(org, org.agent, "taskAssigned")).toBe(false);
    await novo.mutation(api.notificationPreferences.setPreset, { organizationId: org.organizationId, preset: "all" });
    await notify(org, org.agent, "task_assigned");
    expect(await telegramJobs()).toHaveLength(1);
  });

  test("preset 'mine' da org segura campanha e deixa tarefa", async () => {
    const org = await seedOrg("mine");
    await linkTelegram(org, org.agent);
    await as(org.admin.userId).mutation(api.organizations.setNotificationDefaults, { organizationId: org.organizationId, preset: "mine" });
    await notify(org, org.agent, "campaign_completed");
    expect(await telegramJobs()).toHaveLength(0);
    await notify(org, org.agent, "task_assigned");
    expect(await telegramJobs()).toHaveLength(1);
  });
});

describe("applyToAllMyOrgs", () => {
  test("copia as preferências para as outras orgs do usuário, sem pausa e sem tocar em outros", async () => {
    const a = await seedOrg("multi-a");
    const b = await seedOrg("multi-b");
    const c = await seedOrg("multi-c");
    // mesma pessoa em A e B; C é de outro usuário
    const second = await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        organizationId: b.organizationId, userId: a.admin.userId, name: "Admin B", email: "adminb@multi-b.com.br",
        role: "agent", type: "human", status: "active", createdAt: NOW, updatedAt: NOW,
      })
    );
    const me = as(a.admin.userId);
    await me.mutation(api.notificationPreferences.setPreset, { organizationId: a.organizationId, preset: "mine" });
    await me.mutation(api.notificationPreferences.setChannelPref, { organizationId: a.organizationId, channel: "email", flag: "campaignCompleted", enabled: true });
    await me.mutation(api.notificationPreferences.setQuietHours, { organizationId: a.organizationId, enabled: true });
    await me.mutation(api.notificationPreferences.setShowPreview, { organizationId: a.organizationId, showPreview: false });
    await me.mutation(api.notificationPreferences.pauseFor, { organizationId: a.organizationId, mode: "1h" });

    const res = await me.mutation(api.notificationPreferences.applyToAllMyOrgs, { sourceOrganizationId: a.organizationId });
    expect(res).toEqual({ applied: 1, skipped: 0 });
    const rowB = await t.run((ctx) =>
      ctx.db.query("notificationPreferences").withIndex("by_organization_and_member", (q) => q.eq("organizationId", b.organizationId).eq("teamMemberId", second)).first()
    );
    expect(rowB).toMatchObject({ preset: "mine", showPreview: false, quietHours: { enabled: true, start: "21:00", end: "08:00" } });
    expect(rowB?.channels?.email?.campaignCompleted).toBe(true);
    expect(rowB?.pausedUntil).toBeUndefined();
    expect(await prefsOf(c, c.admin)).toBeNull();
    // quem não é membro da origem é recusado
    await expect(
      as(c.admin.userId).mutation(api.notificationPreferences.applyToAllMyOrgs, { sourceOrganizationId: a.organizationId })
    ).rejects.toThrow();
  });

  test("membro removido de uma org não recebe a cópia", async () => {
    const a = await seedOrg("rem-a");
    const b = await seedOrg("rem-b");
    const second = await t.run((ctx) =>
      ctx.db.insert("teamMembers", {
        organizationId: b.organizationId, userId: a.admin.userId, name: "Admin B", role: "agent", type: "human",
        status: "active", removedAt: NOW - 1, createdAt: NOW, updatedAt: NOW,
      })
    );
    const res = await as(a.admin.userId).mutation(api.notificationPreferences.applyToAllMyOrgs, { sourceOrganizationId: a.organizationId });
    expect(res).toEqual({ applied: 0, skipped: 0 });
    expect(await t.run((ctx) => ctx.db.query("notificationPreferences").withIndex("by_organization_and_member", (q) => q.eq("organizationId", b.organizationId).eq("teamMemberId", second)).first())).toBeNull();
  });
});

describe("resumo diário no horário local da org", () => {
  const digestJobs = () =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.includes("dispatchNotification") && (j.args[0] as any).eventType === "dailyDigest")
    );
  async function runDigest(now?: number) {
    await t.mutation(internal.email.sendDailyDigest, now === undefined ? {} : { now });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  async function withLead(organizationId: Id<"organizations">) {
    // dia com algo para contar (senão o resumo é pulado)
    await t.run(async (ctx) => {
      const author = (await ctx.db.query("teamMembers").withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "human")).first())!;
      return await ctx.db.insert("tasks", {
        organizationId, createdBy: author._id, title: "Feita", type: "task", status: "completed", priority: "low",
        completedAt: NOW - HOUR, createdAt: NOW - 2 * HOUR, updatedAt: NOW,
      });
    });
  }

  test("só a org cuja hora local é 08h recebe; segunda rodada na mesma hora não duplica", async () => {
    const la = await seedOrg("dg-la", { timezone: "America/Denver" }); // 08:00
    const sp = await seedOrg("dg-sp", { timezone: "America/Sao_Paulo" }); // 12:00
    const tk = await seedOrg("dg-tk", { timezone: "Asia/Tokyo" }); // 00:00
    for (const o of [la, sp, tk]) await withLead(o.organizationId);
    await runDigest();
    const jobs = await digestJobs();
    const orgs = new Set(jobs.map((j) => (j.args[0] as any).organizationId));
    expect(orgs).toEqual(new Set([la.organizationId]));
    expect(jobs).toHaveLength(2); // admin + agente
    expect((await t.run((ctx) => ctx.db.get(la.organizationId)))?.lastDailyDigestDate).toBe("2026-11-04");
    await runDigest();
    expect(await digestJobs()).toHaveLength(2);
  });

  test("no dia seguinte, na hora local, sai de novo; org sem fuso usa São Paulo", async () => {
    const sp = await seedOrg("dg-sp2", { timezone: "America/Sao_Paulo" });
    await withLead(sp.organizationId);
    // 11:00Z = 08:00 BRT
    await runDigest(Date.UTC(2026, 10, 4, 11, 0));
    expect(await digestJobs()).toHaveLength(2);
    await runDigest(Date.UTC(2026, 10, 4, 11, 30));
    expect(await digestJobs()).toHaveLength(2);
    await runDigest(Date.UTC(2026, 10, 5, 11, 0));
    expect(await digestJobs()).toHaveLength(4);
  });
});

describe("resumo diário: janela, falha e pré-filtro", () => {
  const digestJobs = () =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.includes("dispatchNotification") && (j.args[0] as any).eventType === "dailyDigest")
    );
  async function withTask(organizationId: Id<"organizations">) {
    await t.run(async (ctx) => {
      const author = (await ctx.db.query("teamMembers").withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "human")).first())!;
      await ctx.db.insert("tasks", {
        organizationId, createdBy: author._id, title: "Feita", type: "task", status: "completed", priority: "low",
        completedAt: NOW - HOUR, createdAt: NOW - 2 * HOUR, updatedAt: NOW,
      });
    });
  }
  const run = async (now: number) => {
    await t.mutation(internal.email.sendDailyDigest, { now });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  };

  test("janela 08h-12h locais: recupera rodada perdida às 9h, não envia às 7h nem às 12h; carimbo evita repetir", async () => {
    const org = await seedOrg("dg-janela", { timezone: "America/Sao_Paulo" });
    await withTask(org.organizationId);
    await run(Date.UTC(2026, 10, 4, 10, 0)); // 07:00 BRT
    expect(await digestJobs()).toHaveLength(0);
    await run(Date.UTC(2026, 10, 4, 15, 0)); // 12:00 BRT
    expect(await digestJobs()).toHaveLength(0);
    await run(Date.UTC(2026, 10, 4, 12, 0)); // 09:00 BRT (a das 08h "falhou")
    expect(await digestJobs()).toHaveLength(2);
    await run(Date.UTC(2026, 10, 4, 13, 0)); // 10:00 BRT: já carimbado
    expect(await digestJobs()).toHaveLength(2);
  });

  test("a página só seleciona: agenda 1 job interno por org, e o carimbo só nasce no job", async () => {
    const org = await seedOrg("dg-pagina", { timezone: "America/Sao_Paulo" });
    await withTask(org.organizationId);
    await t.mutation(internal.email.sendDailyDigest, { now: Date.UTC(2026, 10, 4, 11, 0) });
    const names = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name));
    expect(names.filter((n) => n.includes("internalSendOrgDigest"))).toHaveLength(1);
    expect(names.filter((n) => n.includes("dispatchNotification"))).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(org.organizationId)))?.lastDailyDigestDate).toBeUndefined();
  });

  test("pré-filtro: preset none e canal explícito desligado não agendam; pausa idem; silêncio não segura o digest", async () => {
    const org = await seedOrg("dg-prefiltro", { timezone: "America/Sao_Paulo" });
    await withTask(org.organizationId);
    await as(org.agent.userId).mutation(api.notificationPreferences.setPreset, { organizationId: org.organizationId, preset: "none" });
    await as(org.admin.userId).mutation(api.notificationPreferences.setChannelPref, { organizationId: org.organizationId, channel: "email", flag: "dailyDigest", enabled: false });
    await run(Date.UTC(2026, 10, 4, 11, 0));
    expect(await digestJobs()).toHaveLength(0);

    const org2 = await seedOrg("dg-prefiltro2", { timezone: "America/Sao_Paulo" });
    await withTask(org2.organizationId);
    vi.setSystemTime(Date.UTC(2026, 10, 4, 11, 0));
    await as(org2.admin.userId).mutation(api.notificationPreferences.pauseFor, { organizationId: org2.organizationId, mode: "1h" });
    await as(org2.agent.userId).mutation(api.notificationPreferences.setQuietHours, { organizationId: org2.organizationId, enabled: true, start: "21:00", end: "09:00" });
    await run(Date.UTC(2026, 10, 4, 11, 0));
    const jobs = await digestJobs();
    expect(jobs.map((j) => (j.args[0] as any).recipientMemberId)).toEqual([org2.agent.memberId]);
  });
});

describe("revisão do C1", () => {
  test("informativo: sino desligado desliga Telegram; ligar o canal religa o sino", async () => {
    const org = await seedOrg("informativo");
    await linkTelegram(org, org.admin);
    await t.run(async (ctx) => {
      await ctx.db.insert("notificationPreferences", {
        organizationId: org.organizationId, teamMemberId: org.admin.memberId, invite: true, handoffRequested: true,
        handoffResolved: true, taskOverdue: true, taskAssigned: true, leadAssigned: true, newMessage: true,
        dailyDigest: true, campaignCompleted: false, channels: { telegram: { campaignCompleted: true } },
        createdAt: NOW, updatedAt: NOW,
      });
    });
    const me = as(org.admin.userId);
    let eff = await me.query(api.notificationPreferences.getMyEffectivePreferences, { organizationId: org.organizationId });
    expect(eff.channels.bell.campaignCompleted).toBe(false);
    expect(eff.channels.telegram.campaignCompleted).toBe(false); // canal && sino
    await notify(org, org.admin, "campaign_completed");
    expect(await bell(org.admin.memberId)).toHaveLength(0);
    expect(await telegramJobs()).toHaveLength(0);
    await me.mutation(api.notificationPreferences.setChannelPref, { organizationId: org.organizationId, channel: "telegram", flag: "campaignCompleted", enabled: true });
    expect((await prefsOf(org, org.admin))?.campaignCompleted).toBe(true);
    eff = await me.query(api.notificationPreferences.getMyEffectivePreferences, { organizationId: org.organizationId });
    expect(eff.channels.bell.campaignCompleted).toBe(true);
    expect(eff.channels.telegram.campaignCompleted).toBe(true);
    await notify(org, org.admin, "campaign_completed");
    expect(await bell(org.admin.memberId)).toHaveLength(1);
    expect(await telegramJobs()).toHaveLength(1);
  });

  test("religar o sino por Telegram não traz o e-mail do tipo junto; e-mail explícito é preservado", async () => {
    const org = await seedOrg("sino-email");
    await t.run(async (ctx) => {
      await ctx.db.insert("notificationPreferences", {
        organizationId: org.organizationId, teamMemberId: org.admin.memberId, invite: true, handoffRequested: true,
        handoffResolved: true, taskOverdue: true, taskAssigned: true, leadAssigned: true, newMessage: true,
        dailyDigest: true, campaignCompleted: false, campaignPaused: false, createdAt: NOW, updatedAt: NOW,
      });
    });
    const me = as(org.admin.userId);
    await me.mutation(api.notificationPreferences.setChannelPref, { organizationId: org.organizationId, channel: "telegram", flag: "campaignCompleted", enabled: true });
    let row = await prefsOf(org, org.admin);
    expect(row?.campaignCompleted).toBe(true);
    expect(row?.channels?.telegram?.campaignCompleted).toBe(true);
    expect(row?.channels?.email?.campaignCompleted).toBe(false);
    const eff = await me.query(api.notificationPreferences.getMyEffectivePreferences, { organizationId: org.organizationId });
    expect(eff.channels.email.campaignCompleted).toBe(false);
    expect(eff.channels.telegram.campaignCompleted).toBe(true);
    expect(eff.channels.bell.campaignCompleted).toBe(true);
    // e-mail já escolhido como ligado: o push não o sobrescreve
    await me.mutation(api.notificationPreferences.setChannelPref, { organizationId: org.organizationId, channel: "email", flag: "campaignPaused", enabled: true });
    await me.mutation(api.notificationPreferences.setChannelPref, { organizationId: org.organizationId, channel: "push", flag: "campaignPaused", enabled: true });
    row = await prefsOf(org, org.admin);
    expect(row?.channels?.email?.campaignPaused).toBe(true);
    expect(row?.campaignPaused).toBe(true);
  });

  test("setQuietHours: início igual ao fim é recusado", async () => {
    const org = await seedOrg("igual");
    await expect(
      as(org.admin.userId).mutation(api.notificationPreferences.setQuietHours, { organizationId: org.organizationId, enabled: true, start: "22:00", end: "22:00" })
    ).rejects.toThrow(/mesmo horário/);
  });

  test("templates de atrasada escapam HTML do título", async () => {
    const { buildTemplate } = await import("./emailTemplates");
    const evil = '<img src=x onerror="alert(1)">';
    const one = buildTemplate("taskOverdue", { taskTitle: evil, dueDate: "01/01", taskUrl: "https://x.com.br/app/tarefas?task=1" });
    const many = buildTemplate("taskOverdueSummary", {
      count: 2, tasks: [{ title: evil, dueDate: "01/01", taskUrl: "https://x.com.br/app/tarefas?task=1" }], appUrl: "https://x.com.br",
    });
    for (const out of [one, many]) {
      expect(out.html).not.toContain("<img");
      expect(out.html).toContain("&lt;img");
    }
  });
});

describe("e-mail de tarefas atrasadas agrupado por membro", () => {
  const overdueJobs = () =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((j) => j.name.includes("dispatchNotification"))
        .map((j) => j.args[0] as any)
        .filter((a) => String(a.eventType).startsWith("taskOverdue"))
    );
  async function task(org: Org, title: string, assignee: Id<"teamMembers">) {
    await t.run((ctx) =>
      ctx.db.insert("tasks", {
        organizationId: org.organizationId, title, type: "reminder", status: "pending", priority: "medium",
        createdBy: org.admin.memberId, assignedTo: assignee, assigneeIds: [assignee], dueDate: NOW - HOUR,
        createdAt: NOW, updatedAt: NOW,
      })
    );
  }

  test("2+ atrasadas do mesmo membro = 1 e-mail-resumo; 1 = e-mail de sempre; sino segue por tarefa", async () => {
    const org = await seedOrg("atrasadas");
    await task(org, "Ligar A", org.agent.memberId);
    await task(org, "Ligar B", org.agent.memberId);
    await task(org, "Ligar C", org.agent.memberId);
    await task(org, "Só uma", org.admin.memberId);
    await t.mutation(internal.tasks.processOverdueReminders, {});
    const jobs = await overdueJobs();
    expect(jobs).toHaveLength(2);
    const summary = jobs.find((j) => j.recipientMemberId === org.agent.memberId);
    expect(summary.eventType).toBe("taskOverdueSummary");
    expect(summary.templateData.count).toBe(3);
    expect(summary.templateData.tasks).toHaveLength(3);
    const single = jobs.find((j) => j.recipientMemberId === org.admin.memberId);
    expect(single.eventType).toBe("taskOverdue");
    expect(single.templateData.taskTitle).toBe("Só uma");
    expect(await bell(org.agent.memberId)).toHaveLength(3);
  });

  test("resumo respeita o flag taskOverdue", async () => {
    const org = await seedOrg("atrasadas-off");
    await as(org.agent.userId).mutation(api.notificationPreferences.updateMyPreferences, { organizationId: org.organizationId, taskOverdue: false });
    expect(await dispatchReachesSendSummary(org, org.agent)).toBe(false);
    await as(org.agent.userId).mutation(api.notificationPreferences.updateMyPreferences, { organizationId: org.organizationId, taskOverdue: true });
    expect(await dispatchReachesSendSummary(org, org.agent)).toBe(true);
  });
  async function dispatchReachesSendSummary(org: Org, member: Org["admin"]) {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await t.mutation(internal.email.dispatchNotification, {
        organizationId: org.organizationId, recipientMemberId: member.memberId, eventType: "taskOverdueSummary",
        templateData: { count: 2, tasks: [{ title: "A", dueDate: "01/01", taskUrl: "https://x.com.br/app/tarefas?task=1" }], appUrl: "https://x.com.br" },
      });
      return spy.mock.calls.some((c) => String(c[0]).includes("falha ao enfileirar"));
    } finally {
      spy.mockRestore();
    }
  }
});
