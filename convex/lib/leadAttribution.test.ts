import { describe, expect, test } from "vitest";
import {
  attributionFromReferral,
  buildAttributionFromInput,
  mergeFirstTouch,
  sanitizeAttributionInput,
} from "./leadAttribution";
import { normalizeCampaignKey } from "./orgModules";

const NOW = 1_780_000_000_000;

describe("sanitizeAttributionInput", () => {
  test("aceita snake_case plano, faz trim e descarta vazio/não-string", () => {
    const { input, truncated } = sanitizeAttributionInput({
      utm_source: "  google ",
      utm_medium: "cpc",
      utm_campaign: "",
      utm_term: 42,
      gclid: "abc123",
      fbclid: "   ",
    });
    expect(input).toEqual({ utmSource: "google", utmMedium: "cpc", gclid: "abc123" });
    expect(truncated).toEqual([]);
  });

  test("aceita objeto attribution em camelCase; chaves planas vencem", () => {
    const { input } = sanitizeAttributionInput({
      utm_source: "flat",
      attribution: { utmSource: "nested", utmMedium: "email", landingUrl: "https://x.com/lp" },
    });
    expect(input).toEqual({ utmSource: "flat", utmMedium: "email", landingUrl: "https://x.com/lp" });
  });

  test("corta texto em 200 e URL em 2048, registrando os campos", () => {
    const { input, truncated } = sanitizeAttributionInput({
      utm_campaign: "a".repeat(250),
      landingUrl: "https://x.com/" + "b".repeat(3000),
      gclid: "g".repeat(200),
    });
    expect(input.utmCampaign).toHaveLength(200);
    expect(input.landingUrl).toHaveLength(2048);
    expect(input.gclid).toHaveLength(200);
    expect(truncated.sort()).toEqual(["landingUrl", "utmCampaign"]);
  });

  test("landingUrl/referrer guardam só origin + pathname; inválida é descartada", () => {
    const { input } = sanitizeAttributionInput({
      landingUrl: "https://site.com/lp?email=a@b.com&utm_source=x#frag",
      referrer: "não é url",
    });
    expect(input.landingUrl).toBe("https://site.com/lp");
    expect(input.referrer).toBeUndefined();
  });

  test("entrada que não é objeto devolve vazio", () => {
    expect(sanitizeAttributionInput(null).input).toEqual({});
    expect(sanitizeAttributionInput("x").input).toEqual({});
  });
});

describe("buildAttributionFromInput", () => {
  test("sem sinal de mídia não cria atribuição (URL sozinha não conta)", () => {
    expect(buildAttributionFromInput({}, NOW)).toBeNull();
    expect(buildAttributionFromInput({ referrer: "https://google.com" }, NOW)).toBeNull();
  });

  test("campaignKey usa o MESMO normalizeCampaignKey do adSpend", () => {
    const a = buildAttributionFromInput({ utmCampaign: "Réveillon 2026 — Promo!" }, NOW)!;
    expect(a.campaignKey).toBe(normalizeCampaignKey("Réveillon 2026 — Promo!"));
    expect(a.campaignName).toBe("Réveillon 2026 — Promo!");
  });

  test("deriva source: gclid → google_ads, fbclid → meta_ads, utm_source, site", () => {
    expect(buildAttributionFromInput({ gclid: "x" }, NOW)!.source).toBe("google_ads");
    expect(buildAttributionFromInput({ fbclid: "x" }, NOW)!.source).toBe("meta_ads");
    // fbclid vence utm_source=instagram (anúncio pago no Instagram).
    expect(buildAttributionFromInput({ utmSource: "Instagram", fbclid: "x" }, NOW)!.source).toBe("meta_ads");
    expect(buildAttributionFromInput({ utmSource: "Instagram" }, NOW)!.source).toBe("instagram");
    // utm_source pago sem click id casa com o gasto via aliases.
    expect(buildAttributionFromInput({ utmSource: "Google", utmMedium: "CPC" }, NOW)!.source).toBe("google_ads");
    expect(buildAttributionFromInput({ utmSource: "fb", utmMedium: "paid_social" }, NOW)!.source).toBe("meta_ads");
    expect(buildAttributionFromInput({ utmSource: "ig", utmMedium: "paid-social" }, NOW)!.source).toBe("meta_ads");
    expect(buildAttributionFromInput({ utmSource: "google", utmMedium: "organic" }, NOW)!.source).toBe("google");
    expect(buildAttributionFromInput({ utmSource: "Newsletter" }, NOW)!.source).toBe("newsletter");
    expect(buildAttributionFromInput({ trackingCode: "T1" }, NOW)!.source).toBe("site");
  });
});

describe("mergeFirstTouch", () => {
  const incoming = buildAttributionFromInput(
    { utmSource: "google", utmCampaign: "Verão", gclid: "G2", landingUrl: "https://x.com" },
    NOW + 1000
  )!;

  test("sem existente grava o novo", () => {
    expect(mergeFirstTouch(undefined, incoming)).toEqual({ merged: incoming, changed: true });
  });

  test("nunca sobrescreve; só preenche vazios", () => {
    const existing = { source: "meta_ads", capturedAt: NOW, gclid: "G1", utmSource: "facebook" };
    const { merged, changed } = mergeFirstTouch(existing, incoming);
    expect(changed).toBe(true);
    expect(merged).toMatchObject({
      source: "meta_ads",
      capturedAt: NOW,
      gclid: "G1",
      utmSource: "facebook",
      utmCampaign: "Verão",
      campaignKey: "verao",
      landingUrl: "https://x.com",
    });
  });

  test("nada novo a preencher → changed false", () => {
    const { changed, merged } = mergeFirstTouch(incoming, incoming);
    expect(changed).toBe(false);
    expect(merged).toEqual(incoming);
  });

  test("incoming nulo mantém o existente", () => {
    const existing = { source: "site", capturedAt: NOW };
    expect(mergeFirstTouch(existing, null)).toEqual({ merged: existing, changed: false });
  });
});

describe("attributionFromReferral (CTWA, sem regressão)", () => {
  test("mantém o shape da v0.63", () => {
    const a = attributionFromReferral(
      { sourceType: "ad", sourceId: "123", headline: "Promo Verão", sourceUrl: "https://fb.com/ad", ctwaClid: "CLID" },
      NOW
    );
    expect(a).toEqual({
      source: "meta_ads",
      capturedAt: NOW,
      adId: "123",
      adHeadline: "Promo Verão",
      campaignName: "Promo Verão",
      campaignKey: "promo-verao",
      adSourceUrl: "https://fb.com/ad",
      ctwaClid: "CLID",
    });
  });
});
