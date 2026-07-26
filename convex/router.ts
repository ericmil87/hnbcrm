import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { LLMS_TXT, LLMS_FULL_TXT } from "./llmsTxt";
import { EMBED_SCRIPT } from "./embedScript";
import { OPENAPI_SPEC } from "./openapiSpec";
import { resolvePermissions, type Role, type Permissions } from "./lib/permissions";
import { resend } from "./email";
import {
  webhookVerify as whatsappWebhookVerify,
  webhookReceive as whatsappWebhookReceive,
} from "./whatsapp";
import { webhookReceive as bridgeWebhookReceive } from "./bridge";
import { copilotStream } from "./copilotHttp";

const http = httpRouter();

// ── Copiloto: streaming SSE autenticado (JWT do Convex auth no Authorization) ──
http.route({
  path: "/api/copilot/stream",
  method: "POST",
  handler: copilotStream,
});
http.route({
  path: "/api/copilot/stream",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }),
});

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
  // Rate-limit failures bubble up as thrown errors from authenticateApiKey —
  // map them to 429 here so every /api/v1 route answers correctly
  const finalStatus = message.includes("Rate limit exceeded") ? 429 : status;
  return new Response(JSON.stringify({ error: message, code: finalStatus }), {
    status: finalStatus,
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

// API Key authentication helper — resolves permissions from apiKey > teamMember > role defaults
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

  // Resolve permissions: apiKey.permissions > teamMember.permissions > role defaults
  const teamMember = apiKeyRecord.teamMember;
  const permissions: Permissions = apiKeyRecord.permissions
    ?? resolvePermissions(
      (teamMember?.role ?? "agent") as Role,
      teamMember?.permissions ?? undefined
    );

  return { ...apiKeyRecord, permissions };
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
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.leads.internalGetLeads, {
        organizationId: apiKeyRecord.organizationId,
        boardId: boardId ? (boardId as Id<"boards">) : undefined,
        stageId: stageId ? (stageId as Id<"stages">) : undefined,
        assignedTo: assignedTo ? (assignedTo as Id<"teamMembers">) : undefined,
        limit,
        cursor,
      });

      return jsonResponse(result as any);
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
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const leadId = url.searchParams.get("id");
      if (!leadId) return errorResponse("Lead ID required", 400);

      const lead = await ctx.runQuery(internal.leads.internalGetLead, {
        leadId: leadId as Id<"leads">,
        organizationId: apiKeyRecord.organizationId,
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
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "500"), 500);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.contacts.internalGetContacts, {
        organizationId: apiKeyRecord.organizationId,
        limit,
        cursor,
      });

      return jsonResponse(result as any);
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
        photoFileId: body.photoFileId,
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
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const contactId = url.searchParams.get("id");
      if (!contactId) return errorResponse("Contact ID required", 400);

      const contact = await ctx.runQuery(internal.contacts.internalGetContact, {
        contactId: contactId as Id<"contacts">,
        organizationId: apiKeyRecord.organizationId,
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
        photoFileId: body.photoFileId,
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
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const contactId = url.searchParams.get("id");
      if (!contactId) return errorResponse("Contact ID required", 400);

      const result = await ctx.runQuery(internal.contacts.internalGetContactEnrichmentGaps, {
        contactId: contactId as Id<"contacts">,
        organizationId: apiKeyRecord.organizationId,
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
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.conversations.internalGetConversations, {
        organizationId: apiKeyRecord.organizationId,
        leadId: leadId ? (leadId as Id<"leads">) : undefined,
        limit,
        cursor,
      });

      return jsonResponse(result as any);
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
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const conversationId = url.searchParams.get("conversationId");
      if (!conversationId) return errorResponse("conversationId required", 400);

      const messages = await ctx.runQuery(internal.conversations.internalGetMessages, {
        conversationId: conversationId as Id<"conversations">,
        organizationId: apiKeyRecord.organizationId,
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
      // Attachments (file ids) — the mutation validates they belong to the org.
      const attachments = Array.isArray(body.attachments)
        ? (body.attachments as Id<"files">[])
        : undefined;
      if (!body.conversationId || (!body.content && !(attachments && attachments.length > 0))) {
        return errorResponse("conversationId and content (or attachments) required", 400);
      }

      const messageId = await ctx.runMutation(internal.conversations.internalSendMessage, {
        conversationId: body.conversationId as Id<"conversations">,
        content: body.content ?? "",
        contentType: body.contentType || "text",
        isInternal: body.isInternal || false,
        attachments,
        mentionedUserIds: body.mentionedUserIds,
        replyToMessageId: body.replyToMessageId
          ? (body.replyToMessageId as Id<"messages">)
          : undefined,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true, messageId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Send a WhatsApp template message (re-engagement outside the 24h window)
http.route({
  path: "/api/v1/conversations/send-template",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.conversationId || !body.templateName || !body.languageCode) {
        return errorResponse("conversationId, templateName and languageCode required", 400);
      }

      const messageId = await ctx.runMutation(internal.conversations.internalSendTemplate, {
        conversationId: body.conversationId as Id<"conversations">,
        teamMemberId: apiKeyRecord.teamMemberId,
        templateName: body.templateName,
        languageCode: body.languageCode,
        components: body.components,
      });

      return jsonResponse({ success: true, messageId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Receive an inbound message from a contact (external bridges for any channel)
http.route({
  path: "/api/v1/conversations/receive",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();

      if (!body.content) {
        return errorResponse("content required", 400);
      }
      if (!body.contactId && !body.contactPhone) {
        return errorResponse("contactId or contactPhone required", 400);
      }
      const channel = body.channel || "whatsapp";

      // Resolve contact
      let contactId: Id<"contacts">;
      if (body.contactId) {
        contactId = body.contactId as Id<"contacts">;
        const contact = await ctx.runQuery(internal.contacts.internalGetContact, {
          contactId,
          organizationId: apiKeyRecord.organizationId,
        });
        if (!contact) {
          return errorResponse("Contact not found", 404);
        }
      } else {
        contactId = await ctx.runMutation(internal.contacts.internalFindOrCreateContact, {
          organizationId: apiKeyRecord.organizationId,
          phone: body.contactPhone,
          firstName: body.contactFirstName,
          lastName: body.contactLastName,
        });
      }

      // Find the contact's most recent lead, or create one on the default board
      // (shared inbound routing — same logic as the WhatsApp webhook ingress)
      const leadId: Id<"leads"> = await ctx.runMutation(internal.leads.internalEnsureLeadForContact, {
        organizationId: apiKeyRecord.organizationId,
        contactId,
        title: body.leadTitle,
      });

      const messageId = await ctx.runMutation(internal.conversations.internalReceiveMessage, {
        organizationId: apiKeyRecord.organizationId,
        leadId,
        channel,
        content: body.content,
        contentType: body.contentType || "text",
        externalId: body.externalId,
        metadata: body.metadata,
      });

      return jsonResponse({ success: true, messageId, leadId, contactId }, 201);
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
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.handoffs.internalGetHandoffs, {
        organizationId: apiKeyRecord.organizationId,
        status: status || undefined,
        limit,
        cursor,
      });

      return jsonResponse(result as any);
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

// ---- File Storage Endpoints ----

// Generate upload URL
http.route({
  path: "/api/v1/files/upload-url",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);

      const uploadUrl = await ctx.runMutation(internal.files.internalGenerateUploadUrl, {
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ uploadUrl });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Save file metadata after upload
http.route({
  path: "/api/v1/files",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();

      if (!body.storageId || !body.name || !body.mimeType || !body.size || !body.fileType) {
        return errorResponse("storageId, name, mimeType, size, and fileType are required", 400);
      }

      const fileId = await ctx.runMutation(internal.files.internalSaveFile, {
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
        storageId: body.storageId,
        name: body.name,
        mimeType: body.mimeType,
        size: body.size,
        fileType: body.fileType,
        messageId: body.messageId ? (body.messageId as Id<"messages">) : undefined,
        contactId: body.contactId ? (body.contactId as Id<"contacts">) : undefined,
        leadId: body.leadId ? (body.leadId as Id<"leads">) : undefined,
        metadata: body.metadata,
      });

      return jsonResponse({ success: true, fileId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get file download URL
http.route({
  path: "/api/v1/files/:id/url",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const fileId = url.pathname.split("/")[4]; // Extract ID from path

      if (!fileId) return errorResponse("File ID required", 400);

      const fileUrl = await ctx.runQuery(internal.files.internalGetFileUrl, {
        fileId: fileId as Id<"files">,
        organizationId: apiKeyRecord.organizationId,
      });

      if (!fileUrl) return errorResponse("File not found", 404);

      return jsonResponse({ url: fileUrl });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Delete file
http.route({
  path: "/api/v1/files/:id",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const fileId = url.pathname.split("/")[4]; // Extract ID from path

      if (!fileId) return errorResponse("File ID required", 400);

      await ctx.runMutation(internal.files.internalDeleteFile, {
        fileId: fileId as Id<"files">,
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Reference Endpoints ----

// Get boards with stages
http.route({
  path: "/api/v1/boards",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const boards = await ctx.runQuery(internal.boards.internalGetBoards, {
        organizationId: apiKeyRecord.organizationId,
      });
      const boardsWithStages = await Promise.all(
        boards.map(async (board: any) => {
          const stages = await ctx.runQuery(internal.boards.internalGetStages, {
            boardId: board._id,
          });
          return { ...board, stages };
        })
      );
      return jsonResponse({ boards: boardsWithStages });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get team members
http.route({
  path: "/api/v1/team-members",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const members = await ctx.runQuery(internal.teamMembers.internalGetTeamMembers, {
        organizationId: apiKeyRecord.organizationId,
      });
      return jsonResponse({ members });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get field definitions
http.route({
  path: "/api/v1/field-definitions",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const fields = await ctx.runQuery(internal.fieldDefinitions.internalGetFieldDefinitions, {
        organizationId: apiKeyRecord.organizationId,
      });
      return jsonResponse({ fields });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Activity Endpoints ----

// Get activities for a lead
http.route({
  path: "/api/v1/activities",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const leadId = url.searchParams.get("leadId");
      if (!leadId) return errorResponse("leadId required", 400);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.activities.internalGetActivities, {
        leadId: leadId as Id<"leads">,
        limit,
        cursor,
      });

      return jsonResponse(result as any);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Create activity on a lead
http.route({
  path: "/api/v1/activities",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.leadId) return errorResponse("leadId required", 400);
      if (!body.type) return errorResponse("type required", 400);

      const activityId = await ctx.runMutation(internal.activities.internalCreateActivity, {
        leadId: body.leadId as Id<"leads">,
        type: body.type,
        content: body.content,
        metadata: body.metadata,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true, activityId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Dashboard Endpoint ----

// Get dashboard analytics
http.route({
  path: "/api/v1/dashboard",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);

      const stats = await ctx.runQuery(internal.dashboard.internalGetDashboardStats, {
        organizationId: apiKeyRecord.organizationId,
      });

      return jsonResponse(stats);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Contact Search Endpoint ----

// Search contacts by text
http.route({
  path: "/api/v1/contacts/search",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const q = url.searchParams.get("q");
      if (!q) return errorResponse("q (search query) required", 400);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);

      const contacts = await ctx.runQuery(internal.contacts.internalSearchContacts, {
        organizationId: apiKeyRecord.organizationId,
        searchText: q,
        limit,
      });

      return jsonResponse({ contacts });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Lead Sources Endpoint ----

// Get lead sources
http.route({
  path: "/api/v1/lead-sources",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);

      const sources = await ctx.runQuery(internal.leadSources.internalGetLeadSources, {
        organizationId: apiKeyRecord.organizationId,
      });

      return jsonResponse({ sources });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Audit Log Endpoints ----

http.route({
  path: "/api/v1/audit-logs",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);

      const entityType = url.searchParams.get("entityType") || undefined;
      const action = url.searchParams.get("action") as any || undefined;
      const severity = url.searchParams.get("severity") as any || undefined;
      const actorId = url.searchParams.get("actorId") as Id<"teamMembers"> | undefined || undefined;
      const startDate = url.searchParams.get("startDate") ? Number(url.searchParams.get("startDate")) : undefined;
      const endDate = url.searchParams.get("endDate") ? Number(url.searchParams.get("endDate")) : undefined;
      const cursor = url.searchParams.get("cursor") || undefined;
      const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 200) : undefined;

      const result = await ctx.runQuery(internal.auditLogs.internalGetAuditLogs, {
        organizationId: apiKeyRecord.organizationId,
        entityType,
        action,
        severity,
        actorId,
        startDate,
        endDate,
        cursor,
        limit,
      });

      return jsonResponse(result as any);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Public Form Endpoints (no auth) ----

// Get published form by slug — GET /api/v1/forms/public?slug=xxx
http.route({
  path: "/api/v1/forms/public",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const slug = url.searchParams.get("slug");

      if (!slug) return errorResponse("slug query parameter is required", 400);

      const form = await ctx.runQuery(internal.forms.internalGetPublishedForm, { slug });
      if (!form) return errorResponse("Form not found", 404);

      // Return sanitized form data (strip internal fields)
      const sanitized = {
        name: form.name,
        description: form.description,
        fields: form.fields,
        steps: form.steps,
        theme: form.theme,
        settings: {
          submitButtonText: form.settings.submitButtonText,
          successMessage: form.settings.successMessage,
          redirectUrl: form.settings.redirectUrl,
          honeypotEnabled: form.settings.honeypotEnabled,
          successTitle: form.settings.successTitle,
          successSubtitle: form.settings.successSubtitle,
          successCta: form.settings.successCta,
          partialCaptureEnabled: form.settings.partialCaptureEnabled,
        },
      };

      // Check for active A/B experiment on this form
      const experiment = await ctx.runQuery(internal.formExperiments.internalGetActiveExperiment, { formId: form._id });

      return jsonResponse({ form: sanitized, experiment: experiment ?? undefined });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Track A/B experiment view — POST /api/v1/forms/experiment/view
http.route({
  path: "/api/v1/forms/experiment/view",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = await request.json();
      const { variantId } = body;

      if (!variantId) return errorResponse("variantId is required", 400);

      await ctx.runMutation(internal.formExperiments.internalRecordView, {
        variantId: variantId as Id<"formExperimentVariants">,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

http.route({
  path: "/api/v1/forms/experiment/view",
  method: "OPTIONS",
  handler: httpAction(async () => handleOptions()),
});

// Submit form — POST /api/v1/forms/public/submit { slug, data, _honeypot }
http.route({
  path: "/api/v1/forms/public/submit",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = await request.json();
      const { slug, data, _honeypot, sessionId } = body;

      if (!slug || typeof slug !== "string") {
        return errorResponse("slug is required", 400);
      }

      if (!data || typeof data !== "object") {
        return errorResponse("data object is required", 400);
      }

      const form = await ctx.runQuery(internal.forms.internalGetPublishedForm, { slug });
      if (!form) return errorResponse("Form not found", 404);

      // Extract metadata from request
      const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("cf-connecting-ip") || undefined;
      const userAgent = request.headers.get("user-agent") || undefined;
      const referrer = request.headers.get("referer") || undefined;

      // Extract UTM params from referrer as fallback
      let utmSource: string | undefined;
      let utmMedium: string | undefined;
      let utmCampaign: string | undefined;

      if (referrer) {
        try {
          const refUrl = new URL(referrer);
          utmSource = refUrl.searchParams.get("utm_source") || undefined;
          utmMedium = refUrl.searchParams.get("utm_medium") || undefined;
          utmCampaign = refUrl.searchParams.get("utm_campaign") || undefined;
        } catch {
          // Invalid referrer URL, ignore
        }
      }

      // Body UTM values take priority over referrer-parsed ones
      utmSource = body.utmSource || utmSource;
      utmMedium = body.utmMedium || utmMedium;
      utmCampaign = body.utmCampaign || utmCampaign;
      const utmContent: string | undefined = body.utmContent || undefined;
      const utmTerm: string | undefined = body.utmTerm || undefined;

      const honeypotTriggered = !!_honeypot;

      const result = await ctx.runMutation(internal.formSubmissions.internalProcessSubmission, {
        formId: form._id,
        data,
        ipAddress,
        userAgent,
        referrer,
        utmSource,
        utmMedium,
        utmCampaign,
        utmContent,
        utmTerm,
        honeypotTriggered,
        sessionId: sessionId || undefined,
        experimentId: body.experimentId || undefined,
        variantId: body.variantId || undefined,
        visitorId: body.visitorId || undefined,
      });

      // Phase 6: Return proper status codes for validation/duplicate errors
      if (result && result.validation === true) {
        return new Response(JSON.stringify(result), {
          status: 422,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      if (result && result.duplicate === true) {
        return new Response(JSON.stringify(result), {
          status: 409,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return jsonResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      const status = message.includes("not found") ? 404 : message.includes("limit") ? 400 : 500;
      return errorResponse(message, status);
    }
  }),
});

// Save partial form submission — POST /api/v1/forms/public/partial
http.route({
  path: "/api/v1/forms/public/partial",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      // Parse body — sendBeacon sends as text/plain, so always parse as JSON string
      const contentType = request.headers.get("content-type") || "";
      let body: any;
      if (contentType.includes("text/plain")) {
        const text = await request.text();
        body = JSON.parse(text);
      } else {
        body = await request.json();
      }

      const { slug, sessionId, data, completedFieldIds, currentStep, totalFields } = body;

      if (!slug || typeof slug !== "string") {
        return errorResponse("slug is required", 400);
      }
      if (!sessionId || typeof sessionId !== "string") {
        return errorResponse("sessionId is required", 400);
      }
      if (!data || typeof data !== "object") {
        return errorResponse("data object is required", 400);
      }
      if (!Array.isArray(completedFieldIds)) {
        return errorResponse("completedFieldIds array is required", 400);
      }
      if (typeof totalFields !== "number") {
        return errorResponse("totalFields number is required", 400);
      }

      const form = await ctx.runQuery(internal.forms.internalGetPublishedForm, { slug });
      if (!form) return errorResponse("Form not found", 404);

      // Check if partial capture is enabled for this form
      if (!form.settings.partialCaptureEnabled) {
        return jsonResponse({ ignored: true });
      }

      // Extract metadata from request headers
      const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("cf-connecting-ip") || undefined;
      const userAgent = request.headers.get("user-agent") || undefined;
      const referrer = request.headers.get("referer") || undefined;

      // Extract UTM params from referrer as fallback
      let utmSource: string | undefined;
      let utmMedium: string | undefined;
      let utmCampaign: string | undefined;

      if (referrer) {
        try {
          const refUrl = new URL(referrer);
          utmSource = refUrl.searchParams.get("utm_source") || undefined;
          utmMedium = refUrl.searchParams.get("utm_medium") || undefined;
          utmCampaign = refUrl.searchParams.get("utm_campaign") || undefined;
        } catch {
          // Invalid referrer URL, ignore
        }
      }

      // Body UTM values take priority over referrer-parsed ones
      utmSource = body.utmSource || utmSource;
      utmMedium = body.utmMedium || utmMedium;
      utmCampaign = body.utmCampaign || utmCampaign;
      const utmContent: string | undefined = body.utmContent || undefined;
      const utmTerm: string | undefined = body.utmTerm || undefined;

      await ctx.runMutation(internal.formPartials.internalSavePartial, {
        formId: form._id,
        sessionId,
        data,
        completedFieldIds,
        totalFields,
        currentStep,
        ipAddress,
        userAgent,
        referrer,
        utmSource,
        utmMedium,
        utmCampaign,
        utmContent,
        utmTerm,
        experimentId: body.experimentId || undefined,
        variantId: body.variantId || undefined,
        visitorId: body.visitorId || undefined,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      const status = message.includes("not found") ? 404 : 500;
      return errorResponse(message, status);
    }
  }),
});

// ---- Embed Script ----

http.route({
  path: "/api/v1/embed.js",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(EMBED_SCRIPT, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }),
});

http.route({
  path: "/api/v1/embed.js",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// ---- LLMs.txt Routes ----

http.route({
  path: "/llms.txt",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(LLMS_TXT, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
    });
  }),
});

http.route({
  path: "/llms-full.txt",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(LLMS_FULL_TXT, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders },
    });
  }),
});

// ---- OpenAPI Spec ----

http.route({
  path: "/api/v1/openapi.json",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(OPENAPI_SPEC, {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }),
});

// ---- Task Endpoints ----

// Get tasks (with filters + cursor pagination)
http.route({
  path: "/api/v1/tasks",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);

      const status = url.searchParams.get("status") as any || undefined;
      const priority = url.searchParams.get("priority") as any || undefined;
      const assignedTo = url.searchParams.get("assignedTo");
      const leadId = url.searchParams.get("leadId");
      const contactId = url.searchParams.get("contactId");
      const type = url.searchParams.get("type") as any || undefined;
      const activityType = url.searchParams.get("activityType") as any || undefined;
      const dueBefore = url.searchParams.get("dueBefore") ? Number(url.searchParams.get("dueBefore")) : undefined;
      const dueAfter = url.searchParams.get("dueAfter") ? Number(url.searchParams.get("dueAfter")) : undefined;
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.tasks.internalGetTasks, {
        organizationId: apiKeyRecord.organizationId,
        status,
        priority,
        assignedTo: assignedTo ? (assignedTo as Id<"teamMembers">) : undefined,
        leadId: leadId ? (leadId as Id<"leads">) : undefined,
        contactId: contactId ? (contactId as Id<"contacts">) : undefined,
        type,
        activityType,
        dueBefore,
        dueAfter,
        limit,
        cursor,
      });

      return jsonResponse(result as any);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get single task
http.route({
  path: "/api/v1/tasks/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const taskId = url.searchParams.get("id");
      if (!taskId) return errorResponse("Task ID required", 400);

      const task = await ctx.runQuery(internal.tasks.internalGetTask, {
        taskId: taskId as Id<"tasks">,
      });

      if (!task) return errorResponse("Task not found", 404);
      return jsonResponse({ task });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get my tasks (agent's queue)
http.route({
  path: "/api/v1/tasks/my",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);

      const tasks = await ctx.runQuery(internal.tasks.internalGetMyTasks, {
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ tasks });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get overdue tasks
http.route({
  path: "/api/v1/tasks/overdue",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.tasks.internalGetOverdueTasks, {
        organizationId: apiKeyRecord.organizationId,
        limit,
        cursor,
      });

      return jsonResponse(result as any);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Search tasks
http.route({
  path: "/api/v1/tasks/search",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const q = url.searchParams.get("q");
      if (!q) return errorResponse("q (search query) required", 400);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);

      const tasks = await ctx.runQuery(internal.tasks.internalSearchTasks, {
        organizationId: apiKeyRecord.organizationId,
        searchText: q,
        limit,
      });

      return jsonResponse({ tasks });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Create task
http.route({
  path: "/api/v1/tasks/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.title) return errorResponse("title required", 400);

      const taskId = await ctx.runMutation(internal.tasks.internalCreateTask, {
        organizationId: apiKeyRecord.organizationId,
        title: body.title,
        type: body.type || "task",
        priority: body.priority || "medium",
        activityType: body.activityType,
        description: body.description,
        dueDate: body.dueDate,
        leadId: body.leadId ? (body.leadId as Id<"leads">) : undefined,
        contactId: body.contactId ? (body.contactId as Id<"contacts">) : undefined,
        assignedTo: body.assignedTo ? (body.assignedTo as Id<"teamMembers">) : undefined,
        recurrence: body.recurrence,
        checklist: body.checklist,
        tags: body.tags,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true, taskId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Update task
http.route({
  path: "/api/v1/tasks/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.taskId) return errorResponse("taskId required", 400);

      await ctx.runMutation(internal.tasks.internalUpdateTask, {
        taskId: body.taskId as Id<"tasks">,
        title: body.title,
        description: body.description,
        priority: body.priority,
        activityType: body.activityType,
        dueDate: body.dueDate,
        tags: body.tags,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Complete task
http.route({
  path: "/api/v1/tasks/complete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.taskId) return errorResponse("taskId required", 400);

      await ctx.runMutation(internal.tasks.internalCompleteTask, {
        taskId: body.taskId as Id<"tasks">,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Delete task
http.route({
  path: "/api/v1/tasks/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.taskId) return errorResponse("taskId required", 400);

      await ctx.runMutation(internal.tasks.internalDeleteTask, {
        taskId: body.taskId as Id<"tasks">,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Assign task
http.route({
  path: "/api/v1/tasks/assign",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.taskId) return errorResponse("taskId required", 400);

      await ctx.runMutation(internal.tasks.internalAssignTask, {
        taskId: body.taskId as Id<"tasks">,
        assignedTo: body.assignedTo ? (body.assignedTo as Id<"teamMembers">) : undefined,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Snooze task
http.route({
  path: "/api/v1/tasks/snooze",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.taskId || !body.snoozedUntil) return errorResponse("taskId and snoozedUntil required", 400);

      await ctx.runMutation(internal.tasks.internalSnoozeTask, {
        taskId: body.taskId as Id<"tasks">,
        snoozedUntil: body.snoozedUntil,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Bulk task operations
http.route({
  path: "/api/v1/tasks/bulk",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.taskIds || !body.action) return errorResponse("taskIds and action required", 400);

      await ctx.runMutation(internal.tasks.internalBulkUpdate, {
        taskIds: body.taskIds as Id<"tasks">[],
        action: body.action,
        assignedTo: body.assignedTo ? (body.assignedTo as Id<"teamMembers">) : undefined,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get task comments
http.route({
  path: "/api/v1/tasks/comments",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const taskId = url.searchParams.get("taskId");
      if (!taskId) return errorResponse("taskId required", 400);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.taskComments.internalGetComments, {
        taskId: taskId as Id<"tasks">,
        limit,
        cursor,
      });

      return jsonResponse(result as any);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Add task comment
http.route({
  path: "/api/v1/tasks/comments/add",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.taskId || !body.content) return errorResponse("taskId and content required", 400);

      const commentId = await ctx.runMutation(internal.taskComments.internalAddComment, {
        taskId: body.taskId as Id<"tasks">,
        content: body.content,
        isInternal: body.isInternal,
        mentionedUserIds: body.mentionedUserIds,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true, commentId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Calendar Event Endpoints ----

// Get calendar events (startDate, endDate required)
http.route({
  path: "/api/v1/calendar/events",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const url = new URL(request.url);

      const startDate = url.searchParams.get("startDate");
      const endDate = url.searchParams.get("endDate");
      if (!startDate || !endDate) return errorResponse("startDate and endDate required", 400);

      const assignedTo = url.searchParams.get("assignedTo");
      const eventType = url.searchParams.get("eventType") as any || undefined;
      const status = url.searchParams.get("status") as any || undefined;
      const leadId = url.searchParams.get("leadId");
      const contactId = url.searchParams.get("contactId");
      const limit = url.searchParams.get("limit") ? Math.min(Number(url.searchParams.get("limit")), 500) : undefined;
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.calendar.internalGetEvents, {
        organizationId: apiKeyRecord.organizationId,
        startDate: Number(startDate),
        endDate: Number(endDate),
        assignedTo: assignedTo ? (assignedTo as Id<"teamMembers">) : undefined,
        eventType,
        status,
        leadId: leadId ? (leadId as Id<"leads">) : undefined,
        contactId: contactId ? (contactId as Id<"contacts">) : undefined,
        limit,
        cursor,
      });

      return jsonResponse(result as any);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Get single calendar event
http.route({
  path: "/api/v1/calendar/events/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      await authenticateApiKey(ctx, request);
      const url = new URL(request.url);
      const eventId = url.searchParams.get("id");
      if (!eventId) return errorResponse("Event ID required", 400);

      const event = await ctx.runQuery(internal.calendar.internalGetEvent, {
        eventId: eventId as Id<"calendarEvents">,
      });

      if (!event) return errorResponse("Event not found", 404);
      return jsonResponse({ event });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Create calendar event
http.route({
  path: "/api/v1/calendar/events/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.title) return errorResponse("title required", 400);
      if (!body.startTime || !body.endTime) return errorResponse("startTime and endTime required", 400);

      const eventId = await ctx.runMutation(internal.calendar.internalCreateEvent, {
        organizationId: apiKeyRecord.organizationId,
        title: body.title,
        description: body.description,
        eventType: body.eventType || "other",
        startTime: body.startTime,
        endTime: body.endTime,
        allDay: body.allDay,
        leadId: body.leadId ? (body.leadId as Id<"leads">) : undefined,
        contactId: body.contactId ? (body.contactId as Id<"contacts">) : undefined,
        attendees: body.attendees,
        assignedTo: body.assignedTo ? (body.assignedTo as Id<"teamMembers">) : undefined,
        location: body.location,
        meetingUrl: body.meetingUrl,
        color: body.color,
        recurrence: body.recurrence,
        notes: body.notes,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true, eventId }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Update calendar event
http.route({
  path: "/api/v1/calendar/events/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.eventId) return errorResponse("eventId required", 400);

      await ctx.runMutation(internal.calendar.internalUpdateEvent, {
        eventId: body.eventId as Id<"calendarEvents">,
        title: body.title,
        description: body.description,
        eventType: body.eventType,
        startTime: body.startTime,
        endTime: body.endTime,
        allDay: body.allDay,
        location: body.location,
        meetingUrl: body.meetingUrl,
        notes: body.notes,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Delete calendar event
http.route({
  path: "/api/v1/calendar/events/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.eventId) return errorResponse("eventId required", 400);

      await ctx.runMutation(internal.calendar.internalDeleteEvent, {
        eventId: body.eventId as Id<"calendarEvents">,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Reschedule calendar event
http.route({
  path: "/api/v1/calendar/events/reschedule",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.eventId || !body.newStartTime) return errorResponse("eventId and newStartTime required", 400);

      await ctx.runMutation(internal.calendar.internalRescheduleEvent, {
        eventId: body.eventId as Id<"calendarEvents">,
        newStartTime: body.newStartTime,
        newEndTime: body.newEndTime,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// Complete calendar event
http.route({
  path: "/api/v1/calendar/events/complete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      if (!body.eventId) return errorResponse("eventId required", 400);

      await ctx.runMutation(internal.calendar.internalCompleteEvent, {
        eventId: body.eventId as Id<"calendarEvents">,
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Notification Preferences Endpoints ----

http.route({
  path: "/api/v1/notifications/preferences",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const prefs = await ctx.runQuery(internal.notificationPreferences.internalGetPreferences, {
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ preferences: prefs });
    } catch (e: any) {
      return errorResponse(e.message, e.message.includes("API key") ? 401 : 400);
    }
  }),
});

http.route({
  path: "/api/v1/notifications/preferences",
  method: "PUT",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const body = await request.json();
      await ctx.runMutation(internal.notificationPreferences.internalUpsertPreferences, {
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
        updates: body,
      });
      // Return the updated preferences
      const prefs = await ctx.runQuery(internal.notificationPreferences.internalGetPreferences, {
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ preferences: prefs });
    } catch (e: any) {
      return errorResponse(e.message, e.message.includes("API key") ? 401 : 400);
    }
  }),
});

// ---- Resend Webhook Endpoint ----

http.route({
  path: "/api/v1/webhooks/resend",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    return await resend.handleResendEventWebhook(ctx, request);
  }),
});

// ---- WhatsApp Cloud API webhooks (multi-tenant: routed by phone_number_id) ----

http.route({ path: "/webhooks/whatsapp", method: "GET", handler: whatsappWebhookVerify });
http.route({ path: "/webhooks/whatsapp", method: "POST", handler: whatsappWebhookReceive });
http.route({ path: "/webhooks/bridge", method: "POST", handler: bridgeWebhookReceive });

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
http.route({ path: "/api/v1/conversations/receive", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/conversations/send-template", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/handoffs", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/handoffs/pending", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/handoffs/accept", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/handoffs/reject", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/boards", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/team-members", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/field-definitions", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/activities", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/dashboard", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/contacts/search", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/lead-sources", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/audit-logs", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/openapi.json", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/my", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/overdue", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/search", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/create", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/update", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/complete", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/delete", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/assign", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/snooze", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/bulk", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/comments", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/tasks/comments/add", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/calendar/events", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/calendar/events/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/calendar/events/create", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/calendar/events/update", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/calendar/events/delete", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/calendar/events/reschedule", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/calendar/events/complete", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/files/upload-url", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/files", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/files/:id/url", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/files/:id", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/notifications/preferences", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/webhooks/resend", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/forms/public", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/forms/public/submit", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/forms/public/partial", method: "OPTIONS", handler: optionsHandler });

export default http;
