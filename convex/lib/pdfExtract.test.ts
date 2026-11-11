// @vitest-environment node
/**
 * Extrator de PDF (unpdf + pré-varredura): casos do spike P0.5 com PDFs
 * sintéticos gerados no próprio teste.
 */
import { describe, expect, it } from "vitest";
import {
  decodeAscii85,
  decodeAsciiHex,
  extractPdfText,
  inflateLikePdfJs,
  parseFilterChains,
  PdfExtractError,
  preflightPdf,
  PDF_LIMITS,
} from "./pdfExtract";
import {
  ascii85,
  bombPdf,
  encryptedPdf,
  flateTextPdf,
  pdfWithContentStream,
  scannedPdf,
  stream,
  textPdf,
  zlibBomb,
  zlibBombCmf68,
  zlibBombWithFakeEndstream,
} from "./pdfTestFixtures.test-helper";

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

  it("prazo checado por página → TIMEOUT (inline)", async () => {
    const pages = Array.from({ length: 30 }, (_, i) => [`Página ${i}`]);
    expect(await codeOf(extractPdfText(new Uint8Array(textPdf(pages)), { timeoutMs: 0, isolation: "inline" }))).toBe("TIMEOUT");
  });

  it("PDF com conteúdo Flate (normal) continua sendo lido", async () => {
    const r = await extractPdfText(new Uint8Array(flateTextPdf(PRICE_LINES)));
    expect(r.scanned).toBe(false);
    expect(r.text).toContain("Corte feminino R$ 90,00 60 min");
  });
});

describe("worker_threads com terminate no prazo (D4)", () => {
  it("o pdf.js roda no worker por padrão; inline continua disponível", async () => {
    const bytes = new Uint8Array(textPdf([PRICE_LINES]));
    const w = await extractPdfText(bytes);
    expect(w.isolation).toBe("worker");
    const i = await extractPdfText(bytes, { isolation: "inline" });
    expect(i.isolation).toBe("inline");
    expect(i.text).toBe(w.text);
  });

  it("prazo estourado no worker → TIMEOUT (thread terminada)", async () => {
    const pages = Array.from({ length: 60 }, (_, k) => [`Página ${k}`]);
    const t0 = Date.now();
    expect(await codeOf(extractPdfText(new Uint8Array(textPdf(pages)), { timeoutMs: 5 }))).toBe("TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("erros do pdf.js no worker mantêm o código tipado", async () => {
    const pages = Array.from({ length: 301 }, () => ["x"]);
    expect(await codeOf(extractPdfText(new Uint8Array(textPdf(pages, { shareContent: true }))))).toBe("TOO_MANY_PAGES");
  });
});

describe("pré-varredura anti-bomba — contornos da revisão (B1)", () => {
  const MB = 40; // > 16 MB por stream

  it("(a) cabeçalho zlib com CMF 0x68 (aceito pelo pdf.js) → recusado", async () => {
    const pdf = pdfWithContentStream(zlibBombCmf68(MB), "/Filter /FlateDecode");
    expect(await codeOf(extractPdfText(new Uint8Array(pdf)))).toBe("TOO_BIG_EXPANSION");
  });

  it("(b) cadeia [/ASCIIHexDecode /FlateDecode] → recusada", async () => {
    const hex = Buffer.from(zlibBomb(MB).toString("hex") + ">", "latin1");
    const pdf = pdfWithContentStream(hex, "/Filter [/ASCIIHexDecode /FlateDecode]");
    expect(await codeOf(extractPdfText(new Uint8Array(pdf)))).toBe("TOO_BIG_EXPANSION");
  });

  it("(b) cadeia [/A85 /Fl] (abreviada) → recusada", async () => {
    const a85 = Buffer.from(ascii85(zlibBomb(MB)), "latin1");
    const pdf = pdfWithContentStream(a85, "/Filter [/A85 /Fl]");
    expect(await codeOf(extractPdfText(new Uint8Array(pdf)))).toBe("TOO_BIG_EXPANSION");
  });

  it("(c) `endstream` literal cedo no dado não encurta a checagem (/Length direto)", async () => {
    const data = zlibBombWithFakeEndstream(MB);
    expect(data.indexOf("endstream")).toBeLessThan(40);
    const pdf = pdfWithContentStream(data, "/Filter /FlateDecode");
    expect(await codeOf(extractPdfText(new Uint8Array(pdf)))).toBe("TOO_BIG_EXPANSION");
  });

  it("(c) /Length indireto não resolvível + `endstream` falso → checa até o fim do arquivo", async () => {
    const data = zlibBombWithFakeEndstream(MB);
    const pdf = pdfWithContentStream(data, "/Length 99 0 R /Filter /FlateDecode", [], false);
    expect(await codeOf(extractPdfText(new Uint8Array(pdf)))).toBe("TOO_BIG_EXPANSION");
  });

  it("/Filter indireto é resolvido", async () => {
    const pdf = pdfWithContentStream(zlibBomb(MB), "/Filter 5 0 R", ["/FlateDecode"]);
    expect(await codeOf(extractPdfText(new Uint8Array(pdf)))).toBe("TOO_BIG_EXPANSION");
  });

  it("(d) soma acima de 48 MB em streams de 12 MB cada → recusada", () => {
    const parts = [1, 2, 3, 4, 5].map(() => zlibBomb(12));
    const extra = parts.map((z) => stream("/Filter /FlateDecode", z));
    const pdf = new Uint8Array(textPdf([["Folheto"]], { extra }));
    expect(() => preflightPdf(pdf, PDF_LIMITS)).toThrow(PdfExtractError);
    const four = new Uint8Array(textPdf([["Folheto"]], { extra: extra.slice(0, 3) }));
    expect(() => preflightPdf(four, PDF_LIMITS)).not.toThrow();
  });

  it.each([["/LZWDecode"], ["/RunLengthDecode"], ["/LZW"], ["/RL"], ["/Crypt"], ["/QualquerCoisa"], ["[/DCTDecode /FlateDecode]"]])(
    "filtro %s → UNSUPPORTED_FILTER",
    async (filter) => {
      const pdf = pdfWithContentStream(Buffer.from("abc"), `/Filter ${filter}`);
      expect(await codeOf(extractPdfText(new Uint8Array(pdf)))).toBe("UNSUPPORTED_FILTER");
    }
  );

  it("cabeçalho zlib inválido para o pdf.js não é inflado (pdf.js também não expande)", () => {
    const d = Buffer.from(zlibBomb(MB));
    d[0] = 0x79; // método 9: pdf.js recusa
    expect(inflateLikePdfJs(new Uint8Array(d), 1024)).toBeNull();
  });
});

describe("decodificadores ASCII", () => {
  it("ASCIIHex e ASCII85", () => {
    expect(Buffer.from(decodeAsciiHex(Buffer.from("48 65 6C6c 6F>lixo"), 100)).toString()).toBe("Hello");
    expect(Buffer.from(decodeAsciiHex(Buffer.from("486>"), 100))).toEqual(Buffer.from([0x48, 0x60]));
    expect(Buffer.from(decodeAscii85(Buffer.from("87cURD]i,\"Ebo80~>"), 100)).toString()).toBe("Hello World!");
    const zeros = Buffer.alloc(8);
    expect(Buffer.from(decodeAscii85(Buffer.from(ascii85(zeros)), 100))).toEqual(zeros);
    const sample = Buffer.from("Tabela de preços R$ 90,00", "latin1");
    expect(Buffer.from(decodeAscii85(Buffer.from(ascii85(sample)), 100))).toEqual(sample);
  });

  it("teto vale também para o ASCII85 com 'z' (4 bytes por caractere)", () => {
    expect(() => decodeAscii85(Buffer.from("z".repeat(1000) + "~>"), 100)).toThrow(PdfExtractError);
  });

  it("parseFilterChains lê nome, cadeia e abreviações", () => {
    expect(parseFilterChains("<< /Length 5 /Filter /FlateDecode >>")).toEqual([["FlateDecode"]]);
    expect(parseFilterChains("<< /Filter [ /AHx /Fl ] >>")).toEqual([["ASCIIHexDecode", "FlateDecode"]]);
    expect(parseFilterChains("<< /Length 5 >>")).toEqual([]);
    expect(parseFilterChains("<< /Filter 7 0 R >>")).toBeNull(); // sem o objeto 7
  });
});
