import { describe, expect, it } from "vitest";
import { translationCaption } from "./translationCaption";
import { translationView } from "./translationRules";

const ctx = { conversationActive: true, now: 10_000 };
const base = { direction: "inbound", senderType: "contact", isInternal: false, createdAt: 9_000 };
const view = (over: Record<string, unknown>) => {
  const v = translationView({ ...base, ...over } as Parameters<typeof translationView>[0], ctx);
  if (v.kind !== "translated") throw new Error("esperava tradução");
  return v;
};

describe("translationCaption", () => {
  const inbound = view({
    content: "Hello",
    translatedText: "Olá",
    metadata: { translation: { status: "done", role: "inbound", sourceLang: "en", targetLang: "pt-BR", at: 1 } },
  });
  const outbound = (edited?: boolean) =>
    view({
      direction: "outbound",
      senderType: "user",
      content: "Hello",
      translatedText: "Olá",
      metadata: { translation: { status: "done", role: "outbound", sourceLang: "pt-BR", targetLang: "en", at: 1, edited } },
    });

  it("recebida: 'Traduzido do inglês · Ver original' e volta", () => {
    expect(translationCaption(inbound, { showingSecondary: false, showBoth: false })).toEqual({
      label: "Traduzido do inglês",
      action: "Ver original",
    });
    expect(translationCaption(inbound, { showingSecondary: true, showBoth: false })).toEqual({
      label: "Original em inglês",
      action: "Ver tradução",
    });
  });

  it("enviada: 'Enviado em inglês · Ver o que você escreveu'; edição aparece", () => {
    expect(translationCaption(outbound(), { showingSecondary: false, showBoth: false })).toEqual({
      label: "Enviado em inglês",
      action: "Ver o que você escreveu",
    });
    expect(translationCaption(outbound(true), { showingSecondary: false, showBoth: false }).label).toBe(
      "Enviado em inglês · tradução editada"
    );
    expect(translationCaption(outbound(), { showingSecondary: true, showBoth: false }).action).toBe("Ver o que foi enviado");
  });

  it("mostrar os dois: sem ação", () => {
    expect(translationCaption(inbound, { showingSecondary: true, showBoth: true })).toEqual({
      label: "Traduzido do inglês",
      action: null,
    });
  });
});
