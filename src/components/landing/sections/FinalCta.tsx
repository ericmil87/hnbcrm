import { Link } from "react-router";
import { buttonClassName } from "@/components/ui/Button";
import { signUpHref } from "@/lib/authEntry";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS, PRIMARY_CTA_LABEL, trustLine } from "./landingCopy";

/**
 * CTA final: título da copy aprovada, botão e linha de confiança.
 * TODO(integração P1.2/onboarding): trocar o botão pelo composer do hero (mesmos
 * placeholders, chips e a bolha do Copiloto "Me conta: o que você vende e como
 * atende hoje?", 09:41), chamando a mesma função de envio do hero
 * (`goToOnboarding`, ainda não existe). Até lá o botão leva ao cadastro e não
 * promete que nada digitado seja preservado.
 */
export function FinalCta() {
  return (
    <LandingSection id={LANDING_ANCHORS.finalCta} title="Conte como é o seu negócio. A sua IA começa daí.">
      <Link to={signUpHref()} className={buttonClassName("primary", "lg", "w-full sm:w-auto")}>
        {PRIMARY_CTA_LABEL}
      </Link>
      <p className="mt-4 text-sm text-text-muted">{trustLine()}</p>
    </LandingSection>
  );
}
