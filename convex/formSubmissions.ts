import { v } from "convex/values";
import { query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAuth } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";

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

    // Extract contact fields from data using crmMappings
    const contactFields: Record<string, string> = {};
    const leadCustomFields: Record<string, any> = {};

    for (const field of form.fields) {
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
    await ctx.db.insert("formSubmissions", {
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
      createdAt: now,
    });

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

    return { success: true, leadId, contactId };
  },
});

// Get form submissions
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
