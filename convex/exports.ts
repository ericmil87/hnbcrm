/**
 * Export de dados (F1 CSV por entidade + F2 backup completo JSON).
 *
 * Fluxo: `createExportJob` (gate `settings:manage`) grava um job `queued` e
 * agenda `internalRunExport`. A action pagina a(s) tabela(s) em blocos de 500
 * via `internalCollectPage`, monta o CSV (`lib/csv.ts` + `lib/exportColumns.ts`)
 * ou o backup JSON (seção 7 do plano, sanitizado por `lib/exportSanitize.ts`),
 * guarda o blob no File Storage e fecha o job com auditoria + webhook. O blob
 * expira em 7 dias e é apagado pelo cron `cleanup expired exports`.
 *
 * Regras seguidas aqui: org-scoping em todo doc lido, só `.withIndex()`,
 * validators em toda função, `Date.now()` nunca em query, e nenhum segredo no
 * arquivo gerado (denylist central + teste de build `exportSecurity.test.ts`).
 */
import { v } from "convex/values";
import {
  mutation,
  query,
  internalQuery,
  internalMutation,
  internalAction,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { parseCursor, buildCursorFromCreationTime, paginateResults } from "./lib/cursor";
import { serializeCsv } from "./lib/csv";
import {
  buildExportColumns,
  buildExportRow,
  ENTITY_LABELS,
  type ExportEntity,
  type ExportFieldDef,
  type ExportLookups,
} from "./lib/exportColumns";
import { sanitizeDocument, EXCLUDED_BACKUP_TABLES } from "./lib/exportSanitize";

// ===== Constantes =====

/** Docs por página de leitura (regra 5 do plano). */
const PAGE_SIZE = 500;
/** Teto defensivo de linhas num CSV (evita estourar memória da action). */
const MAX_EXPORT_ROWS = 100_000;
/** Teto defensivo de documentos num backup completo. */
const MAX_BACKUP_DOCS = 200_000;
/** Validade do blob no storage. */
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Job ativo mais velho que isto é considerado travado e não bloqueia novos. */
const STALE_JOB_MS = 30 * 60 * 1000;
/** Margem de leitura na paginação (só o doc do cursor pode ser descartado). */
const CURSOR_OVERREAD = 2;

const ACTIVE_STATUSES = ["queued", "running"] as const;

/**
 * Tabelas do backup completo, NA ORDEM da seção 7 do plano (dependências antes
 * dos dependentes). O que não está aqui não sai da organização.
 */
export const BACKUP_TABLES: readonly string[] = [
  "organizations",
  "teamMembers",
  "boards",
  "stages",
  "leadSources",
  "fieldDefinitions",
  "taskProjects",
  "taskColumns",
  "taskLabels",
  "conversationLabels",
  "quickReplies",
  "contacts",
  "leads",
  "conversations",
  "messages",
  "activities",
  "tasks",
  "taskComments",
  "handoffs",
  "calendarEvents",
  "savedViews",
  "webhooks",
];

/** Tabelas que `internalCollectPage` aceita paginar. */
const PAGEABLE_TABLES = new Set<string>(BACKUP_TABLES.filter((t) => t !== "organizations"));

const BACKUP_FORMAT = "hnbcrm-backup";
const BACKUP_VERSION = 1;

// ===== Helpers puros =====

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `hnbcrm-contatos-2026-08-23.csv` / `hnbcrm-backup-2026-08-23.json` */
function buildFileName(scope: string, entity: string | undefined, format: string, now: number): string {
  const date = new Date(now);
  const stamp = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const label = scope === "full_backup" ? "backup" : (ENTITY_LABELS[entity as ExportEntity] ?? entity ?? "dados");
  return `hnbcrm-${label}-${stamp}.${format}`;
}

function toMap(rows: Array<{ id: string } & Record<string, unknown>>): Map<string, any> {
  const map = new Map<string, any>();
  for (const row of rows ?? []) map.set(row.id, row);
  return map;
}

// ===== Núcleo compartilhado (app + REST) =====

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

interface CreateExportInput {
  organizationId: Id<"organizations">;
  requestedBy: Id<"teamMembers">;
  format: "csv" | "json";
  scope: "entity" | "full_backup";
  entity?: "contacts" | "leads" | "tasks";
  columns?: string[];
}

/**
 * Cria o job de export: validações de contrato, liberação de job travado,
 * insert, auditoria e agendamento. Compartilhado pela mutation pública
 * (`createExportJob`, gate `settings:manage`) e pela internal da REST
 * (`internalCreateExportJob`, gate feito no router pela chave de API).
 */
async function createExportJobCore(
  ctx: MutationCtx,
  args: CreateExportInput
): Promise<Id<"exportJobs">> {
  if (args.scope === "entity" && !args.entity) {
    throw new Error("Informe a entidade a exportar (contatos, leads ou tarefas)");
  }
  if (args.scope === "entity" && args.format !== "csv") {
    throw new Error("Exportação por entidade está disponível só em CSV");
  }
  if (args.scope === "full_backup" && args.format !== "json") {
    throw new Error("Backup completo está disponível só em JSON");
  }

  const now = Date.now();

  // 1 job ativo por org: jobs travados (> 30 min) são fechados como falha e
  // liberam a fila em vez de bloquear a organização para sempre.
  for (const status of ACTIVE_STATUSES) {
    const active = await ctx.db
      .query("exportJobs")
      .withIndex("by_organization_and_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", status)
      )
      .take(25);
    for (const job of active) {
      if (now - job.createdAt < STALE_JOB_MS) {
        throw new Error("Já existe uma exportação em andamento nesta organização");
      }
      await ctx.db.patch(job._id, {
        status: "failed",
        error: "Exportação expirou sem concluir",
        finishedAt: now,
      });
      await ctx.db.insert("auditLogs", {
        organizationId: args.organizationId,
        entityType: "exportJob",
        entityId: job._id,
        action: "update",
        actorId: args.requestedBy,
        actorType: "system",
        metadata: { scope: job.scope, entity: job.entity, status: "failed" },
        description: "Encerrou exportação travada (sem conclusão em 30 minutos)",
        severity: job.scope === "full_backup" ? "high" : "medium",
        createdAt: now,
      });
    }
  }

  const jobId = await ctx.db.insert("exportJobs", {
    organizationId: args.organizationId,
    requestedBy: args.requestedBy,
    status: "queued",
    format: args.format,
    scope: args.scope,
    entity: args.entity,
    columns: args.columns,
    progress: { processed: 0 },
    expiresAt: now + EXPIRY_MS,
    createdAt: now,
  });

  const what =
    args.scope === "full_backup"
      ? "backup completo (JSON)"
      : `${ENTITY_LABELS[args.entity as ExportEntity]} (CSV)`;

  await ctx.db.insert("auditLogs", {
    organizationId: args.organizationId,
    entityType: "exportJob",
    entityId: jobId,
    action: "create",
    actorId: args.requestedBy,
    actorType: "human",
    metadata: { scope: args.scope, entity: args.entity, format: args.format },
    description: `Solicitou exportação de ${what}`,
    severity: args.scope === "full_backup" ? "high" : "medium",
    createdAt: now,
  });

  await ctx.scheduler.runAfter(0, internal.exports.internalRunExport, { jobId });

  return jobId;
}

// ===== Superfície pública (gate settings:manage em todas) =====

export const createExportJob = mutation({
  args: {
    organizationId: v.id("organizations"),
    format: v.union(v.literal("csv"), v.literal("json")),
    scope: v.union(v.literal("entity"), v.literal("full_backup")),
    entity: v.optional(
      v.union(v.literal("contacts"), v.literal("leads"), v.literal("tasks"))
    ),
    columns: v.optional(v.array(v.string())),
  },
  returns: v.id("exportJobs"),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await createExportJobCore(ctx, { ...args, requestedBy: member._id });
  },
});

export const getExportJobs = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    return await ctx.db
      .query("exportJobs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(20);
  },
});

export const getExportJob = query({
  args: { organizationId: v.id("organizations"), jobId: v.id("exportJobs") },
  returns: v.any(), // doc do job ou null
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.organizationId !== args.organizationId) return null;
    return job;
  },
});

export const getExportDownloadUrl = query({
  args: { organizationId: v.id("organizations"), jobId: v.id("exportJobs") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.organizationId !== args.organizationId) return null;
    if (job.status !== "completed" || !job.resultStorageId) return null;
    // Job expirado já teve o blob apagado pelo cron → getUrl devolve null.
    return await ctx.storage.getUrl(job.resultStorageId);
  },
});

// ===== Internals da REST (`/api/v1/exports/*`) =====
//
// O gate `settings:manage` destas rotas é feito no `router.ts` a partir das
// permissões resolvidas da chave de API (a superfície pública acima usa
// `requirePermission` com o usuário logado, que não existe no contexto REST).

export const internalCreateExportJob = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    format: v.union(v.literal("csv"), v.literal("json")),
    scope: v.union(v.literal("entity"), v.literal("full_backup")),
    entity: v.optional(
      v.union(v.literal("contacts"), v.literal("leads"), v.literal("tasks"))
    ),
    columns: v.optional(v.array(v.string())),
  },
  returns: v.id("exportJobs"),
  handler: async (ctx, args) => {
    const member = await requireApiMember(ctx, args.organizationId, args.teamMemberId);
    return await createExportJobCore(ctx, {
      organizationId: args.organizationId,
      requestedBy: member._id,
      format: args.format,
      scope: args.scope,
      entity: args.entity,
      columns: args.columns,
    });
  },
});

export const internalListExportJobs = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("exportJobs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(20);
  },
});

/**
 * Job de export da org, aceitando o id como string crua (vem da query string).
 * Id inválido ou de outra organização devolve `null` → 404 no router.
 */
export const internalGetExportJob = internalQuery({
  args: { organizationId: v.id("organizations"), jobId: v.string() },
  returns: v.any(), // doc do job ou null
  handler: async (ctx, args) => {
    const jobId = ctx.db.normalizeId("exportJobs", args.jobId);
    if (!jobId) return null;
    const job = await ctx.db.get(jobId);
    if (!job || job.organizationId !== args.organizationId) return null;
    return job;
  },
});

// ===== Internals de leitura =====

export const internalGetJob = internalQuery({
  args: { jobId: v.id("exportJobs") },
  returns: v.any(), // doc do job ou null
  handler: async (ctx, args) => await ctx.db.get(args.jobId),
});

/**
 * Uma página de até 500 docs de `table`, escopada na org e ordenada por
 * `_creationTime` crescente. Cursor `"<_creationTime>|<_id>"` (`lib/cursor.ts`).
 */
export const internalCollectPage = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    table: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    docs: v.array(v.any()),
    nextCursor: v.union(v.string(), v.null()),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (!PAGEABLE_TABLES.has(args.table)) {
      throw new Error(`Tabela "${args.table}" não é exportável`);
    }
    const limit = Math.min(Math.max(args.limit ?? PAGE_SIZE, 1), PAGE_SIZE);
    const cursor = parseCursor(args.cursor);

    // `stages` é a única tabela do backup sem índice by_organization: vem pelos
    // boards da org (poucas dezenas por board, coleção limitada).
    if (args.table === "stages") {
      const boards = await ctx.db
        .query("boards")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .take(500);
      const docs: any[] = [];
      for (const board of boards) {
        const stages = await ctx.db
          .query("stages")
          .withIndex("by_board", (q) => q.eq("boardId", board._id))
          .take(200);
        for (const stage of stages) {
          if (stage.organizationId === args.organizationId) docs.push(stage);
        }
      }
      return { docs, nextCursor: null, hasMore: false };
    }

    const raw = await ctx.db
      .query(args.table as any)
      .withIndex("by_organization", (q: any) => {
        const scoped = q.eq("organizationId", args.organizationId);
        return cursor ? scoped.gte("_creationTime", cursor.ts) : scoped;
      })
      .order("asc")
      .take(limit + 1 + (cursor ? CURSOR_OVERREAD : 0));

    // `_creationTime` é único por tabela: só o doc do próprio cursor pode voltar.
    const filtered = cursor
      ? raw.filter(
          (doc: any) =>
            doc._creationTime > cursor.ts ||
            (doc._creationTime === cursor.ts && doc._id > cursor.id)
        )
      : raw;

    const { items, nextCursor, hasMore } = paginateResults(
      filtered as any[],
      limit,
      buildCursorFromCreationTime as any
    );

    return { docs: items, nextCursor, hasMore };
  },
});

/** A própria organização (backup completo inclui só ela). */
export const internalGetOrganization = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(), // doc do job ou null
  handler: async (ctx, args) => await ctx.db.get(args.organizationId),
});

/**
 * Tabelas pequenas usadas para desnormalizar o CSV (boards, estágios, membros,
 * origens, projetos, colunas, etiquetas) + custom fields da org.
 */
export const internalGetLookups = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    entity: v.union(v.literal("contacts"), v.literal("leads"), v.literal("tasks")),
  },
  returns: v.object({
    boards: v.array(v.any()),
    stages: v.array(v.any()),
    members: v.array(v.any()),
    sources: v.array(v.any()),
    projects: v.array(v.any()),
    columns: v.array(v.any()),
    labels: v.array(v.any()),
    fieldDefs: v.array(v.any()),
  }),
  handler: async (ctx, args) => {
    const org = args.organizationId;
    const empty: any[] = [];

    const members = args.entity === "contacts"
      ? empty
      : (
          await ctx.db
            .query("teamMembers")
            .withIndex("by_organization", (q) => q.eq("organizationId", org))
            .take(1000)
        ).map((m) => ({ id: m._id, name: m.name, email: m.email ?? "" }));

    let boards: any[] = empty;
    let stages: any[] = empty;
    let sources: any[] = empty;
    if (args.entity === "leads") {
      const boardDocs = await ctx.db
        .query("boards")
        .withIndex("by_organization", (q) => q.eq("organizationId", org))
        .take(500);
      boards = boardDocs.map((b) => ({ id: b._id, name: b.name }));
      const stageDocs: any[] = [];
      for (const board of boardDocs) {
        const perBoard = await ctx.db
          .query("stages")
          .withIndex("by_board", (q) => q.eq("boardId", board._id))
          .take(200);
        stageDocs.push(...perBoard);
      }
      stages = stageDocs.map((s) => ({ id: s._id, name: s.name }));
      sources = (
        await ctx.db
          .query("leadSources")
          .withIndex("by_organization", (q) => q.eq("organizationId", org))
          .take(500)
      ).map((s) => ({ id: s._id, name: s.name }));
    }

    let projects: any[] = empty;
    let columns: any[] = empty;
    let labels: any[] = empty;
    if (args.entity === "tasks") {
      projects = (
        await ctx.db
          .query("taskProjects")
          .withIndex("by_organization", (q) => q.eq("organizationId", org))
          .take(500)
      ).map((p) => ({ id: p._id, name: p.name }));
      columns = (
        await ctx.db
          .query("taskColumns")
          .withIndex("by_organization", (q) => q.eq("organizationId", org))
          .take(1000)
      ).map((c) => ({ id: c._id, name: c.name }));
      labels = (
        await ctx.db
          .query("taskLabels")
          .withIndex("by_organization", (q) => q.eq("organizationId", org))
          .take(500)
      ).map((l) => ({ id: l._id, name: l.name }));
    }

    const fieldDefs =
      args.entity === "tasks"
        ? empty
        : (
            await ctx.db
              .query("fieldDefinitions")
              .withIndex("by_organization", (q) => q.eq("organizationId", org))
              .take(500)
          ).map((d) => ({
            key: d.key,
            name: d.name,
            type: d.type,
            entityType: d.entityType ?? null,
            order: d.order,
          }));

    return { boards, stages, members, sources, projects, columns, labels, fieldDefs };
  },
});

/**
 * Resolve, por página, só as referências grandes (contatos de leads/tarefas e
 * leads de tarefas) — nunca carrega a tabela inteira na memória da action.
 */
export const internalResolveRefs = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    contactIds: v.optional(v.array(v.string())),
    leadIds: v.optional(v.array(v.string())),
  },
  returns: v.object({ contacts: v.array(v.any()), leads: v.array(v.any()) }),
  handler: async (ctx, args) => {
    const uniqueContacts = [...new Set(args.contactIds ?? [])].slice(0, PAGE_SIZE * 2);
    const uniqueLeads = [...new Set(args.leadIds ?? [])].slice(0, PAGE_SIZE * 2);

    const contacts: any[] = [];
    for (const id of uniqueContacts) {
      const doc: any = await ctx.db.get(id as Id<"contacts">);
      if (doc && doc.organizationId === args.organizationId) {
        contacts.push({
          id: doc._id,
          firstName: doc.firstName ?? "",
          lastName: doc.lastName ?? "",
          email: doc.email ?? "",
          phone: doc.phone ?? "",
        });
      }
    }

    const leads: any[] = [];
    for (const id of uniqueLeads) {
      const doc: any = await ctx.db.get(id as Id<"leads">);
      if (doc && doc.organizationId === args.organizationId) {
        leads.push({ id: doc._id, title: doc.title ?? "" });
      }
    }

    return { contacts, leads };
  },
});

// ===== Internals de escrita =====

export const internalStartJob = internalMutation({
  args: { jobId: v.id("exportJobs") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "queued") return false;
    await ctx.db.patch(args.jobId, { status: "running", startedAt: Date.now() });
    return true;
  },
});

export const internalUpdateProgress = internalMutation({
  args: {
    jobId: v.id("exportJobs"),
    processed: v.number(),
    total: v.optional(v.number()),
    currentEntity: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    await ctx.db.patch(args.jobId, {
      progress: {
        processed: args.processed,
        total: args.total,
        currentEntity: args.currentEntity,
      },
    });
    return null;
  },
});

/** Fecha o job (completed/failed) + auditoria + webhook F8. */
export const internalFinishJob = internalMutation({
  args: {
    jobId: v.id("exportJobs"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    resultStorageId: v.optional(v.id("_storage")),
    resultFileName: v.optional(v.string()),
    resultSize: v.optional(v.number()),
    rowCount: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const now = Date.now();

    await ctx.db.patch(args.jobId, {
      status: args.status,
      resultStorageId: args.resultStorageId,
      resultFileName: args.resultFileName,
      resultSize: args.resultSize,
      rowCount: args.rowCount,
      error: args.error,
      finishedAt: now,
      progress: {
        processed: args.rowCount ?? job.progress.processed,
        total: args.rowCount ?? job.progress.total,
        currentEntity: undefined,
      },
    });

    const what =
      job.scope === "full_backup"
        ? "backup completo (JSON)"
        : `${ENTITY_LABELS[job.entity as ExportEntity] ?? job.entity} (CSV)`;

    await ctx.db.insert("auditLogs", {
      organizationId: job.organizationId,
      entityType: "exportJob",
      entityId: args.jobId,
      action: "update",
      actorId: job.requestedBy,
      actorType: "system",
      metadata: {
        scope: job.scope,
        entity: job.entity,
        format: job.format,
        status: args.status,
        rowCount: args.rowCount,
        fileName: args.resultFileName,
        size: args.resultSize,
      },
      description:
        args.status === "completed"
          ? `Concluiu a exportação de ${what} (${args.rowCount ?? 0} registros)`
          : `Falhou a exportação de ${what}: ${args.error ?? "erro desconhecido"}`,
      severity: job.scope === "full_backup" ? "high" : "medium",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: job.organizationId,
      event: args.status === "completed" ? "export.completed" : "export.failed",
      payload: {
        jobId: args.jobId,
        scope: job.scope,
        entity: job.entity ?? null,
        format: job.format,
        status: args.status,
        rowCount: args.rowCount ?? 0,
        fileName: args.resultFileName ?? null,
        size: args.resultSize ?? 0,
        error: args.error ?? null,
        expiresAt: job.expiresAt,
        requestedBy: job.requestedBy,
      },
    });

    return null;
  },
});

/**
 * Cron horário: apaga o blob dos exports concluídos que passaram da validade
 * (7 dias). O doc do job fica no histórico, só sem `resultStorageId`.
 */
export const internalCleanupExpired = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("exportJobs")
      .withIndex("by_status_and_expires", (q) =>
        q.eq("status", "completed").lt("expiresAt", now)
      )
      .take(100);

    let deleted = 0;
    for (const job of expired) {
      if (!job.resultStorageId) continue;
      try {
        await ctx.storage.delete(job.resultStorageId);
      } catch {
        // Blob já removido: segue e limpa o ponteiro do job.
      }
      await ctx.db.patch(job._id, { resultStorageId: undefined });
      deleted++;
    }

    return { deleted };
  },
});

// ===== Execução =====

const ENTITY_TABLE: Record<ExportEntity, string> = {
  contacts: "contacts",
  leads: "leads",
  tasks: "tasks",
};

export const internalRunExport = internalAction({
  args: { jobId: v.id("exportJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Anotações explícitas: cortam a inferência circular entre a action e o
    // `internal.exports` gerado a partir deste próprio módulo.
    const started: boolean = await ctx.runMutation(internal.exports.internalStartJob, {
      jobId: args.jobId,
    });
    if (!started) return null;

    const job: any = await ctx.runQuery(internal.exports.internalGetJob, { jobId: args.jobId });
    if (!job) return null;

    try {
      const now = Date.now();
      const fileName = buildFileName(job.scope, job.entity, job.format, now);
      const { content, mimeType, rowCount } =
        job.scope === "full_backup"
          ? await runBackup(ctx, job, now)
          : await runEntityCsv(ctx, job);

      const blob = new Blob([content], { type: mimeType });
      const resultStorageId = await ctx.storage.store(blob);

      await ctx.runMutation(internal.exports.internalFinishJob, {
        jobId: args.jobId,
        status: "completed",
        resultStorageId,
        resultFileName: fileName,
        resultSize: blob.size,
        rowCount,
      });
    } catch (error) {
      await ctx.runMutation(internal.exports.internalFinishJob, {
        jobId: args.jobId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  },
});

/** CSV de uma entidade, paginado em blocos de 500. */
async function runEntityCsv(
  ctx: any,
  job: any
): Promise<{ content: string; mimeType: string; rowCount: number }> {
  const entity = job.entity as ExportEntity;
  if (!entity) throw new Error("Job sem entidade definida");

  const raw = await ctx.runQuery(internal.exports.internalGetLookups, {
    organizationId: job.organizationId,
    entity,
  });

  const fieldDefs: ExportFieldDef[] = raw.fieldDefs;
  const columns = buildExportColumns(entity, fieldDefs, job.columns ?? null);
  const baseLookups: ExportLookups = {
    boards: toMap(raw.boards),
    stages: toMap(raw.stages),
    members: toMap(raw.members),
    sources: toMap(raw.sources),
    projects: toMap(raw.projects),
    columns: toMap(raw.columns),
    labels: toMap(raw.labels),
  };

  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;

  do {
    const page: any = await ctx.runQuery(internal.exports.internalCollectPage, {
      organizationId: job.organizationId,
      table: ENTITY_TABLE[entity],
      cursor: cursor ?? undefined,
      limit: PAGE_SIZE,
    });

    const contactIds: string[] = [];
    const leadIds: string[] = [];
    for (const doc of page.docs) {
      if (doc.contactId) contactIds.push(doc.contactId);
      if (entity === "tasks" && doc.leadId) leadIds.push(doc.leadId);
    }

    let pageLookups = baseLookups;
    if (contactIds.length > 0 || leadIds.length > 0) {
      const refs: any = await ctx.runQuery(internal.exports.internalResolveRefs, {
        organizationId: job.organizationId,
        contactIds,
        leadIds,
      });
      pageLookups = {
        ...baseLookups,
        contacts: toMap(refs.contacts),
        leads: toMap(refs.leads),
      };
    }

    for (const doc of page.docs) {
      rows.push(buildExportRow(entity, doc, pageLookups, fieldDefs));
    }

    if (rows.length > MAX_EXPORT_ROWS) {
      throw new Error(
        `Exportação acima do limite de ${MAX_EXPORT_ROWS} linhas — filtre os dados ou peça o backup completo`
      );
    }

    await ctx.runMutation(internal.exports.internalUpdateProgress, {
      jobId: job._id,
      processed: rows.length,
      currentEntity: entity,
    });

    cursor = page.nextCursor;
  } while (cursor);

  return {
    // escapeFormulas: dado de outra org/lead pode ter sido digitado por um
    // contato mal-intencionado — neutraliza CSV formula injection ao abrir a
    // planilha no Excel/Sheets (regra 1 do plano de export/import).
    content: serializeCsv(columns, rows, { escapeFormulas: true }),
    mimeType: "text/csv;charset=utf-8",
    rowCount: rows.length,
  };
}

/** Backup completo JSON (seção 7): tabelas na ordem, tudo sanitizado. */
async function runBackup(
  ctx: any,
  job: any,
  now: number
): Promise<{ content: string; mimeType: string; rowCount: number }> {
  const entities: Record<string, Array<Record<string, unknown>>> = {};
  let total = 0;

  for (const table of BACKUP_TABLES) {
    if (EXCLUDED_BACKUP_TABLES.includes(table)) {
      // Guarda de sanidade: a lista de inclusão nunca pode cruzar com a de exclusão.
      throw new Error(`Tabela "${table}" está na lista de exclusão do backup`);
    }

    if (table === "organizations") {
      const org: any = await ctx.runQuery(internal.exports.internalGetOrganization, {
        organizationId: job.organizationId,
      });
      entities.organizations = org ? [sanitizeDocument("organizations", org)] : [];
      total += entities.organizations.length;
      continue;
    }

    const docs: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const page: any = await ctx.runQuery(internal.exports.internalCollectPage, {
        organizationId: job.organizationId,
        table,
        cursor: cursor ?? undefined,
        limit: PAGE_SIZE,
      });
      for (const doc of page.docs) {
        docs.push(sanitizeDocument(table, shapeBackupDoc(table, doc)));
      }
      cursor = page.nextCursor;

      total += page.docs.length;
      if (total > MAX_BACKUP_DOCS) {
        throw new Error(
          `Backup acima do limite de ${MAX_BACKUP_DOCS} registros — fale com o suporte para uma exportação assistida`
        );
      }
      await ctx.runMutation(internal.exports.internalUpdateProgress, {
        jobId: job._id,
        processed: total,
        currentEntity: table,
      });
    } while (cursor);

    entities[table] = docs;
  }

  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    organizationId: job.organizationId,
    entities,
  };

  return {
    content: JSON.stringify(payload),
    mimeType: "application/json",
    rowCount: total,
  };
}

/**
 * Ajustes por tabela antes da sanitização genérica: mensagens levam o
 * `transcriptText` e os anexos SÓ como ids (nenhum binário sai no backup).
 */
function shapeBackupDoc(table: string, doc: any): Record<string, unknown> {
  if (table === "messages") {
    const shaped = { ...doc };
    shaped.attachments = Array.isArray(doc.attachments)
      ? doc.attachments.map((id: unknown) => String(id))
      : undefined;
    if (shaped.attachments === undefined) delete shaped.attachments;
    return shaped;
  }
  return { ...doc };
}
