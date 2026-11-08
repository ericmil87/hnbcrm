/**
 * Destino (rota dentro do app) de um aviso, por tipo. FONTE ÚNICA: o push
 * (`webPush.pushTargetPath`) e o clique do sino no front importam daqui.
 * Pura, sem ctx.
 */
import type { NotificationType } from "./notify";

export type NotificationTargetData = {
  conversationId?: string;
  handoffId?: string;
  taskId?: string;
  metaConnectionId?: string;
  /** `data` livre do aviso (só `metaConnectionId` é lido). */
  data?: Record<string, unknown>;
};

export function notificationTargetPath(type: NotificationType | string, d: NotificationTargetData): string {
  const conversation = d.conversationId ? `/app/entrada?conversation=${d.conversationId}` : null;
  switch (type) {
    case "handoff_requested":
      return d.handoffId ? `/app/repasses?handoff=${d.handoffId}` : (conversation ?? "/app/repasses");
    case "new_message":
    case "conversation_transferred":
    case "ai_draft_pending":
      return conversation ?? "/app/entrada";
    case "group_mention":
      return conversation ?? "/app/grupos";
    case "channel_session_lost": {
      const isMeta = Boolean(d.metaConnectionId ?? d.data?.metaConnectionId);
      return `/app/configuracoes?secao=${isMeta ? "instagram" : "channels"}`;
    }
    case "ai_followup_needs_human":
      return d.taskId ? `/app/tarefas?task=${d.taskId}` : (conversation ?? "/app/tarefas");
    default:
      return d.taskId ? `/app/tarefas?task=${d.taskId}` : (conversation ?? "/app/painel");
  }
}
