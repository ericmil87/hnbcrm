import { describe, expect, it } from "vitest";
import {
  attendanceBillingLabel,
  attendanceProjection,
  attendancesCoveredByCap,
  buildMeters,
  changePlanMailto,
  creditExpiresSoon,
  invoiceLines,
  isBillingPanelVisible,
  overageConfirmText,
  overageEligibility,
  parseCapBrl,
  priceLockText,
  roundNow,
  statusInfo,
  trialDaysLeft,
  trialText,
} from "./billingPanel";

const DAY = 24 * 60 * 60 * 1000;
const summary = {
  month: "2026-11",
  attendances: { total: 850, included: 850, credit: 0, overage: 0, suggestOnly: 0, overageBrlCents: 0, limit: 1000 },
  campaignSends: { used: 5000, limit: 5000 },
};

describe("billingPanel", () => {
  it("painel so aparece com plano (nunca em legacy nem enquanto carrega)", () => {
    expect(isBillingPanelVisible(undefined)).toBe(false);
    expect(isBillingPanelVisible(null)).toBe(false);
    expect(isBillingPanelVisible("legacy")).toBe(false);
    for (const m of ["trial", "active", "past_due", "read_only", "canceled"] as const) {
      expect(isBillingPanelVisible(m)).toBe(true);
    }
  });

  it("status: avisos de past_due e read_only", () => {
    expect(statusInfo("active").notice).toBeNull();
    expect(statusInfo("past_due").notice).toContain("pagamento pendente");
    expect(statusInfo("read_only").notice).toContain("só leitura");
    expect(statusInfo("trial").label).toBe("Teste grátis");
  });

  it("dias do teste calculados no front", () => {
    const now = 1_000_000_000_000;
    expect(trialDaysLeft(now + 12 * DAY - 1000, now)).toBe(12);
    expect(trialDaysLeft(now - DAY, now)).toBe(0);
    expect(trialDaysLeft(undefined, now)).toBeNull();
    expect(trialText(1)).toBe("Falta 1 dia do teste grátis.");
    expect(trialText(12)).toBe("Faltam 12 dias do teste grátis.");
    expect(trialText(0)).toBe("O teste termina hoje.");
  });

  it("priceLock: fundador, desconto e vencido", () => {
    const now = 1000;
    expect(priceLockText({ kind: "founder", discountPct: 30 }, now)).toBe("Preço de fundador: 30% de desconto");
    expect(priceLockText({ kind: "frozen", monthlyBrl: 150 }, now)).toContain("Preço travado");
    expect(priceLockText({ kind: "founder", discountPct: 30, until: 500 }, now)).toBeNull();
    expect(priceLockText(null, now)).toBeNull();
  });

  it("medidores com estado 80/100 e sem canais ate carregar", () => {
    const m = buildMeters(summary, undefined);
    expect(m.map((x) => x.id)).toEqual(["attendances", "campaignSends"]);
    expect(m[0].state).toBe("warn80");
    expect(m[0].percent).toBe(85);
    expect(m[1].state).toBe("limit100");
    const full = buildMeters(summary, {
      channels: { active: 2, limit: 3, truncated: false },
      aiGroups: { used: 0, limit: null, truncated: false },
    });
    expect(full.map((x) => x.id)).toEqual(["attendances", "campaignSends", "channels", "aiGroups"]);
    expect(full[3].percent).toBeNull();
  });

  it("projecao so com limite e uso", () => {
    const now = Date.parse("2026-11-16T00:00:00Z");
    expect(attendanceProjection(400, 1000, "2026-11", now)).toEqual({ projected: 800, exceeds: false });
    expect(attendanceProjection(600, 1000, "2026-11", now)?.exceeds).toBe(true);
    expect(attendanceProjection(0, 1000, "2026-11", now)).toBeNull();
    expect(attendanceProjection(10, null, "2026-11", now)).toBeNull();
  });

  it("excedente: recusado em teste com motivo", () => {
    expect(overageEligibility("active").canEnable).toBe(true);
    expect(overageEligibility("past_due").canEnable).toBe(true);
    const t = overageEligibility("trial");
    expect(t.canEnable).toBe(false);
    expect(t.reason).toContain("depois que você contrata");
    expect(overageEligibility("read_only").canEnable).toBe(false);
  });

  it("teto: inteiro de R$ 1 a R$ 100.000", () => {
    expect(parseCapBrl("250")).toEqual({ ok: true, capBrl: 250 });
    expect(parseCapBrl("250,00")).toEqual({ ok: true, capBrl: 250 });
    expect(parseCapBrl("")).toMatchObject({ ok: false });
    expect(parseCapBrl("12,50")).toMatchObject({ ok: false });
    expect(parseCapBrl("0")).toMatchObject({ ok: false });
    expect(parseCapBrl("100001")).toMatchObject({ ok: false });
    expect(parseCapBrl("100000")).toMatchObject({ ok: true });
  });

  it("texto do aceite cita valor por atendimento e teto", () => {
    const t = overageConfirmText(250, 49);
    expect(t).toMatch(/R\$\s*0,49 por atendimento IA além da franquia/);
    expect(t).toMatch(/teto de R\$\s*250 por mês/);
    expect(attendancesCoveredByCap(250, 49)).toBe(510);
    expect(attendancesCoveredByCap(250, null)).toBeNull();
  });

  it("linhas da fatura somam ao total e mostram preco combinado", () => {
    const est = { planBrl: 497, extraChannelsBrl: 79, groupsAddonBrl: 0, listBrl: 576, recurringBrl: 403.2, overageBrl: 10, totalBrl: 413.2 };
    const lines = invoiceLines(est, "Profissional");
    expect(lines.map((l) => l.id)).toEqual(["plan", "extraChannels", "priceLock", "overage"]);
    expect(lines[0].label).toBe("Plano Profissional");
    expect(lines.reduce((s, l) => s + l.amountBrl, 0)).toBeCloseTo(est.totalBrl, 5);
  });

  it("rotulos de extrato, credito e contato", () => {
    expect(attendanceBillingLabel("suggest_only")).toBe("Só sugestão");
    expect(creditExpiresSoon(10 * DAY, 0)).toBe(true);
    expect(creditExpiresSoon(90 * DAY, 0)).toBe(false);
    expect(changePlanMailto("Acme", "Essencial")).toMatch(/^mailto:.+\?subject=/);
    expect(roundNow(1_000_000_123)).toBe(Math.floor(1_000_000_123 / 900000) * 900000);
  });
});
