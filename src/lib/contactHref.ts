/**
 * Link de e-mail do "Falar com a gente" / "Pedir orçamento". Os botões abrem o formulário
 * (`ContactRequestForm`, que cria lead); este mailto é a alternativa quando o formulário
 * está indisponível (org interna sem configuração, rede, limite).
 */
import { LEGAL_ENTITY } from "./legalEntity";

export type ContactTopic = "implantacao" | "consultoria" | "empresa";

const SUBJECTS: Record<ContactTopic, string> = {
  implantacao: "Implantação HNBCRM",
  consultoria: "Consultoria HNBCRM",
  empresa: "Plano Empresa",
};

export function contactHref(topic: ContactTopic): string {
  return `mailto:${LEGAL_ENTITY.email}?subject=${encodeURIComponent(SUBJECTS[topic])}`;
}
