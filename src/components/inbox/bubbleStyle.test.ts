import { describe, expect, it } from "vitest";
import type { InboxMessage } from "./types";
import { getBubbleStyle } from "./MessageBubble";

const base = { _id: "m1", content: "oi" } as unknown as InboxMessage;

const CASES: Record<string, InboxMessage> = {
  "nota interna": { ...base, isInternal: true, direction: "outbound", senderType: "user" } as InboxMessage,
  entrada: { ...base, direction: "inbound", senderType: "contact" } as InboxMessage,
  ia: { ...base, direction: "outbound", senderType: "ai" } as InboxMessage,
  equipe: { ...base, direction: "outbound", senderType: "user" } as InboxMessage,
};

describe("getBubbleStyle", () => {
  for (const [name, message] of Object.entries(CASES)) {
    it(`${name}: usa só tokens de bolha (sem cor crua nem brand/purple)`, () => {
      const style = getBubbleStyle(message);
      for (const value of [style.bg, style.labelColor, style.footerText]) {
        expect(value).not.toMatch(/purple|brand-|text-white|semantic-warning/);
      }
    });
  }

  it("mapeia cada tipo para os valores exatos do plano", () => {
    const pick = (m: InboxMessage) => {
      const { bg, labelColor, footerText } = getBubbleStyle(m);
      return { bg, labelColor, footerText };
    };
    expect(pick(CASES["nota interna"])).toEqual({
      bg: "bg-bubble-note border border-dashed border-bubble-note-border/30 text-text-primary",
      labelColor: "text-bubble-note-label",
      footerText: "text-text-muted",
    });
    expect(pick(CASES.entrada)).toEqual({
      bg: "bg-bubble-in text-text-primary shadow-bubble",
      labelColor: "text-text-secondary",
      footerText: "text-text-muted",
    });
    expect(pick(CASES.ia)).toEqual({
      bg: "bg-bubble-ai text-bubble-out-fg shadow-bubble",
      labelColor: "text-bubble-ai-label",
      footerText: "text-bubble-out-fg/75",
    });
    expect(pick(CASES.equipe)).toEqual({
      bg: "bg-bubble-out text-bubble-out-fg shadow-bubble",
      labelColor: "text-bubble-out-label",
      footerText: "text-bubble-out-fg/75",
    });
  });

  it("rodapé de bolha de saída nunca usa /70 ou /60 (contraste AA no Claro)", () => {
    for (const key of ["ia", "equipe"]) {
      expect(getBubbleStyle(CASES[key]).footerText).toBe("text-bubble-out-fg/75");
    }
  });
});
