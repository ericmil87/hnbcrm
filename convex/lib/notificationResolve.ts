import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import type { NotificationType } from "./notify";

/**
 * Porta única "resolvido" do sino (B1): quando o assunto de uma notificação foi
 * resolvido em outro lugar (conversa aberta, pedido de ajuda assumido, rascunho
 * revisado, tarefa concluída, canal reconectado), as não lidas daquela entidade
 * viram lidas e guardam quem/quando/por quê em `data.resolvedBy/At/Reason`.
 *
 * Leitura sempre por índice com `readAt` ausente (= não lida) e `take`: o custo
 * é uma leitura limitada + um patch por linha resolvida (broadcast ≤ 25).
 * Não lidas ANTIGAS sem o campo top-level `channelConfigId`/`metaConnectionId`
 * (avisos de canal anteriores ao B1) não têm índice: a retenção de 30 dias as
 * encerra.
 */
export type ResolveTarget =
  | { conversationId: Id<"conversations"> }
  | { handoffId: Id<"handoffs"> }
  | { taskId: Id<"tasks"> }
  | { channelId: Id<"channelConfigs"> }
  | { metaConnectionId: Id<"metaConnections"> };

export const RESOLVE_BATCH = 200;

export async function resolveEntityNotifications(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    target: ResolveTarget;
    /** Só as notificações DESTE membro (abrir conversa). Ausente = de todos. */
    memberId?: Id<"teamMembers">;
    /** Quem resolveu (aceitou o pedido, concluiu a tarefa…). */
    resolvedByMemberId?: Id<"teamMembers">;
    reason: string;
    /** Restringe por tipo (a leitura é por entidade; o filtro é em memória sobre ≤ RESOLVE_BATCH linhas). */
    types?: NotificationType[];
  }
): Promise<number> {
  const db = ctx.db;
  const t = args.target;
  let rows: Doc<"notifications">[];
  if ("conversationId" in t) {
    rows = args.memberId
      ? await db
          .query("notifications")
          .withIndex("by_member_conversation_and_read", (q) =>
            q.eq("memberId", args.memberId!).eq("conversationId", t.conversationId).eq("readAt", undefined)
          )
          .take(RESOLVE_BATCH)
      : await db
          .query("notifications")
          .withIndex("by_conversation_and_read", (q) =>
            q.eq("conversationId", t.conversationId).eq("readAt", undefined)
          )
          .take(RESOLVE_BATCH);
  } else if ("handoffId" in t) {
    rows = await db
      .query("notifications")
      .withIndex("by_handoff_and_read", (q) => q.eq("handoffId", t.handoffId).eq("readAt", undefined))
      .take(RESOLVE_BATCH);
  } else if ("taskId" in t) {
    rows = await db
      .query("notifications")
      .withIndex("by_task_and_read", (q) => q.eq("taskId", t.taskId).eq("readAt", undefined))
      .take(RESOLVE_BATCH);
  } else if ("channelId" in t) {
    rows = await db
      .query("notifications")
      .withIndex("by_channel_config_and_read", (q) => q.eq("channelConfigId", t.channelId).eq("readAt", undefined))
      .take(RESOLVE_BATCH);
  } else {
    rows = await db
      .query("notifications")
      .withIndex("by_meta_connection_and_read", (q) =>
        q.eq("metaConnectionId", t.metaConnectionId).eq("readAt", undefined)
      )
      .take(RESOLVE_BATCH);
  }

  const now = Date.now();
  let resolved = 0;
  for (const n of rows) {
    // Defesa multi-tenant: o índice é por entidade, a org confere aqui.
    if (n.organizationId !== args.organizationId) continue;
    if (args.memberId && n.memberId !== args.memberId) continue;
    if (args.types && !args.types.includes(n.type)) continue;
    await db.patch(n._id, {
      readAt: now,
      data: {
        ...(n.data ?? {}),
        ...(args.resolvedByMemberId ? { resolvedBy: args.resolvedByMemberId } : {}),
        resolvedAt: now,
        resolvedReason: args.reason,
      },
    });
    resolved++;
  }
  return resolved;
}

/**
 * Dedupe do `ai_draft_pending`: "já existe aviso NÃO LIDO deste membro para a
 * conversa E ainda há rascunho pendente (outro que não o recém-criado)". Só
 * "não lido" silenciava para sempre quem revisou no inbox sem passar pelo sino.
 */
export async function draftNotificationAlreadyPending(
  ctx: MutationCtx,
  args: {
    memberId: Id<"teamMembers">;
    conversationId: Id<"conversations">;
    /** O rascunho que acabou de ser gravado (não conta como "outro"). */
    excludeMessageId?: Id<"messages">;
  }
): Promise<boolean> {
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_member_conversation_and_read", (q) =>
      q.eq("memberId", args.memberId).eq("conversationId", args.conversationId).eq("readAt", undefined)
    )
    .take(10);
  if (!unread.some((n) => n.type === "ai_draft_pending")) return false;
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", args.conversationId))
    .order("desc")
    .take(30);
  return recent.some(
    (m) =>
      m._id !== args.excludeMessageId &&
      (m.metadata?.aiDraft as { status?: string } | undefined)?.status === "pending"
  );
}

/**
 * Membro removido: marca como lidas as não lidas dele (não reaparecem numa
 * readmissão). Até 5 lotes de 100 por chamada; o excedente raro cai na
 * retenção de 30 dias.
 */
export async function markMemberNotificationsRead(
  ctx: MutationCtx,
  memberId: Id<"teamMembers">,
  reason: string
): Promise<number> {
  const now = Date.now();
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_member_and_read", (q) => q.eq("memberId", memberId).eq("readAt", undefined))
      .take(100);
    for (const n of rows) {
      await ctx.db.patch(n._id, { readAt: now, data: { ...(n.data ?? {}), resolvedAt: now, resolvedReason: reason } });
    }
    total += rows.length;
    if (rows.length < 100) break;
  }
  return total;
}
