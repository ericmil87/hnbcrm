/**
 * File Storage
 *
 * Convex file storage with upload URLs, metadata management, and access control.
 */

import { v } from "convex/values";
import {
  computeStorageUsageFromFiles,
  deleteFileRow,
  insertFileRow,
} from "./lib/storageUsage";
import { internal } from "./_generated/api";
import { mutation, query, internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { requireAuth, requirePermission } from "./lib/auth";
import { validateFileUpload } from "./lib/fileValidation";
import { checkUploadQuota } from "./lib/fileQuotas";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";
import { Id } from "./_generated/dataModel";

/**
 * Generate upload URL for file storage
 *
 * Client flow:
 * 1. Call this to get presigned URL
 * 2. POST file to URL
 * 3. Extract storageId from response
 * 4. Call saveFile() with metadata
 */
export const generateUploadUrl = mutation({
  args: {
    organizationId: v.id("organizations"),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    // Auth: Requires at least edit_own permission for leads
    await requirePermission(ctx, args.organizationId, "leads", "edit_own");

    // Generate upload URL
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Save file metadata after upload
 *
 * Call this after uploading file to storage URL
 */
export const saveFile = mutation({
  args: {
    organizationId: v.id("organizations"),
    storageId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    fileType: v.union(
      v.literal("message_attachment"),
      v.literal("contact_photo"),
      v.literal("member_avatar"),
      v.literal("lead_document"),
      v.literal("import_file"),
      v.literal("other")
    ),
    // Relations (optional, at most one should be set)
    messageId: v.optional(v.id("messages")),
    contactId: v.optional(v.id("contacts")),
    leadId: v.optional(v.id("leads")),
    teamMemberId: v.optional(v.id("teamMembers")),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    // Auth
    const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");

    // Validate file
    validateFileUpload({
      mimeType: args.mimeType,
      size: args.size,
      name: args.name,
    });

    // Check quota
    await checkUploadQuota(ctx, {
      organizationId: args.organizationId,
      fileSize: args.size,
    });

    // Insert file record
    const fileId = await insertFileRow(ctx, {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      fileType: args.fileType,
      messageId: args.messageId,
      contactId: args.contactId,
      leadId: args.leadId,
      teamMemberId: args.teamMemberId,
      uploadedBy: userMember._id,
      metadata: args.metadata,
      createdAt: Date.now(),
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "file",
      entityId: fileId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: {
        after: {
          name: args.name,
          size: args.size,
          fileType: args.fileType,
        },
      },
      description: `Arquivo enviado: ${args.name}`,
      severity: "low",
      createdAt: Date.now(),
    });

    return fileId;
  },
});

/**
 * Get file download URL
 *
 * Returns null if file not found or access denied
 */
export const getFileUrl = query({
  args: {
    fileId: v.id("files"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (!file) return null;

    // Auth: User must be in the same organization
    try {
      await requireAuth(ctx, file.organizationId);
    } catch {
      return null;
    }

    // Get URL from storage
    const url = await ctx.storage.getUrl(file.storageId);
    return url;
  },
});

/**
 * Delete file and its metadata
 */
export const deleteFile = mutation({
  args: {
    fileId: v.id("files"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (!file) {
      throw new Error("Arquivo não encontrado");
    }

    // Auth: Requires edit permission
    const userMember = await requirePermission(ctx, file.organizationId, "leads", "edit_own");

    // Delete from storage — só quando nenhuma outra linha de `files` compartilha
    // o blob (mensagem encaminhada duplica a linha, não o blob).
    await deleteBlobIfUnreferenced(ctx, file);

    // Delete metadata
    await deleteFileRow(ctx, file);

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: file.organizationId,
      entityType: "file",
      entityId: args.fileId,
      action: "delete",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: {
        before: {
          name: file.name,
          size: file.size,
          fileType: file.fileType,
        },
      },
      description: `Arquivo removido: ${file.name}`,
      severity: "medium",
      createdAt: Date.now(),
    });

    return null;
  },
});

/**
 * Get lead documents (join leadDocuments with files)
 */
export const getLeadDocuments = query({
  args: {
    leadId: v.id("leads"),
  },
  returns: v.array(
    v.object({
      documentId: v.id("leadDocuments"),
      fileId: v.id("files"),
      title: v.optional(v.string()),
      category: v.optional(v.union(
        v.literal("contract"),
        v.literal("proposal"),
        v.literal("invoice"),
        v.literal("other")
      )),
      name: v.string(),
      mimeType: v.string(),
      size: v.number(),
      url: v.union(v.string(), v.null()),
      uploadedBy: v.id("teamMembers"),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    // Get lead to verify org
    const lead = await ctx.db.get(args.leadId);
    if (!lead) return [];

    // Auth
    await requireAuth(ctx, lead.organizationId);

    // Get lead documents
    const documents = await ctx.db
      .query("leadDocuments")
      .withIndex("by_lead", (q) => q.eq("leadId", args.leadId))
      .collect();

    // Fetch files and generate URLs
    const results = await Promise.all(
      documents.map(async (doc) => {
        const file = await ctx.db.get(doc.fileId);
        if (!file) return null;

        const url = await ctx.storage.getUrl(file.storageId);

        return {
          documentId: doc._id,
          fileId: file._id,
          title: doc.title,
          category: doc.category,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          url,
          uploadedBy: doc.uploadedBy,
          createdAt: doc.createdAt,
        };
      })
    );

    return results.filter((r) => r !== null) as any;
  },
});

/**
 * Get file metadata by ID
 */
export const getFile = query({
  args: {
    fileId: v.id("files"),
  },
  returns: v.union(
    v.object({
      _id: v.id("files"),
      organizationId: v.id("organizations"),
      name: v.string(),
      mimeType: v.string(),
      size: v.number(),
      fileType: v.union(
        v.literal("message_attachment"),
        v.literal("contact_photo"),
        v.literal("member_avatar"),
        v.literal("lead_document"),
        v.literal("import_file"),
        v.literal("other")
      ),
      uploadedBy: v.optional(v.id("teamMembers")),
      createdAt: v.number(),
      url: v.union(v.string(), v.null()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (!file) return null;

    // Auth
    try {
      await requireAuth(ctx, file.organizationId);
    } catch {
      return null;
    }

    const url = await ctx.storage.getUrl(file.storageId);

    return {
      _id: file._id,
      organizationId: file.organizationId,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      fileType: file.fileType,
      uploadedBy: file.uploadedBy,
      createdAt: file.createdAt,
      url,
    };
  },
});

// ============================================================================
// Internal Functions (for HTTP API)
// ============================================================================

export const internalGenerateUploadUrl = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.string(),
  handler: async (ctx, _args) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const internalSaveFile = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    storageId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    fileType: v.union(
      v.literal("message_attachment"),
      v.literal("contact_photo"),
      v.literal("member_avatar"),
      v.literal("lead_document"),
      v.literal("import_file"),
      v.literal("other")
    ),
    messageId: v.optional(v.id("messages")),
    contactId: v.optional(v.id("contacts")),
    leadId: v.optional(v.id("leads")),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    // Validate file
    validateFileUpload({
      mimeType: args.mimeType,
      size: args.size,
      name: args.name,
    });

    // Check quota
    await checkUploadQuota(ctx, {
      organizationId: args.organizationId,
      fileSize: args.size,
    });

    // Insert file record
    const fileId = await insertFileRow(ctx, {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: args.name,
      mimeType: args.mimeType,
      size: args.size,
      fileType: args.fileType,
      messageId: args.messageId,
      contactId: args.contactId,
      leadId: args.leadId,
      uploadedBy: args.teamMemberId,
      metadata: args.metadata,
      createdAt: Date.now(),
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "file",
      entityId: fileId,
      action: "create",
      actorId: args.teamMemberId,
      actorType: "ai", // API calls are typically from AI agents
      changes: {
        after: {
          name: args.name,
          size: args.size,
          fileType: args.fileType,
        },
      },
      description: `Arquivo enviado via API: ${args.name}`,
      severity: "low",
      createdAt: Date.now(),
    });

    return fileId;
  },
});

export const internalGetFileUrl = internalQuery({
  args: {
    fileId: v.id("files"),
    organizationId: v.id("organizations"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (!file || file.organizationId !== args.organizationId) {
      return null;
    }

    const url = await ctx.storage.getUrl(file.storageId);
    return url;
  },
});

export const internalDeleteFile = internalMutation({
  args: {
    fileId: v.id("files"),
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (!file || file.organizationId !== args.organizationId) {
      throw new Error("Arquivo não encontrado");
    }

    // Delete from storage — ver `lib/fileRefs.ts`: blob compartilhado fica
    await deleteBlobIfUnreferenced(ctx, file);

    // Delete metadata
    await deleteFileRow(ctx, file);

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "file",
      entityId: args.fileId,
      action: "delete",
      actorId: args.teamMemberId,
      actorType: "ai",
      changes: {
        before: {
          name: file.name,
          size: file.size,
          fileType: file.fileType,
        },
      },
      description: `Arquivo removido via API: ${file.name}`,
      severity: "medium",
      createdAt: Date.now(),
    });

    return null;
  },
});

// ===== Contador agregado de armazenamento (perf Convex I/O, onda 2) =====

const REBUILD_ORGS_PER_PAGE = 20;

const rebuildRowValidator = v.object({
  organizationId: v.id("organizations"),
  before: v.union(v.null(), v.object({ bytes: v.number(), count: v.number() })),
  actual: v.object({ bytes: v.number(), count: v.number() }),
  changed: v.boolean(),
});

async function rebuildOrgUsage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  dryRun: boolean
) {
  const row = await ctx.db
    .query("orgStorageUsage")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
  const actual = await computeStorageUsageFromFiles(ctx, organizationId);
  const before = row ? { bytes: row.bytes, count: row.count } : null;
  const changed = !before || before.bytes !== actual.bytes || before.count !== actual.count;
  if (!dryRun && changed) {
    if (row) await ctx.db.patch(row._id, { ...actual, updatedAt: Date.now() });
    else await ctx.db.insert("orgStorageUsage", { organizationId, ...actual, updatedAt: Date.now() });
  }
  return { organizationId, before, actual, changed };
}

/**
 * Recalcula `orgStorageUsage` a partir de `files` (soma de `size` + nº de
 * linhas). Não é obrigatório: sem linha, a 1ª checagem de quota inicializa
 * sozinha. Serve para corrigir divergência e para pré-aquecer o contador.
 *
 * `organizationId` → só aquela org. Sem ele, varre `organizations` em páginas de
 * 20: dryRun devolve UMA página (e o cursor); o real grava e se reagenda.
 *
 *   npx convex run files:internalRebuildStorageUsage '{"dryRun":true}'
 */
export const internalRebuildStorageUsage = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    dryRun: v.boolean(),
    orgs: v.array(rebuildRowValidator),
    changedCount: v.number(),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    if (args.organizationId) {
      const r = await rebuildOrgUsage(ctx, args.organizationId, dryRun);
      return { dryRun, orgs: [r], changedCount: r.changed ? 1 : 0, continueCursor: null, isDone: true };
    }
    const page = await ctx.db
      .query("organizations")
      .paginate({ numItems: REBUILD_ORGS_PER_PAGE, cursor: args.cursor ?? null });
    const orgs = [];
    for (const org of page.page) orgs.push(await rebuildOrgUsage(ctx, org._id, dryRun));
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.files.internalRebuildStorageUsage, {
        dryRun: false,
        cursor: page.continueCursor,
      });
    }
    return {
      dryRun,
      orgs,
      changedCount: orgs.filter((o) => o.changed).length,
      continueCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});
