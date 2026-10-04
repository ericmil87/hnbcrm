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
import { v, Infer } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";

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
  { table: "aiUsageMonthly", index: "by_organization_and_month" },
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
  // Comparação EXATA com o nome do deployment (1º rótulo do host): substring
  // deixaria "convex" ou "careful" casarem com qualquer deployment.
  let name = "";
  try { name = new URL(site).hostname.split(".")[0] ?? ""; } catch { name = ""; }
  if (!confirm || !name || confirm !== name) {
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

type PurgeOptions = {
  /**
   * Modo cuidadoso (usado pela purga de orgs anônimas, que roda no PROD ao lado
   * de orgs reais): blob de `files` só sai pelo guarda de `lib/fileRefs.ts`
   * (outra linha apontando para o mesmo `storageId` — mesmo de outra org —
   * segura o blob), blob de `exportJobs` só sai se nenhum `files` o referencia,
   * filhos sem índice por org são apagados em lotes sem deixar órfãos (o pai
   * só sai quando os filhos acabaram) e o lote para no orçamento.
   * Ausente = comportamento original de `internalPurgeOrganizations`.
   */
  careful?: boolean;
};

const CAREFUL_CHILD_CAP = 50;

// Apaga até `budget` documentos de UMA org. Devolve quantos apagou e se a org
// ficou vazia (`exhausted` — só confiável no modo cuidadoso).
async function purgeSome(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  budget: number,
  opts: PurgeOptions = {},
): Promise<{ deleted: number; exhausted: boolean }> {
  const careful = opts.careful === true;
  let deleted = 0;
  let exhausted = true;
  const db = ctx.db as unknown as {
    query: (t: string) => { withIndex: (i: string, f: (q: { eq: (k: string, v: unknown) => unknown }) => unknown) => { take: (n: number) => Promise<Array<Record<string, unknown> & { _id: Id<"files"> }>> } };
  };
  for (const { table, index } of ORG_TABLES) {
    if (deleted >= budget) {
      exhausted = false;
      break;
    }
    const want = budget - deleted;
    const rows = await db.query(table).withIndex(index, (q) => q.eq("organizationId", orgId)).take(want);
    if (rows.length >= want) exhausted = false;
    for (const row of rows) {
      if (careful && deleted >= budget) {
        exhausted = false;
        break;
      }
      const childCap = (n: number) => (careful ? CAREFUL_CHILD_CAP : n);
      let childrenLeft = false;
      // Filhos sem índice por org: apagados junto com o pai.
      if (table === "boards") {
        const cap = childCap(200);
        const stages = await ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", row._id as unknown as Id<"boards">)).take(cap);
        for (const s of stages) await ctx.db.delete(s._id);
        deleted += stages.length;
        childrenLeft = stages.length >= cap;
      } else if (table === "copilotThreads") {
        const cap = childCap(200);
        const msgs = await ctx.db.query("copilotMessages").withIndex("by_thread_and_created", (q) => q.eq("threadId", row._id as unknown as Id<"copilotThreads">)).take(cap);
        for (const m of msgs) await ctx.db.delete(m._id);
        deleted += msgs.length;
        childrenLeft = msgs.length >= cap;
      } else if (table === "channelConfigs") {
        const cap = childCap(50);
        const pacing = await ctx.db.query("channelPacing").withIndex("by_channel_config", (q) => q.eq("channelConfigId", row._id as unknown as Id<"channelConfigs">)).take(cap);
        for (const p of pacing) await ctx.db.delete(p._id);
        deleted += pacing.length;
        childrenLeft = pacing.length >= cap;
      } else if (table === "messages") {
        const cap = careful ? CAREFUL_CHILD_CAP : 5;
        const deferred = await ctx.db.query("deferredGroupMedia").withIndex("by_message", (q) => q.eq("messageId", row._id as unknown as Id<"messages">)).take(cap);
        for (const d of deferred) await ctx.db.delete(d._id);
        deleted += deferred.length;
        childrenLeft = deferred.length >= cap;
      }
      if (careful && childrenLeft) {
        // O pai fica para a próxima passada, que apaga o resto dos filhos.
        exhausted = false;
        continue;
      }
      if (careful) {
        if (table === "files") {
          await deleteBlobIfUnreferenced(ctx, row as unknown as Doc<"files">);
        } else {
          const other = (row as { resultStorageId?: Id<"_storage"> }).resultStorageId;
          if (other) {
            const ref = await ctx.db.query("files").withIndex("by_storage_id", (q) => q.eq("storageId", other as unknown as string)).first();
            if (!ref) {
              try { await ctx.storage.delete(other); } catch { /* já apagado */ }
            }
          }
        }
      } else {
        // Blobs: apaga o arquivo do storage junto com a linha (dentro da org
        // toda sendo apagada, não há compartilhamento a preservar).
        const storageId = (row as { storageId?: Id<"_storage">; resultStorageId?: Id<"_storage"> }).storageId
          ?? (row as { resultStorageId?: Id<"_storage"> }).resultStorageId;
        if (storageId) {
          try { await ctx.storage.delete(storageId); } catch { /* já apagado por outra linha */ }
        }
      }
      await ctx.db.delete(row._id as unknown as Id<"files">);
      deleted++;
    }
  }
  return { deleted, exhausted };
}

/** Sessões (+ refresh tokens), contas (+ códigos) e o próprio `users`. */
async function deleteUserAuthData(ctx: MutationCtx, userId: Id<"users">) {
  const sessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(100);
  for (const s of sessions) {
    const tokens = await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", s._id)).take(100);
    for (const t of tokens) await ctx.db.delete(t._id);
    await ctx.db.delete(s._id);
  }
  const accounts = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(20);
  for (const a of accounts) {
    const codes = await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", a._id)).take(20);
    for (const c of codes) await ctx.db.delete(c._id);
    await ctx.db.delete(a._id);
  }
  await ctx.db.delete(userId);
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
    const { deleted } = await purgeSome(ctx, org._id, BATCH);
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
      await deleteUserAuthData(ctx, u._id);
      deleted++;
    }
    const rescheduled = orphans.length > 40;
    if (rescheduled) {
      await ctx.scheduler.runAfter(0, internal.opsPurge.internalPurgeOrphanUsers, { confirmDeployment: args.confirmDeployment, dryRun: false });
    }
    return { dryRun, usersTotal: users.length, orphans: orphans.length, deleted, rescheduled };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Purga das orgs criadas por contas ANÔNIMAS (legado do login anônimo, removido
// na v0.68.1). Roda no PROD, ao lado das orgs reais — por isso a seleção é
// fail-closed e a deleção usa o modo cuidadoso de `purgeSome`.
// ─────────────────────────────────────────────────────────────────────────────

/** Orgs reais conhecidas: nunca purgadas por esta op, mesmo que o critério case. */
export const NEVER_PURGE_SLUGS: readonly string[] = [
  "aos-filhos-da-terra",
  "aosfilhosdaterra",
  "eric-milfont",
  "townsville-inc",
  "townsville",
  "grupo-terrae-hoteis",
  "grupo-terrae-demo",
  "acme-corp-test",
];

const ANON_BATCH = 180;
const ANON_USERS_PER_RUN = 40;
const ANON_COUNT_CAP = 200;
const ANON_ORG_SCAN_CAP = 2000;
const ANON_USER_SCAN_CAP = 5000;
const ANON_MEMBER_CAP = 200;
const ANON_MAX_ORGS_DEFAULT = 50;

const ANON_COUNT_TABLES: { table: string; index: string }[] = [
  "leads", "contacts", "conversations", "messages", "apiKeys", "channelConfigs",
  "campaigns", "files", "tasks", "activities", "auditLogs", "agentRuns",
  "webhooks", "scheduledMessages", "boards", "teamMembers",
].map((table) => ORG_TABLES.find((t) => t.table === table)!);

function hasEmail(email: unknown): boolean {
  return typeof email === "string" && email.trim() !== "";
}

/** `users` sem e-mail, `isAnonymous: true` e SÓ contas `anonymous` no Convex Auth. */
async function isAnonymousUser(ctx: MutationCtx, userId: Id<"users">): Promise<boolean> {
  const user = await ctx.db.get(userId);
  // O provider Anonymous do Convex Auth grava `isAnonymous: true` no perfil.
  if (!user || hasEmail(user.email) || user.isAnonymous !== true) return false;
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .take(20);
  // Precisa ter a conta anônima e NENHUMA outra (senha, OAuth…).
  return accounts.length > 0 && accounts.every((a) => a.provider === "anonymous");
}

type OrgClass =
  | { kind: "target"; memberCount: number; anonUserIds: Id<"users">[]; pendingHumans: { memberId: Id<"teamMembers">; email: string | null }[] }
  | { kind: "legit" }
  | { kind: "noMembers" }
  | { kind: "aiOnly" }
  | { kind: "protected" }
  | { kind: "bridgeConnected" };

/**
 * Fail-closed: só é alvo a org em que TODO humano com `userId` é anônimo (sem
 * e-mail + conta `anonymous`) e há pelo menos um. Membro removido conta igual
 * (já teve acesso). Humano com `userId` apontando para user inexistente, ou com
 * e-mail no próprio `teamMembers`, tira a org da lista. Humano pendente sem
 * `userId` (seed/legado — não tem conta para entrar) não decide nada, só é
 * reportado em `pendingHumans`.
 */
async function classifyOrg(ctx: MutationCtx, org: Doc<"organizations">): Promise<OrgClass> {
  if (NEVER_PURGE_SLUGS.includes(org.slug)) return { kind: "protected" };
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
    .take(ANON_MEMBER_CAP + 1);
  if (members.length === 0) return { kind: "noMembers" };
  if (members.length > ANON_MEMBER_CAP) return { kind: "legit" };
  const anonUserIds: Id<"users">[] = [];
  const pendingHumans: { memberId: Id<"teamMembers">; email: string | null }[] = [];
  for (const m of members) {
    if (m.type === "ai") {
      // Membro IA com userId é anomalia: na dúvida, não purga.
      if (m.userId) return { kind: "legit" };
      continue;
    }
    if (!m.userId) {
      pendingHumans.push({ memberId: m._id, email: hasEmail(m.email) ? m.email!.trim() : null });
      continue;
    }
    if (hasEmail(m.email)) return { kind: "legit" };
    if (!(await isAnonymousUser(ctx, m.userId))) return { kind: "legit" };
    if (!anonUserIds.includes(m.userId)) anonUserIds.push(m.userId);
  }
  if (anonUserIds.length === 0) return { kind: "aiOnly" };
  const channels = await ctx.db
    .query("channelConfigs")
    .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
    .take(50);
  if (channels.some((c) => c.provider === "bridge" && c.bridgeSessionState === "connected")) {
    return { kind: "bridgeConnected" };
  }
  return { kind: "target", memberCount: members.length, anonUserIds, pendingHumans };
}

async function countOrg(ctx: MutationCtx, orgId: Id<"organizations">) {
  const db = ctx.db as unknown as {
    query: (t: string) => { withIndex: (i: string, f: (q: { eq: (k: string, v: unknown) => unknown }) => unknown) => { take: (n: number) => Promise<unknown[]> } };
  };
  const counts: Record<string, number> = {};
  let truncated = false;
  for (const { table, index } of ANON_COUNT_TABLES) {
    const rows = await db.query(table).withIndex(index, (q) => q.eq("organizationId", orgId)).take(ANON_COUNT_CAP);
    counts[table] = rows.length;
    if (rows.length >= ANON_COUNT_CAP) truncated = true;
  }
  return { counts, truncated };
}

async function scanOrgs(ctx: MutationCtx) {
  const orgs = await ctx.db.query("organizations").take(ANON_ORG_SCAN_CAP);
  const targets: { org: Doc<"organizations">; cls: Extract<OrgClass, { kind: "target" }> }[] = [];
  const orgsSemMembro: Doc<"organizations">[] = [];
  const skipped: { org: Doc<"organizations">; reason: string }[] = [];
  let legit = 0;
  for (const org of orgs) {
    const cls = await classifyOrg(ctx, org);
    if (cls.kind === "target") targets.push({ org, cls });
    else if (cls.kind === "noMembers") orgsSemMembro.push(org);
    else if (cls.kind === "legit") legit++;
    else skipped.push({ org, reason: cls.kind }); // protected | bridgeConnected | aiOnly — nunca alvo
  }
  return { orgs, truncated: orgs.length >= ANON_ORG_SCAN_CAP, targets, orgsSemMembro, skipped, legit };
}

/** Anônimos (sem e-mail + conta `anonymous`) sem NENHUM teamMember, nem removido. */
async function orphanAnonymousUsers(ctx: MutationCtx, limit: number) {
  const users = await ctx.db.query("users").take(ANON_USER_SCAN_CAP);
  const out: Id<"users">[] = [];
  for (const u of users) {
    if (out.length >= limit) break;
    if (hasEmail(u.email)) continue;
    const member = await ctx.db.query("teamMembers").withIndex("by_user", (q) => q.eq("userId", u._id)).first();
    if (member) continue;
    if (!(await isAnonymousUser(ctx, u._id))) continue;
    out.push(u._id);
  }
  return out;
}

const orgRef = { organizationId: v.id("organizations"), slug: v.string(), name: v.string() };

const anonPlanValidator = v.object({
  orgsScanned: v.number(),
  orgsScanTruncated: v.boolean(),
  legitOrgs: v.number(),
  targetsTotal: v.number(),
  targetsSelected: v.number(),
  targets: v.array(
    v.object({
      organizationId: v.id("organizations"),
      name: v.string(),
      slug: v.string(),
      memberCount: v.number(),
      pendingHumans: v.array(v.object({ memberId: v.id("teamMembers"), email: v.union(v.string(), v.null()) })),
      anonUserIds: v.array(v.id("users")),
      counts: v.record(v.string(), v.number()),
      truncated: v.boolean(),
    }),
  ),
  totals: v.record(v.string(), v.number()),
  totalsTruncated: v.boolean(),
  orgsSemMembro: v.array(v.object(orgRef)),
  skipped: v.array(v.object({ ...orgRef, reason: v.string() })),
  usersToDelete: v.array(v.id("users")),
  usersKept: v.array(v.object({ userId: v.id("users"), otherOrgSlugs: v.array(v.string()) })),
  orphanAnonUsersAlready: v.array(v.id("users")),
});

const anonReturnsValidator = v.object({
  dryRun: v.boolean(),
  phase: v.union(v.literal("plan"), v.literal("orgs"), v.literal("users"), v.literal("done")),
  plan: v.optional(anonPlanValidator),
  current: v.union(v.string(), v.null()),
  deletedThisRun: v.number(),
  orgRemoved: v.boolean(),
  orgsDone: v.number(),
  usersDeleted: v.number(),
  rescheduled: v.boolean(),
});

/**
 * Purga as orgs 100% anônimas. `dryRun` (default TRUE) devolve o plano inteiro
 * sem escrever. Com `dryRun:false` apaga UMA org por vez (lotes de ~180
 * escritas, auto-reagendado com `currentOrgId` como cursor e re-verificação do
 * critério a cada lote), até `maxOrgs` orgs; depois apaga os usuários anônimos
 * que ficaram sem nenhum membership (sessões, refresh tokens, contas e
 * códigos). Rodar de novo não acha alvos.
 */
export const internalPurgeAnonymousOrganizations = internalMutation({
  args: {
    confirmDeployment: v.string(),
    dryRun: v.optional(v.boolean()),
    maxOrgs: v.optional(v.number()),
    // Estado interno do auto-reagendamento (não passar à mão).
    phase: v.optional(v.union(v.literal("orgs"), v.literal("users"))),
    currentOrgId: v.optional(v.id("organizations")),
    // Trava do orquestrador: ids devolvidos pelo dryRun. Na execução real, se o
    // conjunto de alvos do scan (até maxOrgs) diferir, recusa ANTES de escrever.
    expectTargetIds: v.optional(v.array(v.id("organizations"))),
    // Só para teste: orçamento de escritas por execução (default 180).
    batchSize: v.optional(v.number()),
    orgsDone: v.optional(v.number()),
    deletedSoFar: v.optional(v.number()),
  },
  returns: anonReturnsValidator,
  handler: async (ctx, args): Promise<Infer<typeof anonReturnsValidator>> => {
    assertDeployment(args.confirmDeployment);
    const dryRun = args.dryRun ?? true;
    const maxOrgs = Math.max(1, Math.min(Math.floor(args.maxOrgs ?? ANON_MAX_ORGS_DEFAULT), 500));
    const orgsDone = args.orgsDone ?? 0;
    const batchSize = Math.max(1, Math.min(Math.floor(args.batchSize ?? ANON_BATCH), 500));
    const base = { dryRun, current: null, deletedThisRun: 0, orgRemoved: false, orgsDone, usersDeleted: 0, rescheduled: false };

    if (dryRun) {
      const scan = await scanOrgs(ctx);
      const selected = scan.targets.slice(0, maxOrgs);
      const selectedIds = new Set<string>(selected.map((t) => t.org._id));
      const totals: Record<string, number> = {};
      let totalsTruncated = false;
      const targets = [];
      const anonIds = new Set<Id<"users">>();
      for (const { org, cls } of selected) {
        const { counts, truncated } = await countOrg(ctx, org._id);
        for (const [k, n] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + n;
        totalsTruncated ||= truncated;
        for (const u of cls.anonUserIds) anonIds.add(u);
        targets.push({
          organizationId: org._id,
          name: org.name,
          slug: org.slug,
          memberCount: cls.memberCount,
          pendingHumans: cls.pendingHumans,
          anonUserIds: cls.anonUserIds,
          counts,
          truncated,
        });
      }
      const usersToDelete: Id<"users">[] = [];
      const usersKept: { userId: Id<"users">; otherOrgSlugs: string[] }[] = [];
      for (const userId of anonIds) {
        const memberships = await ctx.db.query("teamMembers").withIndex("by_user", (q) => q.eq("userId", userId)).take(50);
        const others = memberships.filter((m) => !selectedIds.has(m.organizationId));
        if (others.length === 0) {
          usersToDelete.push(userId);
        } else {
          const slugs: string[] = [];
          for (const m of others) slugs.push((await ctx.db.get(m.organizationId))?.slug ?? `(org inexistente ${m.organizationId})`);
          usersKept.push({ userId, otherOrgSlugs: slugs });
        }
      }
      const orphanAnonUsersAlready = await orphanAnonymousUsers(ctx, 500);
      const ref = (o: Doc<"organizations">) => ({ organizationId: o._id, slug: o.slug, name: o.name });
      return {
        ...base,
        phase: "plan" as const,
        plan: {
          orgsScanned: scan.orgs.length,
          orgsScanTruncated: scan.truncated,
          legitOrgs: scan.legit,
          targetsTotal: scan.targets.length,
          targetsSelected: selected.length,
          targets,
          totals,
          totalsTruncated,
          orgsSemMembro: scan.orgsSemMembro.map(ref),
          skipped: scan.skipped.map(({ org, reason }) => ({ ...ref(org), reason })),
          usersToDelete,
          usersKept,
          orphanAnonUsersAlready,
        },
      };
    }

    const reschedule = async (next: {
      phase: "orgs" | "users";
      currentOrgId?: Id<"organizations">;
      orgsDone: number;
      deletedSoFar?: number;
    }) => {
      await ctx.scheduler.runAfter(0, internal.opsPurge.internalPurgeAnonymousOrganizations, {
        confirmDeployment: args.confirmDeployment,
        dryRun: false,
        maxOrgs,
        batchSize,
        ...next,
      });
    };

    if (args.expectTargetIds && !args.currentOrgId && (args.phase ?? "orgs") === "orgs") {
      const scan = await scanOrgs(ctx);
      const actual = scan.targets.slice(0, Math.max(0, maxOrgs - orgsDone)).map((x) => x.org._id as string).sort();
      const expected = [...new Set(args.expectTargetIds.map((id) => id as string))].sort();
      if (actual.length !== expected.length || actual.some((id, i) => id !== expected[i])) {
        const missing = expected.filter((id) => !actual.includes(id));
        const extra = actual.filter((id) => !expected.includes(id));
        throw new Error(`expectTargetIds não confere com os alvos atuais — nada foi apagado (faltando: ${missing.join(",") || "-"}; a mais: ${extra.join(",") || "-"})`);
      }
    }

    // ── Fase 1: orgs ──
    if ((args.phase ?? "orgs") === "orgs") {
      let org: Doc<"organizations"> | null = null;
      let deletedSoFar = args.deletedSoFar ?? 0;
      if (args.currentOrgId) {
        org = await ctx.db.get(args.currentOrgId);
        if (org) {
          // Re-verificação a cada lote: os membros que restam continuam anônimos?
          // `noMembers`/`aiOnly` são continuação normal: `teamMembers` sai por
          // último e o lote pode cortar entre o admin anônimo e a IA/pendentes.
          const cls = await classifyOrg(ctx, org);
          if (cls.kind === "legit" || cls.kind === "protected" || cls.kind === "bridgeConnected") {
            console.log(JSON.stringify({ op: "purgeAnonymousOrg", event: "aborted", organizationId: org._id, slug: org.slug, reason: cls.kind }));
            throw new Error(`org "${org.slug}" deixou de ser alvo no meio da purga (${cls.kind}) — abortado`);
          }
        }
      }
      if (!org && orgsDone < maxOrgs) {
        const scan = await scanOrgs(ctx);
        const next = scan.targets[0];
        if (next) {
          org = next.org;
          deletedSoFar = 0;
          const { counts, truncated } = await countOrg(ctx, org._id);
          console.log(JSON.stringify({
            op: "purgeAnonymousOrg", event: "start", organizationId: org._id, slug: org.slug, name: org.name,
            memberCount: next.cls.memberCount, anonUserIds: next.cls.anonUserIds, counts, countsTruncated: truncated,
          }));
        }
      }
      if (org) {
        const { deleted, exhausted } = await purgeSome(ctx, org._id, batchSize, { careful: true });
        deletedSoFar += deleted;
        if (exhausted) {
          await ctx.db.delete(org._id);
          console.log(JSON.stringify({ op: "purgeAnonymousOrg", event: "done", organizationId: org._id, slug: org.slug, deletedDocs: deletedSoFar }));
          await reschedule({ phase: "orgs", orgsDone: orgsDone + 1 });
          return { ...base, phase: "orgs" as const, current: org.slug, deletedThisRun: deleted, orgRemoved: true, orgsDone: orgsDone + 1, rescheduled: true };
        }
        await reschedule({ phase: "orgs", currentOrgId: org._id, orgsDone, deletedSoFar });
        return { ...base, phase: "orgs" as const, current: org.slug, deletedThisRun: deleted, rescheduled: true };
      }
      // Sem alvo (ou teto `maxOrgs` atingido): segue para os usuários.
    }

    // ── Fase 2: usuários anônimos órfãos ──
    const orphans = await orphanAnonymousUsers(ctx, ANON_USERS_PER_RUN + 1);
    const batch = orphans.slice(0, ANON_USERS_PER_RUN);
    for (const userId of batch) await deleteUserAuthData(ctx, userId);
    if (batch.length > 0) console.log(JSON.stringify({ op: "purgeAnonymousOrg", event: "users", deletedUserIds: batch }));
    const more = orphans.length > ANON_USERS_PER_RUN;
    if (more) await reschedule({ phase: "users", orgsDone });
    return { ...base, phase: more ? ("users" as const) : ("done" as const), usersDeleted: batch.length, rescheduled: more };
  },
});
