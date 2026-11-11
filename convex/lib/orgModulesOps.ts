/**
 * Core do liga/desliga de módulos opcionais (antes no handler de
 * `orgModules.setOrgModules`, extraído sem mudar comportamento). Usado também
 * pela aplicação do Rascunho de Operação do onboarding (tradução). Quem chama
 * já autorizou o `member` (settings:manage); ligar a tradução exige conta com
 * e-mail AQUI (porta crítica, como os toggles de IA).
 */
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireAccountWithEmail } from "./auth";
import { modulesOf, type OrgModules } from "./orgModules";
import type { ConfigVia } from "./attendantConfigOps";

export type OrgModulesPatch = {
  units?: boolean;
  departments?: boolean;
  attribution?: boolean;
  central?: boolean;
  metaMessaging?: boolean;
  telegram?: boolean;
  translation?: boolean;
};

export async function setOrgModulesCore(
  ctx: MutationCtx,
  params: {
    org: Doc<"organizations">;
    member: Doc<"teamMembers">;
    modules: OrgModulesPatch;
    via?: ConfigVia;
  },
): Promise<OrgModules> {
  const { org, member, modules, via } = params;
  if (member.organizationId !== org._id) throw new Error("Organização não encontrada");
  const before = modulesOf(org);
  // Tradução automática: o texto do cliente passa a ir a um provedor de
  // tradução — porta crítica, como os toggles de IA (conta com e-mail).
  if (modules.translation === true && !before.translation) {
    await requireAccountWithEmail(ctx, member.userId);
  }
  const current = org.settings.modules ?? {};
  const next = { ...current };
  for (const key of ["units", "departments", "attribution", "central", "metaMessaging", "telegram", "translation"] as const) {
    const value = modules[key];
    if (value !== undefined) next[key] = value;
  }
  const now = Date.now();
  await ctx.db.patch(org._id, {
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
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
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
    organizationId: org._id,
    entityType: "organization",
    entityId: org._id,
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
        telegram: before.telegram,
        translation: before.translation,
      },
      after: {
        units: after.units,
        departments: after.departments,
        attribution: after.attribution,
        central: after.central,
        metaMessaging: after.metaMessaging,
        telegram: after.telegram,
        translation: after.translation,
      },
    },
    metadata: { modules: true, ...(via ? { via } : {}) },
    description: "Alterou os módulos da organização (Central, Instagram e Messenger, Telegram, Tradução automática)",
    severity: "medium",
    createdAt: now,
  });
  if (metaToggle && metaToggle.configIds.length > 0) {
    await ctx.db.insert("auditLogs", {
      organizationId: org._id,
      entityType: "organization",
      entityId: org._id,
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
}
