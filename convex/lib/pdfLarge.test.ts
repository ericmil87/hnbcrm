// @vitest-environment node
/**
 * Teto de 20 MB do PDF do onboarding (antes 10 MB). Medido na subida do teto
 * (fixture sintética `bigLegitPdf`, processo de teste com base de RSS ~165 MB):
 *  - 19 MB (150 páginas de texto + 4 imagens Flate aleatórias): OK, o RSS
 *    cresceu ~45 MB sobre a base durante a leitura (teto do vigia: +250 MB);
 *  - 19 MB só de streams Flate de "fonte" que somam 45 MB descomprimidos
 *    (taxa 2,4:1, o pior legítimo que cabe nos 48 MB): OK, +50–90 MB;
 *  - ASCII85 de 15 MB crus (arquivo de 18,8 MB): com o orçamento ASCII antigo
 *    (32 MB) era recusado a partir de ~13 MB; com 64 MB passa.
 * As bombas continuam nos testes de `pdfWatchdog.test.ts` / `pdfExtract.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { extractPdfText, PDF_ERROR_MESSAGES, PDF_LIMITS, PdfExtractError, preflightPdf } from "./pdfExtract";
import { ONBOARDING_PDF_MAX_BYTES } from "./onboardingLimits";
import { bigLegitPdf } from "./pdfBigFixture.test-helper";
import { ascii85, pdfWithContentStream } from "./pdfTestFixtures.test-helper";

const MB = 1024 * 1024;
/** Outros testes do processo inflam a base de RSS; o teto absoluto não é o assunto aqui. */
const NO_ABS = { rssAbsMaxBytes: Number.MAX_SAFE_INTEGER };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (e) {
    expect(e).toBeInstanceOf(PdfExtractError);
    return (e as PdfExtractError).code;
  }
}

describe("teto de 20 MB do PDF do onboarding", { timeout: 90_000 }, () => {
  it("é uma constante única usada por PDF_LIMITS", () => {
    expect(ONBOARDING_PDF_MAX_BYTES).toBe(20 * MB);
    expect(PDF_LIMITS.maxBytes).toBe(ONBOARDING_PDF_MAX_BYTES);
  });

  it("PDF legítimo de ~19 MB (texto + imagens Flate grandes) é lido", async () => {
    const pdf = new Uint8Array(bigLegitPdf({ targetMb: 19 }));
    expect(pdf.byteLength).toBeGreaterThan(18.5 * MB);
    expect(pdf.byteLength).toBeLessThan(20 * MB);
    const r = await extractPdfText(pdf, NO_ABS);
    expect(r.scanned).toBe(false);
    expect(r.text).toContain("Pizza margherita");
  });

  it("19 MB de streams de fonte que descomprimem 45 MB (sob o teto de 48 MB) passam pela pré-varredura e pela leitura", async () => {
    const pdf = new Uint8Array(bigLegitPdf({ targetMb: 19, fontMb: 45, fontRatio: 2.4 }));
    expect(() => preflightPdf(pdf, PDF_LIMITS)).not.toThrow();
    const r = await extractPdfText(pdf, NO_ABS);
    expect(r.text).toContain("Pizza margherita");
  });

  it("ASCII85 legítimo de ~19 MB passa pelo orçamento de varredura ASCII", () => {
    const pdf = new Uint8Array(pdfWithContentStream(Buffer.from(ascii85(randomBytes(15 * MB)), "latin1"), "/Filter /ASCII85Decode"));
    expect(pdf.byteLength).toBeLessThan(20 * MB);
    expect(() => preflightPdf(pdf, PDF_LIMITS)).not.toThrow();
    const z = deflateSync(randomBytes(12 * MB), { level: 1 });
    const chain = new Uint8Array(pdfWithContentStream(Buffer.from(ascii85(z), "latin1"), "/Filter [/ASCII85Decode /FlateDecode]"));
    expect(() => preflightPdf(chain, PDF_LIMITS)).not.toThrow();
  });

  it("acima de 20 MB é recusado com a mensagem do limite; bomba continua recusada", async () => {
    let err: PdfExtractError | undefined;
    try {
      await extractPdfText(new Uint8Array(20 * MB + 1));
    } catch (e) {
      err = e as PdfExtractError;
    }
    expect(err).toBeInstanceOf(PdfExtractError);
    expect(err?.code).toBe("TOO_LARGE");
    expect(PDF_ERROR_MESSAGES.TOO_LARGE).toContain("até 20 MB");
    // Streams somados acima de 48 MB (5 × 12 MB de zeros) seguem recusados.
    const zeros = deflateSync(Buffer.alloc(12 * MB), { level: 1 });
    const bomb = new Uint8Array(
      pdfWithContentStream(Buffer.concat([zeros]), "/Filter /FlateDecode", Array.from({ length: 5 }, () => Buffer.concat([Buffer.from("<< /Filter /FlateDecode /Length " + zeros.length + " >>\nstream\n", "latin1"), zeros, Buffer.from("\nendstream", "latin1")])))
    );
    expect(await codeOf(extractPdfText(bomb, NO_ABS))).toBe("TOO_BIG_EXPANSION");
  });
});
