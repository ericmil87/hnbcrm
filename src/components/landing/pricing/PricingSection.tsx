import { useState } from "react";
import { Link } from "react-router";
import { Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { allPlanDisplays } from "@/lib/pricingCatalog";
import type { BillingCycle } from "@/lib/pricing";
import { startHref } from "@/lib/onboardingEntry";
import { ANNUAL_MONTHS_CHARGED, PLANS, TRIAL, USAGE_WARN_PCT } from "../../../../convex/lib/plans";
import { CompareTable } from "./CompareTable";
import { PlanCards } from "./PlanCards";
import { PricingCalculator } from "./PricingCalculator";
import { AddonsBlock, DefinitionsBlock, PricingFaq } from "./PricingInfoBlocks";
import { ServicesBlock } from "./ServicesBlock";
import { ALL_PLANS_BAND, CTA_LABEL, CTA_NOTE } from "./pricingCopy";

interface PricingSectionProps {
  /** "page" = /precos (h1 da página); "section" = landing (h2). */
  variant?: "section" | "page";
}

const CYCLE_OPTIONS = [
  { value: "monthly", label: "Mensal" },
  { value: "annual", label: `Anual · ${12 - ANNUAL_MONTHS_CHARGED} meses grátis` },
];

export function PricingSection({ variant = "section" }: PricingSectionProps) {
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const plans = allPlanDisplays(cycle);
  const Title = variant === "page" ? "h1" : "h2";
  const trialPlan = PLANS[TRIAL.plan].label;

  return (
    <section id="precos" className="py-12 md:py-20" aria-labelledby="pricing-heading">
      <div className="mx-auto max-w-6xl space-y-14 px-4">
        <div className="text-center">
          <Title id="pricing-heading" className="font-display mb-4 text-3xl font-bold md:text-4xl lg:text-5xl">
            Traga a equipe inteira. Pague só pelo que a IA atende.
          </Title>
          <p className="mx-auto max-w-2xl text-lg text-text-secondary">
            Usuários ilimitados em todo plano. Você acompanha o uso em tempo real e recebe aviso em {USAGE_WARN_PCT}% e
            100%. Nada é cobrado além do plano sem você ligar o excedente e escolher o teto.
          </p>

          <div className="mx-auto mt-6 flex max-w-2xl items-start gap-3 rounded-card border border-border bg-surface-raised p-4 text-left">
            <Users size={20} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
            <p className="text-sm text-text-secondary">
              <strong className="font-semibold text-text-primary">Uma pessoa atendida pela IA</strong> é cada pessoa com
              quem a IA conversou no mês.{" "}
              <strong className="font-semibold text-text-primary">O mesmo cliente falando 20 vezes conta 1.</strong>{" "}
              {variant === "page" && (
                <a
                  href="#definicoes"
                  className="inline-flex min-h-11 items-center text-text-primary underline underline-offset-2 md:min-h-0"
                >
                  O que conta e o que não conta
                </a>
              )}
            </p>
          </div>

          <div className="mt-6 flex justify-center">
            <SegmentedControl
              ariaLabel="Ciclo de cobrança"
              value={cycle}
              onValueChange={(v) => setCycle(v === "annual" ? "annual" : "monthly")}
              options={CYCLE_OPTIONS}
            />
          </div>
          <p className="mt-3 text-sm text-text-muted">
            {cycle === "monthly"
              ? `Sem cartão para testar. O teste é do plano ${trialPlan}.`
              : `No anual você paga ${ANNUAL_MONTHS_CHARGED} meses e usa 12. Sem cartão para testar.`}
          </p>
        </div>

        <div className="space-y-4">
          <PlanCards plans={plans} cycle={cycle} />
          <p className="flex items-start justify-center gap-2 text-center text-sm text-text-secondary">
            <Sparkles size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
            <span>{ALL_PLANS_BAND}</span>
          </p>
        </div>

        <div id="calculadora" className="scroll-mt-20">
          <h2 className="mb-4 text-2xl font-bold text-text-primary">Calcule o seu plano</h2>
          <PricingCalculator cycle={cycle} />
        </div>

        <CompareTable />
        <AddonsBlock />
        {variant === "page" && (
          <>
            <DefinitionsBlock />
            <ServicesBlock />
            <PricingFaq firstOpen />
          </>
        )}

        <div className="text-center">
          <Link to={startHref()}>
            <Button variant="primary" size="lg">
              {CTA_LABEL}
            </Button>
          </Link>
          <p className="mt-3 text-sm text-text-muted">{CTA_NOTE}</p>
          {variant === "section" && (
            <p className="mt-2 text-sm">
              <Link to="/precos" className="text-text-secondary hover:text-text-primary underline underline-offset-2">
                Ver a página de preços
              </Link>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
