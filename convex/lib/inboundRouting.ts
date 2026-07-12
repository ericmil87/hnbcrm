/**
 * Shared inbound routing: find-or-create a contact by phone and ensure the
 * contact has a lead on the org's default board (with AI auto-assign).
 * Used by the WhatsApp webhook ingress and the /api/v1/conversations/receive
 * endpoint (same logic as the /api/v1/inbound/lead flow).
 */
import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { buildSearchText } from "./searchText";

export async function findOrCreateContactByPhone(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    phone: string;
    firstName?: string;
    lastName?: string;
  }
): Promise<Id<"contacts">> {
  const existing = await ctx.db
    .query("contacts")
    .withIndex("by_organization_and_phone", (q) =>
      q.eq("organizationId", args.organizationId).eq("phone", args.phone)
    )
    .first();

  if (existing) {
    // Backfill the name from the channel profile if we don't have one yet
    if (!existing.firstName && args.firstName) {
      await ctx.db.patch(existing._id, {
        firstName: args.firstName,
        searchText: buildSearchText({ ...existing, firstName: args.firstName }),
        updatedAt: Date.now(),
      });
    }
    return existing._id;
  }

  const now = Date.now();
  return await ctx.db.insert("contacts", {
    organizationId: args.organizationId,
    firstName: args.firstName,
    lastName: args.lastName,
    phone: args.phone,
    whatsappNumber: args.phone,
    tags: [],
    searchText: buildSearchText(args),
    createdAt: now,
    updatedAt: now,
  });
}

export async function ensureLeadForContact(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    contactId: Id<"contacts">;
    title?: string;
  }
): Promise<Id<"leads">> {
  // Most recent lead for this contact in this org
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
    .order("desc")
    .take(50);
  const existing = leads.find((l) => l.organizationId === args.organizationId);
  if (existing) return existing._id;

  // Default board + first stage
  const boards = await ctx.db
    .query("boards")
    .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
    .collect();
  const defaultBoard = boards.find((b) => b.isDefault) ?? boards[0];
  if (!defaultBoard) throw new Error("No boards configured");

  const stages = await ctx.db
    .query("stages")
    .withIndex("by_board_and_order", (q) => q.eq("boardId", defaultBoard._id))
    .collect();
  const firstStage = stages[0];
  if (!firstStage) throw new Error("No stages configured");

  // Auto-assign to an active AI member if the org opted in
  let assignedTo: Id<"teamMembers"> | undefined;
  const org = await ctx.db.get(args.organizationId);
  if (org?.settings.aiConfig?.autoAssign) {
    const aiMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) =>
        q.eq("organizationId", args.organizationId).eq("type", "ai")
      )
      .collect();
    assignedTo = aiMembers.find((m) => m.status === "active")?._id;
  }

  const contact = await ctx.db.get(args.contactId);
  const contactName =
    [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") ||
    contact?.phone ||
    contact?.email ||
    "Unknown contact";
  const title = args.title || contactName;

  const now = Date.now();
  const leadId = await ctx.db.insert("leads", {
    organizationId: args.organizationId,
    title,
    contactId: args.contactId,
    boardId: defaultBoard._id,
    stageId: firstStage._id,
    assignedTo,
    value: 0,
    currency: org?.settings.currency || "USD",
    priority: "medium",
    temperature: "cold",
    tags: [],
    customFields: {},
    conversationStatus: "new",
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("activities", {
    organizationId: args.organizationId,
    leadId,
    type: "created",
    actorType: "system",
    content: `Lead criado automaticamente a partir de mensagem recebida`,
    metadata: { contactId: args.contactId },
    createdAt: now,
  });

  await ctx.db.insert("auditLogs", {
    organizationId: args.organizationId,
    entityType: "lead",
    entityId: leadId,
    action: "create",
    actorType: "system",
    metadata: { title, contactId: args.contactId, source: "inbound_message" },
    description: `Criou o lead '${title}' automaticamente a partir de mensagem recebida`,
    severity: "medium",
    createdAt: now,
  });

  return leadId;
}
