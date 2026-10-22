/**
 * Ops do Meta Messaging (Instagram/Messenger, F4). SÓ funções internas; todas
 * com `dryRun` default TRUE. Saída sem token, sem PSID/IGSID e sem id completo
 * de Página (4 últimos dígitos). Rodar em prod depois de um dry run:
 *
 *  - internalMetaConnectionsReport: relatório paginado das conexões (leitura).
 *  - internalMetaHealthNow: roda a observação de saúde fora do cron; `dryRun`
 *    só mostra o que o `debug_token` devolveu, sem gravar.
 *  - internalMetaPurge: purga de `metaSentMids` (> 7 dias), `oauthStates` e
 *    `metaOAuthPending` vencidos; a execução real se reagenda enquanto houver lote cheio.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/secretCrypto";
import { maskExternalId } from "./lib/metaIdentity";
import { fetchDebugToken, purgeMetaTemp } from "./lib/metaHealth";

const REPORT_PAGE_SIZE = 50;

export const internalMetaConnectionsReport = internalQuery({
  args: {
    dryRun: v.optional(v.boolean()), // somente leitura: aceito por uniformidade
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    rows: v.array(
      v.object({
        organizationId: v.id("organizations"),
        connectionId: v.id("metaConnections"),
        pageIdMasked: v.string(),
        authState: v.string(),
        authDetail: v.union(v.string(), v.null()),
        lastHealthAt: v.union(v.number(), v.null()),
        dataAccessExpiresAt: v.union(v.number(), v.null()),
        configs: v.number(),
        notSubscribed: v.boolean(),
      })
    ),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("metaConnections")
      .paginate({ cursor: args.cursor ?? null, numItems: Math.max(1, Math.min(args.pageSize ?? REPORT_PAGE_SIZE, REPORT_PAGE_SIZE)) });
    const rows = [];
    for (const c of page.page) {
      const configs = await ctx.db
        .query("channelConfigs")
        .withIndex("by_meta_connection", (q) => q.eq("metaConnectionId", c._id))
        .take(20);
      rows.push({
        organizationId: c.organizationId,
        connectionId: c._id,
        pageIdMasked: c.pageId ? maskExternalId(c.pageId) : "",
        authState: c.authState,
        authDetail: c.authDetail ?? null,
        lastHealthAt: c.lastHealthAt ?? null,
        dataAccessExpiresAt: c.dataAccessExpiresAt ?? null,
        configs: configs.filter((x) => x.organizationId === c.organizationId).length,
        notSubscribed: c.subscribedAt === undefined,
      });
    }
    return { rows, isDone: page.isDone, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

export const internalMetaHealthNow = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    connectionId: v.optional(v.id("metaConnections")),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    dryRun: v.boolean(),
    rows: v.array(
      v.object({
        connectionId: v.id("metaConnections"),
        result: v.union(v.literal("observed"), v.literal("unavailable"), v.literal("error")),
        isValid: v.union(v.boolean(), v.null()),
        scopes: v.array(v.string()),
        dataAccessExpiresAt: v.union(v.number(), v.null()),
        outcome: v.union(v.string(), v.null()),
      })
    ),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const appId = process.env.META_MESSAGING_APP_ID;
    const appSecret = process.env.META_MESSAGING_APP_SECRET;
    const rows: {
      connectionId: Id<"metaConnections">;
      result: "observed" | "unavailable" | "error";
      isValid: boolean | null;
      scopes: string[];
      dataAccessExpiresAt: number | null;
      outcome: string | null;
    }[] = [];
    if (!appId || !appSecret) return { dryRun, rows, nextCursor: null };

    let targets: { connectionId: Id<"metaConnections">; tokenEncrypted: string }[] = [];
    let nextCursor: string | null = null;
    if (args.connectionId) {
      const conn: Doc<"metaConnections"> | null = await ctx.runQuery(internal.metaMessaging.internalGetMetaConnection, {
        connectionId: args.connectionId,
      });
      if (conn && conn.authState !== "revoked" && conn.tokenEncrypted) {
        targets = [{ connectionId: conn._id, tokenEncrypted: conn.tokenEncrypted }];
      }
    } else {
      const page: {
        targets: { connectionId: Id<"metaConnections">; tokenEncrypted: string }[];
        nextCursor: string | null;
      } = await ctx.runQuery(internal.metaMessaging.internalListHealthTargets, {
        cursor: args.cursor ?? null,
        numItems: REPORT_PAGE_SIZE,
      });
      targets = page.targets;
      nextCursor = page.nextCursor;
    }

    for (const target of targets) {
      try {
        const pageToken = await decryptSecret(target.tokenEncrypted);
        const result = await fetchDebugToken({ pageToken, appId, appSecret });
        if (result.kind === "unavailable") {
          rows.push({
            connectionId: target.connectionId,
            result: "unavailable",
            isValid: null,
            scopes: [],
            dataAccessExpiresAt: null,
            outcome: null,
          });
          continue;
        }
        let outcome: string | null = null;
        if (!dryRun) {
          const applied: { outcome: string } = await ctx.runMutation(
            internal.metaMessaging.internalApplyHealthObservation,
            { connectionId: target.connectionId, observation: result.observation }
          );
          outcome = applied.outcome;
        }
        rows.push({
          connectionId: target.connectionId,
          result: "observed",
          isValid: result.observation.isValid,
          scopes: result.observation.scopes,
          dataAccessExpiresAt: result.observation.dataAccessExpiresAt ?? null,
          outcome,
        });
      } catch {
        rows.push({
          connectionId: target.connectionId,
          result: "error",
          isValid: null,
          scopes: [],
          dataAccessExpiresAt: null,
          outcome: null,
        });
      }
    }
    return { dryRun, rows, nextCursor };
  },
});

export const internalMetaPurge = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    dryRun: v.boolean(),
    sentMids: v.number(),
    oauthStates: v.number(),
    oauthPending: v.number(),
    more: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const r = await purgeMetaTemp(ctx, { now: Date.now(), dryRun });
    if (!dryRun && r.more) {
      await ctx.scheduler.runAfter(0, internal.opsMeta.internalMetaPurge, { dryRun: false });
    }
    return { dryRun, ...r };
  },
});
