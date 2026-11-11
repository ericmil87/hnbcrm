import { useState } from "react";
import { Link } from "react-router";
import { Check, Minus } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { formatCount, formatMoney } from "@/lib/format";
import { allPlanDisplays, type PlanDisplay } from "@/lib/pricingCatalog";
import type { BillingCycle } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { signUpHref } from "@/lib/authEntry";
import { ANNUAL_MONTHS_CHARGED, EXTRA_CHANNEL_BRL, GROUPS_ADDON_BRL } from "../../../../convex/lib/plans";
import { PricingCalculator } from "./PricingCalculator";
import {
  CTA_LABEL,
  CTA_NOTE,
  DEFINITIONS,
  NOT_CHARGED,
  PLAN_AUDIENCE,
  PLAN_SUPPORT,
  THIRD_PARTY_POINTS,
  addonLines,
  extraChannelsLimitText,
  faqItems,
} from "./pricingCopy";

interface PricingSectionProps {
  /** "page" = /precos (h1 próprio na página, aqui h2); "section" = landing. */
  variant?: "section" | "page";
}

const brl0 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 0 });
const brl2 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 2 });

const CYCLE_OPTIONS = [
  { value: "monthly", label: "Mensal" },
  { value: "annual", label: `Anual (${12 - ANNUAL_MONTHS_CHARGED} meses grátis)` },
];

function Feature({ children, included = true }: { children: React.ReactNode; included?: boolean }) {
  return (
    <li className={cn("flex items-start gap-2 text-sm", included ? "text-text-primary" : "text-text-muted")}>
      {included ? (
        <Check size={16} className="mt-0.5 shrink-0 text-semantic-success" aria-label="Incluído" />
      ) : (
        <Minus size={16} className="mt-0.5 shrink-0" aria-label="Não incluído" />
      )}
      <span>{children}</span>
    </li>
  );
}

function PlanCard({ plan, cycle }: { plan: PlanDisplay; cycle: BillingCycle }) {
  const headingId = `plan-${plan.key}`;
  const channels =
    plan.channels === "perUnit" ? "1 canal por unidade" : `${plan.channels} ${plan.channels === 1 ? "canal" : "canais"}`;
  const attendances =
    plan.attendancesPerUnit !== null
      ? `${formatCount(plan.attendances)} atendimentos IA + ${formatCount(plan.attendancesPerUnit)} por unidade`
      : `${formatCount(plan.attendances)} atendimentos IA por mês`;
  const showStrike = cycle === "annual" && plan.monthlyBrl !== plan.listMonthlyBrl;

  return (
    <article aria-labelledby={headingId} className="h-full">
      <Card
        className={cn(
          "relative flex h-full flex-col gap-4",
          plan.featured && "border-brand-500 bg-brand-500/10",
        )}
      >
        {plan.featured && (
          <Badge variant="brand" className="absolute -top-3 left-4 bg-brand-700 text-white">
            Mais escolhido
          </Badge>
        )}
        <div>
          <h3 id={headingId} className="text-xl font-bold text-text-primary">
            {plan.label}
          </h3>
          <p className="mt-1 text-sm text-text-secondary">{PLAN_AUDIENCE[plan.key]}</p>
        </div>

        <div>
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
          {plan.annualByContract && (
            <p className="text-sm text-text-secondary">Contrato anual ou trimestral</p>
          )}
          {plan.perDayBrl !== null && cycle === "monthly" && (
            <p className="text-sm text-text-secondary tabular-nums">cerca de {brl2(plan.perDayBrl)} por dia</p>
          )}
        </div>

        <ul className="flex-1 space-y-2">
          <Feature>Usuários ilimitados</Feature>
          <Feature>{channels}</Feature>
          <Feature>{attendances}</Feature>
          <Feature>{formatCount(plan.campaignSends)} envios de campanha por mês</Feature>
          <Feature>
            Excedente opcional, com teto: {brl2(plan.overageBrl)} por atendimento
            {plan.overageByoBrl !== null && <> ({brl2(plan.overageByoBrl)} com chave de IA própria)</>}
          </Feature>
          <Feature included={plan.groupsMode !== "none"}>
            {plan.groupsMode === "addon"
              ? `Grupos de WhatsApp com o add-on (${brl0(GROUPS_ADDON_BRL)}/mês)`
              : "Grupos de WhatsApp"}
          </Feature>
          <Feature included={plan.hasTeamModules}>Setores e filas, tradução, API e MCP</Feature>
          <Feature included={plan.hasCentral}>Central multiunidade e CAC/ROAS por unidade</Feature>
          <Feature>{PLAN_SUPPORT[plan.key]}</Feature>
        </ul>

        {plan.key === "empresa" ? (
          <Link to={signUpHref("empresa")} className="block">
            <Button variant="secondary" size="lg" className="w-full">
              Falar com a gente
            </Button>
          </Link>
        ) : (
          <Link to={signUpHref(plan.key)} className="block">
            <Button variant={plan.featured ? "primary" : "secondary"} size="lg" className="w-full">
              {CTA_LABEL}
            </Button>
          </Link>
        )}
      </Card>
    </article>
  );
}

function BulletBlock({ id, title, items }: { id: string; title: string; items: readonly string[] }) {
  return (
    <Card className="h-full">
      <h3 id={id} className="mb-3 text-lg font-semibold text-text-primary">
        {title}
      </h3>
      <ul aria-labelledby={id} className="space-y-2">
        {items.map((t) => (
          <Feature key={t}>{t}</Feature>
        ))}
      </ul>
    </Card>
  );
}

export function PricingSection({ variant = "section" }: PricingSectionProps) {
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const plans = allPlanDisplays(cycle);
  const addons = addonLines();
  const faq = faqItems();

  return (
    <section id="precos" className="py-16 md:py-24" aria-labelledby="pricing-heading">
      <div className="mx-auto max-w-6xl space-y-12 px-4">
        <div className="text-center">
          <h2 id="pricing-heading" className="mb-4 text-3xl font-bold md:text-4xl lg:text-5xl">
            Traga a equipe inteira. Pague só pelo que a IA atende.
          </h2>
          <p className="mx-auto max-w-2xl text-lg text-text-secondary">
            Usuários ilimitados em todo plano. Você vê o uso em tempo real, recebe aviso em 80% e 100%, e nada é
            cobrado além do plano sem você ligar o excedente e escolher o teto.
          </p>
          <div className="mt-6 flex justify-center">
            <SegmentedControl
              ariaLabel="Ciclo de cobrança"
              value={cycle}
              onValueChange={(v) => setCycle(v === "annual" ? "annual" : "monthly")}
              options={CYCLE_OPTIONS}
            />
          </div>
          <p className="mt-3 text-sm text-text-muted">
            {CTA_NOTE} O teste é do plano Profissional. No anual você paga {ANNUAL_MONTHS_CHARGED} meses e usa 12.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 pt-3 md:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => (
            <PlanCard key={p.key} plan={p} cycle={cycle} />
          ))}
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <BulletBlock id="not-charged-heading" title="O que não cobramos" items={NOT_CHARGED} />
          <BulletBlock id="third-party-heading" title="Terceiros sem margem" items={THIRD_PARTY_POINTS} />
        </div>

        <div>
          <h3 className="mb-4 text-xl font-semibold text-text-primary">Avulsos</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {addons.map((a) => (
              <Card key={a.title} variant="sunken">
                <p className="text-sm font-semibold text-text-primary">{a.title}</p>
                <p className="mt-1 text-lg font-bold tabular-nums text-text-primary">{a.price}</p>
                <p className="mt-1 text-sm text-text-secondary">{a.detail}</p>
              </Card>
            ))}
          </div>
          <p className="mt-3 text-caption text-text-muted tabular-nums">
            Canal extra: {brl0(EXTRA_CHANNEL_BRL)} por mês cada. {extraChannelsLimitText()}
          </p>
        </div>

        <div>
          <h3 className="mb-4 text-xl font-semibold text-text-primary">Definições</h3>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {DEFINITIONS.map((d) => (
              <div key={d.term}>
                <dt className="text-sm font-semibold text-text-primary">{d.term}</dt>
                <dd className="text-sm text-text-secondary">{d.text}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div>
          <h3 className="mb-4 text-xl font-semibold text-text-primary">Calcule o seu plano</h3>
          <PricingCalculator cycle={cycle} />
        </div>

        <div>
          <h3 className="mb-2 text-xl font-semibold text-text-primary">Perguntas sobre preço</h3>
          <div>
            {faq.map((f, i) => (
              <CollapsibleSection key={f.question} title={f.question} defaultOpen={variant === "page" && i === 0}>
                <p className="pb-3 text-sm text-text-secondary">{f.answer}</p>
              </CollapsibleSection>
            ))}
          </div>
        </div>

        <div className="text-center">
          <Link to={signUpHref()}>
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
