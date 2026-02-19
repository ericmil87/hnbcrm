import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAuth, requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";

// Helper: generate a short random ID (8 chars)
function generateFieldId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// Helper: generate slug from name
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9\s-]/g, "") // remove special chars
    .replace(/\s+/g, "-") // spaces to hyphens
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-|-$/g, "") // trim leading/trailing hyphens
    .slice(0, 60);
}

// Get all forms for organization
export const getForms = query({
  args: {
    organizationId: v.id("organizations"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");

    const forms = await ctx.db
      .query("forms")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    return forms;
  },
});

// Get single form by ID
export const getForm = query({
  args: {
    formId: v.id("forms"),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) return null;

    await requireAuth(ctx, form.organizationId);

    return form;
  },
});

// Create form
export const createForm = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
  },
  returns: v.id("forms"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "settings", "manage");

    const now = Date.now();

    // Generate slug from name
    let baseSlug = slugify(args.name);
    if (!baseSlug) baseSlug = "formulario";

    // Check slug uniqueness
    let slug = baseSlug;
    let counter = 1;
    while (true) {
      const existing = await ctx.db
        .query("forms")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      if (!existing) break;
      counter++;
      slug = `${baseSlug}-${counter}`;
    }

    // Default fields
    const fields = [
      {
        id: generateFieldId(),
        type: "text" as const,
        label: "Nome",
        isRequired: true,
        width: "full" as const,
        crmMapping: { entity: "contact" as const, field: "firstName" },
      },
      {
        id: generateFieldId(),
        type: "email" as const,
        label: "Email",
        isRequired: true,
        width: "full" as const,
        crmMapping: { entity: "contact" as const, field: "email" },
      },
      {
        id: generateFieldId(),
        type: "textarea" as const,
        label: "Mensagem",
        isRequired: false,
        width: "full" as const,
      },
    ];

    const formId = await ctx.db.insert("forms", {
      organizationId: args.organizationId,
      name: args.name,
      slug,
      status: "draft",
      fields,
      theme: {
        primaryColor: "#EA580C",
        backgroundColor: "#18181B",
        textColor: "#FAFAFA",
        borderRadius: "md",
        showBranding: true,
      },
      settings: {
        submitButtonText: "Enviar",
        successMessage: "Obrigado! Recebemos sua mensagem.",
        leadTitle: "Formulario - {email}",
        assignmentMode: "none",
        defaultPriority: "medium",
        defaultTemperature: "warm",
        tags: ["formulario"],
        honeypotEnabled: true,
        notifyOnSubmission: false,
      },
      createdBy: userMember._id,
      submissionCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "form",
      entityId: formId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { name: args.name, slug },
      description: buildAuditDescription({ action: "create", entityType: "form", metadata: { name: args.name } }),
      severity: "medium",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "form.created",
      payload: { formId, name: args.name, slug },
    });

    return formId;
  },
});

// Update form
export const updateForm = mutation({
  args: {
    formId: v.id("forms"),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    description: v.optional(v.string()),
    fields: v.optional(v.array(v.any())),
    theme: v.optional(v.any()),
    settings: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) throw new Error("Form not found");

    const userMember = await requireAuth(ctx, form.organizationId);

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.name !== undefined && args.name !== form.name) {
      changes.name = args.name;
      before.name = form.name;
    }

    if (args.slug !== undefined && args.slug !== form.slug) {
      // Check slug uniqueness
      const existing = await ctx.db
        .query("forms")
        .withIndex("by_slug", (q) => q.eq("slug", args.slug!))
        .first();
      if (existing && existing._id !== args.formId) {
        throw new Error("Slug already in use");
      }
      changes.slug = args.slug;
      before.slug = form.slug;
    }

    if (args.description !== undefined) {
      changes.description = args.description;
      before.description = form.description;
    }
    if (args.fields !== undefined) {
      changes.fields = args.fields;
      before.fields = form.fields;
    }
    if (args.theme !== undefined) {
      changes.theme = args.theme;
      before.theme = form.theme;
    }
    if (args.settings !== undefined) {
      changes.settings = args.settings;
      before.settings = form.settings;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.formId, {
      ...changes,
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: form.organizationId,
      entityType: "form",
      entityId: args.formId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before, after: changes },
      metadata: { name: form.name },
      description: buildAuditDescription({ action: "update", entityType: "form", metadata: { name: form.name }, changes: { before, after: changes } }),
      severity: "low",
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: form.organizationId,
      event: "form.updated",
      payload: { formId: args.formId, changes },
    });

    return null;
  },
});

// Publish form
export const publishForm = mutation({
  args: {
    formId: v.id("forms"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) throw new Error("Form not found");

    const userMember = await requirePermission(ctx, form.organizationId, "settings", "manage");

    if (form.fields.length === 0) {
      throw new Error("Form must have at least 1 field to publish");
    }

    const now = Date.now();

    await ctx.db.patch(args.formId, {
      status: "published",
      publishedAt: now,
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: form.organizationId,
      entityType: "form",
      entityId: args.formId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: form.status }, after: { status: "published" } },
      metadata: { name: form.name },
      description: buildAuditDescription({ action: "update", entityType: "form", metadata: { name: form.name }, changes: { before: { status: form.status }, after: { status: "published" } } }),
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Unpublish form
export const unpublishForm = mutation({
  args: {
    formId: v.id("forms"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) throw new Error("Form not found");

    const userMember = await requireAuth(ctx, form.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.formId, {
      status: "draft",
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: form.organizationId,
      entityType: "form",
      entityId: args.formId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: form.status }, after: { status: "draft" } },
      metadata: { name: form.name },
      description: buildAuditDescription({ action: "update", entityType: "form", metadata: { name: form.name }, changes: { before: { status: form.status }, after: { status: "draft" } } }),
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Archive form
export const archiveForm = mutation({
  args: {
    formId: v.id("forms"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) throw new Error("Form not found");

    const userMember = await requireAuth(ctx, form.organizationId);

    const now = Date.now();

    await ctx.db.patch(args.formId, {
      status: "archived",
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: form.organizationId,
      entityType: "form",
      entityId: args.formId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: form.status }, after: { status: "archived" } },
      metadata: { name: form.name },
      description: buildAuditDescription({ action: "update", entityType: "form", metadata: { name: form.name }, changes: { before: { status: form.status }, after: { status: "archived" } } }),
      severity: "medium",
      createdAt: now,
    });

    return null;
  },
});

// Delete form
export const deleteForm = mutation({
  args: {
    formId: v.id("forms"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) throw new Error("Form not found");

    const userMember = await requirePermission(ctx, form.organizationId, "settings", "manage");

    const now = Date.now();

    // Audit log before deletion
    await ctx.db.insert("auditLogs", {
      organizationId: form.organizationId,
      entityType: "form",
      entityId: args.formId,
      action: "delete",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { name: form.name },
      description: buildAuditDescription({ action: "delete", entityType: "form", metadata: { name: form.name } }),
      severity: "high",
      createdAt: now,
    });

    // Delete all related submissions
    const submissions = await ctx.db
      .query("formSubmissions")
      .withIndex("by_form", (q) => q.eq("formId", args.formId))
      .collect();

    for (const submission of submissions) {
      await ctx.db.delete(submission._id);
    }

    await ctx.db.delete(args.formId);

    return null;
  },
});

// Duplicate form
export const duplicateForm = mutation({
  args: {
    formId: v.id("forms"),
  },
  returns: v.id("forms"),
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) throw new Error("Form not found");

    const userMember = await requirePermission(ctx, form.organizationId, "settings", "manage");

    const now = Date.now();

    // Generate new slug
    let baseSlug = `${form.slug}-copia`;
    let slug = baseSlug;
    let counter = 1;
    while (true) {
      const existing = await ctx.db
        .query("forms")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .first();
      if (!existing) break;
      counter++;
      slug = `${baseSlug}-${counter}`;
    }

    const newFormId = await ctx.db.insert("forms", {
      organizationId: form.organizationId,
      name: `${form.name} (copia)`,
      slug,
      description: form.description,
      status: "draft",
      fields: form.fields,
      theme: form.theme,
      settings: form.settings,
      createdBy: userMember._id,
      submissionCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: form.organizationId,
      entityType: "form",
      entityId: newFormId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { name: `${form.name} (copia)`, slug, duplicatedFrom: args.formId },
      description: buildAuditDescription({ action: "create", entityType: "form", metadata: { name: `${form.name} (copia)` } }),
      severity: "medium",
      createdAt: now,
    });

    return newFormId;
  },
});

// Check slug availability
export const checkSlugAvailability = query({
  args: {
    slug: v.string(),
    organizationId: v.id("organizations"),
  },
  returns: v.object({
    available: v.boolean(),
    suggestions: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const existing = await ctx.db
      .query("forms")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (!existing) {
      return { available: true, suggestions: [] };
    }

    // Generate suggestions
    const suggestions: string[] = [];
    for (let i = 2; i <= 4; i++) {
      const candidate = `${args.slug}-${i}`;
      const taken = await ctx.db
        .query("forms")
        .withIndex("by_slug", (q) => q.eq("slug", candidate))
        .first();
      if (!taken) {
        suggestions.push(candidate);
      }
    }

    return { available: false, suggestions };
  },
});

// Internal: Get published form by slug (no auth)
export const internalGetPublishedForm = internalQuery({
  args: {
    slug: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const form = await ctx.db
      .query("forms")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (!form || form.status !== "published") return null;

    return form;
  },
});
