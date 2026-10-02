/**
 * Purga de organizações num deployment-CÓPIA (o dev depois da separação
 * dev/prod — docs/OPS-SEPARAR-DEV-PROD.md). Apaga TUDO de toda org que não
 * esteja em `keepSlugs`, em lotes que se reagendam, e depois os usuários que
 * ficaram sem nenhuma org (`internalPurgeOrphanUsers`).
 *
 * Travas: `confirmDeployment` precisa casar com o `CONVEX_SITE_URL` do
 * deployment onde a função roda (rodar no prod por engano falha na hora),
 * `keepSlugs` precisa existir, e `dryRun` é o default.
 */
import { v } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

const BATCH = 250;

// Tabelas com organizationId + índice por org (prefixo `organizationId`).
const ORG_TABLES: { table: string; index: string }[] = [
  { table: "files", index: "by_organization" },
  { table: "messages", index: "by_organization" },
  { table: "conversationTransfers", index: "by_organization_and_created" },
  { table: "conversations", index: "by_organization" },
  { table: "conversationLabels", index: "by_organization" },
  { table: "groupChats", index: "by_organization" },
  { table: "groupPosts", index: "by_organization" },
  { table: "scheduledMessages", index: "by_organization" },
  { table: "quickReplies", index: "by_organization" },
  { table: "handoffs", index: "by_organization" },
  { table: "activities", index: "by_organization" },
  { table: "auditLogs", index: "by_organization" },
  { table: "taskComments", index: "by_organization" },
  { table: "tasks", index: "by_organization" },
  { table: "taskColumns", index: "by_organization" },
  { table: "taskProjects", index: "by_organization" },
  { table: "taskLabels", index: "by_organization" },
  { table: "notifications", index: "by_organization" },
  { table: "calendarEvents", index: "by_organization" },
  { table: "savedViews", index: "by_organization" },
  { table: "onboardingProgress", index: "by_organization" },
  { table: "notificationPreferences", index: "by_organization" },
  { table: "formSubmissions", index: "by_organization_and_created" },
  { table: "formPartials", index: "by_organization_and_created" },
  { table: "formExperimentVariants", index: "by_organization" },
  { table: "formExperiments", index: "by_organization" },
  { table: "forms", index: "by_organization" },
  { table: "webhooks", index: "by_organization" },
  { table: "agentRuns", index: "by_organization_and_started" },
  { table: "aiReplyQueue", index: "by_organization_and_status" },
  { table: "aiFollowUps", index: "by_organization_and_status" },
  { table: "aiPacing", index: "by_organization" },
  { table: "campaignRecipients", index: "by_organization" },
  { table: "campaigns", index: "by_organization" },
  { table: "optOuts", index: "by_organization" },
  { table: "whatsappTemplates", index: "by_organization" },
  { table: "orgSecrets", index: "by_organization" },
  { table: "pendingActions", index: "by_organization_and_status" },
  { table: "copilotThreads", index: "by_organization_and_member" },
  { table: "agentEvals", index: "by_organization" },
  { table: "leadDocuments", index: "by_organization" },
  { table: "exportJobs", index: "by_organization" },
  { table: "importJobBatches", index: "by_organization" },
  { table: "importJobs", index: "by_organization" },
  { table: "leads", index: "by_organization" },
  { table: "contacts", index: "by_organization" },
  { table: "leadSources", index: "by_organization" },
  { table: "fieldDefinitions", index: "by_organization" },
  { table: "boards", index: "by_organization" },
  { table: "channelConfigs", index: "by_organization" },
  { table: "apiKeys", index: "by_organization" },
  { table: "adSpend", index: "by_organization_and_date" },
  { table: "departments", index: "by_organization" },
  { table: "units", index: "by_organization" },
  { table: "teamMembers", index: "by_organization" },
];

function assertDeployment(confirm: string) {
  const site = process.env.CONVEX_SITE_URL ?? "";
  if (!confirm || !site.includes(confirm)) {
    throw new Error(`confirmDeployment "${confirm}" não casa com este deployment (${site || "?"})`);
  }
}

async function targetOrgs(ctx: MutationCtx, keepSlugs: string[]) {
  const orgs = await ctx.db.query("organizations").collect();
  const keep = new Set(keepSlugs);
  for (const slug of keepSlugs) {
    if (!orgs.some((o) => o.slug === slug)) throw new Error(`keepSlugs: org "${slug}" não existe — abortado`);
  }
  if (keepSlugs.length === 0) throw new Error("keepSlugs vazio — recusado");
  return { orgs, targets: orgs.filter((o) => !keep.has(o.slug)) };
}

// Apaga até `budget` documentos de UMA org. Devolve quantos apagou.
async function purgeSome(ctx: MutationCtx, org: Doc<"organizations">, budget: number): Promise<number> {
  let deleted = 0;
  const db = ctx.db as unknown as {
    query: (t: string) => { withIndex: (i: string, f: (q: { eq: (k: string, v: unknown) => unknown }) => unknown) => { take: (n: number) => Promise<Array<Record<string, unknown> & { _id: Id<"files"> }>> } };
  };
  for (const { table, index } of ORG_TABLES) {
    if (deleted >= budget) break;
    const rows = await db.query(table).withIndex(index, (q) => q.eq("organizationId", org._id)).take(budget - deleted);
    for (const row of rows) {
      // Filhos sem índice por org: apagados junto com o pai.
      if (table === "boards") {
        const stages = await ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", row._id as unknown as Id<"boards">)).take(200);
        for (const s of stages) await ctx.db.delete(s._id);
        deleted += stages.length;
      } else if (table === "copilotThreads") {
        const msgs = await ctx.db.query("copilotMessages").withIndex("by_thread_and_created", (q) => q.eq("threadId", row._id as unknown as Id<"copilotThreads">)).take(200);
        for (const m of msgs) await ctx.db.delete(m._id);
        deleted += msgs.length;
      } else if (table === "channelConfigs") {
        const pacing = await ctx.db.query("channelPacing").withIndex("by_channel_config", (q) => q.eq("channelConfigId", row._id as unknown as Id<"channelConfigs">)).take(50);
        for (const p of pacing) await ctx.db.delete(p._id);
        deleted += pacing.length;
      } else if (table === "messages") {
        const deferred = await ctx.db.query("deferredGroupMedia").withIndex("by_message", (q) => q.eq("messageId", row._id as unknown as Id<"messages">)).take(5);
        for (const d of deferred) await ctx.db.delete(d._id);
        deleted += deferred.length;
      }
      // Blobs: apaga o arquivo do storage junto com a linha (dentro da org
      // toda sendo apagada, não há compartilhamento a preservar).
      const storageId = (row as { storageId?: Id<"_storage">; resultStorageId?: Id<"_storage"> }).storageId
        ?? (row as { resultStorageId?: Id<"_storage"> }).resultStorageId;
      if (storageId) {
        try { await ctx.storage.delete(storageId); } catch { /* já apagado por outra linha */ }
      }
      await ctx.db.delete(row._id as unknown as Id<"files">);
      deleted++;
    }
  }
  return deleted;
}

export const internalPurgeOrganizations = internalMutation({
  args: {
    keepSlugs: v.array(v.string()),
    confirmDeployment: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    orgsTotal: v.number(),
    targetsLeft: v.number(),
    current: v.union(v.string(), v.null()),
    deletedThisRun: v.number(),
    orgRemoved: v.boolean(),
    rescheduled: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertDeployment(args.confirmDeployment);
    const dryRun = args.dryRun ?? true;
    const { orgs, targets } = await targetOrgs(ctx, args.keepSlugs);
    if (targets.length === 0) {
      return { dryRun, orgsTotal: orgs.length, targetsLeft: 0, current: null, deletedThisRun: 0, orgRemoved: false, rescheduled: false };
    }
    const org = targets[0];
    if (dryRun) {
      // Valida os índices em runtime (uma leitura pequena por tabela) sem apagar.
      const db = ctx.db as unknown as { query: (t: string) => { withIndex: (i: string, f: (q: { eq: (k: string, v: unknown) => unknown }) => unknown) => { take: (n: number) => Promise<unknown[]> } } };
      for (const { table, index } of ORG_TABLES) {
        await db.query(table).withIndex(index, (q) => q.eq("organizationId", org._id)).take(1);
      }
      return { dryRun, orgsTotal: orgs.length, targetsLeft: targets.length, current: org.slug, deletedThisRun: 0, orgRemoved: false, rescheduled: false };
    }
    const deleted = await purgeSome(ctx, org, BATCH);
    let orgRemoved = false;
    if (deleted === 0) {
      await ctx.db.delete(org._id);
      orgRemoved = true;
    }
    const more = targets.length > (orgRemoved ? 1 : 0) || !orgRemoved;
    if (more) {
      await ctx.scheduler.runAfter(0, internal.opsPurge.internalPurgeOrganizations, {
        keepSlugs: args.keepSlugs,
        confirmDeployment: args.confirmDeployment,
        dryRun: false,
      });
    }
    return {
      dryRun,
      orgsTotal: orgs.length,
      targetsLeft: targets.length - (orgRemoved ? 1 : 0),
      current: org.slug,
      deletedThisRun: deleted,
      orgRemoved,
      rescheduled: more,
    };
  },
});

/** Usuários sem NENHUM teamMember (ficaram órfãos após a purga): apaga conta, sessões e tokens. */
export const internalPurgeOrphanUsers = internalMutation({
  args: { confirmDeployment: v.string(), dryRun: v.optional(v.boolean()) },
  returns: v.object({ dryRun: v.boolean(), usersTotal: v.number(), orphans: v.number(), deleted: v.number(), rescheduled: v.boolean() }),
  handler: async (ctx, args) => {
    assertDeployment(args.confirmDeployment);
    const dryRun = args.dryRun ?? true;
    const users = await ctx.db.query("users").take(2000);
    const orphans: Doc<"users">[] = [];
    for (const u of users) {
      const member = await ctx.db.query("teamMembers").withIndex("by_user", (q) => q.eq("userId", u._id)).first();
      if (!member) orphans.push(u);
    }
    if (dryRun) return { dryRun, usersTotal: users.length, orphans: orphans.length, deleted: 0, rescheduled: false };
    let deleted = 0;
    for (const u of orphans.slice(0, 40)) {
      const sessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", u._id)).take(100);
      for (const s of sessions) {
        const tokens = await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", s._id)).take(100);
        for (const t of tokens) await ctx.db.delete(t._id);
        await ctx.db.delete(s._id);
      }
      const accounts = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", u._id)).take(20);
      for (const a of accounts) {
        const codes = await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", a._id)).take(20);
        for (const c of codes) await ctx.db.delete(c._id);
        await ctx.db.delete(a._id);
      }
      await ctx.db.delete(u._id);
      deleted++;
    }
    const rescheduled = orphans.length > 40;
    if (rescheduled) {
      await ctx.scheduler.runAfter(0, internal.opsPurge.internalPurgeOrphanUsers, { confirmDeployment: args.confirmDeployment, dryRun: false });
    }
    return { dryRun, usersTotal: users.length, orphans: orphans.length, deleted, rescheduled };
  },
});
