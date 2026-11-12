import { Check } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import { contactHref } from "@/lib/contactHref";
import { formatMoney } from "@/lib/format";
import { followUpDisplay, serviceDisplays, type ServiceDisplay } from "@/lib/pricingCatalog";
import { cn } from "@/lib/utils";
import { SERVICES, type ServiceKey } from "../../../../convex/lib/plans";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

const brl0 = (v: number) => formatMoney(v, "BRL", { fractionDigits: 0 });

/** Escopo de cada pacote (copy aprovada; valores vêm do catálogo). */
const PACKAGE_COPY: Record<ServiceKey, { audience: string; includes: string[] }> = {
  express: {
    audience: "Para quem atende sozinho ou com equipe pequena.",
    includes: [
      "Funil, Atendente e respostas frequentes montados com você",
      "Um treinamento com a sua equipe",
      "Uma semana de ajustes depois de ligar",
    ],
  },
  completa: {
    audience: "Para clínicas e equipes.",
    includes: [
      "Tudo do Express, com mais de um fluxo de atendimento",
      "Formulário do site, campanhas e uma integração simples",
      "Duas semanas com a IA em modo sugestão, revisando com você",
    ],
  },
  empresa: {
    audience: "Para redes com várias unidades.",
    includes: [
      "Diagnóstico e duas semanas de medição antes de mudar",
      "Fluxos por unidade, departamentos e regras de acesso",
      "Treinamento por equipe",
    ],
  },
};

const CUSTOM_COPY = {
  audience: "Quando o seu caso não cabe num pacote.",
  includes: [
    "Diagnóstico do atendimento que você tem hoje",
    "Desenho do Funil e das regras de pedido de ajuda",
    "Jeito de falar e o que a IA precisa saber",
    "Integrações: site, formulários e API",
    "Treinamento da equipe",
    "Acompanhamento nos primeiros 30 dias",
  ],
};

function Includes({ items }: { items: readonly string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((t) => (
        <li key={t} className="flex items-start gap-2 text-sm text-text-primary">
          <Check className="mt-0.5 size-4 shrink-0 text-semantic-success" aria-hidden="true" />
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

function PackageCard({ pkg }: { pkg: ServiceDisplay }) {
  const copy = PACKAGE_COPY[pkg.key];
  return (
    <li data-service={pkg.key} className="flex flex-col gap-3 rounded-card border border-border bg-surface-raised p-4">
      <h3 className="font-display text-lg font-bold text-text-primary">Implantação {pkg.label}</h3>
      <p className="tabular-nums text-text-primary">
        <span className="text-2xl font-bold">{brl0(pkg.brl)}</span>
        {pkg.perUnitBrl !== null && (
          <span className="block text-sm text-text-secondary">+ {brl0(pkg.perUnitBrl)} por unidade adicional</span>
        )}
      </p>
      <p className="text-sm text-text-secondary">{copy.audience}</p>
      <div className="flex-1">
        <Includes items={copy.includes} />
      </div>
    </li>
  );
}

/**
 * S7: "Feito com você". Pacotes de implantação, acompanhamento e consultoria
 * sob medida, sempre como opcional. Valores de `SERVICES` (catálogo). Os botões
 * abrem e-mail por `contactHref`; o formulário que cria lead entra na Onda 5.
 */
export function S7Services() {
  const packages = serviceDisplays();
  const followUp = followUpDisplay();
  const href = contactHref("implantacao");
  return (
    <LandingSection
      id={LANDING_ANCHORS.services}
      eyebrow="Opcional"
      title="Quer que a gente monte junto?"
      subtitle={`Você pode fazer tudo sozinho, conversando com o Copiloto. Se preferir alguém do lado, a implantação é à parte e pode ser parcelada em até ${SERVICES.installments} vezes.`}
    >
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {packages.map((p) => (
          <PackageCard key={p.key} pkg={p} />
        ))}
      </ul>

      <div
        data-service="consultoria"
        className={cn("mt-4 flex flex-col gap-3 rounded-card border-2 border-brand-500 bg-surface-raised p-5 shadow-card md:p-6")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-xl font-bold text-text-primary">{SERVICES.consultoria.label}</h3>
          <Badge variant="brand">Sob orçamento</Badge>
        </div>
        <p className="text-sm text-text-secondary">{CUSTOM_COPY.audience}</p>
        <div className="md:max-w-2xl">
          <Includes items={CUSTOM_COPY.includes} />
        </div>
        <a href={href} className={buttonClassName("primary", "lg", "w-full sm:w-auto sm:self-start")}>
          Pedir orçamento
        </a>
      </div>

      <p className="mt-6 text-text-primary">
        <strong>Acompanhamento mensal:</strong>{" "}
        <span className="tabular-nums">
          {brl0(followUp.monthlyBrl)}/mês, com {followUp.hours} horas de ajustes e orientação depois da implantação.
        </span>{" "}
        Opcional.
      </p>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <a href={href} className={buttonClassName("secondary", "lg")}>
          Falar com a gente
        </a>
      </div>

      <p className="mt-6 max-w-2xl text-sm text-text-muted">
        Fazemos poucas implantações por mês para cuidar bem de cada uma. Se a agenda estiver cheia, a gente avisa o prazo
        antes de você contratar.
      </p>
    </LandingSection>
  );
}
