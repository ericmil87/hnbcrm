export type MilestoneId =
  | "first_lead"
  | "first_contact"
  | "first_invite"
  | "first_webhook"
  | "custom_fields"
  | "wizard_complete"
  | "checklist_complete";

export interface MilestoneConfig {
  title: string;
  description: string;
}

export const MILESTONES: Record<MilestoneId, MilestoneConfig> = {
  first_lead: {
    title: "Primeiro lead",
    description: "Você criou seu primeiro lead no CRM.",
  },
  first_contact: {
    title: "Primeiro contato",
    description: "Seu primeiro contato foi adicionado.",
  },
  first_invite: {
    title: "Equipe crescendo",
    description: "Você convidou seu primeiro membro.",
  },
  first_webhook: {
    title: "Integrado",
    description: "Webhook ou chave de integração configurado.",
  },
  custom_fields: {
    title: "Personalizado",
    description: "Campos personalizados explorados.",
  },
  wizard_complete: {
    title: "Tudo pronto",
    description: "Seu CRM está configurado e pronto para usar.",
  },
  checklist_complete: {
    title: "Missão cumprida",
    description: "Todos os passos iniciais foram concluídos.",
  },
};

export interface SpotlightConfig {
  id: string;
  title: string;
  description: string;
}

export const SPOTLIGHTS: SpotlightConfig[] = [
  {
    id: "board",
    title: "Funil de vendas",
    description:
      "Arraste cards entre etapas para atualizar o status dos seus leads.",
  },
  {
    id: "contacts",
    title: "Contatos",
    description:
      "Cadastre e organize contatos. Use a busca por nome, e-mail ou empresa.",
  },
  {
    id: "inbox",
    title: "Conversas",
    description:
      "Todas as conversas em um só lugar — WhatsApp, e-mail e chat do site.",
  },
  {
    id: "handoffs",
    title: "Requer atenção",
    description:
      "Quando a IA precisar de alguém da equipe, a conversa aparece aqui.",
  },
  {
    id: "team",
    title: "Equipe",
    description:
      "Gerencie pessoas e agentes de IA como uma só equipe.",
  },
];
