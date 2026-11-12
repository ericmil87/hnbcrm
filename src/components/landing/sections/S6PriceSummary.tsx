import { Link } from "react-router";
import { ArrowRight, Users } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import { formatCount, formatMoney } from "@/lib/format";
import { allPlanDisplays, type PlanDisplay } from "@/lib/pricingCatalog";
import { cn } from "@/lib/utils";
import { PricingCalculator } from "../pricing/PricingCalculator";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

const brl0 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 0 });

const AUDIENCE: Record<PlanDisplay["key"], string> = {
  essencial: "Para quem atende sozinho ou com equipe pequena.",
  profissional: "Para clínicas e equipes que atendem todo dia.",
  escala: "Para quem tem volume e vários números.",
  empresa: "Para redes com várias unidades.",
};

const LAST_LINE: Record<PlanDisplay["key"], string> = {
  essencial: "Usuários ilimitados",
  profissional: "Grupos, departamentos, tradução e API",
  escala: "Suporte prioritário",
  empresa: "Gerente de conta",
};

/** Três linhas de cada cartão; números vêm do catálogo. */
export function compactPlanLines(plan: PlanDisplay): string[] {
  if (plan.key === "empresa") return ["Central e painel por unidade", "Contrato e nota fiscal", LAST_LINE.empresa];
  const numbers = typeof plan.channels === "number" ? plan.channels : 1;
  return [
    `${formatCount(plan.attendances)} pessoas atendidas pela IA por mês`,
    `${numbers} ${numbers === 1 ? "número" : "números"} de WhatsApp`,
    LAST_LINE[plan.key],
  ];
}

function PlanSummaryCard({ plan }: { plan: PlanDisplay }) {
  return (
    <li
      data-plan={plan.key}
      className={cn(
        "flex flex-col gap-2 rounded-card border bg-surface-base p-4",
        plan.featured ? "border-brand-500" : "border-border"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-lg font-bold text-text-primary">{plan.label}</h3>
        {plan.featured && <Badge variant="brand">Mais escolhido</Badge>}
      </div>
      <p className="tabular-nums text-text-primary">
        {plan.fromPrice && <span className="text-sm text-text-secondary">a partir de </span>}
        <span className="text-2xl font-bold">{brl0(plan.monthlyBrl)}</span>
        <span className="text-sm text-text-secondary">/mês</span>
        {plan.perUnitBrl !== null && (
          <span className="block text-sm text-text-secondary">+ {brl0(plan.perUnitBrl)} por unidade</span>
        )}
      </p>
      <p className="text-sm text-text-secondary">{AUDIENCE[plan.key]}</p>
      <ul className="mt-1 space-y-1 text-sm text-text-primary">
        {compactPlanLines(plan).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </li>
  );
}

/**
 * S6: preço em 20 segundos. Quatro cartões compactos do catálogo, a calculadora
 * reduzida (perguntas 1 e 2) e o link para a tabela completa em `/precos`.
 * O bloco de preço de fundador fica desligado (decisão da Onda 1).
 */
export function S6PriceSummary() {
  const plans = allPlanDisplays("monthly");
  return (
    <LandingSection
      id={LANDING_ANCHORS.price}
      eyebrow="Preço"
      title="Preço em 20 segundos"
      subtitle="A equipe inteira, sem cobrar por pessoa. Você paga pelas pessoas que a IA atende."
      tone="raised"
    >
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => (
          <PlanSummaryCard key={p.key} plan={p} />
        ))}
      </ul>

      <div className="mt-8 rounded-card border border-border bg-surface-raised p-4 md:p-6 lg:p-8">
        <h3 className="font-display text-xl font-bold text-text-primary md:text-2xl">
          Descubra o seu plano em 20 segundos
        </h3>
        <div className="mt-5">
          <PricingCalculator cycle="monthly" variant="compact" />
        </div>
        <div className="mt-6 space-y-2 border-t border-border pt-4 text-sm text-text-secondary">
          <p>
            Atendente, Copiloto, áudio, imagem, follow-up e pedido de ajuda vêm em todos os planos. Passou da franquia? A
            IA só sugere, e a sua equipe envia. O excedente é opcional, com o teto que você escolher.
          </p>
          <p className="flex items-center gap-2 font-medium text-text-primary">
            <Users className="size-4 shrink-0 text-brand-500" aria-hidden="true" />
            O mesmo cliente falando 20 vezes no mês conta 1.
          </p>
        </div>
      </div>

      <div className="mt-6 flex justify-center lg:justify-start">
        <Link to="/precos" className={buttonClassName("secondary", "lg")}>
          Ver tabela completa
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </LandingSection>
  );
}
