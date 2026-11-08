import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { coalesceKeys, type NotificationType } from "./notify";

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

export const SCAN_PAGE = 200;
export const SCAN_MAX_PAGES = 5;

/**
 * Não lidas de uma conversa (todas as pessoas), da mais nova para a mais
 * antiga, até SCAN_PAGE * SCAN_MAX_PAGES linhas, numa única leitura. `match` filtra em memória
 * (o índice é por conversa); `stopAtFirst` para na primeira que casar.
 */
async function scanConversationUnread(
  ctx: { db: MutationCtx["db"] },
  conversationId: Id<"conversations">,
  opts: {
    match?: (n: Doc<"notifications">) => boolean;
    stopAtFirst?: boolean;
    limit?: number;
    /** Com membro: índice por (conversa, membro) — lê só as não lidas dele. */
    memberId?: Id<"teamMembers">;
  }
): Promise<Doc<"notifications">[]> {
  // UMA leitura (o servidor só aceita uma query paginada por função; paginar
  // em laço quebraria): as mais novas primeiro, com teto.
  const cap = Math.min(opts.limit ?? SCAN_PAGE * SCAN_MAX_PAGES, SCAN_PAGE * SCAN_MAX_PAGES);
  const memberId = opts.memberId;
  const rows = memberId
    ? await ctx.db
        .query("notifications")
        .withIndex("by_conversation_and_member_and_read", (q) =>
          q.eq("conversationId", conversationId).eq("memberId", memberId).eq("readAt", undefined)
        )
        .order("desc")
        .take(Math.min(cap, SCAN_PAGE))
    : await ctx.db
        .query("notifications")
        .withIndex("by_conversation_and_read", (q) => q.eq("conversationId", conversationId).eq("readAt", undefined))
        .order("desc")
        .take(cap);
  const out: Doc<"notifications">[] = [];
  for (const n of rows) {
    if (!opts.match || opts.match(n)) {
      out.push(n);
      if (opts.stopAtFirst) break;
    }
  }
  return out;
}

/** Tarefa concluída/cancelada/excluída: avisos de prazo/atribuição deixam de valer (porta única). */
export async function resolveTaskNotifications(
  ctx: MutationCtx,
  task: Pick<Doc<"tasks">, "_id" | "organizationId">,
  reason: string,
  resolvedByMemberId?: Id<"teamMembers">
): Promise<number> {
  return resolveEntityNotifications(ctx, {
    organizationId: task.organizationId,
    target: { taskId: task._id },
    resolvedByMemberId,
    reason,
    // Excluída: a menção em comentário também perde o destino (na conclusão ela segue valendo).
    types:
      reason === "task_deleted"
        ? ["task_due_soon", "task_overdue", "task_assigned", "task_comment_mention"]
        : ["task_due_soon", "task_overdue", "task_assigned"],
  });
}

/**
 * Desfazer (Telegram): reabre os avisos que ESTA porta resolveu por um dos
 * `reasons` (limpa `readAt` e `data.resolved*`). Só handoff/tarefa, `take(50)`.
 */
export async function reopenEntityNotifications(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    target: { handoffId: Id<"handoffs"> } | { taskId: Id<"tasks"> };
    reasons: string[];
  }
): Promise<number> {
  const t = args.target;
  const rows =
    "handoffId" in t
      ? await ctx.db.query("notifications").withIndex("by_handoff_and_read", (q) => q.eq("handoffId", t.handoffId)).take(50)
      : await ctx.db.query("notifications").withIndex("by_task_and_read", (q) => q.eq("taskId", t.taskId)).take(50);
  let reopened = 0;
  for (const n of rows) {
    if (n.organizationId !== args.organizationId || n.readAt === undefined) continue;
    const reason = n.data?.resolvedReason;
    if (typeof reason !== "string" || !args.reasons.includes(reason)) continue;
    const { resolvedBy: _b, resolvedAt: _a, resolvedReason: _r, ...rest } = (n.data ?? {}) as Record<string, unknown>;
    await ctx.db.patch(n._id, { readAt: undefined, data: rest });
    reopened++;
  }
  return reopened;
}

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
    /** B2: teto menor de leitura no alvo conversa (caminhos que varrem várias conversas). */
    scanLimit?: number;
  }
): Promise<number> {
  const db = ctx.db;
  const t = args.target;
  let rows: Doc<"notifications">[];
  if ("conversationId" in t) {
    // Mais novas primeiro, em lotes, com teto: com muitas não lidas na conversa
    // (dono que só usa o Telegram) o aviso de rascunho é o MAIS RECENTE.
    rows = await scanConversationUnread(ctx, t.conversationId, {
      match: (n) =>
        (!args.memberId || n.memberId === args.memberId) && (!args.types || args.types.includes(n.type)),
      limit: args.scanLimit,
      memberId: args.memberId,
    });
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
 * Quem respondeu ao cliente (app, Telegram, REST/MCP) resolveu os PRÓPRIOS
 * `new_message` e `conversation_transferred` da conversa. Só remetente humano e
 * resposta de verdade (nota interna não conta). Chamar das portas de envio.
 */
export async function resolveRepliedNotifications(
  ctx: MutationCtx,
  args: {
    conversation: Pick<Doc<"conversations">, "_id" | "organizationId">;
    sender: Pick<Doc<"teamMembers">, "_id" | "type">;
    isInternal?: boolean;
  }
): Promise<number> {
  if (args.isInternal || args.sender.type === "ai") return 0;
  return resolveEntityNotifications(ctx, {
    organizationId: args.conversation.organizationId,
    target: { conversationId: args.conversation._id },
    memberId: args.sender._id,
    resolvedByMemberId: args.sender._id,
    reason: "replied",
    types: ["new_message", "conversation_transferred"],
  });
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
  // Uma leitura indexada pela chave de agrupamento do rascunho (a mesma de createNotification).
  const found = await ctx.db
    .query("notifications")
    .withIndex("by_member_and_coalesce_and_read", (q) =>
      q.eq("memberId", args.memberId).eq("coalesceKey", coalesceKeys.aiDraft(args.conversationId)).eq("readAt", undefined)
    )
    .first();
  if (!found) return false;
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

/**
 * B2 (review): o dono do lead mudou → avisos de mensagem nova/resposta sugerida
 * das conversas 1:1 do lead saem das não lidas do dono ANTERIOR. Exceção: a
 * conversa cujo `assignedTo` próprio continua sendo ele (o aviso segue quem
 * atende a conversa, `resolveRelayRecipient`). Teto de leitura para nunca
 * derrubar a atribuição: até LEAD_REASSIGN_MAX_CONVERSATIONS conversas e
 * LEAD_REASSIGN_SCAN não lidas por conversa (com o agrupamento do B2, o membro
 * tem no máximo ~2 não lidas desses tipos por conversa).
 */
export const LEAD_REASSIGN_MAX_CONVERSATIONS = 5;
export const LEAD_REASSIGN_SCAN = 200;

export async function resolveLeadReassignedNotifications(
  ctx: MutationCtx,
  args: {
    lead: Pick<Doc<"leads">, "_id" | "organizationId">;
    previousOwnerId: Id<"teamMembers"> | undefined;
    nextOwnerId: Id<"teamMembers"> | undefined;
    resolvedByMemberId?: Id<"teamMembers">;
  }
): Promise<number> {
  const prev = args.previousOwnerId;
  if (!prev || prev === args.nextOwnerId) return 0;
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.lead._id))
    .take(LEAD_REASSIGN_MAX_CONVERSATIONS);
  let total = 0;
  for (const c of conversations) {
    if (c.organizationId !== args.lead.organizationId || c.kind === "group") continue;
    if (c.assignedTo === prev) continue;
    total += await resolveEntityNotifications(ctx, {
      organizationId: args.lead.organizationId,
      target: { conversationId: c._id },
      memberId: prev,
      resolvedByMemberId: args.resolvedByMemberId,
      reason: "lead_reassigned",
      types: ["new_message", "ai_draft_pending"],
      scanLimit: LEAD_REASSIGN_SCAN,
    });
  }
  return total;
}
