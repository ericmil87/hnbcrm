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

  it("mapeia cada tipo para os tokens do tema", () => {
    expect(getBubbleStyle(CASES["nota interna"]).bg).toContain("bg-bubble-note");
    expect(getBubbleStyle(CASES.entrada).bg).toContain("bg-bubble-in");
    expect(getBubbleStyle(CASES.ia).bg).toContain("bg-bubble-ai");
    expect(getBubbleStyle(CASES.equipe).bg).toContain("bg-bubble-out");
  });

  it("rodapé de bolha de saída nunca usa /70 ou /60 (contraste AA no Claro)", () => {
    for (const key of ["ia", "equipe"]) {
      expect(getBubbleStyle(CASES[key]).footerText).toBe("text-bubble-out-fg/75");
    }
  });
});
