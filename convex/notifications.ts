import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import { requireAuth } from "./lib/auth";

// ===== Queries =====

// Feed do sino, mais recentes primeiro (paginado)
export const list = query({
  args: {
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    return await ctx.db
      .query("notifications")
      .withIndex("by_member_and_created", (q) => q.eq("memberId", member._id))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// Contador de não lidas (badge do sino)
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
      .take(100);
    return unread.length;
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

export const markAllRead = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_member_and_read", (q) =>
        q.eq("memberId", member._id).eq("readAt", undefined)
      )
      .take(500);
    const now = Date.now();
    for (const n of unread) {
      await ctx.db.patch(n._id, { readAt: now });
    }
    return null;
  },
});
