import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";
import { parseCursor, buildCursorFromCreatedAt, paginateResults } from "./lib/cursor";
// Núcleo único do comentário (insert + activity + webhook + menções). Mora em
// lib/ porque o follow-up da IA também comenta na tarefa que concluiu.
import { addTaskCommentCore } from "./lib/taskOps";

// Get comments for a task
export const getComments = query({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return [];

    await requireAuth(ctx, task.organizationId);

    const comments = await ctx.db
      .query("taskComments")
      .withIndex("by_task_and_created", (q) => q.eq("taskId", args.taskId))
      .take(500);

    const authorMap = await batchGet(ctx.db, comments.map(c => c.authorId));

    return comments.map(comment => ({
      ...comment,
      author: authorMap.get(comment.authorId) ?? null,
    }));
  },
});

// Add comment
export const addComment = mutation({
  args: {
    taskId: v.id("tasks"),
    content: v.string(),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
  },
  returns: v.id("taskComments"),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");

    const userMember = await requireAuth(ctx, task.organizationId);

    // Núcleo único: insert + activity + webhook + menções (in-app e e-mail).
    return await addTaskCommentCore(ctx, {
      task,
      author: userMember,
      content: args.content,
      mentionedUserIds: args.mentionedUserIds,
    });
  },
});

// Update comment (author only)
export const updateComment = mutation({
  args: {
    commentId: v.id("taskComments"),
    content: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.commentId);
    if (!comment) throw new Error("Comment not found");

    const userMember = await requireAuth(ctx, comment.organizationId);

    if (comment.authorId !== userMember._id) {
      throw new Error("Only the author can edit this comment");
    }

    await ctx.db.patch(args.commentId, {
      content: args.content,
      updatedAt: Date.now(),
    });

    return null;
  },
});

// Delete comment (author or admin)
export const deleteComment = mutation({
  args: { commentId: v.id("taskComments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.commentId);
    if (!comment) throw new Error("Comment not found");

    const userMember = await requireAuth(ctx, comment.organizationId);

    if (comment.authorId !== userMember._id && userMember.role !== "admin") {
      throw new Error("Only the author or an admin can delete this comment");
    }

    await ctx.db.delete(args.commentId);

    return null;
  },
});

// ===== Internal Functions (for HTTP API) =====

// Internal: Add comment
export const internalAddComment = internalMutation({
  args: {
    taskId: v.id("tasks"),
    content: v.string(),
    isInternal: v.optional(v.boolean()),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.id("taskComments"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    // O id da task vem cru do cliente da API: tem que ser da org de quem age
    const task = await ctx.db.get(args.taskId);
    if (!task || task.organizationId !== teamMember.organizationId) {
      throw new Error("Task not found");
    }

    return await addTaskCommentCore(ctx, {
      task,
      author: teamMember,
      content: args.content,
      mentionedUserIds: args.mentionedUserIds,
    });
  },
});

// Internal: Get comments (with cursor pagination)
export const internalGetComments = internalQuery({
  args: {
    taskId: v.id("tasks"),
    // Org da API key autenticada — sem isso uma key da Org A leria comentários da Org B
    organizationId: v.id("organizations"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || task.organizationId !== args.organizationId) {
      return { comments: [], nextCursor: null, hasMore: false };
    }
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);

    const rawComments = await ctx.db
      .query("taskComments")
      .withIndex("by_task_and_created", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(limit + 1 + (cursor ? limit * 3 : 0));

    let filtered = rawComments;
    if (cursor) {
      filtered = rawComments.filter(
        (c) =>
          c.createdAt < cursor.ts ||
          (c.createdAt === cursor.ts && c._id < cursor.id)
      );
    }

    const { items: comments, nextCursor, hasMore } = paginateResults(
      filtered, limit, buildCursorFromCreatedAt
    );

    const authorMap = await batchGet(ctx.db, comments.map(c => c.authorId));

    const commentsWithAuthors = comments.map(comment => ({
      ...comment,
      author: authorMap.get(comment.authorId) ?? null,
    }));

    return { comments: commentsWithAuthors, nextCursor, hasMore };
  },
});
