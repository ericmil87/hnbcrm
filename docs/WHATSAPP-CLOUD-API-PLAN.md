# WhatsApp Cloud API Connector — Implementation Plan (multi-tenant)

> **Goal:** make WhatsApp a *real* channel in HNBCRM via the **official Meta Cloud API**,
> designed for **every tenant**: each organization connects its own WhatsApp Business
> number by pasting its Meta credentials in a Settings UI. Inbound messages land in the
> Inbox (contact bubbles, media, delivery statuses), outbound messages sent from the CRM
> (by humans or AI team members) are dispatched to WhatsApp, and external AI workers
> drive conversations through the existing REST API + webhooks.
>
> Today `channel: "whatsapp"` exists in the schema but nothing talks to Meta, and there
> is **no code path that creates an inbound message from a contact** (see
> `docs/PROJECT-STATUS.md` — "real channel dispatch not implemented").
>
> **Status: 🟠 in progress — Waves 1–3 done** · Base branch: `feat/form-builder` · Work branch: `feat/whatsapp-cloud-api`
> **Estimated effort:** ~10–13 dev-days across 6 waves.

---

## How to execute this plan (instructions for the AI agent)

1. **Read `convex/CLAUDE.md` first** — Convex rules (index naming, validators, the
   public/internal mutation pattern, side-effect checklist) override anything else.
2. Work **wave by wave, in order**. Within a wave, tasks can be parallelized with
   subagents where independent (each task names its files). Do not start a wave before
   the previous wave's **gate** passes.
3. **Gate for every wave:** `npm run lint` (tsc + `convex dev --once` + vite build)
   green, plus the wave's own checks. New tests (Wave 1 introduces the harness) must pass.
4. **Update this file as you go**: tick checkboxes `[x]`, and append a dated line to the
   **Progress log** at the bottom (task → commit hash). Include this file in the wave's
   commit — it is the single source of truth for progress.
5. **Commits (public repo — keep it clean):**
   - Conventional style matching repo history: `feat: … vX.Y.Z` (bump `package.json`
     minor per shipped wave), `docs: …`, `test: …`, `fix: …`. English, product-focused.
   - **Never mention client names, deployments, or internal projects.** This is a
     generic product feature.
   - **No secrets, ever.** No real tokens/phone numbers anywhere (fixtures use
     `15550000000`-style numbers and fake tokens).
   - One commit per wave (or two if a wave is large); keep each diff reviewable
     (≤ ~800 lines). **Commit locally; do NOT push** — Eric reviews and pushes/opens the PR.
6. Follow the existing **side-effect checklist** on every new mutation that changes
   state: activity log + audit log + webhook trigger (see how `leads.ts`/`handoffs.ts`
   do it). Reuse `internal*` variants for non-auth contexts, as the codebase does.
7. If blocked on something only a human can do (Meta app credentials, env vars,
   product decisions), record it under **Blocked** in the progress log and move to the
   next unblocked task.

---

## Design decisions (read before coding)

### Multi-tenant model

- The Meta relationship belongs to **each tenant**, not to HNBCRM: every organization
  creates its own Meta Business Manager, passes Business Verification with its own
  company registration, creates its own Meta app + WABA, registers its own number, and
  generates its own System User access token + app secret. HNBCRM stores those
  credentials per organization and uses them. (Becoming a Meta **Tech Provider** with
  Embedded Signup — "connect in 2 clicks" — is a future SaaS path, explicitly out of
  scope; it requires Meta App Review and a hosted offering.)
- New table **`channelConfigs`** (org-scoped): one row per connected WhatsApp number.
  An org may have multiple numbers (multiple rows); routing is always by
  `phoneNumberId`, so N tenants × N numbers works on a **single webhook endpoint**.
- Conversations record which number they belong to (`channelConfigId` on the
  conversation) so egress always uses the right credentials.

### Secrets at rest

- `accessToken` and `appSecret` are **encrypted at rest** with AES-256-GCM via Web
  Crypto, using a deployment-level master key from env (`CHANNEL_ENCRYPTION_KEY`,
  32-byte base64). Helpers in `convex/lib/secretCrypto.ts` (encrypt/decrypt, random IV
  per value, `v1:` prefix for future rotation).
- Secrets are **write-only from the client's perspective**: queries return only masked
  values (`…last4`) + a `hasToken` boolean. Decryption happens only inside actions that
  call the Graph API / verify signatures. Never logged, never in audit payloads,
  never in webhook payloads.
- Config mutations are **admin-only** (org role check) and audit-logged (field names
  changed, not values).

### Webhook routing (single endpoint, many tenants)

- One endpoint: `POST /webhooks/whatsapp`. Meta includes
  `entry[].changes[].value.metadata.phone_number_id` in every delivery, and each
  tenant's Meta app signs with **its own** app secret. Chicken-and-egg is resolved as:
  1. read the **raw body** (needed for HMAC anyway);
  2. `JSON.parse` it *without trusting it* just to extract `phone_number_id`;
  3. look up the matching `channelConfigs` row (indexed by `phoneNumberId`);
  4. verify `X-Hub-Signature-256` against the raw body with that config's decrypted
     `appSecret` (timing-safe compare). Mismatch → 401. No matching config → 200 + drop
     (log a warning; don't make Meta retry forever, don't leak tenant existence).
- `GET /webhooks/whatsapp` handshake: Meta sends the `hub.verify_token` the tenant
  typed into *their* Meta app config. Look it up across active `channelConfigs`
  (indexed field) and echo `hub.challenge` on match.

### Key Meta facts baked into this plan

Media URLs expire ~5 minutes after retrieval (download immediately). Webhooks are
retried for up to 7 days and can arrive **duplicated and out of order** (hence wamid
idempotency). Pair rate limit ≈ 1 msg/6s per recipient (error `131056`). Free-form
messages outside the 24h customer-service window fail with `131026` (template
required). Answer webhooks fast (<5s) — heavy work goes through mutations/scheduler.

---

## Environment variables (Convex dashboard — never committed)

| Var | Purpose |
|---|---|
| `CHANNEL_ENCRYPTION_KEY` | 32-byte base64 master key for encrypting channel secrets at rest |

*(All per-tenant WhatsApp credentials live in the `channelConfigs` table, entered via
the Settings UI — no per-tenant env vars.)*

---

## Wave 1 — Core messaging gaps (channel-agnostic) ~2 days

*The structural gap: inbound messages don't exist. Everything else builds on this.*

- [x] **1.1 Schema**: add `externalId: v.optional(v.string())` to `messages` + index
  for dedupe lookup (wamid is globally unique; scope the index per the codebase's
  org-scoping convention in `convex/schema.ts`). Also verify `deliveryStatus` values
  cover `sent|delivered|read|failed`.
- [x] **1.2 Inbound mutation**: `internalReceiveMessage` in `convex/conversations.ts` —
  creates `direction: "inbound"`, `senderType: "contact"` messages (with `externalId`,
  `contentType`, `attachments`, `metadata`), get-or-creates the conversation
  (reuse `internalCreateConversation`), updates `lastMessageAt`/`messageCount`,
  logs activity. **Idempotent**: if `externalId` already exists, return existing id, no-op.
- [x] **1.3 REST endpoint**: `POST /api/v1/conversations/receive` in `convex/router.ts`
  (X-API-Key auth, same pattern as `/conversations/send`) so external bridges can
  inject inbound messages for any channel. Body: `contactPhone` (or `contactId`),
  `channel`, `content`, `contentType?`, `externalId?`, `metadata?`.
- [x] **1.4 Webhook event `message.received`**: fire on inbound creation (register the
  event type wherever `message.sent` is defined; payload parity with 1.5).
- [x] **1.5 Enrich `message.sent` payload**: add `senderType` + `senderId` (today
  consumers can't tell human vs AI vs which member without an extra GET). Update both
  `sendMessage` and `internalSendMessage` triggers.
- [x] **1.6 Delivery-status mutation**: `internalUpdateDeliveryStatus(externalId, status,
  errorDetail?)` — finds message by `externalId`, updates `deliveryStatus` (+ error into
  `metadata`). (Today `deliveryStatus` is written by nothing.)
- [x] **1.7 Test harness (first tests in the repo)**: add `vitest` + `convex-test`;
  cover: inbound creation, idempotent replay, `message.received`/`message.sent` payloads
  include sender info, delivery-status update. Add `npm test` script.

**Gate:** `npm run lint` + `npm test` green.
**Commit:** `feat: inbound messages, delivery status updates & richer message webhooks vX.Y.Z`

## Wave 2 — Channel configuration foundation (multi-tenant) ~2 days

- [x] **2.1 Schema `channelConfigs`**: `organizationId`, `channel` (literal `"whatsapp"`
  for now, union-ready), `displayName`, `phoneNumberId`, `wabaId`,
  `displayPhoneNumber?`, `verifyToken`, `appSecretEncrypted`, `accessTokenEncrypted`,
  `status` (`active|disabled|error`), `lastHealthCheckAt?`, `healthDetail?`, timestamps.
  Indexes: by organization, by `phoneNumberId`, by `verifyToken` (active lookup).
- [x] **2.2 Secret crypto**: `convex/lib/secretCrypto.ts` — AES-256-GCM encrypt/decrypt
  with `CHANNEL_ENCRYPTION_KEY` (Web Crypto, random IV, versioned `v1:` prefix).
  Fail with a clear error if the env var is missing/malformed. Unit tests.
- [x] **2.3 Config mutations/queries** (`convex/channelConfigs.ts`): create/update/
  disable/delete (admin-only via existing role checks; audit-logged **without secret
  values**). Queries return masked secrets (`…last4`, `hasToken`) — encrypted fields
  are never sent to clients. Internal getters return decrypted values for
  actions only.
- [x] **2.4 Health check action**: `checkChannelHealth(configId)` — Graph API
  `GET /{phone_number_id}?fields=display_phone_number,verified_name` with the decrypted
  token; stores result (`status`, `displayPhoneNumber`, `healthDetail`,
  `lastHealthCheckAt`). This powers a "Test connection" button.
- [x] **2.5 Conversation linkage**: add `channelConfigId: v.optional(v.id("channelConfigs"))`
  to `conversations`; helper to resolve an org's default active config (single-config
  orgs) when a conversation was created in-app rather than by ingress.
- [x] **2.6 Tests**: crypto round-trip, masked reads, admin-only enforcement, health
  check happy/error paths (Graph API fetch mocked).

**Gate:** lint + tests green.
**Commit:** `feat: per-organization channel configs with encrypted credentials vX.Y.Z`

## Wave 3 — Meta webhook ingress (multi-tenant routing) ~2–3 days

- [x] **3.1 Module** `convex/whatsapp.ts` (+ `convex/lib/whatsappParse.ts` for pure
  payload parsing — keeps it unit-testable). Routes registered in `convex/router.ts`
  (`http.route({ path: "/webhooks/whatsapp", ... })`).
- [x] **3.2 GET handshake**: `hub.mode=subscribe` + `hub.verify_token` looked up across
  active `channelConfigs` → echo `hub.challenge` (plain text 200); 403 otherwise.
- [x] **3.3 POST routing + signature**: raw body → parse untrusted JSON → extract
  `value.metadata.phone_number_id` → lookup config → verify `X-Hub-Signature-256`
  (HMAC-SHA256 with decrypted `appSecret`, timing-safe). 401 on mismatch; 200 + drop +
  warn on unknown `phone_number_id`. Answer fast; heavy work via
  `ctx.runMutation`/scheduler.
- [x] **3.4 Message parsing** (`value.messages[]`): text; `image|audio|video|document|sticker`
  (→ 3.5); `interactive` (button_reply/list_reply → text + metadata); `location`,
  `contacts`, `reaction` → readable text + raw payload in `metadata`; unknown types →
  fallback text `[unsupported message type: X]` + metadata. Map `value.contacts[0]`
  (profile name, wa_id) into contact get-or-create.
- [x] **3.5 Media pipeline**: Graph API `GET /{media_id}` (per-config token) →
  short-lived URL (expires ~5 min) → download **immediately** → `ctx.storage.store` →
  `files` record (`fileType: "message_attachment"`) attached to the message. Size guard
  (skip oversized, keep a metadata note).
- [x] **3.6 Contact/lead/conversation routing**: config → `organizationId`; by `wa_id`
  phone → `internalFindOrCreateContact` → ensure lead on default board/stage with
  auto-assign to an active `type:"ai"` member if configured (reuse the
  `/api/v1/inbound/lead` flow logic; extract a shared helper instead of copy-pasting) →
  `internalReceiveMessage`, stamping `channelConfigId` on the conversation.
- [x] **3.7 Statuses**: `value.statuses[]` → `internalUpdateDeliveryStatus` per wamid
  (`sent|delivered|read|failed`, capture `errors[]` detail — e.g. `131047`
  re-engagement — into metadata).
- [x] **3.8 Tests**: fixture JSONs for each payload type (fake numbers/tokens),
  signature pass/fail per-tenant, routing to the right org among multiple configs,
  duplicate delivery replay (idempotency), statuses update path.

**Gate:** lint + tests green; manual smoke with `curl` fixtures against `convex dev`.
**Commit:** `feat: WhatsApp Cloud API webhook ingress with multi-tenant routing vX.Y.Z`

## Wave 4 — Outbound dispatch via Graph API ~2 days

- [ ] **4.1 Dispatch action**: `POST https://graph.facebook.com/v23.0/{phone_number_id}/messages`
  using the conversation's `channelConfigId` credentials — `text` first;
  `image/document/audio` via `link` (public storage URL) or uploaded media id. Store
  returned wamid → message `externalId`, set `deliveryStatus: "sent"`.
- [ ] **4.2 Hook into send flow**: in `sendMessage`/`internalSendMessage`, when the
  conversation `channel === "whatsapp"` and `!isInternal`, schedule the dispatch action
  (`ctx.scheduler.runAfter(0, …)`). On Graph API error: `deliveryStatus: "failed"` +
  error code/message in `metadata` + activity entry (visible in Inbox). Missing/disabled
  config → failed with a clear, user-readable reason.
- [ ] **4.3 Pacing**: per-conversation sequential dispatch with small delay to respect
  the ~1 msg/6s per-recipient pair limit (error `131056`); simple scheduler chaining is
  enough — no queue infra.
- [ ] **4.4 24h service window**: track `lastInboundAt` on the conversation (set by
  ingress); expose an `isWithinServiceWindow` computed field in conversation queries;
  on `131026` (window closed) mark failed with a clear message.
- [ ] **4.5 Template sending (minimal)**: `internalSendTemplate` mutation + REST endpoint
  `POST /api/v1/conversations/send-template` (`templateName`, `languageCode`,
  `components?`) for re-engaging outside the window. Record as an outbound message
  (rendered body best-effort, metadata carries template info).
- [ ] **4.6 Mark-as-read (nice-to-have)**: on human/AI reply, send read receipt for the
  latest inbound wamid. Skip if it complicates the wave.
- [ ] **4.7 Tests**: dispatch scheduling on whatsapp channel only, per-config credential
  resolution, error mapping (`131026`/`131056` → failed + metadata), window computation.

**Gate:** lint + tests green.
**Commit:** `feat: WhatsApp outbound dispatch, 24h window & template messages vX.Y.Z`

## Wave 5 — Settings UI, Inbox polish & reliability ~2–3 days

- [ ] **5.1 Settings → Channels page** (follow existing settings/UI patterns, PT-BR like
  the rest of the app): list of connected WhatsApp numbers per org; connect form
  (display name, phone number id, WABA id, verify token — generated suggestion —,
  app secret, access token); secrets shown masked after save (re-paste to change);
  "Test connection" button (health check, shows verified name/number); enable/disable;
  the exact webhook callback URL + verify token displayed for copy-paste into the Meta
  app config. Admin-only.
- [ ] **5.2 Setup guidance in-UI**: short inline checklist linking to
  `docs/WHATSAPP-SETUP.md` (what to create on Meta's side, in which order).
- [ ] **5.3 Inbox UI**: delivery-status ticks on outbound whatsapp messages
  (sent/delivered/read/failed with error tooltip); failed-send visual state; service
  window indicator on the conversation header ("window closes in Xh" / "window closed —
  template required"). Minimal and consistent with existing Inbox components.
- [ ] **5.4 Saved views**: add `channel` filter to `filtersValidator` + UI (gap found in
  review — e.g. "WhatsApp leads awaiting handoff" views).
- [ ] **5.5 Outbound webhook reliability**: retry with backoff (3 attempts) + treat
  non-2xx as failure + log failures (today only thrown exceptions are logged).
- [ ] **5.6 (Stretch)** basic rate limiting on `/api/v1` authenticated endpoints
  (currently none — a leaked API key has no throttle).

**Gate:** lint + tests green; manual UI walkthrough (screenshots in the wave summary).
**Commits:** `feat: WhatsApp channel settings UI & inbox delivery states vX.Y.Z` ·
`feat: channel filters & webhook delivery retries vX.Y.Z`

## Wave 6 — Docs & end-to-end validation (needs Meta credentials — human in the loop)

*Runs entirely on the free dev sandbox (test number, up to 5 recipients) before any
real number/business verification exists.*

- [ ] **6.1 Docs**: update `README.md` (features), `docs/PROJECT-STATUS.md`,
  `convex/openapiSpec.ts` + `convex/llmsTxt.ts` (new endpoints/events), and write
  **`docs/WHATSAPP-SETUP.md`**: Meta app creation, WABA, System User token, webhook
  URL + verify token, test-number sandbox, going live with a real number — written for
  a tenant admin, not a developer.
- [ ] **6.2** Meta dev app created, Cloud API test number active,
  `CHANNEL_ENCRYPTION_KEY` set, channel config created **via the Settings UI**,
  webhook subscribed (`messages` field) and verified.
- [ ] **6.3** Round-trip: message from a personal phone → Inbox contact bubble (correct
  profile name), lead auto-created on default board, conversation linked to the config.
- [ ] **6.4** Reply from CRM UI (human) → arrives on the phone; ticks progress
  sent → delivered → read.
- [ ] **6.5** Reply via REST as an `ai` team member (`/api/v1/conversations/send`) →
  arrives; `message.sent` webhook fires with `senderType: "ai"`.
- [ ] **6.6** Media both ways (photo in, document out). Interactive reply buttons in.
- [ ] **6.7** Idempotency proven: re-deliver a captured webhook payload (curl) → no
  duplicate. Signature tampering → 401. Unknown phone_number_id → 200 + drop.
- [ ] **6.8** Second config in a second org (can be a dummy) proves multi-tenant
  routing end-to-end.
- [ ] **6.9** Window/template behavior exercised (or documented dry-run if no approved
  template yet). Record results + gotchas in the Progress log; file follow-up issues.

**Commit:** `docs: WhatsApp Cloud API setup guide & connector status`

---

## Out of scope (documented follow-ups — file as GitHub issues at the end)

Tech Provider / Embedded Signup ("connect in 2 clicks" hosted SaaS path, requires Meta
App Review) · template creation/management UI · WhatsApp Flows · Coexistence
(`smb_message_echoes`) · payments · per-org encryption keys / key rotation tooling.

## Progress log

<!-- Agent: append entries as `- YYYY-MM-DD — [wave.task] summary (commit abc1234)` -->
<!-- Blocked items: `- YYYY-MM-DD — BLOCKED [wave.task]: reason, what's needed` -->

- 2026-07-11 — [1.1] `externalId` on `messages` + `by_organization_and_external_id` index; verified `deliveryStatus` already covers sent|delivered|read|failed (Wave 1 commit)
- 2026-07-11 — [1.2] `internalReceiveMessage` in `conversations.ts` — inbound contact messages, idempotent on `externalId`, get-or-creates conversation via shared `getOrCreateConversation` helper (also deduped `createConversation`/`internalCreateConversation`), reopens closed conversations, updates lead activity, logs `message_received` activity (Wave 1 commit)
- 2026-07-11 — [1.3] `POST /api/v1/conversations/receive` in `router.ts` — X-API-Key auth, contact by `contactId`/`contactPhone` (find-or-create), lead find-or-create on default board with AI auto-assign; added `internalGetLeadsByContact` to `leads.ts` (Wave 1 commit)
- 2026-07-11 — [1.4] `message.received` webhook fired on inbound creation with payload parity (senderType/contactId/externalId); event registered in `llmsTxt.ts` event table (Wave 1 commit)
- 2026-07-11 — [1.5] `message.sent` payload enriched with `senderType` + `senderId` in both `sendMessage` and `internalSendMessage` (Wave 1 commit)
- 2026-07-11 — [1.6] `internalUpdateDeliveryStatus(organizationId, externalId, status, errorDetail?)` — org arg added to honor org-scoped index; unknown externalId → warn + null (Wave 1 commit)
- 2026-07-11 — [1.7] Test harness: `vitest` + `convex-test@0.0.41` (pinned — 0.0.42+ requires convex ^1.32, repo is on 1.31.2) + `@edge-runtime/vm`; `vitest.config.mts` (edge-runtime env); `npm test` script; 6 tests in `convex/conversations.test.ts` covering inbound creation, idempotent replay, `message.received`/`message.sent` payload sender info, delivery-status happy/unknown paths. Fake timers keep scheduled webhook triggers queued (asserted via `_scheduled_functions`) (Wave 1 commit)
- 2026-07-11 — **Wave 1 gate green**: `npm run lint` exit 0 (tsc convex + tsc app + convex dev --once + vite build) and `npm test` 6/6 passing (commit 4c5a506)
- 2026-07-11 — [2.1] `channelConfigs` table with all planned fields + `appSecretLast4`/`accessTokenLast4` (plaintext last-4 so queries can mask without decrypting); indexes `by_organization`, `by_phone_number_id`, `by_verify_token` (Wave 2 commit)
- 2026-07-11 — [2.2] `convex/lib/secretCrypto.ts` — AES-256-GCM via Web Crypto, random 12-byte IV, `v1:` prefix, clear errors for missing/malformed `CHANNEL_ENCRYPTION_KEY`; 7 unit tests in `convex/secretCrypto.test.ts` (round-trip, unique IV, tamper rejection, format/key errors) (Wave 2 commit)
- 2026-07-11 — [2.3] `convex/channelConfigs.ts` — create/update as public **actions** (encrypt in action, persist via internal mutation running `requirePermission(settings, manage)` on the caller's auth context); enable/disable/delete mutations; `getChannelConfigs` returns masked (`…last4`) + `hasToken`, never encrypted fields; audit logs record changed field names only; phoneNumberId/verifyToken uniqueness enforced deployment-wide (webhook routing keys); `channelConfig` label added to `auditDescription.ts` (Wave 2 commit)
- 2026-07-11 — [2.4] `checkChannelHealth` action — Graph API v23.0 `GET /{phone_number_id}?fields=display_phone_number,verified_name` with decrypted token; stores `status`/`displayPhoneNumber`/`healthDetail`/`lastHealthCheckAt`; failing check → `status: "error"`, passing check restores `active` unless deliberately `disabled` (Wave 2 commit)
- 2026-07-11 — [2.5] `channelConfigId` optional field on `conversations`; `internalGetDefaultActiveConfig(organizationId, channel)` resolves single-config orgs (wired into egress in Wave 4) (Wave 2 commit)
- 2026-07-11 — [2.6] 13 tests in `convex/channelConfigs.test.ts`: encrypted at rest + masked reads + no secrets in audit payloads, duplicate phoneNumberId rejected, admin-only enforcement (agent + unauthenticated rejected), health check happy/error paths with mocked Graph API fetch, default-active-config resolution skips disabled configs (Wave 2 commit)
- 2026-07-11 — **Wave 2 gate green**: `npm run lint` exit 0 and `npm test` 20/20 passing. Note: convex action types referencing same-module internals need explicit handler return annotations (TS7022 circularity) — pattern documented by example in `channelConfigs.ts` (commit be6d745)
- 2026-07-11 — [3.1] `convex/whatsapp.ts` (handlers + ingest action + routing mutation) + `convex/lib/whatsappParse.ts` (pure payload parsing + HMAC verification); routes wired in `router.ts` at `/webhooks/whatsapp` (Wave 3 commit)
- 2026-07-11 — [3.2] GET handshake: `hub.verify_token` looked up across active configs via `by_verify_token` index → echoes `hub.challenge`; 403 otherwise (Wave 3 commit)
- 2026-07-11 — [3.3] POST: raw body → untrusted parse → `phone_number_id` → config lookup → `X-Hub-Signature-256` HMAC-SHA256 timing-safe verify with decrypted per-tenant appSecret; 401 mismatch, 200+drop+warn unknown ids, 400 invalid JSON; statuses inline, messages via scheduler (answer <5s) (Wave 3 commit)
- 2026-07-11 — [3.4] All payload types parsed: text, image/sticker/audio/video/document (→media), interactive button/list replies, template button, location, contacts, reaction (readable PT-BR text + raw in metadata), unknown → `[unsupported message type: X]`; profile name mapped into contact get-or-create (Wave 3 commit)
- 2026-07-11 — [3.5] Media pipeline in `internalIngestMessage`: Graph `GET /{media_id}` with per-config token → immediate download → `ctx.storage.store` → `files` record (`message_attachment`, no uploader — `files.uploadedBy` made optional) linked to the message; 25MB size guard with metadata note; media errors degrade to metadata, message still ingested (Wave 3 commit)
- 2026-07-11 — [3.6] Shared routing extracted to `convex/lib/inboundRouting.ts` (`findOrCreateContactByPhone` + `ensureLeadForContact`: default board/first stage, AI auto-assign, activity+audit) — used by webhook ingress AND `/api/v1/conversations/receive` (refactored to `internal.leads.internalEnsureLeadForContact`, removing the Wave 1 inline copy); `buildSearchText` moved to `lib/searchText.ts`; conversation stamped with `channelConfigId` (Wave 3 commit)
- 2026-07-11 — [3.7] `value.statuses[]` → `internalUpdateDeliveryStatus` per wamid, `errors[]` (code/title/details, e.g. 131047) captured into message metadata (Wave 3 commit)
- 2026-07-11 — [3.8] 26 new tests (46 total): `whatsappParse.test.ts` (every payload type, statuses, signature pass/fail) + `whatsapp.test.ts` (handshake 200/403, signature 401, unknown phone_number_id 200-drop, multi-tenant routing to the right org/config, ingest end-to-end incl. contact/lead/conversation, duplicate replay idempotency, media download with per-config token, oversized-media skip, status updates via POST) (Wave 3 commit)
- 2026-07-11 — **Wave 3 gate green**: lint exit 0, 46/46 tests; manual curl smoke against the dev deployment: GET wrong token → 403, POST unknown phone_number_id → 200 drop, invalid JSON → 400. `CHANNEL_ENCRYPTION_KEY` confirmed present on the dev deployment
