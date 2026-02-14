import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { requireAuth } from "./lib/auth";

// Get boards for organization
export const getBoards = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    return await ctx.db
      .query("boards")
      .withIndex("by_organization_and_order", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// Get stages for board
export const getStages = query({
  args: { boardId: v.id("boards") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    await requireAuth(ctx, board.organizationId);

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
  returns: v.id("boards"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    if (!["admin", "manager"].includes(userMember.role)) {
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
  returns: v.id("stages"),
  handler: async (ctx, args) => {
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    const userMember = await requireAuth(ctx, board.organizationId);
    if (!["admin", "manager"].includes(userMember.role)) {
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

// Internal: Get boards for organization (used by HTTP API router)
export const internalGetBoards = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("boards")
      .withIndex("by_organization_and_order", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// Internal: Get stages for board (used by HTTP API router)
export const internalGetStages = internalQuery({
  args: { boardId: v.id("boards") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("stages")
      .withIndex("by_board_and_order", (q) => q.eq("boardId", args.boardId))
      .collect();
  },
});
