/**
 * Setores (filas de atendimento) — módulo `departments` do MVP "Central".
 *
 * Leitura: `requireAuth`; com o módulo desligado a lista volta VAZIA. Escrita:
 * `settings:manage` + módulo ligado.
 */
import { v } from "convex/values";
import { query, mutation, MutationCtx, QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireAuth, requirePermission, assertAssignableMember } from "./lib/auth";
import { assertModule, getModules } from "./lib/orgModules";
import { departmentFields } from "./schema";

// Teto da contagem de conversas abertas por setor (a UI mostra "500+").
export const DEPARTMENT_OPEN_COUNT_CAP = 500;

export const departmentDocValidator = v.object({
  _id: v.id("departments"),
  _creationTime: v.number(),
  ...departmentFields,
});

const editableDepartmentFields = {
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  color: v.optional(v.string()),
  icon: v.optional(v.string()),
  memberIds: v.optional(v.array(v.id("teamMembers"))),
  unitIds: v.optional(v.array(v.id("units"))),
  isEntry: v.optional(v.boolean()),
  order: v.optional(v.number()),
};

const DEFAULT_DEPARTMENT_COLOR = "#3b82f6";

/** Conversas não arquivadas do setor (e as não lidas), com teto. */
export async function departmentConversationCounts(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  departmentId: Id<"departments">
): Promise<{ openCount: number; unreadCount: number }> {
  const rows = await ctx.db
    .query("conversations")
    .withIndex("by_organization_and_department", (q) =>
      q.eq("organizationId", organizationId).eq("departmentId", departmentId)
    )
    .order("desc")
    .take(DEPARTMENT_OPEN_COUNT_CAP * 2);
  let openCount = 0;
  let unreadCount = 0;
  for (const c of rows) {
    if (c.archivedAt) continue;
    if (openCount >= DEPARTMENT_OPEN_COUNT_CAP) break;
    openCount++;
    unreadCount += c.unreadCount ?? 0;
  }
  return { openCount, unreadCount };
}

async function assertDepartmentRefs(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  refs: { memberIds?: Id<"teamMembers">[]; unitIds?: Id<"units">[] }
) {
  for (const id of refs.memberIds ?? []) {
    await assertAssignableMember(ctx, organizationId, id);
  }
  for (const id of refs.unitIds ?? []) {
    const unit = await ctx.db.get(id);
    if (!unit || unit.organizationId !== organizationId) {
      throw new Error("Unidade não pertence à organização");
    }
  }
}

async function auditDepartment(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    departmentId: Id<"departments">;
    action: "create" | "update" | "delete";
    actorId: Id<"teamMembers">;
    name: string;
    now: number;
  }
) {
  const verb = args.action === "create" ? "Criou" : args.action === "update" ? "Editou" : "Excluiu";
  await ctx.db.insert("auditLogs", {
    organizationId: args.organizationId,
    entityType: "department",
    entityId: args.departmentId,
    action: args.action,
    actorId: args.actorId,
    actorType: "human",
    metadata: { name: args.name },
    description: `${verb} o setor "${args.name}"`,
    severity: args.action === "delete" ? "medium" : "low",
    createdAt: args.now,
  });
}

export const listDepartments = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({
      ...departmentDocValidator.fields,
      members: v.array(
        v.object({
          _id: v.id("teamMembers"),
          name: v.string(),
          type: v.union(v.literal("human"), v.literal("ai")),
        })
      ),
      openCount: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    if (!(await getModules(ctx, args.organizationId)).departments) return [];
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(100);
    departments.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

    return await Promise.all(
      departments.map(async (dept) => {
        const members = (await Promise.all(dept.memberIds.map((id) => ctx.db.get(id))))
          .filter((m): m is NonNullable<typeof m> => m !== null && m.organizationId === args.organizationId)
          .map((m) => ({ _id: m._id, name: m.name, type: m.type }));
        const { openCount } = await departmentConversationCounts(ctx, args.organizationId, dept._id);
        return { ...dept, members, openCount };
      })
    );
  },
});

export const createDepartment = mutation({
  args: {
    organizationId: v.id("organizations"),
    ...editableDepartmentFields,
    name: v.string(),
  },
  returns: v.id("departments"),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await assertModule(ctx, args.organizationId, "departments");
    const name = args.name.trim();
    if (!name) throw new Error("Nome do setor é obrigatório");
    await assertDepartmentRefs(ctx, args.organizationId, args);

    const existing = await ctx.db
      .query("departments")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(100);
    const now = Date.now();
    const { organizationId, ...fields } = args;
    const departmentId = await ctx.db.insert("departments", {
      ...fields,
      organizationId,
      name,
      color: args.color ?? DEFAULT_DEPARTMENT_COLOR,
      memberIds: args.memberIds ?? [],
      order: args.order ?? existing.reduce((max, d) => Math.max(max, d.order + 1), 0),
      createdAt: now,
      updatedAt: now,
    });
    await auditDepartment(ctx, {
      organizationId,
      departmentId,
      action: "create",
      actorId: member._id,
      name,
      now,
    });
    return departmentId;
  },
});

export const updateDepartment = mutation({
  args: { departmentId: v.id("departments"), ...editableDepartmentFields },
  returns: v.null(),
  handler: async (ctx, args) => {
    const dept = await ctx.db.get(args.departmentId);
    if (!dept) throw new Error("Setor não encontrado");
    const member = await requirePermission(ctx, dept.organizationId, "settings", "manage");
    await assertModule(ctx, dept.organizationId, "departments");
    await assertDepartmentRefs(ctx, dept.organizationId, args);

    const { departmentId, ...patch } = args;
    if (patch.name !== undefined) {
      patch.name = patch.name.trim();
      if (!patch.name) throw new Error("Nome do setor é obrigatório");
    }
    const now = Date.now();
    await ctx.db.patch(departmentId, { ...patch, updatedAt: now });
    await auditDepartment(ctx, {
      organizationId: dept.organizationId,
      departmentId,
      action: "update",
      actorId: member._id,
      name: patch.name ?? dept.name,
      now,
    });
    return null;
  },
});

/** Recusa se houver conversa (mesmo arquivada) no setor — reatribua antes. */
export const deleteDepartment = mutation({
  args: { departmentId: v.id("departments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const dept = await ctx.db.get(args.departmentId);
    if (!dept) throw new Error("Setor não encontrado");
    const member = await requirePermission(ctx, dept.organizationId, "settings", "manage");
    await assertModule(ctx, dept.organizationId, "departments");

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_organization_and_department", (q) =>
        q.eq("organizationId", dept.organizationId).eq("departmentId", args.departmentId)
      )
      .first();
    if (conversation) {
      throw new Error("Este setor tem conversas — transfira-as para outro setor antes de excluir");
    }

    await ctx.db.delete(args.departmentId);
    await auditDepartment(ctx, {
      organizationId: dept.organizationId,
      departmentId: args.departmentId,
      action: "delete",
      actorId: member._id,
      name: dept.name,
      now: Date.now(),
    });
    return null;
  },
});
