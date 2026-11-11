/**
 * Linhas da tabela "Compare os planos" (pura). Todo número sai de
 * `convex/lib/plans.ts` / `billingMath.ts`; dinheiro e contagens por `format.ts`.
 */
import { annualMonthlyBrl, overageUnitCents } from "../../../../convex/lib/billingMath";
import {
  EXTRA_CHANNEL_BRL,
  GROUPS_ADDON_BRL,
  PLAN_KEYS,
  PLANS,
  type GatedModule,
  type PlanKey,
} from "../../../../convex/lib/plans";
import { PLAN_SUPPORT } from "./pricingCopy";
import { formatCount, formatMoney } from "@/lib/format";

export type CompareRow = {
  label: string;
  /** Uma célula por plano, na ordem de `PLAN_KEYS`. */
  cells: string[];
};

const brl0 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 0 });
const brl2 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 2 });

const INCLUDED = "Incluído";
const NOT_INCLUDED = "Não incluído";

const perPlan = (fn: (k: PlanKey) => string) => PLAN_KEYS.map(fn);
const moduleCell = (m: GatedModule) => perPlan((k) => (PLANS[k].modules.includes(m) ? INCLUDED : NOT_INCLUDED));

export function compareRows(): CompareRow[] {
  const e = PLANS.empresa;
  return [
    {
      label: "Preço mensal",
      cells: perPlan((k) =>
        k === "empresa"
          ? `a partir de ${brl0(e.monthlyBrl)} + ${brl0(e.perUnitBrl ?? 0)} por unidade`
          : brl0(PLANS[k].monthlyBrl),
      ),
    },
    {
      label: "No anual (por mês)",
      cells: perPlan((k) => (k === "empresa" ? "Contrato anual ou trimestral" : brl0(annualMonthlyBrl(k) ?? 0))),
    },
    { label: "Usuários", cells: perPlan(() => "Ilimitados") },
    {
      label: "Pessoas atendidas pela IA por mês",
      cells: perPlan((k) =>
        k === "empresa"
          ? `${formatCount(e.aiAttendances)} + ${formatCount(e.aiAttendancesPerUnit ?? 0)} por unidade`
          : formatCount(PLANS[k].aiAttendances),
      ),
    },
    {
      label: "Canais incluídos",
      cells: perPlan((k) => {
        const c = PLANS[k].channels;
        return c === "perUnit" ? "1 por unidade" : String(c);
      }),
    },
    {
      label: `Canais extras (${brl0(EXTRA_CHANNEL_BRL)}/mês cada)`,
      cells: perPlan((k) => {
        const max = PLANS[k].maxExtraChannels;
        return max === null ? "sem teto" : `até ${max}`;
      }),
    },
    { label: "Envios de campanha por mês", cells: perPlan((k) => formatCount(PLANS[k].campaignSends)) },
    {
      label: "Excedente (opcional, com teto)",
      cells: perPlan((k) => `${brl2(overageUnitCents(k, false) / 100)} por pessoa`),
    },
    {
      label: "Excedente com chave de IA própria",
      cells: perPlan((k) => {
        const c = PLANS[k].overageByoBrlCents;
        return c === null ? "Não disponível" : brl2(c / 100);
      }),
    },
    {
      label: "Atendente, Copiloto, áudio, imagem, follow-up, pedido de ajuda à equipe, avisos no celular",
      cells: perPlan(() => INCLUDED),
    },
    {
      label: "Grupos de WhatsApp",
      cells: perPlan((k) => {
        if (PLANS[k].modules.includes("groups")) return INCLUDED;
        const max = PLANS[k].groupsAddonMax;
        return max === undefined ? NOT_INCLUDED : `Add-on de ${brl0(GROUPS_ADDON_BRL)}/mês (até ${max} grupos com IA)`;
      }),
    },
    { label: "Departamentos e filas", cells: moduleCell("departments") },
    { label: "Tradução automática", cells: moduleCell("translation") },
    { label: "API, webhooks e MCP", cells: moduleCell("api") },
    { label: "Central com várias unidades e custo por unidade", cells: moduleCell("central") },
    { label: "Exportação dos dados", cells: perPlan(() => "Sempre liberada") },
    { label: "Suporte", cells: perPlan((k) => PLAN_SUPPORT[k]) },
  ];
}
