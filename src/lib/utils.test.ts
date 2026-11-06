import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("mantém o tamanho próprio junto da cor de texto", () => {
    expect(cn("text-caption", "text-text-muted")).toBe("text-caption text-text-muted");
    expect(cn("text-text-muted", "text-micro")).toBe("text-text-muted text-micro");
  });

  it("tamanhos próprios e padrão continuam se substituindo", () => {
    expect(cn("text-sm", "text-caption")).toBe("text-caption");
    expect(cn("text-caption", "md:text-sm", "text-base")).toBe("md:text-sm text-base");
  });

  it("sombras próprias substituem outras sombras", () => {
    expect(cn("shadow-sm", "shadow-bubble")).toBe("shadow-bubble");
  });

  it("raios próprios substituem outros raios", () => {
    expect(cn("rounded-full", "rounded-card")).toBe("rounded-card");
  });
});
