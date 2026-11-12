import { useState } from "react";
import { Link } from "react-router";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { TabPanel, Tabs } from "@/components/ui/Tabs";
import { formatMoney } from "@/lib/format";
import { FEATURED_PLAN, type PlanDisplay } from "@/lib/pricingCatalog";
import type { BillingCycle } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { signUpHref } from "@/lib/authEntry";
import { ContactRequestButton } from "../ContactRequestForm";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { PLANS, TRIAL } from "../../../../convex/lib/plans";
import { CTA_LABEL, PLAN_AUDIENCE, planCardLines } from "./pricingCopy";

const brl0 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 0 });
const brl2 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 2 });

function PlanCard({ plan, cycle }: { plan: PlanDisplay; cycle: BillingCycle }) {
  const headingId = `plan-${plan.key}`;
  const showStrike = cycle === "annual" && plan.monthlyBrl !== plan.listMonthlyBrl;
  const isTrialPlan = plan.key === TRIAL.plan;

  return (
    <article aria-labelledby={headingId} className="h-full">
      <Card
        className={cn("flex h-full flex-col gap-4", plan.featured && "border-brand-500 bg-brand-500/10")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="text-xl font-bold text-text-primary">
            {plan.label}
          </h3>
          {plan.featured && (
            <span className="inline-flex items-center rounded-full bg-brand-700 px-2.5 py-0.5 text-xs font-semibold text-white">
              Mais escolhido
            </span>
          )}
        </div>
        <p className="text-sm text-text-secondary">{PLAN_AUDIENCE[plan.key]}</p>

        <div className="min-h-[5.5rem]">
          <p className="tabular-nums text-text-primary">
            {plan.fromPrice && <span className="mr-1 text-sm text-text-secondary">a partir de</span>}
            <span className="text-4xl font-bold">{brl0(plan.monthlyBrl)}</span>
            <span className="text-sm text-text-secondary">/mês</span>
          </p>
          {plan.perUnitBrl !== null && (
            <p className="text-sm text-text-secondary tabular-nums">+ {brl0(plan.perUnitBrl)} por unidade</p>
          )}
          {showStrike && (
            <p className="text-sm text-text-muted tabular-nums">
              <s>{brl0(plan.listMonthlyBrl)}</s>
              {plan.annualTotalBrl !== null && <> · cobrado {brl0(plan.annualTotalBrl)} por ano</>}
            </p>
          )}
          {plan.annualByContract && <p className="text-sm text-text-secondary">Contrato anual ou trimestral</p>}
          {plan.perDayBrl !== null && cycle === "monthly" && (
            <p className="text-sm text-text-secondary tabular-nums">cerca de {brl2(plan.perDayBrl)} por dia</p>
          )}
        </div>

        <ul className="flex-1 space-y-2">
          {planCardLines(plan).map((line) => (
            <li key={line} className="flex items-start gap-2 text-sm text-text-primary">
              <Check size={16} className="mt-0.5 shrink-0 text-semantic-success" aria-hidden="true" />
              <span>{line}</span>
            </li>
          ))}
        </ul>

        <div>
          {plan.key === "empresa" ? (
            <ContactRequestButton topic="empresa" variant="secondary" size="lg" className="w-full">
              Falar com a gente
            </ContactRequestButton>
          ) : (
            <Link to={signUpHref(plan.key)} className="block">
              <Button variant={plan.featured ? "primary" : "secondary"} size="lg" className="w-full">
                {CTA_LABEL}
              </Button>
            </Link>
          )}
          {isTrialPlan && plan.featured && (
            <p className="mt-2 text-center text-caption text-text-muted">É o plano do teste grátis.</p>
          )}
        </div>
      </Card>
    </article>
  );
}

interface PlanCardsProps {
  plans: PlanDisplay[];
  cycle: BillingCycle;
}

/**
 * Quatro cartões de alturas iguais em grade (md+); no celular, abas acima e um
 * cartão por vez (os demais ficam `hidden` por CSS, a aba Profissional abre selecionada).
 */
export function PlanCards({ plans, cycle }: PlanCardsProps) {
  const [selected, setSelected] = useState<string>(FEATURED_PLAN);
  // O papel de tabpanel só existe onde as abas aparecem (abaixo de md).
  const mobile = useMediaQuery("(max-width: 767px)");

  return (
    <div>
      <div className="md:hidden">
        <Tabs
          value={selected}
          onValueChange={setSelected}
          ariaLabel="Escolha um plano para ver os detalhes"
          variant="pills"
          idPrefix="plan-tabs"
          className="mb-4"
          items={plans.map((p) => ({ id: p.key, label: PLANS[p.key].label }))}
        />
      </div>
      <div className="grid grid-cols-1 items-stretch gap-6 md:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => {
          const active = p.key === selected;
          const card = <PlanCard plan={p} cycle={cycle} />;
          return (
            <div key={p.key} data-plan={p.key} className={cn("h-full", !active && "hidden md:block")}>
              {active && mobile ? (
                <TabPanel id={p.key} idPrefix="plan-tabs" className="h-full rounded-card">
                  {card}
                </TabPanel>
              ) : (
                card
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
