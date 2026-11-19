/**
 * Peças compartilhadas pelo import de CSV (`imports.ts`) e pela importação de
 * contatos do celular (`phoneContactsImport.ts`, PR6):
 *
 * - **Job travado** (`releaseStaleImports`): job `running` cujo batimento
 *   (`heartbeatAt`, gravado a cada lote; senão `startedAt`/`createdAt`) passou
 *   de `STALE_IMPORT_MS` é encerrado como `failed` — a vaga de "1 importação
 *   ativa por org" volta e a fila `importStagedRows` dele é apagada. `failed`
 *   pode ser desfeito (o que já foi gravado tem trilha em `importJobBatches`).
 * - **Lead importado** (`insertImportedLead`): o insert único do lead criado
 *   por importação (etapa → `leadCreationStagePatch`; contato fora do comercial
 *   → nasce arquivado). Sem activity/audit/webhook por lead (exceção
 *   deliberada do import; a trilha fica em `importJobBatches`).
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { autoLeadArchivePatch, type ContactRelation } from "./contactRelation";
import { leadCreationStagePatch } from "./leadStageMove";

/** Sem batimento há mais que isso = a execução morreu (lote leva segundos). */
export const STALE_IMPORT_MS = 15 * 60 * 1000;
export const STALE_IMPORT_ERROR = "A importação parou de responder e foi encerrada. O que já foi gravado pode ser desfeito.";

/** Momento do último sinal de vida de um job. */
export function lastImportBeat(job: Pick<Doc<"importJobs">, "heartbeatAt" | "startedAt" | "createdAt">): number {
  return job.heartbeatAt ?? job.startedAt ?? job.createdAt;
}

/** Job em execução sem batimento dentro da janela. */
export function isStaleRunningImport(
  job: Pick<Doc<"importJobs">, "status" | "heartbeatAt" | "startedAt" | "createdAt">,
  now: number,
): boolean {
  return job.status === "running" && now - lastImportBeat(job) > STALE_IMPORT_MS;
}

/** Apaga a fila transitória de um job (até `limit` docs por chamada). */
export async function deleteStagedRows(ctx: MutationCtx, jobId: Id<"importJobs">, limit = 200): Promise<number> {
  const docs = await ctx.db
    .query("importStagedRows")
    .withIndex("by_job_and_chunk", (q) => q.eq("jobId", jobId))
    .take(limit);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length;
}

/** Encerra um job travado como `failed` (audit + fila apagada). */
export async function failStaleImport(
  ctx: MutationCtx,
  job: Doc<"importJobs">,
  now: number,
  reason: string = STALE_IMPORT_ERROR,
): Promise<void> {
  await ctx.db.patch(job._id, { status: "failed", error: reason, finishedAt: now });
  await deleteStagedRows(ctx, job._id);
  await ctx.db.insert("auditLogs", {
    organizationId: job.organizationId,
    entityType: "importJob",
    entityId: job._id,
    action: "update",
    actorId: job.requestedBy,
    actorType: "system",
    metadata: { entity: job.entity, fileName: job.fileName, source: job.source, lastBeatAt: lastImportBeat(job) },
    description: `Encerrou a importação travada de ${job.fileName}`,
    severity: "medium",
    createdAt: now,
  });
}

/** Libera a vaga: encerra os jobs `running` travados da org. Devolve quantos. */
export async function releaseStaleImports(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  now: number,
): Promise<number> {
  const running = await ctx.db
    .query("importJobs")
    .withIndex("by_organization_and_status", (q) => q.eq("organizationId", organizationId).eq("status", "running"))
    .take(10);
  let released = 0;
  for (const job of running) {
    if (!isStaleRunningImport(job, now)) continue;
    await failStaleImport(ctx, job, now);
    released++;
  }
  return released;
}

/** Insert único do lead criado por importação (CSV e celular). */
export async function insertImportedLead(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    title: string;
    contactId?: Id<"contacts">;
    /** Tipo do contato: fora do comercial → lead nasce arquivado. */
    contactRelation?: ContactRelation | null;
    board: Doc<"boards">;
    stage: Doc<"stages">;
    currency: string;
    now: number;
    assignedTo?: Id<"teamMembers">;
    value?: number;
    priority?: Doc<"leads">["priority"];
    temperature?: Doc<"leads">["temperature"];
    sourceId?: Id<"leadSources">;
    tags?: string[];
    customFields?: Record<string, unknown>;
  },
): Promise<Id<"leads">> {
  const { now } = args;
  return await ctx.db.insert("leads", {
    ...autoLeadArchivePatch(args.contactRelation, now),
    organizationId: args.organizationId,
    title: args.title,
    contactId: args.contactId,
    boardId: args.board._id,
    stageId: args.stage._id,
    assignedTo: args.assignedTo,
    value: args.value ?? 0,
    currency: args.currency,
    priority: args.priority ?? "medium",
    temperature: args.temperature ?? "cold",
    sourceId: args.sourceId,
    tags: args.tags ?? [],
    customFields: args.customFields ?? {},
    conversationStatus: "new",
    // Lead importado direto numa etapa fechada já nasce fechado (closedAt/closedType).
    ...leadCreationStagePatch(args.stage, now),
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  });
}
