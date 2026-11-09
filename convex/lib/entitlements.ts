/**
 * Porta única de entitlements: o plano gravado em `organizations.billing`
 * vira decisões. `resolveEntitlements` é PURA (o relógio vem do chamador).
 * Org sem `billing` ou `legacy` = `gated:false`: todo check devolve "ok" e o
 * comportamento é idêntico ao de antes do modelo de planos.
 *
 * B1: nada chama isto ainda (os gates entram no B5). Convites e exportação
 * NUNCA importam este módulo (entitlementsPort.test.ts).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  GATED_MODULES,
  PLANS,
  TRIAL,
  USAGE_WARN_PCT,
  lowestPlanWithModule,
  type BillingStatus,
  type GatedModule,
  type PlanKey,
} from "./plans";
import { overageUnitCents } from "./billingMath";

export type Entitlements = {
  /** false = legacy / sem billing: todo check devolve ok. */
  gated: boolean;
  plan: PlanKey | null;
  status: BillingStatus | "none";
  limits: { channels: number; aiAttendances: number; campaignSends: number; groupsWithAi: number };
  modules: Record<GatedModule, boolean>;
  overage: { enabled: boolean; capBrlCents: number; unitBrlCents: number };
  /** false em read_only / canceled / teste vencido. */
  aiAllowed: boolean;
  /** Idem; inbound NUNCA para. */
  outboundAllowed: boolean;
  /** Literal: exportação é sempre liberada. */
  exportAllowed: true;
};

type OrgForEntitlements = Pick<Doc<"organizations">, "settings"> & { billing?: Doc<"organizations">["billing"] };

const allModules = (value: boolean): Record<GatedModule, boolean> =>
  Object.fromEntries(GATED_MODULES.map((m) => [m, value])) as Record<GatedModule, boolean>;

export function resolveEntitlements(org: OrgForEntitlements | null | undefined, now: number): Entitlements {
  const billing = org?.billing;
  // Fail-open deliberado: status diferente de legacy SEM plano nunca deveria existir (a porta
  // recusa), mas se existir (dado antigo, escrita fora da porta) a org fica sem gate em vez
  // de perder acesso por um documento malformado.
  if (!billing || billing.status === "legacy" || !billing.plan) {
    return {
      gated: false,
      plan: billing?.plan ?? null,
      status: billing ? billing.status : "none",
      limits: { channels: Infinity, aiAttendances: Infinity, campaignSends: Infinity, groupsWithAi: Infinity },
      modules: allModules(true),
      overage: { enabled: false, capBrlCents: 0, unitBrlCents: 0 },
      aiAllowed: true,
      outboundAllowed: true,
      exportAllowed: true,
    };
  }

  const status = billing.status;
  const trial = status === "trial";
  const trialValid = trial && billing.trialEndsAt !== undefined && billing.trialEndsAt > now;
  const blocked = status === "read_only" || status === "canceled" || (trial && !trialValid);
  // Teste mede pelo Profissional; `past_due` é igual a `active` (avisar, não travar).
  const planKey: PlanKey = trial ? TRIAL.plan : billing.plan;
  const def = PLANS[planKey];
  const units = Math.max(1, Math.floor(billing.units ?? 1));
  const extraChannels = Math.max(0, Math.floor(billing.extraChannels ?? 0));
  const ov = billing.overrides;

  const baseChannels = def.channels === "perUnit" ? units : def.channels;
  const baseAttendances = trial
    ? TRIAL.aiAttendances
    : def.aiAttendancesPerUnit !== undefined
      ? def.aiAttendances + def.aiAttendancesPerUnit * units
      : def.aiAttendances;

  const modules = allModules(false);
  for (const m of def.modules) modules[m] = true;
  const groupsAddon = planKey === "essencial" && billing.addons?.groups === true;
  if (groupsAddon) modules.groups = true;
  // read_only / canceled / teste vencido: nenhum módulo novo pode ser ligado.
  const finalModules = blocked ? allModules(false) : modules;

  const groupsWithAi = groupsAddon ? (def.groupsAddonMax ?? 0) : modules.groups ? Infinity : 0;
  const byo = org?.settings?.aiConfig?.providerConfig?.mode === "byo";
  const overage = billing.overage;

  return {
    gated: true,
    plan: planKey,
    status,
    limits: {
      channels: ov?.channels ?? baseChannels + extraChannels,
      aiAttendances: ov?.aiAttendances ?? baseAttendances,
      campaignSends: ov?.campaignSends ?? def.campaignSends,
      groupsWithAi: ov?.groupsWithAi ?? groupsWithAi,
    },
    modules: finalModules,
    overage: {
      enabled: overage?.enabled === true,
      capBrlCents: overage?.enabled === true ? Math.round(overage.capBrl * 100) : 0,
      unitBrlCents: overageUnitCents(planKey, byo),
    },
    aiAllowed: !blocked,
    outboundAllowed: !blocked,
    exportAllowed: true,
  };
}

export async function loadEntitlements(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  now: number
): Promise<Entitlements & { org: Doc<"organizations"> | null }> {
  const org = await ctx.db.get(organizationId);
  return { ...resolveEntitlements(org, now), org };
}

// ── Checks puros (nunca lançam; quem chama decide avisar × recusar) ─────────

const MODULE_NAMES: Record<GatedModule, string> = {
  groups: "Grupos",
  departments: "Setores e filas",
  translation: "Tradução automática",
  api: "API e webhooks",
  central: "Painel da Central",
  units: "Unidades",
  attribution: "Atribuição de mídia",
};

export function checkModule(
  e: Entitlements,
  m: GatedModule
): { ok: true } | { ok: false; reason: "plan"; upgradeTo: PlanKey; message: string } {
  if (!e.gated || e.modules[m]) return { ok: true };
  const upgradeTo = lowestPlanWithModule(m);
  const message =
    m === "groups" && e.plan === "essencial"
      ? "Grupos no Essencial é um add-on (R$ 99/mês, até 3 grupos com IA). Fale com a gente para ativar."
      : `${MODULE_NAMES[m]} faz parte do plano ${PLANS[upgradeTo].label}.`;
  return { ok: false, reason: "plan", upgradeTo, message };
}

export function checkChannelSlot(
  e: Entitlements,
  activeChannels: number
): { ok: true } | { ok: false; needsExtraAck: true; message: string } {
  if (!e.gated || activeChannels < e.limits.channels) return { ok: true };
  return {
    ok: false,
    needsExtraAck: true,
    message: `Seu plano inclui ${e.limits.channels} ${e.limits.channels === 1 ? "canal" : "canais"}. Adicionar um canal extra por R$ 79/mês?`,
  };
}

/**
 * Mesma regra de `spendCrossings`: cruzar 100% de uma vez dispara SÓ o de
 * "atingido"; o carimbo (`warnedAt`/`reachedAt`) é do chamador.
 */
export function usageCrossings(args: {
  used: number;
  limit: number;
  warnedAt?: number;
  reachedAt?: number;
}): { warn: boolean; reached: boolean } {
  if (!Number.isFinite(args.limit) || args.limit <= 0) return { warn: false, reached: false };
  const pct = (args.used / args.limit) * 100;
  if (pct >= 100) return { warn: false, reached: args.reachedAt === undefined };
  if (pct >= USAGE_WARN_PCT) return { warn: args.warnedAt === undefined, reached: false };
  return { warn: false, reached: false };
}
