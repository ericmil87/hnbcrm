import { httpRouter } from "convex/server";
import { CONTACT_RELATIONS, isContactRelation, type ContactRelation } from "./lib/contactRelation";

import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { LLMS_TXT, LLMS_FULL_TXT } from "./llmsTxt";
import { EMBED_SCRIPT } from "./embedScript";
import { OPENAPI_SPEC } from "./openapiSpec";
import {
  hasPermission,
  resolvePermissions,
  completeLegacyPermissions,
  type Role,
  type Permissions,
  type PermissionCategory,
} from "./lib/permissions";
import { encodeHeaderKey } from "./lib/importKeys";
import { OPT_OUT_ERROR_PREFIX } from "./lib/startConversation";
import { NOT_ON_WHATSAPP_SEND_PREFIX } from "./lib/whatsappCheck";
import { FORM_NOTE_PREFIX } from "./lib/inboundLeadWelcome";
import { buildAttributionFromInput, sanitizeAttributionInput } from "./lib/leadAttribution";
import { resend } from "./email";
import {
  webhookVerify as whatsappWebhookVerify,
  webhookReceive as whatsappWebhookReceive,
} from "./whatsapp";
import { webhookReceive as bridgeWebhookReceive } from "./bridge";
import {
  webhookVerify as metaMessagingWebhookVerify,
  webhookReceive as metaMessagingWebhookReceive,
  oauthCallback as metaOAuthCallback,
  deauthorizeCallback as metaDeauthorizeCallback,
  dataDeletionCallback as metaDataDeletionCallback,
  deletionStatusPage as metaDeletionStatusPage,
} from "./metaMessaging";
import { copilotStream } from "./copilotHttp";
import { handleOnboardingStream, onboardingStreamPreflight } from "./onboardingHttp";
import { telegramWebhook } from "./telegramHttp";
import { asaasWebhook } from "./billingHttp";
import { clientIpKey } from "./lib/onboardingBudget";
import { LANGUAGE_CODES, normalizeLanguageCode } from "./lib/languages";
import { IDEMPOTENCY_REUSED_MESSAGE } from "./lib/schedBookingOps";
import { isoWithOffset } from "./lib/schedBookingEffects";
import { cleanBodyText, parseWhen, restIdempotencyKey, type SchedAppointmentId, withTimes } from "./lib/schedRestView";

/** Valores aceitos em `GET /api/v1/contacts?relation=`. */
const CONTACT_RELATION_FILTERS: readonly string[] = [...CONTACT_RELATIONS, "none", "non_customer"];

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
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Idempotency-Key",
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
  // Chave legada com permissões gravadas e sem `agenda`: deriva de `tasks` (completeLegacyPermissions).
  const permissions: Permissions = apiKeyRecord.permissions
    ? (completeLegacyPermissions(apiKeyRecord.permissions) as Permissions)
    : resolvePermissions(
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
  // Onboarding conversacional (JWT do usuário, não API key) — onboardingSessions.* (settings:manage)
  "POST /api/onboarding/stream": { category: "settings", level: "manage" },
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
  "POST /api/v1/contacts/update": { category: "contacts", level: "edit" }, // contacts.updateContact; PR1: subiu de view para edit (aceita `relation`, porta contacts.setContactRelation = contacts:edit)
  "POST /api/v1/contacts/enrich": { category: "contacts", level: "edit" }, // só internalMutation → nível de escrita
  "GET /api/v1/contacts/gaps": { category: "contacts", level: "view" }, // contacts.getContactEnrichmentGaps (requireAuth)
  "GET /api/v1/contacts/search": { category: "contacts", level: "view" }, // contacts.searchContacts (requireAuth)

  // Conversas — convex/conversations.ts
  "GET /api/v1/conversations": { category: "inbox", level: "view_own" }, // conversations.getConversations (requireAuth)
  "GET /api/v1/conversations/messages": { category: "inbox", level: "view_own" }, // conversations.getMessages (requireAuth)
  "POST /api/v1/conversations/send": { category: "inbox", level: "view_own" }, // conversations.sendMessage (requireAuth)
  "POST /api/v1/conversations/send-template": { category: "inbox", level: "reply" }, // só internalMutation → nível de escrita
  "POST /api/v1/conversations/receive": { category: "inbox", level: "reply" }, // ingestão externa, sem equivalente público
  "GET /api/v1/conversations/channels": { category: "inbox", level: "view_own" }, // startConversation.listSendableWhatsappChannels (requireAuth)
  "POST /api/v1/conversations/start": { category: "inbox", level: "reply" }, // startConversation.startConversation (requirePermission inbox:reply; contacts:edit/leads:edit_own no núcleo quando cria)

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

  // Agenda — convex/calendar.ts (categoria `agenda`): ler = view_own (view_all enxerga os de
  // todos); escrever = edit (altera qualquer compromisso da org, checado em `lib/calendarCore.ts`).
  "GET /api/v1/calendar/events": { category: "agenda", level: "view_own" }, // calendar.getEvents
  "GET /api/v1/calendar/events/get": { category: "agenda", level: "view_own" }, // calendar.getEvent
  "POST /api/v1/calendar/events/create": { category: "agenda", level: "edit" }, // calendar.createEvent
  "POST /api/v1/calendar/events/update": { category: "agenda", level: "edit" }, // calendar.updateEvent
  "POST /api/v1/calendar/events/delete": { category: "agenda", level: "edit" }, // calendar.deleteEvent
  "POST /api/v1/calendar/events/reschedule": { category: "agenda", level: "edit" }, // calendar.rescheduleEvent
  "POST /api/v1/calendar/events/complete": { category: "agenda", level: "edit" }, // calendar.completeEvent
  "POST /api/v1/calendar/events/cancel": { category: "agenda", level: "edit" }, // calendar.cancelEvent

  // Agenda v2 — agendamentos (I1). Ler = view_own (a chave com view_own só enxerga o que a tela mostraria ao membro); escrever
  // = edit (mesmos níveis das mutations de schedulingMutations.ts); fechar a agenda inteira exige manage DENTRO do handler.
  "GET /api/v1/scheduling/services": { category: "agenda", level: "view_own" }, // schedulingConfig.getConfig (serviços ativos)
  "GET /api/v1/scheduling/resources": { category: "agenda", level: "view_own" }, // schedulingConfig.getConfig (recursos ativos)
  "GET /api/v1/scheduling/slots": { category: "agenda", level: "view_own" }, // scheduling.findSlots (equipe só com edit+)
  "GET /api/v1/scheduling/appointments": { category: "agenda", level: "view_own" }, // scheduling.listAgendaAppointments
  "GET /api/v1/scheduling/appointments/get": { category: "agenda", level: "view_own" }, // scheduling.getAppointment
  "GET /api/v1/scheduling/pending": { category: "agenda", level: "view_own" }, // scheduling.listPending
  "POST /api/v1/scheduling/appointments/preview": { category: "agenda", level: "edit" }, // schedulingMutations.previewBooking
  "POST /api/v1/scheduling/appointments/book": { category: "agenda", level: "edit" }, // schedulingMutations.bookAppointment
  "POST /api/v1/scheduling/appointments/reschedule": { category: "agenda", level: "edit" }, // schedulingMutations.rescheduleAppointment
  "POST /api/v1/scheduling/appointments/cancel": { category: "agenda", level: "edit" }, // schedulingMutations.cancelAppointment
  "POST /api/v1/scheduling/appointments/status": { category: "agenda", level: "edit" }, // schedulingMutations.setAppointmentStatus (+ recusar = cancelar)
  "POST /api/v1/scheduling/appointments/undo-status": { category: "agenda", level: "edit" }, // schedulingMutations.undoAppointmentStatus
  "POST /api/v1/scheduling/appointments/resources": { category: "agenda", level: "edit" }, // schedulingMutations.reassignResources
  "POST /api/v1/scheduling/resources/day": { category: "agenda", level: "edit" }, // schedulingExceptions.setResourceClosure (sem recurso: manage no handler)
  "POST /api/v1/scheduling/resources/reopen": { category: "agenda", level: "edit" }, // schedulingExceptions.removeResourceClosure (idem)
  "GET /api/v1/scheduling/closures/get": { category: "agenda", level: "view_all" }, // schedulingExceptions.getClosureRun (view_all)
  "POST /api/v1/scheduling/conflicts/resolve": { category: "agenda", level: "edit" }, // schedulingExceptions.resolveConflict

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
  "POST /api/v1/public/contact", // pedido de contato/consultoria → lead na org interna (hnbcrmLeads.ts)
  "POST /api/v1/public/newsletter", // inscrição na newsletter → lead com etiqueta `newsletter` na org interna
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

// ---- Onboarding conversacional v2 (P2.3): SSE autenticado por JWT do usuário ----
// Não é REST de API key: a rota resolve o membro pelo JWT e aplica o MESMO gate
// fail-closed (`ROUTE_PERMISSIONS` + `requireRoutePermission`) às permissões dele.
http.route({
  path: "/api/onboarding/stream",
  method: "POST",
  handler: httpAction(async (ctx, request) =>
    handleOnboardingStream(ctx, request, (permissions) =>
      requireRoutePermission({ permissions }, "POST", "/api/onboarding/stream")
    )
  ),
});
http.route({
  path: "/api/onboarding/stream",
  method: "OPTIONS",
  handler: httpAction(async () => onboardingStreamPreflight()),
});

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
      if (body.channel === "instagram" || body.channel === "messenger") {
        return errorResponse(
          "Instagram e Messenger não permitem iniciar conversa; a pessoa precisa escrever primeiro (a mensagem entra pelo webhook da Meta ou por POST /api/v1/conversations/receive).",
          400
        );
      }
      const organizationId = apiKeyRecord.organizationId;
      const tags: string[] = Array.isArray(body.tags)
        ? body.tags.filter((t: unknown): t is string => typeof t === "string")
        : [];

      // v0.64: board/estágio (regra por tag → default ATIVO), `sourceId`
      // validado contra a org e auto-assign só para ATENDENTE — antes de
      // qualquer escrita, para um 400 não deixar contato órfão.
      const target = await ctx.runQuery(internal.inboundLeadWelcome.internalResolveInboundLeadTarget, {
        organizationId,
        tags,
        ...(body.sourceId != null && body.sourceId !== "" ? { sourceId: String(body.sourceId) } : {}),
      });
      if (!target.ok) {
        return errorResponse(target.error, target.status);
      }

      // Find or create contact — telefone normalizado (dígitos E.164 em
      // `phone` + `whatsappNumber`, igual ao ingest do WhatsApp).
      const contactId = await ctx.runMutation(internal.contacts.internalFindOrCreateContact, {
        organizationId,
        email: body.contact?.email,
        phone: body.contact?.phone,
        firstName: body.contact?.firstName,
        lastName: body.contact?.lastName,
        company: body.contact?.company,
        normalizePhone: true,
      });

      const leadId = await ctx.runMutation(internal.leads.internalCreateLead, {
        organizationId,
        title: body.title,
        contactId,
        boardId: target.boardId,
        stageId: target.stageId,
        assignedTo: target.assignedTo,
        value: body.value || 0,
        currency: body.currency,
        priority: body.priority || "medium",
        temperature: body.temperature || "cold",
        sourceId: target.sourceId,
        tags,
        customFields: body.customFields || {},
        teamMemberId: apiKeyRecord.teamMemberId,
      });

      // T07: origem do site (utm_*, gclid, fbclid…) → leads.attribution,
      // primeiro toque. Falha aqui nunca derruba a captura do lead.
      let attributionSaved = false;
      const { input: attributionInput, truncated: attributionTruncated } =
        sanitizeAttributionInput(body);
      if (attributionTruncated.length > 0) {
        console.warn(
          "[inbound/lead] campos de atribuição cortados:",
          attributionTruncated.join(",")
        );
      }
      const incomingAttribution = buildAttributionFromInput(attributionInput, Date.now());
      if (incomingAttribution) {
        try {
          attributionSaved = await ctx.runMutation(
            internal.inboundLeadWelcome.internalApplyLeadAttribution,
            { organizationId, leadId, attribution: incomingAttribution }
          );
        } catch (e) {
          console.error("[inbound/lead] atribuição falhou:", e instanceof Error ? e.message : e);
        }
      }

      // Boas-vindas automáticas valem para ESTE lead? (interruptor + telefone +
      // tag de consentimento + texto). O envio em si re-checa tudo.
      const rawPhone = typeof body.contact?.phone === "string" ? body.contact.phone : "";
      const welcome = await ctx.runQuery(internal.inboundLeadWelcome.internalWelcomeAppliesTo, {
        organizationId,
        ...(rawPhone ? { phone: rawPhone } : {}),
        tags,
      });

      let conversationId: Id<"conversations"> | undefined;
      if (body.message) {
        const formMessage = String(body.message);
        if (welcome || body.channel === "whatsapp") {
          // A mensagem do formulário é do LEAD, não nossa: vira NOTA INTERNA na
          // conversa do WhatsApp — nunca um outbound (que sairia para o
          // próprio cliente com o texto que ele mesmo escreveu).
          conversationId = await ctx.runMutation(internal.conversations.internalCreateConversation, {
            organizationId,
            leadId,
            channel: "whatsapp",
            ...(welcome ? { channelConfigId: welcome.channelConfigId } : {}),
          });
          await ctx.runMutation(internal.conversations.internalSendMessage, {
            conversationId,
            content: `${FORM_NOTE_PREFIX}${formMessage}`,
            isInternal: true,
            teamMemberId: apiKeyRecord.teamMemberId,
          });
        } else {
          // Legado (sem boas-vindas e sem canal WhatsApp): comportamento antigo.
          conversationId = await ctx.runMutation(internal.conversations.internalCreateConversation, {
            organizationId,
            leadId,
            channel: body.channel || "webchat",
          });
          await ctx.runMutation(internal.conversations.internalSendMessage, {
            conversationId,
            content: formMessage,
            isInternal: false,
            teamMemberId: apiKeyRecord.teamMemberId,
          });
        }
      }

      let welcomeQueued = false;
      let welcomeSkippedReason: string | undefined;
      if (welcome) {
        try {
          // Action: pré-checa o número no gateway (bridge) antes de enfileirar.
          const result = await ctx.runAction(internal.inboundLeadWelcome.internalRunInboundLeadWelcome, {
            organizationId,
            leadId,
            contactId,
            actorMemberId: apiKeyRecord.teamMemberId,
          });
          welcomeQueued = result.sent;
          welcomeSkippedReason = result.reason;
          if (result.conversationId) conversationId = result.conversationId;
        } catch (e) {
          // O lead já existe: falha da boas-vindas não vira 500 da captura.
          console.error("[inbound/lead] boas-vindas falhou:", e instanceof Error ? e.message : e);
          welcomeSkippedReason = "erro";
        }
      }

      return jsonResponse(
        {
          success: true,
          leadId,
          contactId,
          boardId: target.boardId,
          stageId: target.stageId,
          ...(target.routedByTag ? { routedByTag: target.routedByTag } : {}),
          ...(conversationId ? { conversationId } : {}),
          attributionSaved,
          ...(attributionTruncated.length > 0 ? { attributionTruncated } : {}),
          welcomeQueued,
          ...(welcomeSkippedReason ? { welcomeSkippedReason } : {}),
        },
        201
      );
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

      if (body.closedReason !== undefined && typeof body.closedReason !== "string") {
        return errorResponse("closedReason must be a string", 400);
      }
      if (
        body.finalValue !== undefined &&
        (typeof body.finalValue !== "number" || !Number.isFinite(body.finalValue) || body.finalValue < 0)
      ) {
        return errorResponse("finalValue must be a finite number >= 0", 400);
      }

      await ctx.runMutation(internal.leads.internalMoveLeadToStage, {
        leadId: body.leadId as Id<"leads">,
        stageId: body.stageId as Id<"stages">,
        teamMemberId: apiKeyRecord.teamMemberId,
        ...(typeof body.closedReason === "string" ? { closedReason: body.closedReason } : {}),
        ...(typeof body.finalValue === "number" ? { finalValue: body.finalValue } : {}),
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
      // PR1: `?relation=` = um tipo (customer|personal|team|supplier|partner|automated),
      // `none` (sem tipo) ou `non_customer` (qualquer tipo fora do comercial).
      const relationParam = url.searchParams.get("relation") || undefined;
      if (relationParam !== undefined && !CONTACT_RELATION_FILTERS.includes(relationParam)) {
        return errorResponse(`relation inválido: use ${CONTACT_RELATION_FILTERS.join(", ")}`, 400);
      }

      const result = await ctx.runQuery(internal.contacts.internalGetContacts, {
        organizationId: apiKeyRecord.organizationId,
        limit,
        cursor,
        ...(relationParam ? { relation: relationParam as ContactRelation | "none" | "non_customer" } : {}),
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

      // Tradução automática (F1): idioma preferido validado pelo catálogo.
      if (body.preferredLanguage !== undefined && !isValidPreferredLanguageBody(body.preferredLanguage)) {
        return errorResponse(
          `preferredLanguage inválido: use um destes códigos (ou "" para limpar): ${LANGUAGE_CODES.join(", ")}`,
          400
        );
      }

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
        ...(typeof body.preferredLanguage === "string" ? { preferredLanguage: body.preferredLanguage } : {}),
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

      // PR1: tipo de contato. Valor do catálogo ou null (limpa); só chave de membro humano.
      if (body.relation !== undefined && body.relation !== null && !isContactRelation(body.relation)) {
        return errorResponse(`relation inválido: use ${CONTACT_RELATIONS.join(", ")} ou null`, 400);
      }
      if (body.relation !== undefined && apiKeyRecord.teamMember?.type === "ai") {
        return errorResponse(PERMISSION_DENIED_MESSAGE, 403);
      }

      // Tradução automática (F1): idioma preferido validado pelo catálogo.
      if (body.preferredLanguage !== undefined && !isValidPreferredLanguageBody(body.preferredLanguage)) {
        return errorResponse(
          `preferredLanguage inválido: use um destes códigos (ou "" para limpar): ${LANGUAGE_CODES.join(", ")}`,
          400
        );
      }

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
        ...(typeof body.preferredLanguage === "string" ? { preferredLanguage: body.preferredLanguage } : {}),
        ...(body.relation !== undefined ? { relation: body.relation as ContactRelation | null } : {}),
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

      const channelParam = url.searchParams.get("channel");
      if (channelParam && !["whatsapp", "telegram", "email", "webchat", "internal", "instagram", "messenger"].includes(channelParam)) {
        return errorResponse("channel inválido", 400);
      }
      const channelConfigParam = url.searchParams.get("channelConfigId");

      const result = await ctx.runQuery(internal.conversations.internalGetConversations, {
        organizationId: apiKeyRecord.organizationId,
        leadId: leadId ? (leadId as Id<"leads">) : undefined,
        ...(channelParam ? { channel: channelParam as "whatsapp" } : {}),
        ...(channelConfigParam ? { channelConfigId: channelConfigParam as Id<"channelConfigs"> } : {}),
        limit,
        cursor,
        ...(kindParam ? { kind: kindParam as "direct" | "group" | "all" } : {}),
      });

      return jsonResponse(result as any);
    } catch (error) {
      return startConversationError(error);
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

      if (body.translation !== undefined && !isTranslationBody(body.translation)) {
        return errorResponse("translation must be {authoredText, sourceLang, targetLang, edited?}", 400);
      }
      if (
        isTranslationBody(body.translation) &&
        (!normalizeLanguageCode(body.translation.sourceLang) || !normalizeLanguageCode(body.translation.targetLang))
      ) {
        return errorResponse(
          `translation.sourceLang/targetLang inválido: use um destes códigos: ${LANGUAGE_CODES.join(", ")}`,
          400
        );
      }
      // `language`: "auto" | "off" | código do catálogo (review #8: inválido = 400).
      if (body.language !== undefined && !isValidSendLanguage(body.language)) {
        return errorResponse(
          `language inválido: use "auto", "off" ou um destes códigos: ${LANGUAGE_CODES.join(", ")}`,
          400
        );
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
        // Tradução automática (F1): "auto" | "off" | código; ignorado sem o módulo.
        ...(typeof body.language === "string" && body.language.trim()
          ? { language: body.language.trim() }
          : {}),
        ...(isTranslationBody(body.translation) ? { translation: body.translation } : {}),
        // Aceite explícito de envio a número sem WhatsApp (lib/whatsappCheck).
        ...(body.notOnWhatsappAck === true ? { notOnWhatsappAck: true } : {}),
      });

      return jsonResponse({ success: true, messageId }, 201);
    } catch (error) {
      // Número marcado "sem WhatsApp": 409 — repetir com `notOnWhatsappAck: true`
      // só depois de um humano confirmar (mesma ideia do opt-out da Nova conversa).
      if (error instanceof ConvexError) {
        const raw = plainErrorMessage(error);
        const at = raw.indexOf(NOT_ON_WHATSAPP_SEND_PREFIX);
        if (at !== -1) {
          return new Response(
            JSON.stringify({ error: raw.slice(at + NOT_ON_WHATSAPP_SEND_PREFIX.length).trim(), code: 409, notOnWhatsapp: true }),
            { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      }
      // Erro de regra/validação (ConvexError PT-BR) = 400, não 500.
      if (error instanceof ConvexError) return errorResponse(plainErrorMessage(error), 400);
      return errorResponse(error instanceof Error ? error.message : "Internal server error");
    }
  }),
});

// ---- Nova conversa (v0.68): iniciar conversa de WhatsApp pela API ----
//
// Mesmo núcleo da UI ("Nova conversa" no inbox): `startConversation.ts`. O
// ator é o membro dono da API key, e as permissões da CHAVE funcionam como teto
// (o membro E a chave precisam ter cada nível).

/** `preferredLanguage` de `/contacts/create|update`: código do catálogo ou "" (limpa). */
function isValidPreferredLanguageBody(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return raw.trim() === "" || normalizeLanguageCode(raw) !== undefined;
}

/** `language` de `POST /conversations/send`: "auto", "off" ou código do catálogo. */
function isValidSendLanguage(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (!value) return true; // vazio = não informado ("auto")
  return value === "auto" || value === "off" || normalizeLanguageCode(value) !== undefined;
}

/** Corpo `translation` de `POST /conversations/send` (F3: o cliente já traduziu). */
function isTranslationBody(
  raw: unknown
): raw is { authoredText: string; sourceLang: string; targetLang: string; edited?: boolean } {
  if (!raw || typeof raw !== "object") return false;
  const t = raw as Record<string, unknown>;
  return (
    typeof t.authoredText === "string" &&
    typeof t.sourceLang === "string" &&
    typeof t.targetLang === "string" &&
    (t.edited === undefined || typeof t.edited === "boolean")
  );
}

/**
 * Erro das rotas de nova conversa: validação/regra (ConvexError PT-BR) → 400;
 * número em opt-out → 409 com `optOut: true` (repetir com `optOutAck: true`
 * só depois de um humano confirmar); falta de permissão → 403.
 */
function startConversationError(error: unknown): Response {
  const raw = plainErrorMessage(error);
  if (raw === "API key required" || raw === "Invalid API key") return errorResponse(raw, 401);
  if (raw.includes("Rate limit exceeded")) return errorResponse(raw, 429);
  const optOutAt = raw.indexOf(OPT_OUT_ERROR_PREFIX);
  if (optOutAt !== -1) {
    const message = raw.slice(optOutAt + OPT_OUT_ERROR_PREFIX.length).trim();
    return new Response(JSON.stringify({ error: message, code: 409, optOut: true }), {
      status: 409,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (raw.includes(PERMISSION_DENIED_MESSAGE)) {
    // Mensagem do núcleo ("Permissão insuficiente para criar contatos") sem o prefixo do runtime.
    const at = raw.indexOf(PERMISSION_DENIED_MESSAGE);
    return errorResponse(raw.slice(at).split("\n")[0].trim(), 403);
  }
  if (error instanceof ConvexError || /Validator|ArgumentValidationError|Membro não encontrado/.test(raw)) {
    return errorResponse(raw, 400);
  }
  return errorResponse(raw, 500);
}

/**
 * Texto legível de um erro que atravessou `ctx.runAction`/`runMutation`: o
 * `ConvexError` pode chegar com a classe (data = string) ou só como `Error`
 * cuja mensagem é o data serializado em JSON (com aspas), às vezes com prefixo
 * "Uncaught ConvexError:" e o stack nas linhas seguintes.
 */
function plainErrorMessage(error: unknown): string {
  let msg =
    error instanceof ConvexError && typeof error.data === "string"
      ? error.data
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Erro interno";
  // Erro do núcleo que atravessa mutation → action → http chega serializado
  // mais de uma vez; desembrulha até estabilizar (com teto).
  for (let i = 0; i < 4; i++) {
    const before = msg;
    msg = msg.split("\n")[0].replace(/^(Uncaught )?(ConvexError|Error):\s*/, "").trim();
    if (msg.startsWith('"')) {
      try {
        const parsed = JSON.parse(msg);
        if (typeof parsed === "string") msg = parsed;
      } catch {
        /* não era JSON */
      }
    }
    if (msg === before) break;
  }
  return msg;
}

// List WhatsApp numbers the API key's member can start a conversation from
http.route({
  path: "/api/v1/conversations/channels",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "GET", "/api/v1/conversations/channels");
      if (denied) return denied;
      const rows = await ctx.runQuery(internal.startConversation.internalListChannelsForRest, {
        organizationId: apiKeyRecord.organizationId,
        actorMemberId: apiKeyRecord.teamMemberId,
      });
      // Allowlist: nenhum token, URL de gateway, id de instância nem id de Página/IG sai daqui.
      const channels = rows.map((c) => ({
        id: c._id,
        channel: c.channel,
        transport: c.transport,
        accountLabel: c.accountLabel,
        handle: c.handle,
        canStart: c.canStart,
        displayName: c.displayName,
        connected: c.connected,
        ...(c.channel === "whatsapp" ? { provider: c.provider, phoneDisplay: c.phoneDisplay } : {}),
        ...(c.sessionState !== null ? { sessionState: c.sessionState } : {}),
      }));
      return jsonResponse({ channels });
    } catch (error) {
      return startConversationError(error);
    }
  }),
});

// Start (or reopen) a WhatsApp conversation with a phone number or existing contact
http.route({
  path: "/api/v1/conversations/start",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/conversations/start");
      if (denied) return denied;
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return errorResponse("Corpo JSON inválido", 400);
      }
      if (!body || typeof body !== "object") return errorResponse("Corpo JSON inválido", 400);
      if (typeof body.channelConfigId !== "string" || !body.channelConfigId) {
        return errorResponse("channelConfigId é obrigatório (veja GET /api/v1/conversations/channels)", 400);
      }
      const str = (k: string): string | undefined => {
        const val = body[k];
        return typeof val === "string" && val.trim() !== "" ? val : undefined;
      };
      const phone = str("phone");
      const contactId = str("contactId");
      if (!phone && !contactId) return errorResponse("Informe phone ou contactId", 400);
      for (const k of ["phone", "contactId", "firstName", "lastName", "boardId", "stageId", "content"]) {
        if (body[k] !== undefined && body[k] !== null && typeof body[k] !== "string") {
          return errorResponse(`${k} deve ser texto`, 400);
        }
      }
      if (body.optOutAck !== undefined && typeof body.optOutAck !== "boolean") {
        return errorResponse("optOutAck deve ser booleano", 400);
      }
      const opt = (k: string) => (str(k) !== undefined ? { [k]: str(k) } : {});
      const result = await ctx.runAction(internal.startConversation.internalStartConversationAsMember, {
        organizationId: apiKeyRecord.organizationId,
        channelConfigId: body.channelConfigId as Id<"channelConfigs">,
        ...opt("phone"),
        ...opt("contactId"),
        ...opt("firstName"),
        ...opt("lastName"),
        ...opt("boardId"),
        ...opt("stageId"),
        ...opt("content"),
        ...(body.optOutAck === true ? { optOutAck: true } : {}),
        actorMemberId: apiKeyRecord.teamMemberId,
        keyPermissions: apiKeyRecord.permissions,
      } as any);
      return jsonResponse({ success: true, ...result }, 201);
    } catch (error) {
      return startConversationError(error);
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
      return startConversationError(error);
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

      // Instagram/Messenger: sem telefone; a conta (channelConfigId) é da org e do mesmo canal.
      let metaConfigId: Id<"channelConfigs"> | undefined;
      if (channel === "instagram" || channel === "messenger") {
        if (!body.contactId) {
          return errorResponse("Instagram e Messenger exigem contactId (sem contactPhone)", 400);
        }
        if (typeof body.channelConfigId !== "string" || !body.channelConfigId) {
          return errorResponse("channelConfigId é obrigatório para instagram/messenger (veja GET /api/v1/conversations/channels)", 400);
        }
        let cfg: { organizationId: Id<"organizations">; channel: string; status: string; disabledByModuleAt?: number } | null = null;
        try {
          cfg = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
            configId: body.channelConfigId as Id<"channelConfigs">,
          });
        } catch {
          cfg = null;
        }
        if (!cfg || cfg.organizationId !== apiKeyRecord.organizationId || cfg.channel !== channel) {
          return errorResponse("channelConfigId não encontrado nesta organização para este canal", 400);
        }
        if (cfg.status !== "active" || cfg.disabledByModuleAt !== undefined) {
          return errorResponse("Esta conta está desativada; reconecte em Configurações → Canais antes de registrar mensagens.", 400);
        }
        const metaOn: boolean = await ctx.runQuery(internal.metaMessaging.internalMetaModuleEnabled, {
          organizationId: apiKeyRecord.organizationId,
        });
        if (!metaOn) return errorResponse("O módulo Instagram/Messenger está desligado nesta organização.", 400);
        metaConfigId = body.channelConfigId as Id<"channelConfigs">;
      }

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

      // Meta: a janela de 7 dias (`referral` de anúncio) e o `standby` só podem vir da própria Meta
      // (webhook assinado), nunca de um cliente REST. Sem identidade do contato nesta conta, a IA
      // não é acordada (a resposta não teria destinatário).
      let metadata = body.metadata;
      let skipAiEnqueue = false;
      if (metaConfigId) {
        if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
          const { referral: _referral, standby: _standby, ...rest } = metadata as Record<string, unknown>;
          metadata = rest;
        }
        skipAiEnqueue = !(await ctx.runQuery(internal.metaMessaging.internalContactHasMetaIdentity, {
          contactId,
          channelConfigId: metaConfigId,
        }));
      }

      const messageId = await ctx.runMutation(internal.conversations.internalReceiveMessage, {
        organizationId: apiKeyRecord.organizationId,
        leadId,
        channel,
        ...(metaConfigId ? { channelConfigId: metaConfigId } : {}),
        content: body.content,
        contentType: body.contentType || "text",
        externalId: body.externalId,
        metadata,
        ...(skipAiEnqueue ? { skipAiEnqueue: true } : {}),
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
// API (plano EXPORT-IMPORT-PLAN-v2.md (removido do repo em 22/10/2026; histórico git até ea71ddd), regra 3). O gate saiu do antigo
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
      const referrer =
        (typeof body.referrer === "string" && body.referrer.trim() ? body.referrer.trim().slice(0, 2048) : undefined) ||
        request.headers.get("referer") || undefined;

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
      const gclid: string | undefined = typeof body.gclid === "string" && body.gclid ? body.gclid : undefined;
      const fbclid: string | undefined = typeof body.fbclid === "string" && body.fbclid ? body.fbclid : undefined;
      const landingUrl: string | undefined =
        typeof body.landingUrl === "string" && body.landingUrl ? body.landingUrl : undefined;

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
        gclid,
        fbclid,
        landingUrl,
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

// Pedido de contato/consultoria — POST /api/v1/public/contact
// Público (sem API key): honeypot, limite de corpo, rate limit por IP/e-mail/dia e
// validação na mutation. Sem org interna configurada: 503 {ok:false, code:"unavailable"}
// (o front cai para o mailto). Honeypot preenchido: 200 {ok:true} sem criar nada.
http.route({
  path: "/api/v1/public/contact",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      // Recusa pelo Content-Length ANTES de ler o corpo; o corte pelo texto cobre quem omite o cabeçalho.
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 8_000) {
        return jsonResponse({ ok: false, code: "invalid", message: "Pedido grande demais." }, 413);
      }
      const text = await request.text();
      if (text.length > 8_000) return jsonResponse({ ok: false, code: "invalid", message: "Pedido grande demais." }, 413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return jsonResponse({ ok: false, code: "invalid", message: "Corpo inválido." }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ ok: false, code: "invalid", message: "Corpo inválido." }, 400);
      }
      const b = body as Record<string, unknown>;
      if (typeof b._honeypot === "string" && b._honeypot.trim() !== "") return jsonResponse({ ok: true });
      const str = (x: unknown): string => (typeof x === "string" ? x : "");
      const result = await ctx.runMutation(internal.hnbcrmLeads.internalSubmitContactRequest, {
        name: str(b.name),
        email: str(b.email),
        ...(typeof b.phone === "string" ? { phone: b.phone } : {}),
        ...(typeof b.business === "string" ? { business: b.business } : {}),
        ...(typeof b.teamSize === "string" ? { teamSize: b.teamSize } : {}),
        need: str(b.need),
        kind: str(b.kind),
        ipKey: clientIpKey(request) ?? undefined,
      });
      if (result.ok) return jsonResponse({ ok: true });
      const status = result.code === "rate_limited" ? 429 : result.code === "unavailable" ? 503 : 400;
      return jsonResponse(result, status);
    } catch (err) {
      // Só a mensagem do erro: nunca o corpo (dados do solicitante).
      console.error("[contact]", err instanceof Error ? err.message : "erro");
      return jsonResponse({ ok: false, code: "error", message: "Não foi possível enviar agora." }, 500);
    }
  }),
});

// Inscrição na newsletter — POST /api/v1/public/newsletter
// Mesmo tratamento do contato: sem API key, corpo limitado, honeypot `_honeypot` (preenchido =
// 200 {ok:true} sem gravar), rate limit na mutation, sem org interna = 503 unavailable.
http.route({
  path: "/api/v1/public/newsletter",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 2_000) {
        return jsonResponse({ ok: false, code: "invalid", message: "Pedido grande demais." }, 413);
      }
      const text = await request.text();
      if (text.length > 2_000) return jsonResponse({ ok: false, code: "invalid", message: "Pedido grande demais." }, 413);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return jsonResponse({ ok: false, code: "invalid", message: "Corpo inválido." }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ ok: false, code: "invalid", message: "Corpo inválido." }, 400);
      }
      const b = body as Record<string, unknown>;
      if (typeof b._honeypot === "string" && b._honeypot.trim() !== "") return jsonResponse({ ok: true });
      const result = await ctx.runMutation(internal.hnbcrmLeads.internalSubscribeNewsletter, {
        email: typeof b.email === "string" ? b.email : "",
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        ...(typeof b.source === "string" ? { source: b.source } : {}),
        ipKey: clientIpKey(request) ?? undefined,
      });
      if (result.ok) return jsonResponse({ ok: true });
      const status = result.code === "rate_limited" ? 429 : result.code === "unavailable" ? 503 : 400;
      return jsonResponse(result, status);
    } catch (err) {
      console.error("[newsletter]", err instanceof Error ? err.message : "erro");
      return jsonResponse({ ok: false, code: "error", message: "Não foi possível inscrever agora." }, 500);
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
// Todas chamam `internal.calendar.*` (núcleo único `lib/calendarCore.ts`, o mesmo do app).
// Erros de regra (ConvexError PT-BR) = 400; evento inexistente = 404; sem permissão = 403.

function calendarError(error: unknown): Response {
  const raw = plainErrorMessage(error);
  if (raw.includes("Evento não encontrado")) return errorResponse(raw, 404);
  return startConversationError(error);
}

function numParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

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

      const startDate = numParam(url.searchParams.get("startDate"));
      const endDate = numParam(url.searchParams.get("endDate"));
      if (startDate === undefined || endDate === undefined) return errorResponse("startDate and endDate required", 400);
      if (Number.isNaN(startDate) || Number.isNaN(endDate)) return errorResponse("startDate and endDate must be numbers (epoch ms)", 400);

      const assignedTo = url.searchParams.get("assignedTo");
      const eventType = url.searchParams.get("eventType") as any || undefined;
      const status = url.searchParams.get("status") as any || undefined;
      const leadId = url.searchParams.get("leadId");
      const contactId = url.searchParams.get("contactId");
      const limit = numParam(url.searchParams.get("limit"));
      if (limit !== undefined && Number.isNaN(limit)) return errorResponse("limit must be a number", 400);
      const cursor = url.searchParams.get("cursor") || undefined;

      const result = await ctx.runQuery(internal.calendar.internalGetEvents, {
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
        permissions: apiKeyRecord.permissions,
        startDate,
        endDate,
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
      return calendarError(error);
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
      const url = new URL(request.url);
      const eventId = url.searchParams.get("id");
      if (!eventId) return errorResponse("Event ID required", 400);

      const event = await ctx.runQuery(internal.calendar.internalGetEvent, {
        eventId: eventId as Id<"calendarEvents">,
        organizationId: auth.organizationId,
        teamMemberId: auth.teamMemberId,
        permissions: auth.permissions,
      });

      if (!event) return errorResponse("Event not found", 404);
      return jsonResponse({ event });
    } catch (error) {
      return calendarError(error);
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
      if (!isFiniteNumber(body.startTime) || !isFiniteNumber(body.endTime)) return errorResponse("startTime and endTime required (epoch ms)", 400);

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
        taskId: body.taskId ? (body.taskId as Id<"tasks">) : undefined,
        attendees: body.attendees,
        assignedTo: body.assignedTo ? (body.assignedTo as Id<"teamMembers">) : undefined,
        location: body.location,
        meetingUrl: body.meetingUrl,
        color: body.color,
        recurrence: body.recurrence,
        notes: body.notes,
        teamMemberId: apiKeyRecord.teamMemberId,
        permissions: apiKeyRecord.permissions,
      });

      return jsonResponse({ success: true, eventId }, 201);
    } catch (error) {
      return calendarError(error);
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
        organizationId: apiKeyRecord.organizationId,
        title: body.title,
        description: body.description,
        eventType: body.eventType,
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
        permissions: apiKeyRecord.permissions,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return calendarError(error);
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
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
        permissions: apiKeyRecord.permissions,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return calendarError(error);
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
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
        permissions: apiKeyRecord.permissions,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return calendarError(error);
    }
  }),
});

// Cancel calendar event
http.route({
  path: "/api/v1/calendar/events/cancel",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKeyRecord = await authenticateApiKey(ctx, request);
      const denied = requireRoutePermission(apiKeyRecord, "POST", "/api/v1/calendar/events/cancel");
      if (denied) return denied;
      const body = await request.json();
      if (!body.eventId) return errorResponse("eventId required", 400);

      await ctx.runMutation(internal.calendar.internalCancelEvent, {
        eventId: body.eventId as Id<"calendarEvents">,
        organizationId: apiKeyRecord.organizationId,
        teamMemberId: apiKeyRecord.teamMemberId,
        permissions: apiKeyRecord.permissions,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return calendarError(error);
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
      if (!body.eventId || !isFiniteNumber(body.newStartTime)) return errorResponse("eventId and newStartTime required (epoch ms)", 400);

      await ctx.runMutation(internal.calendar.internalRescheduleEvent, {
        eventId: body.eventId as Id<"calendarEvents">,
        organizationId: apiKeyRecord.organizationId,
        newStartTime: body.newStartTime,
        newEndTime: body.newEndTime,
        teamMemberId: apiKeyRecord.teamMemberId,
        permissions: apiKeyRecord.permissions,
      });

      return jsonResponse({ success: true });
    } catch (error) {
      return calendarError(error);
    }
  }),
});

// ---- Agenda v2 (I1): agendamentos, horários livres, fechar recurso, conflitos ----
// Handlers finos: chamam as `internal*` de `schedulingRest.ts` (leituras e fechamento) e de `schedulingMutations.ts`
// (marcar, remarcar, cancelar, status…) com o ATOR = membro dono da chave (humano, `via: "rest"`, origem `api`).
// Erro de regra (`sched_rules`) = 409 `{ error, code: "sched_rules", violations, alternatives }`; id malformado = 400;
// inexistente/outra org/que a chave não enxerga = 404 (mesma resposta); sem permissão = 403; módulo desligado = 400
// "Módulo não habilitado: Agenda" (o padrão de `assertModule` nas demais rotas). Datas de entrada e saída: ISO com offset,
// `…Local` (AAAA-MM-DDTHH:mm no fuso da org) e `timezone`.

const SCHED_ID_RE = /^[A-Za-z0-9;_-]{1,64}$/;
const SCHED_STATUS_FILTERS = ["pending_approval", "scheduled", "confirmed", "checked_in", "completed", "no_show", "cancelled", "rescheduled"] as const;
const SCHED_STATUS_TARGETS = ["scheduled", "confirmed", "checked_in", "completed", "no_show"] as const;

/** Credenciais da chave para as `internal*` da agenda (membro dono + permissões da CHAVE). */
function schedKey(auth: { organizationId: Id<"organizations">; teamMemberId: Id<"teamMembers">; permissions: Permissions }) {
  return { organizationId: auth.organizationId, teamMemberId: auth.teamMemberId, permissions: auth.permissions };
}
function schedActor(auth: { teamMemberId: Id<"teamMembers"> }) {
  return { type: "human" as const, memberId: auth.teamMemberId, via: "rest" as const };
}

function schedId<T extends string>(value: unknown): T | null {
  return typeof value === "string" && SCHED_ID_RE.test(value) ? (value as T) : null;
}
/** `undefined` = ausente; `null` = inválida; senão a lista (teto 10). */
function schedIdList<T extends string>(value: unknown): T[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 10) return null;
  const out: T[] = [];
  for (const item of value) {
    const id = schedId<T>(item);
    if (id === null) return null;
    out.push(id);
  }
  return out;
}
function schedStringList(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 10) return null;
  return value.every((x) => typeof x === "string" && x.length > 0 && x.length <= 40) ? (value as string[]) : null;
}

async function schedBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function schedViolations(violations: Array<{ code: string; severity: string; message: string }>) {
  return violations.map((v) => ({ code: v.code, severity: v.severity, message: v.message }));
}

/** 409 de regra: corpo estruturado; `alternatives` no formato `Slot` (com ISO e hora local). */
async function schedRulesResponse(
  ctx: any,
  organizationId: Id<"organizations"> | undefined,
  violations: Array<{ code: string; severity: string; message: string }>,
  alternatives: Array<{ startTime: number; endTime: number }>
): Promise<Response> {
  const tz = organizationId ? await ctx.runQuery(internal.schedulingRest.internalTimezone, { organizationId }) : "";
  const decorated = tz ? alternatives.map((s) => withTimes(s, tz)) : alternatives;
  const body = {
    error: violations[0]?.message ?? "As regras da agenda impediram esta operação.",
    code: "sched_rules",
    violations: schedViolations(violations),
    alternatives: decorated,
  };
  return new Response(JSON.stringify(body), { status: 409, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

/** Dados de um `ConvexError({ code: "sched_rules", … })`, mesmo quando chega serializado. */
function schedRulesData(error: unknown): { violations: any[]; alternatives: any[] } | null {
  const tryParse = (text: string): unknown => {
    const at = text.indexOf("{");
    if (at === -1) return undefined;
    try {
      return JSON.parse(text.slice(at).split("\n")[0]);
    } catch {
      return undefined;
    }
  };
  const candidates: unknown[] = [];
  if (error instanceof ConvexError) candidates.push(error.data);
  if (error instanceof Error) candidates.push(error.message);
  for (const c of candidates) {
    const data = typeof c === "string" ? tryParse(c) : c;
    if (typeof data !== "object" || data === null) continue;
    const d = data as { code?: unknown; violations?: unknown; alternatives?: unknown };
    if (d.code !== "sched_rules") continue;
    return { violations: Array.isArray(d.violations) ? d.violations : [], alternatives: Array.isArray(d.alternatives) ? d.alternatives : [] };
  }
  return null;
}

/** Erros da agenda: regra = 409; chave de idempotência reusada = 409; "não encontrado" = 404; o resto como `startConversationError`. */
async function schedError(ctx: any, organizationId: Id<"organizations"> | undefined, error: unknown): Promise<Response> {
  const rules = schedRulesData(error);
  if (rules) return await schedRulesResponse(ctx, organizationId, rules.violations, rules.alternatives);
  const raw = plainErrorMessage(error);
  if (raw.startsWith(IDEMPOTENCY_REUSED_MESSAGE)) {
    return new Response(JSON.stringify({ error: raw, code: "idempotency_key_reused" }), {
      status: 409,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (/não encontrad[oa]$/i.test(raw)) return errorResponse(raw, 404);
  return startConversationError(error);
}

/** Entrada de data da escrita: `startsAt` | `startsAtLocal` | `startTime`; o fuso da org converte a hora local. */
async function schedWhen(ctx: any, organizationId: Id<"organizations">, body: Record<string, unknown>): Promise<{ startTime: number } | Response> {
  const tz: string = await ctx.runQuery(internal.schedulingRest.internalTimezone, { organizationId });
  const when = parseWhen({ startsAt: body.startsAt, startsAtLocal: body.startsAtLocal, startTime: body.startTime }, tz);
  return when.ok ? { startTime: when.startTime } : errorResponse(when.error, 400);
}

function schedIdemKey(request: Request, body: Record<string, unknown>) {
  return restIdempotencyKey(request.headers.get("Idempotency-Key") ?? body.requestId);
}

/** Campos comuns de prévia e criação. Devolve a `Response` 400 quando algo é inválido. */
async function schedBookParts(ctx: any, organizationId: Id<"organizations">, body: Record<string, unknown>) {
  const serviceId = schedId<Id<"schedServices">>(body.serviceId);
  if (!serviceId) return errorResponse("serviceId inválido ou ausente", 400);
  const when = await schedWhen(ctx, organizationId, body);
  if (when instanceof Response) return when;
  const optional = (name: string) => (body[name] === undefined || body[name] === null ? undefined : schedId<string>(body[name]));
  const contactId = optional("contactId");
  const leadId = optional("leadId");
  const conversationId = optional("conversationId");
  if (contactId === null) return errorResponse("contactId inválido", 400);
  if (leadId === null) return errorResponse("leadId inválido", 400);
  if (conversationId === null) return errorResponse("conversationId inválido", 400);
  const resourceIds = schedIdList<Id<"schedResources">>(body.resourceIds);
  if (resourceIds === null) return errorResponse("resourceIds inválido (lista de até 10 ids)", 400);
  const force = schedStringList(body.force);
  if (force === null) return errorResponse("force inválido (lista de códigos de aviso)", 400);
  if (body.variantKey !== undefined && typeof body.variantKey !== "string") return errorResponse("variantKey inválido", 400);
  const notes = cleanBodyText(body.notes, 500);
  return {
    serviceId,
    startTime: when.startTime,
    ...(typeof body.variantKey === "string" ? { variantKey: body.variantKey } : {}),
    ...(contactId ? { contactId: contactId as Id<"contacts"> } : {}),
    ...(leadId ? { leadId: leadId as Id<"leads"> } : {}),
    ...(conversationId ? { conversationId: conversationId as Id<"conversations"> } : {}),
    ...(resourceIds ? { resourceIds } : {}),
    ...(force ? { force } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** Resultado achatado de uma porta de reserva: `ok:false` = 409 de regra. */
async function schedOutcome(
  ctx: any,
  organizationId: Id<"organizations">,
  result: { ok: boolean; violations: any[]; alternatives: any[] },
  onOk: () => Response
): Promise<Response> {
  if (!result.ok) return await schedRulesResponse(ctx, organizationId, result.violations, result.alternatives);
  return onOk();
}

function schedBookedBody(result: { appointmentId?: string; status?: string; created: boolean; duplicate: boolean; inConflict: boolean; warnings: any[] }) {
  return {
    success: true,
    appointmentId: result.appointmentId,
    status: result.status,
    created: result.created,
    duplicate: result.duplicate,
    inConflict: result.inConflict,
    warnings: schedViolations(result.warnings),
  };
}

// Serviços ativos
http.route({
  path: "/api/v1/scheduling/services",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "GET", "/api/v1/scheduling/services");
      if (denied) return denied;
      const catalog = await ctx.runQuery(internal.schedulingRest.internalCatalog, schedKey(auth));
      return jsonResponse({
        timezone: catalog.timezone,
        services: catalog.services.map(({ organizationId: _o, ...s }: { organizationId: unknown }) => s),
      });
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Recursos ativos (pessoa, sala, equipamento)
http.route({
  path: "/api/v1/scheduling/resources",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "GET", "/api/v1/scheduling/resources");
      if (denied) return denied;
      const catalog = await ctx.runQuery(internal.schedulingRest.internalCatalog, schedKey(auth));
      return jsonResponse({
        timezone: catalog.timezone,
        resources: catalog.resources.map(({ organizationId: _o, ...r }: { organizationId: unknown }) => r),
      });
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Horários livres (serviceId + from [+ to, até 7 dias], period, resourceIds, partySize, rescheduleAppointmentId)
http.route({
  path: "/api/v1/scheduling/slots",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "GET", "/api/v1/scheduling/slots");
      if (denied) return denied;
      const url = new URL(request.url);
      const serviceId = schedId<Id<"schedServices">>(url.searchParams.get("serviceId"));
      if (!serviceId) return errorResponse("serviceId inválido ou ausente", 400);
      const from = url.searchParams.get("from");
      if (!from) return errorResponse("from required (AAAA-MM-DD)", 400);
      const to = url.searchParams.get("to") || undefined;
      const period = url.searchParams.get("period") || undefined;
      if (period !== undefined && !["manha", "tarde", "noite", "qualquer"].includes(period)) {
        return errorResponse("period deve ser manha, tarde, noite ou qualquer", 400);
      }
      const rawResources = url.searchParams.get("resourceIds");
      const resourceIds = rawResources ? rawResources.split(",").map((s) => s.trim()).filter(Boolean) : [];
      if (resourceIds.length > 10 || resourceIds.some((id) => !schedId(id))) return errorResponse("resourceIds inválido", 400);
      const rescheduleRaw = url.searchParams.get("rescheduleAppointmentId");
      const rescheduleAppointmentId = rescheduleRaw ? schedId<SchedAppointmentId>(rescheduleRaw) : undefined;
      if (rescheduleRaw && !rescheduleAppointmentId) return errorResponse("rescheduleAppointmentId inválido", 400);
      const partySize = numParam(url.searchParams.get("partySize"));
      const limit = numParam(url.searchParams.get("limit"));
      if (Number.isNaN(partySize) || Number.isNaN(limit)) return errorResponse("partySize e limit devem ser números", 400);
      const result = await ctx.runQuery(internal.schedulingRest.internalFindSlots, {
        ...schedKey(auth),
        serviceId,
        fromLocalDate: from,
        ...(to ? { toLocalDate: to } : {}),
        ...(url.searchParams.get("variantKey") ? { variantKey: url.searchParams.get("variantKey") as string } : {}),
        ...(period ? { period: period as "manha" | "tarde" | "noite" | "qualquer" } : {}),
        ...(resourceIds.length > 0 ? { resourceIds: resourceIds as Id<"schedResources">[] } : {}),
        ...(rescheduleAppointmentId ? { rescheduleAppointmentId } : {}),
        ...(partySize !== undefined ? { partySize } : {}),
        ...(limit !== undefined ? { limit } : {}),
        now: Math.floor(Date.now() / 60_000) * 60_000,
      });
      const tz = result.timezone;
      return jsonResponse({
        ...result,
        slots: result.slots.map((s: { startTime: number; endTime: number }) => withTimes(s, tz)),
        ...(result.firstPossible ? { firstPossible: withTimes(result.firstPossible, tz) } : {}),
        earliestBookableAtIso: isoWithOffset(result.earliestBookableAt, tz),
      });
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Agendamentos por intervalo de datas locais (paginação por cursor)
http.route({
  path: "/api/v1/scheduling/appointments",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "GET", "/api/v1/scheduling/appointments");
      if (denied) return denied;
      const url = new URL(request.url);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to") || from;
      if (!from || !to) return errorResponse("from required (AAAA-MM-DD); to opcional (padrão = from)", 400);
      const status = url.searchParams.get("status") || undefined;
      if (status !== undefined && !(SCHED_STATUS_FILTERS as readonly string[]).includes(status)) return errorResponse("status inválido", 400);
      const limit = numParam(url.searchParams.get("limit"));
      if (Number.isNaN(limit)) return errorResponse("limit must be a number", 400);
      const page = await ctx.runQuery(internal.schedulingRest.internalListAppointments, {
        ...schedKey(auth),
        fromLocalDate: from,
        toLocalDate: to,
        ...(status ? { status: status as (typeof SCHED_STATUS_FILTERS)[number] } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor") as string } : {}),
      });
      return jsonResponse({
        timezone: page.timezone,
        appointments: page.appointments.map((a: { startTime: number; endTime: number }) => withTimes(a, page.timezone)),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Um agendamento (id na query string)
http.route({
  path: "/api/v1/scheduling/appointments/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "GET", "/api/v1/scheduling/appointments/get");
      if (denied) return denied;
      const appointmentId = schedId<SchedAppointmentId>(new URL(request.url).searchParams.get("id"));
      if (!appointmentId) return errorResponse("id inválido ou ausente", 400);
      const found = await ctx.runQuery(internal.schedulingRest.internalGetAppointment, { ...schedKey(auth), appointmentId });
      if (!found) return errorResponse("Agendamento não encontrado", 404);
      const { detail, timezone } = found;
      return jsonResponse({
        appointment: withTimes(detail.appointment, timezone),
        openConflicts: detail.openConflicts,
        canEdit: detail.canEdit,
        createdByName: detail.createdByName,
        statusActors: detail.statusActors,
      });
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Pendências: aprovações, conflitos, sem desfecho e sugestões (as sugestões só para `view_all`+)
http.route({
  path: "/api/v1/scheduling/pending",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "GET", "/api/v1/scheduling/pending");
      if (denied) return denied;
      const { pending, timezone } = await ctx.runQuery(internal.schedulingRest.internalListPending, {
        ...schedKey(auth),
        now: Math.floor(Date.now() / 3_600_000) * 3_600_000,
      });
      const rows = (list: Array<{ startTime: number; endTime: number }>) => list.map((a) => withTimes(a, timezone));
      return jsonResponse({
        timezone,
        approvals: rows(pending.approvals),
        conflicts: pending.conflicts.map((c: { appointment: { startTime: number; endTime: number } | null }) => ({
          ...c,
          appointment: c.appointment ? withTimes(c.appointment, timezone) : null,
        })),
        noOutcome: rows(pending.noOutcome),
        suggestions: pending.suggestions,
        capped: pending.capped,
      });
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Prévia de marcar (ou de remarcar, com rescheduleAppointmentId): não grava nada
http.route({
  path: "/api/v1/scheduling/appointments/preview",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/appointments/preview");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const parts = await schedBookParts(ctx, auth.organizationId, body);
      if (parts instanceof Response) return parts;
      const rescheduleRaw = body.rescheduleAppointmentId;
      const rescheduleAppointmentId = rescheduleRaw === undefined || rescheduleRaw === null ? undefined : schedId<SchedAppointmentId>(rescheduleRaw);
      if (rescheduleAppointmentId === null) return errorResponse("rescheduleAppointmentId inválido", 400);
      const result = await ctx.runMutation(internal.schedulingMutations.internalBookAppointment, {
        organizationId: auth.organizationId,
        ...parts,
        actor: schedActor(auth),
        origin: "api",
        mode: "preview",
        ...(rescheduleAppointmentId ? { rescheduleAppointmentId } : {}),
      });
      return await schedOutcome(ctx, auth.organizationId, result, () =>
        jsonResponse({ preview: true, plan: result.plan, warnings: schedViolations(result.warnings), ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}) })
      );
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Marcar. `Idempotency-Key` (cabeçalho) ou `requestId` (corpo) OBRIGATÓRIO: mesma chave = mesmo agendamento
http.route({
  path: "/api/v1/scheduling/appointments/book",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/appointments/book");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const key = schedIdemKey(request, body);
      if (!key.ok) return errorResponse(key.error, 400);
      const parts = await schedBookParts(ctx, auth.organizationId, body);
      if (parts instanceof Response) return parts;
      const result = await ctx.runMutation(internal.schedulingMutations.internalBookAppointment, {
        organizationId: auth.organizationId,
        ...parts,
        actor: schedActor(auth),
        origin: "api",
        mode: "commit",
        idempotencyKey: key.key,
      });
      return await schedOutcome(ctx, auth.organizationId, result, () => jsonResponse(schedBookedBody(result), result.created ? 201 : 200));
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Remarcar (novo agendamento + o antigo `rescheduled`, na mesma transação). `Idempotency-Key`/`requestId` opcional
http.route({
  path: "/api/v1/scheduling/appointments/reschedule",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/appointments/reschedule");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const appointmentId = schedId<SchedAppointmentId>(body.appointmentId);
      if (!appointmentId) return errorResponse("appointmentId inválido ou ausente", 400);
      const when = await schedWhen(ctx, auth.organizationId, body);
      if (when instanceof Response) return when;
      const resourceIds = schedIdList<Id<"schedResources">>(body.resourceIds);
      if (resourceIds === null) return errorResponse("resourceIds inválido (lista de até 10 ids)", 400);
      const force = schedStringList(body.force);
      if (force === null) return errorResponse("force inválido (lista de códigos de aviso)", 400);
      const rawKey = request.headers.get("Idempotency-Key") ?? body.requestId;
      const key = rawKey === undefined || rawKey === null ? undefined : schedIdemKey(request, body);
      if (key && !key.ok) return errorResponse(key.error, 400);
      const result = await ctx.runMutation(internal.schedulingMutations.internalRescheduleAppointment, {
        organizationId: auth.organizationId,
        appointmentId,
        actor: schedActor(auth),
        startTime: when.startTime,
        ...(resourceIds ? { resourceIds } : {}),
        ...(force ? { force } : {}),
        ...(key && key.ok ? { idempotencyKey: key.key } : {}),
      });
      return await schedOutcome(ctx, auth.organizationId, result, () => jsonResponse(schedBookedBody(result)));
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Cancelar (`cancelledBy`: staff (padrão) ou client)
http.route({
  path: "/api/v1/scheduling/appointments/cancel",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/appointments/cancel");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const appointmentId = schedId<SchedAppointmentId>(body.appointmentId);
      if (!appointmentId) return errorResponse("appointmentId inválido ou ausente", 400);
      if (body.cancelledBy !== undefined && body.cancelledBy !== "staff" && body.cancelledBy !== "client") {
        return errorResponse("cancelledBy deve ser staff ou client", 400);
      }
      const result = await ctx.runMutation(internal.schedulingMutations.internalCancelAppointment, {
        organizationId: auth.organizationId,
        appointmentId,
        actor: schedActor(auth),
        byClass: body.cancelledBy === "client" ? "client" : "staff",
        ...(cleanBodyText(body.reason, 200) ? { reason: cleanBodyText(body.reason, 200) } : {}),
      });
      return jsonResponse({ success: true, lateCancel: result.lateCancel });
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Mudar status: to = scheduled (aprovar) | confirmed | checked_in | completed | no_show. `action: "reject"` recusa (cancela)
http.route({
  path: "/api/v1/scheduling/appointments/status",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/appointments/status");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const appointmentId = schedId<SchedAppointmentId>(body.appointmentId);
      if (!appointmentId) return errorResponse("appointmentId inválido ou ausente", 400);
      if (body.action === "reject") {
        const cancelled = await ctx.runMutation(internal.schedulingMutations.internalCancelAppointment, {
          organizationId: auth.organizationId,
          appointmentId,
          actor: schedActor(auth),
          byClass: "staff",
          ...(cleanBodyText(body.reason, 200) ? { reason: cleanBodyText(body.reason, 200) } : {}),
        });
        return jsonResponse({ success: true, lateCancel: cancelled.lateCancel });
      }
      const to = body.action === "approve" ? "scheduled" : body.to;
      if (typeof to !== "string" || !(SCHED_STATUS_TARGETS as readonly string[]).includes(to)) {
        return errorResponse("to deve ser scheduled, confirmed, checked_in, completed ou no_show (ou action: approve | reject)", 400);
      }
      await ctx.runMutation(internal.schedulingMutations.internalSetAppointmentStatus, {
        organizationId: auth.organizationId,
        appointmentId,
        actor: schedActor(auth),
        to: to as (typeof SCHED_STATUS_TARGETS)[number],
      });
      return jsonResponse({ success: true });
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Desfazer a última mudança de status
http.route({
  path: "/api/v1/scheduling/appointments/undo-status",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/appointments/undo-status");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const appointmentId = schedId<SchedAppointmentId>(body.appointmentId);
      if (!appointmentId) return errorResponse("appointmentId inválido ou ausente", 400);
      const result = await ctx.runMutation(internal.schedulingMutations.internalUndoAppointmentStatus, {
        organizationId: auth.organizationId,
        appointmentId,
        actor: schedActor(auth),
      });
      return await schedOutcome(ctx, auth.organizationId, result, () => jsonResponse({ success: true, restoredTo: result.restoredTo }));
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Trocar sala/profissional/equipamento (mesmas regras de capacidade de marcar)
http.route({
  path: "/api/v1/scheduling/appointments/resources",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/appointments/resources");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const appointmentId = schedId<SchedAppointmentId>(body.appointmentId);
      if (!appointmentId) return errorResponse("appointmentId inválido ou ausente", 400);
      const resourceIds = schedIdList<Id<"schedResources">>(body.resourceIds);
      if (!resourceIds || resourceIds.length === 0) return errorResponse("resourceIds inválido ou ausente", 400);
      const force = schedStringList(body.force);
      if (force === null) return errorResponse("force inválido (lista de códigos de aviso)", 400);
      const result = await ctx.runMutation(internal.schedulingMutations.internalReassignResources, {
        organizationId: auth.organizationId,
        appointmentId,
        actor: schedActor(auth),
        resourceIds,
        ...(force ? { force } : {}),
      });
      return await schedOutcome(ctx, auth.organizationId, result, () => jsonResponse(schedBookedBody(result)));
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

/** Campos comuns de fechar/reabrir recurso (escopo, datas, aceite). `Response` 400 quando inválido. */
function schedClosureParts(body: Record<string, unknown>) {
  const resourceId = body.resourceId === undefined || body.resourceId === null ? undefined : schedId<Id<"schedResources">>(body.resourceId);
  if (resourceId === null) return errorResponse("resourceId inválido", 400);
  const kinds = ["room", "person", "equipment"];
  if (body.resourceKind !== undefined && !kinds.includes(body.resourceKind as string)) return errorResponse("resourceKind deve ser room, person ou equipment", 400);
  if (typeof body.fromLocalDate !== "string") return errorResponse("fromLocalDate required (AAAA-MM-DD)", 400);
  if (body.toLocalDate !== undefined && typeof body.toLocalDate !== "string") return errorResponse("toLocalDate inválido", 400);
  const mode = body.mode === undefined ? "preview" : body.mode;
  if (mode !== "preview" && mode !== "commit") return errorResponse("mode deve ser preview (padrão) ou commit", 400);
  if (body.acceptAffected !== undefined && typeof body.acceptAffected !== "boolean") return errorResponse("acceptAffected deve ser booleano", 400);
  if (body.expectedAffected !== undefined && !isFiniteNumber(body.expectedAffected)) return errorResponse("expectedAffected deve ser número", 400);
  const exceptionKinds = ["closed", "custom", "extra", "block"];
  if (body.kind !== undefined && !exceptionKinds.includes(body.kind as string)) return errorResponse("kind deve ser closed, custom, extra ou block", 400);
  return {
    ...(resourceId ? { resourceId } : {}),
    ...(body.resourceKind !== undefined ? { resourceKind: body.resourceKind as "room" | "person" | "equipment" } : {}),
    fromLocalDate: body.fromLocalDate,
    ...(typeof body.toLocalDate === "string" ? { toLocalDate: body.toLocalDate } : {}),
    ...(body.kind !== undefined ? { kind: body.kind as "closed" | "custom" | "extra" | "block" } : {}),
    mode: mode as "preview" | "commit",
    ...(body.acceptAffected !== undefined ? { acceptAffected: body.acceptAffected as boolean } : {}),
    ...(body.expectedAffected !== undefined ? { expectedAffected: body.expectedAffected as number } : {}),
  };
}

/** Linhas do fechamento com ISO e hora local (nunca nome além do que a tela mostra à equipe). */
function schedClosureBody(result: { items: Array<{ startTime: number }> }, tz: string) {
  return { ...result, items: result.items.map((i) => withTimes(i, tz)) };
}

// Fechar recurso/dia (ou horário especial, extra, bloqueio). `mode: "preview"` (padrão) não grava; `commit` com
// `expectedAffected` (a contagem da prévia) e `acceptAffected`. Sem `resourceId` (agenda inteira ou tipo) exige `manage`.
http.route({
  path: "/api/v1/scheduling/resources/day",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/resources/day");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const parts = schedClosureParts(body);
      if (parts instanceof Response) return parts;
      if (parts.resourceId === undefined && !hasPermission(auth.permissions, "agenda", "manage")) {
        return errorResponse(PERMISSION_DENIED_MESSAGE, 403);
      }
      const reasonCodes = ["no_staff", "maintenance", "day_off", "holiday", "other"];
      if (body.reasonCode !== undefined && !reasonCodes.includes(body.reasonCode as string)) return errorResponse("reasonCode inválido", 400);
      const intervals = Array.isArray(body.intervals) ? body.intervals : undefined;
      if (body.intervals !== undefined && (!intervals || intervals.length > 6 || !intervals.every((i: any) => i && isFiniteNumber(i.startMin) && isFiniteNumber(i.endMin)))) {
        return errorResponse("intervals inválido (até 6 itens { startMin, endMin })", 400);
      }
      const result = await ctx.runMutation(internal.schedulingRest.internalSetResourceDay, {
        ...schedKey(auth),
        ...parts,
        ...(intervals ? { intervals: intervals.map((i: any) => ({ startMin: i.startMin, endMin: i.endMin })) } : {}),
        ...(body.reasonCode !== undefined ? { reasonCode: body.reasonCode as "no_staff" | "maintenance" | "day_off" | "holiday" | "other" } : {}),
        ...(cleanBodyText(body.reason, 120) ? { reason: cleanBodyText(body.reason, 120) } : {}),
      });
      const tz: string = await ctx.runQuery(internal.schedulingRest.internalTimezone, { organizationId: auth.organizationId });
      return jsonResponse(schedClosureBody(result, tz));
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Reabrir recurso/dia (remove as exceções manuais do tipo pedido; não desfaz realocações). Mesma prévia e mesmo `manage`
http.route({
  path: "/api/v1/scheduling/resources/reopen",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/resources/reopen");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const parts = schedClosureParts(body);
      if (parts instanceof Response) return parts;
      if (parts.resourceId === undefined && !hasPermission(auth.permissions, "agenda", "manage")) {
        return errorResponse(PERMISSION_DENIED_MESSAGE, 403);
      }
      const result = await ctx.runMutation(internal.schedulingRest.internalReopenResourceDay, { ...schedKey(auth), ...parts });
      const tz: string = await ctx.runQuery(internal.schedulingRest.internalTimezone, { organizationId: auth.organizationId });
      return jsonResponse(schedClosureBody(result, tz));
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Andamento de um fechamento em lotes (`runId` devolvido por resources/day)
http.route({
  path: "/api/v1/scheduling/closures/get",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "GET", "/api/v1/scheduling/closures/get");
      if (denied) return denied;
      const runId = schedId<Id<"schedClosureRuns">>(new URL(request.url).searchParams.get("runId"));
      if (!runId) return errorResponse("runId inválido ou ausente", 400);
      const run = await ctx.runQuery(internal.schedulingRest.internalGetClosureRun, { ...schedKey(auth), runId });
      if (!run) return errorResponse("Fechamento não encontrado", 404);
      return jsonResponse({ run });
    } catch (error) {
      return await schedError(ctx, orgId, error);
    }
  }),
});

// Resolver conflito: action = { type: "resource", resourceIds } | { type: "reschedule", startsAt|startsAtLocal|startTime, resourceIds? }
// | { type: "cancel", reason? } | { type: "manual", note? }
http.route({
  path: "/api/v1/scheduling/conflicts/resolve",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let orgId: Id<"organizations"> | undefined;
    try {
      const auth = await authenticateApiKey(ctx, request);
      orgId = auth.organizationId;
      const denied = requireRoutePermission(auth, "POST", "/api/v1/scheduling/conflicts/resolve");
      if (denied) return denied;
      const body = await schedBody(request);
      if (!body) return errorResponse("Corpo JSON inválido", 400);
      const conflictId = schedId<Id<"schedConflicts">>(body.conflictId);
      if (!conflictId) return errorResponse("conflictId inválido ou ausente", 400);
      const raw = body.action;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return errorResponse("action required", 400);
      const act = raw as Record<string, unknown>;
      const resourceIds = schedIdList<Id<"schedResources">>(act.resourceIds);
      if (resourceIds === null) return errorResponse("resourceIds inválido (lista de até 10 ids)", 400);
      const force = schedStringList(act.force);
      if (force === null) return errorResponse("force inválido (lista de códigos de aviso)", 400);
      let action:
        | { type: "resource"; resourceIds: Id<"schedResources">[]; force?: string[] }
        | { type: "reschedule"; startTime: number; resourceIds?: Id<"schedResources">[]; force?: string[] }
        | { type: "cancel"; reason?: string }
        | { type: "manual"; note?: string };
      if (act.type === "resource") {
        if (!resourceIds || resourceIds.length === 0) return errorResponse("action.resourceIds required", 400);
        action = { type: "resource", resourceIds, ...(force ? { force } : {}) };
      } else if (act.type === "reschedule") {
        const when = await schedWhen(ctx, auth.organizationId, act);
        if (when instanceof Response) return when;
        action = { type: "reschedule", startTime: when.startTime, ...(resourceIds ? { resourceIds } : {}), ...(force ? { force } : {}) };
      } else if (act.type === "cancel") {
        const reason = cleanBodyText(act.reason, 200);
        action = { type: "cancel", ...(reason ? { reason } : {}) };
      } else if (act.type === "manual") {
        const note = cleanBodyText(act.note, 200);
        action = { type: "manual", ...(note ? { note } : {}) };
      } else {
        return errorResponse("action.type deve ser resource, reschedule, cancel ou manual", 400);
      }
      await ctx.runMutation(internal.schedulingRest.internalResolveConflict, { ...schedKey(auth), conflictId, action });
      return jsonResponse({ success: true });
    } catch (error) {
      return await schedError(ctx, orgId, error);
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

// ---- Meta Messaging (Instagram + Messenger): webhook único e callback do OAuth ----
// Fora de /api/v1 (sem API key), como os webhooks acima.
http.route({ path: "/webhooks/meta-messaging", method: "GET", handler: metaMessagingWebhookVerify });
http.route({ path: "/webhooks/meta-messaging", method: "POST", handler: metaMessagingWebhookReceive });
http.route({ path: "/oauth/meta/callback", method: "GET", handler: metaOAuthCallback });
// Callbacks da Meta (F5): assinados com signed_request, fora de /api/v1.
http.route({ path: "/webhooks/meta-messaging/deauthorize", method: "POST", handler: metaDeauthorizeCallback });
http.route({ path: "/webhooks/meta-messaging/data-deletion", method: "POST", handler: metaDataDeletionCallback });
http.route({ path: "/meta/deletion-status", method: "GET", handler: metaDeletionStatusPage });

// ---- Telegram (Copiloto da equipe, F0): bot da plataforma. secret_token no header, fora de /api/v1.
// O segmento `platform` vira `<botKey>` quando houver bots por org (F6).
http.route({ path: "/webhooks/telegram/platform", method: "POST", handler: telegramWebhook });
// Cobrança (Asaas): autenticado pelo token do emissor (header `asaas-access-token`), fora do /api/v1.
http.route({ path: "/webhooks/asaas", method: "POST", handler: asaasWebhook });

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
http.route({ path: "/api/v1/conversations/channels", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/conversations/start", method: "OPTIONS", handler: optionsHandler });
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
http.route({ path: "/api/v1/calendar/events/cancel", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/services", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/resources", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/slots", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/appointments", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/appointments/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/pending", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/appointments/preview", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/appointments/book", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/appointments/reschedule", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/appointments/cancel", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/appointments/status", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/appointments/undo-status", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/appointments/resources", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/resources/day", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/resources/reopen", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/closures/get", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/scheduling/conflicts/resolve", method: "OPTIONS", handler: optionsHandler });
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
http.route({ path: "/api/v1/public/contact", method: "OPTIONS", handler: optionsHandler });
http.route({ path: "/api/v1/public/newsletter", method: "OPTIONS", handler: optionsHandler });
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
