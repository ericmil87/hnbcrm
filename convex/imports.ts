/**
 * Importação de dados (F3 contatos, F4 leads, F5 rollback).
 *
 * Este módulo tem a superfície PÚBLICA do wizard (todas as funções passam por
 * `requirePermission(ctx, org, "settings", "manage")`) mais as internas de
 * leitura/escrita que as actions consomem. As actions que leem o arquivo do
 * storage e encadeiam os lotes vivem em `convex/importRun.ts`.
 *
 * Fluxo: createImportJob → (internalDetectHeaders) → updateMapping →
 *        runPreview → (internalRunDryRun) → confirmImport → (internalRunImport)
 *        → completed | completed_with_errors → rollbackImport (opcional).
 *
 * Convenções desta implementação:
 * - `importJobBatches.updated[].before` guarda SÓ os campos alterados; `null`
 *   significa "o campo não existia" (o rollback remove o campo em vez de
 *   gravar null, que quebraria os validators de campos opcionais).
 * - Linhas são numeradas a partir de 1 (linha 1 = 1ª linha de dados, sem contar
 *   o cabeçalho) em erros, preview e no CSV de linhas com erro.
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { buildSearchText } from "./lib/searchText";
import { formatFileSize } from "./lib/fileValidation";
import { parseCsv, serializeCsv } from "./lib/csv";
import {
  CUSTOM_FIELD_PREFIX,
  IGNORE_FIELD,
  coerceAndValidateRow,
  listImportTargets,
  normalizeLabel,
  type ImportEntity,
  type ImportFieldDef,
} from "./lib/importMapping";

// ===== Limites (seção 2.8 do plano) =====

/** Teto de linhas por job — acima disso o job falha com erro amigável. */
export const MAX_IMPORT_ROWS = 10_000;
/** Teto do arquivo de import (o mesmo do allowlist de text/csv). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Linhas processadas por mutation. */
export const IMPORT_BATCH_SIZE = 50;
/** Caps do dry-run gravado no doc do job. */
export const DRY_RUN_MAX_SAMPLE_ERRORS = 50;
export const DRY_RUN_MAX_PREVIEW_ROWS = 10;

/** Status que ocupam a vaga de "1 import ativo por org". */
const ACTIVE_STATUSES = ["mapping", "previewing", "preview_ready", "running"] as const;

const ENTITY_LABEL: Record<ImportEntity, string> = {
  contacts: "contatos",
  leads: "leads",
};

// ===== Validators compartilhados =====

const entityValidator = v.union(v.literal("contacts"), v.literal("leads"));
const strategyValidator = v.union(
  v.literal("skip"),
  v.literal("update"),
  v.literal("create")
);
const dryRunValidator = v.object({
  totalRows: v.number(),
  validRows: v.number(),
  errorRows: v.number(),
  newRows: v.number(),
  updateRows: v.number(),
  skipRows: v.number(),
  sampleErrors: v.array(
    v.object({ row: v.number(), field: v.optional(v.string()), message: v.string() })
  ),
  preview: v.array(v.record(v.string(), v.any())),
});
// As células vão como array alinhado a `headers` (e não como record) porque
// cabeçalho acentuado não pode ser nome de campo em valor Convex.
const batchRowsValidator = v.array(
  v.object({ row: v.number(), cells: v.array(v.string()) })
);

// ===== Helpers puros =====

const baseMime = (mimeType: string): string => mimeType.split(";")[0].trim().toLowerCase();

/** CSV pelo MIME ou pela extensão (alguns navegadores mandam text/plain). */
function isCsvFile(mimeType: string, name: string): boolean {
  const mime = baseMime(mimeType);
  if (mime === "text/csv" || mime === "application/csv") return true;
  return (
    (mime === "text/plain" || mime === "application/octet-stream" || mime === "") &&
    name.toLowerCase().endsWith(".csv")
  );
}

export function rowLimitMessage(rows: number): string {
  return `Arquivo com ${rows.toLocaleString("pt-BR")} linhas — o limite por importação é ${MAX_IMPORT_ROWS.toLocaleString("pt-BR")}. Divida o arquivo e importe em partes.`;
}

// Codificação das chaves do record mapping/suggestedMapping: módulo puro
// compartilhado com o frontend e as rotas REST (todos codificam igual).
export { encodeHeaderKey, invalidHeader, mappingForHeaders } from "./lib/importKeys";
import { encodeHeaderKey, mappingForHeaders } from "./lib/importKeys";

/** Cabeçalho legível a partir da chave (só para mensagens de erro). */
function headerLabel(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  const complex =
    Array.isArray(a) || Array.isArray(b) ||
    (a !== null && typeof a === "object") || (b !== null && typeof b === "object");
  if (complex) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return a === b;
}

/** Campos de contato que a importação pode escrever (whitelist explícita). */
const CONTACT_FIELDS = [
  "firstName", "lastName", "email", "phone", "company", "title",
  "whatsappNumber", "telegramUsername", "tags", "bio",
  "linkedinUrl", "instagramUrl", "facebookUrl", "twitterUrl",
  "city", "state", "country", "industry", "companySize", "cnpj", "companyWebsite",
  "preferredContactTime", "deviceType", "utmSource", "acquisitionChannel",
  "instagramFollowers", "linkedinConnections", "socialInfluenceScore", "aiOptOut",
] as const;

// ===== Helpers de ctx =====

async function loadFieldDefs(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">
): Promise<ImportFieldDef[]> {
  const defs = await ctx.db
    .query("fieldDefinitions")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(500);
  return defs.map((d) => ({
    key: d.key,
    name: d.name,
    type: d.type,
    options: d.options,
    entityType: d.entityType,
    isRequired: d.isRequired,
  }));
}

/** Job da org do chamador (regra 1: job de outra org = "Not authorized"). */
async function requireJob(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  jobId: Id<"importJobs">
): Promise<Doc<"importJobs">> {
  const job = await ctx.db.get(jobId);
  if (!job || job.organizationId !== organizationId) throw new Error("Not authorized");
  return job;
}

async function logJobAudit(
  ctx: MutationCtx,
  job: Doc<"importJobs">,
  description: string,
  action: "create" | "update",
  metadata: Record<string, unknown>,
  now: number
): Promise<void> {
  await ctx.db.insert("auditLogs", {
    organizationId: job.organizationId,
    entityType: "importJob",
    entityId: job._id,
    action,
    actorId: job.requestedBy,
    actorType: "human",
    metadata: { entity: job.entity, fileName: job.fileName, ...metadata },
    description,
    severity: "medium",
    createdAt: now,
  });
}

async function findContactMatch(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  email: string | undefined,
  phone: string | undefined
): Promise<Doc<"contacts"> | null> {
  if (email) {
    const byEmail = await ctx.db
      .query("contacts")
      .withIndex("by_organization_and_email", (q) =>
        q.eq("organizationId", organizationId).eq("email", email)
      )
      .first();
    if (byEmail) return byEmail;
  }
  if (phone) {
    const byPhone = await ctx.db
      .query("contacts")
      .withIndex("by_organization_and_phone", (q) =>
        q.eq("organizationId", organizationId).eq("phone", phone)
      )
      .first();
    if (byPhone) return byPhone;
  }
  return null;
}

/**
 * Membro dono da chave de API, validado contra a organização (regra 1). Só as
 * internals da REST usam — no app o membro vem do `requirePermission`.
 */
async function requireApiMember(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  teamMemberId: Id<"teamMembers">
): Promise<Doc<"teamMembers">> {
  const member = await ctx.db.get(teamMemberId);
  if (!member || member.organizationId !== organizationId) {
    throw new Error("Membro da chave de API não pertence a esta organização");
  }
  return member;
}

// ===== Núcleo compartilhado (app + REST) =====
//
// Cada passo do wizard tem um `*Core` puro de permissão: a mutation pública
// aplica `requirePermission` e chama o core; a internal equivalente (consumida
// pelo `router.ts`) chama o mesmo core depois do gate por chave de API.

interface CreateImportInput {
  organizationId: Id<"organizations">;
  requestedBy: Id<"teamMembers">;
  entity: ImportEntity;
  fileId: Id<"files">;
  fileName: string;
  duplicateStrategy: "skip" | "update" | "create";
}

async function createImportJobCore(
  ctx: MutationCtx,
  args: CreateImportInput
): Promise<Id<"importJobs">> {
  const file = await ctx.db.get(args.fileId);
  if (!file || file.organizationId !== args.organizationId) {
    throw new Error("Arquivo não encontrado nesta organização");
  }
  if (!isCsvFile(file.mimeType, file.name)) {
    throw new Error(`O arquivo precisa ser um CSV (recebido: ${file.mimeType})`);
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(
      `Arquivo muito grande (${formatFileSize(file.size)}). Máximo permitido: ${formatFileSize(MAX_IMPORT_BYTES)}`
    );
  }

  for (const status of ACTIVE_STATUSES) {
    const running = await ctx.db
      .query("importJobs")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", status)
      )
      .first();
    if (running) {
      throw new Error(
        "Já existe uma importação em andamento nesta organização — conclua ou cancele antes de iniciar outra."
      );
    }
  }

  const now = Date.now();
  const jobId = await ctx.db.insert("importJobs", {
    organizationId: args.organizationId,
    requestedBy: args.requestedBy,
    status: "mapping",
    entity: args.entity,
    fileId: args.fileId,
    fileName: args.fileName,
    duplicateStrategy: args.duplicateStrategy,
    matchFields: args.entity === "contacts" ? ["email", "phone"] : undefined,
    progress: { processed: 0, total: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
    createdAt: now,
  });

  const job = (await ctx.db.get(jobId))!;
  await logJobAudit(
    ctx,
    job,
    `Criou uma importação de ${ENTITY_LABEL[args.entity]} (${args.fileName})`,
    "create",
    { duplicateStrategy: args.duplicateStrategy },
    now
  );

  await ctx.scheduler.runAfter(0, internal.importRun.internalDetectHeaders, { jobId });
  return jobId;
}

async function updateMappingCore(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  jobId: Id<"importJobs">,
  mapping: Record<string, string>
): Promise<null> {
  const job = await requireJob(ctx, organizationId, jobId);
  if (job.status !== "mapping" && job.status !== "preview_ready") {
    throw new Error("O mapeamento só pode ser alterado antes da execução da importação");
  }

  const targets = new Set(listImportTargets(job.entity).map((t) => t.field));
  const fieldDefs = await loadFieldDefs(ctx, organizationId);
  const customKeys = new Set(fieldDefs.map((d) => d.key));
  const detected = job.detectedHeaders ?? [];
  const keyToHeader = new Map(detected.map((h) => [encodeHeaderKey(h), h]));

  for (const [key, destination] of Object.entries(mapping)) {
    const header = keyToHeader.get(key) ?? headerLabel(key);
    if (detected.length > 0 && !keyToHeader.has(key)) {
      throw new Error(`A coluna "${header}" não existe no arquivo enviado`);
    }
    if (destination === IGNORE_FIELD) continue;
    if (destination.startsWith(CUSTOM_FIELD_PREFIX)) {
      const customKey = destination.slice(CUSTOM_FIELD_PREFIX.length);
      if (!customKeys.has(customKey)) {
        throw new Error(`Campo personalizado "${customKey}" não existe nesta organização`);
      }
      continue;
    }
    if (!targets.has(destination)) {
      throw new Error(`Campo "${destination}" não existe em ${ENTITY_LABEL[job.entity]}`);
    }
  }

  // Trocar o mapeamento invalida o dry-run anterior.
  await ctx.db.patch(jobId, { mapping, status: "mapping", dryRun: undefined });
  return null;
}

async function runPreviewCore(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  jobId: Id<"importJobs">
): Promise<null> {
  const job = await requireJob(ctx, organizationId, jobId);
  if (job.status !== "mapping" && job.status !== "preview_ready") {
    throw new Error("A pré-visualização só roda antes da execução da importação");
  }
  const mapping = job.mapping ?? job.suggestedMapping;
  const mapped = Object.values(mapping ?? {}).filter(
    (destination) => destination && destination !== IGNORE_FIELD
  );
  if (mapped.length === 0) {
    throw new Error("Mapeie ao menos uma coluna antes de pré-visualizar");
  }

  await ctx.db.patch(jobId, {
    status: "previewing",
    mapping: mapping ?? undefined,
    error: undefined,
  });
  await ctx.scheduler.runAfter(0, internal.importRun.internalRunDryRun, { jobId });
  return null;
}

async function confirmImportCore(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  jobId: Id<"importJobs">
): Promise<null> {
  const job = await requireJob(ctx, organizationId, jobId);
  if (job.status !== "preview_ready") {
    throw new Error("Rode a pré-visualização antes de confirmar a importação");
  }
  if (!job.dryRun || job.dryRun.validRows === 0) {
    throw new Error("Nenhuma linha válida para importar");
  }

  const now = Date.now();
  await ctx.db.patch(jobId, {
    status: "running",
    error: undefined,
    progress: {
      processed: 0,
      total: job.dryRun.totalRows,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    },
  });
  await logJobAudit(
    ctx,
    job,
    `Iniciou a importação de ${ENTITY_LABEL[job.entity]} (${job.fileName}) — ${job.dryRun.validRows} linha(s) válida(s)`,
    "update",
    { validRows: job.dryRun.validRows, totalRows: job.dryRun.totalRows },
    now
  );
  await ctx.scheduler.runAfter(0, internal.importRun.internalRunImport, { jobId });
  return null;
}

async function rollbackImportCore(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  jobId: Id<"importJobs">
): Promise<null> {
  const job = await requireJob(ctx, organizationId, jobId);
  if (job.status !== "completed" && job.status !== "completed_with_errors") {
    throw new Error("Só é possível desfazer importações concluídas");
  }
  await ctx.scheduler.runAfter(0, internal.importRun.internalRunRollback, { jobId });
  return null;
}

/** Erros de linha de um job (batches; cai no dry-run se ainda não rodou). */
async function collectFailedRows(
  ctx: QueryCtx | MutationCtx,
  job: Doc<"importJobs">
): Promise<{ storageId: string; errors: Array<{ row: number; message: string }> }> {
  const file = await ctx.db.get(job.fileId);
  if (!file || file.organizationId !== job.organizationId) {
    throw new Error("Arquivo original não encontrado");
  }

  const batches = await ctx.db
    .query("importJobBatches")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .take(500);

  const errors: Array<{ row: number; message: string }> = [];
  for (const batch of batches) {
    for (const item of batch.errors) errors.push(item);
  }
  // Job que ainda não rodou: aproveita os erros de amostra do dry-run.
  if (errors.length === 0 && job.dryRun) {
    for (const item of job.dryRun.sampleErrors) {
      errors.push({
        row: item.row,
        message: item.field ? `${item.field}: ${item.message}` : item.message,
      });
    }
  }

  return { storageId: file.storageId, errors };
}

/** Monta o CSV das linhas com erro (colunas originais + coluna de erro). */
function buildFailedRowsCsv(
  csvText: string,
  errors: Array<{ row: number; message: string }>
): string {
  const parsed = parseCsv(csvText);

  const messages = new Map<number, string>();
  for (const item of errors) {
    const previous = messages.get(item.row);
    messages.set(item.row, previous ? `${previous}; ${item.message}` : item.message);
  }

  let errorColumn = "erro";
  while (parsed.headers.includes(errorColumn)) errorColumn = `${errorColumn} (importação)`;

  const rows: Array<Record<string, unknown>> = [];
  for (const [row, message] of Array.from(messages.entries()).sort((a, b) => a[0] - b[0])) {
    const original = parsed.rows[row - 1];
    if (!original) continue;
    rows.push({ ...original, [errorColumn]: message });
  }

  // escapeFormulas: as linhas com erro reproduzem o conteúdo original do
  // arquivo enviado pelo usuário (dado não confiável) — neutraliza fórmula ao
  // abrir de novo no Excel/Sheets.
  return serializeCsv([...parsed.headers, errorColumn], rows, { escapeFormulas: true });
}

// ===== Superfície pública =====

export const createImportJob = mutation({
  args: {
    organizationId: v.id("organizations"),
    entity: entityValidator,
    fileId: v.id("files"),
    fileName: v.string(),
    duplicateStrategy: strategyValidator,
  },
  returns: v.id("importJobs"),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await createImportJobCore(ctx, { ...args, requestedBy: member._id });
  },
});

export const updateMapping = mutation({
  args: {
    organizationId: v.id("organizations"),
    jobId: v.id("importJobs"),
    mapping: v.record(v.string(), v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await updateMappingCore(ctx, args.organizationId, args.jobId, args.mapping);
  },
});

export const runPreview = mutation({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await runPreviewCore(ctx, args.organizationId, args.jobId);
  },
});

export const confirmImport = mutation({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await confirmImportCore(ctx, args.organizationId, args.jobId);
  },
});

export const rollbackImport = mutation({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await rollbackImportCore(ctx, args.organizationId, args.jobId);
  },
});

export const cancelImport = mutation({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const job = await requireJob(ctx, args.organizationId, args.jobId);
    if (job.status !== "mapping" && job.status !== "preview_ready") {
      throw new Error("Só é possível cancelar uma importação que ainda não começou");
    }
    const now = Date.now();
    await ctx.db.patch(args.jobId, { status: "canceled", finishedAt: now });
    await logJobAudit(
      ctx,
      job,
      `Cancelou a importação de ${ENTITY_LABEL[job.entity]} (${job.fileName})`,
      "update",
      { previousStatus: job.status },
      now
    );
    return null;
  },
});

export const getImportJobs = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await ctx.db
      .query("importJobs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(20);
  },
});

export const getImportJob = query({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await requireJob(ctx, args.organizationId, args.jobId);
  },
});

/**
 * CSV só com as linhas que falharam (colunas originais + coluna de erro), para
 * o usuário corrigir e reimportar.
 *
 * É uma ACTION e não uma query porque só o contexto de action consegue ler o
 * conteúdo do arquivo no storage (`ctx.storage.get`); em query só existe
 * `getUrl`/`getMetadata`. Args e retorno seguem o contrato da seção 6 do plano.
 */
export const getFailedRowsCsv = action({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const context: {
      storageId: string;
      errors: Array<{ row: number; message: string }>;
    } = await ctx.runQuery(internal.imports.internalGetFailedRowsContext, {
      organizationId: args.organizationId,
      jobId: args.jobId,
    });

    if (context.errors.length === 0) return "";

    const blob = await ctx.storage.get(context.storageId as Id<"_storage">);
    if (!blob) throw new Error("Arquivo original indisponível no armazenamento");
    return buildFailedRowsCsv(await blob.text(), context.errors);
  },
});

// ===== Internals da REST (`/api/v1/imports/*`) =====
//
// O gate `settings:manage` destas rotas é feito no `router.ts` a partir das
// permissões resolvidas da chave de API (a superfície pública acima usa
// `requirePermission` com o usuário logado, que não existe no contexto REST).
// As chaves do `mapping` chegam aqui JÁ codificadas (`encodeHeaderKey`) — o
// router codifica os cabeçalhos crus do corpo da requisição.

export const internalCreateImportJob = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    entity: entityValidator,
    fileId: v.string(),
    fileName: v.string(),
    duplicateStrategy: strategyValidator,
  },
  returns: v.id("importJobs"),
  handler: async (ctx, args) => {
    const member = await requireApiMember(ctx, args.organizationId, args.teamMemberId);
    const fileId = ctx.db.normalizeId("files", args.fileId);
    if (!fileId) throw new Error("Arquivo não encontrado nesta organização");
    return await createImportJobCore(ctx, {
      organizationId: args.organizationId,
      requestedBy: member._id,
      entity: args.entity,
      fileId,
      fileName: args.fileName,
      duplicateStrategy: args.duplicateStrategy,
    });
  },
});

export const internalListImportJobs = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("importJobs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(20);
  },
});

/**
 * Job de importação da org, aceitando o id como string crua (vem da query
 * string ou do corpo). Id inválido ou de outra org devolve `null` → 404.
 */
export const internalGetImportJob = internalQuery({
  args: { organizationId: v.id("organizations"), jobId: v.string() },
  returns: v.any(), // doc do job ou null
  handler: async (ctx, args) => {
    const jobId = ctx.db.normalizeId("importJobs", args.jobId);
    if (!jobId) return null;
    const job = await ctx.db.get(jobId);
    if (!job || job.organizationId !== args.organizationId) return null;
    return job;
  },
});

export const internalUpdateMapping = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    jobId: v.id("importJobs"),
    mapping: v.record(v.string(), v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) =>
    await updateMappingCore(ctx, args.organizationId, args.jobId, args.mapping),
});

export const internalRunPreview = internalMutation({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => await runPreviewCore(ctx, args.organizationId, args.jobId),
});

export const internalConfirmImport = internalMutation({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => await confirmImportCore(ctx, args.organizationId, args.jobId),
});

export const internalRollbackImport = internalMutation({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => await rollbackImportCore(ctx, args.organizationId, args.jobId),
});

export const internalFailedRowsContext = internalQuery({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const job = await requireJob(ctx, args.organizationId, args.jobId);
    return await collectFailedRows(ctx, job);
  },
});

/** Versão REST do `getFailedRowsCsv` (mesmo CSV, gate na rota). */
export const internalGetFailedRowsCsv = internalAction({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const context: {
      storageId: string;
      errors: Array<{ row: number; message: string }>;
    } = await ctx.runQuery(internal.imports.internalFailedRowsContext, {
      organizationId: args.organizationId,
      jobId: args.jobId,
    });

    if (context.errors.length === 0) return "";

    const blob = await ctx.storage.get(context.storageId as Id<"_storage">);
    if (!blob) throw new Error("Arquivo original indisponível no armazenamento");
    return buildFailedRowsCsv(await blob.text(), context.errors);
  },
});

// ===== Internals de leitura (consumidas pelas actions) =====

export const internalGetJobContext = internalQuery({
  args: { jobId: v.id("importJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const file = await ctx.db.get(job.fileId);
    return {
      job,
      file:
        file && file.organizationId === job.organizationId
          ? { storageId: file.storageId, name: file.name, size: file.size, mimeType: file.mimeType }
          : null,
      fieldDefs: await loadFieldDefs(ctx, job.organizationId),
    };
  },
});

export const internalGetFailedRowsContext = internalQuery({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const job = await requireJob(ctx, args.organizationId, args.jobId);
    return await collectFailedRows(ctx, job);
  },
});

/** Duplicatas em lote (usado pelo dry-run) — um booleano por chave. */
export const internalCheckDuplicates = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    keys: v.array(v.object({ email: v.optional(v.string()), phone: v.optional(v.string()) })),
  },
  returns: v.array(v.boolean()),
  handler: async (ctx, args) => {
    const out: boolean[] = [];
    for (const key of args.keys) {
      let found = false;
      if (key.email) {
        found = Boolean(
          await ctx.db
            .query("contacts")
            .withIndex("by_organization_and_email", (q) =>
              q.eq("organizationId", args.organizationId).eq("email", key.email)
            )
            .first()
        );
      }
      if (!found && key.phone) {
        found = Boolean(
          await ctx.db
            .query("contacts")
            .withIndex("by_organization_and_phone", (q) =>
              q.eq("organizationId", args.organizationId).eq("phone", key.phone)
            )
            .first()
        );
      }
      out.push(found);
    }
    return out;
  },
});

export const internalListBatchIds = internalQuery({
  args: { jobId: v.id("importJobs") },
  returns: v.array(v.id("importJobBatches")),
  handler: async (ctx, args) => {
    const batches = await ctx.db
      .query("importJobBatches")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .take(1000);
    return batches.sort((a, b) => a.batchIndex - b.batchIndex).map((b) => b._id);
  },
});

// ===== Internals de escrita =====

export const internalPatchDetection = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    detectedHeaders: v.array(v.string()),
    suggestedMapping: v.record(v.string(), v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "mapping") return null;
    await ctx.db.patch(args.jobId, {
      detectedHeaders: args.detectedHeaders,
      suggestedMapping: args.suggestedMapping,
      // Pré-preenche o mapeamento: o wizard só precisa ajustar o que quiser.
      mapping: job.mapping ?? args.suggestedMapping,
    });
    return null;
  },
});

export const internalPatchDryRun = internalMutation({
  args: { jobId: v.id("importJobs"), dryRun: dryRunValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "previewing") return null;
    await ctx.db.patch(args.jobId, { dryRun: args.dryRun, status: "preview_ready" });
    return null;
  },
});

/** Claim exatamente-uma-vez da execução (protege contra retry do scheduler). */
export const internalClaimImport = internalMutation({
  args: { jobId: v.id("importJobs") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running" || job.startedAt !== undefined) return false;
    await ctx.db.patch(args.jobId, { startedAt: Date.now() });
    return true;
  },
});

export const internalFailJob = internalMutation({
  args: { jobId: v.id("importJobs"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const terminal = ["completed", "completed_with_errors", "failed", "rolled_back", "canceled"];
    if (terminal.includes(job.status)) return null;

    const now = Date.now();
    await ctx.db.patch(args.jobId, { status: "failed", error: args.error, finishedAt: now });
    await logJobAudit(
      ctx,
      job,
      `Falhou a importação de ${ENTITY_LABEL[job.entity]} (${job.fileName}): ${args.error}`,
      "update",
      { error: args.error },
      now
    );
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: job.organizationId,
      event: "import.failed",
      payload: {
        jobId: args.jobId,
        entity: job.entity,
        fileName: job.fileName,
        error: args.error,
      },
    });
    return null;
  },
});

export const internalFinishImport = internalMutation({
  args: { jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running") return null;

    const now = Date.now();
    const p = job.progress;
    const status = p.failed > 0 ? "completed_with_errors" : "completed";
    await ctx.db.patch(args.jobId, { status, finishedAt: now });
    await logJobAudit(
      ctx,
      job,
      `Concluiu a importação de ${ENTITY_LABEL[job.entity]} (${job.fileName}): ${p.created} criado(s), ${p.updated} atualizado(s), ${p.skipped} pulado(s), ${p.failed} com erro`,
      "update",
      { status, ...p },
      now
    );
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: job.organizationId,
      event: "import.completed",
      payload: {
        jobId: args.jobId,
        entity: job.entity,
        fileName: job.fileName,
        status,
        created: p.created,
        updated: p.updated,
        skipped: p.skipped,
        failed: p.failed,
        total: p.total,
      },
    });
    return null;
  },
});

/**
 * Processa um lote de linhas: coage, resolve duplicata e cria/atualiza/pula.
 * Grava um doc de `importJobBatches` com o rastro do rollback e acumula o
 * progresso no job.
 */
export const internalProcessBatch = internalMutation({
  args: {
    jobId: v.id("importJobs"),
    batchIndex: v.number(),
    headers: v.array(v.string()),
    rows: batchRowsValidator,
  },
  returns: v.object({ shouldContinue: v.boolean() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "running") return { shouldContinue: false };

    const organizationId = job.organizationId;
    const mapping = mappingForHeaders(args.headers, job.mapping);
    const entity = job.entity as ImportEntity;
    const fieldDefs = await loadFieldDefs(ctx, organizationId);
    const now = Date.now();

    const createdIds: string[] = [];
    const updated: Array<{ id: string; before: Record<string, unknown> }> = [];
    const errors: Array<{ row: number; message: string }> = [];
    let created = 0;
    let updatedCount = 0;
    let skipped = 0;
    let failed = 0;

    // Contexto de leads carregado sob demanda (uma vez por lote).
    let leadContext: {
      boards: Doc<"boards">[];
      defaultBoard: Doc<"boards"> | undefined;
      sources: Doc<"leadSources">[];
      members: Doc<"teamMembers">[];
      currency: string;
      stagesByBoard: Map<string, Doc<"stages">[]>;
    } | null = null;

    const getLeadContext = async () => {
      if (leadContext) return leadContext;
      const boards = await ctx.db
        .query("boards")
        .withIndex("by_organization_and_order", (q) => q.eq("organizationId", organizationId))
        .take(200);
      const sources = await ctx.db
        .query("leadSources")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .take(200);
      const members = await ctx.db
        .query("teamMembers")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .take(500);
      const org = await ctx.db.get(organizationId);
      leadContext = {
        boards,
        defaultBoard: boards.find((b) => b.isDefault) ?? boards[0],
        sources,
        members,
        currency: org?.settings.currency ?? "BRL",
        stagesByBoard: new Map(),
      };
      return leadContext;
    };

    const getStages = async (boardId: Id<"boards">) => {
      const context = await getLeadContext();
      const cached = context.stagesByBoard.get(boardId);
      if (cached) return cached;
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", boardId))
        .take(200);
      context.stagesByBoard.set(boardId, stages);
      return stages;
    };

    for (const item of args.rows) {
      const rowData: Record<string, string> = {};
      args.headers.forEach((header, index) => {
        rowData[header] = item.cells[index] ?? "";
      });
      const result = coerceAndValidateRow(rowData, mapping, entity, fieldDefs);
      if (!result.ok) {
        failed++;
        errors.push({
          row: item.row,
          message: result.errors
            .map((e) => (e.field ? `${e.field}: ${e.message}` : e.message))
            .join("; "),
        });
        continue;
      }
      const value = result.value as Record<string, any>;

      try {
        if (entity === "contacts") {
          const existing =
            job.duplicateStrategy === "create"
              ? null
              : await findContactMatch(ctx, organizationId, value.email, value.phone);

          if (existing && job.duplicateStrategy === "skip") {
            skipped++;
            continue;
          }

          if (existing) {
            const before: Record<string, unknown> = {};
            const patch: Record<string, unknown> = {};
            for (const field of CONTACT_FIELDS) {
              const next = value[field];
              if (next === undefined) continue;
              const current = (existing as any)[field];
              // Etiquetas somam (importação nunca apaga etiqueta existente).
              const merged =
                field === "tags"
                  ? Array.from(new Set([...(current ?? []), ...(next as string[])]))
                  : next;
              if (sameValue(current, merged)) continue;
              before[field] = current === undefined ? null : current;
              patch[field] = merged;
            }
            const incomingCf = (value.customFields ?? {}) as Record<string, unknown>;
            if (Object.keys(incomingCf).length > 0) {
              const mergedCf = { ...(existing.customFields ?? {}), ...incomingCf };
              if (!sameValue(existing.customFields, mergedCf)) {
                before.customFields =
                  existing.customFields === undefined ? null : existing.customFields;
                patch.customFields = mergedCf;
              }
            }
            if (Object.keys(patch).length > 0) {
              const merged = { ...existing, ...patch } as Record<string, unknown>;
              patch.searchText = buildSearchText(merged as any) || undefined;
              patch.updatedAt = now;
              await ctx.db.patch(existing._id, patch as any);
              updated.push({ id: existing._id, before });
            }
            updatedCount++;
            continue;
          }

          const doc: Record<string, unknown> = {
            organizationId,
            tags: [],
            createdAt: now,
            updatedAt: now,
          };
          for (const field of CONTACT_FIELDS) {
            if (value[field] !== undefined) doc[field] = value[field];
          }
          const cf = (value.customFields ?? {}) as Record<string, unknown>;
          if (Object.keys(cf).length > 0) doc.customFields = cf;
          doc.searchText = buildSearchText(doc as any) || undefined;
          const contactId = await ctx.db.insert("contacts", doc as any);
          createdIds.push(contactId);
          created++;
          continue;
        }

        // ===== Leads =====
        const context = await getLeadContext();
        const wantedBoard = value.boardName as string | undefined;
        const board =
          (wantedBoard
            ? context.boards.find((b) => normalizeLabel(b.name) === normalizeLabel(wantedBoard))
            : undefined) ?? context.defaultBoard;
        if (!board) {
          failed++;
          errors.push({ row: item.row, message: "Nenhum funil configurado nesta organização" });
          continue;
        }
        const stages = await getStages(board._id);
        const wantedStage = value.stageName as string | undefined;
        const stage =
          (wantedStage
            ? stages.find((s) => normalizeLabel(s.name) === normalizeLabel(wantedStage))
            : undefined) ?? stages[0];
        if (!stage) {
          failed++;
          errors.push({ row: item.row, message: `O funil "${board.name}" não tem estágios` });
          continue;
        }

        let contactId: Id<"contacts"> | undefined;
        const hasContactData =
          value.contactEmail || value.contactPhone || value.contactFirstName ||
          value.contactLastName || value.contactCompany;
        if (hasContactData) {
          const existingContact = await findContactMatch(
            ctx,
            organizationId,
            value.contactEmail,
            value.contactPhone
          );
          if (existingContact) {
            contactId = existingContact._id;
            // Em leads a estratégia "update" atualiza o contato vinculado;
            // "skip"/"create" só reaproveitam o contato (o lead sempre é novo).
            if (job.duplicateStrategy === "update") {
              const before: Record<string, unknown> = {};
              const patch: Record<string, unknown> = {};
              const incoming: Record<string, unknown> = {
                firstName: value.contactFirstName,
                lastName: value.contactLastName,
                email: value.contactEmail,
                phone: value.contactPhone,
                company: value.contactCompany,
              };
              for (const [field, next] of Object.entries(incoming)) {
                if (next === undefined) continue;
                const current = (existingContact as any)[field];
                if (sameValue(current, next)) continue;
                before[field] = current === undefined ? null : current;
                patch[field] = next;
              }
              if (Object.keys(patch).length > 0) {
                const merged = { ...existingContact, ...patch } as Record<string, unknown>;
                patch.searchText = buildSearchText(merged as any) || undefined;
                patch.updatedAt = now;
                await ctx.db.patch(existingContact._id, patch as any);
                updated.push({ id: existingContact._id, before });
              }
            }
          } else {
            const contactDoc: Record<string, unknown> = {
              organizationId,
              firstName: value.contactFirstName,
              lastName: value.contactLastName,
              email: value.contactEmail,
              phone: value.contactPhone,
              company: value.contactCompany,
              tags: [],
              createdAt: now,
              updatedAt: now,
            };
            contactDoc.searchText = buildSearchText(contactDoc as any) || undefined;
            contactId = await ctx.db.insert("contacts", contactDoc as any);
            createdIds.push(contactId);
          }
        }

        const assigneeEmail = (value.assigneeEmail as string | undefined)?.toLowerCase();
        const assignee = assigneeEmail
          ? context.members.find((m) => (m.email ?? "").toLowerCase() === assigneeEmail)
          : undefined;
        const sourceName = value.sourceName as string | undefined;
        const source = sourceName
          ? context.sources.find((s) => normalizeLabel(s.name) === normalizeLabel(sourceName))
          : undefined;

        const leadId = await ctx.db.insert("leads", {
          organizationId,
          title: String(value.title),
          contactId,
          boardId: board._id,
          stageId: stage._id,
          assignedTo: assignee?._id,
          value: typeof value.value === "number" ? value.value : 0,
          currency: (value.currency as string) || context.currency,
          priority: (value.priority as any) ?? "medium",
          temperature: (value.temperature as any) ?? "cold",
          sourceId: source?._id,
          tags: (value.tags as string[]) ?? [],
          customFields: (value.customFields as Record<string, any>) ?? {},
          conversationStatus: "new",
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        });
        createdIds.push(leadId);
        created++;
      } catch (e: any) {
        failed++;
        errors.push({ row: item.row, message: String(e?.message ?? e) });
      }
    }

    await ctx.db.insert("importJobBatches", {
      organizationId,
      jobId: args.jobId,
      batchIndex: args.batchIndex,
      createdIds,
      updated,
      errors,
      createdAt: now,
    });

    const fresh = await ctx.db.get(args.jobId);
    if (fresh && fresh.status === "running") {
      await ctx.db.patch(args.jobId, {
        progress: {
          processed: fresh.progress.processed + args.rows.length,
          total: Math.max(fresh.progress.total, fresh.progress.processed + args.rows.length),
          created: fresh.progress.created + created,
          updated: fresh.progress.updated + updatedCount,
          skipped: fresh.progress.skipped + skipped,
          failed: fresh.progress.failed + failed,
        },
      });
    }

    return { shouldContinue: Boolean(fresh && fresh.status === "running") };
  },
});

/**
 * Rollback de um lote (regra 9): apaga o que foi criado (leads antes de
 * contatos) e reverte o que foi atualizado aplicando `before` — `null` no
 * `before` significa "campo não existia" e é removido do doc.
 */
export const internalRollbackBatch = internalMutation({
  args: { jobId: v.id("importJobs"), batchId: v.id("importJobBatches") },
  returns: v.object({ deleted: v.number(), reverted: v.number() }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const batch = await ctx.db.get(args.batchId);
    if (!job || !batch || batch.jobId !== args.jobId) return { deleted: 0, reverted: 0 };
    if (batch.organizationId !== job.organizationId) return { deleted: 0, reverted: 0 };

    const now = Date.now();
    let deleted = 0;
    let reverted = 0;

    const leadIds: Id<"leads">[] = [];
    const contactIds: Id<"contacts">[] = [];
    for (const raw of batch.createdIds) {
      const leadId = ctx.db.normalizeId("leads", raw);
      if (leadId) {
        leadIds.push(leadId);
        continue;
      }
      const contactId = ctx.db.normalizeId("contacts", raw);
      if (contactId) contactIds.push(contactId);
    }

    // Leads primeiro: contato criado pela importação pode estar referenciado.
    for (const leadId of leadIds) {
      const lead = await ctx.db.get(leadId);
      if (!lead || lead.organizationId !== job.organizationId) continue;
      await ctx.db.delete(leadId);
      deleted++;
    }
    for (const contactId of contactIds) {
      const contact = await ctx.db.get(contactId);
      if (!contact || contact.organizationId !== job.organizationId) continue;
      const stillLinked = await ctx.db
        .query("leads")
        .withIndex("by_contact", (q) => q.eq("contactId", contactId))
        .first();
      if (stillLinked) continue; // outro lead passou a usar o contato — preserva
      await ctx.db.delete(contactId);
      deleted++;
    }

    for (const item of batch.updated) {
      const contactId = ctx.db.normalizeId("contacts", item.id);
      if (!contactId) continue;
      const contact = await ctx.db.get(contactId);
      if (!contact || contact.organizationId !== job.organizationId) continue;
      const patch: Record<string, unknown> = {};
      for (const [field, before] of Object.entries(item.before)) {
        patch[field] = before === null ? undefined : before;
      }
      if (Object.keys(patch).length === 0) continue;
      const merged: Record<string, unknown> = { ...contact };
      for (const [field, next] of Object.entries(patch)) {
        if (next === undefined) delete merged[field];
        else merged[field] = next;
      }
      patch.searchText = buildSearchText(merged as any) || undefined;
      patch.updatedAt = now;
      await ctx.db.patch(contactId, patch as any);
      reverted++;
    }

    return { deleted, reverted };
  },
});

export const internalFinishRollback = internalMutation({
  args: { jobId: v.id("importJobs"), deleted: v.number(), reverted: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    if (job.status !== "completed" && job.status !== "completed_with_errors") return null;

    const now = Date.now();
    await ctx.db.patch(args.jobId, { status: "rolled_back", finishedAt: now });
    await logJobAudit(
      ctx,
      job,
      `Desfez a importação de ${ENTITY_LABEL[job.entity]} (${job.fileName}): ${args.deleted} registro(s) apagado(s), ${args.reverted} revertido(s)`,
      "update",
      { deleted: args.deleted, reverted: args.reverted },
      now
    );
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: job.organizationId,
      event: "import.rolled_back",
      payload: {
        jobId: args.jobId,
        entity: job.entity,
        fileName: job.fileName,
        deleted: args.deleted,
        reverted: args.reverted,
      },
    });
    return null;
  },
});
