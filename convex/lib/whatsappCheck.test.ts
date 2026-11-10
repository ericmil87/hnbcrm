import { describe, expect, test } from "vitest";
import { canonicalContactPatch, isAutomatedSendBlocked, markerSurvivesNumberChange, notFoundFailCount, isMarkedNotOnWhatsapp, isRecentlyVerified, maskPhone, VERIFIED_TTL_MS } from "./whatsappCheck";

const mark = (phone: string, status: "not_on_whatsapp" | "verified" = "not_on_whatsapp", checkedAt = 1000) => ({
  phone,
  status,
  checkedAt,
});

describe("isMarkedNotOnWhatsapp", () => {
  test("vale só para o número ATUAL do contato", () => {
    const c = { phone: "5531990001234", whatsappNumber: undefined, whatsappCheck: mark("5531990001234") };
    expect(isMarkedNotOnWhatsapp(c)).toBe(true);
    expect(isMarkedNotOnWhatsapp(c, "5531990001234")).toBe(true);
    // número DIFERENTE → marcador velho não vale
    expect(isMarkedNotOnWhatsapp({ ...c, phone: "5531988887777" })).toBe(false);
    // só OUTRA grafia (12 ↔ 13 dígitos): continua valendo (a checagem pergunta as duas)
    expect(isMarkedNotOnWhatsapp({ ...c, whatsappNumber: "553190001234" })).toBe(true);
    expect(isMarkedNotOnWhatsapp({ ...c, phone: "553190001234" })).toBe(true);
    // whatsappNumber manda sobre phone (é o que o dispatch lê)
    expect(isMarkedNotOnWhatsapp({ ...c, whatsappNumber: "5531988887777" })).toBe(false);
  });
  test("verified não bloqueia; sem marcador não bloqueia; destino diferente não bloqueia", () => {
    expect(isMarkedNotOnWhatsapp({ phone: "5531990001234", whatsappCheck: mark("5531990001234", "verified") })).toBe(false);
    expect(isMarkedNotOnWhatsapp({ phone: "5531990001234" })).toBe(false);
    expect(isMarkedNotOnWhatsapp(null)).toBe(false);
    expect(isMarkedNotOnWhatsapp({ phone: "5531990001234", whatsappCheck: mark("5531990001234") }, "553190001234")).toBe(true);
    expect(isMarkedNotOnWhatsapp({ phone: "5531990001234", whatsappCheck: mark("5531990001234") }, "5511987654321")).toBe(false);
  });
  test("compara só dígitos", () => {
    expect(isMarkedNotOnWhatsapp({ phone: "+55 (31) 99000-1234", whatsappCheck: mark("5531990001234") })).toBe(true);
  });
});

describe("isRecentlyVerified", () => {
  test("30 dias, para o número atual", () => {
    const c = { phone: "553190001234", whatsappCheck: mark("553190001234", "verified", 1000) };
    expect(isRecentlyVerified(c, 1000 + VERIFIED_TTL_MS - 1)).toBe(true);
    expect(isRecentlyVerified(c, 1000 + VERIFIED_TTL_MS)).toBe(false);
    expect(isRecentlyVerified({ ...c, phone: "5531990001234" }, 2000)).toBe(false);
  });
});

describe("canonicalContactPatch (regra da Nova conversa e do self-heal)", () => {
  test("grafia errada com 9 → whatsappNumber e phone passam para a canônica", () => {
    const { patch, previousPhone } = canonicalContactPatch({ phone: "5531990001234", whatsappNumber: "5531990001234" }, "553190001234");
    expect(patch).toEqual({ whatsappNumber: "553190001234", phone: "553190001234" });
    expect(previousPhone).toBe("5531990001234");
  });
  test("telefone fixo cadastrado à parte não é apagado", () => {
    const { patch } = canonicalContactPatch({ phone: "553133334444", whatsappNumber: "5531990001234" }, "553190001234");
    expect(patch).toEqual({ whatsappNumber: "553190001234" });
  });
  test("já canônico → patch vazio", () => {
    expect(canonicalContactPatch({ phone: "553190001234", whatsappNumber: "553190001234" }, "553190001234").patch).toEqual({});
  });
});

test("maskPhone mostra só os 4 últimos dígitos", () => {
  expect(maskPhone("5531990001234")).toBe("*********1234");
  expect(maskPhone("12")).toBe("****");
});

test("markerSurvivesNumberChange: not_on_whatsapp aceita outra grafia; verified é exato", () => {
  expect(markerSurvivesNumberChange(mark("5531990001234"), "553190001234")).toBe(true);
  expect(markerSurvivesNumberChange(mark("5531990001234"), "5511987654321")).toBe(false);
  expect(markerSurvivesNumberChange(mark("5531990001234", "verified"), "553190001234")).toBe(false);
  expect(markerSurvivesNumberChange(mark("5531990001234", "verified"), "5531990001234")).toBe(true);
});

test("contador de recipient_not_found: EXATO nos dígitos (um `no LID` é daquele JID) e bloqueia a partir de 2", () => {
  const c = { phone: "5531990001234", whatsappFails: { phone: "5531990001234", count: 2, at: 1 } };
  expect(notFoundFailCount(c)).toBe(2);
  expect(notFoundFailCount({ ...c, whatsappNumber: "553190001234" })).toBe(0); // outra grafia: contador não vale
  expect(notFoundFailCount({ ...c, phone: "5511987654321" })).toBe(0);
  expect(isAutomatedSendBlocked(c)).toBe(true);
  expect(isAutomatedSendBlocked({ ...c, whatsappFails: { ...c.whatsappFails, count: 1 } })).toBe(false);
});
