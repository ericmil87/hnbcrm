/**
 * D1 — grupos do sino (chips) e da matriz de preferências (C2). Puro: o front
 * importa este arquivo. Todo tipo de `notifications.type` tem exatamente um
 * grupo (paridade garantida em `notificationInbox.test.ts`).
 */
export const NOTIFICATION_GROUPS = ["atendimento", "tarefas", "grupos", "campanhas", "sistema"] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

export const NOTIFICATION_GROUP_LABELS: Record<NotificationGroup, string> = {
  atendimento: "Atendimento",
  tarefas: "Tarefas",
  grupos: "Grupos",
  campanhas: "Campanhas",
  sistema: "Sistema",
};

export const NOTIFICATION_TYPE_GROUP: Record<string, NotificationGroup> = {
  handoff_requested: "atendimento",
  handoff_resolved: "atendimento",
  ai_draft_pending: "atendimento",
  ai_followup_needs_human: "atendimento",
  conversation_transferred: "atendimento",
  new_message: "atendimento",
  lead_assigned: "atendimento",
  task_assigned: "tarefas",
  task_comment_mention: "tarefas",
  task_due_soon: "tarefas",
  task_overdue: "tarefas",
  group_joined: "grupos",
  group_mention: "grupos",
  group_post_pending: "grupos",
  group_post_failed: "grupos",
  group_opportunity: "grupos",
  group_digest: "grupos",
  campaign_completed: "campanhas",
  campaign_paused: "campanhas",
  channel_session_lost: "sistema",
  ai_spend_warning: "sistema",
  ai_spend_reached: "sistema",
  plan_usage_warning: "sistema",
  plan_usage_reached: "sistema",
  plan_overage_cap_reached: "sistema",
  trial_ending: "sistema",
  plan_read_only: "sistema",
};

/** Grupo do tipo; tipo desconhecido (versão futura) cai em "sistema". */
export function groupOfType(type: string): NotificationGroup {
  return NOTIFICATION_TYPE_GROUP[type] ?? "sistema";
}

export function typesOfGroup(group: NotificationGroup): string[] {
  return Object.keys(NOTIFICATION_TYPE_GROUP).filter((t) => NOTIFICATION_TYPE_GROUP[t] === group);
}
