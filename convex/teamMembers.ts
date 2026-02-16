import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { requireAuth, requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { permissionsValidator } from "./schema";
import { resolvePermissions, hasPermission, type Role } from "./lib/permissions";

// Role hierarchy for elevation checks: admin > manager > agent/ai
const ROLE_RANK: Record<string, number> = { admin: 3, manager: 2, agent: 1, ai: 0 };

// Get team members for organization
export const getTeamMembers = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    return await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(200);
  },
});

// Get current user's team member record
export const getCurrentTeamMember = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    return await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId)
      )
      .first();
  },
});

// Search user by email — checks if user exists and if already a member of the org
export const searchUserByEmail = query({
  args: {
    organizationId: v.id("organizations"),
    email: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "team", "manage");

    // Check if email already belongs to a team member in this org
    const existingMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();

    const isOrgMember = existingMember?.organizationId === args.organizationId;

    // Check if a user account exists with this email
    const existingUsers = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), args.email))
      .take(1);

    return {
      userExists: existingUsers.length > 0,
      isOrgMember,
      existingMember: isOrgMember ? existingMember : null,
    };
  },
});

// Create team member (requires team:manage)
export const createTeamMember = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    email: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("manager"), v.literal("agent"), v.literal("ai")),
    type: v.union(v.literal("human"), v.literal("ai")),
    capabilities: v.optional(v.array(v.string())),
    permissions: v.optional(permissionsValidator),
  },
  returns: v.id("teamMembers"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "team", "manage");

    const now = Date.now();

    // For human members with email, try to link to existing user immediately
    let userId = undefined as any;
    if (args.type === "human" && args.email) {
      const existingUsers = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("email"), args.email))
        .take(1);
      if (existingUsers.length > 0) {
        userId = existingUsers[0]._id;
      }
    }

    const teamMemberId = await ctx.db.insert("teamMembers", {
      organizationId: args.organizationId,
      userId,
      name: args.name,
      email: args.email,
      role: args.role,
      type: args.type,
      status: "active",
      capabilities: args.capabilities,
      permissions: args.permissions,
      createdAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "teamMember",
      entityId: teamMemberId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name, role: args.role, type: args.type },
      description: buildAuditDescription({ action: "create", entityType: "teamMember", metadata: { name: args.name, role: args.role, type: args.type } }),
      severity: "medium",
      createdAt: now,
    });

    return teamMemberId;
  },
});

// Update team member status (requires team:manage or self)
export const updateTeamMemberStatus = mutation({
  args: {
    teamMemberId: v.id("teamMembers"),
    status: v.union(v.literal("active"), v.literal("inactive"), v.literal("busy")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Membro não encontrado");

    const userMember = await requireAuth(ctx, teamMember.organizationId);

    // Self can change own status; otherwise need team:manage
    if (userMember._id !== args.teamMemberId) {
      const perms = resolvePermissions(userMember.role as Role, (userMember as any).permissions);
      if (!hasPermission(perms, "team", "manage")) {
        throw new Error("Permissão insuficiente");
      }
    }

    const now = Date.now();

    await ctx.db.patch(args.teamMemberId, {
      status: args.status,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: teamMember.organizationId,
      entityType: "teamMember",
      entityId: args.teamMemberId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { status: teamMember.status },
        after: { status: args.status },
      },
      description: buildAuditDescription({ action: "update", entityType: "teamMember", changes: { before: { status: teamMember.status }, after: { status: args.status } } }),
      severity: "low",
      createdAt: now,
    });

    return null;
  },
});

// Update team member (name, role, permissions) — requires team:manage
export const updateTeamMember = mutation({
  args: {
    teamMemberId: v.id("teamMembers"),
    name: v.optional(v.string()),
    role: v.optional(v.union(v.literal("admin"), v.literal("manager"), v.literal("agent"), v.literal("ai"))),
    permissions: v.optional(permissionsValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Membro não encontrado");

    const userMember = await requirePermission(ctx, teamMember.organizationId, "team", "manage");

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.name !== undefined && args.name !== teamMember.name) {
      changes.name = args.name;
      before.name = teamMember.name;
    }

    if (args.role !== undefined && args.role !== teamMember.role) {
      // Guard: can't elevate beyond own role
      if (ROLE_RANK[args.role] > ROLE_RANK[userMember.role]) {
        throw new Error("Não é possível atribuir um cargo superior ao seu");
      }

      // Guard: can't demote last admin
      if (teamMember.role === "admin" && args.role !== "admin") {
        const admins = await ctx.db
          .query("teamMembers")
          .withIndex("by_organization", (q) => q.eq("organizationId", teamMember.organizationId))
          .collect();
        const activeAdmins = admins.filter(
          (m) => m.role === "admin" && m.status === "active" && m._id !== args.teamMemberId
        );
        if (activeAdmins.length === 0) {
          throw new Error("Não é possível rebaixar o último administrador");
        }
      }

      changes.role = args.role;
      before.role = teamMember.role;
    }

    if (args.permissions !== undefined) {
      changes.permissions = args.permissions;
      before.permissions = teamMember.permissions;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.teamMemberId, {
      ...changes,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: teamMember.organizationId,
      entityType: "teamMember",
      entityId: args.teamMemberId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before, after: changes },
      metadata: { name: teamMember.name },
      description: buildAuditDescription({ action: "update", entityType: "teamMember", metadata: { name: teamMember.name }, changes: { before, after: changes } }),
      severity: "high",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: teamMember.organizationId,
      event: "teamMember.updated",
      payload: { teamMemberId: args.teamMemberId, changes },
    });

    return null;
  },
});

// Remove (deactivate) team member — requires team:manage
export const removeTeamMember = mutation({
  args: { teamMemberId: v.id("teamMembers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Membro não encontrado");

    const userMember = await requirePermission(ctx, teamMember.organizationId, "team", "manage");

    // Guard: can't remove self
    if (userMember._id === args.teamMemberId) {
      throw new Error("Não é possível remover a si mesmo");
    }

    // Guard: can't remove last admin
    if (teamMember.role === "admin") {
      const admins = await ctx.db
        .query("teamMembers")
        .withIndex("by_organization", (q) => q.eq("organizationId", teamMember.organizationId))
        .collect();
      const activeAdmins = admins.filter(
        (m) => m.role === "admin" && m.status === "active" && m._id !== args.teamMemberId
      );
      if (activeAdmins.length === 0) {
        throw new Error("Não é possível remover o último administrador");
      }
    }

    const now = Date.now();

    await ctx.db.patch(args.teamMemberId, {
      status: "inactive",
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: teamMember.organizationId,
      entityType: "teamMember",
      entityId: args.teamMemberId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: teamMember.name, role: teamMember.role },
      description: buildAuditDescription({ action: "delete", entityType: "teamMember", metadata: { name: teamMember.name } }),
      severity: "high",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: teamMember.organizationId,
      event: "teamMember.removed",
      payload: { teamMemberId: args.teamMemberId, name: teamMember.name },
    });

    return null;
  },
});

// Reactivate team member — requires team:manage
export const reactivateTeamMember = mutation({
  args: { teamMemberId: v.id("teamMembers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Membro não encontrado");

    const userMember = await requirePermission(ctx, teamMember.organizationId, "team", "manage");

    if (teamMember.status !== "inactive") {
      throw new Error("Membro já está ativo");
    }

    const now = Date.now();

    await ctx.db.patch(args.teamMemberId, {
      status: "active",
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: teamMember.organizationId,
      entityType: "teamMember",
      entityId: args.teamMemberId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { status: "inactive" },
        after: { status: "active" },
      },
      metadata: { name: teamMember.name },
      description: buildAuditDescription({ action: "update", entityType: "teamMember", metadata: { name: teamMember.name }, changes: { before: { status: "inactive" }, after: { status: "active" } } }),
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// ===== Internal functions =====

// Internal: Get team members for organization (used by HTTP API router)
export const internalGetTeamMembers = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(200);
  },
});

// Internal: Create team member with invite metadata (used by inviteHumanMember action)
export const internalCreateInvitedMember = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    userId: v.optional(v.id("users")),
    name: v.string(),
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("manager"), v.literal("agent")),
    invitedBy: v.id("teamMembers"),
    mustChangePassword: v.boolean(),
    permissions: v.optional(permissionsValidator),
  },
  returns: v.id("teamMembers"),
  handler: async (ctx, args) => {
    const now = Date.now();

    const teamMemberId = await ctx.db.insert("teamMembers", {
      organizationId: args.organizationId,
      userId: args.userId,
      name: args.name,
      email: args.email,
      role: args.role,
      type: "human",
      status: "active",
      invitedBy: args.invitedBy,
      mustChangePassword: args.mustChangePassword,
      permissions: args.permissions,
      createdAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "teamMember",
      entityId: teamMemberId,
      action: "create",
      actorId: args.invitedBy,
      actorType: "human",
      metadata: { name: args.name, email: args.email, role: args.role, invited: true },
      description: buildAuditDescription({ action: "create", entityType: "teamMember", metadata: { name: args.name, role: args.role } }),
      severity: "high",
      createdAt: now,
    });

    return teamMemberId;
  },
});

// Internal: Verify caller has team:manage for action context
export const internalVerifyTeamManager = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", userId)
      )
      .first();

    if (!userMember) return null;

    const perms = resolvePermissions(userMember.role as Role, (userMember as any).permissions);
    if (!hasPermission(perms, "team", "manage")) return null;

    return userMember;
  },
});

// Internal: Clear mustChangePassword flag (called after password change)
export const internalClearMustChangePassword = internalMutation({
  args: { teamMemberId: v.id("teamMembers") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.teamMemberId, {
      mustChangePassword: false,
      updatedAt: Date.now(),
    });
    return null;
  },
});

// Internal: Find team member by user ID in org
export const internalGetMemberByUserId = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    userId: v.id("users"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", args.userId)
      )
      .first();
  },
});
