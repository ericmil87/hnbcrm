import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { resolvePermissions, hasPermission, type Role } from "./permissions";

export type NotificationType =
  | "task_assigned"
  | "task_comment_mention"
  | "task_due_soon"
  | "task_overdue"
  | "handoff_requested"
  | "handoff_resolved"
  | "ai_draft_pending"
  | "campaign_completed"
  | "campaign_paused"
  | "group_joined"
  | "group_mention"
  | "group_post_pending"
  | "group_post_failed"
  | "group_opportunity"
  | "group_digest"
  | "ai_followup_needs_human";

// Cada tipo de notificação in-app tem o mesmo flag da preferência de e-mail
// (modelo opt-out: sem linha, ou flag ausente = habilitado).
const PREFERENCE_FLAG: Record<NotificationType, string> = {
  task_assigned: "taskAssigned",
  task_comment_mention: "taskCommentMention",
  task_due_soon: "taskDueSoon",
  task_overdue: "taskOverdue",
  handoff_requested: "handoffRequested",
  handoff_resolved: "handoffResolved",
  ai_draft_pending: "aiDraftPending",
  campaign_completed: "campaignCompleted",
  campaign_paused: "campaignPaused",
  group_joined: "groupJoined",
  group_mention: "groupMention",
  group_post_pending: "groupPostPending",
  group_post_failed: "groupPostFailed",
  group_opportunity: "groupOpportunity",
  group_digest: "groupDigest",
  // Só sino: não existe template de e-mail para este evento (`buildTemplate` é
  // fail-closed), e nenhum caminho chama `dispatchNotification` com ele.
  ai_followup_needs_human: "aiFollowupNeedsHuman",
};

/**
 * Humanos ATIVOS com direito de responder no inbox — o público de um aviso sem
 * destinatário definido (repasse da IA, follow-up que precisou de gente). Cap
 * de 25 para proteger a transação em orgs grandes.
 *
 * Mora aqui (e não em `handoffs.ts`, onde nasceu) porque o follow-up usa a
 * MESMA regra de destinatário e importar `handoffs.ts` de `lib/` fecharia um
 * ciclo de módulos.
 */
export async function inboxRepliers(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">
): Promise<Doc<"teamMembers">[]> {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", organizationId).eq("type", "human")
    )
    .collect();

  return members
    .filter(
      (m) =>
        m.status === "active" &&
        hasPermission(
          resolvePermissions(m.role as Role, m.permissions ?? undefined),
          "inbox",
          "reply"
        )
    )
    .slice(0, 25);
}

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
    handoffId?: Id<"handoffs">;
    conversationId?: Id<"conversations">;
    campaignId?: Id<"campaigns">;
    groupPostId?: Id<"groupPosts">;
    groupChatId?: Id<"groupChats">;
    /** Carga do botão de ação do item (oportunidade de grupo, digest). */
    data?: Record<string, unknown>;
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
    handoffId: args.handoffId,
    campaignId: args.campaignId,
    groupPostId: args.groupPostId,
    groupChatId: args.groupChatId,
    data: args.data,
    conversationId: args.conversationId,
    actorId: args.actorId,
    createdAt: Date.now(),
  });
}
