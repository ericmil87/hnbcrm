/**
 * Módulos opcionais por org (Central + Instagram/Messenger + Telegram da equipe). Leitura para o hook do front
 * (`useOrgModules`) e liga/desliga em Configurações.
 *
 * `demoMode` é só LIDO aqui: quem liga é o simulador interno (`demoSim`), nunca
 * a UI — uma org real com demoMode ligado deixaria de enviar WhatsApp.
 */
import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { requireAuth, requirePermission } from "./lib/auth";
import { getModules, isDemoOrg } from "./lib/orgModules";
import { setOrgModulesCore } from "./lib/orgModulesOps";

const modulesReturn = v.object({
  units: v.boolean(),
  departments: v.boolean(),
  attribution: v.boolean(),
  central: v.boolean(),
  metaMessaging: v.boolean(),
  telegram: v.boolean(),
  translation: v.boolean(),
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
      telegram: v.optional(v.boolean()),
      translation: v.optional(v.boolean()),
    }),
  },
  returns: modulesReturn,
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    return await setOrgModulesCore(ctx, { org, member, modules: args.modules });
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
