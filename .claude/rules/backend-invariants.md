---
paths:
  - "convex/**"
---

# HNBCRM backend invariants (convex/)

Project-specific rules that change how code must be written. Official Convex rules: `convex-official.md`. Why each rule exists (measured incidents, decisions): `docs/architecture/<area>.md` — read the area file before a non-trivial change.

## Auth and tenancy
- Every public function starts with `requireAuth(ctx, organizationId)` or `requirePermission(ctx, organizationId, category, level)` (`convex/lib/auth.ts`); both resolve the membership through `getActiveMembership`, so removed members (`removedAt` / legacy `status:"inactive"`) never authenticate. API keys follow the same path (`apiKeys.getByKeyHash`).
- Detail queries return `null` for non-members instead of throwing (the frontend relies on it for cross-org deep links).
- Any assignment (lead, task, handoff, event) goes through `assertAssignableMember`; a removed member never receives a NEW assignment.
- Critical doors call `requireAccountWithEmail(ctx, userId?)`: `createOrganization`, `channelConfigs.internalRequireSettingsManage`, `apiKeys.verifyAdmin`, `teamMembers.internalPrepareInvite`, AI toggles/acks, the public wrapper `campaigns.launchCampaign` (never the shared `launchCampaignHandler`, which REST calls with `actorMemberId`).
- `createTeamMember` creates AI members only; humans only via `inviteHumanMember`. Never re-add e-mail auto-linking in `afterUserCreatedOrUpdated`.
- Multi-tenant defense in every notification/e-mail: `dispatchNotification` refuses members of another org and members without `userId`.

## Side effects, events, audit
- Mutations that change business state write `activities` + `auditLogs` (severity `high` for security-relevant acts: acks, purges, exports, autopilot) and emit webhooks ONLY via `scheduleWebhookEvent(ctx, {organizationId, event, payload})`. The gate only schedules when the org has an active webhook for the event or `"*"`; tests asserting a schedule must seed one.
- Ops functions never write activity/audit per row — one audit per job transition (import/export pattern).
- Audit snapshots flatten `_id` to `id` (Convex rejects underscore field names). Long texts in audit go through `convex/lib/auditText.ts` (50k cap + sha marker).

## Single ports — extend them, never bypass
| Concern | Port | Build guard |
|---|---|---|
| Lead stage change (any actor) | `moveLeadToStageCore` (`convex/lib/leadStageMove.ts`), emits `lead.won`/`lead.lost` once | `leadStageMovePort.test.ts` fails on `patch(…{stageId})` outside the core |
| New lead insert | `leadCreationStagePatch` on every `insert("leads")` | — |
| Handoff creation (human, keyword, tool, failure, bot, budget) | `createHandoffCore` (`convex/handoffs.ts`); `handoffs.origin` values `bot_suspect`/`ai_budget` are refused by the public validator | — |
| Outbound e-mail | `sendTransactionalEmail` (`convex/email.ts`): validates address, checks `emailSuppressions`, never throws, returns boolean | `emailConfig.test.ts` |
| Phone normalization | `normalizeCampaignPhone(raw, defaultCountry)` + `phoneLookupCandidates` (`convex/lib/phone.ts`); org default via `resolveDefaultCountry` (`convex/lib/orgPhone.ts`) | `lib/phone.test.ts` |
| Blob deletion | `convex/lib/fileRefs.ts` (delete storage only when no other `files` row shares the `storageId`) | — |
| Group sends | `assertGroupConversationSendable` + `resolveGroupMentions` (`convex/lib/groupGuard.ts`) | — |
| Lead hard delete | `hardDeleteLead` (`convex/lib/leadCascade.ts`): snapshot in audit, batched cascade job | `leadDelete.test.ts` |
| Follow-up terminal states | `resolveFollowUpOutcome` (`convex/lib/followUpOps.ts`) | `attendantFollowUp.test.ts` |
| Bridge number check | `convex/lib/bridgeNumberCheck.ts` (used by Nova conversa AND campaigns) | — |
| Webhook scheduling | `scheduleWebhookEvent` (`convex/lib/webhookDispatch.ts`) | `webhookDispatchPort.test.ts` |
| Outbound message dispatch (any channel) | `scheduleOutboundDispatch` (`convex/lib/outboundDispatch.ts`) branches by `conversation.channel`; callers keep their own business guards (`!isInternal`) | `outboundDispatchPort.test.ts` fails on `scheduleWhatsappDispatch(` or `internal.whatsapp.internalDispatchMessage` outside the port |
| Channel transport | `configTransport(config)` (`convex/lib/channelTransport.ts`) decides by `channel` BEFORE `provider`; `configProvider()` is WhatsApp-only and throws for other channels | `channelTransport.test.ts` |
| Contact lookup by phone | `findContactsByPhoneCandidates` (`convex/lib/inboundRouting.ts`); only callers holding the REAL channel JID pass `phoneIsChannelJid` | `phoneDedupe.test.ts` |

## Ops functions (`convex/ops*.ts`, `internal*` everywhere)
- `internalMutation`/`internalAction`/`internalQuery`, args include `dryRun` (default **true**) and `cursor`/`pageSize`; dry run returns the plan, real run re-schedules itself by cursor (~150–200 writes per execution). Prod ops are run with `npx convex run --prod` after a dry run.
- Never log full phone numbers, e-mails or secrets from ops; mask digit runs (`maskDigitRuns`).
- Backfills are idempotent and additive; schema changes stay additive (DEV and PROD must accept the same documents). Legacy fields stay in the schema as `v.optional` until a migration removes the data.

## Module structure
- Pure logic lives in `convex/lib/*.ts` (no `ctx`), tested directly; `convex/<module>.ts` holds thin registered functions. `Date.now()` only in actions/mutations.
- Avoid import cycles between `attendant.ts`, `handoffs.ts`, `groupPosts.ts`/`groupPostWorker.ts`: shared code goes to `convex/lib/*Ops.ts`; cross-module triggers go through `ctx.scheduler.runAfter(0, internal.…)`.
- `conversation.leadId` is OPTIONAL (groups); read leads via `getLeadRef` (`convex/lib/leadRef.ts`), never raw `ctx.db.get(conversation.leadId)`.
- Untrusted text (customer messages, image descriptions, follow-up notes, form input) enters prompts only inside the envelope from `convex/lib/promptEnvelope.ts` and is sanitized before persistence (`convex/lib/followUpNote.ts`, `escape` in e-mail templates).
- Hot documents: do not grow arrays on `conversations`/`groupChats` docs; use side tables (`groupParticipants`, `groupTimeline`) and the helpers in `convex/lib/groupParticipantsStore.ts`. Denormalized list previews (`lastMessage*` on `conversations`) must be kept in sync by the writer.
- `v.union` string literals used in several tables (`actorType`, `origin`, notification types, `AI_STATE_REASON_CODES`) have paired lists in `convex/lib/*` and the frontend; a parity test fails when one side is missing — add to both.

## REST / MCP (`convex/router.ts`, `mcp-server/`)
- New route = entry in `ROUTE_PERMISSIONS` ("METHOD /path" → category+level mirroring the app function) + `requireRoutePermission` right after `authenticateApiKey`; flat paths only (`/campaigns/get?campaignId=`; no `:id`). `routerPermissions.test.ts` enforces completeness.
- REST handlers call `internal*` wrappers that take `actorMemberId` (no `ctx.auth`); user errors are `ConvexError` → 400, opt-out → 409 `{optOut:true}`.
- Rate limit per key 300 req/min (`apiKeys.updateLastUsed`). OpenAPI served at `/api/v1/openapi.json` must stay valid JSON (`openapiSpec.test.ts`).

## E-mail and notifications
- In-app notification type + preference flag are paired; e-mail only for types with a template (`buildTemplate` is fail-closed). Broadcast handoff e-mails are throttled per org (15 min).
- `emailSuppressions` is deployment-wide on purpose. `RESEND_TEST_MODE="true"` is the only value that enables sandbox; default is real sending.

## Scheduling and crons
- Scheduled jobs carry an anti-zombie token (`tickToken`, `schedulerFnId`) and are canceled through one function before the pointer is cleared (`cancelArmedFollowUp` pattern). Watchdog crons rescue lost jobs; never rely on a single `runAt`.
- After a Convex backup restore, re-arm: `internalRearmScheduledMessages`, `internalRearmGroupPosts`, `internalRedispatchStuckOutbound`.

## Convex pitfalls (adopted from the official `convex-expert` agent, 22/10/2026)
- Numeric args that become deltas need bounds and must reject `NaN`/`Infinity`/negatives; fixed sets are `v.union(v.literal(…))`. Every client-supplied index range or `limit`/`from`/`to` has a floor AND a ceiling; REST params via `Number(...)` get `Math.min` + integer check (`convex/router.ts`).
- Mutations reachable over HTTP with real effects are idempotent by `requestId`/`idempotencyKey` (campaign send, start conversation, MCP writes) — never "toggle by presence".
- `v.id(...)` built from a REST path/query: catch `ArgumentValidationError` and answer 400/404, not 500.
- Never `ctx.runQuery`/`ctx.runMutation` inside a `query`; extract a helper. `.take(n)` followed by a JS filter silently drops valid rows — filter through the index.
- Exports named with JS reserved words (`delete`, `new`) and Node builtins outside `"use node"` break the bundle (use Web Crypto, as `convex/lib/auditText.ts` does).
- Required-field deadlock: a new REQUIRED field on a populated table fails the push and blocks ALL deploys, including the backfill mutation — widen (optional) → migrate → narrow.
- "By id" mutations verify ownership of the DOCUMENT and, when writing a FK (`boardId`, `projectId`, `stageId`), of the PARENT: both `organizationId`s must equal the membership's.
- When rewriting a file, preserve every export (diff the export list before/after).
- Convex Auth envs (`JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`) are per deployment; multiline PEM via `"$(cat key.pem)"` — pasted by hand it loses newlines silently.
- Limits per transaction: 16k document reads, 8k writes, 1 MiB per document, 8 MiB payload, ~1 s query CPU, 10 min action. "Too many reads/writes" means a missing index or a `collect()` on a growing table.
