import { describe, expect, it } from "vitest";
import { SETTINGS_PANELS } from "@/components/settings/registry";
import { normalizeSearch, searchSettingsPanels } from "./settingsSearch";

const ids = (q: string) => searchSettingsPanels(SETTINGS_PANELS, q).map((p) => p.id);

describe("searchSettingsPanels", () => {
  it("normaliza acento e caixa", () => {
    expect(normalizeSearch("  Transcrição ")).toBe("transcricao");
  });

  it('"transcrição" encontra o painel de canais (com ou sem acento)', () => {
    expect(ids("transcrição")).toContain("channels");
    expect(ids("TRANSCRICAO")).toContain("channels");
  });

  it('"qr code" e "número" encontram canais', () => {
    expect(ids("qr code")).toContain("channels");
    expect(ids("numero")).toContain("channels");
  });

  it("casa por rótulo e por descrição", () => {
    expect(ids("dados da empresa")).toEqual(["general"]);
    expect(ids("fuso")).toContain("general");
  });

  it('"tema" e "escuro" encontram Aparência', () => {
    expect(ids("tema")).toContain("appearance");
    expect(ids("escuro")).toContain("appearance");
  });

  it("busca vazia devolve tudo; sem resultado devolve vazio", () => {
    expect(ids("  ")).toHaveLength(SETTINGS_PANELS.length);
    expect(ids("zzzxxx")).toEqual([]);
  });

  it("todas as palavras precisam casar", () => {
    expect(ids("chaves webhook")).toEqual([]);
    expect(ids("chaves integração")).toContain("apikeys");
  });

  it('"transcrição" acha Recursos da IA e canais; "imagem" só os recursos', () => {
    expect(ids("transcrição")).toEqual(expect.arrayContaining(["ai-features", "channels"]));
    expect(ids("imagem")).toContain("ai-features");
  });

  it('"persona" e "horário" acham Jeito de atender', () => {
    expect(ids("persona")).toContain("ai-attendant");
    expect(ids("horário")).toContain("ai-attendant");
  });

  it("os painéis do Atendente IA estão registrados", () => {
    for (const id of ["ai", "ai-attendant", "ai-conversation", "ai-handoff", "ai-followup", "ai-features", "ai-usage", "ai-models"]) {
      expect(ids("")).toContain(id);
    }
  });
});

describe("busca do painel billing", () => {
  it("acha por fatura, plano e excedente", () => {
    const billing = SETTINGS_PANELS.filter((p) => p.id === "billing");
    for (const q of ["fatura", "plano", "excedente", "Uso e fatura"]) {
      expect(searchSettingsPanels(billing, q).map((p) => p.id)).toEqual(["billing"]);
    }
  });
});
