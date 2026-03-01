import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAuth } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { LAYOUT_FIELD_TYPES } from "./lib/formFieldTypes";

// ── Phase 6: Server-side validation helper ──

function validateSubmissionData(
  fields: any[],
  data: Record<string, any>,
  visibleFieldIds?: Set<string>
): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    // Skip layout fields
    if (LAYOUT_FIELD_TYPES.includes(field.type)) continue;
    // Skip hidden fields from required validation (they always have defaultValue)
    if (field.type === "hidden") continue;
    // Skip invisible fields (conditional logic)
    if (visibleFieldIds && !visibleFieldIds.has(field.id)) continue;

    const value = data[field.id];
    const trimmed = typeof value === "string" ? value.trim() : "";
    const isEmpty = field.type === "checkbox" ? value !== "true" : trimmed === "";

    if (field.isRequired && isEmpty) {
      errors[field.id] = "Campo obrigatório";
      continue;
    }

    if (!isEmpty && trimmed) {
      if (field.type === "email") {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmed)) {
          errors[field.id] = "E-mail inválido";
        }
      }

      if (field.type === "url") {
        try {
          new URL(trimmed);
        } catch {
          errors[field.id] = "URL inválida";
        }
      }

      if (field.type === "rating") {
        const num = parseInt(trimmed);
        if (isNaN(num) || num < 1 || num > 5) {
          errors[field.id] = "Avaliação inválida";
        }
      }

      const v = field.validation;
      if (v) {
        if (v.minLength !== undefined && trimmed.length < v.minLength) {
          errors[field.id] = `Mínimo ${v.minLength} caracteres`;
        }
        if (v.maxLength !== undefined && trimmed.length > v.maxLength) {
          errors[field.id] = `Máximo ${v.maxLength} caracteres`;
        }
        if (field.type === "number") {
          const num = Number(value);
          if (v.min !== undefined && num < v.min) {
            errors[field.id] = `Mínimo: ${v.min}`;
          }
          if (v.max !== undefined && num > v.max) {
            errors[field.id] = `Máximo: ${v.max}`;
          }
        }
        if (v.pattern) {
          try {
            if (!new RegExp(v.pattern).test(trimmed)) {
              errors[field.id] = "Formato inválido";
            }
          } catch {
            // Invalid regex, skip
          }
        }
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// Phase 3: Evaluate conditional logic server-side
function evaluateFieldVisibilityServer(
  field: any,
  data: Record<string, any>
): boolean {
  const logic = field.conditionalLogic;
  if (!logic || !logic.conditions || logic.conditions.length === 0) return true;

  const results = logic.conditions.map((condition: any) => {
    const fieldValue = String(data[condition.fieldId] ?? "");
    const condValue = condition.value ?? "";

    switch (condition.operator) {
      case "equals": return fieldValue === condValue;
      case "not_equals": return fieldValue !== condValue;
      case "contains": return fieldValue.toLowerCase().includes(condValue.toLowerCase());
      case "not_contains": return !fieldValue.toLowerCase().includes(condValue.toLowerCase());
      case "is_empty": return fieldValue.trim() === "";
      case "is_not_empty": return fieldValue.trim() !== "";
      case "greater_than": return Number(fieldValue) > Number(condValue);
      case "less_than": return Number(fieldValue) < Number(condValue);
      default: return true;
    }
  });

  const conditionsMet = logic.logic === "all"
    ? results.every(Boolean)
    : results.some(Boolean);

  return logic.action === "show" ? conditionsMet : !conditionsMet;
}

// Phase 6: Simple hash for duplicate detection
function hashSubmissionData(data: Record<string, any>): string {
  const sorted = Object.keys(data).sort().map(k => `${k}:${data[k]}`).join("|");
  // Simple hash — good enough for 60s window dedup
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    const char = sorted.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return String(hash);
}

// Internal: Process a form submission (called from HTTP action, no auth)
export const internalProcessSubmission = internalMutation({
  args: {
    formId: v.id("forms"),
    data: v.record(v.string(), v.any()),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    referrer: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    honeypotTriggered: v.boolean(),
    sessionId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const form = await ctx.db.get(args.formId);
    if (!form) throw new Error("Form not found");
    if (form.status !== "published") throw new Error("Form is not published");

    // Check submission limit
    if (form.settings.submissionLimit && form.submissionCount >= form.settings.submissionLimit) {
      throw new Error("Submission limit reached");
    }

    const now = Date.now();

    // If honeypot triggered, store as spam and return early
    if (args.honeypotTriggered) {
      await ctx.db.insert("formSubmissions", {
        organizationId: form.organizationId,
        formId: args.formId,
        data: args.data,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
        referrer: args.referrer,
        utmSource: args.utmSource,
        utmMedium: args.utmMedium,
        utmCampaign: args.utmCampaign,
        honeypotTriggered: true,
        processingStatus: "spam",
        createdAt: now,
      });

      // Still increment submission count
      await ctx.db.patch(args.formId, {
        submissionCount: form.submissionCount + 1,
        lastSubmissionAt: now,
        updatedAt: now,
      });

      return { success: true, spam: true };
    }

    // Phase 3: Compute field visibility based on conditional logic
    const visibleFieldIds = new Set<string>();
    for (const field of form.fields) {
      if (evaluateFieldVisibilityServer(field, args.data)) {
        visibleFieldIds.add(field.id);
      }
    }

    // Phase 6: Server-side validation
    const validationResult = validateSubmissionData(form.fields, args.data, visibleFieldIds);
    if (!validationResult.valid) {
      // Store with error status
      await ctx.db.insert("formSubmissions", {
        organizationId: form.organizationId,
        formId: args.formId,
        data: args.data,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
        referrer: args.referrer,
        utmSource: args.utmSource,
        utmMedium: args.utmMedium,
        utmCampaign: args.utmCampaign,
        honeypotTriggered: false,
        processingStatus: "error",
        errorMessage: JSON.stringify(validationResult.errors),
        createdAt: now,
      });

      await ctx.db.patch(args.formId, {
        submissionCount: form.submissionCount + 1,
        lastSubmissionAt: now,
        updatedAt: now,
      });

      return { success: false, validation: true, errors: validationResult.errors };
    }

    // Phase 6: Duplicate detection — check recent submissions (last 60s)
    const fingerprint = hashSubmissionData(args.data);
    const sixtySecondsAgo = now - 60 * 1000;
    const recentSubmissions = await ctx.db
      .query("formSubmissions")
      .withIndex("by_form_and_created", (q) =>
        q.eq("formId", args.formId).gte("createdAt", sixtySecondsAgo)
      )
      .collect();

    const isDuplicate = recentSubmissions.some((s) => {
      if (s.processingStatus === "spam") return false;
      return hashSubmissionData(s.data as Record<string, any>) === fingerprint;
    });

    if (isDuplicate) {
      return { success: false, duplicate: true };
    }

    // Extract contact fields from data using crmMappings (only visible fields)
    const contactFields: Record<string, string> = {};
    const leadCustomFields: Record<string, any> = {};

    for (const field of form.fields) {
      // Skip invisible fields from CRM mapping
      if (!visibleFieldIds.has(field.id)) continue;
      const value = args.data[field.id];
      if (value === undefined || value === null || value === "") continue;

      if (field.crmMapping) {
        if (field.crmMapping.entity === "contact") {
          contactFields[field.crmMapping.field] = value;
        } else if (field.crmMapping.entity === "lead") {
          leadCustomFields[field.crmMapping.field] = value;
        }
      }
    }

    // Find or create contact
    const contactId: Id<"contacts"> = await ctx.runMutation(internal.contacts.internalFindOrCreateContact, {
      organizationId: form.organizationId,
      email: contactFields.email,
      phone: contactFields.phone,
      firstName: contactFields.firstName,
      lastName: contactFields.lastName,
      company: contactFields.company,
    });

    // Build lead title from template
    let leadTitle = form.settings.leadTitle;
    leadTitle = leadTitle.replace(/\{email\}/g, contactFields.email || "");
    leadTitle = leadTitle.replace(/\{name\}/g, [contactFields.firstName, contactFields.lastName].filter(Boolean).join(" ") || "");
    leadTitle = leadTitle.replace(/\{firstName\}/g, contactFields.firstName || "");
    leadTitle = leadTitle.replace(/\{lastName\}/g, contactFields.lastName || "");
    leadTitle = leadTitle.replace(/\{company\}/g, contactFields.company || "");
    leadTitle = leadTitle.replace(/\{phone\}/g, contactFields.phone || "");
    // Clean up any remaining unreplaced placeholders
    leadTitle = leadTitle.replace(/\{[^}]*\}/g, "").trim();
    if (!leadTitle) leadTitle = `Formulario - ${form.name}`;

    // Get board/stage: use form settings or fall back to default board
    let boardId = form.settings.boardId;
    let stageId = form.settings.stageId;

    if (!boardId) {
      const boards = await ctx.db
        .query("boards")
        .withIndex("by_organization", (q) => q.eq("organizationId", form.organizationId))
        .collect();
      const defaultBoard = boards.find((b) => b.isDefault) || boards[0];
      if (!defaultBoard) throw new Error("No boards configured");
      boardId = defaultBoard._id;
    }

    if (!stageId) {
      const stages = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", boardId!))
        .collect();
      const firstStage = stages[0];
      if (!firstStage) throw new Error("No stages configured");
      stageId = firstStage._id;
    }

    // Determine assignee based on assignmentMode
    let assignedTo = undefined;
    if (form.settings.assignmentMode === "specific" && form.settings.assignedTo) {
      assignedTo = form.settings.assignedTo;
    } else if (form.settings.assignmentMode === "round_robin") {
      // Find active human team members
      const members = await ctx.db
        .query("teamMembers")
        .withIndex("by_organization_and_type", (q) =>
          q.eq("organizationId", form.organizationId).eq("type", "human")
        )
        .collect();
      const activeMembers = members.filter((m) => m.status === "active");

      if (activeMembers.length > 0) {
        // Find member with fewest assigned leads
        let minLeads = Infinity;
        let selectedMember = activeMembers[0];

        for (const member of activeMembers) {
          const leads = await ctx.db
            .query("leads")
            .withIndex("by_organization_and_assigned", (q) =>
              q.eq("organizationId", form.organizationId).eq("assignedTo", member._id)
            )
            .collect();
          if (leads.length < minLeads) {
            minLeads = leads.length;
            selectedMember = member;
          }
        }

        assignedTo = selectedMember._id;
      }
    }

    // Create lead
    const leadId: Id<"leads"> = await ctx.runMutation(internal.leads.internalCreateLead, {
      organizationId: form.organizationId,
      title: leadTitle,
      contactId,
      boardId: boardId!,
      stageId,
      assignedTo,
      priority: form.settings.defaultPriority,
      temperature: form.settings.defaultTemperature,
      tags: form.settings.tags,
      customFields: Object.keys(leadCustomFields).length > 0 ? leadCustomFields : {},
      sourceId: form.settings.sourceId,
      teamMemberId: form.createdBy,
    });

    // Store form submission
    const submissionId = await ctx.db.insert("formSubmissions", {
      organizationId: form.organizationId,
      formId: args.formId,
      data: args.data,
      leadId,
      contactId,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      referrer: args.referrer,
      utmSource: args.utmSource,
      utmMedium: args.utmMedium,
      utmCampaign: args.utmCampaign,
      honeypotTriggered: false,
      processingStatus: "processed",
      sessionId: args.sessionId,
      createdAt: now,
    });

    // Mark partial as converted if sessionId was provided
    if (args.sessionId) {
      await ctx.runMutation(internal.formPartials.internalMarkConverted, {
        formId: args.formId,
        sessionId: args.sessionId,
        submissionId,
      });
    }

    // Increment form submission count
    await ctx.db.patch(args.formId, {
      submissionCount: form.submissionCount + 1,
      lastSubmissionAt: now,
      updatedAt: now,
    });

    // Activity log on lead
    await ctx.db.insert("activities", {
      organizationId: form.organizationId,
      leadId,
      type: "created",
      actorType: "system",
      content: `Formulario '${form.name}' submetido`,
      createdAt: now,
    });

    // Audit log
    await ctx.db.insert("auditLogs", {
      organizationId: form.organizationId,
      entityType: "formSubmission",
      entityId: args.formId,
      action: "create",
      actorType: "system",
      metadata: { formName: form.name, leadId, contactId },
      description: buildAuditDescription({ action: "create", entityType: "formSubmission", metadata: { name: form.name } }),
      severity: "medium",
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: form.organizationId,
      event: "form.submitted",
      payload: { formId: args.formId, formName: form.name, leadId, contactId },
    });

    // Email notifications
    if (form.settings.notifyOnSubmission && form.settings.notifyMemberIds) {
      const appUrl = process.env.APP_URL ?? "https://app.hnbcrm.com.br";
      for (const memberId of form.settings.notifyMemberIds) {
        await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
          organizationId: form.organizationId,
          recipientMemberId: memberId,
          eventType: "formSubmission",
          templateData: {
            formName: form.name,
            contactEmail: contactFields.email,
            contactName: [contactFields.firstName, contactFields.lastName].filter(Boolean).join(" ") || undefined,
            leadUrl: `${appUrl}/app/pipeline`,
          },
        });
      }
    }

    // Phase 7: Send confirmation email to submitter if enabled
    if (form.settings.confirmationEmail?.enabled && contactFields.email) {
      // Build field label map for variable replacement
      const fieldLabels: Record<string, string> = {};
      for (const field of form.fields) {
        fieldLabels[field.id] = field.label;
      }

      await ctx.scheduler.runAfter(0, internal.email.sendConfirmationEmail, {
        toEmail: contactFields.email,
        formName: form.name,
        subject: form.settings.confirmationEmail.subject,
        body: form.settings.confirmationEmail.body,
        replyTo: form.settings.confirmationEmail.replyTo,
        submittedData: args.data,
        fieldLabels,
      });
    }

    return { success: true, leadId, contactId };
  },
});

// Get form submissions (legacy, kept for backward compat)
export const getFormSubmissions = query({
  args: {
    formId: v.id("forms"),
    organizationId: v.id("organizations"),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const limit = args.limit ?? 50;

    const submissions = await ctx.db
      .query("formSubmissions")
      .withIndex("by_form_and_created", (q) => q.eq("formId", args.formId))
      .order("desc")
      .take(limit);

    return submissions;
  },
});

// Phase 1: Paginated form submissions with optional status filter
export const getFormSubmissionsPaginated = query({
  args: {
    formId: v.id("forms"),
    organizationId: v.id("organizations"),
    status: v.optional(v.union(v.literal("processed"), v.literal("spam"), v.literal("error"))),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    if (args.status) {
      return await ctx.db
        .query("formSubmissions")
        .withIndex("by_form_and_status", (q) =>
          q.eq("formId", args.formId).eq("processingStatus", args.status!)
        )
        .order("desc")
        .paginate(args.paginationOpts);
    }

    return await ctx.db
      .query("formSubmissions")
      .withIndex("by_form_and_created", (q) => q.eq("formId", args.formId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// Get form stats
export const getFormStats = query({
  args: {
    formId: v.id("forms"),
    organizationId: v.id("organizations"),
    now: v.number(), // Pass Date.now() from client — queries must not call Date.now()
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const submissions = await ctx.db
      .query("formSubmissions")
      .withIndex("by_form_and_created", (q) => q.eq("formId", args.formId))
      .collect();

    const sevenDaysAgo = args.now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = args.now - 30 * 24 * 60 * 60 * 1000;

    const total = submissions.length;
    const processed = submissions.filter((s) => s.processingStatus === "processed").length;
    const spam = submissions.filter((s) => s.processingStatus === "spam").length;
    const error = submissions.filter((s) => s.processingStatus === "error").length;
    const last7Days = submissions.filter((s) => s.createdAt >= sevenDaysAgo).length;
    const last30Days = submissions.filter((s) => s.createdAt >= thirtyDaysAgo).length;

    return { total, processed, spam, error, last7Days, last30Days };
  },
});

// Phase 5: Form analytics with daily breakdown
export const getFormAnalytics = query({
  args: {
    formId: v.id("forms"),
    organizationId: v.id("organizations"),
    now: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const submissions = await ctx.db
      .query("formSubmissions")
      .withIndex("by_form_and_created", (q) => q.eq("formId", args.formId))
      .collect();

    const sevenDaysAgo = args.now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = args.now - 30 * 24 * 60 * 60 * 1000;

    const total = submissions.length;
    const processed = submissions.filter((s) => s.processingStatus === "processed").length;
    const spam = submissions.filter((s) => s.processingStatus === "spam").length;
    const error = submissions.filter((s) => s.processingStatus === "error").length;
    const last7Days = submissions.filter((s) => s.createdAt >= sevenDaysAgo).length;
    const last30Days = submissions.filter((s) => s.createdAt >= thirtyDaysAgo).length;
    const spamRate = total > 0 ? spam / total : 0;

    // Daily submissions for last 30 days
    const dailySubmissions: { date: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = args.now - (i + 1) * 24 * 60 * 60 * 1000;
      const dayEnd = args.now - i * 24 * 60 * 60 * 1000;
      const count = submissions.filter((s) => s.createdAt >= dayStart && s.createdAt < dayEnd).length;
      const date = new Date(dayStart).toISOString().split("T")[0];
      dailySubmissions.push({ date, count });
    }

    // UTM source breakdown
    const utmBreakdown: Record<string, number> = {};
    for (const s of submissions) {
      if (s.utmSource) {
        utmBreakdown[s.utmSource] = (utmBreakdown[s.utmSource] ?? 0) + 1;
      }
    }
    const utmSources = Object.entries(utmBreakdown)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);

    return {
      total, processed, spam, error,
      last7Days, last30Days, spamRate,
      dailySubmissions, utmSources,
    };
  },
});
