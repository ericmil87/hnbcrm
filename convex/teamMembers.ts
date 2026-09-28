import { v, ConvexError } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  requireAuth,
  requirePermission,
  getActiveMembership,
  isMembershipRevoked,
} from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { permissionsValidator } from "./schema";
import {
  resolvePermissions,
  hasPermission,
  type Role,
  type Permissions,
  type PermissionCategory,
} from "./lib/permissions";
import { normalizeEmail } from "./lib/emailAddress";

// Role hierarchy for elevation checks: admin > manager > agent/ai
const ROLE_RANK: Record<string, number> = { admin: 3, manager: 2, agent: 1, ai: 0 };

/**
 * Quem tem `team:manage` não pode criar/promover alguém acima de si: nem
 * cargo de rank maior, nem permissão customizada que ele mesmo não tem (um
 * agente com `team:manage` por override criaria um admin e herdaria tudo).
 */
function assertCanGrant(
  caller: Doc<"teamMembers">,
  role: string | undefined,
  permissions: Partial<Record<PermissionCategory, string>> | undefined,
) {
  if (role !== undefined && ROLE_RANK[role] > ROLE_RANK[caller.role]) {
    throw new ConvexError("Não é possível atribuir um cargo superior ao seu");
  }
  if (permissions) {
    const callerPerms = resolvePermissions(caller.role as Role, caller.permissions as Permissions | undefined);
    for (const [category, level] of Object.entries(permissions)) {
      if (level === undefined) continue;
      if (!hasPermission(callerPerms, category as PermissionCategory, level)) {
        throw new ConvexError("Não é possível conceder permissões acima das suas");
      }
    }
  }
}

/** Admins que ainda seguram a org (com conta, presentes ou ocupados, nunca removidos). */
async function countOtherAdmins(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  excludeId: Id<"teamMembers">,
) {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .collect();
  // Só conta quem consegue ENTRAR: linha pendente sem `userId` (convite antigo
  // que nunca virou conta — o auto-link por e-mail saiu) não segura a org.
  return members.filter(
    (m) =>
      m.role === "admin" &&
      m.userId !== undefined &&
      !isMembershipRevoked(m) &&
      m._id !== excludeId
  ).length;
}

/**
 * Estado do vínculo para as listas de equipe. `removed`: saiu da org (a tela
 * mostra para reativar; seletores de atribuição filtram). `pending`: pessoa
 * sem conta — convite antigo do `createTeamMember` humano, que o fim do
 * auto-link por e-mail deixou sem caminho de entrada; o admin reconvida (a
 * linha é adotada) ou remove.
 */
function membershipFlags(m: Doc<"teamMembers">) {
  return {
    removed: isMembershipRevoked(m),
    pending: m.type === "human" && m.userId === undefined && !isMembershipRevoked(m),
  };
}

/**
 * Linhas da org para um e-mail, cobrindo dado antigo gravado com maiúscula
 * (o índice é por igualdade exata: consulta a forma normalizada E a digitada).
 */
async function membersByEmailInOrg(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  rawEmail: string,
) {
  const variants = Array.from(new Set([normalizeEmail(rawEmail), rawEmail.trim()]));
  const rows: Doc<"teamMembers">[] = [];
  for (const email of variants) {
    const found = await ctx.db
      .query("teamMembers")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(100);
    for (const m of found) {
      if (m.organizationId === organizationId && !rows.some((r) => r._id === m._id)) rows.push(m);
    }
  }
  return rows;
}

// Get team members for organization
export const getTeamMembers = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(200);

    return await Promise.all(
      members.map(async (m) => {
        let avatarUrl: string | null = null;
        if (m.avatarFileId) {
          const file = await ctx.db.get(m.avatarFileId);
          if (file) {
            avatarUrl = await ctx.storage.getUrl(file.storageId);
          }
        }
        return { ...m, avatarUrl, ...membershipFlags(m) };
      })
    );
  },
});

// Get current user's team member record
export const getCurrentTeamMember = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    return await getActiveMembership(ctx, args.organizationId, userId);
  },
});

// Create team member (requires team:manage) — SÓ membro IA.
// Pessoa entra por `nodeActions.inviteHumanMember`: o ramo humano daqui
// gravava um membro com e-mail e sem conta, e quem se cadastrasse primeiro com
// aquele endereço herdava o vínculo (sem provar que é dono do e-mail).
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

    if (args.type === "human") {
      throw new ConvexError("Para adicionar uma pessoa use o convite por e-mail");
    }
    assertCanGrant(userMember, args.role, args.permissions);

    const now = Date.now();

    const teamMemberId = await ctx.db.insert("teamMembers", {
      organizationId: args.organizationId,
      name: args.name,
      email: args.email ? normalizeEmail(args.email) : undefined,
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

    // Status aqui é PRESENÇA. Tirar alguém da org é `removeTeamMember` (com a
    // guarda de último admin), e trazer de volta é `reactivateTeamMember` —
    // senão o removido (ou quem se removesse) contornaria as duas.
    if (args.status === "inactive") {
      throw new ConvexError("Para desativar um membro use Remover membro");
    }
    if (isMembershipRevoked(teamMember)) {
      throw new ConvexError("Membro removido — use Reativar membro");
    }

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
      assertCanGrant(userMember, args.role, undefined);

      // Guard: can't demote last admin
      if (teamMember.role === "admin" && args.role !== "admin") {
        if ((await countOtherAdmins(ctx, teamMember.organizationId, args.teamMemberId)) === 0) {
          throw new ConvexError("Não é possível rebaixar o último administrador");
        }
      }

      changes.role = args.role;
      before.role = teamMember.role;
    }

    if (args.permissions !== undefined) {
      // Só o que MUDA precisa caber nas permissões de quem edita: o painel
      // reenvia o objeto inteiro, e renomear alguém cujas permissões (dadas
      // por um admin) superam as do editor não pode falhar.
      const current = resolvePermissions(
        teamMember.role as Role,
        teamMember.permissions as Permissions | undefined
      ) as unknown as Record<string, string | undefined>;
      const changedOnly = Object.fromEntries(
        Object.entries(args.permissions).filter(([category, level]) => current[category] !== level)
      ) as Partial<Record<PermissionCategory, string>>;
      assertCanGrant(userMember, undefined, changedOnly);
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

    if (isMembershipRevoked(teamMember)) {
      throw new ConvexError("Membro já foi removido");
    }

    // Guard: can't remove last admin
    if (teamMember.role === "admin") {
      if ((await countOtherAdmins(ctx, teamMember.organizationId, args.teamMemberId)) === 0) {
        throw new ConvexError("Não é possível remover o último administrador");
      }
    }

    const now = Date.now();

    // `removedAt` corta o acesso (requireAuth, seletor de orgs, API keys);
    // `status: "inactive"` segue gravado para quem já lê o status (atendente
    // IA, tela de equipe). A linha fica: histórico, autoria e reconvite.
    await ctx.db.patch(args.teamMemberId, {
      status: "inactive",
      removedAt: now,
      removedBy: userMember._id,
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

    if (!isMembershipRevoked(teamMember)) {
      throw new Error("Membro já está ativo");
    }

    const now = Date.now();

    await ctx.db.patch(args.teamMemberId, {
      status: "active",
      removedAt: undefined,
      removedBy: undefined,
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

// Update member avatar
export const updateMemberAvatar = mutation({
  args: {
    teamMemberId: v.id("teamMembers"),
    avatarFileId: v.optional(v.id("files")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Membro não encontrado");

    const userMember = await requireAuth(ctx, teamMember.organizationId);
    const now = Date.now();

    // Self or team:manage
    if (userMember._id !== args.teamMemberId) {
      const perms = resolvePermissions(userMember.role as Role, (userMember as any).permissions);
      if (!hasPermission(perms, "team", "manage")) {
        throw new Error("Permissão insuficiente");
      }
    }

    // Delete old avatar file if exists
    if (teamMember.avatarFileId) {
      const oldFile = await ctx.db.get(teamMember.avatarFileId);
      if (oldFile) {
        await ctx.storage.delete(oldFile.storageId);
        await ctx.db.delete(oldFile._id);
      }
    }

    await ctx.db.patch(args.teamMemberId, {
      avatarFileId: args.avatarFileId,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: teamMember.organizationId,
      entityType: "teamMember",
      entityId: args.teamMemberId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: {
        before: { avatarFileId: teamMember.avatarFileId },
        after: { avatarFileId: args.avatarFileId },
      },
      metadata: { name: teamMember.name },
      description: buildAuditDescription({
        action: "update",
        entityType: "teamMember",
        metadata: { name: teamMember.name },
        changes: { before: { avatarFileId: teamMember.avatarFileId }, after: { avatarFileId: args.avatarFileId } },
      }),
      severity: "low",
      createdAt: now,
    });

    return null;
  },
});

// Chamada pelo frontend logo após um "reset-verification" bem-sucedido
// (código de e-mail + senha nova). Quem acabou de provar que tem acesso ao
// e-mail e escolheu a própria senha nova não deveria ser forçado a trocá-la
// de novo no primeiro login — esse flag existe para senha TEMPORÁRIA de
// convite, e a redefinição por código já cumpre esse papel.
//
// Limite de segurança: só mexe nos teamMembers do PRÓPRIO usuário
// autenticado (via `by_user`, sem organizationId no arg — a troca de senha
// não é escopada a uma org) — nunca aceita um id de outro usuário.
export const clearMustChangePasswordAfterReset = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    for (const member of members) {
      if (member.mustChangePassword) {
        await ctx.db.patch(member._id, {
          mustChangePassword: false,
          updatedAt: Date.now(),
        });
      }
    }

    return null;
  },
});

// ===== Internal functions =====

// Internal: Get team members for organization (used by HTTP API router / MCP
// `crm_list_team`). Carrega `removed`/`pending` para quem integra não
// oferecer ex-membro como responsável (a atribuição seria recusada).
export const internalGetTeamMembers = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(200);
    return members.map((m) => ({ ...m, ...membershipFlags(m) }));
  },
});

// Internal: pré-checagem do convite (antes de criar conta). Tudo que pode
// recusar o convite roda AQUI, porque a action não é transacional: recusar
// depois de criar o usuário deixaria uma conta órfã com senha que ninguém viu.
export const internalPrepareInvite = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("manager"), v.literal("agent")),
    permissions: v.optional(permissionsValidator),
  },
  returns: v.object({ callerMemberId: v.id("teamMembers") }),
  handler: async (ctx, args) => {
    const caller = await requirePermission(ctx, args.organizationId, "team", "manage");
    assertCanGrant(caller, args.role, args.permissions);

    const rows = await membersByEmailInOrg(ctx, args.organizationId, args.email);
    if (rows.some((m) => !isMembershipRevoked(m) && m.userId !== undefined)) {
      throw new ConvexError("Este usuário já é membro desta organização");
    }
    return { callerMemberId: caller._id };
  },
});

// Internal: grava o vínculo do convite, sem duplicar (org, usuário) nem
// (org, e-mail). Reaproveita, nesta ordem: a linha do MESMO usuário (removida
// → reativa), ou uma linha pendente sem conta com o mesmo e-mail (legado do
// antigo `createTeamMember` humano). Só insere quando não há nenhuma.
export const internalUpsertInvitedMember = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    userId: v.id("users"),
    name: v.string(),
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("manager"), v.literal("agent")),
    invitedBy: v.id("teamMembers"),
    mustChangePassword: v.boolean(),
    permissions: v.optional(permissionsValidator),
  },
  returns: v.object({
    teamMemberId: v.id("teamMembers"),
    outcome: v.union(v.literal("created"), v.literal("reactivated"), v.literal("linked_pending")),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const email = normalizeEmail(args.email);

    const byUser = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", args.userId)
      )
      .take(10);
    const byEmail = await membersByEmailInOrg(ctx, args.organizationId, args.email);

    // Re-checagem dentro da transação: dois cliques no "Convidar" passam
    // juntos pela pré-checagem, mas só um grava.
    if (
      byUser.some((m) => !isMembershipRevoked(m)) ||
      byEmail.some((m) => !isMembershipRevoked(m) && m.userId !== undefined)
    ) {
      throw new ConvexError("Este usuário já é membro desta organização");
    }

    const reusable =
      byUser[0] ?? byEmail.find((m) => m.userId === undefined && m.type === "human");
    const outcome: "created" | "reactivated" | "linked_pending" = !reusable
      ? "created"
      : reusable.userId === undefined
        ? "linked_pending"
        : "reactivated";

    let teamMemberId: Id<"teamMembers">;
    if (reusable) {
      teamMemberId = reusable._id;
      await ctx.db.patch(reusable._id, {
        userId: args.userId,
        name: args.name,
        email,
        role: args.role,
        type: "human",
        status: "active",
        removedAt: undefined,
        removedBy: undefined,
        invitedBy: args.invitedBy,
        mustChangePassword: args.mustChangePassword,
        permissions: args.permissions,
        updatedAt: now,
      });
    } else {
      teamMemberId = await ctx.db.insert("teamMembers", {
        organizationId: args.organizationId,
        userId: args.userId,
        name: args.name,
        email,
        role: args.role,
        type: "human",
        status: "active",
        invitedBy: args.invitedBy,
        mustChangePassword: args.mustChangePassword,
        permissions: args.permissions,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "teamMember",
      entityId: teamMemberId,
      action: outcome === "created" ? "create" : "update",
      actorId: args.invitedBy,
      actorType: "human",
      metadata: { name: args.name, email, role: args.role, invited: true, outcome },
      description: buildAuditDescription({
        action: outcome === "created" ? "create" : "update",
        entityType: "teamMember",
        metadata: { name: args.name, role: args.role },
      }),
      severity: "high",
      createdAt: now,
    });

    return { teamMemberId, outcome };
  },
});

// Internal: Verify caller has team:manage for action context
export const internalVerifyTeamManager = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const userMember = await getActiveMembership(ctx, args.organizationId, userId);
    if (!userMember) return null;

    const perms = resolvePermissions(userMember.role as Role, (userMember as any).permissions);
    if (!hasPermission(perms, "team", "manage")) return null;

    return userMember;
  },
});

/**
 * Senha temporária é da CONTA, não do vínculo: o flag mora em cada membro, mas
 * vale para o usuário inteiro. Sem isto, quem foi convidado com conta nova em
 * D (flag ligado) e depois adicionado a B como conta existente (flag
 * desligado) escapava da troca escolhendo B.
 */
async function userMustChangePassword(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(100);
  return members.some((m) => m.mustChangePassword === true && !isMembershipRevoked(m));
}

// Nível do USUÁRIO (sem org): o front bloqueia com a troca de senha qualquer
// que seja a org selecionada.
export const getMustChangePassword = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    return await userMustChangePassword(ctx, userId);
  },
});

// Internal: o convite de conta EXISTENTE herda a senha temporária pendente.
export const internalUserMustChangePassword = internalQuery({
  args: { userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, args) => await userMustChangePassword(ctx, args.userId),
});

// Internal: limpa o flag em TODOS os membros do usuário (após trocar a senha).
export const internalClearMustChangePasswordForUser = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(100);
    for (const member of members) {
      if (member.mustChangePassword) {
        await ctx.db.patch(member._id, { mustChangePassword: false, updatedAt: Date.now() });
      }
    }
    return null;
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
    return await getActiveMembership(ctx, args.organizationId, args.userId);
  },
});
