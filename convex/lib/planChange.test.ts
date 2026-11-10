import { describe, expect, test } from "vitest";
import { classifyPlanChange, equivalentMonthlyBrl, evaluatePlanChange, lockAfterPlanChange, type ChangeOrgInfo } from "./planChange";

const shape = (plan: "essencial" | "profissional" | "escala", cycle: "monthly" | "yearly", chargeBrl: number) => ({ plan, cycle, chargeBrl });

describe("classifyPlanChange", () => {
  test("mensalidade equivalente maior = upgrade, menor = downgrade", () => {
    expect(classifyPlanChange(shape("profissional", "monthly", 497), shape("escala", "monthly", 997))).toBe("upgrade");
    expect(classifyPlanChange(shape("escala", "monthly", 997), shape("profissional", "monthly", 497))).toBe("downgrade");
  });
  test("mensal -> anual é upgrade e anual -> mensal é downgrade, no mesmo plano", () => {
    expect(classifyPlanChange(shape("essencial", "monthly", 197), shape("essencial", "yearly", 1970))).toBe("upgrade");
    expect(classifyPlanChange(shape("essencial", "yearly", 1970), shape("essencial", "monthly", 197))).toBe("downgrade");
  });
  test("igual em tudo é same", () => {
    expect(classifyPlanChange(shape("escala", "yearly", 9970), shape("escala", "yearly", 9970))).toBe("same");
  });
  test("outro plano compara a mensalidade equivalente (anual conta 10/12)", () => {
    expect(equivalentMonthlyBrl("yearly", 1200)).toBe(100);
    // Profissional mensal (497) -> Essencial anual (197*10/12 = 164): menor = downgrade.
    expect(classifyPlanChange(shape("profissional", "monthly", 497), shape("essencial", "yearly", 1970))).toBe("downgrade");
    // Essencial mensal (197) -> Profissional anual (4970/12 = 414): maior = upgrade.
    expect(classifyPlanChange(shape("essencial", "monthly", 197), shape("profissional", "yearly", 4970))).toBe("upgrade");
  });
  test("mesmo plano e ciclo, add-on muda o valor: decide pelo valor", () => {
    expect(classifyPlanChange(shape("essencial", "monthly", 197), shape("essencial", "monthly", 247))).toBe("upgrade");
    expect(classifyPlanChange(shape("essencial", "monthly", 247), shape("essencial", "monthly", 197))).toBe("downgrade");
  });
});

const org = (extra: Partial<ChangeOrgInfo> = {}): ChangeOrgInfo => ({
  status: "active",
  plan: "profissional",
  cycle: "monthly",
  groupsAddon: false,
  extraChannels: 0,
  priceLock: null,
  hasSubscription: true,
  canceling: false,
  currentPeriodEnd: 1_800_000_000_000,
  ...extra,
});

describe("evaluatePlanChange", () => {
  const ev = (plan: "essencial" | "profissional" | "escala" | "empresa", cycle: "monthly" | "yearly", o = org()) =>
    evaluatePlanChange({ plan, cycle, groupsAddon: false, org: o, now: 1 });

  test("upgrade não traz effectiveAt; downgrade traz o fim do ciclo", () => {
    expect(ev("escala", "monthly")).toMatchObject({ ok: true, kind: "upgrade", currentChargeBrl: 497 });
    expect(ev("escala", "monthly")).not.toHaveProperty("effectiveAt");
    expect(ev("essencial", "monthly")).toMatchObject({ ok: true, kind: "downgrade", effectiveAt: 1_800_000_000_000 });
  });
  test("recusas: Empresa, sem assinatura, cancelando, trimestral, add-on inválido", () => {
    expect(ev("empresa", "monthly")).toMatchObject({ ok: false, refusal: expect.stringMatching(/Empresa/) });
    expect(ev("escala", "monthly", org({ plan: "empresa" }))).toMatchObject({ ok: false });
    expect(ev("escala", "monthly", org({ hasSubscription: false }))).toMatchObject({ ok: false, refusal: expect.stringMatching(/assinatura ativa/) });
    expect(ev("escala", "monthly", org({ status: "trial" }))).toMatchObject({ ok: false });
    expect(ev("escala", "monthly", org({ canceling: true }))).toMatchObject({ ok: false, refusal: expect.stringMatching(/cancelamento agendado/) });
    expect(ev("escala", "monthly", org({ cycle: "quarterly" }))).toMatchObject({ ok: false });
    expect(evaluatePlanChange({ plan: "escala", cycle: "monthly", groupsAddon: true, org: org(), now: 1 })).toMatchObject({ ok: false });
  });
  test("a trava vale só no plano que cobriu: a troca de plano usa a tabela", () => {
    const locked = org({ priceLock: { kind: "founder", monthlyBrl: 297 } });
    expect(ev("profissional", "yearly", locked)).toMatchObject({ ok: true, currentChargeBrl: 297 });
    expect(ev("escala", "monthly", locked)).toMatchObject({ ok: true, price: { chargeBrl: 997 } });
  });
});

describe("lockAfterPlanChange", () => {
  test("mesmo plano mantém; outro plano perde o valor combinado e mantém só desconto %", () => {
    expect(lockAfterPlanChange({ monthlyBrl: 297 }, "profissional", "profissional")).toEqual({ monthlyBrl: 297 });
    expect(lockAfterPlanChange({ monthlyBrl: 297 }, "profissional", "escala")).toBeUndefined();
    expect(lockAfterPlanChange({ monthlyBrl: 297, discountPct: 20 }, "profissional", "escala")).toEqual({ monthlyBrl: undefined, discountPct: 20 });
    expect(lockAfterPlanChange(undefined, "profissional", "escala")).toBeUndefined();
  });
});
