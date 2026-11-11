import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada e âncora.
 * P1.3: três passos, aviso sobre o QR code (sempre visível) e o botão Testar grátis.
 */
export function S5HowItStarts() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.howItStarts}
      eyebrow="Em 3 passos"
      title="Como começa"
    />
  );
}
