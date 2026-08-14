# CLAUDE.md — Convex Backend

## File Layout

| File | Purpose |
|------|---------|
| `schema.ts` | All table definitions, indexes, validators |
| `auth.ts` / `auth.config.ts` | Auth providers (Password + Anonymous) |
| `convex.config.ts` | Convex component registration (Resend email) |
| `crons.ts` | Scheduled jobs (overdue reminders, recurring tasks, daily digest) |
| `http.ts` | Wires HTTP routes from `router.ts` |
| `router.ts` | RESTful API endpoints (`/api/v1/*`), API key auth |
| `leads.ts` | Lead CRUD, stage moves, assignment, qualification |
| `contacts.ts` | Contact CRUD |
| `conversations.ts` | Multi-channel conversations + messages, full-text search, archiving, labels, contact presence |
| `transcription.ts` | Voice-note transcription via self-hosted Whisper (`transcribe` user action + `autoTranscribe` post-ingest) |
| `quickReplies.ts` | Quick replies CRUD — "/" shortcuts in the inbox composer |
| `scheduledMessages.ts` | Scheduled messages: schedule/cancel + delivery via `ctx.scheduler.runAt` |
| `channelConfigs.ts` | Per-org WhatsApp channel configs (provider meta\|bridge), encrypted credentials, health checks, bridge provisioning |
| `whatsapp.ts` | WhatsApp ingress (`/webhooks/whatsapp`, Meta handshake) + outbound dispatch branched by provider; retry pacing-aware (backoff oficial 4^X p/ 131056/130429/80007) e congelamento de canal em 131048 (spam-flag) |
| `bridge.ts` | Unofficial bridge ingress (`POST /webhooks/bridge`, wuzapi/whatsmeow), HMAC-verified via `WA_BRIDGE_HMAC_SECRET` |
| `lib/bridgeParse.ts` | Pure parser for wuzapi webhook payloads + HMAC verification (no ctx) |
| `lib/bridgeSend.ts` | Pure adapter for the wuzapi REST send API (text + media request builders / response parser) |
| `lib/bridgeMedia.ts` | Bidirectional bridge media helpers (download/decrypt + outbound encode) |
| `lib/bridgeSession.ts` | Bridge session lifecycle: QR pairing, status, gateway provisioning (`POST /admin/users`) |
| `handoffs.ts` | Repasse IA→humano: caminho ÚNICO de criação `createHandoffCore` (todos os gatilhos — humano, palavra-chave, tool, falha) que resolve `conversationId` de origem, notifica in-app (destinatário ou broadcast p/ `inbox >= reply`) e dispara webhook; criar NÃO pausa a conversa; accept = assumir (pausa IA + atribui lead + desarquiva → UI navega p/ a conversa), reject devolve à IA, status `canceled` p/ repasse cancelado pelo returnToAi |
| `attendant.ts` | Atendente IA: fila (aiReplyQueue), elegibilidade (11 condições), lock/lease OCC, commits transacionais, runtime, simulador, rascunhos com AÇÕES APROVÁVEIS (acceptAiDraft+actionIndexes → executor compartilhado), captura de dados (updateThisContact/updateThisLeadInfo com whitelist captureFields), estado por conversa (getConversationAiState), skip com rastro; loop de coaching `requestAiDraft`/`returnToAi` (SÓ app UI) — itens `humanInitiated` (`origin` coach\|return_to_ai) têm bypass RESTRITO no claim e commitam SEMPRE como sugestão, e a regeneração supersede o rascunho de origem p/ status `revised` (encadeado previousDraftId/nextDraftId) |
| `lib/channelResolve.ts` | Resolução ÚNICA do channelConfig de uma conversa (fallback determinístico, prefere Meta) — usada por atendente E dispatch |
| `lib/inboundRouting.ts` | Roteamento inbound → contato/lead; aplica o pipelineConfig do atendente do canal (board/estágio inicial) com fallback auditado |
| `lib/whatsappDispatch.ts` | Pacing de envio em 2 níveis: cursor por conversa (pair rate 6,5s) + cursor por número (`channelPacing`; Meta 1-3s, bridge reativo 4-10s / frio 8-15s), typing humanizado no bridge, claim OCC |
| `copilot.ts` | Copiloto: threads/mensagens + executores de tools (leitura via query, escrita via mutation com via:"copilot", destrutivo → pendingActions) |
| `copilotHttp.ts` | Streaming SSE autenticado do copiloto (`POST /api/copilot/stream`) com loop de tool_calls |
| `aiSettings.ts` | Config de IA da org: ativação + LGPD ack, atendente 1-toque, perfil/modo (gate do autopilot), modelos/ZDR, budget, métricas — contadores `revised` (rascunho substituído por instrução humana) e `coached` (turnos pedidos por humano) ficam FORA do cálculo de aceitação que libera o autopilot |
| `aiDiagnostics.ts` | Ops: `pingProvider` — smoke de conectividade LLM a partir do deployment |
| `testReset.ts` | Comandos de teste via WhatsApp — `/resetme` (hard delete do próprio remetente), `/resetlist` (10 leads mais recentes, numerados) e `/resetother <nº\|sufixo do telefone>` (hard delete de outro lead, com confirmação no WhatsApp) — só com env `WA_TEST_RESET_PHONES` (allowlist de telefones; ausente = desligado) |
| `agentRuns.ts` | Registro de operações de IA (tokens/custo/tools — sem PII) |
| `agentEvals.ts` | Golden conversations + replay (regressão de persona via simulador) |
| `orgSecrets.ts` | BYO API keys por org (cifradas; leitura sempre mascarada) |
| `lib/agentSecurity.ts` | 4 camadas: assertAgentCan, escopo por registro, TOOL_DENYLIST + SECRET_FIELD_PATTERN, orgAiActive |
| `lib/agentTools.ts` | Registry ESTÁTICO de tools de IA (specs + projeção de resultado por whitelist) |
| `lib/agentRoutes.ts` | Resolve rotas LLM da org (platform chain ou BYO + strictZdr) |
| `lib/agentPersonas.ts` | Personas de atendente por indústria (sementes do 1-toque) |
| `lib/promptEnvelope.ts` | Envelope de dado não-confiável (`<crm_data untrusted>`) |
| `lib/outboundSideEffects.ts` | Side effects compartilhados de outbound (usado por conversations + attendant; evita ciclo de módulos) |
| `lib/llm/` | Camada LLM pura: types, registry (modelos/ZDR/capacidades), openaiCompatible (chat/stream/retry), index (chains/fallback), sanitize |
| `boards.ts` | Kanban boards and stages |
| `organizations.ts` | Organization CRUD + settings |
| `teamMembers.ts` | Human + AI team member management |
| `calendar.ts` | Calendar events CRUD (time-ranged events with recurrence) |
| `tasks.ts` | Task CRUD (projects/columns, labels, multi-assignee `assigneeIds`, real subtasks via `parentTaskId` + `getSubtasks`, informative `blockedBy` deps, manual kanban order, pre-due reminders, recurrence via `recurrenceSourceId`); `updateTask` aceita `null` p/ limpar `projectId`/`parentTaskId`/`assignedTo`/`leadId`/`contactId` (vínculos novos validados contra a org da task); `internal*` variants power the REST API + MCP (write params unchanged by P1; todas escopadas por org da API key — see `router.ts`) |
| `taskComments.ts` | Task comments, `authorType` human\|ai, `@mention` → in-app + e-mail notification via `lib/notify.ts` |
| `taskProjects.ts` | Task projects (CRUD, archive/reorder) + kanban columns per project (CRUD/reorder, done column, WIP limit) — admin/manager only for management |
| `taskLabels.ts` | Org-wide task labels with color (CRUD) — any member |
| `notifications.ts` | In-app notifications: list/unreadCount/markRead/markAllRead (bell in `AppShell`); tipos de tarefa + `handoff_requested`/`handoff_resolved`/`ai_draft_pending`, com ponteiros `handoffId`/`conversationId` p/ o deep-link do item |
| `lib/notify.ts` | `createNotification()` — inserts an in-app notification in the same transaction as the triggering mutation; skips AI members and self-notification; `PREFERENCE_FLAG` mapeia cada tipo para o flag de opt-out, incluindo os novos de handoff e `ai_draft_pending` → `aiDraftPending` |
| `activities.ts` | Activity timeline events on leads |
| `auditLogs.ts` | Audit trail queries |
| `dashboard.ts` | Aggregation queries for dashboard |
| `email.ts` | Central email dispatch, Resend instance, daily digest handler |
| `emailTemplates.ts` | Pure TS email template builders (8 templates, PT-BR) |
| `webhooks.ts` | Webhook CRUD |
| `webhookTrigger.ts` | Internal action that fires webhooks |
| `lib/auth.ts` | Shared `requireAuth()` + `requirePermission()` helpers |
| `lib/permissions.ts` | Shared permission types, defaults, hierarchy comparison |
| `lib/batchGet.ts` | Utility for batch-fetching documents by IDs |
| `authHelpers.ts` | Internal queries/mutations for auth table operations (user/authAccount CRUD) |
| `nodeActions.ts` | Node.js actions: API key hashing, webhook dispatch, invite, password change |
| `forms.ts` | Form builder CRUD: create, update, publish, archive, duplicate, slug check |
| `formSubmissions.ts` | Form submission processing, stats, spam detection |
| `notificationPreferences.ts` | Per-member notification preferences CRUD |
| `apiKeys.ts` | API key generation, validation, revocation, permission scoping |
| `leadSources.ts` / `fieldDefinitions.ts` | Lead sources + custom fields |
| `llmsTxt.ts` | `/llms.txt` and `/llms-full.txt` endpoint content |
| `onboarding.ts` / `onboardingSeed.ts` | Onboarding wizard + checklist state |
| `seed.ts` | Dev seed data |

## Auth Pattern (copy this for every public function)

```typescript
import { requireAuth } from "./lib/auth";

// In any public query/mutation with organizationId arg:
const userMember = await requireAuth(ctx, args.organizationId);

// For entity-based auth (org comes from the entity, not args):
const entity = await ctx.db.get(args.entityId);
const userMember = await requireAuth(ctx, entity.organizationId);
```

Note: `getAuthUserId` is still used directly in functions without org context (e.g. `getUserOrganizations`).

### Permissions Pattern

For functions requiring specific permission levels, use `requirePermission`:

```typescript
import { requirePermission } from "./lib/auth";

// Requires at least "edit_own" level for the "leads" category:
const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");

// For admin-only operations:
const userMember = await requirePermission(ctx, args.organizationId, "team", "manage");
```

Permission categories: `leads`, `contacts`, `inbox`, `tasks`, `reports`, `team`, `settings`, `auditLogs`, `apiKeys`. Each has hierarchical levels — `resolvePermissions(role, explicitPermissions?)` falls back to role defaults when no explicit override exists. See `convex/lib/permissions.ts` for full type definitions and `DEFAULT_PERMISSIONS`.

## Mutation Side Effects Checklist

When writing mutations that create/update/delete entities, include all three:

1. **Activity log** — `ctx.db.insert("activities", { organizationId, leadId, type, actorId, actorType, content, metadata, createdAt })`
2. **Audit log** — `ctx.db.insert("auditLogs", { organizationId, entityType, entityId, action, actorId, actorType, changes: { before, after }, description: buildAuditDescription({...}), severity, createdAt })`
3. **Webhook trigger** — `ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, { organizationId, event: "entity.action", payload })`
4. **Email notification** — `ctx.scheduler.runAfter(0, internal.email.dispatchNotification, { organizationId, recipientMemberId, eventType, templateData })`

## Key Indexes

All tables use `by_organization` as the primary access pattern. Important compound indexes:
- `leads`: `by_organization_and_stage`, `by_organization_and_assigned`, `by_organization_and_board`
- `conversations`: `by_lead_and_channel`, `by_organization_and_status`
- `messages`: `by_conversation_and_created`
- `stages`: `by_board_and_order`
- `auditLogs`: `by_organization_and_created`, `by_entity`, `by_organization_and_entity_type_and_created`, `by_organization_and_action_and_created`, `by_organization_and_severity_and_created`, `by_organization_and_actor_and_created`
- `activities`: `by_lead_and_created`
- `apiKeys`: `by_key_hash_and_active`

## HTTP API Pattern (router.ts)

All endpoints use `httpAction` and follow this structure:
```typescript
http.route({
  path: "/api/v1/endpoint",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const { organizationId, teamMemberId } = await authenticateApiKey(ctx, request);
      // call ctx.runMutation / ctx.runQuery
      return jsonResponse(result);
    } catch (e: any) {
      return errorResponse(e.message, 400);
    }
  }),
});
```

## Rules

- Every exported function needs `args` + `returns` validators
- Use `v.null()` for functions that return nothing
- Never use `Date.now()` in queries (breaks Convex reactivity) — pass timestamps as arguments or use them only in mutations
- Only schedule `internal.*` functions, never `api.*`
- Put `"use node";` at the top of any file using Node.js APIs (only valid in actions)
- Use `ctx.db.patch` for partial updates
