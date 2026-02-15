import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

const http = httpRouter();

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
};

// Preflight handler
function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// Standard error response
function errorResponse(message: string, status: number = 500) {
  return new Response(JSON.stringify({ error: message, code: status }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// Standard success response
function jsonResponse(data: Record<string, unknown>, status: number = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// API Key authentication helper
async function authenticateApiKey(ctx: any, request: Request) {
  const apiKey = request.headers.get("X-API-Key");
  if (!apiKey) {
    throw new Error("API key required");
  }

  // Hash the API key before lookup (keys are stored as SHA-256 hashes)
  const keyHash = await ctx.runAction(internal.nodeActions.hashString, { input: apiKey });

  const apiKeyRecord = await ctx.runQuery(internal.apiKeys.getByKeyHash, { keyHash });
  if (!apiKeyRecord) {
    throw new Error("Invalid API key");
  }

  await ctx.runMutation(internal.apiKeys.updateLastUsed, { apiKeyId: apiKeyRecord._id });

  return apiKeyRecord;
}

// ---- Lead Endpoints ----

// Universal lead capture endpoint
http.route({
  path: "/api/v1/inbound/lead",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();

      if (!body.title) {
        return errorResponse("Title is required", 400);
      }

      // Find or create contact
      const contactId = await ctx.runMutation(internal.contacts.internalFindOrCreateContact, {
        organizationId: apiKeyRecord.organizationId,
        email: body.contact?.email,
        phone: body.contact?.phone,
        firstName: body.contact?.firstName,
        lastName: body.contact?.lastName,
        company: body.contact?.company,
      });

      // Get default board and stage
      const boards = await ctx.runQuery(internal.boards.internalGetBoards, {
        organizationId: apiKeyRecord.organizationId,
      });
      const defaultBoard = boards.find((b: { isDefault: boolean; _id: string }) => b.isDefault) || boards[0];

      if (!defaultBoard) {
        return errorResponse("No boards configured", 500);
      }

      const stages = await ctx.runQuery(internal.boards.internalGetStages, {
        boardId: defaultBoard._id,
      });
      const firstStage = stages[0];

      if (!firstStage) {
        return errorResponse("No stages configured", 500);
      }

      // Auto-assign to AI agent if configured
      let assignedTo = undefined;
      const org = await ctx.runQuery(internal.organizations.internalGetOrganization, {
        organizationId: apiKeyRecord.organizationId,
      });

      if (org?.settings.aiConfig?.autoAssign) {
        const aiAgents = await ctx.runQuery(internal.teamMembers.internalGetTeamMembers, {
          organizationId: apiKeyRecord.organizationId,
        });
        const availableAI = aiAgents.find((m: { type: string; status: string; _id: string }) => m.type === "ai" && m.status === "active");
        assignedTo = availableAI?._id;
      }

      // Create lead
      const leadId = await ctx.runMutation(internal.leads.internalCreateLead, {
        organizationId: apiKeyRecord.organizationId,
        title: body.title,
        contactId,
        boardId: defaultBoard._id,
        stageId: firstStage._id,
        assignedTo,
        value: body.value || 0,
        currency: body.currency,
        priority: body.priority || "medium",
        temperature: body.temperature || "cold",
        sourceId: body.sourceId,
        tags: body.tags || [],
        customFields: body.customFields || {},
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      // Create conversation if message provided
      if (body.message) {
        const conversationId = await ctx.runMutation(internal.conversations.internalCreateConversation, {
          organizationId: apiKeyRecord.organizationId,
          leadId,
          channel: body.channel || "webchat",
        });

        await ctx.runMutation(internal.conversations.internalSendMessage, {
          conversationId,
          content: body.message,
          isInternal: false,
          teamMemberId: apiKeyRecord.teamMemberId,
        });
      }

      return jsonResponse({ success: true, leadId, contactId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get leads
http.route({
  path: "/api/v1/leads",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);

      const url = new URL(request.url);
      const boardId = url.searchParams.get("boardId");
      const stageId = url.searchParams.get("stageId");
      const assignedTo = url.searchParams.get("assignedTo");

      const leads = await ctx.runQuery(internal.leads.internalGetLeads, {
        organizationId: apiKeyRecord.organizationId,
        boardId: boardId ? (boardId as Id<"boards">) : undefined,
        stageId: stageId ? (stageId as Id<"stages">) : undefined,
        assignedTo: assignedTo ? (assignedTo as Id<"teamMembers">) : undefined,
      });

      return jsonResponse({ leads });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get single lead
http.route({
  path: "/api/v1/leads/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const leadId = url.searchParams.get("id");
      if (!leadId) return errorResponse("Lead ID required", 400);

      const lead = await ctx.runQuery(internal.leads.internalGetLead, {
        leadId: leadId as Id<"leads">,
      });

      if (!lead) return errorResponse("Lead not found", 404);
      return jsonResponse({ lead });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Update lead
http.route({
  path: "/api/v1/leads/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.leadId) return errorResponse("leadId required", 400);

      await ctx.runMutation(internal.leads.internalUpdateLead, {
        leadId: body.leadId as Id<"leads">,
        title: body.title,
        value: body.value,
        priority: body.priority,
        temperature: body.temperature,
        tags: body.tags,
        customFields: body.customFields,
        sourceId: body.sourceId,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Delete lead
http.route({
  path: "/api/v1/leads/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.leadId) return errorResponse("leadId required", 400);

      await ctx.runMutation(internal.leads.internalDeleteLead, {
        leadId: body.leadId as Id<"leads">,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Move lead to stage
http.route({
  path: "/api/v1/leads/move-stage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.leadId || !body.stageId) return errorResponse("leadId and stageId required", 400);

      await ctx.runMutation(internal.leads.internalMoveLeadToStage, {
        leadId: body.leadId as Id<"leads">,
        stageId: body.stageId as Id<"stages">,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Assign lead
http.route({
  path: "/api/v1/leads/assign",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.leadId) return errorResponse("leadId required", 400);

      await ctx.runMutation(internal.leads.internalAssignLead, {
        leadId: body.leadId as Id<"leads">,
        assignedTo: body.assignedTo ? (body.assignedTo as Id<"teamMembers">) : undefined,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Request handoff for lead
http.route({
  path: "/api/v1/leads/handoff",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.leadId || !body.reason) return errorResponse("leadId and reason required", 400);

      const handoffId = await ctx.runMutation(internal.handoffs.internalRequestHandoff, {
        leadId: body.leadId as Id<"leads">,
        toMemberId: body.toMemberId ? (body.toMemberId as Id<"teamMembers">) : undefined,
        reason: body.reason,
        summary: body.summary,
        suggestedActions: body.suggestedActions || [],
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true, handoffId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Contact Endpoints ----

// Get contacts
http.route({
  path: "/api/v1/contacts",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);

      const contacts = await ctx.runQuery(internal.contacts.internalGetContacts, {
        organizationId: apiKeyRecord.organizationId,
      });

      return jsonResponse({ contacts });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Create contact
http.route({
  path: "/api/v1/contacts/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();

      const contactId = await ctx.runMutation(internal.contacts.internalCreateContact, {
        organizationId: apiKeyRecord.organizationId,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        company: body.company,
        title: body.title,
        whatsappNumber: body.whatsappNumber,
        telegramUsername: body.telegramUsername,
        tags: body.tags,
        photoUrl: body.photoUrl,
        bio: body.bio,
        linkedinUrl: body.linkedinUrl,
        instagramUrl: body.instagramUrl,
        facebookUrl: body.facebookUrl,
        twitterUrl: body.twitterUrl,
        city: body.city,
        state: body.state,
        country: body.country,
        industry: body.industry,
        companySize: body.companySize,
        cnpj: body.cnpj,
        companyWebsite: body.companyWebsite,
        preferredContactTime: body.preferredContactTime,
        deviceType: body.deviceType,
        utmSource: body.utmSource,
        acquisitionChannel: body.acquisitionChannel,
        instagramFollowers: body.instagramFollowers,
        linkedinConnections: body.linkedinConnections,
        socialInfluenceScore: body.socialInfluenceScore,
        customFields: body.customFields,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true, contactId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get single contact
http.route({
  path: "/api/v1/contacts/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const contactId = url.searchParams.get("id");
      if (!contactId) return errorResponse("Contact ID required", 400);

      const contact = await ctx.runQuery(internal.contacts.internalGetContact, {
        contactId: contactId as Id<"contacts">,
      });

      if (!contact) return errorResponse("Contact not found", 404);
      return jsonResponse({ contact });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Update contact
http.route({
  path: "/api/v1/contacts/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.contactId) return errorResponse("contactId required", 400);

      await ctx.runMutation(internal.contacts.internalUpdateContact, {
        contactId: body.contactId as Id<"contacts">,
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        company: body.company,
        title: body.title,
        whatsappNumber: body.whatsappNumber,
        telegramUsername: body.telegramUsername,
        tags: body.tags,
        photoUrl: body.photoUrl,
        bio: body.bio,
        linkedinUrl: body.linkedinUrl,
        instagramUrl: body.instagramUrl,
        facebookUrl: body.facebookUrl,
        twitterUrl: body.twitterUrl,
        city: body.city,
        state: body.state,
        country: body.country,
        industry: body.industry,
        companySize: body.companySize,
        cnpj: body.cnpj,
        companyWebsite: body.companyWebsite,
        preferredContactTime: body.preferredContactTime,
        deviceType: body.deviceType,
        utmSource: body.utmSource,
        acquisitionChannel: body.acquisitionChannel,
        instagramFollowers: body.instagramFollowers,
        linkedinConnections: body.linkedinConnections,
        socialInfluenceScore: body.socialInfluenceScore,
        customFields: body.customFields,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Enrich contact (AI agent endpoint)
http.route({
  path: "/api/v1/contacts/enrich",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.contactId) return errorResponse("contactId required", 400);
      if (!body.fields || typeof body.fields !== "object") return errorResponse("fields object required", 400);
      if (!body.source) return errorResponse("source required", 400);

      await ctx.runMutation(internal.contacts.enrichContact, {
        contactId: body.contactId as Id<"contacts">,
        fields: body.fields,
        source: body.source,
        confidence: body.confidence,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get contact enrichment gaps
http.route({
  path: "/api/v1/contacts/gaps",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const contactId = url.searchParams.get("id");
      if (!contactId) return errorResponse("Contact ID required", 400);

      const result = await ctx.runQuery(internal.contacts.internalGetContactEnrichmentGaps, {
        contactId: contactId as Id<"contacts">,
      });

      if (!result) return errorResponse("Contact not found", 404);
      return jsonResponse({ contact: result });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Conversation/Message Endpoints ----

// Get conversations
http.route({
  path: "/api/v1/conversations",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const leadId = url.searchParams.get("leadId");

      const conversations = await ctx.runQuery(internal.conversations.internalGetConversations, {
        organizationId: apiKeyRecord.organizationId,
        leadId: leadId ? (leadId as Id<"leads">) : undefined,
      });

      return jsonResponse({ conversations });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get messages for conversation
http.route({
  path: "/api/v1/conversations/messages",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const conversationId = url.searchParams.get("conversationId");
      if (!conversationId) return errorResponse("conversationId required", 400);

      const messages = await ctx.runQuery(internal.conversations.internalGetMessages, {
        conversationId: conversationId as Id<"conversations">,
      });

      return jsonResponse({ messages });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Send message to conversation
http.route({
  path: "/api/v1/conversations/send",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.conversationId || !body.content) {
        return errorResponse("conversationId and content required", 400);
      }

      const messageId = await ctx.runMutation(internal.conversations.internalSendMessage, {
        conversationId: body.conversationId as Id<"conversations">,
        content: body.content,
        contentType: body.contentType || "text",
        isInternal: body.isInternal || false,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true, messageId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Handoff Endpoints ----

// Get handoffs
http.route({
  path: "/api/v1/handoffs",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const status = url.searchParams.get("status") as "pending" | "accepted" | "rejected" | null;

      const handoffs = await ctx.runQuery(internal.handoffs.internalGetHandoffs, {
        organizationId: apiKeyRecord.organizationId,
        status: status || undefined,
      });

      return jsonResponse({ handoffs });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get pending handoffs (keep backward compat)
http.route({
  path: "/api/v1/handoffs/pending",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);

      const handoffs = await ctx.runQuery(internal.handoffs.internalGetHandoffs, {
        organizationId: apiKeyRecord.organizationId,
        status: "pending",
      });

      return jsonResponse({ handoffs });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Accept handoff
http.route({
  path: "/api/v1/handoffs/accept",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.handoffId) return errorResponse("handoffId required", 400);

      await ctx.runMutation(internal.handoffs.internalAcceptHandoff, {
        handoffId: body.handoffId as Id<"handoffs">,
        notes: body.notes,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Reject handoff
http.route({
  path: "/api/v1/handoffs/reject",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.handoffId) return errorResponse("handoffId required", 400);

      await ctx.runMutation(internal.handoffs.internalRejectHandoff, {
        handoffId: body.handoffId as Id<"handoffs">,
        notes: body.notes,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- CORS Preflight Routes ----
const optionsHandler = httpAction(async () => handleOptions());

http.route({ path: "/api/v1/inbound/lead", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/leads", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/leads/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/leads/update", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/leads/delete", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/leads/move-stage", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/leads/assign", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/leads/handoff", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/contacts", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/contacts/create", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/contacts/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/contacts/update", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/contacts/enrich", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/contacts/gaps", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/conversations", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/conversations/messages", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/conversations/send", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/handoffs", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/handoffs/pending", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/handoffs/accept", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/handoffs/reject", method: "OPTIONS", handler: optionsHandler });

export default http;
