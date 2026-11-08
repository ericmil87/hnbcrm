import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { resolvePermissions, hasPermission, type Role } from "./permissions";
import { isMembershipRevoked } from "./auth";
import { notificationCopy } from "./notificationCopy";
import { shouldDeliver } from "./notificationPolicy";
import { loadMemberPrefs } from "./notificationPrefs";
import { dispatchNotificationChannels, type EmailFallback } from "./notificationChannels";
import { carriedRenotifyState, nextRenotifyState } from "./webPush";

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
 * Telegram e push (E1) num patch: só com `telegramOnPatch` (o chamador já
 * agrupou numa janela própria: relay de 20 s, rascunho novo para revisar). Sem
 * isso o patch é silencioso — nunca 2 envios para a mesma janela. O nome ficou
 * do B2; vale para os dois canais "que tocam".
 */
export type CoalesceOptions = {
  key: string;
  windowMs?: number;
  /** Quantos eventos este aviso representa (default 1). */
  increment?: number;
  render?: (count: number) => { title: string; body?: string };
  telegramOnPatch?: boolean;
  /**
   * Com `telegramOnPatch`: o PUSH do patch só sai se passou a janela de renotify
   * (5 min do último toque que de fato saiu). O Telegram segue a cada patch.
   * Usado por `group_mention` (cada menção vai ao Telegram, mas o aparelho não vibra a cada uma).
   */
  pushOnlyAfterRenotifyWindow?: boolean;
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
 * - Depois de gravar, a escada de canais (`lib/notificationChannels.ts`): Telegram,
 *   push e o e-mail de reserva (`email`, só para os tipos de rede de segurança).
 *
 * Devolve o id do aviso gravado/atualizado, ou null quando nada foi gravado.
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
    /** E1: e-mail de reserva (+10/+30 min, só se ainda não lido). Ignorado num patch. */
    email?: EmailFallback;
  }
): Promise<Id<"notifications"> | null> {
  if (args.actorId && args.actorId === args.memberId) return null;
  const member = await ctx.db.get(args.memberId);
  if (!member || member.type !== "human") return null;
  if (member.organizationId !== args.organizationId) return null;
  // B1: removido da org ou pendente de convite (sem conta) não recebe nem acumula.
  if (isMembershipRevoked(member) || !member.userId) return null;

  const prefs = await loadMemberPrefs(ctx, args.organizationId, args.memberId);
  const now = Date.now();
  // Sino (C1): flag antigo `false` só apaga tipos NÃO acionáveis; acionável sempre registra.
  if (shouldDeliver({ type: args.type, channel: "bell", prefs, now }) !== "deliver") return null;
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
      // Renotify (E1): o relógio dos 5 min só anda quando o push de fato é agendado
      // (pausa/silêncio/sem aparelho não contam como toque).
      const nextRenotify = nextRenotifyState(existing.data, now);
      const pushAllowed = !co.pushOnlyAfterRenotifyWindow || nextRenotify.pushRenotify;
      const { pushScheduled } = await dispatchNotificationChannels(ctx, {
        organizationId: args.organizationId,
        memberId: args.memberId,
        type: args.type,
        notificationId: existing._id,
        now,
        prefs,
        isPatch: true,
        externalOnPatch: co.telegramOnPatch,
        pushAllowed,
      });
      await ctx.db.patch(existing._id, {
        title: copy.title,
        body: copy.body,
        // `data` do evento ATUAL (ex.: `messageIds` da última janela, que o cartão do
        // Telegram mostra) + contagem acumulada.
        // E1: `pushRenotify` = vibrar de novo (1ª vez ou ≥ 5 min do último toque).
        // Só avança quando este patch de fato empurra (Telegram/push); patch
        // silencioso preserva o estado (senão o relógio dos 5 min andaria sem toque).
        data: {
          ...(args.data ?? {}),
          count,
          coalescedSince: since ?? existing.createdAt,
          ...(pushScheduled ? nextRenotify : carriedRenotifyState(existing.data)),
        },
        actorId: args.actorId,
        createdAt: now,
      });
      return existing._id;
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
    data: co
      ? { ...(args.data ?? {}), count: increment, coalescedSince: now, pushRenotify: true }
      : args.data,
    conversationId: args.conversationId,
    actorId: args.actorId,
    createdAt: now,
    ...(co ? { coalesceKey: co.key } : {}),
  });
  const { pushScheduled } = await dispatchNotificationChannels(ctx, {
    organizationId: args.organizationId,
    memberId: args.memberId,
    type: args.type,
    notificationId,
    now,
    prefs,
    isPatch: false,
    email: args.email,
  });
  // O relógio do renotify só começa quando o push de fato saiu do servidor.
  if (co && pushScheduled) {
    const row = await ctx.db.get(notificationId);
    await ctx.db.patch(notificationId, { data: { ...(row?.data ?? {}), pushRenotifyAt: now } });
  }
  return notificationId;
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
