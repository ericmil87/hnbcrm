import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada e âncora.
 * P1.3: cartões Atendente, Copiloto e Sua equipe, com microcenas e a faixa de canais.
 */
export function S3Team() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.team}
      eyebrow="Humanos e IAs no mesmo time"
      title="Três no mesmo time"
      subtitle="Cada um tem o seu papel. Ninguém atropela ninguém."
    />
  );
}
