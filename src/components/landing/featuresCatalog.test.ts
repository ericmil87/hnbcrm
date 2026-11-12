import { describe, expect, it } from "vitest";
import {
  FEATURE_AREAS,
  FEATURE_HIGHLIGHTS,
  FEATURE_ROADMAP,
  FEATURE_STATUS_LABEL,
  countFeatures,
  featureStatus,
} from "./featuresCatalog";

describe("featuresCatalog", () => {
  it("ids de área são únicos", () => {
    const ids = FEATURE_AREAS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("nenhum texto vazio nas áreas, itens, destaques e roadmap", () => {
    for (const area of FEATURE_AREAS) {
      expect(area.title.trim(), area.id).not.toBe("");
      expect(area.summary.trim(), area.id).not.toBe("");
      expect(area.items.length, area.id).toBeGreaterThan(0);
      for (const item of area.items) {
        expect(item.name.trim()).not.toBe("");
        expect(item.text.trim(), item.name).not.toBe("");
      }
    }
    for (const h of FEATURE_HIGHLIGHTS) {
      expect(h.title.trim()).not.toBe("");
      expect(h.text.trim(), h.title).not.toBe("");
    }
    for (const r of FEATURE_ROADMAP) {
      expect(r.name.trim()).not.toBe("");
      expect(r.text.trim(), r.name).not.toBe("");
    }
  });

  it("são oito destaques", () => {
    expect(FEATURE_HIGHLIGHTS).toHaveLength(8);
  });

  it("o roadmap só tem em-liberacao, em-breve e no-radar", () => {
    for (const r of FEATURE_ROADMAP) expect(["em-liberacao", "em-breve", "no-radar"]).toContain(r.status);
  });

  it("featureStatus: ausente é pronto", () => {
    expect(featureStatus({ name: "a", text: "b" })).toBe("pronto");
    expect(featureStatus({ name: "a", text: "b", status: "no-radar" })).toBe("no-radar");
  });

  it("countFeatures soma o total de itens", () => {
    const total = FEATURE_AREAS.reduce((n, a) => n + a.items.length, 0);
    const counts = countFeatures();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(total);
    expect(Object.keys(counts).sort()).toEqual(Object.keys(FEATURE_STATUS_LABEL).sort());
  });
});
