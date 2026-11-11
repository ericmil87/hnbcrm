import { Link } from "react-router";
import { buttonClassName } from "@/components/ui/Button";
import { signUpHref } from "@/lib/authEntry";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS, PRIMARY_CTA_LABEL, trustLine } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada, âncora, botão e
 * linha de confiança.
 * P1.6: repete o composer do hero (mesmos placeholders e chips) com a bolha do Copiloto.
 */
export function FinalCta() {
  return (
    <LandingSection id={LANDING_ANCHORS.finalCta} title="Conte como é o seu negócio. A sua IA começa daí.">
      <Link to={signUpHref()} className={buttonClassName("primary", "lg")}>
        {PRIMARY_CTA_LABEL}
      </Link>
      <p className="mt-4 text-sm text-text-muted">{trustLine()}</p>
    </LandingSection>
  );
}
