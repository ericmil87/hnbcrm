# HNBCRM API Reference

Complete mapping of MCP tools to REST API endpoints.

All REST endpoints are at `/api/v1/*` and require an `X-API-Key` header. MCP tools handle authentication automatically via environment variables.

API keys resolve permissions in this order: key-level permissions > team member permissions > role defaults. Keys can optionally have:
- **Scoped permissions**: Restrict a key to specific operations (e.g., read-only)
- **Expiration**: Keys with `expiresAt` are automatically rejected after expiration

---

## Permissions per route

**Every `/api/v1` route enforces a minimum permission** (category + level), checked right after the API key is authenticated. A key below the required level gets the same response on every route:

```json
{ "error": "Permissão insuficiente", "code": 403 }
```

The required level mirrors the equivalent in-app function: where the app calls `requirePermission(ctx, org, category, level)` the route requires the same pair; where the app only requires organization membership, the route requires the category's lowest read level. A route with no entry in the table is rejected (fail-closed). Source of truth: `ROUTE_PERMISSIONS` in `convex/router.ts`.

The last column shows whether the **default** permissions of the `ai` and `agent` roles (identical: leads `edit_own`, contacts `edit`, inbox `reply`, tasks `edit_own`, reports `view`, team/settings/auditLogs/apiKeys `none`) are enough. When it says **não**, the key needs an explicit permission override (Settings → Team → member → permissions) or an admin-linked key — otherwise the MCP tool that calls it (`crm_delete_lead`, `crm_list_team`) fails with 403.

| Route | Required permission | `ai`/`agent` default is enough? |
|-------|---------------------|-------------------------------|
| `POST /api/v1/inbound/lead` | `leads: edit_own` | sim |
| `GET /api/v1/leads` | `leads: view_own` | sim |
| `GET /api/v1/leads/get` | `leads: view_own` | sim |
| `POST /api/v1/leads/update` | `leads: view_own` | sim |
| `POST /api/v1/leads/delete` | `leads: full` | **não** |
| `POST /api/v1/leads/move-stage` | `leads: view_own` | sim |
| `POST /api/v1/leads/assign` | `leads: view_own` | sim |
| `POST /api/v1/leads/handoff` | `inbox: view_own` | sim |
| `GET /api/v1/contacts` | `contacts: view` | sim |
| `POST /api/v1/contacts/create` | `contacts: edit` | sim |
| `GET /api/v1/contacts/get` | `contacts: view` | sim |
| `POST /api/v1/contacts/update` | `contacts: view` | sim |
| `POST /api/v1/contacts/enrich` | `contacts: edit` | sim |
| `GET /api/v1/contacts/gaps` | `contacts: view` | sim |
| `GET /api/v1/contacts/search` | `contacts: view` | sim |
| `GET /api/v1/conversations` | `inbox: view_own` | sim |
| `GET /api/v1/conversations/messages` | `inbox: view_own` | sim |
| `POST /api/v1/conversations/send` | `inbox: view_own` | sim |
| `POST /api/v1/conversations/send-template` | `inbox: reply` | sim |
| `POST /api/v1/conversations/receive` | `inbox: reply` | sim |
| `GET /api/v1/handoffs` | `inbox: view_own` | sim |
| `GET /api/v1/handoffs/pending` | `inbox: view_own` | sim |
| `POST /api/v1/handoffs/accept` | `inbox: reply` | sim |
| `POST /api/v1/handoffs/reject` | `inbox: reply` | sim |
| `POST /api/v1/files/upload-url` | `leads: edit_own` | sim |
| `POST /api/v1/files` | `leads: edit_own` | sim |
| `GET /api/v1/files/:id/url` | `leads: view_own` | sim |
| `DELETE /api/v1/files/:id` | `leads: edit_own` | sim |
| `POST /api/v1/exports` | `settings: manage` | **não** |
| `GET /api/v1/exports` | `settings: manage` | **não** |
| `GET /api/v1/exports/get` | `settings: manage` | **não** |
| `GET /api/v1/exports/download` | `settings: manage` | **não** |
| `POST /api/v1/imports` | `settings: manage` | **não** |
| `GET /api/v1/imports` | `settings: manage` | **não** |
| `GET /api/v1/imports/get` | `settings: manage` | **não** |
| `POST /api/v1/imports/mapping` | `settings: manage` | **não** |
| `POST /api/v1/imports/preview` | `settings: manage` | **não** |
| `POST /api/v1/imports/confirm` | `settings: manage` | **não** |
| `POST /api/v1/imports/rollback` | `settings: manage` | **não** |
| `GET /api/v1/imports/failed-rows` | `settings: manage` | **não** |
| `GET /api/v1/boards` | `leads: view_own` | sim |
| `GET /api/v1/team-members` | só API key válida (espelha requireAuth do app) | sim |
| `GET /api/v1/field-definitions` | `leads: view_own` | sim |
| `GET /api/v1/lead-sources` | `leads: view_own` | sim |
| `GET /api/v1/activities` | `leads: view_own` | sim |
| `POST /api/v1/activities` | `leads: view_own` | sim |
| `GET /api/v1/dashboard` | `reports: view` | sim |
| `GET /api/v1/audit-logs` | `auditLogs: view` | **não** |
| `GET /api/v1/tasks` | `tasks: view_own` | sim |
| `GET /api/v1/tasks/get` | `tasks: view_own` | sim |
| `GET /api/v1/tasks/my` | `tasks: view_own` | sim |
| `GET /api/v1/tasks/overdue` | `tasks: view_own` | sim |
| `GET /api/v1/tasks/search` | `tasks: view_own` | sim |
| `POST /api/v1/tasks/create` | `tasks: view_own` | sim |
| `POST /api/v1/tasks/update` | `tasks: view_own` | sim |
| `POST /api/v1/tasks/complete` | `tasks: view_own` | sim |
| `POST /api/v1/tasks/delete` | `tasks: view_own` | sim |
| `POST /api/v1/tasks/assign` | `tasks: view_own` | sim |
| `POST /api/v1/tasks/snooze` | `tasks: view_own` | sim |
| `POST /api/v1/tasks/bulk` | `tasks: view_own` | sim |
| `GET /api/v1/tasks/comments` | `tasks: view_own` | sim |
| `POST /api/v1/tasks/comments/add` | `tasks: view_own` | sim |
| `GET /api/v1/calendar/events` | `tasks: view_own` | sim |
| `GET /api/v1/calendar/events/get` | `tasks: view_own` | sim |
| `POST /api/v1/calendar/events/create` | `tasks: view_own` | sim |
| `POST /api/v1/calendar/events/update` | `tasks: view_own` | sim |
| `POST /api/v1/calendar/events/delete` | `tasks: view_own` | sim |
| `POST /api/v1/calendar/events/reschedule` | `tasks: view_own` | sim |
| `POST /api/v1/calendar/events/complete` | `tasks: view_own` | sim |
| `GET /api/v1/notifications/preferences` | só API key válida (self-scoped) | sim |
| `PUT /api/v1/notifications/preferences` | só API key válida (self-scoped) | sim |

Public routes (no API key, no permission): `GET /api/v1/forms/public`, `POST /api/v1/forms/public/submit`, `POST /api/v1/forms/public/partial`, `POST /api/v1/forms/experiment/view`, `GET /api/v1/embed.js`, `GET /api/v1/openapi.json`, `POST /api/v1/webhooks/resend`.

---

## Lead Management

### crm_create_lead

Create a new lead with optional contact and initial message.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | yes | Lead title |
| contact | object | no | `{ firstName, lastName, email, phone, company }` |
| value | number | no | Deal value (default: 0) |
| priority | string | no | `low`, `medium`, `high`, `urgent` (default: medium) |
| temperature | string | no | `cold`, `warm`, `hot` (default: cold) |
| tags | string[] | no | Tags |
| customFields | object | no | Custom field values |
| message | string | no | Initial message (creates conversation) |
| channel | string | no | Channel for message (default: webchat) |
| sourceId | string | no | Lead source ID |

**REST:** `POST /api/v1/inbound/lead` — Same body as MCP params

**Response:** `{ success: true, leadId, contactId }`

---

### crm_list_leads

List leads with optional filters.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| boardId | string | no | Filter by board |
| stageId | string | no | Filter by stage |
| assignedTo | string | no | Filter by assigned team member |

**REST:** `GET /api/v1/leads?boardId=X&stageId=Y&assignedTo=Z&limit=200&cursor=CURSOR`

**Response:** `{ leads: [...], nextCursor, hasMore }`

---

### crm_get_lead

Get full details of a specific lead.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | string | yes | The lead ID |

**REST:** `GET /api/v1/leads/get?id=LEAD_ID`

**Response:** `{ lead: { ... } }`

---

### crm_update_lead

Update lead properties.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | string | yes | The lead ID |
| title | string | no | New title |
| value | number | no | New value |
| priority | string | no | New priority |
| temperature | string | no | New temperature |
| tags | string[] | no | New tags |
| customFields | object | no | Custom field values |
| sourceId | string | no | New source ID |
| qualification | object | no | BANT scoring: `{ budget, authority, need, timeline: boolean, score: number }` |

**REST:** `POST /api/v1/leads/update` — Same body as MCP params

**Response:** `{ success: true }`

---

### crm_delete_lead

Permanently delete a lead.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | string | yes | The lead ID |

**REST:** `POST /api/v1/leads/delete` — Body: `{ leadId }`

**Response:** `{ success: true }`

---

### crm_move_lead

Move a lead to a different pipeline stage.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | string | yes | The lead ID |
| stageId | string | yes | Target stage ID |

**REST:** `POST /api/v1/leads/move-stage` — Body: `{ leadId, stageId }`

**Response:** `{ success: true }`

---

### crm_assign_lead

Assign a lead to a team member or unassign.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | string | yes | The lead ID |
| assignedTo | string | no | Team member ID (omit to unassign) |

**REST:** `POST /api/v1/leads/assign` — Body: `{ leadId, assignedTo? }`

**Response:** `{ success: true }`

---

## Contact Management

### crm_list_contacts

List all contacts in the organization with cursor-based pagination.

**MCP Parameters:** None

**REST:** `GET /api/v1/contacts?limit=500&cursor=CURSOR`

**Response:** `{ contacts: [...], nextCursor, hasMore }`

---

### crm_get_contact

Get full contact details including enrichment data.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| contactId | string | yes | The contact ID |

**REST:** `GET /api/v1/contacts/get?id=CONTACT_ID`

**Response:** `{ contact: { ... } }`

---

### crm_create_contact

Create a new contact.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| firstName | string | no | First name |
| lastName | string | no | Last name |
| email | string | no | Email address |
| phone | string | no | Phone number |
| company | string | no | Company name |
| title | string | no | Job title |
| *(all other contact fields)* | various | no | See [Data Model](DATA_MODEL.md) |

**REST:** `POST /api/v1/contacts/create` — Same body as MCP params

**Response:** `{ success: true, contactId }`

---

### crm_update_contact

Update contact information.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| contactId | string | yes | The contact ID |
| *(any contact fields)* | various | no | Fields to update |

**REST:** `POST /api/v1/contacts/update` — Same body as MCP params

**Response:** `{ success: true }`

---

### crm_enrich_contact

Write enrichment data to a contact with provenance tracking.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| contactId | string | yes | The contact ID |
| fields | object | yes | Field values to enrich (e.g. `{ company: "Acme" }`) |
| source | string | yes | Data source name (e.g. "linkedin-profile") |
| confidence | number | no | Confidence score 0.0-1.0 |

**REST:** `POST /api/v1/contacts/enrich` — Same body as MCP params

**Response:** `{ success: true }`

---

### crm_get_contact_gaps

Identify missing/enrichable fields on a contact.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| contactId | string | yes | The contact ID |

**REST:** `GET /api/v1/contacts/gaps?id=CONTACT_ID`

**Response:** `{ contact: { missingFields: [...], enrichmentMeta: { ... } } }`

---

### crm_search_contacts

Search contacts by name, email, company, or other text.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| query | string | yes | Search text |
| limit | number | no | Max results (default 20, max 100) |

**REST:** `GET /api/v1/contacts/search?q=QUERY&limit=20`

**Response:** `{ contacts: [...] }`

---

## Conversations

### crm_list_conversations

List conversations with cursor-based pagination, optionally filtered by lead.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | string | no | Filter by lead |

**REST:** `GET /api/v1/conversations?leadId=X&limit=200&cursor=CURSOR`

**Response:** `{ conversations: [...], nextCursor, hasMore }`

---

### crm_get_messages

Get all messages in a conversation thread.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| conversationId | string | yes | The conversation ID |

**REST:** `GET /api/v1/conversations/messages?conversationId=X`

**Response:** `{ messages: [...] }`

---

### crm_send_message

Send a message or internal note in a conversation.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| conversationId | string | yes | The conversation ID |
| content | string | yes | Message content |
| contentType | string | no | `text`, `image`, `file`, `audio` (default: text) |
| isInternal | boolean | no | Mark as internal note (default: false) |
| mentionedUserIds | string[] | no | Team member IDs to mention |

**REST:** `POST /api/v1/conversations/send` — Same body as MCP params

**Response:** `{ success: true, messageId }`

---

## Handoffs

### crm_request_handoff

Request an AI-to-human (or human-to-human) handoff for a lead.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | string | yes | The lead ID |
| reason | string | yes | Why the handoff is needed |
| toMemberId | string | no | Target team member (null = any human) |
| summary | string | no | Conversation summary |
| suggestedActions | string[] | no | Recommended next steps |

**REST:** `POST /api/v1/leads/handoff` — Same body as MCP params

**Response:** `{ success: true, handoffId }`

---

### crm_list_handoffs

List handoff requests by status with cursor-based pagination.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| status | string | no | `pending`, `accepted`, `rejected` |

**REST:** `GET /api/v1/handoffs?status=pending&limit=200&cursor=CURSOR`

**Response:** `{ handoffs: [...], nextCursor, hasMore }`

---

### crm_accept_handoff

Accept a pending handoff.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| handoffId | string | yes | The handoff ID |
| notes | string | no | Optional acceptance notes |

**REST:** `POST /api/v1/handoffs/accept` — Body: `{ handoffId, notes? }`

**Response:** `{ success: true }`

---

### crm_reject_handoff

Reject a pending handoff with optional feedback.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| handoffId | string | yes | The handoff ID |
| notes | string | no | Reason for rejection |

**REST:** `POST /api/v1/handoffs/reject` — Body: `{ handoffId, notes? }`

**Response:** `{ success: true }`

---

## Pipeline & Reference

### crm_list_boards

List all pipeline boards with their stages.

**MCP Parameters:** None

**REST:** `GET /api/v1/boards`

**Response:** `{ boards: [{ ...board, stages: [...] }] }`

Each stage has `isClosedWon` and `isClosedLost` booleans indicating terminal stages.

---

### crm_list_team

List all team members in the organization.

**MCP Parameters:** None

**REST:** `GET /api/v1/team-members`

**Response:** `{ members: [...] }`

Members have `type: "human" | "ai"`, `role: "admin" | "manager" | "agent" | "ai"`, and optional `permissions` object with 9 granular RBAC categories. When `permissions` is null, role-based defaults apply.

> **Note:** Team management operations (invite, update, remove, reactivate) are Convex-only mutations and are not available via the REST API. Use the Convex client for these operations.

---

### crm_get_dashboard

Get pipeline analytics and summary statistics.

**MCP Parameters:** None

**REST:** `GET /api/v1/dashboard`

**Response:** `{ totalLeads, leadsByStage, leadsBySource, recentActivity, teamPerformance, ... }`

---

### Field Definitions

**REST only:** `GET /api/v1/field-definitions`

**Response:** `{ fields: [...] }`

---

### Lead Sources

**REST only:** `GET /api/v1/lead-sources`

**Response:** `{ sources: [...] }`

---

## Activities

### crm_get_activities

Get the activity timeline for a lead with cursor-based pagination.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | string | yes | The lead ID |
| limit | number | no | Max results (default 50, max 200) |

**REST:** `GET /api/v1/activities?leadId=X&limit=50&cursor=CURSOR`

**Response:** `{ activities: [...], nextCursor, hasMore }`

---

### crm_create_activity

Log an activity on a lead.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | string | yes | The lead ID |
| type | string | yes | `note`, `call`, `email_sent` |
| content | string | no | Activity description |
| metadata | object | no | Additional structured data |

**REST:** `POST /api/v1/activities` — Same body as MCP params

**Response:** `{ success: true, activityId }`

---

## Audit Logs

### Audit Logs (REST only)

**REST:** `GET /api/v1/audit-logs`

**Query params:** `entityType`, `action`, `severity`, `actorId`, `startDate`, `endDate`, `cursor`, `limit` (all optional)

**Response:** `{ logs: [...], nextCursor, hasMore }`

---

## Calendar

### calendar_list_events

List calendar events in a date range with optional filters.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| startDate | number | yes | Start of date range (timestamp ms) |
| endDate | number | yes | End of date range (timestamp ms) |
| assignedTo | string | no | Filter by assigned team member |
| eventType | string | no | Filter by event type |
| status | string | no | Filter by status |
| leadId | string | no | Filter by associated lead |
| contactId | string | no | Filter by associated contact |
| includeTasks | boolean | no | Include tasks with dueDate in range (default: true) |

**REST:** `GET /api/v1/calendar/events?startDate=X&endDate=Y&assignedTo=Z&eventType=T&status=S&leadId=L&contactId=C&includeTasks=true`

**Response:** `{ events: [...] }`

---

### calendar_create_event

Create a new calendar event.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | yes | Event title |
| eventType | string | yes | `call`, `meeting`, `follow_up`, `demo`, `task`, `reminder`, `other` |
| startTime | number | yes | Start timestamp (ms) |
| endTime | number | yes | End timestamp (ms) |
| allDay | boolean | no | All-day event (default: false) |
| description | string | no | Description |
| leadId | string | no | Associated lead |
| contactId | string | no | Associated contact |
| assignedTo | string | no | Assigned team member |
| attendees | string[] | no | Attendee team member IDs |
| location | string | no | Meeting location |
| meetingUrl | string | no | Video conference URL |
| recurrence | object | no | `{ pattern, endDate? }` |
| notes | string | no | Additional notes |

**REST:** `POST /api/v1/calendar/events/create` — Same body as MCP params

**Response:** `{ success: true, eventId }`

---

### calendar_get_event

Get full details of a calendar event.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | string | yes | The event ID |

**REST:** `GET /api/v1/calendar/events/get?id=EVENT_ID`

**Response:** `{ event: { ... } }`

---

### calendar_update_event

Update calendar event fields.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | string | yes | The event ID |
| title | string | no | New title |
| description | string | no | New description |
| eventType | string | no | New type |
| startTime | number | no | New start time |
| endTime | number | no | New end time |
| allDay | boolean | no | All-day toggle |
| location | string | no | New location |
| meetingUrl | string | no | New meeting URL |
| notes | string | no | New notes |

**REST:** `POST /api/v1/calendar/events/update` — Same body as MCP params

**Response:** `{ success: true }`

---

### calendar_delete_event

Delete a calendar event (cascades to recurring child events).

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | string | yes | The event ID |

**REST:** `POST /api/v1/calendar/events/delete` — Body: `{ eventId }`

**Response:** `{ success: true }`

---

### calendar_reschedule_event

Reschedule a calendar event to a new time.

**MCP Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | string | yes | The event ID |
| newStartTime | number | yes | New start timestamp (ms) |
| newEndTime | number | no | New end timestamp (auto-calculated from duration if omitted) |

**REST:** `POST /api/v1/calendar/events/reschedule` — Body: `{ eventId, newStartTime, newEndTime? }`

**Response:** `{ success: true }`

---

### Additional Calendar REST Endpoints

**POST /api/v1/calendar/events/complete** — Mark event as completed. Body: `{ eventId }`. If event has recurrence, auto-generates next instance.

---

## Public Forms (no auth required)

### GET /api/v1/forms/public

Get a published form by slug. No authentication required.

**Query params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slug | string | yes | Form slug |

**Response:** `{ form: { name, description, fields, theme, settings: { submitButtonText, successMessage, redirectUrl, honeypotEnabled } } }`

---

### POST /api/v1/forms/public/submit

Submit data to a published form. Creates a lead and contact automatically.

**Body:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slug | string | yes | Form slug |
| data | object | yes | Field values keyed by field ID |
| _honeypot | any | no | Honeypot field — if filled, submission is silently marked as spam |

**Response:** `{ success: true, leadId, contactId }`

---

## Pending Handoffs Shortcut

**REST only:** `GET /api/v1/handoffs/pending`

Shortcut for `GET /api/v1/handoffs?status=pending`.

**Response:** `{ handoffs: [...] }`

---

## Notifications

### Notification Tools
| MCP Tool | REST Endpoint |
|----------|--------------|
| `crm_get_notification_preferences` | GET /api/v1/notifications/preferences |
| `crm_update_notification_preferences` | PUT /api/v1/notifications/preferences |

---

## Data Export / Import (REST only)

No MCP tools — these endpoints exist only in the REST API and in the app UI (Settings → Dados).

**These are the only endpoints that enforce a permission level.** The API key must resolve to `settings: manage` (admin default; manager only has `settings: view`). Anything lower gets `403 { "error": "Permissão insuficiente" }`. Every job transition is written to `auditLogs` — a full backup is logged with severity `high`.

Both flows are asynchronous: the POST returns a `jobId` and the work happens in the background. Poll the `get` endpoint until the job reaches a terminal status.

### Export Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/exports` | Create an export job |
| GET | `/api/v1/exports` | List the last 20 export jobs |
| GET | `/api/v1/exports/get?id=<jobId>` | Poll a single job |
| GET | `/api/v1/exports/download?id=<jobId>` | Download the generated file |

> CSV cells starting with `=`, `+`, `@` or TAB come prefixed with `'` (formula-injection protection; negative numbers untouched). The import side strips the prefix, so export → reimport round-trips cleanly.

#### POST /api/v1/exports

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| format | string | yes | `csv` or `json` |
| scope | string | yes | `entity` (one table as CSV) or `full_backup` (whole org as JSON) |
| entity | string | when scope=entity | `contacts`, `leads` or `tasks` |
| columns | string[] | no | Subset of CSV columns (default: all) |

Valid combinations: `scope=entity` requires `format=csv`; `scope=full_backup` requires `format=json`. Only one active export job per organization — a second one returns "Já existe uma exportação em andamento nesta organização".

**Response:** `{ success: true, jobId }` (201)

#### GET /api/v1/exports/get?id=

**Response:** `{ job: { status, format, scope, entity, progress: { processed, total, currentEntity }, resultFileName, resultSize, rowCount, error, expiresAt, ... } }`

`status` goes `queued` → `running` → `completed` | `failed`. 404 when the job belongs to another organization or does not exist.

#### GET /api/v1/exports/download?id=

Streams the file through the authenticated endpoint (no public storage URL is ever persisted).

**Response:** the file body with `Content-Type: text/csv; charset=utf-8` (or `application/json`) and `Content-Disposition: attachment; filename="hnbcrm-contatos-2026-08-23.csv"`. 404 when the job is not `completed` or when the blob already expired (7 days).

CSV exports carry a UTF-8 BOM (opens cleanly in Excel/LibreOffice), ISO dates, denormalized names (`boardName`, `stageName`, `contactEmail`, …) and flattened custom fields as `cf_<key>` columns. The JSON backup is `{ format: "hnbcrm-backup", version: 1, exportedAt, organizationId, entities: { <table>: [...] } }` with all secrets stripped (no API keys, org secrets, channel credentials or webhook secrets). Restoring a backup is **not** supported.

### Import Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/imports` | Create an import job (header detection starts automatically) |
| GET | `/api/v1/imports` | List the last 20 import jobs |
| GET | `/api/v1/imports/get?id=<jobId>` | Poll a single job |
| POST | `/api/v1/imports/mapping` | Set the column → field mapping |
| POST | `/api/v1/imports/preview` | Run the dry-run |
| POST | `/api/v1/imports/confirm` | Execute the import |
| POST | `/api/v1/imports/rollback` | Undo a finished import |
| GET | `/api/v1/imports/failed-rows?id=<jobId>` | Download the rows that failed |

Canceling a job that has not started yet (status `mapping` / `preview_ready`) is available only in the app UI — there is no REST route for it. A stuck job blocks new imports for the organization until it is canceled or fails.

#### POST /api/v1/imports

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| entity | string | yes | `contacts` or `leads` |
| duplicateStrategy | string | yes | `skip`, `update` or `create` |
| fileName | string | yes | Name shown in the job history |
| csv | string | one of csv/fileId | Inline CSV content, max 5 MB |
| fileId | string | one of csv/fileId | File already saved via `POST /api/v1/files` with `fileType: "import_file"` (max 10 MB) |

Limits: 10.000 rows per job. Only one active import job per organization.

**Response:** `{ success: true, jobId, fileId }` (201)

#### POST /api/v1/imports/mapping

**Body:** `{ jobId, mapping }` — `mapping` keys are the **raw file headers**, exactly as they appear in `detectedHeaders`.

```json
{ "jobId": "...", "mapping": { "Nome": "firstName", "E-mail": "email", "Observações": "__ignore__" } }
```

Values are a field name, `cf:<key>` for a custom field of the organization, or `__ignore__` to drop the column. Contacts accept `firstName`, `lastName`, `email`, `phone`, `company`, `title`, `city`, `state`, `country`, `tags`, … Leads accept `title`, `value`, `boardName`, `stageName`, `sourceName`, `assigneeEmail`, `contactFirstName`, `contactLastName`, `contactEmail`, `contactPhone`, `contactCompany`, `priority`, `temperature`, `tags`, … Changing the mapping invalidates the previous dry-run. Only allowed before execution.

**Response:** `{ success: true }`

#### POST /api/v1/imports/preview · confirm · rollback

All three take `{ jobId }` and return `{ success: true }`; the work runs in the background.

- **preview** — queues the dry-run (`previewing`). When done the job sits at `preview_ready` with `dryRun: { totalRows, validRows, errorRows, newRows, updateRows, skipRows, sampleErrors (max 50), preview (max 10 rows) }`.
- **confirm** — only from `preview_ready` and only with `dryRun.validRows > 0`. Runs in batches of 50 rows; follow `progress: { processed, total, created, updated, skipped, failed }` until `completed` or `completed_with_errors`.
- **rollback** — only for `completed` / `completed_with_errors`. Deletes the created records and reverts the updated ones (`rolled_back`). Side effects already fired (activities, webhooks) are NOT reverted.

#### GET /api/v1/imports/failed-rows?id=

CSV with only the failed rows — original columns plus an `erro` column — ready to fix and re-import.

**Response:** `text/csv` body with `Content-Disposition: attachment` (empty body when there are no errors).

### Webhook events

`export.completed`, `export.failed`, `import.completed`, `import.failed`, `import.rolled_back` — see WORKFLOWS.md for the full polling flow.
