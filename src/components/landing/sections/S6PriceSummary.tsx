import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada, âncora e o link para
 * a tabela completa (a tabela saiu da landing e fica só em /precos).
 * P1.6: quatro cartões compactos do catálogo, calculadora reduzida e CTA.
 */
export function S6PriceSummary() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.price}
      eyebrow="Preço"
      title="Preço em 20 segundos"
      subtitle="A equipe inteira, sem cobrar por pessoa. Você paga pelas pessoas que a IA atende."
      tone="raised"
    >
      <Link to="/precos" className={buttonClassName("secondary", "lg")}>
        Ver tabela completa
        <ArrowRight className="size-4" aria-hidden="true" />
      </Link>
    </LandingSection>
  );
}
