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
import {
  decodeAsciiHex,
  extractPdfText,
  MAX_STREAM_KEYWORDS,
  PdfExtractError,
  PDF_LIMITS,
  PDF_WORKER_RSS_ABS_MAX_BYTES,
  PDF_WORKER_RSS_CAP_BYTES,
  preflightPdf,
} from "./pdfExtract";
import {
  cheapZlibBomb,
  flateTextPdf,
  objStmBombPdf,
  pdfWithDecoy,
  pdfWithRawStreamPrefix,
  photoPdf,
  zlibBomb,
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

const D = (L: number) => `<< /Length ${L} /Filter /FlateDecode >>\nstream\n`;

/**
 * Depois das bombas deste arquivo a base de RSS do processo fica inflada (o
 * Node não devolve a memória na hora) e dispararia o teto ABSOLUTO; os testes
 * que não são sobre ele o desligam explicitamente.
 */
const NO_ABS = { rssAbsMaxBytes: Number.MAX_SAFE_INTEGER };

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
      ...NO_ABS,
    });
    expect(r.scanned).toBe(false);
  });

  it("o vigia é limpo em todos os caminhos (sucesso, erro tipado, prazo)", async () => {
    const before = (process as unknown as { getActiveResourcesInfo: () => string[] }).getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    await extractPdfText(new Uint8Array(flateTextPdf(["Linha de teste com texto suficiente para não ser escaneado."])), NO_ABS);
    expect(await codeOf(extractPdfText(new Uint8Array(Buffer.from("%PDF-1.7\n" + "lixo ".repeat(200), "latin1")), NO_ABS))).toMatch(
      /CORRUPT|PARSE_FAILED/
    );
    expect(await codeOf(extractPdfText(build(1, D, ""), { timeoutMs: 1, skipPreflightForTests: true }))).toMatch(/TIMEOUT|TOO_BIG_EXPANSION/);
    await new Promise((r) => setTimeout(r, 50));
    const after = (process as unknown as { getActiveResourcesInfo: () => string[] }).getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    expect(after).toBeLessThanOrEqual(before);
  });

  it("teto absoluto de RSS: base já inflada → recusa mesmo sem crescer 250 MB", async () => {
    const pdf = build(400, D, "");
    const abs = process.memoryUsage.rss() + 60 * 1024 * 1024;
    const code = await codeOf(
      extractPdfText(pdf, { skipPreflightForTests: true, rssCapBytes: 10 * 1024 * 1024 * 1024, rssAbsMaxBytes: abs, timeoutMs: 60_000 })
    );
    expect(code).toBe("TOO_BIG_EXPANSION");
  });

  it("os tetos padrão são 250 MB sobre a base e 450 MB absolutos", () => {
    expect(PDF_WORKER_RSS_CAP_BYTES).toBe(250 * 1024 * 1024);
    expect(PDF_WORKER_RSS_ABS_MAX_BYTES).toBe(450 * 1024 * 1024);
  });
});

describe("4ª revisão: pré-varredura linear e com prazo", () => {
  const latin1 = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

  it("10 MB de `stream~` sem quebra de linha: < 1 s (recusado pelo teto de ocorrências)", () => {
    const body = latin1("%PDF-1.4\n" + "stream~".repeat(Math.floor((10 * 1024 * 1024) / 7)));
    const t0 = performance.now();
    expect(() => preflightPdf(body, PDF_LIMITS)).toThrow(PdfExtractError);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("15 mil `stream~` (abaixo do teto de ocorrências) seguidos de 4 MB sem quebra: linear, < 1 s", () => {
    const body = latin1("%PDF-1.4\n" + "stream~".repeat(15_000) + "x".repeat(4 << 20));
    const t0 = performance.now();
    expect(() => preflightPdf(body, PDF_LIMITS)).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("32 mil streams AHx vazios + 4 MB: < 1 s", () => {
    const body = latin1("%PDF-1.4\n" + "1 0 obj<</Filter/AHx>>stream\n>\n".repeat(32_000) + "x".repeat(4 << 20));
    const t0 = performance.now();
    let code = "OK";
    try {
      preflightPdf(body, PDF_LIMITS);
    } catch (e) {
      code = (e as PdfExtractError).code;
    }
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(code).toBe("TOO_LARGE"); // acima de 20 mil ocorrências
  });

  it("acima de 20 mil `stream` → TOO_LARGE", () => {
    // "~" logo após a palavra-chave: não parece hex nem ASCII85 (isola o teto de ocorrências).
    const body = latin1("%PDF-1.4\n" + "stream~\n".repeat(MAX_STREAM_KEYWORDS + 1));
    const t0 = performance.now();
    let code = "OK";
    try {
      preflightPdf(body, PDF_LIMITS);
    } catch (e) {
      code = (e as PdfExtractError).code;
    }
    expect(code).toBe("TOO_LARGE");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("muitos `stream\\n` seguidos (parecem ASCII85, sem endstream): o orçamento ASCII (32 MB) corta", () => {
    const body = latin1("%PDF-1.4\n" + "stream\n".repeat(19_000));
    const t0 = performance.now();
    expect(() => preflightPdf(body, PDF_LIMITS)).toThrow(PdfExtractError);
    // limitado pelo orçamento; folga para a suíte inteira em paralelo
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("o prazo vale para a pré-varredura (TIMEOUT checado a cada `stream`)", async () => {
    const body = latin1("%PDF-1.4\n" + "stream\n".repeat(1000));
    let code = "OK";
    try {
      preflightPdf(body, PDF_LIMITS, Date.now() - 1);
    } catch (e) {
      code = (e as PdfExtractError).code;
    }
    expect(code).toBe("TIMEOUT");
    expect(await codeOf(extractPdfText(body, { timeoutMs: 0 }))).toBe("TIMEOUT");
  });

  it("decodeAsciiHex não aloca len/2 para um stream que termina logo", () => {
    const big = new Uint8Array(8 * 1024 * 1024).fill(0x3e); // ">" no primeiro byte
    const scan = { bytes: 0 };
    expect(decodeAsciiHex(big, 16 * 1024 * 1024, scan).byteLength).toBe(0);
    expect(scan.bytes).toBe(0);
  });
});

describe("4ª revisão: imagem Flate grande legítima (t12)", () => {
  it("foto 2500×2500 RGB (19 MB descomprimidos) não é recusada", async () => {
    const pdf = new Uint8Array(photoPdf(2500, 2500));
    expect(pdf.byteLength).toBeLessThan(PDF_LIMITS.maxBytes);
    expect(() => preflightPdf(pdf, PDF_LIMITS)).not.toThrow();
    const r = await extractPdfText(pdf, NO_ABS);
    expect(r.scanned).toBe(false);
    expect(r.text).toContain("Pizza margherita R$ 45,00");
  });

  it("bomba rotulada como /Subtype /Image passa pela pré-varredura e cai no vigia", async () => {
    const pdf = build(400, (L) => `<< /Length ${L} /Subtype /Image /Filter /FlateDecode >>\nstream\n`, "");
    expect(() => preflightPdf(pdf, PDF_LIMITS)).not.toThrow();
    expect(await codeOf(extractPdfText(pdf, { rssCapBytes: 150 * 1024 * 1024, timeoutMs: 60_000, ...NO_ABS }))).toBe(
      "TOO_BIG_EXPANSION"
    );
  });
});
