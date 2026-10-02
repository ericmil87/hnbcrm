/// <reference types="vite/client" />
/**
 * Simulador de org de demonstração (`demoSim`): recusa fora de demoMode,
 * setup idempotente, operações (conversa, mensagens, classificação,
 * transferência, repasse, desfecho retroativo) e reset que só toca a org demo.
 */
import { expect, test, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const NOW = new Date("2026-09-28T15:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const OWNER = "dono@example.com";

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.useRealTimers();
});

const scenario = {
  org: { name: "Grupo Demo", slug: "grupo-demo", timezone: "America/Sao_Paulo", currency: "BRL" },
  units: [
    { key: "u1", name: "Unidade Um", color: "#111111", status: "active" as const },
    { key: "u2", name: "Unidade Dois", color: "#222222", status: "onboarding" as const },
  ],
  team: [
    { key: "gerente", name: "Gerente Fictício", type: "human" as const, role: "manager" as const },
    { key: "fin", name: "Financeiro Fictício", type: "human" as const, role: "agent" as const },
    { key: "ia", name: "Concierge Demo", type: "ai" as const, role: "ai" as const },
  ],
  departments: [
    { key: "res", name: "Reservas", color: "#2563EB", memberKeys: ["gerente", "ia"], isEntry: true },
    { key: "fin", name: "Financeiro", color: "#059669", memberKeys: ["fin"], unitKeys: ["u1"] },
  ],
  boards: [
    {
      key: "b1",
      name: "Reservas",
      isDefault: true,
      stages: [
        { key: "novo", name: "Novo contato", color: "#64748B" },
        { key: "cot", name: "Cotação", color: "#6366F1" },
        { key: "won", name: "Reserva confirmada", color: "#16A34A", isClosedWon: true },
        { key: "lost", name: "Não converteu", color: "#DC2626", isClosedLost: true },
      ],
    },
  ],
  fields: [
    { key: "checkin", name: "Check-in", type: "date" as const, entity: "lead" as const },
    { key: "hospedes", name: "Hóspedes", type: "number" as const, entity: "lead" as const },
  ],
  labels: [{ name: "Lua de Mel", color: "#DB2777" }],
  attendant: { name: "Concierge Demo", systemPrompt: "Você é a concierge.", knowledge: "Base." },
};

async function seedOwner() {
  return await t.run(async (ctx) => ctx.db.insert("users", { email: OWNER, name: "Dono" }));
}

async function setup() {
  await seedOwner();
  return await t.mutation(internal.demoSim.internalEnsureDemoOrg, { ownerEmail: OWNER, scenario });
}

async function realOrg(slug = "org-real") {
  return await t.run(async (ctx) =>
    ctx.db.insert("organizations", {
      name: "Org Real",
      slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: NOW,
      updatedAt: NOW,
    })
  );
}

const byName = <T extends { name: string; id: string }>(rows: T[], name: string) => {
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`sem ${name}`);
  return row.id;
};

test("recusa org sem demoMode e slug de org real", async () => {
  const orgId = await realOrg("grupo-demo");
  await expect(
    t.mutation(internal.demoSim.internalApplyOps, { organizationId: orgId, ops: [] })
  ).rejects.toThrow(/demonstração/);
  await expect(t.mutation(internal.demoSim.internalResetDemo, { organizationId: orgId })).rejects.toThrow(
    /demonstração/
  );
  await expect(t.query(internal.demoSim.internalDemoStatus, { organizationId: orgId })).rejects.toThrow(
    /demonstração/
  );
  await expect(
    t.mutation(internal.demoSim.internalSeedAdSpend, { organizationId: orgId, rows: [] })
  ).rejects.toThrow(/demonstração/);
  await seedOwner();
  await expect(
    t.mutation(internal.demoSim.internalEnsureDemoOrg, { ownerEmail: OWNER, scenario })
  ).rejects.toThrow(/REAL/);
});

test("setup cria a org demo e é idempotente", async () => {
  const first = await setup();
  expect(first.created).toBe(true);
  const second = await t.mutation(internal.demoSim.internalEnsureDemoOrg, { ownerEmail: OWNER, scenario });
  expect(second.created).toBe(false);
  expect(second.map.organizationId).toBe(first.map.organizationId);

  const orgId = first.map.organizationId;
  const snapshot = await t.run(async (ctx) => {
    const org = await ctx.db.get(orgId);
    const count = async (table: "teamMembers" | "units" | "departments" | "boards" | "stages" | "fieldDefinitions" | "conversationLabels") =>
      (await ctx.db.query(table).collect()).filter((r: any) => r.organizationId === orgId).length;
    const ai = (await ctx.db.query("teamMembers").collect()).find((m) => m.type === "ai");
    const fin = (await ctx.db.query("departments").collect()).find((d) => d.name === "Financeiro");
    return {
      settings: org!.settings,
      members: await count("teamMembers"),
      units: await count("units"),
      departments: await count("departments"),
      boards: await count("boards"),
      stages: await count("stages"),
      fields: await count("fieldDefinitions"),
      labels: await count("conversationLabels"),
      ai,
      fin,
    };
  });
  expect(snapshot.settings.demoMode).toBe(true);
  expect(snapshot.settings.modules).toEqual({ units: true, departments: true, attribution: true, central: true });
  expect(snapshot.settings.aiConfig?.enabled).toBe(true);
  expect(snapshot.settings.aiConfig?.lgpdAck).toBeDefined();
  expect(snapshot.members).toBe(4); // dono + 3 fictícios
  expect(snapshot.units).toBe(2);
  expect(snapshot.departments).toBe(2);
  expect(snapshot.boards).toBe(1);
  expect(snapshot.stages).toBe(4);
  expect(snapshot.fields).toBe(2);
  expect(snapshot.labels).toBe(1);
  expect(snapshot.ai?.agentProfile?.kind).toBe("attendant");
  expect(snapshot.ai?.agentProfile?.mode).toBe("suggest");
  expect(snapshot.ai?.agentProfile?.systemPrompt).toBe("Você é a concierge.");
  expect(snapshot.fin?.memberIds).toHaveLength(1);
  expect(snapshot.fin?.unitIds).toHaveLength(1);
  expect(first.map.ownerMemberId).not.toBeNull();
  expect(first.map.attendantMemberId).not.toBeNull();
});

test("ops: conversa retroativa completa até a venda", async () => {
  const { map } = await setup();
  const orgId = map.organizationId;
  const board = map.boards[0];
  const ai = map.attendantMemberId!;
  const gerente = byName(map.members, "Gerente Fictício");
  const fin = byName(map.members, "Financeiro Fictício");
  const u1 = byName(map.units, "Unidade Um");
  const res = byName(map.departments, "Reservas");
  const finDept = byName(map.departments, "Financeiro");
  const t0 = NOW - 10 * DAY;

  const results = await t.mutation(internal.demoSim.internalApplyOps, {
    organizationId: orgId,
    ops: [
      {
        type: "createContactLeadConversation",
        ref: "c",
        phone: "5554900000001",
        firstName: "Maria",
        lastName: "Teste",
        boardId: board.id,
        departmentId: res,
        leadAssignedTo: ai,
        value: 3000,
        createdAt: t0,
      },
      {
        type: "addMessage",
        conversationId: "$c",
        direction: "inbound",
        senderType: "contact",
        content: "Oi, quero reservar",
        at: t0,
        demo: { story: "s1", step: 0 },
      },
      {
        type: "classify",
        conversationId: "$c",
        unitId: u1,
        tags: ["Lua de Mel"],
        temperature: "hot",
        attribution: { source: "meta_ads", campaignName: "Campanha Ótima" },
        at: t0 + 1000,
      },
      {
        type: "addMessage",
        conversationId: "$c",
        direction: "outbound",
        senderType: "ai",
        senderId: ai,
        content: "Olá!",
        at: t0 + 8000,
      },
      { type: "transfer", conversationId: "$c", toDepartmentId: finDept, toMemberId: fin, note: "Pix", byMemberId: ai, at: t0 + 60_000 },
      { type: "handoffRequest", conversationId: "$c", fromMemberId: ai, toMemberId: gerente, reason: "Fechar", at: t0 + 120_000 },
      { type: "handoffAccept", conversationId: "$c", memberId: gerente, at: t0 + 180_000 },
      {
        type: "outcome",
        conversationId: "$c",
        result: "won",
        value: 3500,
        checkin: "2026-10-20",
        guests: 2,
        byMemberId: gerente,
        at: t0 + 3_600_000,
      },
    ],
  });
  expect(results).toHaveLength(8);
  const conversationId = results[0].conversationId as Id<"conversations">;
  const leadId = results[0].leadId as Id<"leads">;

  const state = await t.run(async (ctx) => {
    const conversation = await ctx.db.get(conversationId);
    const lead = await ctx.db.get(leadId);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect();
    const transfers = await ctx.db
      .query("conversationTransfers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect();
    const handoffs = await ctx.db.query("handoffs").collect();
    const stage = lead ? await ctx.db.get(lead.stageId) : null;
    return { conversation, lead, messages, transfers, handoffs, stage };
  });
  expect(state.conversation?.createdAt).toBe(t0);
  expect(state.conversation?.firstInboundAt).toBe(t0);
  expect(state.conversation?.firstResponseAt).toBe(t0 + 8000);
  expect(state.conversation?.firstResponderType).toBe("ai");
  expect(state.conversation?.unitId).toBe(u1);
  expect(state.conversation?.labelIds).toHaveLength(1);
  expect(state.conversation?.assignedTo).toBe(gerente);
  expect(state.conversation?.departmentId).toBe(finDept);
  expect(state.lead?.attribution?.campaignKey).toBe("campanha-otima");
  expect(state.lead?.closedType).toBe("won");
  expect(state.lead?.assignedTo).toBe(gerente);
  expect(state.lead?.closedAt).toBe(t0 + 3_600_000);
  expect(state.lead?.value).toBe(3500);
  expect(state.lead?.customFields).toMatchObject({ checkin: "2026-10-20", hospedes: 2 });
  expect(state.stage?.isClosedWon).toBe(true);
  expect(state.transfers).toHaveLength(1);
  expect(state.transfers[0].createdAt).toBe(t0 + 60_000);
  expect(state.messages.some((m) => m.metadata?.kind === "transfer")).toBe(true);
  expect(state.messages.find((m) => m.direction === "inbound")?.metadata).toMatchObject({ demo: true, story: "s1" });
  expect(state.handoffs[0].status).toBe("accepted");
  expect(state.handoffs[0].createdAt).toBe(t0 + 120_000);
  expect(state.handoffs[0].resolvedAt).toBe(t0 + 180_000);
  // Nenhuma mensagem gerou dispatch (sem rede).
  expect(state.messages.every((m) => !m.externalId)).toBe(true);

  const open = await t.query(internal.demoSim.internalListOpenConversations, { organizationId: orgId });
  expect(open).toHaveLength(0); // lead fechado sai da lista
});

test("ops: ids de outra org são recusados", async () => {
  const { map } = await setup();
  const otherOrg = await realOrg();
  const foreignBoard = await t.run(async (ctx) =>
    ctx.db.insert("boards", {
      organizationId: otherOrg,
      name: "Outro",
      color: "#000",
      isDefault: true,
      order: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
  );
  await expect(
    t.mutation(internal.demoSim.internalApplyOps, {
      organizationId: map.organizationId,
      ops: [{ type: "createContactLeadConversation", phone: "1", firstName: "X", boardId: foreignBoard }],
    })
  ).rejects.toThrow(/não pertence/);
});

test("adSpend + status + reset só da org demo", async () => {
  const { map } = await setup();
  const orgId = map.organizationId;
  const board = map.boards[0];
  await t.mutation(internal.demoSim.internalSeedAdSpend, {
    organizationId: orgId,
    rows: [
      { date: "2026-09-20", platform: "meta", campaignName: "Campanha Ótima", amount: 120 },
      { date: "2026-09-20", platform: "meta", campaignName: "Campanha Ótima", amount: 150 },
    ],
  });
  for (let i = 0; i < 3; i++) {
    await t.mutation(internal.demoSim.internalApplyOps, {
      organizationId: orgId,
      ops: [
        { type: "createContactLeadConversation", ref: "c", phone: `55549000000${i}`, firstName: `P${i}`, boardId: board.id },
        { type: "addMessage", conversationId: "$c", direction: "inbound", senderType: "contact", content: "oi" },
      ],
    });
  }

  // Dados de OUTRA org precisam sobreviver ao reset.
  const otherOrg = await realOrg();
  const otherContact = await t.run(async (ctx) =>
    ctx.db.insert("contacts", { organizationId: otherOrg, firstName: "Real", tags: [], createdAt: NOW, updatedAt: NOW })
  );

  const before = await t.query(internal.demoSim.internalDemoStatus, { slug: "grupo-demo" });
  expect(before.counts).toMatchObject({ contacts: 3, leads: 3, conversations: 3, messages: 3, adSpend: 1, openConversations: 3 });
  const open = await t.query(internal.demoSim.internalListOpenConversations, { organizationId: orgId });
  expect(open).toHaveLength(3);

  const result = await t.mutation(internal.demoSim.internalResetDemo, { organizationId: orgId });
  expect(result.done).toBe(true);
  const after = await t.query(internal.demoSim.internalDemoStatus, { organizationId: orgId });
  expect(after.counts).toMatchObject({ contacts: 0, leads: 0, conversations: 0, messages: 0, adSpend: 0 });
  // Configuração da demo fica.
  expect(after.map.units).toHaveLength(2);
  expect(after.map.departments).toHaveLength(2);
  expect(await t.run(async (ctx) => ctx.db.get(otherContact))).not.toBeNull();
});

test("após o reset o dono não cai no assistente de onboarding", async () => {
  const { map } = await setup();
  const orgId = map.organizationId;
  const userId = await t.run(async (ctx) => (await ctx.db.query("users").first())!._id);
  await t.mutation(internal.demoSim.internalApplyOps, {
    organizationId: orgId,
    ops: [{ type: "createContactLeadConversation", phone: "5554900000009", firstName: "Z", boardId: map.boards[0].id }],
  });
  const reset = await t.mutation(internal.demoSim.internalResetDemo, { organizationId: orgId });
  expect(reset.done).toBe(true);
  const progress = await t
    .withIdentity({ subject: `${userId}|s1` })
    .query(api.onboarding.getOnboardingProgress, { organizationId: orgId });
  expect(progress.shouldShowWizard).toBe(false);
  const rows = await t.run(async (ctx) =>
    (await ctx.db.query("onboardingProgress").collect()).filter((r) => r.organizationId === orgId)
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ wizardCompleted: true, checklistDismissed: true });
  const org = await t.run(async (ctx) => ctx.db.get(orgId));
  expect(org?.onboardingMeta?.wizardCompletedAt).toBeDefined();
});
