import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";
import { createNotification, filterMembersOfOrg } from "./lib/notify";
import { parseCursor, buildCursorFromCreatedAt, paginateResults } from "./lib/cursor";

const MENTION_EXCERPT_LENGTH = 240;

function excerpt(content: string): string {
  const clean = content.trim();
  return clean.length > MENTION_EXCERPT_LENGTH
    ? `${clean.slice(0, MENTION_EXCERPT_LENGTH)}…`
    : clean;
}

// Menção em comentário: in-app + e-mail para cada mencionado (menos o autor).
async function notifyMentions(
  ctx: MutationCtx,
  opts: {
    task: Doc<"tasks">;
    commentId: Id<"taskComments">;
    content: string;
    mentionedUserIds?: Id<"teamMembers">[];
    author: Doc<"teamMembers">;
  }
): Promise<void> {
  const requested = [...new Set(opts.mentionedUserIds ?? [])].filter(
    (id) => id !== opts.author._id
  );
  if (requested.length === 0) return;

  // Os ids vêm do cliente: só notifica membros da org DA TASK (o e-mail não tem
  // gate de org em dispatchNotification — a barreira precisa ser aqui).
  const mentioned = await filterMembersOfOrg(ctx, opts.task.organizationId, requested);
  if (mentioned.length === 0) return;

  const snippet = excerpt(opts.content);
  const url = `${process.env.APP_URL ?? "https://app.hnbcrm.com.br"}/app/tarefas?task=${opts.task._id}`;

  for (const memberId of mentioned) {
    await createNotification(ctx, {
      organizationId: opts.task.organizationId,
      memberId,
      type: "task_comment_mention",
      title: `${opts.author.name} mencionou você em um comentário`,
      body: `${opts.task.title}: ${snippet}`,
      taskId: opts.task._id,
      actorId: opts.author._id,
    });

    await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
      organizationId: opts.task.organizationId,
      recipientMemberId: memberId,
      eventType: "taskCommentMention",
      templateData: {
        authorName: opts.author.name,
        taskTitle: opts.task.title,
        taskId: opts.task._id,
        commentExcerpt: snippet,
        taskUrl: url,
      },
    });
  }
}

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

    const now = Date.now();

    const commentId = await ctx.db.insert("taskComments", {
      organizationId: task.organizationId,
      taskId: args.taskId,
      authorId: userMember._id,
      authorType: userMember.type === "ai" ? "ai" : "human",
      content: args.content,
      mentionedUserIds: args.mentionedUserIds,
      createdAt: now,
      updatedAt: now,
    });

    // Log activity if task is linked to a lead
    if (task.leadId) {
      await ctx.db.insert("activities", {
        organizationId: task.organizationId,
        leadId: task.leadId,
        type: "note",
        actorId: userMember._id,
        actorType: userMember.type === "ai" ? "ai" : "human",
        content: `Comment added on task "${task.title}"`,
        metadata: { taskId: args.taskId, commentId },
        createdAt: now,
      });
    }

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.comment_added",
      payload: { taskId: args.taskId, commentId, content: args.content },
    });

    // Menções: in-app + e-mail
    await notifyMentions(ctx, {
      task,
      commentId,
      content: args.content,
      mentionedUserIds: args.mentionedUserIds,
      author: userMember,
    });

    return commentId;
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

    const now = Date.now();

    const commentId = await ctx.db.insert("taskComments", {
      organizationId: task.organizationId,
      taskId: args.taskId,
      authorId: teamMember._id,
      authorType: teamMember.type === "ai" ? "ai" : "human",
      content: args.content,
      mentionedUserIds: args.mentionedUserIds,
      createdAt: now,
      updatedAt: now,
    });

    if (task.leadId) {
      await ctx.db.insert("activities", {
        organizationId: task.organizationId,
        leadId: task.leadId,
        type: "note",
        actorId: teamMember._id,
        actorType: teamMember.type === "ai" ? "ai" : "human",
        content: `Comment added on task "${task.title}"`,
        metadata: { taskId: args.taskId, commentId },
        createdAt: now,
      });
    }

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: task.organizationId,
      event: "task.comment_added",
      payload: { taskId: args.taskId, commentId, content: args.content },
    });

    await notifyMentions(ctx, {
      task,
      commentId,
      content: args.content,
      mentionedUserIds: args.mentionedUserIds,
      author: teamMember,
    });

    return commentId;
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
