import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada e âncora.
 * P1.2: cena em loop com três painéis (Conversa, Funil, Você), botão de pausa e legenda.
 */
export function S2Machine() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.machine}
      eyebrow="Veja acontecendo"
      title="A máquina funcionando, às 23h14"
      subtitle="Um cliente manda áudio. A IA entende, responde e move o lead no Funil. Você só entra quando importa."
      tone="raised"
    />
  );
}
