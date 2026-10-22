# CLAUDE.md — Convex Backend

Deployments, commands and ops rules: root `CLAUDE.md` + `docs/architecture/ops-dev-prod.md`. Per-area decisions and history: `docs/architecture/README.md`.

## File Layout

| File | Purpose |
|------|---------|
| `schema.ts` | All table definitions, indexes, validators |
| `auth.ts` / `auth.config.ts` | Auth providers (Password only; `Anonymous` removed in v0.68.1); `convex.config.ts` registers components (Resend) |
| `crons.ts` | Scheduled jobs (reminders, recurring tasks, digests, group posts, export cleanup, channel health, AI follow-ups watchdog) |
| `http.ts` / `router.ts` | Route wiring / REST `/api/v1/*`, API-key auth, RBAC on every route via `ROUTE_PERMISSIONS` + `requireRoutePermission` (fail-closed) |
| `leads.ts` / `contacts.ts` | Lead CRUD, stage moves (via `lib/leadStageMove.ts`), assignment, qualification / Contact CRUD |
| `conversations.ts` | Multi-channel conversations + messages, search, archiving, labels, presence, ingest (`internalReceive*`) |
| `transcription.ts` / `vision.ts` | Whisper voice-note transcription / image description pass (once per image: `messages.imageDescription` + `metadata.vision`) |
| `lib/mediaEnrichment.ts` | Pure gates: `shouldTranscribeAudio`, `visionEnabledForOrg`, `shouldDescribeImage`, `attendantActive`, `isSticker` |
| `quickReplies.ts` / `scheduledMessages.ts` | "/" shortcuts in the composer / scheduled sends via `ctx.scheduler.runAt` |
| `channelConfigs.ts` | Per-org WhatsApp channels (meta\|bridge), encrypted creds, health checks, provisioning, number exclusivity (`claimBridgePhone`) |
| `whatsapp.ts` | Meta ingress (`/webhooks/whatsapp`) + outbound dispatch by provider; pacing-aware retry; channel freeze on 131048 |
| `bridge.ts` | Bridge ingress (`POST /webhooks/bridge`, HMAC via `WA_BRIDGE_HMAC_SECRET`); `fromMe` → `internalReceiveDeviceMessage`; device history actions |
| `lib/bridgeParse.ts` / `bridgeSend.ts` / `bridgeMedia.ts` | Pure wuzapi adapters: parser+HMAC, send, media (`sanitizeBridgeMediaMeta`, `stripMediaKeyMaterial`) |
| `lib/bridgeSession.ts` / `bridgeHistory.ts` | QR/status/provisioning/logout, `BRIDGE_WEBHOOK_EVENTS` (single event list) / pure `data_json` history adapter |
| `handoffs.ts` | AI→human handoffs; single creation path `createHandoffCore`; accept = take over, reject = back to AI, `canceled` via `returnToAi` |
| `attendant.ts` | AI attendant: `aiReplyQueue`, eligibility, OCC lock, transactional commits, runtime, simulator, drafts, coaching, `getConversationAiState` |
| `attendantFollowUp.ts` | Follow-up the AI executes itself: `fire` guard chain, `internalWatchdog`, `adoptTask`/`internalAdoptTask`, `runNow`, `cancelAuto` |
| `lib/followUpOps.ts` | Follow-up core: `resolveFollowUpOutcome` (single outcome), `syncFollowUpForTask`, `armFollowUp`/`cancelArmedFollowUp`, delivery hook |
| `lib/followUpSettings.ts` / `agentSchedule.ts` / `followUpNote.ts` | Pure: `resolveFollowUpSettings` / `isWithinSchedule`, `followUpWindow` / `sanitizeFollowUpNote` |
| `lib/channelResolve.ts` / `inboundRouting.ts` / `whatsappDispatch.ts` | Channel resolution (strict per channel; `transportOf`) / inbound routing / 2-level pacing (`channelPacing`) |
| `lib/channelTransport.ts` | Pure `configTransport` (`ChannelTransport`: meta\|bridge\|instagram\|messenger; channel before provider, unknown channel throws); `configProvider` is WhatsApp-only and fail-closed |
| `lib/outboundDispatch.ts` | Single outbound port `scheduleOutboundDispatch` (picks the dispatcher by `conversation.channel`); build guard `outboundDispatchPort.test.ts` |
| `metaMessaging.ts` | Instagram + Messenger (official Graph API, module `metaMessaging`): `GET/POST /webhooks/meta-messaging` (signature `META_MESSAGING_APP_SECRET` before parse; route by `by_messenger_page_id`/`by_instagram_account_id`), `internalIngestEvent` (text/placeholder only), Facebook Login OAuth (`startMetaConnect`, `GET /oauth/meta/callback`, `finalizeMetaSelection`), `disconnectMetaConnection`; F1: `internalDispatchMessage` (scheduled only via the port), `internalMarkMetaDispatched`/`internalMarkDispatchFailed`, echo D6 (our `app_id` = no-op, other app = `internalReceiveDeviceMessage` with `channel`; IG without `app_id` = `metaSentMids` + in-flight check + `internalReconcileEcho`), delivery/read by watermark |
| `lib/metaSend.ts` | Pure send helpers: `TEXT_LIMIT`, `splitMetaText` (IG 1000 bytes, Messenger 1900 chars; paragraph > sentence > word, never splits a grapheme), `buildTextPayload` (`metadata "hnb:<id>"`, `RESPONSE` only on Messenger), `classifyMetaError`, `serviceWindowState`/`metaConversationWindow` (24 h, 7 d by ad) |
| `lib/metaDispatch.ts` | `scheduleMetaMessagingDispatch` (called only by the port): strict config, server-side window (closed = `failed`, no network), `claimChannelSlot`; `findMetaConversationForUser` |
| `lib/metaMessagingParse.ts` / `metaOAuth.ts` / `metaGraph.ts` / `metaIdentity.ts` | Pure: webhook parser (never throws, sorted by timestamp) + `verifyMetaSignature` / authorize URL, `REQUIRED_SCOPES`, `pickUsablePages`, `redirectUrlFor` / `graphBase`, `sendEndpoint`, `profileEndpoint` (v26.0) / `findOrCreateContactByMetaIdentity` (PSID/IGSID in `contactChannelIdentities`, never `phone`) |
| `copilot.ts` / `copilotHttp.ts` | Copilot threads + tool executors (destructive → `pendingActions`) / SSE `POST /api/copilot/stream` with tool_calls loop |
| `aiSettings.ts` | Org AI config: activation + LGPD ack, profile/mode, models/ZDR, `setProductRouting`, `internalSetFollowUpMode`, metrics |
| `aiDiagnostics.ts` / `agentRuns.ts` / `orgSecrets.ts` | `pingProvider` smoke test / AI run log (no PII) / BYO keys (encrypted, always masked) |
| `agentEvals.ts` | Golden conversations + replay; `CURATED_GOLDENS` installed by `internalSeedCuratedGoldens` |
| `testReset.ts` | WhatsApp test commands `/resetme`, `/resetlist`, `/resetother <nº>`; only with env `WA_TEST_RESET_PHONES` (absent = off) |
| `lib/agentSecurity.ts` / `agentTools.ts` | 4 security layers (`assertAgentCan`, `TOOL_DENYLIST`, `SECRET_FIELD_PATTERN`, `orgAiActive`) / STATIC AI tool registry |
| `lib/agentRoutes.ts` / `agentPersonas.ts` | LLM route resolution (platform chain or BYO + `strictZdr`; `effectivePlatformOrder`) / industry personas |
| `lib/promptEnvelope.ts` / `outboundSideEffects.ts` / `llm/` | `<crm_data untrusted>` envelope / outbound side effects shared by conversations+attendant / pure LLM layer |
| `boards.ts` / `organizations.ts` / `teamMembers.ts` / `calendar.ts` | Kanban boards+stages / org CRUD + settings / human+AI members / calendar events |
| `tasks.ts` | Task CRUD (projects, labels, `assigneeIds`, subtasks, `blockedBy`); writers call `syncFollowUpForTask`; `internal*` variants serve REST/MCP |
| `taskComments.ts` / `taskProjects.ts` / `taskLabels.ts` / `lib/taskOps.ts` | Comments / projects + columns / labels / shared cores `applyTaskCompletion`, `addTaskCommentCore` |
| `notifications.ts` / `lib/notify.ts` | In-app notifications (bell) / `createNotification()`, `PREFERENCE_FLAG`, `inboxRepliers`; skips AI members and self |
| `activities.ts` / `auditLogs.ts` / `dashboard.ts` / `webhooks.ts` / `webhookTrigger.ts` | Timeline / audit / dashboard / webhook CRUD + firing action |
| `email.ts` | Resend; single exit `sendTransactionalEmail` (never throws), `dispatchNotification` (gates), `handleEmailEvent` (suppression), digest |
| `authEmails.ts` / `authEmailTemplates.ts` / `passwordReset.ts` | Reset-code + welcome emails (outside `notificationPreferences`) / templates / OTP provider |
| `emailTemplates.ts` / `lib/emailAddress.ts` / `lib/appUrl.ts` | PT-BR templates (`buildTemplate` fail-closed) / `isDeliverableEmail` / `appUrl()` single link source |
| `exports.ts` / `imports.ts` / `importRun.ts` | Export jobs (CSV, `hnbcrm-backup` v1) / import wizard (`importJobBatches` rollback) / import actions |
| `lib/csv.ts` / `importMapping.ts` / `importKeys.ts` / `exportColumns.ts` / `exportSanitize.ts` | RFC 4180 CSV / `suggestMapping`, `coerceAndValidateRow` / `encodeHeaderKey` / columns / denylist |
| `lib/auth.ts` / `permissions.ts` / `batchGet.ts` / `fileRefs.ts` | `requireAuth()`, `requirePermission()` / defaults / batch get / `isStorageShared`, `deleteBlobIfUnreferenced` |
| `authHelpers.ts` / `nodeActions.ts` / `forms.ts` / `formSubmissions.ts` | Auth-table ops / Node actions (API key hash, webhooks, invite) / form builder / submissions |
| `notificationPreferences.ts` / `apiKeys.ts` / `leadSources.ts` / `fieldDefinitions.ts` / `llmsTxt.ts` | Prefs / API keys / sources + custom fields / `/llms.txt` |
| `onboarding.ts` / `onboardingSeed.ts` / `seed.ts` | Onboarding wizard + checklist / dev seed (`seed:seedMockData` is internal) |
| `opsMigration.ts` | Dev/prod split and post-restore ops (bridge webhooks, HMAC, disarm channels, re-arm scheduled), all `dryRun` default true |

## Auth Pattern (copy this for every public function)

```typescript
import { requireAuth } from "./lib/auth";

// In any public query/mutation with organizationId arg:
const userMember = await requireAuth(ctx, args.organizationId);

// For entity-based auth (org comes from the entity, not args):
const entity = await ctx.db.get(args.entityId);
const userMember = await requireAuth(ctx, entity.organizationId);
```

`getAuthUserId` is used directly only in functions without org context (e.g. `getUserOrganizations`).

### Permissions Pattern

`const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");` (from `./lib/auth`; admin-only e.g. `"team", "manage"`).

Categories: `leads`, `contacts`, `inbox`, `tasks`, `reports`, `team`, `settings`, `auditLogs`, `apiKeys`, `campaigns`. Levels are hierarchical;
`resolvePermissions(role, explicitPermissions?)` falls back to role defaults. Types and `DEFAULT_PERMISSIONS`: `lib/permissions.ts`.

## Mutation Side Effects Checklist

Every mutation that creates/updates/deletes an entity:

1. **Activity log** — `ctx.db.insert("activities", { organizationId, leadId, type, actorId, actorType, content, metadata, createdAt })`
2. **Audit log** — `ctx.db.insert("auditLogs", { organizationId, entityType, entityId, action, actorId, actorType, changes: { before, after }, description: buildAuditDescription({...}), severity, createdAt })`
3. **Webhook** — `await scheduleWebhookEvent(ctx, { organizationId, event: "entity.action", payload })` (`lib/webhookDispatch.ts`; never schedule the action directly)
4. **Email** — `ctx.scheduler.runAfter(0, internal.email.dispatchNotification, { organizationId, recipientMemberId, eventType, templateData })`

## Key Indexes

All tables use `by_organization` first. Compound indexes:
- `leads`: `by_organization_and_stage`, `by_organization_and_assigned`, `by_organization_and_board`
- `conversations`: `by_lead_and_channel`, `by_organization_and_status`; `messages`: `by_conversation_and_created`; `stages`: `by_board_and_order`
- `auditLogs`: `by_organization_and_created`, `by_entity`, and `by_organization_and_{entity_type,action,severity,actor}_and_created`
- `activities`: `by_lead_and_created`; `apiKeys`: `by_key_hash_and_active`

## HTTP API Pattern (router.ts)

```typescript
http.route({ path: "/api/v1/endpoint", method: "POST", handler: httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return handleOptions();
  try {
    const auth = await authenticateApiKey(ctx, request);
    const denied = requireRoutePermission(auth, "POST", "/api/v1/endpoint"); // NEW routes need a ROUTE_PERMISSIONS entry (fail-closed)
    if (denied) return denied;
    return jsonResponse(await ctx.runMutation(/* or runQuery */));
  } catch (e: any) { return errorResponse(e.message, 400); }
}) });
```

## Rules

General Convex rules (validators, no `.filter()`, no `Date.now()` in queries, only `internal.*` scheduled, `"use node"`): root `CLAUDE.md` and
`.claude/rules/convex-official.md`. Specific to `convex/`: shared cores go in `lib/` (a cycle between modules breaks the build); user-facing errors are
`ConvexError` with PT-BR text; build tests guard the invariants (`routerPermissions.test.ts`, `agentToolSecurity.test.ts`, `webhookDispatchPort.test.ts`).
