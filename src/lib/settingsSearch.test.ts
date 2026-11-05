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
});
