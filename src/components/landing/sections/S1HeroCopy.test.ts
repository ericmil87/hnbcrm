import { describe, expect, it } from "vitest";
import { AI_PROCESSING_NOTICE } from "@/lib/onboardingChat";
import { HERO_HINT } from "./S1HeroCopy";

describe("HERO_HINT", () => {
  it("reutiliza o aviso único de IA da conversa", () => {
    expect(HERO_HINT).toContain(AI_PROCESSING_NOTICE);
    expect(AI_PROCESSING_NOTICE).toMatch(/provedores parceiros, inclusive fora do Brasil/);
  });
});
