import { v, ConvexError } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { requireAuth, getActiveMembership, isMembershipRevoked } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { aiConfigValidator } from "./schema";

// Get user's organizations
export const getUserOrganizations = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const teamMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);

    // Removido da org = some do seletor (o vínculo acabou; o histórico fica).
    const memberships = teamMembers.filter((m) => !isMembershipRevoked(m));
    const seen = new Set<string>();
    const organizations = await Promise.all(
      memberships.map(async (member) => {
        if (seen.has(member.organizationId)) return null;
        seen.add(member.organizationId);
        const org = await ctx.db.get(member.organizationId);
        // `invited`: o vínculo nasceu de convite (quem criou a org não tem
        // `invitedBy`) — o front só anuncia "você foi adicionado" nesse caso.
        return org
          ? { ...org, role: member.role, type: member.type, invited: member.invitedBy !== undefined }
          : null;
      })
    );

    return organizations.filter(Boolean);
  },
});

// Create organization
export const createOrganization = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
  },
  returns: v.id("organizations"),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const user = await ctx.db.get(userId);
    if (!user) throw new Error("User not found");

    // Check if slug is available
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    
    // ConvexError: em produção um Error comum chega ao cliente como "Server
    // Error"; o front traduz por /slug/i, então a palavra fica.
    if (existing) throw new ConvexError("Este endereço (slug) já está em uso por outra organização");

    const now = Date.now();
    
    // Create organization
    const orgId = await ctx.db.insert("organizations", {
      name: args.name,
      slug: args.slug,
      settings: {
        // Produto PT-BR: os defaults seguem o público (o assistente ajusta).
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        // IA é opt-in total: nasce DESLIGADA; o admin ativa na seção IA
        // (que também exige o aceite LGPD antes de qualquer inferência).
        aiConfig: {
          enabled: false,
          autoAssign: false,
          handoffThreshold: 0.8,
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    // Create admin team member
    const teamMemberId = await ctx.db.insert("teamMembers", {
      organizationId: orgId,
      userId,
      name: user.name || user.email || "Admin",
      email: user.email,
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // E-mail de boas-vindas para o admin que acabou de se cadastrar.
    await ctx.scheduler.runAfter(0, internal.authEmails.sendWelcomeEmail, {
      organizationId: orgId,
      teamMemberId,
    });

    // Create default board and stages
    const boardId = await ctx.db.insert("boards", {
      organizationId: orgId,
      name: "Funil de Vendas",
      description: "Funil padrão",
      color: "#3B82F6",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });

    const stages = [
      { name: "Novo lead", color: "#EF4444", order: 0 },
      { name: "Qualificado", color: "#F59E0B", order: 1 },
      { name: "Proposta", color: "#8B5CF6", order: 2 },
      { name: "Negociação", color: "#06B6D4", order: 3 },
      { name: "Ganho", color: "#10B981", order: 4, isClosedWon: true },
      { name: "Perdido", color: "#6B7280", order: 5, isClosedLost: true },
    ];

    for (const stage of stages) {
      await ctx.db.insert("stages", {
        organizationId: orgId,
        boardId,
        name: stage.name,
        color: stage.color,
        order: stage.order,
        isClosedWon: stage.isClosedWon || false,
        isClosedLost: stage.isClosedLost || false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Create default lead sources
    const sources = [
      { name: "Website", type: "website" as const },
      { name: "Redes Sociais", type: "social" as const },
      { name: "Campanha de E-mail", type: "email" as const },
      { name: "Telefone", type: "phone" as const },
      { name: "Indicação", type: "referral" as const },
      { name: "API", type: "api" as const },
    ];

    for (const source of sources) {
      await ctx.db.insert("leadSources", {
        organizationId: orgId,
        name: source.name,
        type: source.type,
        isActive: true,
        createdAt: now,
      });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: orgId,
      entityType: "organization",
      entityId: orgId,
      action: "create",
      actorId: teamMemberId,
      actorType: "human",
      metadata: { name: args.name, slug: args.slug },
      description: buildAuditDescription({ action: "create", entityType: "organization", metadata: { name: args.name, slug: args.slug } }),
      severity: "medium",
      createdAt: now,
    });

    return orgId;
  },
});

// Get organization by slug
export const getOrganizationBySlug = query({
  args: { slug: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const org = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (!org) return null;
    // Só membros resolvem o slug — senão qualquer usuário logado enumeraria
    // as orgs (id + nome) do deployment.
    if (!(await getActiveMembership(ctx, org._id, userId))) return null;
    return { _id: org._id, name: org.name, slug: org.slug };
  },
});

// Update organization (admin only)
export const updateOrganization = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.optional(v.string()),
    settings: v.optional(v.object({
      timezone: v.string(),
      currency: v.string(),
      aiConfig: v.optional(aiConfigValidator),
    })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organization not found");

    const userMember = await requireAuth(ctx, args.organizationId);
    if (userMember.role !== "admin") throw new Error("Not authorized");

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.name !== undefined && args.name !== org.name) {
      changes.name = args.name;
      before.name = org.name;
    }
    if (args.settings !== undefined) {
      // MERGE, nunca substituir: o validador acima só conhece timezone/
      // currency/aiConfig, e o patch do objeto inteiro apagava
      // optOutKeywords, campaignDefaults e o que mais vive em settings.
      changes.settings = { ...(org.settings ?? {}), ...args.settings };
      if (args.settings.aiConfig === undefined && org.settings?.aiConfig !== undefined) {
        changes.settings.aiConfig = org.settings.aiConfig;
      }
      before.settings = org.settings;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.organizationId, {
      ...changes,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before, after: changes },
      description: buildAuditDescription({ action: "update", entityType: "organization", changes: { before, after: changes } }),
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Internal: Get organization by ID (used by router instead of getOrganizationBySlug)
export const internalGetOrganization = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.organizationId);
  },
});

// Internal: Get organization by slug (used by HTTP API router)
export const internalGetOrganizationBySlug = internalQuery({
  args: { slug: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

// Deep-link de entidade (`?task=`, `?conversation=`, `?lead=`, `?handoff=`):
// diz a org do item SÓ se o usuário tem vínculo ativo nela, para o front
// trocar de org antes de abrir. Para quem não é membro (ou id inválido,
// inexistente, deslogado) devolve null — não revela a org de ninguém.
export const resolveEntityOrg = query({
  args: {
    kind: v.union(v.literal("task"), v.literal("conversation"), v.literal("lead"), v.literal("handoff")),
    id: v.string(),
  },
  returns: v.union(v.null(), v.object({ organizationId: v.id("organizations") })),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const table =
      args.kind === "task" ? "tasks"
      : args.kind === "conversation" ? "conversations"
      : args.kind === "lead" ? "leads"
      : "handoffs";
    const docId = ctx.db.normalizeId(table, args.id);
    if (!docId) return null;
    const doc = await ctx.db.get(docId);
    if (!doc) return null;

    if (!(await getActiveMembership(ctx, doc.organizationId, userId))) return null;
    return { organizationId: doc.organizationId };
  },
});
