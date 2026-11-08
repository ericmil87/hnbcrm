import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { resolvePermissions, hasPermission, type Role } from "./permissions";
import { isMembershipRevoked } from "./auth";
import { internal } from "../_generated/api";
import { modulesOf } from "./orgModules";
import { hasTelegramTemplate } from "./telegramNotifications";
import { notificationCopy } from "./notificationCopy";
import { shouldDeliver, type PolicyPrefs } from "./notificationPolicy";
import { loadMemberPrefs, orgDefaultsOf } from "./notificationPrefs";

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
  | "ai_followup_needs_human"
  | "conversation_transferred"
  | "channel_session_lost"
  | "ai_spend_warning"
  | "ai_spend_reached"
  | "new_message"
  | "lead_assigned";

// Tipo → flag de preferência: `PREFERENCE_FLAG` mora em `lib/notificationPolicy.ts` (pura).

/**
 * Agrupamento (B2): com `coalesce`, uma NÃO lida do membro com a mesma `key`
 * (e dentro de `windowMs`, contado do primeiro evento do grupo) é atualizada em
 * vez de nascer outra: `data.count` soma `increment`, `title`/`body` vêm de
 * `render(total)` (ou dos args), `createdAt` renova (sobe no sino).
 *
 * Telegram num patch: só com `telegramOnPatch` (o chamador já agrupou numa
 * janela própria: relay de 20 s, rascunho novo para revisar). Sem isso o patch
 * é silencioso — nunca 2 envios para a mesma janela.
 */
export type CoalesceOptions = {
  key: string;
  windowMs?: number;
  /** Quantos eventos este aviso representa (default 1). */
  increment?: number;
  render?: (count: number) => { title: string; body?: string };
  telegramOnPatch?: boolean;
};

export const coalesceKeys = {
  newMessage: (conversationId: Id<"conversations">) => `new_message:${conversationId}`,
  groupMention: (groupChatId: Id<"groupChats">) => `group_mention:${groupChatId}`,
  aiDraft: (conversationId: Id<"conversations">) => `ai_draft_pending:${conversationId}`,
};

export const GROUP_MENTION_WINDOW_MS = 10 * 60 * 1000;

/** Fuso da org para os textos do sino (`notificationCopy`); fallback no formatador. */
export async function orgTimeZone(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">
): Promise<string | undefined> {
  return (await ctx.db.get(organizationId))?.settings.timezone;
}

/**
 * Humanos não removidos (inclui `busy`: alerta de repasse é crítico) com direito de responder no inbox — o público de um aviso sem
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
        !isMembershipRevoked(m) &&
        // Pendente (sem conta) não abre o link nem ocupa vaga do cap.
        !!m.userId &&
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
    // Removido da org não é notificado (nem enxergaria o aviso).
    if (member && member.organizationId === organizationId && !isMembershipRevoked(member)) {
      allowed.push(memberId);
    }
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
 * - Membro removido (`isMembershipRevoked`) ou sem `userId` é recusado (B1).
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
    /** B1: canal de origem (aviso de sessão perdida) — índice da porta "resolvido". */
    channelConfigId?: Id<"channelConfigs">;
    metaConnectionId?: Id<"metaConnections">;
    /** Carga do botão de ação do item (oportunidade de grupo, digest). */
    data?: Record<string, unknown>;
    actorId?: Id<"teamMembers">;
    coalesce?: CoalesceOptions;
  }
): Promise<void> {
  if (args.actorId && args.actorId === args.memberId) return;
  const member = await ctx.db.get(args.memberId);
  if (!member || member.type !== "human") return;
  if (member.organizationId !== args.organizationId) return;
  // B1: removido da org ou pendente de convite (sem conta) não recebe nem acumula.
  if (isMembershipRevoked(member) || !member.userId) return;

  const prefs = await loadMemberPrefs(ctx, args.organizationId, args.memberId);
  const now = Date.now();
  // Sino (C1): flag antigo `false` só apaga tipos NÃO acionáveis; acionável sempre registra.
  if (shouldDeliver({ type: args.type, channel: "bell", prefs, now }) !== "deliver") return;
  const co = args.coalesce;
  const increment = Math.max(1, Math.floor(co?.increment ?? 1));
  if (co) {
    // Uma leitura indexada: a não lida mais nova do membro com esta chave.
    const existing = await ctx.db
      .query("notifications")
      .withIndex("by_member_and_coalesce_and_read", (q) =>
        q.eq("memberId", args.memberId).eq("coalesceKey", co.key).eq("readAt", undefined)
      )
      .order("desc")
      .first();
    const since = typeof existing?.data?.coalescedSince === "number" ? existing.data.coalescedSince : existing?.createdAt;
    const inWindow = existing && (co.windowMs === undefined || now - (since ?? 0) <= co.windowMs);
    if (existing && existing.organizationId === args.organizationId && inWindow) {
      const prevCount = typeof existing.data?.count === "number" ? existing.data.count : 1;
      const count = prevCount + increment;
      const copy = co.render ? co.render(count) : { title: args.title, body: args.body };
      await ctx.db.patch(existing._id, {
        title: copy.title,
        body: copy.body,
        // `data` do evento ATUAL (ex.: `messageIds` da última janela, que o cartão do
        // Telegram mostra) + contagem acumulada.
        data: { ...(args.data ?? {}), count, coalescedSince: since ?? existing.createdAt },
        actorId: args.actorId,
        createdAt: now,
      });
      if (co.telegramOnPatch) await maybeScheduleTelegram(ctx, args, existing._id, now, prefs);
      return;
    }
  }
  const copy = co?.render ? co.render(increment) : { title: args.title, body: args.body };

  const notificationId = await ctx.db.insert("notifications", {
    organizationId: args.organizationId,
    memberId: args.memberId,
    type: args.type,
    title: copy.title,
    body: copy.body,
    taskId: args.taskId,
    handoffId: args.handoffId,
    campaignId: args.campaignId,
    groupPostId: args.groupPostId,
    groupChatId: args.groupChatId,
    channelConfigId: args.channelConfigId,
    metaConnectionId: args.metaConnectionId,
    data: co ? { ...(args.data ?? {}), count: increment, coalescedSince: now } : args.data,
    conversationId: args.conversationId,
    actorId: args.actorId,
    createdAt: now,
    ...(co ? { coalesceKey: co.key } : {}),
  });
  await maybeScheduleTelegram(ctx, args, notificationId, now, prefs);
}

async function maybeScheduleTelegram(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; memberId: Id<"teamMembers">; type: NotificationType },
  notificationId: Id<"notifications">,
  now: number,
  prefs: PolicyPrefs | null
): Promise<void> {
  // Telegram (F1, D7): mesma porta, depois do insert — o self-skip e a
  // preferência acima já valeram. Uma leitura indexada do vínculo ativo; envio
  // e formatação ficam na action agendada (nada de rede numa mutation).
  if (!hasTelegramTemplate(args.type)) return;
  const link = await ctx.db
    .query("telegramLinks")
    .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", args.memberId).eq("status", "active"))
    .first();
  if (!link || link.organizationId !== args.organizationId) return;
  // Switch do relay: vale só para o Telegram (o sino já gravou, B2).
  if (args.type === "new_message" && !link.prefs.relayAssignedConversations) return;
  const org = await ctx.db.get(args.organizationId);
  if (!modulesOf(org).telegram) return;
  // C1: política única — preferência por canal, pausa (`pausedUntil` + `mutedUntil` legado
  // do `/pausar`) e silêncio. O sino já gravou; aqui só decide se o Telegram toca.
  const decision = shouldDeliver({
    type: args.type,
    channel: "telegram",
    prefs,
    orgDefaults: orgDefaultsOf(org),
    now,
    legacyMutedUntil: link.mutedUntil,
  });
  if (decision !== "deliver") return;
  await ctx.scheduler.runAfter(0, internal.telegram.internalDeliverNotification, { notificationId });
}

/**
 * B2: lead atribuído a um membro → sino (o e-mail `leadAssigned` continua no
 * chamador). Sem ponteiro de conversa: `data.leadId` (o clique do sino ganha
 * destino no D1). Self-skip/IA/opt-out ficam com `createNotification`.
 */
export async function notifyLeadAssigned(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    leadId: Id<"leads">;
    leadTitle: string;
    memberId: Id<"teamMembers">;
    actor: Pick<Doc<"teamMembers">, "_id" | "name">;
  }
): Promise<void> {
  await createNotification(ctx, {
    organizationId: args.organizationId,
    memberId: args.memberId,
    type: "lead_assigned",
    ...notificationCopy({ type: "lead_assigned", leadTitle: args.leadTitle, actorName: args.actor.name }),
    data: { leadId: args.leadId },
    actorId: args.actor._id,
  });
}
