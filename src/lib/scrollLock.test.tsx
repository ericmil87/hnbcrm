import { describe, expect, it } from "vitest";
import { lockBodyScroll } from "./scrollLock";

describe("lockBodyScroll", () => {
  it("só restaura quando a última camada libera, em qualquer ordem", () => {
    document.body.style.overflow = "";
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    expect(document.body.style.overflow).toBe("hidden");
    a();
    expect(document.body.style.overflow).toBe("hidden");
    b();
    expect(document.body.style.overflow).toBe("");
  });

  it("liberar duas vezes não desbalanceia o contador", () => {
    const a = lockBodyScroll();
    const b = lockBodyScroll();
    a();
    a();
    expect(document.body.style.overflow).toBe("hidden");
    b();
    expect(document.body.style.overflow).toBe("");
  });
});
