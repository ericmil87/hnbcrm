import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
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
      .take(100);
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
      .take(100);
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
      .take(100);

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
      .take(100);

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

// Update board
export const updateBoard = mutation({
  args: {
    boardId: v.id("boards"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    const userMember = await requireAuth(ctx, board.organizationId);
    if (!["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    const now = Date.now();
    const changes: Record<string, any> = {};
    if (args.name !== undefined) changes.name = args.name;
    if (args.description !== undefined) changes.description = args.description;
    if (args.color !== undefined) changes.color = args.color;

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.boardId, { ...changes, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: board.organizationId,
      entityType: "board",
      entityId: args.boardId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before: { name: board.name }, after: changes },
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Delete board (blocked if leads exist)
export const deleteBoard = mutation({
  args: { boardId: v.id("boards") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    const userMember = await requireAuth(ctx, board.organizationId);
    if (!["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    // Check for leads in this board
    const leadInBoard = await ctx.db
      .query("leads")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .first();

    if (leadInBoard) {
      throw new Error("Não é possível excluir pipeline com leads. Mova ou exclua os leads primeiro.");
    }

    const now = Date.now();

    // Delete all stages in this board
    const stages = await ctx.db
      .query("stages")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .take(100);

    for (const stage of stages) {
      await ctx.db.delete(stage._id);
    }

    await ctx.db.insert("auditLogs", {
      organizationId: board.organizationId,
      entityType: "board",
      entityId: args.boardId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: board.name },
      severity: "high",
      createdAt: now,
    });

    await ctx.db.delete(args.boardId);

    return null;
  },
});

// Update stage
export const updateStage = mutation({
  args: {
    stageId: v.id("stages"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    isClosedWon: v.optional(v.boolean()),
    isClosedLost: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stage = await ctx.db.get(args.stageId);
    if (!stage) throw new Error("Stage not found");

    const userMember = await requireAuth(ctx, stage.organizationId);
    if (!["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    const now = Date.now();
    const changes: Record<string, any> = {};
    if (args.name !== undefined) changes.name = args.name;
    if (args.color !== undefined) changes.color = args.color;
    if (args.isClosedWon !== undefined) changes.isClosedWon = args.isClosedWon;
    if (args.isClosedLost !== undefined) changes.isClosedLost = args.isClosedLost;

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.stageId, { ...changes, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: stage.organizationId,
      entityType: "stage",
      entityId: args.stageId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before: { name: stage.name }, after: changes },
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Delete stage (blocked if leads exist)
export const deleteStage = mutation({
  args: { stageId: v.id("stages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stage = await ctx.db.get(args.stageId);
    if (!stage) throw new Error("Stage not found");

    const userMember = await requireAuth(ctx, stage.organizationId);
    if (!["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    // Check for leads in this stage
    const leadInStage = await ctx.db
      .query("leads")
      .withIndex("by_stage", (q) => q.eq("stageId", args.stageId))
      .first();

    if (leadInStage) {
      throw new Error("Não é possível excluir etapa com leads. Mova os leads primeiro.");
    }

    const now = Date.now();

    await ctx.db.insert("auditLogs", {
      organizationId: stage.organizationId,
      entityType: "stage",
      entityId: args.stageId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: stage.name, boardId: stage.boardId },
      severity: "high",
      createdAt: now,
    });

    await ctx.db.delete(args.stageId);

    return null;
  },
});

// Reorder stages within a board
export const reorderStages = mutation({
  args: {
    boardId: v.id("boards"),
    stageIds: v.array(v.id("stages")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    const userMember = await requireAuth(ctx, board.organizationId);
    if (!["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    const now = Date.now();

    for (let i = 0; i < args.stageIds.length; i++) {
      await ctx.db.patch(args.stageIds[i], { order: i, updatedAt: now });
    }

    return null;
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
      .take(100);
  },
});

// Create board with default stages in one mutation
export const createBoardWithStages = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    color: v.string(),
    stages: v.array(v.object({
      name: v.string(),
      color: v.string(),
      isClosedWon: v.optional(v.boolean()),
      isClosedLost: v.optional(v.boolean()),
    })),
  },
  returns: v.id("boards"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    if (!["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    const boards = await ctx.db
      .query("boards")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(100);

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

    // Create all stages
    for (let i = 0; i < args.stages.length; i++) {
      const stage = args.stages[i];
      await ctx.db.insert("stages", {
        organizationId: args.organizationId,
        boardId,
        name: stage.name,
        color: stage.color,
        order: i,
        isClosedWon: stage.isClosedWon || false,
        isClosedLost: stage.isClosedLost || false,
        createdAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "board",
      entityId: boardId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { name: args.name, stageCount: args.stages.length },
      severity: "medium",
      createdAt: now,
    });

    return boardId;
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
      .take(100);
  },
});
