import { describe, expect, it } from "vitest";
import { resolveListPreview } from "./listPreview";

describe("resolveListPreview", () => {
  it("digitando vence rascunho e mensagem", () => {
    expect(resolveListPreview({ contactTyping: true, draft: "oi", isOpen: false })).toEqual({ kind: "typing" });
  });
  it("rascunho vence a última mensagem e vira uma linha", () => {
    expect(resolveListPreview({ contactTyping: false, draft: "olá\n  tudo bem?", isOpen: false })).toEqual({
      kind: "draft",
      text: "olá tudo bem?",
    });
  });
  it("conversa aberta não mostra rascunho", () => {
    expect(resolveListPreview({ contactTyping: false, draft: "oi", isOpen: true })).toEqual({ kind: "message" });
  });
  it("rascunho vazio ou só espaços cai na mensagem", () => {
    expect(resolveListPreview({ contactTyping: false, draft: "  ", isOpen: false })).toEqual({ kind: "message" });
    expect(resolveListPreview({ contactTyping: false, draft: undefined, isOpen: false })).toEqual({ kind: "message" });
  });
  it("conversa aberta ainda mostra digitando", () => {
    expect(resolveListPreview({ contactTyping: true, draft: null, isOpen: true })).toEqual({ kind: "typing" });
  });
});
