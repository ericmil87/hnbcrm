"use node";
/**
 * O atendente LÊ o PDF que o cliente (ou a equipe) mandou: texto extraído no
 * recebimento, gravado na mensagem e entregue ao histórico por `historyTextOf`.
 *
 *   ingest → schedulePdfRead (lib/mediaEnrichment) → internalReadPdf
 *     → claim (idempotente) → blob → bytes `%PDF-` + teto de 5 MB
 *     → extractPdfText (porta única; worker isolado, vigia de memória, falha fechada)
 *     → done:    texto limpo (cleanUntrustedText) ≤ 6.000 caracteres
 *     → scanned: sem camada de texto → JPEG embutido da página (stream
 *                /DCTDecode cru, sem rasterizar) → passe de visão das imagens
 *                (só com visionEnabled) → `scanned` (+ `viaVision`)
 *
 * Extrair texto NÃO chama LLM (custo de modelo zero). Nunca lança para fora e
 * nunca loga conteúdo nem nome de arquivo: só código, bytes e duração.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { extractPdfText, PdfExtractError } from "./lib/pdfExtract";
import { findFirstEmbeddedJpeg } from "./lib/pdfEmbeddedJpeg";
import { cleanUntrustedText, truncateText } from "./lib/untrustedText";
import { hasPdfMagic, PDF_READ_MAX_BYTES, PDF_READ_MAX_CHARS } from "./lib/pdfRead";

export const internalReadPdf = internalAction({
  args: { messageId: v.id("messages"), force: v.optional(v.boolean()) },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args): Promise<{ status: string }> => {
    const started = Date.now();
    let bytesLen = 0;
    const log = (code: string) =>
      console.log(JSON.stringify({ event: "pdfRead", code, bytes: bytesLen, ms: Date.now() - started }));
    const finish = async (
      status: "done" | "scanned" | "failed" | "skipped",
      extra: {
        text?: string;
        truncated?: boolean;
        pages?: number;
        pagesRead?: number;
        viaVision?: boolean;
        error?: string;
      } = {}
    ) => {
      try {
        await ctx.runMutation(internal.pdfReadState.internalSetPdfReadResult, {
          messageId: args.messageId,
          status,
          ...extra,
        });
      } catch {
        // gravar falhou: o claim do atendente segue pelo teto de espera.
      }
      log(extra.error ?? status);
      return { status };
    };

    let claimed = false;
    try {
      const info = await ctx.runQuery(internal.pdfReadState.internalGetPdfForRead, { messageId: args.messageId });
      if (!info) return { status: "skipped" };
      claimed = await ctx.runMutation(internal.pdfReadState.internalClaimPdfRead, {
        messageId: args.messageId,
        force: args.force,
      });
      if (!claimed) return { status: "claimed_elsewhere" };
      bytesLen = info.size;

      if (info.size > PDF_READ_MAX_BYTES) return await finish("failed", { error: "TOO_LARGE" });
      const blob = await ctx.storage.get(info.storageId as Id<"_storage">);
      if (!blob) return await finish("failed", { error: "NOT_FOUND" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      bytesLen = bytes.byteLength;
      if (bytes.byteLength > PDF_READ_MAX_BYTES) return await finish("failed", { error: "TOO_LARGE" });
      // Extensão/mime dizem PDF, os bytes não: recusa (nada é lido).
      if (!hasPdfMagic(bytes)) return await finish("skipped", { error: "NOT_PDF" });

      let result;
      try {
        result = await extractPdfText(bytes, { maxChars: PDF_READ_MAX_CHARS });
      } catch (e) {
        return await finish("failed", { error: e instanceof PdfExtractError ? e.code : "PARSE_FAILED" });
      }

      if (!result.scanned && result.text.trim()) {
        // Texto de terceiro: limpeza de invisíveis/injeção + teto antes de gravar.
        const cleaned = cleanUntrustedText(result.text).text;
        const cut = truncateText(cleaned, PDF_READ_MAX_CHARS);
        if (cut.text) {
          return await finish("done", {
            text: cut.text,
            truncated: result.truncated || cut.truncated,
            pages: result.numPages,
            pagesRead: result.pagesRead,
          });
        }
      }

      // Escaneado: o texto vazio é fato; a leitura vira da IMAGEM, se houver visão.
      const pageInfo = { pages: result.numPages, pagesRead: result.pagesRead };
      if (!info.visionOn) return await finish("scanned", pageInfo);
      const jpeg = findFirstEmbeddedJpeg(bytes, PDF_READ_MAX_BYTES);
      if (!jpeg) return await finish("scanned", pageInfo);

      const tempId = await ctx.storage.store(new Blob([jpeg.bytes], { type: "image/jpeg" }));
      let viaVision = false;
      try {
        const vision = await ctx.runAction(internal.vision.internalDescribePdfImage, {
          messageId: args.messageId,
          storageId: tempId,
          size: jpeg.bytes.byteLength,
        });
        viaVision = vision.status === "done" && !!vision.text;
      } catch {
        viaVision = false;
      } finally {
        try {
          await ctx.storage.delete(tempId);
        } catch {
          // blob temporário órfão é inofensivo (sem linha em `files`).
        }
      }
      return await finish("scanned", { ...pageInfo, viaVision });
    } catch {
      if (claimed) return await finish("failed", { error: "PARSE_FAILED" });
      return { status: "failed" };
    }
  },
});
