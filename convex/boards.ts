import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation, QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import {
  CASCADE_WRITE_BUDGET,
  actorTypeValidator,
  buildEntitySnapshot,
  cascadeContactRefs,
  cascadeLeadChildren,
  hardDeleteLead,
  newBudget,
  type CascadeActorType,
} from "./lib/leadCascade";

// Boards arquivados (archivedAt setado) continuam no banco mas somem de toda
// listagem de "pipelines ativos" e nunca são escolhidos como default/fallback.
function isActiveBoard(board: Doc<"boards">): boolean {
  return board.archivedAt === undefined;
}

async function loadOrgBoards(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">
): Promise<Doc<"boards">[]> {
  return await ctx.db
    .query("boards")
    .withIndex("by_organization_and_order", (q) => q.eq("organizationId", organizationId))
    .take(100);
}

// Promove o board ativo de menor `order` a padrão quando o default sai de cena.
async function promoteDefaultBoard(
  ctx: MutationCtx,
  boards: Doc<"boards">[],
  excludeBoardId: Id<"boards">,
  now: number
): Promise<Doc<"boards"> | null> {
  const candidates = boards
    .filter((b) => b._id !== excludeBoardId && isActiveBoard(b) && b.deletionStartedAt === undefined)
    .sort((a, b) => a.order - b.order);
  const promoted = candidates[0];
  if (!promoted) return null;
  if (!promoted.isDefault) {
    await ctx.db.patch(promoted._id, { isDefault: true, updatedAt: now });
  }
  return promoted;
}

async function requireBoardManager(ctx: MutationCtx, board: Doc<"boards">) {
  const userMember = await requireAuth(ctx, board.organizationId);
  if (!["admin", "manager"].includes(userMember.role)) {
    throw new Error("Not authorized");
  }
  return userMember;
}

// Get boards for organization
export const getBoards = query({
  args: {
    organizationId: v.id("organizations"),
    includeArchived: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const boards = await loadOrgBoards(ctx, args.organizationId);
    return args.includeArchived ? boards : boards.filter(isActiveBoard);
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
      isDefault: boards.filter(isActiveBoard).length === 0,
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
      description: buildAuditDescription({ action: "create", entityType: "board", metadata: { name: args.name } }),
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
      description: buildAuditDescription({ action: "create", entityType: "stage", metadata: { name: args.name, boardId: args.boardId } }),
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
      description: buildAuditDescription({ action: "update", entityType: "board", changes: { before: { name: board.name }, after: changes } }),
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Archive board (soft-delete: some das listagens, restaurável)
export const archiveBoard = mutation({
  args: { boardId: v.id("boards") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    const userMember = await requireBoardManager(ctx, board);

    if (!isActiveBoard(board)) throw new Error("Este pipeline já está arquivado.");

    const boards = await loadOrgBoards(ctx, board.organizationId);
    if (boards.filter(isActiveBoard).length <= 1) {
      throw new Error("Não é possível arquivar o último pipeline ativo.");
    }

    const now = Date.now();
    let promoted: Doc<"boards"> | null = null;
    if (board.isDefault) {
      promoted = await promoteDefaultBoard(ctx, boards, board._id, now);
    }

    await ctx.db.patch(args.boardId, {
      archivedAt: now,
      isDefault: promoted ? false : board.isDefault,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: board.organizationId,
      entityType: "board",
      entityId: args.boardId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: {
        before: { archivedAt: board.archivedAt, isDefault: board.isDefault },
        after: { archivedAt: now, isDefault: promoted ? false : board.isDefault },
      },
      metadata: {
        name: board.name,
        archived: true,
        promotedDefaultBoardId: promoted?._id,
        promotedDefaultName: promoted?.name,
      },
      description: `Arquivou o pipeline '${board.name}'`,
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Unarchive board
export const unarchiveBoard = mutation({
  args: { boardId: v.id("boards") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    const userMember = await requireBoardManager(ctx, board);

    if (isActiveBoard(board)) throw new Error("Este pipeline não está arquivado.");
    if (board.deletionStartedAt !== undefined) {
      throw new Error("Este pipeline está sendo excluído permanentemente.");
    }

    const now = Date.now();
    await ctx.db.patch(args.boardId, { archivedAt: undefined, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: board.organizationId,
      entityType: "board",
      entityId: args.boardId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: {
        before: { archivedAt: board.archivedAt },
        after: { archivedAt: undefined },
      },
      metadata: { name: board.name, archived: false },
      description: `Restaurou o pipeline '${board.name}'`,
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Prévia do estrago de excluir um pipeline (alimenta o modal de confirmação)
export const getBoardDeletionImpact = query({
  args: { boardId: v.id("boards") },
  returns: v.object({
    leadCount: v.number(),
    exclusiveContactCount: v.number(),
    capped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    const userMember = await requireAuth(ctx, board.organizationId);
    if (!["admin", "manager"].includes(userMember.role)) {
      throw new Error("Not authorized");
    }

    const leads = await ctx.db
      .query("leads")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .take(1001);
    const capped = leads.length > 1000;

    // Contatos exclusivos deste pipeline: varredura limitada (o modal só precisa
    // de uma ordem de grandeza — acima do teto o número vira piso e `capped`).
    const contactIds = [...new Set(leads.map((l) => l.contactId).filter(Boolean))] as Id<"contacts">[];
    const scanned = contactIds.slice(0, 300);
    let exclusiveContactCount = 0;
    for (const contactId of scanned) {
      const contactLeads = await ctx.db
        .query("leads")
        .withIndex("by_contact", (q) => q.eq("contactId", contactId))
        .take(20);
      if (contactLeads.every((l) => l.boardId === args.boardId)) exclusiveContactCount += 1;
    }

    return {
      leadCount: Math.min(leads.length, 1000),
      exclusiveContactCount,
      capped: capped || contactIds.length > scanned.length,
    };
  },
});

// Delete board — com leads só quando `deleteLeads` for explícito. A exclusão em
// si é diferida: o board é marcado (some da UI) e a cascata roda em lotes.
export const deleteBoard = mutation({
  args: {
    boardId: v.id("boards"),
    deleteLeads: v.optional(v.boolean()),
    deleteContacts: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const board = await ctx.db.get(args.boardId);
    if (!board) throw new Error("Board not found");

    const userMember = await requireBoardManager(ctx, board);

    if (board.deletionStartedAt !== undefined) {
      throw new Error("Este pipeline já está sendo excluído permanentemente.");
    }

    const boards = await loadOrgBoards(ctx, board.organizationId);
    if (isActiveBoard(board) && boards.filter(isActiveBoard).length <= 1) {
      throw new Error("Não é possível excluir o último pipeline ativo.");
    }

    const leads = await ctx.db
      .query("leads")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .take(1001);

    if (leads.length > 0 && args.deleteLeads !== true) {
      throw new Error("Não é possível excluir pipeline com leads. Mova ou exclua os leads primeiro.");
    }

    const now = Date.now();
    let promoted: Doc<"boards"> | null = null;
    if (board.isDefault) {
      promoted = await promoteDefaultBoard(ctx, boards, board._id, now);
    }

    await ctx.db.insert("auditLogs", {
      organizationId: board.organizationId,
      entityType: "board",
      entityId: args.boardId,
      action: "delete",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: buildEntitySnapshot(board) },
      metadata: {
        name: board.name,
        leadCount: Math.min(leads.length, 1000),
        leadCountCapped: leads.length > 1000,
        deleteLeads: args.deleteLeads === true,
        deleteContacts: args.deleteContacts === true,
        promotedDefaultBoardId: promoted?._id,
        promotedDefaultName: promoted?.name,
      },
      description: `Excluiu o pipeline '${board.name}'${leads.length > 0 ? ` e ${leads.length > 1000 ? "1000+" : leads.length} lead(s)` : ""}`,
      severity: "high",
      createdAt: now,
    });

    await ctx.db.patch(args.boardId, {
      archivedAt: board.archivedAt ?? now,
      deletionStartedAt: now,
      isDefault: false,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.boards.internalDeleteBoardCascade, {
      organizationId: board.organizationId,
      boardId: args.boardId,
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      deleteContacts: args.deleteContacts === true,
      pendingLeadIds: [],
      pendingContactIds: [],
    });

    return null;
  },
});

/**
 * Cascata da exclusão do pipeline: excluir cada lead pelo MESMO núcleo do
 * `deleteLead` (audit com snapshot + webhook), depois etapas e o board. Roda com
 * orçamento de escritas e se re-agenda até acabar — um job sequencial, não N.
 */
export const internalDeleteBoardCascade = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    boardId: v.id("boards"),
    actorId: v.optional(v.id("teamMembers")),
    actorType: actorTypeValidator,
    deleteContacts: v.optional(v.boolean()),
    pendingLeadIds: v.array(v.id("leads")),
    pendingContactIds: v.array(v.id("contacts")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const budget = newBudget(CASCADE_WRITE_BUDGET);
    const actorType = args.actorType as CascadeActorType;
    const pendingLeadIds: Id<"leads">[] = [];
    const pendingContactIds: Id<"contacts">[] = [];

    for (const leadId of args.pendingLeadIds) {
      if (budget.left <= 0 || !(await cascadeLeadChildren(ctx, leadId, budget))) {
        pendingLeadIds.push(leadId);
      }
    }
    for (const contactId of args.pendingContactIds) {
      if (budget.left <= 0 || !(await cascadeContactRefs(ctx, contactId, budget))) {
        pendingContactIds.push(contactId);
      }
    }

    while (budget.left > 0 && pendingLeadIds.length === 0 && pendingContactIds.length === 0) {
      const lead = await ctx.db
        .query("leads")
        .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
        .first();
      if (!lead) break;

      const { deletedContactId } = await hardDeleteLead(ctx, {
        lead,
        actorId: args.actorId,
        actorType,
        deleteContact: args.deleteContacts,
        extraMetadata: { viaBoardDeletion: true },
      });
      budget.left -= 2;

      if (!(await cascadeLeadChildren(ctx, lead._id, budget))) pendingLeadIds.push(lead._id);
      if (deletedContactId && !(await cascadeContactRefs(ctx, deletedContactId, budget))) {
        pendingContactIds.push(deletedContactId);
      }
    }

    const remainingLead = await ctx.db
      .query("leads")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .first();

    if (pendingLeadIds.length > 0 || pendingContactIds.length > 0 || remainingLead) {
      await ctx.scheduler.runAfter(0, internal.boards.internalDeleteBoardCascade, {
        organizationId: args.organizationId,
        boardId: args.boardId,
        actorId: args.actorId,
        actorType: args.actorType,
        deleteContacts: args.deleteContacts,
        pendingLeadIds,
        pendingContactIds,
      });
      return null;
    }

    const stages = await ctx.db
      .query("stages")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .take(Math.max(budget.left, 1));
    for (const stage of stages) {
      await ctx.db.delete(stage._id);
      budget.left -= 1;
    }

    const remainingStage = await ctx.db
      .query("stages")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .first();
    if (remainingStage) {
      await ctx.scheduler.runAfter(0, internal.boards.internalDeleteBoardCascade, {
        organizationId: args.organizationId,
        boardId: args.boardId,
        actorId: args.actorId,
        actorType: args.actorType,
        deleteContacts: args.deleteContacts,
        pendingLeadIds: [],
        pendingContactIds: [],
      });
      return null;
    }

    const board = await ctx.db.get(args.boardId);
    if (board) await ctx.db.delete(args.boardId);

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
      description: buildAuditDescription({ action: "update", entityType: "stage", changes: { before: { name: stage.name }, after: changes } }),
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
      description: buildAuditDescription({ action: "delete", entityType: "stage", metadata: { name: stage.name, boardId: stage.boardId } }),
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
  args: {
    organizationId: v.id("organizations"),
    includeArchived: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const boards = await loadOrgBoards(ctx, args.organizationId);
    return args.includeArchived ? boards : boards.filter(isActiveBoard);
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
      isDefault: boards.filter(isActiveBoard).length === 0,
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
      description: buildAuditDescription({ action: "create", entityType: "board", metadata: { name: args.name, stageCount: args.stages.length } }),
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
