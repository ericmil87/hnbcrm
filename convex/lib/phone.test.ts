import { describe, expect, test } from "vitest";
import { normalizeCampaignPhone, isValidBrMobile, looksLikePhone, formatPhoneForDisplay } from "./phone";

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
    expect(normalizeCampaignPhone("+1 555 000 0001")).toMatchObject({ ok: true, phone: "15550000001", country: "15" });
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
    expect(formatPhoneForDisplay("15550000001")).toBe("+15550000001");
  });
});
