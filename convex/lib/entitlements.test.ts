import { describe, expect, test } from "vitest";
import { checkChannelSlot, checkModule, resolveEntitlements, usageCrossings } from "./entitlements";
import type { OrgBilling } from "./entitlementsOps";

const NOW = Date.UTC(2026, 10, 9);
const DAY = 86_400_000;
const settings = { timezone: "UTC", currency: "BRL" };

function org(billing?: Partial<OrgBilling> & { plan: OrgBilling["plan"]; status: OrgBilling["status"] }, byo = false) {
  return {
    settings: { ...settings, ...(byo ? { aiConfig: { providerConfig: { mode: "byo" as const } } } : {}) } as never,
    billing: billing ? ({ updatedAt: 0, ...billing } as OrgBilling) : undefined,
  };
}

describe("resolveEntitlements", () => {
  test("sem billing e legacy: sem gate, tudo liberado", () => {
    for (const o of [org(), org({ plan: "essencial", status: "legacy" })]) {
      const e = resolveEntitlements(o, NOW);
      expect(e.gated).toBe(false);
      expect(e.limits.aiAttendances).toBe(Infinity);
      expect(e.aiAllowed && e.outboundAllowed).toBe(true);
      expect(Object.values(e.modules).every(Boolean)).toBe(true);
      expect(checkModule(e, "central")).toEqual({ ok: true });
      expect(checkChannelSlot(e, 999)).toEqual({ ok: true });
    }
    expect(resolveEntitlements(null, NOW).gated).toBe(false);
    // legacy sem plano (formato do backfill e do cadastro)
    const noPlan = resolveEntitlements({ settings: settings as never, billing: { status: "legacy", updatedAt: 0 } }, NOW);
    expect(noPlan).toMatchObject({ gated: false, plan: null, status: "legacy" });
  });

  test("fail-open: status diferente de legacy sem plano fica sem gate", () => {
    const e = resolveEntitlements({ settings: settings as never, billing: { status: "active", updatedAt: 0 } }, NOW);
    expect(e).toMatchObject({ gated: false, status: "active" });
    expect(e.limits.aiAttendances).toBe(Infinity);
  });

  test("trial válido = Profissional com 300 atendimentos", () => {
    const e = resolveEntitlements(org({ plan: "essencial", status: "trial", trialEndsAt: NOW + DAY }), NOW);
    expect(e.plan).toBe("profissional");
    expect(e.limits).toMatchObject({ channels: 3, aiAttendances: 300, campaignSends: 5000 });
    expect(e.modules.groups).toBe(true);
    expect(e.aiAllowed).toBe(true);
  });

  test("trial vencido (ou sem data) bloqueia IA e envio", () => {
    for (const trialEndsAt of [NOW - 1, undefined]) {
      const e = resolveEntitlements(org({ plan: "profissional", status: "trial", trialEndsAt }), NOW);
      expect(e.aiAllowed).toBe(false);
      expect(e.outboundAllowed).toBe(false);
      expect(e.exportAllowed).toBe(true);
    }
  });

  test("past_due = active; read_only e canceled bloqueiam e não deixam ligar módulo", () => {
    const active = resolveEntitlements(org({ plan: "profissional", status: "active" }), NOW);
    const pastDue = resolveEntitlements(org({ plan: "profissional", status: "past_due" }), NOW);
    expect({ ...pastDue, status: "active" }).toEqual(active);
    for (const status of ["read_only", "canceled"] as const) {
      const e = resolveEntitlements(org({ plan: "escala", status }), NOW);
      expect(e.aiAllowed).toBe(false);
      expect(e.outboundAllowed).toBe(false);
      expect(Object.values(e.modules).some(Boolean)).toBe(false);
    }
  });

  test("Empresa: canais = unidades, atendimentos 3.000 + 1.000 x unidades", () => {
    const e = resolveEntitlements(org({ plan: "empresa", status: "active", units: 4 }), NOW);
    expect(e.limits).toMatchObject({ channels: 4, aiAttendances: 7000, campaignSends: 50000 });
    expect(e.modules.central).toBe(true);
  });

  test("canais extra somam; overrides vencem", () => {
    const e = resolveEntitlements(org({ plan: "escala", status: "active", extraChannels: 4 }), NOW);
    expect(e.limits.channels).toBe(10);
    const o = resolveEntitlements(
      org({ plan: "escala", status: "active", extraChannels: 4, overrides: { channels: 2, aiAttendances: 99 } }),
      NOW
    );
    expect(o.limits.channels).toBe(2);
    expect(o.limits.aiAttendances).toBe(99);
  });

  test("add-on Grupos no Essencial: 3 grupos com IA", () => {
    const without = resolveEntitlements(org({ plan: "essencial", status: "active" }), NOW);
    expect(without.modules.groups).toBe(false);
    expect(without.limits.groupsWithAi).toBe(0);
    const withAddon = resolveEntitlements(org({ plan: "essencial", status: "active", addons: { groups: true } }), NOW);
    expect(withAddon.modules.groups).toBe(true);
    expect(withAddon.limits.groupsWithAi).toBe(3);
  });

  test("preço do excedente segue o modo BYO; teto em centavos", () => {
    const billing = { plan: "profissional", status: "active", overage: { enabled: true, capBrl: 100, updatedAt: 0 } } as const;
    expect(resolveEntitlements(org(billing), NOW).overage).toEqual({ enabled: true, capBrlCents: 10000, unitBrlCents: 49 });
    expect(resolveEntitlements(org(billing, true), NOW).overage.unitBrlCents).toBe(29);
    expect(resolveEntitlements(org({ plan: "profissional", status: "active" }), NOW).overage.enabled).toBe(false);
  });
});

describe("checks puros", () => {
  test("checkModule recusa com upgrade e mensagem", () => {
    const e = resolveEntitlements(org({ plan: "essencial", status: "active" }), NOW);
    expect(checkModule(e, "departments")).toMatchObject({ ok: false, reason: "plan", upgradeTo: "profissional" });
    expect(checkModule(e, "central")).toMatchObject({ ok: false, upgradeTo: "empresa" });
    const g = checkModule(e, "groups");
    expect(g.ok === false && g.message).toContain("add-on");
  });

  test("checkChannelSlot pede aceite no limite", () => {
    const e = resolveEntitlements(org({ plan: "essencial", status: "active" }), NOW);
    expect(checkChannelSlot(e, 0)).toEqual({ ok: true });
    expect(checkChannelSlot(e, 1)).toMatchObject({ ok: false, needsExtraAck: true });
  });

  test("usageCrossings: 80%, 100%, carimbos e salto direto", () => {
    expect(usageCrossings({ used: 79, limit: 100 })).toEqual({ warn: false, reached: false });
    expect(usageCrossings({ used: 80, limit: 100 })).toEqual({ warn: true, reached: false });
    expect(usageCrossings({ used: 80, limit: 100, warnedAt: 1 })).toEqual({ warn: false, reached: false });
    expect(usageCrossings({ used: 101, limit: 100, warnedAt: 1 })).toEqual({ warn: false, reached: true });
    expect(usageCrossings({ used: 101, limit: 100, warnedAt: 1, reachedAt: 2 })).toEqual({ warn: false, reached: false });
    expect(usageCrossings({ used: 5, limit: Infinity })).toEqual({ warn: false, reached: false });
  });
});
