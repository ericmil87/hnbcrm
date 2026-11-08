import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth, isMembershipRevoked } from "./lib/auth";
import { groupOfType, typesOfGroup } from "./lib/notificationGroups";
import type { NotificationGroup } from "./lib/notificationGroups";

const groupValidator = v.union(
  v.literal("atendimento"),
  v.literal("tarefas"),
  v.literal("grupos"),
  v.literal("campanhas"),
  v.literal("sistema")
);

/** Lote de `markAllRead` (uma transação); com mais, a mutation se reagenda. */
export const MARK_ALL_READ_BATCH = 200;
/** Teto de não lidas contadas pelo badge (a UI mostra "99+"). */
export const UNREAD_COUNT_CAP = 100;

// ===== Queries =====

/**
 * Feed do sino, mais recentes primeiro (paginado). Args novos opcionais (cliente
 * anterior segue válido): `unreadOnly` lê o índice de não lidas; `group` filtra
 * por grupo do tipo SOBRE A PÁGINA (não há índice por grupo) — uma página pode
 * vir curta/vazia com `isDone:false`; o front continua pedindo até `isDone`.
 * Cada item ganha campos derivados (aditivos): `group`, `leadId` (de `data.leadId`)
 * e `resolvedByName` (quem resolveu, resolvido no servidor, só da mesma org).
 */
export const list = query({
  args: {
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    unreadOnly: v.optional(v.boolean()),
    group: v.optional(groupValidator),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const base = ctx.db.query("notifications");
    const result = await (args.unreadOnly === true
      ? base.withIndex("by_member_and_read", (q) => q.eq("memberId", member._id).eq("readAt", undefined))
      : base.withIndex("by_member_and_created", (q) => q.eq("memberId", member._id))
    )
      .order("desc")
      .paginate(args.paginationOpts);
    const groupTypes = args.group ? new Set(typesOfGroup(args.group)) : null;
    const rows = groupTypes ? result.page.filter((n) => groupTypes.has(n.type)) : result.page;
    return { ...result, page: await enrichForInbox(ctx, member, rows) };
  },
});

async function enrichForInbox(ctx: QueryCtx, member: Doc<"teamMembers">, rows: Doc<"notifications">[]) {
  const names = new Map<string, string | null>();
  for (const n of rows) {
    const rb = n.data?.resolvedBy;
    if (typeof rb !== "string" || names.has(rb)) continue;
    const id = ctx.db.normalizeId("teamMembers", rb);
    const doc = id ? await ctx.db.get(id) : null;
    // Só o nome, e só de gente da mesma org.
    names.set(rb, doc && doc.organizationId === member.organizationId ? doc.name : null);
  }
  return rows.map((n) => {
    const rb = n.data?.resolvedBy;
    const rawLead = n.data?.leadId;
    const leadId = typeof rawLead === "string" ? ctx.db.normalizeId("leads", rawLead) : null;
    return {
      ...n,
      group: groupOfType(n.type),
      leadId,
      resolvedByName: typeof rb === "string" ? names.get(rb) ?? null : null,
    };
  });
}

// Contador de não lidas (badge do sino) — mantido para o cliente anterior.
export const unreadCount = query({
  args: { organizationId: v.id("organizations") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_member_and_read", (q) =>
        q.eq("memberId", member._id).eq("readAt", undefined)
      )
      .take(UNREAD_COUNT_CAP);
    return unread.length;
  },
});

async function summaryFor(ctx: QueryCtx, memberId: Id<"teamMembers">) {
  const [unread, seen] = await Promise.all([
    ctx.db
      .query("notifications")
      .withIndex("by_member_and_read", (q) => q.eq("memberId", memberId).eq("readAt", undefined))
      .take(UNREAD_COUNT_CAP),
    ctx.db.query("notificationSeen").withIndex("by_member", (q) => q.eq("memberId", memberId)).first(),
  ]);
  const seenAt = seen?.seenAt ?? null;
  const unseen = seenAt === null ? unread.length : unread.filter((n) => n.createdAt > seenAt).length;
  return { unread: unread.length, unseen, seenAt };
}

/**
 * Badge do sino: não lidas (teto 100) e "novas desde o último visto" (`markSeen`).
 * `unseen` ⊆ `unread`; um aviso agrupado que recebeu mensagem nova (createdAt
 * renovado) volta a contar como novo.
 */
export const unreadSummary = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ unread: v.number(), unseen: v.number(), seenAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    return await summaryFor(ctx, member._id);
  },
});

/**
 * Seletor de org: uma contagem por vínculo ATIVO do usuário (sem org no
 * argumento — como `getUserOrganizations`). Só devolve id/nome da org (que o
 * usuário já vê no seletor) e as contagens das PRÓPRIAS notificações.
 */
export const unreadCountsByUser = query({
  args: {},
  returns: v.array(
    v.object({
      organizationId: v.id("organizations"),
      organizationName: v.string(),
      unread: v.number(),
      unseen: v.number(),
    })
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const memberships = await ctx.db.query("teamMembers").withIndex("by_user", (q) => q.eq("userId", userId)).take(50);
    const out: { organizationId: Id<"organizations">; organizationName: string; unread: number; unseen: number }[] = [];
    const seen = new Set<string>();
    for (const m of memberships) {
      if (isMembershipRevoked(m) || seen.has(m.organizationId)) continue;
      seen.add(m.organizationId);
      const org = await ctx.db.get(m.organizationId);
      if (!org) continue;
      const sum = await summaryFor(ctx, m._id);
      out.push({ organizationId: org._id, organizationName: org.name, unread: sum.unread, unseen: sum.unseen });
    }
    return out;
  },
});

// ===== Mutations =====

export const markRead = mutation({
  args: {
    organizationId: v.id("organizations"),
    notificationId: v.id("notifications"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.memberId !== member._id) {
      throw new Error("Notificação não encontrada");
    }
    if (!notification.readAt) {
      await ctx.db.patch(args.notificationId, { readAt: Date.now() });
    }
    return null;
  },
});

/**
 * Devolve uma notificação do próprio membro a "não lida". Item já RESOLVIDO
 * (`data.resolvedReason`/`resolvedBy`: outra pessoa assumiu, tarefa concluída,
 * canal reconectado) não volta: viraria pendência falsa. Retorna `true` quando
 * reabriu; `false` se já estava não lida ou está resolvida.
 */
export const markUnread = mutation({
  args: { organizationId: v.id("organizations"), notificationId: v.id("notifications") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification || notification.memberId !== member._id) {
      throw new Error("Notificação não encontrada");
    }
    if (notification.readAt === undefined) return false;
    if (notification.data?.resolvedReason !== undefined || notification.data?.resolvedBy !== undefined) return false;
    await ctx.db.patch(args.notificationId, { readAt: undefined });
    return true;
  },
});

async function markBatch(
  ctx: MutationCtx,
  memberId: Id<"teamMembers">,
  group: NotificationGroup | undefined,
  cutoff: number
) {
  // Cursor por `_creationTime` (campo final implícito do índice): linhas já
  // lidas saem do índice; as de outro grupo ficam e o cursor anda por cima delas.
  const rows = await ctx.db
    .query("notifications")
    .withIndex("by_member_and_read", (q) =>
      q.eq("memberId", memberId).eq("readAt", undefined).lt("_creationTime", cutoff)
    )
    .order("desc")
    .take(MARK_ALL_READ_BATCH);
  const types = group ? new Set(typesOfGroup(group)) : null;
  const now = Date.now();
  for (const n of rows) {
    if (types && !types.has(n.type)) continue;
    await ctx.db.patch(n._id, { readAt: now });
  }
  if (rows.length === MARK_ALL_READ_BATCH) {
    await ctx.scheduler.runAfter(0, internal.notifications.internalMarkAllReadBatch, {
      memberId,
      group,
      cutoff: rows[rows.length - 1]._creationTime,
    });
  }
}

/**
 * Marca como lidas todas as não lidas do membro (opcionalmente só de um grupo),
 * em lotes: o primeiro roda aqui, o resto se reagenda por cursor até acabar.
 * Só vale o que existia no clique (corte `_creationTime`): o que chega depois
 * continua não lido.
 */
export const markAllRead = mutation({
  args: { organizationId: v.id("organizations"), group: v.optional(groupValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    await markBatch(ctx, member._id, args.group, Date.now() + 1);
    return null;
  },
});

export const internalMarkAllReadBatch = internalMutation({
  args: { memberId: v.id("teamMembers"), group: v.optional(groupValidator), cutoff: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.memberId);
    if (!member || isMembershipRevoked(member)) return null;
    await markBatch(ctx, args.memberId, args.group, args.cutoff);
    return null;
  },
});

/** "Visto" do sino: o badge passa a contar só o que chegar depois deste instante. */
export const markSeen = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const now = Date.now();
    const row = await ctx.db
      .query("notificationSeen")
      .withIndex("by_member", (q) => q.eq("memberId", member._id))
      .first();
    if (row) await ctx.db.patch(row._id, { seenAt: now });
    else await ctx.db.insert("notificationSeen", { organizationId: args.organizationId, memberId: member._id, seenAt: now });
    return null;
  },
});
