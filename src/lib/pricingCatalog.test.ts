import { describe, expect, it } from "vitest";
import { allPlanDisplays, planDisplay } from "./pricingCatalog";

describe("pricingCatalog", () => {
  it("mensal mostra a tabela", () => {
    expect(allPlanDisplays("monthly").map((p) => p.monthlyBrl)).toEqual([197, 497, 997, 1490]);
  });
  it("anual mostra 164 / 414 / 831 e Empresa por contrato", () => {
    const a = allPlanDisplays("annual");
    expect(a.map((p) => p.monthlyBrl)).toEqual([164, 414, 831, 1490]);
    expect(a[0].annualTotalBrl).toBe(1970);
    expect(a[3].annualTotalBrl).toBeNull();
    expect(a[3].annualByContract).toBe(true);
  });
  it("destaque so no Profissional", () => {
    expect(allPlanDisplays("monthly").filter((p) => p.featured).map((p) => p.key)).toEqual(["profissional"]);
  });
  it("Essencial: cerca de R$ 6,50 por dia, grupos so por add-on", () => {
    const e = planDisplay("essencial", "monthly");
    expect(e.perDayBrl).toBe(6.5);
    expect(e.groupsMode).toBe("addon");
    expect(e.groupsAddonMax).toBe(3);
    expect(e.hasTeamModules).toBe(false);
  });
  it("Empresa: por unidade e Central", () => {
    const e = planDisplay("empresa", "monthly");
    expect(e.perUnitBrl).toBe(390);
    expect(e.channels).toBe("perUnit");
    expect(e.attendancesPerUnit).toBe(1000);
    expect(e.hasCentral).toBe(true);
    expect(planDisplay("escala", "monthly").hasCentral).toBe(false);
  });
  it("excedente e BYO vem do catalogo", () => {
    expect(allPlanDisplays("monthly").map((p) => p.overageBrl)).toEqual([0.49, 0.49, 0.39, 0.29]);
    expect(allPlanDisplays("monthly").map((p) => p.overageByoBrl)).toEqual([null, 0.29, 0.25, 0.19]);
  });
});
