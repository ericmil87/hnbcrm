import { describe, expect, it } from "vitest";
import {
  attributionDetail,
  attributionSourceMeta,
  contactKindLabel,
  formatStayRange,
  hexAlpha,
  nightsBetween,
  shortId,
  transferTarget,
} from "./centralMeta";

describe("centralMeta", () => {
  it("rotula o tipo de contato, com 'lead' como padrão", () => {
    expect(contactKindLabel("supplier")).toBe("Fornecedor");
    expect(contactKindLabel(undefined)).toBe("Lead de reserva");
  });

  it("conhece as origens e cai num genérico para as desconhecidas", () => {
    expect(attributionSourceMeta("meta_ads").phrase).toBe("Veio do anúncio Meta");
    expect(attributionSourceMeta("tiktok_ads").label).toBe("tiktok ads");
  });

  it("escolhe o detalhe mais humano da atribuição", () => {
    expect(
      attributionDetail({ source: "meta_ads", adHeadline: "Natal Luz", campaignName: "c1" })
    ).toBe("Natal Luz");
    expect(attributionDetail({ source: "google_ads", utmTerm: "pousada gramado" })).toBe(
      "pousada gramado"
    );
    expect(attributionDetail({ source: "organico" })).toBeNull();
  });

  it("resume ids longos", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("ARAkLiQ1234567890zzzz")).toBe("ARAkLi…zzzz");
  });

  it("formata o período da estadia", () => {
    expect(formatStayRange("2026-10-12", "2026-10-15")).toBe("12–15/out");
    expect(formatStayRange("2026-10-28", "2026-11-02")).toBe("28/out–02/nov");
    expect(formatStayRange("2026-10-12", undefined)).toBe("12/out");
    expect(formatStayRange("12/10/2026", undefined)).toBeNull();
    expect(nightsBetween("2026-10-12", "2026-10-15")).toBe(3);
    expect(nightsBetween("2026-10-15", "2026-10-12")).toBeNull();
  });

  it("descreve o destino da transferência", () => {
    expect(transferTarget({ toDept: { name: "Financeiro" }, toMember: { name: "Camila" } })).toBe(
      "Financeiro · Camila"
    );
    expect(transferTarget({})).toBe("outro responsável");
  });

  it("converte hex em rgba", () => {
    expect(hexAlpha("#ff6b00", 0.15)).toBe("rgba(255, 107, 0, 0.15)");
    expect(hexAlpha("red", 0.1)).toBeUndefined();
  });
});
