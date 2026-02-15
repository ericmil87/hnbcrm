import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { requireAuth } from "./lib/auth";
import { batchGet } from "./lib/batchGet";

// All optional string fields on a contact that participate in search
function buildSearchText(contact: {
  firstName?: string; lastName?: string; email?: string; phone?: string;
  company?: string; title?: string; city?: string; state?: string;
  country?: string; industry?: string; bio?: string;
}): string {
  return [
    contact.firstName, contact.lastName, contact.email, contact.phone,
    contact.company, contact.title, contact.city, contact.state,
    contact.country, contact.industry, contact.bio,
  ].filter(Boolean).join(" ");
}

// Shared optional-field arg validators for enrichment fields
const enrichmentArgFields = {
  photoUrl: v.optional(v.string()),
  bio: v.optional(v.string()),
  linkedinUrl: v.optional(v.string()),
  instagramUrl: v.optional(v.string()),
  facebookUrl: v.optional(v.string()),
  twitterUrl: v.optional(v.string()),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  country: v.optional(v.string()),
  industry: v.optional(v.string()),
  companySize: v.optional(v.string()),
  cnpj: v.optional(v.string()),
  companyWebsite: v.optional(v.string()),
  preferredContactTime: v.optional(v.union(
    v.literal("morning"), v.literal("afternoon"), v.literal("evening")
  )),
  deviceType: v.optional(v.union(
    v.literal("android"), v.literal("iphone"), v.literal("desktop"), v.literal("unknown")
  )),
  utmSource: v.optional(v.string()),
  acquisitionChannel: v.optional(v.string()),
  instagramFollowers: v.optional(v.number()),
  linkedinConnections: v.optional(v.number()),
  socialInfluenceScore: v.optional(v.number()),
  customFields: v.optional(v.record(v.string(), v.any())),
};

// All the string/simple fields that can be diffed for change tracking
const trackableFields = [
  "firstName", "lastName", "email", "phone", "company", "title",
  "whatsappNumber", "telegramUsername",
  "photoUrl", "bio",
  "linkedinUrl", "instagramUrl", "facebookUrl", "twitterUrl",
  "city", "state", "country",
  "industry", "companySize", "cnpj", "companyWebsite",
  "preferredContactTime", "deviceType", "utmSource", "acquisitionChannel",
  "instagramFollowers", "linkedinConnections", "socialInfluenceScore",
] as const;

function diffChanges(args: Record<string, any>, contact: Record<string, any>) {
  const changes: Record<string, any> = {};
  const before: Record<string, any> = {};
  for (const field of trackableFields) {
    if (args[field] !== undefined && args[field] !== contact[field]) {
      changes[field] = args[field];
      before[field] = contact[field];
    }
  }
  if (args.tags !== undefined) {
    changes.tags = args.tags;
    before.tags = contact.tags;
  }
  if (args.customFields !== undefined) {
    changes.customFields = args.customFields;
    before.customFields = contact.customFields;
  }
  return { changes, before };
}

// ===== Public queries =====

export const getContacts = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    return await ctx.db
      .query("contacts")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(500);
  },
});

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

export const searchContacts = query({
  args: {
    organizationId: v.id("organizations"),
    searchText: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    return await ctx.db
      .query("contacts")
      .withSearchIndex("search_contacts", (q) =>
        q.search("searchText", args.searchText).eq("organizationId", args.organizationId)
      )
      .take(args.limit ?? 20);
  },
});

export const getContactWithLeads = query({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return null;
    await requireAuth(ctx, contact.organizationId);

    const leads = await ctx.db
      .query("leads")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .take(100);

    const [stageMap, assigneeMap] = await Promise.all([
      batchGet(ctx.db, leads.map(l => l.stageId)),
      batchGet(ctx.db, leads.map(l => l.assignedTo)),
    ]);
    const leadsWithData = leads.map(lead => ({
      ...lead,
      stage: stageMap.get(lead.stageId) ?? null,
      assignee: lead.assignedTo ? assigneeMap.get(lead.assignedTo) ?? null : null,
    }));

    return { ...contact, leads: leadsWithData };
  },
});

export const getContactEnrichmentGaps = query({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return null;
    await requireAuth(ctx, contact.organizationId);

    const allFields = [
      "firstName", "lastName", "email", "phone", "company", "title",
      "whatsappNumber", "telegramUsername", "photoUrl", "bio",
      "linkedinUrl", "instagramUrl", "facebookUrl", "twitterUrl",
      "city", "state", "country",
      "industry", "companySize", "cnpj", "companyWebsite",
      "preferredContactTime", "deviceType", "utmSource", "acquisitionChannel",
      "instagramFollowers", "linkedinConnections", "socialInfluenceScore",
    ];

    const missingFields = allFields.filter((f) => {
      const val = (contact as any)[f];
      return val === undefined || val === null || val === "";
    });

    return { ...contact, missingFields };
  },
});

// ===== Public mutations =====

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
    ...enrichmentArgFields,
  },
  returns: v.id("contacts"),
  handler: async (ctx, args) => {
    const userMember = await requireAuth(ctx, args.organizationId);
    const now = Date.now();

    const searchText = buildSearchText(args);
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
      searchText: searchText || undefined,
      photoUrl: args.photoUrl,
      bio: args.bio,
      linkedinUrl: args.linkedinUrl,
      instagramUrl: args.instagramUrl,
      facebookUrl: args.facebookUrl,
      twitterUrl: args.twitterUrl,
      city: args.city,
      state: args.state,
      country: args.country,
      industry: args.industry,
      companySize: args.companySize,
      cnpj: args.cnpj,
      companyWebsite: args.companyWebsite,
      preferredContactTime: args.preferredContactTime,
      deviceType: args.deviceType,
      utmSource: args.utmSource,
      acquisitionChannel: args.acquisitionChannel,
      instagramFollowers: args.instagramFollowers,
      linkedinConnections: args.linkedinConnections,
      socialInfluenceScore: args.socialInfluenceScore,
      customFields: args.customFields,
      createdAt: now,
      updatedAt: now,
    });

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
    let contact = null;

    if (args.email) {
      contact = await ctx.db
        .query("contacts")
        .withIndex("by_organization_and_email", (q) =>
          q.eq("organizationId", args.organizationId).eq("email", args.email)
        )
        .first();
    }

    if (!contact && args.phone) {
      contact = await ctx.db
        .query("contacts")
        .withIndex("by_organization_and_phone", (q) =>
          q.eq("organizationId", args.organizationId).eq("phone", args.phone)
        )
        .first();
    }

    if (contact) return contact._id;

    const now = Date.now();
    const searchText = buildSearchText(args);

    return await ctx.db.insert("contacts", {
      organizationId: args.organizationId,
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      phone: args.phone,
      company: args.company,
      tags: [],
      searchText: searchText || undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

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
    ...enrichmentArgFields,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) throw new Error("Contact not found");

    const userMember = await requireAuth(ctx, contact.organizationId);
    const now = Date.now();

    const { changes, before } = diffChanges(args, contact);
    if (Object.keys(changes).length === 0) return null;

    const merged = { ...contact, ...changes };
    const searchText = buildSearchText(merged);

    await ctx.db.patch(args.contactId, {
      ...changes,
      searchText: searchText || undefined,
      updatedAt: now,
    });

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

export const deleteContact = mutation({
  args: { contactId: v.id("contacts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) throw new Error("Contact not found");

    const userMember = await requireAuth(ctx, contact.organizationId);

    const linkedLeads = await ctx.db
      .query("leads")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .first();

    if (linkedLeads) {
      throw new Error("Cannot delete contact with linked leads. Remove or reassign leads first.");
    }

    const now = Date.now();

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

// ===== Internal functions (for HTTP API / httpAction context) =====

export const internalGetContacts = internalQuery({
  args: { organizationId: v.id("organizations"), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contacts")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(args.limit ?? 500);
  },
});

export const internalGetContact = internalQuery({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return null;
    return contact;
  },
});

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
    let contact = null;

    if (args.email) {
      contact = await ctx.db
        .query("contacts")
        .withIndex("by_organization_and_email", (q) =>
          q.eq("organizationId", args.organizationId).eq("email", args.email)
        )
        .first();
    }

    if (!contact && args.phone) {
      contact = await ctx.db
        .query("contacts")
        .withIndex("by_organization_and_phone", (q) =>
          q.eq("organizationId", args.organizationId).eq("phone", args.phone)
        )
        .first();
    }

    if (contact) return contact._id;

    const now = Date.now();
    const searchText = buildSearchText(args);

    return await ctx.db.insert("contacts", {
      organizationId: args.organizationId,
      firstName: args.firstName,
      lastName: args.lastName,
      email: args.email,
      phone: args.phone,
      company: args.company,
      tags: [],
      searchText: searchText || undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

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
    ...enrichmentArgFields,
  },
  returns: v.id("contacts"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const now = Date.now();
    const searchText = buildSearchText(args);

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
      searchText: searchText || undefined,
      photoUrl: args.photoUrl,
      bio: args.bio,
      linkedinUrl: args.linkedinUrl,
      instagramUrl: args.instagramUrl,
      facebookUrl: args.facebookUrl,
      twitterUrl: args.twitterUrl,
      city: args.city,
      state: args.state,
      country: args.country,
      industry: args.industry,
      companySize: args.companySize,
      cnpj: args.cnpj,
      companyWebsite: args.companyWebsite,
      preferredContactTime: args.preferredContactTime,
      deviceType: args.deviceType,
      utmSource: args.utmSource,
      acquisitionChannel: args.acquisitionChannel,
      instagramFollowers: args.instagramFollowers,
      linkedinConnections: args.linkedinConnections,
      socialInfluenceScore: args.socialInfluenceScore,
      customFields: args.customFields,
      createdAt: now,
      updatedAt: now,
    });

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
    ...enrichmentArgFields,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const contact = await ctx.db.get(args.contactId);
    if (!contact) throw new Error("Contact not found");

    const now = Date.now();
    const { changes, before } = diffChanges(args, contact);
    if (Object.keys(changes).length === 0) return null;

    const merged = { ...contact, ...changes };
    const searchText = buildSearchText(merged);

    await ctx.db.patch(args.contactId, {
      ...changes,
      searchText: searchText || undefined,
      updatedAt: now,
    });

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

// Enrichment mutation for AI agents
export const enrichContact = internalMutation({
  args: {
    contactId: v.id("contacts"),
    fields: v.record(v.string(), v.any()),
    source: v.string(),
    confidence: v.optional(v.number()),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const contact = await ctx.db.get(args.contactId);
    if (!contact) throw new Error("Contact not found");

    const now = Date.now();
    const before: Record<string, any> = {};
    const after: Record<string, any> = {};

    // Build enrichmentMeta entries for each field
    const existingMeta = contact.enrichmentMeta || {};
    const newMeta: Record<string, { source: string; updatedAt: number; confidence?: number }> = { ...existingMeta };

    for (const [key, value] of Object.entries(args.fields)) {
      before[key] = (contact as any)[key];
      after[key] = value;
      newMeta[key] = {
        source: args.source,
        updatedAt: now,
        confidence: args.confidence,
      };
    }

    const merged = { ...contact, ...args.fields };
    const searchText = buildSearchText(merged);

    await ctx.db.patch(args.contactId, {
      ...args.fields,
      enrichmentMeta: newMeta,
      searchText: searchText || undefined,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: contact.organizationId,
      entityType: "contact",
      entityId: args.contactId,
      action: "update",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      changes: { before, after },
      metadata: { enrichmentSource: args.source, confidence: args.confidence },
      severity: "low",
      createdAt: now,
    });

    return null;
  },
});

// Internal query for enrichment gaps
export const internalGetContactEnrichmentGaps = internalQuery({
  args: { contactId: v.id("contacts") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return null;

    const allFields = [
      "firstName", "lastName", "email", "phone", "company", "title",
      "whatsappNumber", "telegramUsername", "photoUrl", "bio",
      "linkedinUrl", "instagramUrl", "facebookUrl", "twitterUrl",
      "city", "state", "country",
      "industry", "companySize", "cnpj", "companyWebsite",
      "preferredContactTime", "deviceType", "utmSource", "acquisitionChannel",
      "instagramFollowers", "linkedinConnections", "socialInfluenceScore",
    ];

    const missingFields = allFields.filter((f) => {
      const val = (contact as any)[f];
      return val === undefined || val === null || val === "";
    });

    return { ...contact, missingFields };
  },
});
