import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada e âncora.
 * P1.3: abas por perfil (Tabs), três pares "Hoje" / "Com o HNBCRM" por aba.
 */
export function S4Profiles() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.profiles}
      eyebrow="Por perfil"
      title="O que muda no seu dia"
      subtitle="Escolha o seu perfil. Três dores, três cenas."
      tone="raised"
    />
  );
}
