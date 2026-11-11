import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada e âncora.
 * P1.6: dados de `src/components/landing/socialProof.ts`; em produção só itens reais.
 */
export function S7bSocialProof() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.socialProof}
      title="Como é usar no dia a dia"
      tone="raised"
    />
  );
}
