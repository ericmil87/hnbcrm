import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { LLMS_TXT, LLMS_FULL_TXT } from "./llmsTxt";
import { EMBED_SCRIPT } from "./embedScript";
import { OPENAPI_SPEC } from "./openapiSpec";
import {
  hasPermission,
  resolvePermissions,
  type Role,
  type Permissions,
  type PermissionCategory,
} from "./lib/permissions";
import { encodeHeaderKey } from "./lib/importKeys";
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

// ---- Enforcement de permissão das rotas /api/v1 ----
//
// TODA rota autenticada por `X-API-Key` declara aqui a permissão mínima que a
// chave precisa ter. O nível ESPELHA a função equivalente do app:
//   • quando a função pública usa `requirePermission(ctx, org, cat, nível)`,
//     a rota exige o MESMO par (ex.: leads.deleteLead → `leads: full`);
//   • quando usa só `requireAuth` (qualquer membro da org), a rota exige o
//     MENOR nível de leitura da categoria (ex.: `leads: view_own`) — a REST
//     não fica mais frouxa nem mais rígida que a UI.
// Rotas sem equivalente público (ingestão/enriquecimento) usam o nível de
// escrita da categoria. Ver a tabela em `.claude/skills/hnbcrm/references/
// API_REFERENCE.md` e em `/llms.txt`.

/** Par categoria+nível de uma rota (o nível é validado contra a categoria pelo TS). */
export type RoutePermission = {
  [C in PermissionCategory]: { category: C; level: Permissions[C] };
}[PermissionCategory];

/**
 * `"authenticated"` = basta uma API key válida, sem nível de categoria — usado
 * SOMENTE onde a função equivalente do app usa `requireAuth` puro e a rota é
 * de leitura da própria org / self-scoped. Não é mais permissivo que o app.
 */
export type RouteAccess = RoutePermission | "authenticated";

/** Mensagem única de negação (o corpo do 403 é idêntico em todas as rotas). */
export const PERMISSION_DENIED_MESSAGE = "Permissão insuficiente";

/**
 * Permissão exigida por rota. Chave = `"MÉTODO /caminho"`, com o caminho
 * REGISTRADO em `http.route` (padrões com `:id`, não o caminho concreto).
 * O comentário de cada entrada aponta a função do app que ditou o nível.
 */
export const ROUTE_PERMISSIONS: Record<string, RouteAccess> = {
  // Leads — convex/leads.ts
  "POST /api/v1/inbound/lead": { category: "leads", level: "edit_own" }, // leads.createLead (captura universal)
  "GET /api/v1/leads": { category: "leads", level: "view_own" }, // leads.getLeads (requireAuth)
  "GET /api/v1/leads/get": { category: "leads", level: "view_own" }, // leads.getLead (requireAuth)
  "POST /api/v1/leads/update": { category: "leads", level: "view_own" }, // leads.updateLead (requireAuth)
  "POST /api/v1/leads/delete": { category: "leads", level: "full" }, // leads.deleteLead
  "POST /api/v1/leads/move-stage": { category: "leads", level: "view_own" }, // leads.moveLeadToStage (requireAuth)
  "POST /api/v1/leads/assign": { category: "leads", level: "view_own" }, // leads.assignLead (requireAuth)
  "POST /api/v1/leads/handoff": { category: "inbox", level: "view_own" }, // handoffs.requestHandoff (requireAuth)

  // Contatos — convex/contacts.ts
  "GET /api/v1/contacts": { category: "contacts", level: "view" }, // contacts.getContacts (requireAuth)
  "POST /api/v1/contacts/create": { category: "contacts", level: "edit" }, // contacts.createContact
  "GET /api/v1/contacts/get": { category: "contacts", level: "view" }, // contacts.getContact (requireAuth)
  "POST /api/v1/contacts/update": { category: "contacts", level: "view" }, // contacts.updateContact (requireAuth)
  "POST /api/v1/contacts/enrich": { category: "contacts", level: "edit" }, // só internalMutation → nível de escrita
  "GET /api/v1/contacts/gaps": { category: "contacts", level: "view" }, // contacts.getContactEnrichmentGaps (requireAuth)
  "GET /api/v1/contacts/search": { category: "contacts", level: "view" }, // contacts.searchContacts (requireAuth)

  // Conversas — convex/conversations.ts
  "GET /api/v1/conversations": { category: "inbox", level: "view_own" }, // conversations.getConversations (requireAuth)
  "GET /api/v1/conversations/messages": { category: "inbox", level: "view_own" }, // conversations.getMessages (requireAuth)
  "POST /api/v1/conversations/send": { category: "inbox", level: "view_own" }, // conversations.sendMessage (requireAuth)
  "POST /api/v1/conversations/send-template": { category: "inbox", level: "reply" }, // só internalMutation → nível de escrita
  "POST /api/v1/conversations/receive": { category: "inbox", level: "reply" }, // ingestão externa, sem equivalente público

  // Repasses — convex/handoffs.ts
  "GET /api/v1/handoffs": { category: "inbox", level: "view_own" }, // handoffs.getHandoffs
  "GET /api/v1/handoffs/pending": { category: "inbox", level: "view_own" }, // handoffs.getHandoffs
  "POST /api/v1/handoffs/accept": { category: "inbox", level: "reply" }, // handoffs.acceptHandoff
  "POST /api/v1/handoffs/reject": { category: "inbox", level: "reply" }, // handoffs.rejectHandoff

  // Arquivos — convex/files.ts (a categoria do módulo é `leads`)
  "POST /api/v1/files/upload-url": { category: "leads", level: "edit_own" }, // files.generateUploadUrl
  "POST /api/v1/files": { category: "leads", level: "edit_own" }, // files.saveFile
  "GET /api/v1/files/:id/url": { category: "leads", level: "view_own" }, // files.getFileUrl (requireAuth)
  "DELETE /api/v1/files/:id": { category: "leads", level: "edit_own" }, // files.deleteFile

  // Export / Import — convex/exports.ts + convex/imports.ts
  "POST /api/v1/exports": { category: "settings", level: "manage" }, // exports.createExportJob
  "GET /api/v1/exports": { category: "settings", level: "manage" }, // exports.listExportJobs
  "GET /api/v1/exports/get": { category: "settings", level: "manage" }, // exports.getExportJob
  "GET /api/v1/exports/download": { category: "settings", level: "manage" }, // exports.getDownloadUrl
  "POST /api/v1/imports": { category: "settings", level: "manage" }, // imports.createImportJob
  "GET /api/v1/imports": { category: "settings", level: "manage" }, // imports.listImportJobs
  "GET /api/v1/imports/get": { category: "settings", level: "manage" }, // imports.getImportJob
  "POST /api/v1/imports/mapping": { category: "settings", level: "manage" }, // imports.updateMapping
  "POST /api/v1/imports/preview": { category: "settings", level: "manage" }, // imports.runPreview
  "POST /api/v1/imports/confirm": { category: "settings", level: "manage" }, // imports.confirmImport
  "POST /api/v1/imports/rollback": { category: "settings", level: "manage" }, // imports.rollbackImport
  "GET /api/v1/imports/failed-rows": { category: "settings", level: "manage" }, // imports.getFailedRowsCsv

  // Referência (leitura de configuração do funil)
  "GET /api/v1/boards": { category: "leads", level: "view_own" }, // boards.getBoards (requireAuth)
  "GET /api/v1/team-members": "authenticated", // teamMembers.getTeamMembers usa requireAuth puro — qualquer membro vê a equipe no app; team:view aqui seria MAIS rígido que o app e quebraria crm_list_team p/ keys ai/agent
  "GET /api/v1/field-definitions": { category: "leads", level: "view_own" }, // fieldDefinitions.getFieldDefinitions (membro da org)
  "GET /api/v1/lead-sources": { category: "leads", level: "view_own" }, // leadSources.getLeadSources (membro da org)

  // Atividades — convex/activities.ts (membro da org)
  "GET /api/v1/activities": { category: "leads", level: "view_own" }, // activities.getActivities
  "POST /api/v1/activities": { category: "leads", level: "view_own" }, // activities.createActivity

  // Painel e auditoria
  "GET /api/v1/dashboard": { category: "reports", level: "view" }, // dashboard.getDashboardStats (requireAuth)
  "GET /api/v1/audit-logs": { category: "auditLogs", level: "view" }, // auditLogs.getAuditLogs (requireAuth)

  // Tarefas — convex/tasks.ts + convex/taskComments.ts (todas com requireAuth)
  "GET /api/v1/tasks": { category: "tasks", level: "view_own" }, // tasks.getTasks
  "GET /api/v1/tasks/get": { category: "tasks", level: "view_own" }, // tasks.getTask
  "GET /api/v1/tasks/my": { category: "tasks", level: "view_own" }, // tasks.getMyTasks
  "GET /api/v1/tasks/overdue": { category: "tasks", level: "view_own" }, // tasks.getTasks
  "GET /api/v1/tasks/search": { category: "tasks", level: "view_own" }, // tasks.searchTasks
  "POST /api/v1/tasks/create": { category: "tasks", level: "view_own" }, // tasks.createTask
  "POST /api/v1/tasks/update": { category: "tasks", level: "view_own" }, // tasks.updateTask
  "POST /api/v1/tasks/complete": { category: "tasks", level: "view_own" }, // tasks.completeTask
  "POST /api/v1/tasks/delete": { category: "tasks", level: "view_own" }, // tasks.deleteTask
  "POST /api/v1/tasks/assign": { category: "tasks", level: "view_own" }, // tasks.assignTask
  "POST /api/v1/tasks/snooze": { category: "tasks", level: "view_own" }, // tasks.snoozeTask
  "POST /api/v1/tasks/bulk": { category: "tasks", level: "view_own" }, // tasks.bulkUpdateTasks
  "GET /api/v1/tasks/comments": { category: "tasks", level: "view_own" }, // taskComments.getComments
  "POST /api/v1/tasks/comments/add": { category: "tasks", level: "view_own" }, // taskComments.addComment

  // Agenda — convex/calendar.ts (requireAuth; a navegação do app usa `tasks`)
  "GET /api/v1/calendar/events": { category: "tasks", level: "view_own" }, // calendar.getEvents
  "GET /api/v1/calendar/events/get": { category: "tasks", level: "view_own" }, // calendar.getEvent
  "POST /api/v1/calendar/events/create": { category: "tasks", level: "view_own" }, // calendar.createEvent
  "POST /api/v1/calendar/events/update": { category: "tasks", level: "view_own" }, // calendar.updateEvent
  "POST /api/v1/calendar/events/delete": { category: "tasks", level: "view_own" }, // calendar.deleteEvent
  "POST /api/v1/calendar/events/reschedule": { category: "tasks", level: "view_own" }, // calendar.rescheduleEvent
  "POST /api/v1/calendar/events/complete": { category: "tasks", level: "view_own" }, // calendar.completeEvent

  // Preferências de notificação — convex/notificationPreferences.ts
  "GET /api/v1/notifications/preferences": "authenticated", // rota self-scoped (preferências do PRÓPRIO membro da key) — espelha requireAuth de notificationPreferences.getMyPreferences; team:view no app é só p/ ver preferências de OUTRO membro
  "PUT /api/v1/notifications/preferences": "authenticated", // idem (escrita self-scoped)

  // Campanhas de WhatsApp — convex/campaigns.ts (categoria `campaigns`: view < manage < full)
  "GET /api/v1/campaigns": { category: "campaigns", level: "view" }, // campaigns.listCampaigns
  "GET /api/v1/campaigns/get": { category: "campaigns", level: "view" }, // campaigns.getCampaign
  "GET /api/v1/campaigns/report": { category: "campaigns", level: "view" }, // campaigns.getCampaignReport
  "GET /api/v1/campaigns/recipients": { category: "campaigns", level: "view" }, // campaigns.getCampaignRecipients
  "GET /api/v1/campaigns/safe-defaults": { category: "campaigns", level: "view" }, // campaigns.getSafeDefaults
  "POST /api/v1/campaigns/preview-audience": { category: "campaigns", level: "manage" }, // campaigns.previewAudience
  "POST /api/v1/campaigns/create": { category: "campaigns", level: "manage" }, // campaigns.createCampaign
  "POST /api/v1/campaigns/update": { category: "campaigns", level: "manage" }, // campaigns.updateCampaign
  "POST /api/v1/campaigns/delete": { category: "campaigns", level: "full" }, // campaigns.deleteCampaign
  "POST /api/v1/campaigns/recipients": { category: "campaigns", level: "manage" }, // campaigns.addManualRecipients / importRecipientsCsv
  "POST /api/v1/campaigns/launch": { category: "campaigns", level: "full" }, // campaigns.launchCampaign
  "POST /api/v1/campaigns/pause": { category: "campaigns", level: "manage" }, // campaigns.pauseCampaign
  "POST /api/v1/campaigns/resume": { category: "campaigns", level: "manage" }, // campaigns.resumeCampaign
  "POST /api/v1/campaigns/cancel": { category: "campaigns", level: "full" }, // campaigns.cancelCampaign
  "POST /api/v1/campaigns/retry-failed": { category: "campaigns", level: "manage" }, // campaigns.retryFailed
  "GET /api/v1/opt-outs": { category: "campaigns", level: "view" }, // optOuts.listOptOuts
  "POST /api/v1/opt-outs": { category: "campaigns", level: "manage" }, // optOuts.addOptOut (campaigns:manage OU contacts:edit no app — a REST fica na categoria da campanha)
  "DELETE /api/v1/opt-outs": { category: "campaigns", level: "full" }, // optOuts.removeOptOut
  "GET /api/v1/whatsapp/templates": { category: "campaigns", level: "view" }, // whatsappTemplates.listTemplates
  "POST /api/v1/whatsapp/templates/sync": { category: "campaigns", level: "manage" }, // whatsappTemplates.syncMetaTemplates (campaigns:manage OU settings:manage no app)
  "GET /api/v1/whatsapp/tier": { category: "campaigns", level: "view" }, // whatsappTemplates.readMetaTier (leitura do limite do portfólio)

  // Grupos de WhatsApp — convex/groupChats.ts (ler/escrever numa sala é `inbox`;
  // acompanhar e sincronizar mexem na configuração do número, daí `settings`)
  "GET /api/v1/groups": { category: "inbox", level: "view_own" }, // groupChats.listGroups
  "GET /api/v1/groups/get": { category: "inbox", level: "view_own" }, // groupChats.getGroup
  "GET /api/v1/groups/messages": { category: "inbox", level: "view_own" }, // conversations.getMessages (requireAuth) da conversa do grupo
  "POST /api/v1/groups/send": { category: "inbox", level: "view_own" }, // conversations.sendMessage (requireAuth) — mesmo nível de POST /conversations/send
  "POST /api/v1/groups/monitor": { category: "settings", level: "manage" }, // groupChats.setMonitored
  "POST /api/v1/groups/sync": { category: "settings", level: "manage" }, // groupChats.syncGroups

  // Publicações programadas em grupos — convex/groupPosts.ts (categoria `campaigns`)
  "GET /api/v1/group-posts": { category: "campaigns", level: "view" }, // groupPosts.list
  "GET /api/v1/group-posts/get": { category: "campaigns", level: "view" }, // groupPosts.get
  "POST /api/v1/group-posts/create": { category: "campaigns", level: "manage" }, // groupPosts.create (conteúdo IA sem aprovação exige `full` DENTRO do handler)
  "POST /api/v1/group-posts/update": { category: "campaigns", level: "manage" }, // groupPosts.update (idem)
  "POST /api/v1/group-posts/activate": { category: "campaigns", level: "full" }, // groupPosts.activate (a partir daqui o CRM escreve sozinho na sala)
  "POST /api/v1/group-posts/pause": { category: "campaigns", level: "manage" }, // groupPosts.pause
  "POST /api/v1/group-posts/approve": { category: "campaigns", level: "manage" }, // groupPosts.approvePending
  "POST /api/v1/group-posts/reject": { category: "campaigns", level: "manage" }, // groupPosts.rejectPending
};

/**
 * Rotas `/api/v1` que NÃO usam `X-API-Key` e por isso ficam fora do mapa:
 * formulários públicos, script de embed, spec OpenAPI e o webhook do Resend
 * (verificado pela assinatura do próprio componente).
 */
export const PUBLIC_API_ROUTES: readonly string[] = [
  "GET /api/v1/forms/public",
  "POST /api/v1/forms/public/submit",
  "POST /api/v1/forms/public/partial",
  "POST /api/v1/forms/experiment/view",
  "GET /api/v1/embed.js",
  "GET /api/v1/openapi.json",
  "POST /api/v1/webhooks/resend",
];

/** Chave do mapa a partir do método + caminho registrado. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * Gate ÚNICO das rotas `/api/v1` — chamado logo após `authenticateApiKey` em
 * todo handler autenticado. Devolve `null` quando a chave tem a permissão e a
 * `Response` 403 quando não tem. Rota fora de `ROUTE_PERMISSIONS` é negada
 * (fail-closed: rota nova sem entrada no mapa não vaza dado).
 */
export function requireRoutePermission(
  auth: { permissions: Permissions },
  method: string,
  path: string
): Response | null {
  const required = ROUTE_PERMISSIONS[routeKey(method, path)];
  if (required === "authenticated") return null; // authenticateApiKey já validou a key
  if (required && hasPermission(auth.permissions, required.category, required.level)) {
    return null;
  }
  return errorResponse(PERMISSION_DENIED_MESSAGE, 403);
}

// ---- Lead Endpoints ----

// Universal lead capture endpoint
http.route({
  path: "/api/v1/inbound/lead",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/inbound/lead");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/leads");
      if (denied) return denied;

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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/leads/get");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/leads/update");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/leads/delete");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/leads/move-stage");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/leads/assign");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/leads/handoff");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/contacts");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/contacts/create");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/contacts/get");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/contacts/update");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/contacts/enrich");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/contacts/gaps");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/conversations");
      if (denied) return denied;
      const url = new URL(request.url);
      const leadId = url.searchParams.get("leadId");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
      const cursor = url.searchParams.get("cursor") || undefined;
      // `kind` ausente = `direct`: a rota devolve só conversa 1 a 1, como antes
      // da v0.57. Sala de grupo (sem lead nem contato) só sai quando pedida.
      const kindParam = url.searchParams.get("kind");
      if (kindParam && !["direct", "group", "all"].includes(kindParam)) {
        return errorResponse("kind deve ser direct, group ou all", 400);
      }

      const result = await ctx.runQuery(internal.conversations.internalGetConversations, {
        organizationId: apiKeyRecord.organizationId,
        leadId: leadId ? (leadId as Id<"leads">) : undefined,
        limit,
        cursor,
        ...(kindParam ? { kind: kindParam as "direct" | "group" | "all" } : {}),
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/conversations/messages");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/conversations/send");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/conversations/send-template");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/conversations/receive");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/handoffs");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/handoffs/pending");
      if (denied) return denied;

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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/handoffs/accept");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/handoffs/reject");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/files/upload-url");
      if (denied) return denied;

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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/files");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/files/:id/url");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "DELETE", "/api/v1/files/:id");
      if (denied) return denied;
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

// ---- Export / Import Endpoints ----
//
// Exportar/importar dados da organização exige `settings: manage` na chave de
// API (plano docs/EXPORT-IMPORT-PLAN-v2.md, regra 3). O gate saiu do antigo
// `denyDataOps` local e hoje vem do mecanismo único `ROUTE_PERMISSIONS` +
// `requireRoutePermission`, compartilhado com todas as demais rotas.

/** Teto do CSV embutido no corpo de POST /api/v1/imports. */
const MAX_INLINE_CSV_BYTES = 5 * 1024 * 1024;

const EXPORT_ENTITIES = ["contacts", "leads", "tasks"];
const IMPORT_ENTITIES = ["contacts", "leads"];
const DUPLICATE_STRATEGIES = ["skip", "update", "create"];

/**
 * Erro das rotas de export/import: chave ausente/inválida → 401; validação e
 * regra de negócio das mutations (job ativo, status errado, coluna inexistente)
 * → 400, no padrão documentado em `convex/CLAUDE.md`.
 */
function dataOpsError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Erro interno";
  if (message === "API key required" || message === "Invalid API key") {
    return errorResponse(message, 401);
  }
  return errorResponse(message, 400);
}

/**
 * As chaves do record `mapping` são `encodeURIComponent(cabeçalho)` (o Convex
 * não aceita acento em nome de campo). Na REST o consumidor sempre vê o
 * cabeçalho cru: entra cru no corpo, sai cru nas respostas.
 */
function decodeMappingKeys(
  mapping: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!mapping) return undefined;
  const decoded: Record<string, string> = {};
  for (const [key, destination] of Object.entries(mapping)) {
    let header = key;
    try {
      header = decodeURIComponent(key);
    } catch {
      // Chave que não é URI-encoded: devolve como está.
    }
    decoded[header] = destination;
  }
  return decoded;
}

function shapeImportJob(job: any) {
  if (!job) return job;
  return {
    ...job,
    mapping: decodeMappingKeys(job.mapping),
    suggestedMapping: decodeMappingKeys(job.suggestedMapping),
  };
}

/** Nome seguro para o header `Content-Disposition`. */
function attachmentFileName(name: string): string {
  const safe = name.replace(/[^\w.\-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "arquivo";
}

// Criar job de exportação
http.route({
  path: "/api/v1/exports",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "POST", "/api/v1/exports");
      if (denied) return denied;

      const body = await request.json();

      if (body.format !== "csv" && body.format !== "json") {
        return errorResponse("format deve ser \"csv\" ou \"json\"", 400);
      }
      if (body.scope !== "entity" && body.scope !== "full_backup") {
        return errorResponse("scope deve ser \"entity\" ou \"full_backup\"", 400);
      }
      if (body.entity !== undefined && !EXPORT_ENTITIES.includes(body.entity)) {
        return errorResponse("entity deve ser \"contacts\", \"leads\" ou \"tasks\"", 400);
      }
      if (
        body.columns !== undefined &&
        (!Array.isArray(body.columns) ||
          body.columns.some((column: unknown) => typeof column !== "string"))
      ) {
        return errorResponse("columns deve ser um array de strings", 400);
      }

      const jobId = await ctx.runMutation(internal.exports.internalCreateExportJob, {
        organizationId: auth.organizationId,
        teamMemberId: auth.teamMemberId,
        format: body.format,
        scope: body.scope,
        entity: body.entity,
        columns: body.columns,
      });

      return jsonResponse({ success: true, jobId }, 201);
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Listar exportações (últimas 20)
http.route({
  path: "/api/v1/exports",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/exports");
      if (denied) return denied;

      const jobs = await ctx.runQuery(internal.exports.internalListExportJobs, {
        organizationId: auth.organizationId,
      });

      return jsonResponse({ jobs });
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Consultar uma exportação
http.route({
  path: "/api/v1/exports/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/exports/get");
      if (denied) return denied;

      const jobId = new URL(request.url).searchParams.get("id");
      if (!jobId) return errorResponse("Parâmetro \"id\" é obrigatório", 400);

      const job = await ctx.runQuery(internal.exports.internalGetExportJob, {
        organizationId: auth.organizationId,
        jobId,
      });
      if (!job) return errorResponse("Exportação não encontrada", 404);

      return jsonResponse({ job });
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Baixar o arquivo gerado (stream autenticado — nunca URL pública)
http.route({
  path: "/api/v1/exports/download",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/exports/download");
      if (denied) return denied;

      const jobId = new URL(request.url).searchParams.get("id");
      if (!jobId) return errorResponse("Parâmetro \"id\" é obrigatório", 400);

      const job = await ctx.runQuery(internal.exports.internalGetExportJob, {
        organizationId: auth.organizationId,
        jobId,
      });
      if (!job) return errorResponse("Exportação não encontrada", 404);
      if (job.status !== "completed" || !job.resultStorageId) {
        return errorResponse(
          `Exportação indisponível para download (status: ${job.status})`,
          404
        );
      }

      const blob = await ctx.storage.get(job.resultStorageId as Id<"_storage">);
      if (!blob) {
        return errorResponse("Arquivo expirado ou removido do armazenamento", 404);
      }

      const fileName = attachmentFileName(
        job.resultFileName ?? `hnbcrm-export.${job.format}`
      );
      return new Response(blob, {
        status: 200,
        headers: {
          "Content-Type":
            job.format === "csv" ? "text/csv; charset=utf-8" : "application/json",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          ...corsHeaders,
        },
      });
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Criar job de importação (CSV embutido ou fileId de upload prévio)
http.route({
  path: "/api/v1/imports",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "POST", "/api/v1/imports");
      if (denied) return denied;

      const body = await request.json();

      if (!IMPORT_ENTITIES.includes(body.entity)) {
        return errorResponse("entity deve ser \"contacts\" ou \"leads\"", 400);
      }
      if (!DUPLICATE_STRATEGIES.includes(body.duplicateStrategy)) {
        return errorResponse(
          "duplicateStrategy deve ser \"skip\", \"update\" ou \"create\"",
          400
        );
      }
      if (typeof body.fileName !== "string" || body.fileName.trim().length === 0) {
        return errorResponse("fileName é obrigatório", 400);
      }
      if (typeof body.csv !== "string" && typeof body.fileId !== "string") {
        return errorResponse("Envie o conteúdo em \"csv\" ou o \"fileId\" de um upload prévio", 400);
      }

      let fileId: string = body.fileId;
      if (typeof body.csv === "string") {
        const blob = new Blob([body.csv], { type: "text/csv" });
        if (blob.size > MAX_INLINE_CSV_BYTES) {
          return errorResponse(
            `CSV embutido acima de ${MAX_INLINE_CSV_BYTES / (1024 * 1024)} MB — faça upload por /api/v1/files e use "fileId"`,
            400
          );
        }
        const storageId = await ctx.storage.store(blob);
        fileId = await ctx.runMutation(internal.files.internalSaveFile, {
          organizationId: auth.organizationId,
          teamMemberId: auth.teamMemberId,
          storageId,
          name: body.fileName,
          mimeType: "text/csv",
          size: blob.size,
          fileType: "import_file",
        });
      }

      const jobId = await ctx.runMutation(internal.imports.internalCreateImportJob, {
        organizationId: auth.organizationId,
        teamMemberId: auth.teamMemberId,
        entity: body.entity,
        fileId,
        fileName: body.fileName,
        duplicateStrategy: body.duplicateStrategy,
      });

      return jsonResponse({ success: true, jobId, fileId }, 201);
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Listar importações (últimas 20)
http.route({
  path: "/api/v1/imports",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/imports");
      if (denied) return denied;

      const jobs = await ctx.runQuery(internal.imports.internalListImportJobs, {
        organizationId: auth.organizationId,
      });

      return jsonResponse({ jobs: (jobs as any[]).map(shapeImportJob) });
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Consultar uma importação
http.route({
  path: "/api/v1/imports/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/imports/get");
      if (denied) return denied;

      const jobId = new URL(request.url).searchParams.get("id");
      if (!jobId) return errorResponse("Parâmetro \"id\" é obrigatório", 400);

      const job = await ctx.runQuery(internal.imports.internalGetImportJob, {
        organizationId: auth.organizationId,
        jobId,
      });
      if (!job) return errorResponse("Importação não encontrada", 404);

      return jsonResponse({ job: shapeImportJob(job) });
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Definir o mapeamento cabeçalho → campo
http.route({
  path: "/api/v1/imports/mapping",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "POST", "/api/v1/imports/mapping");
      if (denied) return denied;

      const body = await request.json();
      if (typeof body.jobId !== "string") return errorResponse("jobId é obrigatório", 400);
      if (!body.mapping || typeof body.mapping !== "object" || Array.isArray(body.mapping)) {
        return errorResponse("mapping deve ser um objeto { cabeçalho: campo }", 400);
      }

      const job = await ctx.runQuery(internal.imports.internalGetImportJob, {
        organizationId: auth.organizationId,
        jobId: body.jobId,
      });
      if (!job) return errorResponse("Importação não encontrada", 404);

      // O corpo vem com CABEÇALHOS CRUS; o record persistido usa a chave codificada.
      const mapping: Record<string, string> = {};
      for (const [header, destination] of Object.entries(body.mapping)) {
        if (typeof destination !== "string") {
          return errorResponse(`O destino da coluna "${header}" deve ser uma string`, 400);
        }
        mapping[encodeHeaderKey(header)] = destination;
      }

      await ctx.runMutation(internal.imports.internalUpdateMapping, {
        organizationId: auth.organizationId,
        jobId: job._id as Id<"importJobs">,
        mapping,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Rodar o dry-run
http.route({
  path: "/api/v1/imports/preview",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "POST", "/api/v1/imports/preview");
      if (denied) return denied;

      const body = await request.json();
      if (typeof body.jobId !== "string") return errorResponse("jobId é obrigatório", 400);

      const job = await ctx.runQuery(internal.imports.internalGetImportJob, {
        organizationId: auth.organizationId,
        jobId: body.jobId,
      });
      if (!job) return errorResponse("Importação não encontrada", 404);

      await ctx.runMutation(internal.imports.internalRunPreview, {
        organizationId: auth.organizationId,
        jobId: job._id as Id<"importJobs">,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Confirmar e executar a importação
http.route({
  path: "/api/v1/imports/confirm",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "POST", "/api/v1/imports/confirm");
      if (denied) return denied;

      const body = await request.json();
      if (typeof body.jobId !== "string") return errorResponse("jobId é obrigatório", 400);

      const job = await ctx.runQuery(internal.imports.internalGetImportJob, {
        organizationId: auth.organizationId,
        jobId: body.jobId,
      });
      if (!job) return errorResponse("Importação não encontrada", 404);

      await ctx.runMutation(internal.imports.internalConfirmImport, {
        organizationId: auth.organizationId,
        jobId: job._id as Id<"importJobs">,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Desfazer uma importação concluída
http.route({
  path: "/api/v1/imports/rollback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "POST", "/api/v1/imports/rollback");
      if (denied) return denied;

      const body = await request.json();
      if (typeof body.jobId !== "string") return errorResponse("jobId é obrigatório", 400);

      const job = await ctx.runQuery(internal.imports.internalGetImportJob, {
        organizationId: auth.organizationId,
        jobId: body.jobId,
      });
      if (!job) return errorResponse("Importação não encontrada", 404);

      await ctx.runMutation(internal.imports.internalRollbackImport, {
        organizationId: auth.organizationId,
        jobId: job._id as Id<"importJobs">,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return dataOpsError(error);
    }
  }),
});

// Baixar o CSV das linhas que falharam
http.route({
  path: "/api/v1/imports/failed-rows",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/imports/failed-rows");
      if (denied) return denied;

      const jobId = new URL(request.url).searchParams.get("id");
      if (!jobId) return errorResponse("Parâmetro \"id\" é obrigatório", 400);

      const job = await ctx.runQuery(internal.imports.internalGetImportJob, {
        organizationId: auth.organizationId,
        jobId,
      });
      if (!job) return errorResponse("Importação não encontrada", 404);

      const csv = await ctx.runAction(internal.imports.internalGetFailedRowsCsv, {
        organizationId: auth.organizationId,
        jobId: job._id as Id<"importJobs">,
      });

      const fileName = attachmentFileName(`erros-${job.fileName ?? "importacao.csv"}`);
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          ...corsHeaders,
        },
      });
    } catch (error) {
      return dataOpsError(error);
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/boards");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/team-members");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/field-definitions");
      if (denied) return denied;
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
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/activities");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/activities");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/dashboard");
      if (denied) return denied;

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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/contacts/search");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/lead-sources");
      if (denied) return denied;

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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/audit-logs");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/tasks");
      if (denied) return denied;
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
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/tasks/get");
      if (denied) return denied;
      const organizationId = auth.organizationId;
      const url = new URL(request.url);
      const taskId = url.searchParams.get("id");
      if (!taskId) return errorResponse("Task ID required", 400);

      const task = await ctx.runQuery(internal.tasks.internalGetTask, {
        taskId: taskId as Id<"tasks">,
        organizationId,
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/tasks/my");
      if (denied) return denied;

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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/tasks/overdue");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/tasks/search");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/tasks/create");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/tasks/update");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/tasks/complete");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/tasks/delete");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/tasks/assign");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/tasks/snooze");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/tasks/bulk");
      if (denied) return denied;
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
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/tasks/comments");
      if (denied) return denied;
      const organizationId = auth.organizationId;
      const url = new URL(request.url);
      const taskId = url.searchParams.get("taskId");
      if (!taskId) return errorResponse("taskId required", 400);
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.taskComments.internalGetComments, {
        taskId: taskId as Id<"tasks">,
        organizationId,
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/tasks/comments/add");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/calendar/events");
      if (denied) return denied;
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
      const auth = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(auth, "GET", "/api/v1/calendar/events/get");
      if (denied) return denied;
      const organizationId = auth.organizationId;
      const url = new URL(request.url);
      const eventId = url.searchParams.get("id");
      if (!eventId) return errorResponse("Event ID required", 400);

      const event = await ctx.runQuery(internal.calendar.internalGetEvent, {
        eventId: eventId as Id<"calendarEvents">,
        organizationId,
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/calendar/events/create");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/calendar/events/update");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/calendar/events/delete");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/calendar/events/reschedule");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/calendar/events/complete");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/notifications/preferences");
      if (denied) return denied;
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
      const denied = requireRoutePermission(apiKeyRecord, "PUT", "/api/v1/notifications/preferences");
      if (denied) return denied;
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

// ---- Campanhas de WhatsApp (disparo em massa) — convex/campaigns.ts ----
// Padrão de caminho FLAT (`/campaigns/get?campaignId=`), como o resto da API:
// o httpRouter do Convex só casa `path` exato ou `pathPrefix` — `:id` não é
// padrão de rota. Erros de domínio viram 400/403/404 em vez de 500.

function campaignErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Internal server error";
  if (/não encontrad/i.test(message)) return errorResponse(message, 404);
  if (/Permissão insuficiente|Rate limit/i.test(message)) return errorResponse(message, 403);
  return errorResponse(message, 400);
}

function parseLimit(raw: string | null, fallback: number, max: number): number {
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

http.route({
  path: "/api/v1/campaigns",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/campaigns");
      if (denied) return denied;
      const url = new URL(request.url);
      const status = url.searchParams.get("status") ?? undefined;
      const campaigns = await ctx.runQuery(internal.campaignsInternal.internalListCampaigns, {
        organizationId: apiKeyRecord.organizationId,
        ...(status ? { status: status as any } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ campaigns });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/campaigns/get");
      if (denied) return denied;
      const url = new URL(request.url);
      const campaignId = url.searchParams.get("campaignId");
      if (!campaignId) return errorResponse("campaignId required", 400);
      const campaign = await ctx.runQuery(internal.campaignsInternal.internalGetCampaign, {
        campaignId: campaignId as Id<"campaigns">,
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      if (!campaign) return errorResponse("Campanha não encontrada", 404);
      return jsonResponse({ campaign });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/report",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/campaigns/report");
      if (denied) return denied;
      const url = new URL(request.url);
      const campaignId = url.searchParams.get("campaignId");
      if (!campaignId) return errorResponse("campaignId required", 400);
      const report = await ctx.runQuery(internal.campaignsInternal.internalGetCampaignReport, {
        campaignId: campaignId as Id<"campaigns">,
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ report });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/recipients",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/campaigns/recipients");
      if (denied) return denied;
      const url = new URL(request.url);
      const campaignId = url.searchParams.get("campaignId");
      if (!campaignId) return errorResponse("campaignId required", 400);
      const status = url.searchParams.get("status") ?? undefined;
      const search = url.searchParams.get("search") ?? undefined;
      const page = await ctx.runQuery(internal.campaignsInternal.internalGetCampaignRecipients, {
        campaignId: campaignId as Id<"campaigns">,
        paginationOpts: {
          numItems: parseLimit(url.searchParams.get("limit"), 100, 500),
          cursor: url.searchParams.get("cursor"),
        },
        ...(status ? { status: status as any } : {}),
        ...(search ? { search } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({
        recipients: page.page,
        nextCursor: page.isDone ? null : page.continueCursor,
        hasMore: !page.isDone,
      });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/safe-defaults",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/campaigns/safe-defaults");
      if (denied) return denied;
      const url = new URL(request.url);
      const channelConfigId = url.searchParams.get("channelConfigId");
      if (!channelConfigId) return errorResponse("channelConfigId required", 400);
      const tier = url.searchParams.get("tier") ?? undefined;
      // v0.57: "groups" tem tabela de limites própria (salas, não pessoas)
      const audienceSource = url.searchParams.get("audienceSource");
      const defaults = await ctx.runQuery(internal.campaignsInternal.internalGetSafeDefaults, {
        channelConfigId: channelConfigId as Id<"channelConfigs">,
        ...(tier ? { tier } : {}),
        ...(audienceSource === "segment" ||
        audienceSource === "import" ||
        audienceSource === "manual" ||
        audienceSource === "groups" ||
        audienceSource === "group_members"
          ? { audienceSource }
          : {}),
        now: Date.now(),
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ defaults });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/preview-audience",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/preview-audience");
      if (denied) return denied;
      const body = await request.json();
      const preview = await ctx.runQuery(internal.campaignsInternal.internalPreviewAudience, {
        organizationId: apiKeyRecord.organizationId,
        filters: body.filters ?? {},
        now: Date.now(),
        // Públicos de grupo (v0.57): "groups" | "group_members"
        ...(body.source ? { source: body.source } : {}),
        ...(Array.isArray(body.groupChatIds)
          ? { groupChatIds: body.groupChatIds as Id<"groupChats">[] }
          : {}),
        ...(body.memberFilters ? { memberFilters: body.memberFilters } : {}),
        ...(body.channelConfigId ? { channelConfigId: body.channelConfigId as Id<"channelConfigs"> } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ preview });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/create");
      if (denied) return denied;
      const body = await request.json();
      if (!body.name) return errorResponse("name required", 400);
      if (!body.channelConfigId) return errorResponse("channelConfigId required", 400);
      if (!body.content) return errorResponse("content required", 400);
      const campaignId = await ctx.runMutation(internal.campaignsInternal.internalCreateCampaign, {
        organizationId: apiKeyRecord.organizationId,
        name: body.name,
        description: body.description,
        channelConfigId: body.channelConfigId as Id<"channelConfigs">,
        content: body.content,
        audience: body.audience ?? { source: "manual" },
        schedule: body.schedule,
        pacing: body.pacing,
        safeMode: body.safeMode,
        safety: body.safety,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true, campaignId }, 201);
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/update");
      if (denied) return denied;
      const body = await request.json();
      if (!body.campaignId) return errorResponse("campaignId required", 400);
      await ctx.runMutation(internal.campaignsInternal.internalUpdateCampaign, {
        campaignId: body.campaignId as Id<"campaigns">,
        patch: body.patch ?? {},
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/delete");
      if (denied) return denied;
      const body = await request.json();
      if (!body.campaignId) return errorResponse("campaignId required", 400);
      await ctx.runMutation(internal.campaignsInternal.internalDeleteCampaign, {
        campaignId: body.campaignId as Id<"campaigns">,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

// Destinatários: `entries` (manual, ≤500) OU `csv` (texto ≤5 MB) OU `fileId`
// (arquivo `import_file`). Com CSV, `dryRun: true` só valida e devolve o resumo.
http.route({
  path: "/api/v1/campaigns/recipients",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/recipients");
      if (denied) return denied;
      const body = await request.json();
      if (!body.campaignId) return errorResponse("campaignId required", 400);
      const campaignId = body.campaignId as Id<"campaigns">;
      if (Array.isArray(body.entries)) {
        if (body.entries.length > 500) return errorResponse("máximo de 500 números por chamada", 400);
        const result = await ctx.runMutation(internal.campaignsInternal.internalAddManualRecipients, {
          campaignId,
          entries: body.entries,
          // Origem opcional: seleção de membros de um grupo (relatório por grupo)
          ...(body.sourceGroupChatId
            ? { sourceGroupChatId: body.sourceGroupChatId as Id<"groupChats"> }
            : {}),
          actorMemberId: apiKeyRecord.teamMemberId,
        });
        return jsonResponse({ success: true, ...result });
      }
      if (typeof body.csv === "string" || body.fileId) {
        const result = await ctx.runAction(internal.campaignsInternal.internalImportRecipientsCsv, {
          campaignId,
          ...(typeof body.csv === "string" ? { csvText: body.csv } : {}),
          ...(body.fileId ? { fileId: body.fileId as Id<"files"> } : {}),
          ...(body.mapping ? { mapping: body.mapping } : {}),
          dryRun: body.dryRun === true,
          actorMemberId: apiKeyRecord.teamMemberId,
        });
        return jsonResponse({ success: true, ...result });
      }
      return errorResponse("envie entries[], csv ou fileId", 400);
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/launch",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/launch");
      if (denied) return denied;
      const body = await request.json();
      if (!body.campaignId) return errorResponse("campaignId required", 400);
      const result = await ctx.runMutation(internal.campaignsInternal.internalLaunchCampaign, {
        campaignId: body.campaignId as Id<"campaigns">,
        consentAck: body.consentAck === true,
        bridgeRiskAck: body.bridgeRiskAck === true,
        newNumberRiskAck: body.newNumberRiskAck === true,
        // D15: público "group_members" exige este aceite (DM a quem não iniciou)
        groupMembersDmAck: body.groupMembersDmAck === true,
        overrideAck: body.overrideAck === true,
        overrideWord: typeof body.overrideWord === "string" ? body.overrideWord : undefined,
        tierAtLaunch: typeof body.tierAtLaunch === "string" ? body.tierAtLaunch : undefined,
        templateQualityAtLaunch:
          typeof body.templateQualityAtLaunch === "string" ? body.templateQualityAtLaunch : undefined,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true, ...result });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/pause",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/pause");
      if (denied) return denied;
      const body = await request.json();
      if (!body.campaignId) return errorResponse("campaignId required", 400);
      await ctx.runMutation(internal.campaignsInternal.internalPauseCampaign, {
        campaignId: body.campaignId as Id<"campaigns">,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/resume",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/resume");
      if (denied) return denied;
      const body = await request.json();
      if (!body.campaignId) return errorResponse("campaignId required", 400);
      await ctx.runMutation(internal.campaignsInternal.internalResumeCampaign, {
        campaignId: body.campaignId as Id<"campaigns">,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/cancel",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/cancel");
      if (denied) return denied;
      const body = await request.json();
      if (!body.campaignId) return errorResponse("campaignId required", 400);
      await ctx.runMutation(internal.campaignsInternal.internalCancelCampaign, {
        campaignId: body.campaignId as Id<"campaigns">,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/campaigns/retry-failed",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/campaigns/retry-failed");
      if (denied) return denied;
      const body = await request.json();
      if (!body.campaignId) return errorResponse("campaignId required", 400);
      const result = await ctx.runMutation(internal.campaignsInternal.internalRetryFailed, {
        campaignId: body.campaignId as Id<"campaigns">,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true, ...result });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

// ---- Lista de supressão (opt-out) — convex/optOuts.ts ----

http.route({
  path: "/api/v1/opt-outs",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/opt-outs");
      if (denied) return denied;
      const url = new URL(request.url);
      const search = url.searchParams.get("search") ?? undefined;
      const page = await ctx.runQuery(internal.campaignsInternal.internalListOptOuts, {
        organizationId: apiKeyRecord.organizationId,
        paginationOpts: {
          numItems: parseLimit(url.searchParams.get("limit"), 100, 500),
          cursor: url.searchParams.get("cursor"),
        },
        ...(search ? { search } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({
        optOuts: page.page,
        nextCursor: page.isDone ? null : page.continueCursor,
        hasMore: !page.isDone,
      });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/opt-outs",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/opt-outs");
      if (denied) return denied;
      const body = await request.json();
      if (!body.phone && !body.contactId) return errorResponse("phone or contactId required", 400);
      const optOutId = await ctx.runMutation(internal.campaignsInternal.internalAddOptOut, {
        organizationId: apiKeyRecord.organizationId,
        phone: typeof body.phone === "string" ? body.phone : undefined,
        contactId: body.contactId ? (body.contactId as Id<"contacts">) : undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true, optOutId }, 201);
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/opt-outs",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "DELETE", "/api/v1/opt-outs");
      if (denied) return denied;
      const url = new URL(request.url);
      const optOutId = url.searchParams.get("optOutId");
      if (!optOutId) return errorResponse("optOutId required", 400);
      await ctx.runMutation(internal.campaignsInternal.internalRemoveOptOut, {
        optOutId: optOutId as Id<"optOuts">,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

// ---- Templates da Meta (Cloud API) — convex/whatsappTemplates.ts ----

http.route({
  path: "/api/v1/whatsapp/templates",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/whatsapp/templates");
      if (denied) return denied;
      const url = new URL(request.url);
      const channelConfigId = url.searchParams.get("channelConfigId");
      if (!channelConfigId) return errorResponse("channelConfigId required", 400);
      const templates = await ctx.runQuery(internal.campaignsInternal.internalListTemplates, {
        channelConfigId: channelConfigId as Id<"channelConfigs">,
        onlyApproved: url.searchParams.get("onlyApproved") === "true",
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ templates });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/whatsapp/templates/sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/whatsapp/templates/sync");
      if (denied) return denied;
      const body = await request.json();
      if (!body.channelConfigId) return errorResponse("channelConfigId required", 400);
      const result = await ctx.runAction(internal.campaignsInternal.internalSyncMetaTemplates, {
        channelConfigId: body.channelConfigId as Id<"channelConfigs">,
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ success: true, ...result });
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/whatsapp/tier",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/whatsapp/tier");
      if (denied) return denied;
      const url = new URL(request.url);
      const channelConfigId = url.searchParams.get("channelConfigId");
      if (!channelConfigId) return errorResponse("channelConfigId required", 400);
      const result = await ctx.runAction(internal.campaignsInternal.internalReadMetaTier, {
        channelConfigId: channelConfigId as Id<"channelConfigs">,
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse(result);
    } catch (error) {
      return campaignErrorResponse(error);
    }
  }),
});

// ---- Grupos de WhatsApp — convex/groupChats.ts + convex/groupPosts.ts ----
// Mesmos caminhos FLAT das campanhas (`/groups/get?groupChatId=`). Entrar,
// sair, criar grupo e mexer em participantes NÃO têm rota (§10 do plano):
// são irreversíveis e alcançam gente de fora, então ficam só na UI.

/** Mesmo mapeamento de erro das campanhas (404 / 403 / 400). */
const groupErrorResponse = campaignErrorResponse;

http.route({
  path: "/api/v1/groups",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/groups");
      if (denied) return denied;
      const url = new URL(request.url);
      const channelConfigId = url.searchParams.get("channelConfigId");
      const groups = await ctx.runQuery(internal.groupsInternal.internalListGroups, {
        organizationId: apiKeyRecord.organizationId,
        ...(channelConfigId ? { channelConfigId: channelConfigId as Id<"channelConfigs"> } : {}),
        ...(url.searchParams.get("includeRemoved") === "true" ? { includeRemoved: true } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ groups });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/groups/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/groups/get");
      if (denied) return denied;
      const url = new URL(request.url);
      const groupChatId = url.searchParams.get("groupChatId");
      if (!groupChatId) return errorResponse("groupChatId required", 400);
      const group = await ctx.runQuery(internal.groupsInternal.internalGetGroup, {
        groupChatId: groupChatId as Id<"groupChats">,
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      if (!group) return errorResponse("Grupo não encontrado", 404);
      return jsonResponse({ group });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/groups/messages",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/groups/messages");
      if (denied) return denied;
      const url = new URL(request.url);
      const groupChatId = url.searchParams.get("groupChatId");
      if (!groupChatId) return errorResponse("groupChatId required", 400);
      const messages = await ctx.runQuery(internal.groupsInternal.internalListGroupMessages, {
        groupChatId: groupChatId as Id<"groupChats">,
        limit: parseLimit(url.searchParams.get("limit"), 50, 200),
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ messages });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/groups/send",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/groups/send");
      if (denied) return denied;
      const body = await request.json();
      if (!body.groupChatId) return errorResponse("groupChatId required", 400);
      const attachments = Array.isArray(body.attachments)
        ? (body.attachments as Id<"files">[])
        : undefined;
      if (!body.content && !(attachments && attachments.length > 0)) {
        return errorResponse("content (or attachments) required", 400);
      }
      // Resolve a conversa da sala e re-checa o RBAC do membro da chave; o
      // envio em si é o MESMO caminho de POST /conversations/send (pacing,
      // webhook e dispatch inclusos).
      const target = await ctx.runQuery(
        internal.groupsInternal.internalResolveGroupConversation,
        {
          groupChatId: body.groupChatId as Id<"groupChats">,
          actorMemberId: apiKeyRecord.teamMemberId,
        }
      );
      const messageId = await ctx.runMutation(internal.conversations.internalSendMessage, {
        conversationId: target.conversationId,
        content: body.content ?? "",
        contentType: body.contentType || "text",
        attachments,
        ...(Array.isArray(body.mentions) ? { mentions: body.mentions as string[] } : {}),
        ...(body.replyToMessageId
          ? { replyToMessageId: body.replyToMessageId as Id<"messages"> }
          : {}),
        teamMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse(
        { success: true, messageId, conversationId: target.conversationId },
        201
      );
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/groups/monitor",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/groups/monitor");
      if (denied) return denied;
      const body = await request.json();
      if (!body.groupChatId) return errorResponse("groupChatId required", 400);
      if (typeof body.monitored !== "boolean") {
        return errorResponse("monitored (boolean) required", 400);
      }
      const groupChatId = await ctx.runMutation(internal.groupsInternal.internalSetMonitored, {
        groupChatId: body.groupChatId as Id<"groupChats">,
        monitored: body.monitored,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true, groupChatId, monitored: body.monitored });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/groups/sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/groups/sync");
      if (denied) return denied;
      const body = await request.json();
      if (!body.channelConfigId) return errorResponse("channelConfigId required", 400);
      const result = await ctx.runAction(internal.groupsInternal.internalSyncGroups, {
        channelConfigId: body.channelConfigId as Id<"channelConfigs">,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true, ...result });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

// ---- Publicações programadas em grupos — convex/groupPosts.ts ----

http.route({
  path: "/api/v1/group-posts",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/group-posts");
      if (denied) return denied;
      const url = new URL(request.url);
      const status = url.searchParams.get("status");
      const channelConfigId = url.searchParams.get("channelConfigId");
      const posts = await ctx.runQuery(internal.groupsInternal.internalListGroupPosts, {
        organizationId: apiKeyRecord.organizationId,
        ...(status ? { status: status as any } : {}),
        ...(channelConfigId ? { channelConfigId: channelConfigId as Id<"channelConfigs"> } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      return jsonResponse({ posts });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/group-posts/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/group-posts/get");
      if (denied) return denied;
      const url = new URL(request.url);
      const groupPostId = url.searchParams.get("groupPostId");
      if (!groupPostId) return errorResponse("groupPostId required", 400);
      const post = await ctx.runQuery(internal.groupsInternal.internalGetGroupPost, {
        groupPostId: groupPostId as Id<"groupPosts">,
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      if (!post) return errorResponse("Publicação não encontrada", 404);
      return jsonResponse({ post });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/group-posts/create",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/group-posts/create");
      if (denied) return denied;
      const body = await request.json();
      if (!body.name) return errorResponse("name required", 400);
      if (!Array.isArray(body.groupChatIds) || body.groupChatIds.length === 0) {
        return errorResponse("groupChatIds required", 400);
      }
      if (!body.schedule) return errorResponse("schedule required", 400);
      if (!body.content) return errorResponse("content required", 400);
      const groupPostId = await ctx.runMutation(
        internal.groupsInternal.internalCreateGroupPost,
        {
          organizationId: apiKeyRecord.organizationId,
          name: body.name,
          groupChatIds: body.groupChatIds as Id<"groupChats">[],
          schedule: body.schedule,
          content: body.content,
          actorMemberId: apiKeyRecord.teamMemberId,
          via: "api",
        }
      );
      return jsonResponse({ success: true, groupPostId }, 201);
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/group-posts/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/group-posts/update");
      if (denied) return denied;
      const body = await request.json();
      if (!body.groupPostId) return errorResponse("groupPostId required", 400);
      await ctx.runMutation(internal.groupsInternal.internalUpdateGroupPost, {
        groupPostId: body.groupPostId as Id<"groupPosts">,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(Array.isArray(body.groupChatIds)
          ? { groupChatIds: body.groupChatIds as Id<"groupChats">[] }
          : {}),
        ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
        ...(body.content !== undefined ? { content: body.content } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/group-posts/activate",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/group-posts/activate");
      if (denied) return denied;
      const body = await request.json();
      if (!body.groupPostId) return errorResponse("groupPostId required", 400);
      await ctx.runMutation(internal.groupsInternal.internalActivateGroupPost, {
        groupPostId: body.groupPostId as Id<"groupPosts">,
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/group-posts/pause",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/group-posts/pause");
      if (denied) return denied;
      const body = await request.json();
      if (!body.groupPostId) return errorResponse("groupPostId required", 400);
      await ctx.runMutation(internal.groupsInternal.internalPauseGroupPost, {
        groupPostId: body.groupPostId as Id<"groupPosts">,
        ...(body.reason ? { reason: body.reason } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/group-posts/approve",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/group-posts/approve");
      if (denied) return denied;
      const body = await request.json();
      if (!body.groupPostId) return errorResponse("groupPostId required", 400);
      await ctx.runMutation(internal.groupsInternal.internalApproveGroupPost, {
        groupPostId: body.groupPostId as Id<"groupPosts">,
        ...(body.editedText ? { editedText: body.editedText } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return groupErrorResponse(error);
    }
  }),
});

http.route({
  path: "/api/v1/group-posts/reject",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/group-posts/reject");
      if (denied) return denied;
      const body = await request.json();
      if (!body.groupPostId) return errorResponse("groupPostId required", 400);
      await ctx.runMutation(internal.groupsInternal.internalRejectGroupPost, {
        groupPostId: body.groupPostId as Id<"groupPosts">,
        ...(body.reason ? { reason: body.reason } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
        via: "api",
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return groupErrorResponse(error);
    }
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
http.route({ path: "/api/v1/exports", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/exports/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/exports/download", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/imports", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/imports/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/imports/mapping", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/imports/preview", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/imports/confirm", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/imports/rollback", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/imports/failed-rows", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/notifications/preferences", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/webhooks/resend", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/forms/public", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/forms/public/submit", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/forms/public/partial", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/report", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/recipients", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/safe-defaults", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/preview-audience", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/create", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/update", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/delete", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/launch", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/pause", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/resume", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/cancel", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/campaigns/retry-failed", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/opt-outs", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/whatsapp/templates", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/whatsapp/templates/sync", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/whatsapp/tier", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/groups", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/groups/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/groups/messages", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/groups/send", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/groups/monitor", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/groups/sync", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/group-posts", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/group-posts/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/group-posts/create", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/group-posts/update", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/group-posts/activate", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/group-posts/pause", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/group-posts/approve", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/group-posts/reject", method: "OPTIONS", handler: optionsHandler });

export default http;
