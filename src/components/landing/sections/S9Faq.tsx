import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada e âncora.
 * P1.6: cinco perguntas e o link para /precos#perguntas.
 */
export function S9Faq() {
  return (
    <LandingSection
      id={LANDING_ANCHORS.faq}
      title="Perguntas rápidas"
      tone="raised"
    />
  );
}
