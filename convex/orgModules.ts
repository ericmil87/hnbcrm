/**
 * Módulos opcionais por org (MVP "Central"). Leitura para o hook do front
 * (`useOrgModules`) e liga/desliga em Configurações → Central.
 *
 * `demoMode` é só LIDO aqui: quem liga é o simulador interno (`demoSim`), nunca
 * a UI — uma org real com demoMode ligado deixaria de enviar WhatsApp.
 */
import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { requireAuth, requirePermission } from "./lib/auth";
import { getModules, isDemoOrg, modulesOf } from "./lib/orgModules";

const modulesReturn = v.object({
  units: v.boolean(),
  departments: v.boolean(),
  attribution: v.boolean(),
  central: v.boolean(),
  demoMode: v.boolean(),
});

export const getOrgModules = query({
  args: { organizationId: v.id("organizations") },
  returns: modulesReturn,
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    return await getModules(ctx, args.organizationId);
  },
});

export const setOrgModules = mutation({
  args: {
    organizationId: v.id("organizations"),
    // Parcial: só as chaves informadas mudam.
    modules: v.object({
      units: v.optional(v.boolean()),
      departments: v.optional(v.boolean()),
      attribution: v.optional(v.boolean()),
      central: v.optional(v.boolean()),
    }),
  },
  returns: modulesReturn,
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");

    const before = modulesOf(org);
    const current = org.settings.modules ?? {};
    const next = { ...current };
    for (const key of ["units", "departments", "attribution", "central"] as const) {
      const value = args.modules[key];
      if (value !== undefined) next[key] = value;
    }
    const now = Date.now();
    await ctx.db.patch(args.organizationId, {
      settings: { ...org.settings, modules: next },
      updatedAt: now,
    });

    const after = modulesOf({ settings: { ...org.settings, modules: next } });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: {
          units: before.units,
          departments: before.departments,
          attribution: before.attribution,
          central: before.central,
        },
        after: {
          units: after.units,
          departments: after.departments,
          attribution: after.attribution,
          central: after.central,
        },
      },
      metadata: { modules: true },
      description: "Alterou os módulos da Central (unidades, setores, atribuição, painel)",
      severity: "medium",
      createdAt: now,
    });
    return after;
  },
});

/** Para actions (dispatch, probes de canal): a org é de demonstração? */
export const internalIsDemoOrg = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    return await isDemoOrg(ctx, args.organizationId);
  },
});
