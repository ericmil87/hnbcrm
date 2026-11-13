import { describe, expect, it } from "vitest";
import {
  decidePaste,
  filesFromTransfer,
  isFileDrag,
  pastedFileName,
  type TransferLike,
} from "./composerFiles";

const NOW = new Date(2026, 10, 13, 9, 5, 7);
const png = (name = "image.png") => new File(["x"], name, { type: "image/png" });

describe("isFileDrag", () => {
  it("só é arquivo quando os tipos incluem Files", () => {
    expect(isFileDrag({ types: ["Files"] })).toBe(true);
    expect(isFileDrag({ types: ["text/plain"] })).toBe(false);
    expect(isFileDrag({ types: ["text/uri-list", "Files"] })).toBe(true);
    expect(isFileDrag(null)).toBe(false);
  });
});

describe("filesFromTransfer", () => {
  it("usa files e cai para items sem duplicar", () => {
    const a = png("a.png");
    expect(filesFromTransfer({ files: [a], items: [{ kind: "file", getAsFile: () => a }] })).toEqual([a]);
    expect(
      filesFromTransfer({
        files: [],
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => a },
        ],
      })
    ).toEqual([a]);
    expect(filesFromTransfer(undefined)).toEqual([]);
  });
});

describe("pastedFileName", () => {
  it("nomeia imagem sem nome de verdade", () => {
    expect(pastedFileName({ name: "image.png", type: "image/png" }, NOW)).toBe("imagem-colada-20261113-090507.png");
    expect(pastedFileName({ name: "", type: "image/jpeg" }, NOW)).toBe("imagem-colada-20261113-090507.jpg");
  });
  it("mantém o nome real", () => {
    expect(pastedFileName({ name: "contrato.pdf", type: "application/pdf" }, NOW)).toBe("contrato.pdf");
  });
  it("arquivo genérico não imagem", () => {
    expect(pastedFileName({ name: "", type: "application/pdf" }, NOW)).toBe("arquivo-colado-20261113-090507.pdf");
  });
});

describe("decidePaste", () => {
  it("só texto: não intercepta", () => {
    const dt: TransferLike = { files: [], getData: () => "olá" };
    expect(decidePaste(dt, NOW)).toEqual({ intercept: false });
  });
  it("captura de tela: intercepta e nomeia", () => {
    const d = decidePaste({ files: [png()], getData: () => "" }, NOW);
    expect(d.intercept).toBe(true);
    if (d.intercept) expect(d.files[0].name).toBe("imagem-colada-20261113-090507.png");
  });
  it("texto + imagem genérica (planilha): o texto vence", () => {
    expect(decidePaste({ files: [png()], getData: () => "A1\tB1" }, NOW)).toEqual({ intercept: false });
  });
  it("arquivo com nome real intercepta mesmo com texto", () => {
    const d = decidePaste({ files: [png("foto.png")], getData: () => "foto.png" }, NOW);
    expect(d.intercept).toBe(true);
    if (d.intercept) expect(d.files[0].name).toBe("foto.png");
  });
});
