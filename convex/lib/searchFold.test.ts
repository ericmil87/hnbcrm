import { describe, expect, it } from "vitest";
import { findFolded, foldForSearch, foldWithMap } from "./searchFold";
import { buildSearchText } from "./searchText";
import { MESSAGE_SEARCH_MAX_CHARS, messageSearchNorm, withMessageSearchPatch } from "./messageSearch";
import { matchesIdentity } from "./contactSearchRank";

describe("foldForSearch", () => {
  it("tira acento e põe em minúsculas", () => {
    expect(foldForSearch("Antônio")).toBe("antonio");
    expect(foldForSearch("Rebouças")).toBe("reboucas");
    expect(foldForSearch("AÇÃO")).toBe("acao");
    expect(foldForSearch("São João")).toBe("sao joao");
    expect(foldForSearch("Über ñandú")).toBe("uber nandu");
  });
  it("emoji, números e pontuação ficam como estão; vazio é vazio", () => {
    expect(foldForSearch("Oi 👋 R$ 1.500,00!")).toBe("oi 👋 r$ 1.500,00!");
    expect(foldForSearch("")).toBe("");
  });
  it("acento já decomposto (NFD na origem) também sai", () => {
    expect(foldForSearch("Antônio")).toBe("antonio");
  });
});

describe("foldWithMap / findFolded", () => {
  it("mapa aponta para o texto original", () => {
    const { folded, map } = foldWithMap("Ação");
    expect(folded).toBe("acao");
    expect(map).toEqual([0, 1, 2, 3]);
  });
  it("acha sem acento e devolve o trecho original acentuado", () => {
    const text = "Mora na Rua Rebouças, 12";
    const hit = findFolded(text, "reboucas");
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe("Rebouças");
    const hit2 = findFolded("Falei com o ANTÔNIO ontem", "antônio");
    expect("Falei com o ANTÔNIO ontem".slice(hit2!.start, hit2!.end)).toBe("ANTÔNIO");
  });
  it("com emoji antes (par substituto) o índice continua certo", () => {
    const text = "👋 olá, João";
    const hit = findFolded(text, "joao")!;
    expect(text.slice(hit.start, hit.end)).toBe("João");
  });
  it("acento combinante solto no fim entra no trecho", () => {
    const text = "Antônio José";
    const hit = findFolded(text, "jose")!;
    expect(text.slice(hit.start, hit.end)).toBe("José");
  });
  it("sem match ou termo vazio = null", () => {
    expect(findFolded("abc", "xyz")).toBeNull();
    expect(findFolded("abc", "  ")).toBeNull();
  });
});

describe("buildSearchText (contatos) grava dobrado", () => {
  it("nome, cidade e @ do Instagram", () => {
    expect(
      buildSearchText({ firstName: "Antônio", lastName: "Rebouças", city: "São Paulo", instagramUsername: "toni" })
    ).toBe("antonio reboucas sao paulo toni");
  });
  it("matchesIdentity compara sem acento dos dois lados", () => {
    expect(matchesIdentity({ firstName: "Antônio" }, "ANTONIO")).toBe(true);
    expect(matchesIdentity({ firstName: "Antonio" }, "antônio")).toBe(true);
  });
});

describe("messageSearchNorm", () => {
  it("junta conteúdo, transcrição e leitura da imagem, dobrados", () => {
    expect(
      messageSearchNorm({ content: "[áudio]", transcriptText: "Rua Rebouças", imageDescription: "Comprovante PIX" })
    ).toBe("[audio] rua reboucas comprovante pix");
  });
  it("sem texto = undefined; texto longo é cortado no teto", () => {
    expect(messageSearchNorm({ content: "  " })).toBeUndefined();
    expect(messageSearchNorm({ content: "a".repeat(MESSAGE_SEARCH_MAX_CHARS + 50) })!.length).toBe(
      MESSAGE_SEARCH_MAX_CHARS
    );
  });
  it("patch recalcula sobre o estado final, e chave undefined apaga o campo", () => {
    const current = { content: "[imagem]", imageDescription: "Recibo errado" };
    expect(withMessageSearchPatch(current, { imageDescription: undefined }).searchNorm).toBe("[imagem]");
    expect(withMessageSearchPatch(current, { content: "Edição" }).searchNorm).toBe("edicao recibo errado");
  });
});
