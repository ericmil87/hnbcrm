/**
 * Contador agregado de armazenamento por org (`orgStorageUsage`) — perf Convex
 * I/O, onda 2.
 *
 * A quota de arquivos fazia `.collect()` de TODAS as linhas de `files` da org a
 * cada upload e a cada mídia recebida no WhatsApp. Agora ela lê 1 documento.
 *
 * Regras:
 *  - Toda linha de `files` inserida ou apagada passa por `insertFileRow` /
 *    `deleteFileRow` (ou chama `bumpStorageUsage` direto). `storageUsage.test.ts`
 *    quebra o build se aparecer um `insert("files"` fora daqui.
 *  - O contador conta LINHAS de `files` (o mesmo que a soma antiga fazia): uma
 *    mensagem encaminhada duplica a linha com o mesmo blob e conta duas vezes.
 *  - Sem linha de contador = "não inicializado": o bump não cria a linha; a
 *    PRIMEIRA leitura da quota numa mutation calcula via `.collect()` uma vez e
 *    grava (lazy init — não há backfill obrigatório).
 *  - Nunca negativo. Divergência (escritor esquecido, purga parcial) se corrige
 *    com `files:internalRebuildStorageUsage`.
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

export type StorageUsage = { bytes: number; count: number };

/** Soma o real a partir de `files` (varredura completa da org). */
export async function computeStorageUsageFromFiles(
  ctx: QueryCtx,
  organizationId: Id<"organizations">
): Promise<StorageUsage> {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .collect();
  return { bytes: rows.reduce((sum, f) => sum + (f.size || 0), 0), count: rows.length };
}

async function getRow(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return await ctx.db
    .query("orgStorageUsage")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
}

/** Uso atual da org em QUERY: sem contador, calcula sem gravar. */
export async function readStorageUsage(
  ctx: QueryCtx,
  organizationId: Id<"organizations">
): Promise<StorageUsage> {
  const row = await getRow(ctx, organizationId);
  if (row) return { bytes: row.bytes, count: row.count };
  return await computeStorageUsageFromFiles(ctx, organizationId);
}

/**
 * Uso atual da org em MUTATION: sem contador, calcula via `.collect()` UMA vez
 * e grava (lazy init). Corrida entre duas inicializações é resolvida pelo OCC
 * (as duas leram a faixa vazia do índice; a segunda reexecuta e acha a linha).
 */
export async function readStorageUsageForWrite(
  ctx: MutationCtx,
  organizationId: Id<"organizations">
): Promise<StorageUsage> {
  const row = await getRow(ctx, organizationId);
  if (row) return { bytes: row.bytes, count: row.count };
  const computed = await computeStorageUsageFromFiles(ctx, organizationId);
  await ctx.db.insert("orgStorageUsage", {
    organizationId,
    bytes: computed.bytes,
    count: computed.count,
    updatedAt: Date.now(),
  });
  return computed;
}

/**
 * Soma `delta` ao contador da org. Sem contador ainda: não faz nada (a próxima
 * leitura calcula do zero e já inclui esta mudança). Nunca deixa negativo.
 */
export async function bumpStorageUsage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  delta: { bytes: number; count: number }
): Promise<void> {
  if (!delta.bytes && !delta.count) return;
  const row = await getRow(ctx, organizationId);
  if (!row) return;
  await ctx.db.patch(row._id, {
    bytes: Math.max(0, row.bytes + delta.bytes),
    count: Math.max(0, row.count + delta.count),
    updatedAt: Date.now(),
  });
}

/** Insere uma linha de `files` e soma ao contador. Porta ÚNICA de insert. */
export async function insertFileRow(
  ctx: MutationCtx,
  doc: Omit<Doc<"files">, "_id" | "_creationTime">
): Promise<Id<"files">> {
  const fileId = await ctx.db.insert("files", doc);
  await bumpStorageUsage(ctx, doc.organizationId, { bytes: doc.size || 0, count: 1 });
  return fileId;
}

/** Apaga uma linha de `files` (NÃO mexe no blob — ver `lib/fileRefs.ts`) e desconta. */
export async function deleteFileRow(
  ctx: MutationCtx,
  file: Pick<Doc<"files">, "_id" | "organizationId" | "size">
): Promise<void> {
  await ctx.db.delete(file._id);
  await bumpStorageUsage(ctx, file.organizationId, { bytes: -(file.size || 0), count: -1 });
}
