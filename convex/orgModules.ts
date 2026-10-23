/**
 * Módulos opcionais por org (Central + Instagram/Messenger). Leitura para o hook do front
 * (`useOrgModules`) e liga/desliga em Configurações.
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
  metaMessaging: v.boolean(),
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
      metaMessaging: v.optional(v.boolean()),
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
    for (const key of ["units", "departments", "attribution", "central", "metaMessaging"] as const) {
      const value = args.modules[key];
      if (value !== undefined) next[key] = value;
    }
    const now = Date.now();
    await ctx.db.patch(args.organizationId, {
      settings: { ...org.settings, modules: next },
      updatedAt: now,
    });

    const after = modulesOf({ settings: { ...org.settings, modules: next } });

    // Meta Messaging (D12): desligar desativa os configs Instagram/Messenger ativos na MESMA
    // mutação; religar reativa só os marcados com disabledByModuleAt cuja conexão está "ok".
    let metaToggle: { action: "disabled" | "reenabled"; configIds: string[] } | null = null;
    if (before.metaMessaging !== after.metaMessaging) {
      const configs = await ctx.db
        .query("channelConfigs")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .take(200);
      const touched: string[] = [];
      for (const c of configs) {
        if (c.channel !== "instagram" && c.channel !== "messenger") continue;
        if (!after.metaMessaging) {
          if (c.status !== "active") continue;
          await ctx.db.patch(c._id, { status: "disabled", disabledByModuleAt: now, updatedAt: now });
          touched.push(c._id);
        } else {
          if (c.disabledByModuleAt === undefined) continue;
          const conn = c.metaConnectionId ? await ctx.db.get(c.metaConnectionId) : null;
          if (conn && conn.authState === "ok") {
            await ctx.db.patch(c._id, { status: "active", disabledByModuleAt: undefined, updatedAt: now });
            touched.push(c._id);
          }
        }
      }
      metaToggle = { action: after.metaMessaging ? "reenabled" : "disabled", configIds: touched };
    }
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
          metaMessaging: before.metaMessaging,
        },
        after: {
          units: after.units,
          departments: after.departments,
          attribution: after.attribution,
          central: after.central,
          metaMessaging: after.metaMessaging,
        },
      },
      metadata: { modules: true },
      description: "Alterou os módulos da organização (Central, Instagram e Messenger)",
      severity: "medium",
      createdAt: now,
    });
    if (metaToggle && metaToggle.configIds.length > 0) {
      await ctx.db.insert("auditLogs", {
        organizationId: args.organizationId,
        entityType: "organization",
        entityId: args.organizationId,
        action: "update",
        actorId: member._id,
        actorType: "human",
        metadata: { metaMessaging: metaToggle.action, configIds: metaToggle.configIds },
        description:
          metaToggle.action === "disabled"
            ? "Desligou Instagram e Messenger: canais desativados junto com o módulo"
            : "Religou Instagram e Messenger: canais reativados",
        severity: "high",
        createdAt: now,
      });
    }
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
