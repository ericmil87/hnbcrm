/**
 * Módulos opcionais por org (MVP "Central": unidades, setores, atribuição,
 * painel) + `demoMode`.
 *
 * Regra de ouro: TUDO desligado por padrão. Uma org sem `settings.modules`
 * (todas as que existiam antes) lê tudo `false`, e nenhuma função nova age
 * nela — `assertModule` lança antes de qualquer escrita.
 */
import { ConvexError } from "convex/values";
import { QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

export type OrgModuleKey = "units" | "departments" | "attribution" | "central";

export type OrgModules = {
  units: boolean;
  departments: boolean;
  attribution: boolean;
  central: boolean;
  demoMode: boolean;
};

export const MODULE_LABELS: Record<OrgModuleKey, string> = {
  units: "Unidades",
  departments: "Setores",
  attribution: "Atribuição de mídia",
  central: "Painel da Central",
};

/** Leitura pura do doc (serve a quem já carregou a org). */
export function modulesOf(org: Pick<Doc<"organizations">, "settings"> | null | undefined): OrgModules {
  const m = org?.settings?.modules;
  return {
    units: m?.units === true,
    departments: m?.departments === true,
    attribution: m?.attribution === true,
    central: m?.central === true,
    demoMode: org?.settings?.demoMode === true,
  };
}

export async function getModules(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">
): Promise<OrgModules> {
  return modulesOf(await ctx.db.get(organizationId));
}

/** Lança "Módulo não habilitado" (legível no cliente) se o módulo está off. */
export async function assertModule(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  key: OrgModuleKey
): Promise<OrgModules> {
  const modules = await getModules(ctx, organizationId);
  if (!modules[key]) {
    throw new ConvexError(`Módulo não habilitado: ${MODULE_LABELS[key]}`);
  }
  return modules;
}

/** Org de demonstração — nunca envia nada para fora (WhatsApp, probes). */
export async function isDemoOrg(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">
): Promise<boolean> {
  return (await getModules(ctx, organizationId)).demoMode;
}

/**
 * Chave normalizada de campanha: minúsculo, sem acento, espaços → "-".
 * Mesma regra em `adSpend.campaignKey` e `leads.attribution.campaignKey`, é o
 * que liga o gasto à venda no painel.
 */
export function normalizeCampaignKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Pelo menos um módulo da Central ligado — gate das operações que servem a
 * todos (tipo de contato, desfecho Convertido/Não convertido).
 */
export async function assertAnyModule(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">
): Promise<OrgModules> {
  const modules = await getModules(ctx, organizationId);
  if (!modules.units && !modules.departments && !modules.attribution && !modules.central) {
    throw new ConvexError("Módulo não habilitado: Central");
  }
  return modules;
}
