import { describe, expect, it } from "vitest";
import { parseAdSpendCsv, parseCsvAmount, parseCsvDate, parsePlatform } from "./adSpendCsv";
import { campaignLabel, formatDuration, formatPct, formatRoas, lastNDays, shiftDate } from "./centralFormat";

const units = [
  { _id: "u1", name: "Pousada Vale Encantado", shortName: "Vale" },
  { _id: "u2", name: "Hotel Serra Alta" },
];

describe("parseCsvDate", () => {
  it("aceita ISO e dd/mm/aaaa", () => {
    expect(parseCsvDate("2026-09-01")).toBe("2026-09-01");
    expect(parseCsvDate("01/09/2026")).toBe("2026-09-01");
    expect(parseCsvDate("1/9/26")).toBe("2026-09-01");
  });
  it("recusa data impossível", () => {
    expect(parseCsvDate("31/02/2026")).toBeNull();
    expect(parseCsvDate("data")).toBeNull();
  });
});

describe("parseCsvAmount", () => {
  it("entende pt-BR e en-US", () => {
    expect(parseCsvAmount("R$ 1.234,56")).toBe(1234.56);
    expect(parseCsvAmount("1234,5")).toBe(1234.5);
    expect(parseCsvAmount("1,234.56")).toBe(1234.56);
    expect(parseCsvAmount("1234.56")).toBe(1234.56);
    expect(parseCsvAmount("1.234")).toBe(1234);
    expect(parseCsvAmount("abc")).toBeNull();
  });
});

describe("parsePlatform", () => {
  it("normaliza as plataformas", () => {
    expect(parsePlatform("Facebook")).toBe("meta");
    expect(parsePlatform("Google Ads")).toBe("google");
    expect(parsePlatform("TikTok")).toBe("other");
  });
});

describe("parseAdSpendCsv", () => {
  it("pula cabeçalho, casa unidade por nome curto sem acento e acusa erros por linha", () => {
    const csv = [
      "data;plataforma;campanha;unidade;valor",
      "01/09/2026;meta;Primavera Serra;vale;150,00",
      "2026-09-02;google;Busca marca;;80",
      "03/09/2026;meta;Primavera Serra;Hotel Inexistente;10",
      "04/09/2026;meta;;Vale;10",
      "xx;meta;Camp;Vale;10",
    ].join("\n");
    const result = parseAdSpendCsv(csv, units);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ date: "2026-09-01", platform: "meta", unitId: "u1", amount: 150 });
    expect(result.rows[1]).toMatchObject({ date: "2026-09-02", platform: "google", amount: 80 });
    expect(result.rows[1].unitId).toBeUndefined();
    expect(result.errors.map((e) => e.line)).toEqual([4, 5, 6]);
  });
});

describe("centralFormat", () => {
  it("formata duração, porcentagem e ROAS", () => {
    expect(formatDuration(42)).toBe("42 s");
    expect(formatDuration(180)).toBe("3 min");
    expect(formatDuration(4800)).toBe("1 h 20 min");
    expect(formatDuration(null)).toBe("—");
    expect(formatPct(0.234)).toBe("23,4%");
    expect(formatRoas(4.25)).toBe("4,3×");
    expect(formatRoas(null)).toBe("—");
  });
  it("não repete a origem no rótulo da campanha", () => {
    expect(campaignLabel("google_ads", "Google Ads — pousada gramado centro")).toBe("Google Ads · pousada gramado centro");
    expect(campaignLabel("meta_ads", "meta ads: Primavera")).toBe("Meta Ads · Primavera");
    expect(campaignLabel("meta_ads", "Primavera Serra")).toBe("Meta Ads · Primavera Serra");
    expect(campaignLabel("organico")).toBe("Orgânico");
    expect(campaignLabel("google_ads", "Google Ads")).toBe("Google Ads");
    expect(campaignLabel("indicacao", "Indicação de hóspede/amigo")).toBe("Indicação de hóspede/amigo");
  });
  it("calcula períodos por calendário", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(lastNDays(7, "2026-09-28")).toEqual({ from: "2026-09-22", to: "2026-09-28" });
  });
});
