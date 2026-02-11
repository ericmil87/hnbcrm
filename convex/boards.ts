import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Get boards for organization
export const getBoards = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    return await ctx.db
      .query("boards")
      .withIndex("by_organization_and_order", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// Get stages for board
export const getStages = query({
  args: { boardId: v.id("boards") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    // Verify user is part of organization
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", board.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember) throw new Error("Not authorized");

    return await ctx.db
      .query("stages")
      .withIndex("by_board_and_order", (q) => q.eq("boardId", args.boardId))
      .collect();
  },
});

// Create board
export const createBoard = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    color: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Verify user is admin or manager
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember || !["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    // Get next order
    const boards = await ctx.db
      .query("boards")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    
    const maxOrder = Math.max(...boards.map(b => b.order), -1);
    const now = Date.now();

    const boardId = await ctx.db.insert("boards", {
      organizationId: args.organizationId,
      name: args.name,
      description: args.description,
      color: args.color,
      isDefault: boards.length === 0,
      order: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "board",
      entityId: boardId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name },
      severity: "medium",
      createdAt: now,
    });

    return boardId;
  },
});

// Create stage
export const createStage = mutation({
  args: {
    boardId: v.id("boards"),
    name: v.string(),
    color: v.string(),
    isClosedWon: v.optional(v.boolean()),
    isClosedLost: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    // Verify user is admin or manager
    const userMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization", (q) => q.eq("organizationId", board.organizationId))
      .filter((q) => q.eq(q.field("userId"), userId))
      .first();

    if (!userMember || !["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    // Get next order
    const stages = await ctx.db
      .query("stages")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .collect();
    
    const maxOrder = Math.max(...stages.map(s => s.order), -1);
    const now = Date.now();

    const stageId = await ctx.db.insert("stages", {
      organizationId: board.organizationId,
      boardId: args.boardId,
      name: args.name,
      color: args.color,
      order: maxOrder + 1,
      isClosedWon: args.isClosedWon || false,
      isClosedLost: args.isClosedLost || false,
      createdAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: board.organizationId,
      entityType: "stage",
      entityId: stageId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name, boardId: args.boardId },
      severity: "medium",
      createdAt: now,
    });

    return stageId;
  },
});
