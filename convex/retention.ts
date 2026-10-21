/**
 * Retenção de dados que ninguém lê mais (perf Convex I/O, fase 4a).
 *
 * Cron DIÁRIO (`crons.ts`, "data retention", 07:30 UTC) que apaga, por índice
 * e em lotes, cinco tipos de linha HISTÓRICA. Nunca toca dado vivo: cada
 * tabela só é lida por um range de índice que já exclui o que está em uso.
 *
 * | tabela        | o que sai                                   | campo de data   | janela |
 * |---------------|---------------------------------------------|-----------------|--------|
 * | notifications | LIDAS (`readAt` definido)                   | `readAt`        |  90 d  |
 * | aiReplyQueue  | `done`/`skipped`/`failed` (nunca `pending`/`processing`) | `updatedAt` | 90 d |
 * | agentRuns     | `done`/`error`/`aborted` (nunca `running`)  | `startedAt`     |  90 d  |
 * | formPartials  | `abandoned` (nunca `in_progress`/`converted`) | `lastActivityAt` | 30 d |
 * | auditLogs     | severidade `low`, ação ≠ `delete`           | `createdAt`     | 180 d  |
 *
 * Por que esses campos: `aiReplyQueue.updatedAt` é obrigatório e é carimbado
 * em toda transição (o item terminal fica parado nele); `agentRuns.finishedAt`
 * é OPCIONAL (run abortada pode não ter), então o corte usa `startedAt` — uma
 * run terminal iniciada há 90 dias terminou há ~90 dias. `auditLogs` pula a
 * ação `delete` inteira: o snapshot de exclusão (`changes.before`) do
 * `hardDeleteLead` é `high`, mas outros deletes (`savedViews`) gravam `low`, e
 * um registro de exclusão é a única prova do que existia. `medium`/`high`/
 * `critical` nunca entram no range.
 *
 * Efeitos colaterais conhecidos (aceitos):
 * - `computeAcceptanceMetrics` (gate do autopilot) lê as ÚLTIMAS 300 runs do
 *   atendente sem janela de tempo: numa org de pouco volume, runs com mais de
 *   90 dias deixam de contar — a métrica passa a olhar só os últimos 90 dias.
 * - `aiSpend:internalBackfillMonthlyUsage` recalcula um mês a partir das runs:
 *   para mês com mais de 90 dias não sobra run, então NÃO rodar backfill de mês
 *   antigo (o `aiUsageMonthly` já agregado continua lá — nada aqui o apaga).
 * - `formPartials.getPartialStats` conta abandonos por formulário: abandonos
 *   com mais de 30 dias saem da contagem.
 * - Nenhuma das cinco tabelas aponta para `_storage` (verificado no schema);
 *   todas já estão em `EXCLUDED_BACKUP_TABLES`, então o backup JSON não muda.
 * - Ponteiros para item de fila/run apagado (`aiFollowUps.queueItemId`,
 *   `copilotMessages.agentRunId`) só são lidos em caminho em voo, que trata
 *   `null`; um follow-up/mensagem de 90 dias não está em voo.
 *
 * Operação: kill switch `RETENTION_DISABLED=1` (vale também para a execução
 * manual) e `CRONS_DISABLED=1` (só a do cron, como os demais crons). Janelas
 * ajustáveis por env `RETENTION_<TABELA>_DAYS` (inteiro ≥ 7; inválido = padrão).
 * Teto de 20.000 linhas por dia: o que sobrar fica para o dia seguinte.
 *
 *   npx convex run --prod retention:internalRetentionPreview '{}'
 *   npx convex run --prod retention:internalRunRetentionNow '{}'                 # dryRun
 *   npx convex run --prod retention:internalRunRetentionNow '{"dryRun":false}'
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { cronsDisabled } from "./lib/cronGuard";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION_TABLES = [
  "notifications",
  "aiReplyQueue",
  "agentRuns",
  "formPartials",
  "auditLogs",
] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

/** Janelas padrão, em dias. */
export const RETENTION_DEFAULT_DAYS: Record<RetentionTable, number> = {
  notifications: 90,
  aiReplyQueue: 90,
  agentRuns: 90,
  formPartials: 30,
  auditLogs: 180,
};

/** Env opcional que sobrepõe a janela padrão de cada tabela. */
export const RETENTION_ENV_DAYS: Record<RetentionTable, string> = {
  notifications: "RETENTION_NOTIFICATIONS_DAYS",
  aiReplyQueue: "RETENTION_AI_REPLY_QUEUE_DAYS",
  agentRuns: "RETENTION_AGENT_RUNS_DAYS",
  formPartials: "RETENTION_FORM_PARTIALS_DAYS",
  auditLogs: "RETENTION_AUDIT_LOGS_DAYS",
};

/** Piso de qualquer janela (env ou override): um typo nunca apaga a semana. */
export const RETENTION_MIN_DAYS = 7;
/** Linhas por transação. */
export const RETENTION_BATCH_SIZE = 200;
/** Teto de linhas apagadas por execução diária (todas as tabelas somadas). */
export const RETENTION_DAILY_CAP = 20_000;
/** Teto da contagem do preview, por tabela. */
export const RETENTION_PREVIEW_LIMIT = 1000;

export const AI_REPLY_QUEUE_TERMINAL = ["done", "skipped", "failed"] as const;
export const AGENT_RUN_TERMINAL = ["done", "error", "aborted"] as const;
/** Todas as ações de auditLogs MENOS "delete" (registro de exclusão fica sempre). */
export const AUDIT_LOG_PURGEABLE_ACTIONS = ["create", "update", "move", "assign", "handoff"] as const;

export function retentionDisabled(): boolean {
  return process.env.RETENTION_DISABLED === "1";
}

const tableValidator = v.union(
  v.literal("notifications"),
  v.literal("aiReplyQueue"),
  v.literal("agentRuns"),
  v.literal("formPartials"),
  v.literal("auditLogs")
);

const overridesValidator = v.object({
  notifications: v.optional(v.number()),
  aiReplyQueue: v.optional(v.number()),
  agentRuns: v.optional(v.number()),
  formPartials: v.optional(v.number()),
  auditLogs: v.optional(v.number()),
});
type Overrides = Partial<Record<RetentionTable, number>>;

/** Janela efetiva: override do operador > env > padrão. */
export function retentionDays(table: RetentionTable, overrides?: Overrides): number {
  const override = overrides?.[table];
  if (override !== undefined) {
    if (!Number.isFinite(override) || override < RETENTION_MIN_DAYS) {
      throw new Error(`Janela de ${table} precisa ser ≥ ${RETENTION_MIN_DAYS} dias (veio ${override})`);
    }
    return override;
  }
  const raw = process.env[RETENTION_ENV_DAYS[table]];
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= RETENTION_MIN_DAYS) return n;
    console.warn(JSON.stringify({ event: "retentionInvalidEnv", env: RETENTION_ENV_DAYS[table] }));
  }
  return RETENTION_DEFAULT_DAYS[table];
}

type Row = { id: Id<RetentionTable>; ts: number };
type RangeFetch = (limit: number) => Promise<Row[]>;

/**
 * Os ranges de índice de cada tabela, todos `< cutoff` e em ordem crescente.
 * Só o que está aqui pode ser apagado — é a definição de "candidato".
 */
function candidateRanges(db: QueryCtx["db"], table: RetentionTable, cutoff: number): RangeFetch[] {
  switch (table) {
    case "notifications":
      return [
        async (limit) =>
          (
            await db
              .query("notifications")
              // gt(0) exclui readAt ausente (não lida) — undefined ordena antes de números.
              .withIndex("by_read_at", (q) => q.gt("readAt", 0).lt("readAt", cutoff))
              .take(limit)
          ).map((d) => ({ id: d._id, ts: d.readAt ?? 0 })),
      ];
    case "aiReplyQueue":
      return AI_REPLY_QUEUE_TERMINAL.map((status) => async (limit: number) =>
        (
          await db
            .query("aiReplyQueue")
            .withIndex("by_status_and_updated", (q) => q.eq("status", status).lt("updatedAt", cutoff))
            .take(limit)
        ).map((d) => ({ id: d._id, ts: d.updatedAt }))
      );
    case "agentRuns":
      return AGENT_RUN_TERMINAL.map((status) => async (limit: number) =>
        (
          await db
            .query("agentRuns")
            .withIndex("by_status_and_started", (q) => q.eq("status", status).lt("startedAt", cutoff))
            .take(limit)
        ).map((d) => ({ id: d._id, ts: d.startedAt }))
      );
    case "formPartials":
      return [
        async (limit) =>
          (
            await db
              .query("formPartials")
              .withIndex("by_status_and_activity", (q) =>
                q.eq("status", "abandoned").lt("lastActivityAt", cutoff)
              )
              .take(limit)
          ).map((d) => ({ id: d._id, ts: d.lastActivityAt })),
      ];
    case "auditLogs":
      return AUDIT_LOG_PURGEABLE_ACTIONS.map((action) => async (limit: number) =>
        (
          await db
            .query("auditLogs")
            .withIndex("by_severity_and_action_and_created", (q) =>
              q.eq("severity", "low").eq("action", action).lt("createdAt", cutoff)
            )
            .take(limit)
        ).map((d) => ({ id: d._id, ts: d.createdAt }))
      );
  }
}

/** Até `limit` candidatos, percorrendo os ranges em ordem. */
async function takeCandidates(db: QueryCtx["db"], table: RetentionTable, cutoff: number, limit: number) {
  const out: Row[] = [];
  for (const fetch of candidateRanges(db, table, cutoff)) {
    if (out.length >= limit) break;
    out.push(...(await fetch(limit - out.length)));
  }
  return out;
}

/** Os N candidatos mais antigos entre todos os ranges da tabela. */
async function oldestCandidates(db: QueryCtx["db"], table: RetentionTable, cutoff: number, n: number) {
  const all: Row[] = [];
  for (const fetch of candidateRanges(db, table, cutoff)) all.push(...(await fetch(n)));
  return all.sort((a, b) => a.ts - b.ts).slice(0, n);
}

/** Conta candidatos até `RETENTION_PREVIEW_LIMIT` (`truncated` = há mais). */
async function countCandidates(db: QueryCtx["db"], table: RetentionTable, cutoff: number) {
  const rows = await takeCandidates(db, table, cutoff, RETENTION_PREVIEW_LIMIT + 1);
  return {
    count: Math.min(rows.length, RETENTION_PREVIEW_LIMIT),
    truncated: rows.length > RETENTION_PREVIEW_LIMIT,
  };
}

const runResultValidator = v.object({
  status: v.union(
    v.literal("crons_disabled"),
    v.literal("retention_disabled"),
    v.literal("cap_reached"),
    v.literal("continuing"),
    v.literal("next_table"),
    v.literal("finished")
  ),
  table: v.optional(tableValidator),
  deleted: v.number(),
  deletedSoFar: v.number(),
  cutoff: v.optional(v.number()),
});

/**
 * Um lote de UMA tabela. Lote cheio = reagenda a mesma tabela (o que foi
 * apagado já saiu do range, então não precisa de cursor); lote parcial =
 * tabela esgotada, segue para a próxima. `startedAt` é fixado na 1ª chamada
 * do dia e propagado, para o corte não andar entre lotes.
 */
export const internalRunRetention = internalMutation({
  args: {
    table: v.optional(tableValidator),
    // Só esta tabela (execução manual com `table`): não passa para a próxima.
    onlyTable: v.optional(v.boolean()),
    startedAt: v.optional(v.number()),
    deletedSoFar: v.optional(v.number()),
    maxDocs: v.optional(v.number()),
    olderThanOverrides: v.optional(overridesValidator),
    // Disparo manual do operador: ignora CRONS_DISABLED (RETENTION_DISABLED vale sempre).
    manual: v.optional(v.boolean()),
  },
  returns: runResultValidator,
  handler: async (ctx, args) => {
    if (!args.manual && cronsDisabled()) return { status: "crons_disabled" as const, deleted: 0, deletedSoFar: 0 };
    if (retentionDisabled()) return { status: "retention_disabled" as const, deleted: 0, deletedSoFar: 0 };

    const table: RetentionTable = args.table ?? RETENTION_TABLES[0];
    const startedAt = args.startedAt ?? Date.now();
    const cap = Math.max(0, Math.floor(args.maxDocs ?? RETENTION_DAILY_CAP));
    const deletedBefore = args.deletedSoFar ?? 0;
    const remaining = cap - deletedBefore;
    if (remaining <= 0) {
      console.log(JSON.stringify({ event: "retention", table, status: "cap_reached", deletedSoFar: deletedBefore, cap }));
      return { status: "cap_reached" as const, table, deleted: 0, deletedSoFar: deletedBefore };
    }

    const days = retentionDays(table, args.olderThanOverrides);
    const cutoff = startedAt - days * DAY_MS;
    const batch = Math.min(RETENTION_BATCH_SIZE, remaining);
    const rows = await takeCandidates(ctx.db, table, cutoff, batch);
    for (const row of rows) await ctx.db.delete(row.id);
    const deletedSoFar = deletedBefore + rows.length;
    console.log(JSON.stringify({ event: "retention", table, deleted: rows.length, cutoff, deletedSoFar }));

    const common = {
      startedAt,
      deletedSoFar,
      maxDocs: args.maxDocs,
      olderThanOverrides: args.olderThanOverrides,
      manual: args.manual,
      onlyTable: args.onlyTable,
    };
    const result = { table, deleted: rows.length, deletedSoFar, cutoff };

    if (deletedSoFar >= cap) {
      console.log(JSON.stringify({ event: "retention", table, status: "cap_reached", deletedSoFar, cap }));
      return { status: "cap_reached" as const, ...result };
    }
    if (rows.length === batch) {
      await ctx.scheduler.runAfter(0, internal.retention.internalRunRetention, { ...common, table });
      return { status: "continuing" as const, ...result };
    }
    const nextIndex = RETENTION_TABLES.indexOf(table) + 1;
    if (!args.onlyTable && nextIndex < RETENTION_TABLES.length) {
      await ctx.scheduler.runAfter(0, internal.retention.internalRunRetention, {
        ...common,
        table: RETENTION_TABLES[nextIndex],
      });
      return { status: "next_table" as const, ...result };
    }
    console.log(JSON.stringify({ event: "retention", status: "finished", deletedSoFar }));
    return { status: "finished" as const, ...result };
  },
});

const planEntryValidator = v.object({
  table: tableValidator,
  days: v.number(),
  cutoff: v.number(),
  count: v.number(),
  truncated: v.boolean(),
});

/**
 * Só leitura: quantos candidatos cada tabela tem AGORA (até 1000 por tabela,
 * `truncated` = há mais). Rodar em prod antes do primeiro cron.
 * `Date.now()` aqui é aceitável: query de ops avulsa, ninguém a assina.
 */
export const internalRetentionPreview = internalQuery({
  args: { olderThanOverrides: v.optional(overridesValidator), now: v.optional(v.number()) },
  returns: v.array(planEntryValidator),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const out = [];
    for (const table of RETENTION_TABLES) {
      const days = retentionDays(table, args.olderThanOverrides);
      const cutoff = now - days * DAY_MS;
      out.push({ table, days, cutoff, ...(await countCandidates(ctx.db, table, cutoff)) });
    }
    return out;
  },
});

/**
 * Disparo manual. `dryRun` (default TRUE) devolve o plano — contagem e os 5
 * ids mais antigos por tabela — sem apagar nada. Com `dryRun:false` agenda o
 * MESMO paginador do cron (lote → reagenda), com o mesmo teto (`maxDocs`,
 * default 20.000) e respeitando `RETENTION_DISABLED`; o progresso sai nos
 * logs `{"event":"retention",…}`.
 */
export const internalRunRetentionNow = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    table: v.optional(tableValidator),
    maxDocs: v.optional(v.number()),
    olderThanOverrides: v.optional(overridesValidator),
  },
  returns: v.object({
    dryRun: v.boolean(),
    disabled: v.boolean(),
    plan: v.array(
      v.object({
        table: tableValidator,
        days: v.number(),
        cutoff: v.number(),
        count: v.number(),
        truncated: v.boolean(),
        oldest: v.array(v.object({ id: v.string(), ts: v.number() })),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const now = Date.now();
    const tables = args.table ? [args.table] : [...RETENTION_TABLES];
    const plan = [];
    for (const table of tables) {
      const days = retentionDays(table, args.olderThanOverrides);
      const cutoff = now - days * DAY_MS;
      const counted = await countCandidates(ctx.db, table, cutoff);
      const oldest = (await oldestCandidates(ctx.db, table, cutoff, 5)).map((r) => ({ id: r.id as string, ts: r.ts }));
      plan.push({ table, days, cutoff, ...counted, oldest });
    }
    const disabled = retentionDisabled();
    if (dryRun || disabled) return { dryRun, disabled, plan };

    // Mesmo caminho do cron (lote → reagenda), mas sem a trava de CRONS_DISABLED.
    await ctx.scheduler.runAfter(0, internal.retention.internalRunRetention, {
      table: args.table,
      onlyTable: args.table !== undefined,
      startedAt: now,
      maxDocs: args.maxDocs,
      olderThanOverrides: args.olderThanOverrides,
      manual: true,
    });
    return { dryRun, disabled, plan };
  },
});
