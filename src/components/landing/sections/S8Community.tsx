import { buttonClassName } from "@/components/ui/Button";
import { communityUrl } from "@/lib/communityLink";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

/**
 * Placeholder estrutural (P1.1): título da copy aprovada, âncora e o botão do
 * grupo. Sem `VITE_COMMUNITY_URL` (ou com link que não é https) a seção não
 * aparece, e o link "Comunidade" some da navegação.
 * P1.6: três linhas (com a alternativa "Regras simples, fixadas na descrição") e QR code no computador.
 */
export function S8Community() {
  const url = communityUrl();
  if (!url) return null;
  return (
    <LandingSection
      id={LANDING_ANCHORS.community}
      eyebrow="Comunidade"
      title="Entre no grupo de quem está colocando IA no atendimento"
      subtitle="Troque ideias, tire dúvidas e receba as novidades do HNBCRM no WhatsApp."
    >
      <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClassName("primary", "lg")}>
        Entrar no grupo do WhatsApp
      </a>
    </LandingSection>
  );
}
