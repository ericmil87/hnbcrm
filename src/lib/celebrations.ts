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
    title: "Primeiro Lead!",
    description: "Voce criou seu primeiro lead no CRM.",
  },
  first_contact: {
    title: "Primeiro Contato!",
    description: "Seu primeiro contato foi adicionado.",
  },
  first_invite: {
    title: "Equipe Crescendo!",
    description: "Voce convidou seu primeiro membro.",
  },
  first_webhook: {
    title: "Integrado!",
    description: "Webhook ou API Key configurado.",
  },
  custom_fields: {
    title: "Personalizado!",
    description: "Campos personalizados explorados.",
  },
  wizard_complete: {
    title: "Tudo Pronto!",
    description: "Seu CRM esta configurado e pronto para usar.",
  },
  checklist_complete: {
    title: "Missao Cumprida!",
    description: "Todos os passos iniciais foram concluidos!",
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
    title: "Pipeline Kanban",
    description:
      "Arraste cards entre etapas para atualizar o status dos seus leads.",
  },
  {
    id: "contacts",
    title: "Contatos",
    description:
      "Cadastre e organize contatos. Use a busca por nome, email ou empresa.",
  },
  {
    id: "inbox",
    title: "Caixa de Entrada",
    description:
      "Todas as conversas em um so lugar — WhatsApp, email e webchat.",
  },
  {
    id: "handoffs",
    title: "Repasses",
    description:
      "Quando a IA precisa de ajuda humana, os repasses aparecem aqui.",
  },
  {
    id: "team",
    title: "Equipe",
    description:
      "Gerencie humanos e bots de IA como uma equipe unificada.",
  },
];
