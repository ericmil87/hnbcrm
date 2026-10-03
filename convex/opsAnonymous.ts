/**
 * Auditoria SOMENTE LEITURA do legado do login anônimo (removido na v0.68.1).
 * Lista usuários sem e-mail (o usuário anônimo do Convex Auth não tem) e o que
 * eles têm: orgs, canais, campanhas, leads e mensagens agendadas. Não escreve
 * nada — desarmar/cancelar é decisão do Eric, com as ops de `opsMigration`.
 *
 * Varre a tabela `users` com `take(USER_SCAN_CAP)` (não há índice por e-mail
 * ausente); `truncated` avisa se o teto foi atingido.
 */
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

const USER_SCAN_CAP = 5000;
const COUNT_CAP = 200;

const orgSummary = v.object({
  organizationId: v.id("organizations"),
  slug: v.string(),
  name: v.string(),
  role: v.string(),
  removed: v.boolean(),
  channelConfigs: v.number(),
  campaigns: v.number(),
  leads: v.number(),
  scheduledMessages: v.number(),
  members: v.number(),
  apiKeys: v.number(),
  activeApiKeys: v.number(),
});

export const internalListAnonymousUsers = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    scanned: v.number(),
    truncated: v.boolean(),
    total: v.number(),
    users: v.array(
      v.object({
        userId: v.id("users"),
        createdAt: v.number(),
        name: v.union(v.string(), v.null()),
        hasAnonymousAccount: v.boolean(),
        orgs: v.array(orgSummary),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 20), 200));
    const all = await ctx.db.query("users").take(USER_SCAN_CAP);
    const anon = all.filter((u) => typeof u.email !== "string" || u.email.trim() === "");

    const users = [];
    for (const u of anon.slice(0, limit)) {
      const account = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", u._id).eq("provider", "anonymous"))
        .first();
      const memberships = await ctx.db
        .query("teamMembers")
        .withIndex("by_user", (q) => q.eq("userId", u._id))
        .take(50);
      const orgs = [];
      for (const m of memberships) {
        const org = await ctx.db.get(m.organizationId);
        if (!org) continue;
        const oid = org._id;
        const [channels, campaigns, leads, scheduled, members, keys] = await Promise.all([
          ctx.db.query("channelConfigs").withIndex("by_organization", (q) => q.eq("organizationId", oid)).take(COUNT_CAP),
          ctx.db.query("campaigns").withIndex("by_organization", (q) => q.eq("organizationId", oid)).take(COUNT_CAP),
          ctx.db.query("leads").withIndex("by_organization", (q) => q.eq("organizationId", oid)).take(COUNT_CAP),
          ctx.db.query("scheduledMessages").withIndex("by_organization", (q) => q.eq("organizationId", oid)).take(COUNT_CAP),
          ctx.db.query("teamMembers").withIndex("by_organization", (q) => q.eq("organizationId", oid)).take(COUNT_CAP),
          ctx.db.query("apiKeys").withIndex("by_organization", (q) => q.eq("organizationId", oid)).take(COUNT_CAP),
        ]);
        orgs.push({
          organizationId: oid,
          slug: org.slug,
          name: org.name,
          role: m.role,
          removed: m.removedAt !== undefined,
          channelConfigs: channels.length,
          campaigns: campaigns.length,
          leads: leads.length,
          scheduledMessages: scheduled.length,
          members: members.length,
          apiKeys: keys.length,
          activeApiKeys: keys.filter((k) => k.isActive).length,
        });
      }
      users.push({
        userId: u._id,
        createdAt: u._creationTime,
        name: u.name ?? null,
        hasAnonymousAccount: account !== null,
        orgs,
      });
    }
    return { scanned: all.length, truncated: all.length >= USER_SCAN_CAP, total: anon.length, users };
  },
});
