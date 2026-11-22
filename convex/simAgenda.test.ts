/// <reference types="vite/client" />
/** Harness de simulação da IA na agenda (`simAgenda.ts`): o seeder usa os cores de configuração e a porta de reserva. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const weekdays = [1, 2, 3, 4, 5, 6];
const week = weekdays.map((weekday) => ({ weekday, start: "09:00", end: "18:00" }));

const spec = {
  slug: "sim-agenda-teste",
  name: "Clínica Teste",
  persona: "Você atende a clínica.",
  knowledge: "Funcionamos de segunda a sábado.",
  resources: [
    { key: "s1", kind: "room" as const, name: "Sala 1", capacity: 1, weekly: week },
    { key: "sd", kind: "room" as const, name: "Sala dupla", capacity: 2, weekly: week },
    { key: "p1", kind: "person" as const, name: "Ana", capacity: 1, weekly: week },
  ],
  services: [{ name: "Sessão", durationMin: 50, requirements: [{ role: "Sala", kind: "room" as const }, { role: "Profissional", kind: "person" as const }] }],
  settings: { gridMinutes: 30, smartMode: "restrict" as const, aiBook: "propose" as const },
  exceptions: [{ resourceKey: "sd", dayOffset: 2, mode: "closed" as const, reasonCode: "no_staff" as const }],
  appointments: [{ service: "Sessão", dayOffset: 1, time: "10:00", resourceKeys: ["s1", "p1"], name: "Paciente Fictícia" }],
};

describe("simAgenda", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T13:00:00Z")); // segunda 10:00 em São Paulo
  });
  afterEach(() => vi.useRealTimers());

  test("semeia a org pelos cores, recusa slug repetido e slug fora do prefixo", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.mutation(internal.simAgenda.internalSeedScenarioOrg, { spec });
    expect(seeded.appointmentsCreated).toBe(1);
    expect(Object.keys(seeded.resourceIds).sort()).toEqual(["p1", "s1", "sd"]);
    await expect(t.mutation(internal.simAgenda.internalSeedScenarioOrg, { spec })).rejects.toThrow(/slug já existe/);
    await expect(t.mutation(internal.simAgenda.internalSeedScenarioOrg, { spec: { ...spec, slug: "outra-org" } })).rejects.toThrow(/sim-agenda-/);

    const dump = await t.query(internal.simAgendaRead.internalSimOrgDump, { organizationId: seeded.organizationId });
    expect(dump.appointments).toHaveLength(1);
    expect(dump.appointments[0].status).toBe("scheduled");
    expect(dump.exceptions).toHaveLength(1);
    expect(dump.settings?.smart?.mode).toBe("restrict");

    const org = await t.run((ctx) => ctx.db.get(seeded.organizationId));
    expect(org?.settings.demoMode).toBe(true);
    expect(org?.settings.aiConfig?.spendCap?.mode).toBe("block");
  });

  test("cliente fictício, estado da conversa e recusa de org que não é de cenário", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.mutation(internal.simAgenda.internalSeedScenarioOrg, { spec });
    const c = await t.mutation(internal.simAgenda.internalSimNewCustomer, { organizationId: seeded.organizationId, name: "Cliente Um", phone: "5599900000001" });
    const st = await t.query(internal.simAgendaRead.internalSimState, { organizationId: seeded.organizationId, conversationId: c.conversationId });
    expect(st.messages).toEqual([]);
    expect(st.offers).toEqual([]);
    const real = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Real", slug: "org-real", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: 1, updatedAt: 1 })
    );
    await expect(t.query(internal.simAgendaRead.internalSimOrgDump, { organizationId: real })).rejects.toThrow(/só orgs de cenário/);
    await expect(t.mutation(internal.simAgenda.internalSimSetAiEnabled, { organizationId: real, enabled: false })).rejects.toThrow(/só orgs de cenário/);
  });

  test("envelhece as ofertas e lista as orgs de cenário", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.mutation(internal.simAgenda.internalSeedScenarioOrg, { spec });
    const list = await t.query(internal.simAgendaRead.internalSimListOrgs, {});
    expect(list.map((o) => o.slug)).toEqual(["sim-agenda-teste"]);
    await t.mutation(internal.simAgenda.internalSimSetAiEnabled, { organizationId: seeded.organizationId, enabled: false });
    const after = await t.query(internal.simAgendaRead.internalSimListOrgs, {});
    expect(after[0].aiEnabled).toBe(false);
    const c = await t.mutation(internal.simAgenda.internalSimNewCustomer, { organizationId: seeded.organizationId, name: "Cliente Dois", phone: "5599900000002" });
    expect(await t.mutation(internal.simAgenda.internalSimAgeOffers, { organizationId: seeded.organizationId, conversationId: c.conversationId, minutes: 60 })).toBe(0);
  });
});
