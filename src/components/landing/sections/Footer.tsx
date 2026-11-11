import { Footer as SharedFooter } from "../Footer";

/**
 * Rodapé da landing. Por enquanto (P1.1) é o rodapé compartilhado das páginas
 * públicas, que já traz a identificação legal (`LegalIdentification`) e a versão.
 * P1.6: rodapé novo da copy (Produto, Mais, linha de desenvolvedores, legal, versão).
 */
export function LandingFooter() {
  return <SharedFooter />;
}
