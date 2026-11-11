/**
 * Link do botão "Falar com a gente" / "Pedir orçamento" (implantação e plano Empresa).
 * Ponto único: a Onda 5 troca por um formulário que cria lead sem mexer nos botões.
 */
import { LEGAL_ENTITY } from "./legalEntity";

export type ContactTopic = "implantacao" | "empresa";

const SUBJECTS: Record<ContactTopic, string> = {
  implantacao: "Implantação HNBCRM",
  empresa: "Plano Empresa",
};

export function contactHref(topic: ContactTopic): string {
  return `mailto:${LEGAL_ENTITY.email}?subject=${encodeURIComponent(SUBJECTS[topic])}`;
}
