import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada e âncora.
 * P1.6: implantação Express, Completa e Empresa, acompanhamento e consultoria sob medida (valores do catálogo).
 */
export function S7Services() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.services}
      eyebrow="Opcional"
      title="Quer que a gente monte junto?"
    />
  );
}
