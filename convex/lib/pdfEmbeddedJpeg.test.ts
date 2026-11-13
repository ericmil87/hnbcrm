import { expect, test, describe } from "vitest";
import { findFirstEmbeddedJpeg } from "./pdfEmbeddedJpeg";

const enc = (s: string) => new TextEncoder().encode(s);

describe("findFirstEmbeddedJpeg: entrada hostil", () => {
  test("muitos `stream` e nenhum `obj` (5 MB): null e rápido", () => {
    const pdf = enc("stream\n".repeat(Math.floor((5 * 1024 * 1024) / 7)));
    const t0 = performance.now();
    expect(findFirstEmbeddedJpeg(pdf, 5 * 1024 * 1024)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  test("dicionário de imagem repetido sem `endstream`: null e rápido", () => {
    const one = "1 0 obj << /Subtype /Image /Filter /DCTDecode /Width 300 /Height 300 >> stream\n";
    const pdf = enc(one.repeat(Math.floor((5 * 1024 * 1024) / one.length)));
    const t0 = performance.now();
    expect(findFirstEmbeddedJpeg(pdf, 5 * 1024 * 1024)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  test("`obj` além da janela do dicionário não vale", () => {
    const pdf = enc("1 0 obj " + "x".repeat(5000) + " /Subtype /Image stream\n");
    expect(findFirstEmbeddedJpeg(pdf, 1024 * 1024)).toBeNull();
  });
});
