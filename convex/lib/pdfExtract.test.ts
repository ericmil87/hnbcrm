// @vitest-environment node
/**
 * Extrator de PDF (unpdf + pré-varredura): casos do spike P0.5 com PDFs
 * sintéticos gerados no próprio teste.
 */
import { describe, expect, it } from "vitest";
import { extractPdfText, PdfExtractError, preflightPdf, PDF_LIMITS } from "./pdfExtract";
import { bombPdf, encryptedPdf, scannedPdf, textPdf } from "./pdfTestFixtures.test-helper";

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    expect(e).toBeInstanceOf(PdfExtractError);
    return (e as PdfExtractError).code;
  }
}

const PRICE_LINES = [
  "Tabela de serviços - Salão Exemplo",
  "Corte feminino R$ 90,00 60 min",
  "Coloração e manutenção R$ 180,00 120 min",
  "Pé e mão R$ 55,00 - atenção: promoção às terças",
  "Escova progressiva R$ 250,00 (cabelos médios)",
];

describe("extractPdfText", () => {
  it("PDF normal com acentos", async () => {
    const r = await extractPdfText(new Uint8Array(textPdf([PRICE_LINES])));
    expect(r.scanned).toBe(false);
    expect(r.numPages).toBe(1);
    expect(r.pagesRead).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("Corte feminino R$ 90,00 60 min");
    expect(r.text).toContain("Coloração e manutenção");
    expect(r.text).toContain("Pé e mão R$ 55,00 - atenção: promoção às terças");
    expect(r.text).toContain("Escova progressiva R$ 250,00 (cabelos médios)");
  });

  it("não destaca o buffer do chamador", async () => {
    const bytes = new Uint8Array(textPdf([PRICE_LINES]));
    await extractPdfText(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x25); // '%'
  });

  it("PDF escaneado (só imagem) → texto vazio e scanned:true", async () => {
    const r = await extractPdfText(new Uint8Array(scannedPdf()));
    expect(r).toMatchObject({ text: "", scanned: true, numPages: 1, truncated: false });
  });

  it("PDF protegido (/Encrypt) → ENCRYPTED antes de abrir", async () => {
    expect(await codeOf(extractPdfText(new Uint8Array(encryptedPdf())))).toBe("ENCRYPTED");
  });

  it("PDF corrompido/truncado → CORRUPT (ou leitura tolerante sem lançar erro cru)", async () => {
    const full = textPdf([PRICE_LINES]);
    const truncated = new Uint8Array(full.subarray(0, 40));
    expect(["CORRUPT", "PARSE_FAILED", "OK"]).toContain(await codeOf(extractPdfText(truncated)));
    const garbage = new Uint8Array(Buffer.from("%PDF-1.7\n" + "lixo ".repeat(200), "latin1"));
    expect(["CORRUPT", "PARSE_FAILED"]).toContain(await codeOf(extractPdfText(garbage)));
  });

  it("não é PDF / vazio / grande demais", async () => {
    expect(await codeOf(extractPdfText(new Uint8Array(Buffer.from("<html>oi</html>"))))).toBe("NOT_PDF");
    expect(await codeOf(extractPdfText(new Uint8Array(0)))).toBe("EMPTY");
    expect(await codeOf(extractPdfText(new Uint8Array(PDF_LIMITS.maxBytes + 1)))).toBe("TOO_LARGE");
  });

  it("bomba de descompressão é recusada rápido (sem chegar ao pdf.js)", async () => {
    const bomb = new Uint8Array(bombPdf(40)); // ~40 KB que viram 40 MB
    expect(bomb.byteLength).toBeLessThan(200_000);
    const t0 = Date.now();
    expect(await codeOf(extractPdfText(bomb))).toBe("TOO_BIG_EXPANSION");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("soma de streams acima do teto total também é recusada", () => {
    const pdf = new Uint8Array(bombPdf(3));
    expect(() => preflightPdf(pdf, { maxStreamOutBytes: 4 * 1024 * 1024, maxTotalInflateBytes: 2 * 1024 * 1024 })).toThrow(
      PdfExtractError
    );
    expect(() => preflightPdf(pdf, { maxStreamOutBytes: 4 * 1024 * 1024, maxTotalInflateBytes: 8 * 1024 * 1024 })).not.toThrow();
  });

  it("muitas páginas: lê só as 40 primeiras e marca truncated", async () => {
    const pages = Array.from({ length: 60 }, (_, i) => [`Página ${i + 1}: serviço número ${i + 1} por R$ ${i + 10},00`]);
    const r = await extractPdfText(new Uint8Array(textPdf(pages)));
    expect(r.numPages).toBe(60);
    expect(r.pagesRead).toBe(40);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("Página 40:");
    expect(r.text).not.toContain("Página 41:");
  });

  it("acima de 300 páginas declaradas → TOO_MANY_PAGES", async () => {
    const pages = Array.from({ length: 301 }, () => ["x"]);
    const pdf = new Uint8Array(textPdf(pages, { shareContent: true }));
    expect(await codeOf(extractPdfText(pdf))).toBe("TOO_MANY_PAGES");
  });

  it("limite de caracteres corta o texto", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => Array.from({ length: 40 }, () => `Linha da página ${i + 1} com preço R$ 10,00`));
    const r = await extractPdfText(new Uint8Array(textPdf(pages)), { maxChars: 2000 });
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(r.truncated).toBe(true);
    expect(r.pagesRead).toBeLessThan(10);
  });

  it("prazo checado por página → TIMEOUT", async () => {
    const pages = Array.from({ length: 30 }, (_, i) => [`Página ${i}`]);
    expect(await codeOf(extractPdfText(new Uint8Array(textPdf(pages)), { timeoutMs: 0 }))).toBe("TIMEOUT");
  });
});
