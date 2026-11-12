import { LandingSection } from "./LandingSection";
import { HeroChat } from "./HeroChat";
import { LANDING_ANCHORS, trustLine } from "./landingCopy";

/**
 * CTA final: título da copy aprovada, o mesmo composer do hero (`HeroChat`:
 * placeholders, chips, bolha do Copiloto e a mesma `goToOnboarding`) e a linha de
 * confiança.
 */
export function FinalCta() {
  return (
    <LandingSection id={LANDING_ANCHORS.finalCta} title="Conte como é o seu negócio. A sua IA começa daí.">
      <div className="max-w-xl">
        <HeroChat variant="final" />
      </div>
      <p className="mt-4 text-sm text-text-muted">{trustLine()}</p>
    </LandingSection>
  );
}
