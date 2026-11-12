import { describe, expect, it } from "vitest";
import { canSubmitOrganization, needsTermsAcceptance } from "./termsAcceptance";

describe("termsAcceptance", () => {
  it("pede aceite só quando há sessão e a versão difere", () => {
    expect(needsTermsAcceptance(undefined)).toBe(false);
    expect(needsTermsAcceptance(null)).toBe(false);
    expect(needsTermsAcceptance({ currentVersion: "2026-11-10", acceptedVersion: null })).toBe(true);
    expect(needsTermsAcceptance({ currentVersion: "2026-11-10", acceptedVersion: "2026-01-01" })).toBe(true);
    expect(needsTermsAcceptance({ currentVersion: "2026-11-10", acceptedVersion: "2026-11-10" })).toBe(false);
  });
  it("criar organização exige a caixa marcada", () => {
    expect(canSubmitOrganization({ name: "Acme", accepted: false })).toBe(false);
    expect(canSubmitOrganization({ name: "Acme", accepted: true })).toBe(true);
    expect(canSubmitOrganization({ name: " ", accepted: true })).toBe(false);
  });
});
