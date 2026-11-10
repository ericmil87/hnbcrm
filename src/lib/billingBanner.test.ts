import { describe, expect, it } from "vitest";
import { readDismissed, resolveBillingBanner, writeDismissed, type BannerEntitlements } from "./billingBanner";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const none = new Set<string>();
// Com `usageLevel`, o alerta é do mês corrente (novembro) salvo se o teste disser outro.
const ent = (o: Partial<BannerEntitlements>): BannerEntitlements => ({
  mode: "active",
  readOnly: false,
  ...(o.usageLevel ? { usageAlertMonth: "2026-11" } : {}),
  ...o,
});
const run = (o: Partial<BannerEntitlements>, extra: { canViewBilling?: boolean; dismissed?: Set<string> } = {}) =>
  resolveBillingBanner({ ent: ent(o), now: NOW, canViewBilling: extra.canViewBilling ?? true, dismissed: extra.dismissed ?? none });

describe("resolveBillingBanner", () => {
  it("nunca em org legada, null ou sem alerta", () => {
    expect(run({ mode: "legacy", readOnly: true, usageLevel: "limit100" })).toBeNull();
    expect(resolveBillingBanner({ ent: null, now: NOW, canViewBilling: true, dismissed: none })).toBeNull();
    expect(resolveBillingBanner({ ent: undefined, now: NOW, canViewBilling: true, dismissed: none })).toBeNull();
    expect(run({})).toBeNull();
  });

  it("usageLevel ausente conta como ok", () => {
    expect(run({ mode: "active" })).toBeNull();
    expect(run({ mode: "active", usageLevel: "ok" })).toBeNull();
  });

  it("prioridade: só leitura > atraso > teste <= 7 > 100% > 80% > teste", () => {
    const base = { usageLevel: "limit100" as const, trialEndsAt: NOW + 3 * DAY };
    expect(run({ ...base, mode: "trial", readOnly: true, })?.kind).toBe("read_only");
    expect(run({ ...base, mode: "past_due" })?.kind).toBe("past_due");
    expect(run({ ...base, mode: "trial" })?.kind).toBe("trial_ending");
    expect(run({ mode: "active", usageLevel: "limit100" })?.kind).toBe("limit100");
    expect(run({ mode: "active", usageLevel: "warn80" })?.kind).toBe("warn80");
    expect(run({ mode: "trial", trialEndsAt: NOW + 20 * DAY, usageLevel: "warn80" })?.kind).toBe("warn80");
    expect(run({ mode: "trial", trialEndsAt: NOW + 20 * DAY })?.kind).toBe("trial");
  });

  it("read_only (inclusive canceled) e atraso não são dispensáveis", () => {
    expect(run({ mode: "read_only", readOnly: true })?.dismissible).toBe(false);
    expect(run({ mode: "canceled" })?.kind).toBe("read_only");
    expect(run({ mode: "past_due" })?.dismissible).toBe(false);
    expect(run({ mode: "active", usageLevel: "limit100" })?.dismissible).toBe(false);
  });

  it("texto do limite com e sem excedente", () => {
    const plain = run({ usageLevel: "limit100" });
    expect(plain?.title).toBe("Você chegou a 100% da franquia do mês");
    expect(plain?.body).toContain("envios de campanha");
    expect(plain?.body).toContain("a IA passa a só sugerir respostas e a equipe envia");
    const b = run({ usageLevel: "limit100", overage: { enabled: true, capBrl: 250 } });
    expect(b?.body).toMatch(/excedente está ligado, com teto de R\$\s*250/);
    expect(run({ usageLevel: "warn80" })?.title).toBe("Você usou 80% da franquia do mês");
  });

  it("quem não administra não recebe CTA e vê a orientação", () => {
    const b = run({ mode: "read_only", readOnly: true }, { canViewBilling: false });
    expect(b?.cta).toBeNull();
    expect(b?.body).toContain("Peça a um administrador");
    expect(run({ mode: "read_only", readOnly: true })?.cta?.to).toBe("/app/configuracoes?secao=billing");
  });

  it("dispensa: teste por dia, 80% até o fim do mês, teste longo por semana", () => {
    const e = { mode: "trial" as const, trialEndsAt: NOW + 3 * DAY };
    const first = run(e);
    expect(first?.dismissKey).toBeTruthy();
    expect(run(e, { dismissed: new Set([first!.dismissKey!]) })).toBeNull();
    const nextDay = resolveBillingBanner({ ent: ent(e), now: NOW + DAY, canViewBilling: true, dismissed: new Set([first!.dismissKey!]) });
    expect(nextDay?.kind).toBe("trial_ending");

    const w = run({ usageLevel: "warn80", usageAlertMonth: "2026-11" });
    expect(w?.dismissKey).toBe("warn80:2026-11");
    expect(run({ usageLevel: "warn80", usageAlertMonth: "2026-11" }, { dismissed: new Set(["warn80:2026-11"]) })).toBeNull();
    const dec = Date.parse("2026-12-05T12:00:00Z");
    const decBanner = resolveBillingBanner({
      ent: ent({ usageLevel: "warn80", usageAlertMonth: "2026-12" }),
      now: dec,
      canViewBilling: true,
      dismissed: new Set(["warn80:2026-11"]),
    });
    expect(decBanner?.kind).toBe("warn80");

    const long = run({ mode: "trial", trialEndsAt: NOW + 20 * DAY });
    expect(run({ mode: "trial", trialEndsAt: NOW + 20 * DAY }, { dismissed: new Set([long!.dismissKey!]) })).toBeNull();
  });

  it("dispensar o aviso de 80% não esconde o de 100%", () => {
    expect(run({ usageLevel: "limit100" }, { dismissed: new Set(["warn80:2026-11"]) })?.kind).toBe("limit100");
  });
});

describe("alerta de uso de outro mês e teste vencido", () => {
  it("100% de novembro não aparece em dezembro", () => {
    const dec = Date.parse("2026-12-02T12:00:00Z");
    const stale = ent({ usageLevel: "limit100", usageAlertMonth: "2026-11" });
    expect(resolveBillingBanner({ ent: stale, now: NOW, canViewBilling: true, dismissed: none })?.kind).toBe("limit100");
    expect(resolveBillingBanner({ ent: stale, now: dec, canViewBilling: true, dismissed: none })).toBeNull();
    const noMonth: BannerEntitlements = { mode: "active", readOnly: false, usageLevel: "warn80" };
    expect(resolveBillingBanner({ ent: noMonth, now: NOW, canViewBilling: true, dismissed: none })).toBeNull();
  });

  it("teste vencido antes do cron já vira modo leitura", () => {
    const b = run({ mode: "trial", trialEndsAt: NOW - 1000 });
    expect(b?.kind).toBe("read_only");
    expect(run({ mode: "trial", trialEndsAt: NOW + DAY })?.kind).toBe("trial_ending");
  });
});

describe("dispensa em localStorage", () => {
  it("lê e grava; erro de storage não quebra", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    writeDismissed("org1", new Set(["a", "b"]), storage);
    expect([...readDismissed("org1", storage)]).toEqual(["a", "b"]);
    expect(readDismissed("org2", storage).size).toBe(0);
    mem.set("hnbcrm.billingBanner.org3", "{lixo");
    expect(readDismissed("org3", storage).size).toBe(0);
    const boom = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(readDismissed("org1", boom).size).toBe(0);
    expect(() => writeDismissed("org1", new Set(["a"]), boom)).not.toThrow();
    expect(readDismissed("org1", null).size).toBe(0);
  });
});
