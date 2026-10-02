/**
 * Unidades (hotéis/filiais) — módulo `units` do MVP "Central".
 *
 * Leitura: `requireAuth`; com o módulo desligado a lista volta VAZIA (a UI
 * nunca quebra por consultar antes de saber os módulos). Escrita:
 * `settings:manage` + módulo ligado.
 */
import { v } from "convex/values";
import { query, mutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireAuth, requirePermission } from "./lib/auth";
import { assertModule, getModules } from "./lib/orgModules";
import { unitFields } from "./schema";

export const unitDocValidator = v.object({
  _id: v.id("units"),
  _creationTime: v.number(),
  ...unitFields,
});

const unitStatusValidator = unitFields.status;

// Campos editáveis (tudo menos org/ordem/carimbos).
const editableUnitFields = {
  name: v.optional(v.string()),
  shortName: v.optional(v.string()),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  kind: v.optional(v.string()),
  color: v.optional(v.string()),
  status: v.optional(unitStatusValidator),
  roomsCount: v.optional(v.number()),
  bookingUrl: v.optional(v.string()),
  whatsappLabel: v.optional(v.string()),
  channelConfigIds: v.optional(v.array(v.id("channelConfigs"))),
  boardId: v.optional(v.id("boards")),
  description: v.optional(v.string()),
  order: v.optional(v.number()),
};

const DEFAULT_UNIT_COLOR = "#f97316";

async function assertUnitRefsInOrg(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  refs: { channelConfigIds?: Id<"channelConfigs">[]; boardId?: Id<"boards"> }
) {
  for (const id of refs.channelConfigIds ?? []) {
    const config = await ctx.db.get(id);
    if (!config || config.organizationId !== organizationId) {
      throw new Error("Canal não pertence à organização");
    }
  }
  if (refs.boardId) {
    const board = await ctx.db.get(refs.boardId);
    if (!board || board.organizationId !== organizationId) {
      throw new Error("Pipeline não pertence à organização");
    }
  }
}

async function auditUnit(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    unitId: Id<"units">;
    action: "create" | "update" | "delete";
    actorId: Id<"teamMembers">;
    name: string;
    now: number;
  }
) {
  const verb = args.action === "create" ? "Criou" : args.action === "update" ? "Editou" : "Excluiu";
  await ctx.db.insert("auditLogs", {
    organizationId: args.organizationId,
    entityType: "unit",
    entityId: args.unitId,
    action: args.action,
    actorId: args.actorId,
    actorType: "human",
    metadata: { name: args.name },
    description: `${verb} a unidade "${args.name}"`,
    severity: args.action === "delete" ? "medium" : "low",
    createdAt: args.now,
  });
}

export const listUnits = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(unitDocValidator),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    if (!(await getModules(ctx, args.organizationId)).units) return [];
    const units = await ctx.db
      .query("units")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(200);
    return units.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  },
});

export const createUnit = mutation({
  args: {
    organizationId: v.id("organizations"),
    ...editableUnitFields,
    name: v.string(),
  },
  returns: v.id("units"),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await assertModule(ctx, args.organizationId, "units");
    const name = args.name.trim();
    if (!name) throw new Error("Nome da unidade é obrigatório");
    await assertUnitRefsInOrg(ctx, args.organizationId, args);

    const existing = await ctx.db
      .query("units")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(200);
    const now = Date.now();
    const { organizationId, ...fields } = args;
    const unitId = await ctx.db.insert("units", {
      ...fields,
      organizationId,
      name,
      color: args.color ?? DEFAULT_UNIT_COLOR,
      status: args.status ?? "active",
      order: args.order ?? existing.reduce((max, u) => Math.max(max, u.order + 1), 0),
      createdAt: now,
      updatedAt: now,
    });
    await auditUnit(ctx, { organizationId, unitId, action: "create", actorId: member._id, name, now });
    return unitId;
  },
});

export const updateUnit = mutation({
  args: { unitId: v.id("units"), ...editableUnitFields },
  returns: v.null(),
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new Error("Unidade não encontrada");
    const member = await requirePermission(ctx, unit.organizationId, "settings", "manage");
    await assertModule(ctx, unit.organizationId, "units");
    await assertUnitRefsInOrg(ctx, unit.organizationId, args);

    const { unitId, ...patch } = args;
    if (patch.name !== undefined) {
      patch.name = patch.name.trim();
      if (!patch.name) throw new Error("Nome da unidade é obrigatório");
    }
    const now = Date.now();
    await ctx.db.patch(unitId, { ...patch, updatedAt: now });
    await auditUnit(ctx, {
      organizationId: unit.organizationId,
      unitId,
      action: "update",
      actorId: member._id,
      name: patch.name ?? unit.name,
      now,
    });
    return null;
  },
});

/** Recusa se houver lead ou conversa ligada — o histórico do painel depende dela. */
export const deleteUnit = mutation({
  args: { unitId: v.id("units") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new Error("Unidade não encontrada");
    const member = await requirePermission(ctx, unit.organizationId, "settings", "manage");
    await assertModule(ctx, unit.organizationId, "units");

    const [lead, conversation] = await Promise.all([
      ctx.db
        .query("leads")
        .withIndex("by_organization_and_unit", (q) =>
          q.eq("organizationId", unit.organizationId).eq("unitId", args.unitId)
        )
        .first(),
      ctx.db
        .query("conversations")
        .withIndex("by_organization_and_unit", (q) =>
          q.eq("organizationId", unit.organizationId).eq("unitId", args.unitId)
        )
        .first(),
    ]);
    if (lead || conversation) {
      throw new Error(
        "Esta unidade tem leads ou conversas vinculados — marque-a como inativa em vez de excluir"
      );
    }

    // Setores que listavam a unidade deixam de listá-la (vazio = todas).
    const departments = await ctx.db
      .query("departments")
      .withIndex("by_organization", (q) => q.eq("organizationId", unit.organizationId))
      .take(200);
    for (const dept of departments) {
      if (dept.unitIds?.includes(args.unitId)) {
        await ctx.db.patch(dept._id, { unitIds: dept.unitIds.filter((id) => id !== args.unitId) });
      }
    }

    await ctx.db.delete(args.unitId);
    await auditUnit(ctx, {
      organizationId: unit.organizationId,
      unitId: args.unitId,
      action: "delete",
      actorId: member._id,
      name: unit.name,
      now: Date.now(),
    });
    return null;
  },
});
