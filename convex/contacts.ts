import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { requireAuth } from "./lib/auth";

// Get contacts for organization
export const getContacts = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    return await ctx.db
      .query("contacts")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// Create contact
export const createContact = mutation({
  args: {
    organizationId: v.id("organizations"),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    whatsappNumber: v.optional(v.string()),
    telegramUsername: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.id("contacts"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);

    const now = Date.now();

    const contactId = await ctx.db.insert("contacts", {
      organizationId: args.organizationId,
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      phone: args.phone,
      company: args.company,
      title: args.title,
      whatsappNumber: args.whatsappNumber,
      telegramUsername: args.telegramUsername,
      tags: args.tags || [],
      createdAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "contact",
      entityId: contactId,
      action: "create",
      actorId: userMember._id,
      actorType: "human",
      metadata: { 
        name: `${args.firstName || ""} ${args.lastName || ""}`.trim(),
        email: args.email,
      },
      severity: "low",
      createdAt: now,
    });

    return contactId;
  },
});

// Find or create contact by email/phone
export const findOrCreateContact = mutation({
  args: {
    organizationId: v.id("organizations"),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    company: v.optional(v.string()),
  },
  returns: v.id("contacts"),
  handler: async (ctx, args) => {
    // Try to find existing contact
    let contact = null;
    
    if (args.email) {
      contact = await ctx.db
        .query("contacts")
        .withIndex("by_email", (q) => q.eq("email", args.email))
        .filter((q) => q.eq(q.field("organizationId"), args.organizationId))
        .first();
    }
    
    if (!contact && args.phone) {
      contact = await ctx.db
        .query("contacts")
        .withIndex("by_phone", (q) => q.eq("phone", args.phone))
        .filter((q) => q.eq(q.field("organizationId"), args.organizationId))
        .first();
    }

    if (contact) {
      return contact._id;
    }

    // Create new contact
    const now = Date.now();

    const contactId = await ctx.db.insert("contacts", {
      organizationId: args.organizationId,
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      phone: args.phone,
      company: args.company,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    return contactId;
  },
});

// Update contact
export const updateContact = mutation({
  args: {
    contactId: v.id("contacts"),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    whatsappNumber: v.optional(v.string()),
    telegramUsername: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) throw new Error("Contact not found");

    const userMember = await requireAuth(ctx, contact.organizationId);

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.firstName !== undefined && args.firstName !== contact.firstName) {
      changes.firstName = args.firstName;
      before.firstName = contact.firstName;
    }
    if (args.lastName !== undefined && args.lastName !== contact.lastName) {
      changes.lastName = args.lastName;
      before.lastName = contact.lastName;
    }
    if (args.email !== undefined && args.email !== contact.email) {
      changes.email = args.email;
      before.email = contact.email;
    }
    if (args.phone !== undefined && args.phone !== contact.phone) {
      changes.phone = args.phone;
      before.phone = contact.phone;
    }
    if (args.company !== undefined && args.company !== contact.company) {
      changes.company = args.company;
      before.company = contact.company;
    }
    if (args.title !== undefined && args.title !== contact.title) {
      changes.title = args.title;
      before.title = contact.title;
    }
    if (args.whatsappNumber !== undefined && args.whatsappNumber !== contact.whatsappNumber) {
      changes.whatsappNumber = args.whatsappNumber;
      before.whatsappNumber = contact.whatsappNumber;
    }
    if (args.telegramUsername !== undefined && args.telegramUsername !== contact.telegramUsername) {
      changes.telegramUsername = args.telegramUsername;
      before.telegramUsername = contact.telegramUsername;
    }
    if (args.tags !== undefined) {
      changes.tags = args.tags;
      before.tags = contact.tags;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.contactId, {
      ...changes,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: contact.organizationId,
      entityType: "contact",
      entityId: args.contactId,
      action: "update",
      actorId: userMember._id,
      actorType: "human",
      changes: { before, after: changes },
      severity: "low",
      createdAt: now,
    });

    return null;
  },
});

// Delete contact
export const deleteContact = mutation({
  args: { contactId: v.id("contacts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) throw new Error("Contact not found");

    const userMember = await requireAuth(ctx, contact.organizationId);

    // Check for linked leads
    const linkedLeads = await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) => q.eq("organizationId", contact.organizationId))
      .filter((q) => q.eq(q.field("contactId"), args.contactId))
      .first();

    if (linkedLeads) {
      throw new Error("Cannot delete contact with linked leads. Remove or reassign leads first.");
    }

    const now = Date.now();

    // Log audit entry before deletion
    await ctx.db.insert("auditLogs", {
      organizationId: contact.organizationId,
      entityType: "contact",
      entityId: args.contactId,
      action: "delete",
      actorId: userMember._id,
      actorType: "human",
      metadata: {
        name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
        email: contact.email,
      },
      severity: "high",
      createdAt: now,
    });

    await ctx.db.delete(args.contactId);

    return null;
  },
});

// Get single contact by ID
export const getContact = query({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return null;

    await requireAuth(ctx, contact.organizationId);

    return contact;
  },
});

// ===== Internal functions (for HTTP API / httpAction context) =====

// Internal: Get contacts for organization (no auth check)
export const internalGetContacts = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contacts")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
  },
});

// Internal: Get single contact by ID (no auth check)
export const internalGetContact = internalQuery({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return null;
    return contact;
  },
});

// Internal: Find or create contact by email/phone (no auth needed)
export const internalFindOrCreateContact = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    company: v.optional(v.string()),
  },
  returns: v.id("contacts"),
  handler: async (ctx, args) => {
    // Try to find existing contact
    let contact = null;

    if (args.email) {
      contact = await ctx.db
        .query("contacts")
        .withIndex("by_email", (q) => q.eq("email", args.email))
        .filter((q) => q.eq(q.field("organizationId"), args.organizationId))
        .first();
    }

    if (!contact && args.phone) {
      contact = await ctx.db
        .query("contacts")
        .withIndex("by_phone", (q) => q.eq("phone", args.phone))
        .filter((q) => q.eq(q.field("organizationId"), args.organizationId))
        .first();
    }

    if (contact) {
      return contact._id;
    }

    // Create new contact
    const now = Date.now();

    const contactId = await ctx.db.insert("contacts", {
      organizationId: args.organizationId,
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      phone: args.phone,
      company: args.company,
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    return contactId;
  },
});

// Internal: Create contact (accepts teamMemberId instead of auth)
export const internalCreateContact = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    whatsappNumber: v.optional(v.string()),
    telegramUsername: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.id("contacts"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const now = Date.now();

    const contactId = await ctx.db.insert("contacts", {
      organizationId: args.organizationId,
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      phone: args.phone,
      company: args.company,
      title: args.title,
      whatsappNumber: args.whatsappNumber,
      telegramUsername: args.telegramUsername,
      tags: args.tags || [],
      createdAt: now,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "contact",
      entityId: contactId,
      action: "create",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: {
        name: `${args.firstName || ""} ${args.lastName || ""}`.trim(),
        email: args.email,
      },
      severity: "low",
      createdAt: now,
    });

    return contactId;
  },
});

// Internal: Update contact (accepts teamMemberId instead of auth)
export const internalUpdateContact = internalMutation({
  args: {
    contactId: v.id("contacts"),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    whatsappNumber: v.optional(v.string()),
    telegramUsername: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const contact = await ctx.db.get(args.contactId);
    if (!contact) throw new Error("Contact not found");

    const now = Date.now();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};

    if (args.firstName !== undefined && args.firstName !== contact.firstName) {
      changes.firstName = args.firstName;
      before.firstName = contact.firstName;
    }
    if (args.lastName !== undefined && args.lastName !== contact.lastName) {
      changes.lastName = args.lastName;
      before.lastName = contact.lastName;
    }
    if (args.email !== undefined && args.email !== contact.email) {
      changes.email = args.email;
      before.email = contact.email;
    }
    if (args.phone !== undefined && args.phone !== contact.phone) {
      changes.phone = args.phone;
      before.phone = contact.phone;
    }
    if (args.company !== undefined && args.company !== contact.company) {
      changes.company = args.company;
      before.company = contact.company;
    }
    if (args.title !== undefined && args.title !== contact.title) {
      changes.title = args.title;
      before.title = contact.title;
    }
    if (args.whatsappNumber !== undefined && args.whatsappNumber !== contact.whatsappNumber) {
      changes.whatsappNumber = args.whatsappNumber;
      before.whatsappNumber = contact.whatsappNumber;
    }
    if (args.telegramUsername !== undefined && args.telegramUsername !== contact.telegramUsername) {
      changes.telegramUsername = args.telegramUsername;
      before.telegramUsername = contact.telegramUsername;
    }
    if (args.tags !== undefined) {
      changes.tags = args.tags;
      before.tags = contact.tags;
    }

    if (Object.keys(changes).length === 0) return null;

    await ctx.db.patch(args.contactId, {
      ...changes,
      updatedAt: now,
    });

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: contact.organizationId,
      entityType: "contact",
      entityId: args.contactId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before, after: changes },
      severity: "low",
      createdAt: now,
    });

    return null;
  },
});
