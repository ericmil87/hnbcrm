// @vitest-environment node
/**
 * 3ª revisão do P2.2 (B1 estrutural):
 *  - pré-varredura (primeira barreira) recusa as 5 variantes novas
 *    (`stream JUNK\n`, `stream%x\n`, chamariz `%stream\n`, chamariz
 *    `(stream\n)`, stream dentro de /ObjStm) e as anteriores;
 *  - vigia de memória do worker (defesa principal): com a pré-varredura
 *    DESLIGADA (só em teste), toda bomba de 400 MB é recusada por
 *    TOO_BIG_EXPANSION e o pico de RSS fica perto do teto.
 * Arquivo próprio: o vitest roda cada arquivo num processo (pool forks), então
 * o RSS medido aqui não mistura com outros testes.
 */
import { describe, expect, it } from "vitest";
import { extractPdfText, PdfExtractError, PDF_LIMITS, preflightPdf } from "./pdfExtract";
import { cheapZlibBomb, flateTextPdf, objStmBombPdf, pdfWithDecoy, pdfWithRawStreamPrefix, zlibBomb } from "./pdfTestFixtures.test-helper";

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    expect(e).toBeInstanceOf(PdfExtractError);
    return (e as PdfExtractError).code;
  }
}

const D = (L: number) => `<< /Length ${L} /Filter /FlateDecode >>\nstream\n`;

/** [nome, prefixo do objeto, chamariz antes do objeto] — as da revisão anterior + as 5 novas (menos /ObjStm, à parte). */
const VARIANTS: Array<[string, (L: number) => string, string]> = [
  ["controle", D, ""],
  ["comentário entre >> e stream", (L) => `<< /Length ${L} /Filter /FlateDecode >> %x\nstream\n`, ""],
  ["nome /obj no dicionário", (L) => `<< /Filter /FlateDecode /N /obj /Length ${L} >>\nstream\n`, ""],
  ["/Filter a mais de 4 KB", (L) => `<< /Filter /FlateDecode /P (${"x".repeat(5000)}) /Length ${L} >>\nstream\n`, ""],
  ["stream \\n", (L) => `<< /Length ${L} /Filter /FlateDecode >>stream \n`, ""],
  ["stream JUNK\\n", (L) => `<< /Length ${L} /Filter /FlateDecode >>\nstream JUNK\n`, ""],
  ["stream%x\\n", (L) => `<< /Length ${L} /Filter /FlateDecode >>\nstream%x\n`, ""],
  ["chamariz %stream em comentário", D, "%stream\n"],
  ["chamariz (stream) em string", D, "99 0 obj\n(stream\n)\nendobj\n"],
];

function build(mbOrData: number | Buffer, prefix: (L: number) => string, pre: string): Uint8Array {
  const data = typeof mbOrData === "number" ? cheapZlibBomb(mbOrData) : mbOrData;
  return new Uint8Array(pre ? pdfWithDecoy(data, prefix, pre) : pdfWithRawStreamPrefix(data, prefix));
}

describe("pré-varredura: variantes da 3ª revisão (primeira barreira)", () => {
  it.each(VARIANTS)("%s → TOO_BIG_EXPANSION na pré-varredura", (_label, prefix, pre) => {
    const pdf = build(200, prefix, pre);
    const t0 = Date.now();
    expect(() => preflightPdf(pdf, PDF_LIMITS)).toThrow(PdfExtractError);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("stream comprimido dentro de /ObjStm (1 KB → 200 MB) → recusado", () => {
    const pdf = new Uint8Array(objStmBombPdf(200));
    expect(pdf.byteLength).toBeLessThan(10 * 1024);
    let code = "OK";
    try {
      preflightPdf(pdf, PDF_LIMITS);
    } catch (e) {
      code = (e as PdfExtractError).code;
    }
    expect(code).toBe("TOO_BIG_EXPANSION");
  });

  it("a mesma variante com dado pequeno passa (sem falso positivo)", async () => {
    const small = new Uint8Array(pdfWithDecoy(zlibBomb(0.01), (L) => `<< /Length ${L} /Filter /FlateDecode >>\nstream JUNK\n`, "%stream\n"));
    expect(() => preflightPdf(small, PDF_LIMITS)).not.toThrow();
    const r = await extractPdfText(new Uint8Array(flateTextPdf(["Corte feminino R$ 90,00 60 min", "Escova progressiva R$ 250,00 (cabelos médios)"])));
    expect(r.text).toContain("Corte feminino R$ 90,00");
  });
});

describe("vigia de memória do worker (defesa principal)", () => {
  const CAP = 150 * 1024 * 1024;

  async function measured<T>(fn: () => Promise<T>): Promise<{ result: T | Error; peakDelta: number }> {
    const r0 = process.memoryUsage.rss();
    let peak = r0;
    const iv = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage.rss());
    }, 5);
    let result: T | Error;
    try {
      result = await fn();
    } catch (e) {
      result = e as Error;
    } finally {
      clearInterval(iv);
    }
    peak = Math.max(peak, process.memoryUsage.rss());
    return { result, peakDelta: peak - r0 };
  }

  const all: Array<[string, () => Uint8Array]> = [
    // 400 MB: bem acima do teto do teste (o pdf.js nem sempre retém toda a
    // saída; com 200 MB o /ObjStm ficou logo abaixo de 150 MB sob carga).
    ...VARIANTS.map(([label, prefix, pre]) => [label, () => build(400, prefix, pre)] as [string, () => Uint8Array]),
    ["/ObjStm", () => new Uint8Array(objStmBombPdf(400))],
  ];

  it.each(all)("%s, sem pré-varredura: o vigia termina o worker (TOO_BIG_EXPANSION) perto do teto", async (_label, make) => {
    const pdf = make();
    const { result, peakDelta } = await measured(() =>
      extractPdfText(pdf, { skipPreflightForTests: true, rssCapBytes: CAP, timeoutMs: 60_000 })
    );
    console.log(JSON.stringify({ variante: _label, picoMB: Math.round(peakDelta / 1e6), tetoMB: Math.round(CAP / 1e6) }));
    expect(result).toBeInstanceOf(PdfExtractError);
    expect((result as PdfExtractError).code).toBe("TOO_BIG_EXPANSION");
    // Folga para um passo de crescimento do buffer do pdf.js entre duas leituras do vigia.
    expect(peakDelta).toBeLessThan(CAP + 100 * 1024 * 1024);
  });

  it("PDF normal não dispara o vigia", async () => {
    const r = await extractPdfText(new Uint8Array(flateTextPdf(["Tabela: corte R$ 90,00 e escova R$ 60,00 com hidratação"])), {
      rssCapBytes: CAP,
    });
    expect(r.scanned).toBe(false);
  });

  it("o vigia é limpo em todos os caminhos (sucesso, erro tipado, prazo)", async () => {
    const before = (process as unknown as { getActiveResourcesInfo: () => string[] }).getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    await extractPdfText(new Uint8Array(flateTextPdf(["Linha de teste com texto suficiente para não ser escaneado."])));
    expect(await codeOf(extractPdfText(new Uint8Array(Buffer.from("%PDF-1.7\n" + "lixo ".repeat(200), "latin1"))))).toMatch(/CORRUPT|PARSE_FAILED/);
    expect(await codeOf(extractPdfText(build(1, D, ""), { timeoutMs: 1, skipPreflightForTests: true }))).toMatch(/TIMEOUT|TOO_BIG_EXPANSION/);
    await new Promise((r) => setTimeout(r, 50));
    const after = (process as unknown as { getActiveResourcesInfo: () => string[] }).getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    expect(after).toBeLessThanOrEqual(before);
  });
});
