import { describe, expect, test } from "vitest";
import { normalizeCampaignPhone, isValidBrMobile, looksLikePhone, formatPhoneForDisplay, splitCountryCode } from "./phone";
import { resolveDefaultCountry, SUPPORTED_DEFAULT_COUNTRIES } from "./orgPhone";

describe("normalizeCampaignPhone (E.164 sem +)", () => {
  test("celular BR com DDI, formatação e +", () => {
    expect(normalizeCampaignPhone("+55 (11) 99999-1234")).toEqual({
      ok: true, phone: "5511999991234", country: "55", isMobile: true,
    });
  });
  test("celular BR sem DDI ganha 55", () => {
    expect(normalizeCampaignPhone("(21) 98888-7777")).toMatchObject({ ok: true, phone: "5521988887777" });
  });
  test("celular antigo de 8 dígitos ganha o 9º dígito", () => {
    expect(normalizeCampaignPhone("11 8888-7777")).toMatchObject({ ok: true, phone: "5511988887777", isMobile: true });
    expect(normalizeCampaignPhone("55 11 8888-7777")).toMatchObject({ ok: true, phone: "5511988887777" });
  });
  test("fixo BR fica com 8 dígitos e não é celular", () => {
    expect(normalizeCampaignPhone("11 3333-4444")).toMatchObject({ ok: true, phone: "551133334444", isMobile: false });
  });
  test("0 de tronco e 00 internacional são removidos", () => {
    expect(normalizeCampaignPhone("011 99999-1234")).toMatchObject({ ok: true, phone: "5511999991234" });
    expect(normalizeCampaignPhone("0055 11 99999-1234")).toMatchObject({ ok: true, phone: "5511999991234" });
  });
  test("DDD inválido é recusado", () => {
    expect(normalizeCampaignPhone("55 10 99999-1234")).toEqual({ ok: false, reason: "invalid" });
  });
  test("internacional com DDI é aceito como está", () => {
    expect(normalizeCampaignPhone("+1 555 000 0001")).toMatchObject({ ok: true, phone: "15550000001", country: "1" });
    expect(normalizeCampaignPhone("+351 912 345 678")).toMatchObject({ ok: true, phone: "351912345678" });
  });
  test("vazio / curto / longo", () => {
    expect(normalizeCampaignPhone("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeCampaignPhone("1234")).toEqual({ ok: false, reason: "too_short" });
    expect(normalizeCampaignPhone("1234567890123456")).toEqual({ ok: false, reason: "too_long" });
  });
  test("outro país default", () => {
    expect(normalizeCampaignPhone("912 345 678", "351")).toMatchObject({ ok: true, phone: "351912345678" });
  });
});

describe("helpers", () => {
  test("isValidBrMobile", () => {
    expect(isValidBrMobile("5511999991234")).toBe(true);
    expect(isValidBrMobile("551133334444")).toBe(false);
    expect(isValidBrMobile("15550000001")).toBe(false);
  });
  test("looksLikePhone", () => {
    expect(looksLikePhone("(11) 99999-1234")).toBe(true);
    expect(looksLikePhone("abc")).toBe(false);
  });
  test("formatPhoneForDisplay", () => {
    expect(formatPhoneForDisplay("5511999991234")).toBe("+55 (11) 99999-1234");
    expect(formatPhoneForDisplay("551133334444")).toBe("+55 (11) 3333-4444");
    expect(formatPhoneForDisplay("15550000001")).toBe("+1 (555) 000-0001");
  });
});

describe("DDI explícito e DDI padrão da org (v0.67)", () => {
  test("+ explícito numa org BR é respeitado e nunca vira DDD", () => {
    expect(normalizeCampaignPhone("+1 212 555 1234")).toEqual({ ok: true, phone: "12125551234", country: "1", isMobile: true });
    expect(normalizeCampaignPhone("+44 7911 123456")).toMatchObject({ ok: true, phone: "447911123456", country: "44" });
    expect(normalizeCampaignPhone("00 351 912 345 678")).toMatchObject({ ok: true, phone: "351912345678", country: "351" });
  });
  test("+1 com 2º/3º dígitos de DDD BR e 4º dígito 9 não é mutilado", () => {
    // sem o "+" seria lido como 55 12 95555-1234
    expect(normalizeCampaignPhone("+1 295 555 1234")).toMatchObject({ ok: true, phone: "12955551234", country: "1" });
    expect(normalizeCampaignPhone("+1 (219) 955-5123")).toMatchObject({ ok: true, phone: "12199555123", country: "1" });
  });
  test("padrão NANP (1)", () => {
    for (const raw of ["(212) 555-1234", "1 212 555 1234", "212 555 1234", "+1 212-555-1234"]) {
      expect(normalizeCampaignPhone(raw, "1")).toMatchObject({ ok: true, phone: "12125551234", country: "1" });
    }
    expect(normalizeCampaignPhone("112 555 1234", "1")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeCampaignPhone("555 1234", "1")).toEqual({ ok: false, reason: "too_short" });
    expect(normalizeCampaignPhone("011 44 7911 123456", "1")).toMatchObject({ ok: true, phone: "447911123456" });
  });
  test("padrão Reino Unido (44): tira o 0 de tronco; +55 segue regra BR", () => {
    expect(normalizeCampaignPhone("07911 123456", "44")).toMatchObject({ ok: true, phone: "447911123456", country: "44" });
    expect(normalizeCampaignPhone("7911 123456", "44")).toMatchObject({ ok: true, phone: "447911123456" });
    expect(normalizeCampaignPhone("+55 85 9999-8888", "44")).toMatchObject({ ok: true, phone: "5585999998888", country: "55" });
    expect(normalizeCampaignPhone("+55 10 99999-1234", "44")).toEqual({ ok: false, reason: "invalid" });
  });
  test("padrão Austrália (61)", () => {
    expect(normalizeCampaignPhone("0412 345 678", "61")).toMatchObject({ ok: true, phone: "61412345678", country: "61" });
  });
  test("E.164 vindo do WhatsApp (12+ dígitos) passa intacto qualquer que seja o padrão", () => {
    for (const cc of ["55", "1", "44", "61", "351"]) {
      expect(normalizeCampaignPhone("5585999998888", cc)).toMatchObject({ ok: true, phone: "5585999998888" });
      expect(normalizeCampaignPhone("447911123456", cc)).toMatchObject({ ok: true, phone: "447911123456" });
      expect(normalizeCampaignPhone("351912345678", cc)).toMatchObject({ ok: true, phone: "351912345678" });
    }
  });
  test("DDI desconhecido com + é inválido", () => {
    expect(normalizeCampaignPhone("+999 1234 5678")).toEqual({ ok: false, reason: "invalid" });
  });
  test("splitCountryCode", () => {
    expect(splitCountryCode("12125551234")).toEqual({ country: "1", national: "2125551234" });
    expect(splitCountryCode("79161234567")).toEqual({ country: "7", national: "9161234567" });
    expect(splitCountryCode("5585999998888")).toEqual({ country: "55", national: "85999998888" });
    expect(splitCountryCode("351912345678")).toEqual({ country: "351", national: "912345678" });
    expect(splitCountryCode("971501234567")).toEqual({ country: "971", national: "501234567" });
    expect(splitCountryCode("99912345678")).toBeNull();
    expect(splitCountryCode("")).toBeNull();
  });
  test("formatPhoneForDisplay NANP e genérico", () => {
    expect(formatPhoneForDisplay("12125551234")).toBe("+1 (212) 555-1234");
    expect(formatPhoneForDisplay("447911123456")).toBe("+44 791 112 3456");
    expect(formatPhoneForDisplay("351912345678")).toBe("+351 912 345 678");
    expect(formatPhoneForDisplay("61412345678")).toBe("+61 412 345 678");
    expect(formatPhoneForDisplay("99912345678")).toBe("+99912345678");
    expect(formatPhoneForDisplay("")).toBe("");
  });
  test("resolveDefaultCountry", () => {
    expect(resolveDefaultCountry(undefined)).toBe("55");
    expect(resolveDefaultCountry(null)).toBe("55");
    expect(resolveDefaultCountry({})).toBe("55");
    expect(resolveDefaultCountry({ defaultCountryCode: "1" })).toBe("1");
    expect(resolveDefaultCountry({ defaultCountryCode: "351" })).toBe("351");
    expect(resolveDefaultCountry({ defaultCountryCode: "999" })).toBe("55");
    expect(resolveDefaultCountry({ defaultCountryCode: "+44" })).toBe("55");
    expect(resolveDefaultCountry({ defaultCountryCode: "abc" })).toBe("55");
  });
  test("todo país do seletor tem DDI conhecido", () => {
    for (const c of SUPPORTED_DEFAULT_COUNTRIES) {
      expect(resolveDefaultCountry({ defaultCountryCode: c.dialCode })).toBe(c.dialCode);
    }
  });
});
