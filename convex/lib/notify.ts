import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

export type NotificationType =
  | "task_assigned"
  | "task_comment_mention"
  | "task_due_soon"
  | "task_overdue";

// Cada tipo de notificação in-app tem o mesmo flag da preferência de e-mail
// (modelo opt-out: sem linha, ou flag ausente = habilitado).
const PREFERENCE_FLAG: Record<NotificationType, string> = {
  task_assigned: "taskAssigned",
  task_comment_mention: "taskCommentMention",
  task_due_soon: "taskDueSoon",
  task_overdue: "taskOverdue",
};

/**
 * Filtra ids de membros mantendo só os que pertencem à organização informada.
 *
 * Chame SEMPRE antes de notificar com ids vindos do cliente (menções,
 * responsáveis via API): sem isso um usuário da Org A consegue endereçar um
 * membro da Org B e vazar título de tarefa / trecho de comentário para outro
 * tenant — inclusive por e-mail, que não é coberto pelo gate de
 * `createNotification`.
 */
export async function filterMembersOfOrg(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  memberIds: Id<"teamMembers">[]
): Promise<Id<"teamMembers">[]> {
  const allowed: Id<"teamMembers">[] = [];
  for (const memberId of memberIds) {
    const member = await ctx.db.get(memberId);
    if (member && member.organizationId === organizationId) allowed.push(memberId);
  }
  return allowed;
}

/**
 * Insere uma notificação in-app para um membro, na mesma transação da mutation.
 *
 * Regras:
 * - O membro TEM que ser da organização da notificação (isolamento multi-tenant).
 * - Só notifica membros humanos (o sino é da UI; membros IA não têm feed — P0.2 fora de escopo).
 * - Não notifica o próprio ator (actorId === memberId vira no-op).
 * - Respeita `notificationPreferences` do destinatário (opt-out: flag === false pula).
 */
export async function createNotification(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    memberId: Id<"teamMembers">;
    type: NotificationType;
    title: string;
    body?: string;
    taskId?: Id<"tasks">;
    actorId?: Id<"teamMembers">;
  }
): Promise<void> {
  if (args.actorId && args.actorId === args.memberId) return;
  const member = await ctx.db.get(args.memberId);
  if (!member || member.type !== "human") return;
  if (member.organizationId !== args.organizationId) return;

  const prefs = await ctx.db
    .query("notificationPreferences")
    .withIndex("by_organization_and_member", (q) =>
      q.eq("organizationId", args.organizationId).eq("teamMemberId", args.memberId)
    )
    .first();
  if (prefs && (prefs as any)[PREFERENCE_FLAG[args.type]] === false) return;

  await ctx.db.insert("notifications", {
    organizationId: args.organizationId,
    memberId: args.memberId,
    type: args.type,
    title: args.title,
    body: args.body,
    taskId: args.taskId,
    actorId: args.actorId,
    createdAt: Date.now(),
  });
}
