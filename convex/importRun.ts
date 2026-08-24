/**
 * Execução da importação (actions internas) — detecção de cabeçalhos, dry-run,
 * execução em lotes e rollback.
 *
 * Só aqui existe acesso ao conteúdo do arquivo (`ctx.storage.get` não existe em
 * query/mutation). Toda escrita passa pelas internal mutations de
 * `convex/imports.ts`, que são as donas das transições de status/auditoria.
 *
 * Todas as actions são idempotentes por desenho (o scheduler pode repetir):
 * detect só roda em `mapping`, dry-run só em `previewing`, a execução tem claim
 * exatamente-uma-vez (`internalClaimImport`) e o rollback é reaplicável.
 */

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { parseCsv } from "./lib/csv";
import {
  DRY_RUN_MAX_PREVIEW_ROWS,
  DRY_RUN_MAX_SAMPLE_ERRORS,
  IMPORT_BATCH_SIZE,
  MAX_IMPORT_ROWS,
  encodeHeaderKey,
  invalidHeader,
  mappingForHeaders,
  rowLimitMessage,
} from "./imports";
import {
  IGNORE_FIELD,
  coerceAndValidateRow,
  suggestMapping,
  type ImportEntity,
  type ImportFieldDef,
} from "./lib/importMapping";

/** Margem dentro do orçamento de 10 min da action. */
const RUN_DEADLINE_MS = 8 * 60 * 1000;
/** Chaves por chamada da checagem de duplicatas do dry-run. */
const DUP_CHECK_CHUNK = 100;

interface JobContext {
  job: {
    _id: Id<"importJobs">;
    organizationId: Id<"organizations">;
    status: string;
    entity: ImportEntity;
    duplicateStrategy: "skip" | "update" | "create";
    mapping?: Record<string, string>;
    suggestedMapping?: Record<string, string>;
  };
  file: { storageId: string; name: string; size: number; mimeType: string } | null;
  fieldDefs: ImportFieldDef[];
}

async function loadContext(ctx: ActionCtx, jobId: Id<"importJobs">): Promise<JobContext | null> {
  return (await ctx.runQuery(internal.imports.internalGetJobContext, { jobId })) as
    | JobContext
    | null;
}

async function readCsv(ctx: ActionCtx, context: JobContext) {
  if (!context.file) throw new Error("Arquivo da importação não encontrado");
  const blob = await ctx.storage.get(context.file.storageId as Id<"_storage">);
  if (!blob) throw new Error("Arquivo indisponível no armazenamento");
  const parsed = parseCsv(await blob.text());
  if (parsed.headers.length === 0) {
    throw new Error("O arquivo está vazio ou não tem linha de cabeçalho");
  }
  for (const header of parsed.headers) {
    const problem = invalidHeader(header);
    if (problem) throw new Error(problem);
  }
  if (parsed.rows.length === 0) {
    throw new Error("O arquivo não tem nenhuma linha de dados");
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw new Error(rowLimitMessage(parsed.rows.length));
  }
  return parsed;
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e ?? "Erro desconhecido");

// ===== 1. Detecção de cabeçalhos =====

export const internalDetectHeaders = internalAction({
  args: { jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.jobId);
    if (!context || context.job.status !== "mapping") return null;

    try {
      const parsed = await readCsv(ctx, context);
      const suggested = suggestMapping(parsed.headers, context.job.entity, context.fieldDefs);
      // O record vai indexado pela chave codificada do cabeçalho (ASCII).
      const suggestedMapping: Record<string, string> = {};
      for (const header of parsed.headers) {
        suggestedMapping[encodeHeaderKey(header)] = suggested[header] ?? IGNORE_FIELD;
      }
      await ctx.runMutation(internal.imports.internalPatchDetection, {
        jobId: args.jobId,
        detectedHeaders: parsed.headers,
        suggestedMapping,
      });
    } catch (e) {
      await ctx.runMutation(internal.imports.internalFailJob, {
        jobId: args.jobId,
        error: errorMessage(e),
      });
    }
    return null;
  },
});

// ===== 2. Dry-run =====

export const internalRunDryRun = internalAction({
  args: { jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.jobId);
    if (!context || context.job.status !== "previewing") return null;

    try {
      const parsed = await readCsv(ctx, context);
      const mapping = mappingForHeaders(
        parsed.headers,
        context.job.mapping ?? context.job.suggestedMapping
      );
      if (Object.values(mapping).every((d) => !d || d === IGNORE_FIELD)) {
        throw new Error("Mapeie ao menos uma coluna antes de pré-visualizar");
      }

      const entity = context.job.entity;
      const sampleErrors: Array<{ row: number; field?: string; message: string }> = [];
      const preview: Array<Record<string, unknown>> = [];
      const validKeys: Array<{ email?: string; phone?: string }> = [];
      let validRows = 0;
      let errorRows = 0;

      for (let i = 0; i < parsed.rows.length; i++) {
        const rowNumber = i + 1;
        const result = coerceAndValidateRow(parsed.rows[i], mapping, entity, context.fieldDefs);
        if (!result.ok) {
          errorRows++;
          for (const err of result.errors) {
            if (sampleErrors.length >= DRY_RUN_MAX_SAMPLE_ERRORS) break;
            sampleErrors.push({ row: rowNumber, field: err.field, message: err.message });
          }
          if (preview.length < DRY_RUN_MAX_PREVIEW_ROWS) {
            preview.push({
              linha: rowNumber,
              erro: result.errors
                .map((e) => (e.field ? `${e.field}: ${e.message}` : e.message))
                .join("; "),
            });
          }
          continue;
        }
        validRows++;
        const value = result.value as Record<string, any>;
        // Estratégia "create" nunca casa duplicata — não gasta consulta.
        if (entity === "contacts" && context.job.duplicateStrategy !== "create") {
          validKeys.push({ email: value.email, phone: value.phone });
        }
        if (preview.length < DRY_RUN_MAX_PREVIEW_ROWS) {
          preview.push({ linha: rowNumber, ...value });
        }
      }

      let newRows = validRows;
      let updateRows = 0;
      let skipRows = 0;

      if (entity === "contacts" && validKeys.length > 0) {
        let duplicates = 0;
        for (let i = 0; i < validKeys.length; i += DUP_CHECK_CHUNK) {
          const matched: boolean[] = await ctx.runQuery(
            internal.imports.internalCheckDuplicates,
            {
              organizationId: context.job.organizationId,
              keys: validKeys.slice(i, i + DUP_CHECK_CHUNK),
            }
          );
          duplicates += matched.filter(Boolean).length;
        }
        if (context.job.duplicateStrategy === "skip") {
          skipRows = duplicates;
          newRows = validRows - duplicates;
        } else if (context.job.duplicateStrategy === "update") {
          updateRows = duplicates;
          newRows = validRows - duplicates;
        }
      }

      await ctx.runMutation(internal.imports.internalPatchDryRun, {
        jobId: args.jobId,
        dryRun: {
          totalRows: parsed.rows.length,
          validRows,
          errorRows,
          newRows,
          updateRows,
          skipRows,
          sampleErrors,
          preview,
        },
      });
    } catch (e) {
      await ctx.runMutation(internal.imports.internalFailJob, {
        jobId: args.jobId,
        error: errorMessage(e),
      });
    }
    return null;
  },
});

// ===== 3. Execução =====

export const internalRunImport = internalAction({
  args: { jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claimed: boolean = await ctx.runMutation(internal.imports.internalClaimImport, {
      jobId: args.jobId,
    });
    if (!claimed) return null;

    const context = await loadContext(ctx, args.jobId);
    if (!context) return null;

    try {
      const parsed = await readCsv(ctx, context);
      const deadline = Date.now() + RUN_DEADLINE_MS;

      for (let start = 0; start < parsed.rows.length; start += IMPORT_BATCH_SIZE) {
        if (Date.now() > deadline) {
          throw new Error(
            "A importação excedeu o tempo limite de execução — divida o arquivo em partes menores."
          );
        }
        const rows = parsed.rows
          .slice(start, start + IMPORT_BATCH_SIZE)
          .map((data, offset) => ({
            row: start + offset + 1,
            cells: parsed.headers.map((header) => data[header] ?? ""),
          }));
        const result: { shouldContinue: boolean } = await ctx.runMutation(
          internal.imports.internalProcessBatch,
          {
            jobId: args.jobId,
            batchIndex: Math.floor(start / IMPORT_BATCH_SIZE),
            headers: parsed.headers,
            rows,
          }
        );
        if (!result.shouldContinue) return null; // job cancelado/alterado no meio
      }

      await ctx.runMutation(internal.imports.internalFinishImport, { jobId: args.jobId });
    } catch (e) {
      await ctx.runMutation(internal.imports.internalFailJob, {
        jobId: args.jobId,
        error: errorMessage(e),
      });
    }
    return null;
  },
});

// ===== 4. Rollback =====

export const internalRunRollback = internalAction({
  args: { jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.jobId);
    if (!context) return null;
    if (context.job.status !== "completed" && context.job.status !== "completed_with_errors") {
      return null;
    }

    const batchIds: Id<"importJobBatches">[] = await ctx.runQuery(
      internal.imports.internalListBatchIds,
      { jobId: args.jobId }
    );

    let deleted = 0;
    let reverted = 0;
    for (const batchId of batchIds) {
      const result: { deleted: number; reverted: number } = await ctx.runMutation(
        internal.imports.internalRollbackBatch,
        { jobId: args.jobId, batchId }
      );
      deleted += result.deleted;
      reverted += result.reverted;
    }

    await ctx.runMutation(internal.imports.internalFinishRollback, {
      jobId: args.jobId,
      deleted,
      reverted,
    });
    return null;
  },
});
