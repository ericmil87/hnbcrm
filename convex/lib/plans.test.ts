import { describe, expect, test } from "vitest";
import {
  ANNUAL_MONTHS_CHARGED,
  EXTRA_CHANNEL_BRL,
  GATED_MODULES,
  GROUPS_ADDON_BRL,
  MODULE_GATE,
  PACK,
  PLANS,
  PLAN_KEYS,
  TRIAL,
  USAGE_WARN_PCT,
  lowestPlanWithModule,
} from "./plans";

describe("catálogo de planos", () => {
  test("preços e limites da decisão", () => {
    expect(PLANS.essencial).toMatchObject({ monthlyBrl: 197, channels: 1, aiAttendances: 300, campaignSends: 500, overageBrlCents: 49, overageByoBrlCents: null, groupsAddonMax: 3 });
    expect(PLANS.profissional).toMatchObject({ monthlyBrl: 497, channels: 3, aiAttendances: 1000, campaignSends: 5000, overageBrlCents: 49, overageByoBrlCents: 29 });
    expect(PLANS.escala).toMatchObject({ monthlyBrl: 997, channels: 6, aiAttendances: 2500, campaignSends: 20000, overageBrlCents: 39, overageByoBrlCents: 25 });
    expect(PLANS.empresa).toMatchObject({ monthlyBrl: 1490, perUnitBrl: 390, channels: "perUnit", aiAttendances: 3000, aiAttendancesPerUnit: 1000, campaignSends: 50000, overageBrlCents: 29, overageByoBrlCents: 19 });
  });

  test("constantes", () => {
    expect(TRIAL).toEqual({ plan: "profissional", days: 30, aiAttendances: 300 });
    expect(EXTRA_CHANNEL_BRL).toBe(79);
    expect(GROUPS_ADDON_BRL).toBe(99);
    expect(PACK).toEqual({ attendances: 1000, brl: 390, months: 12 });
    expect(ANNUAL_MONTHS_CHARGED).toBe(10);
    expect(USAGE_WARN_PCT).toBe(80);
  });

  test("módulos: grupos/setores/tradução/api no Profissional+; Central, unidades e atribuição só Empresa", () => {
    expect(PLANS.essencial.modules).toEqual([]);
    for (const p of ["profissional", "escala"] as const) {
      expect(PLANS[p].modules).toEqual(["groups", "departments", "translation", "api"]);
    }
    expect([...PLANS.empresa.modules].sort()).toEqual([...GATED_MODULES].sort());
    expect(lowestPlanWithModule("api")).toBe("profissional");
    expect(lowestPlanWithModule("central")).toBe("empresa");
  });

  test("planos crescentes em preço e franquia", () => {
    const keys = [...PLAN_KEYS];
    for (let i = 1; i < keys.length; i++) {
      expect(PLANS[keys[i]].monthlyBrl).toBeGreaterThan(PLANS[keys[i - 1]].monthlyBrl);
      expect(PLANS[keys[i]].aiAttendances).toBeGreaterThan(PLANS[keys[i - 1]].aiAttendances);
    }
  });

  test("MODULE_GATE só cobre chaves reais, sem metaMessaging nem telegram", () => {
    const valid = ["units", "departments", "attribution", "central", "metaMessaging", "telegram", "translation"];
    for (const [k, g] of Object.entries(MODULE_GATE)) {
      expect(valid).toContain(k);
      expect(GATED_MODULES).toContain(g);
    }
    expect(MODULE_GATE).not.toHaveProperty("metaMessaging");
    expect(MODULE_GATE).not.toHaveProperty("telegram");
  });
});
