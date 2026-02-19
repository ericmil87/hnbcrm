// llms.txt and llms-full.txt content for LLM-readable documentation
// See https://llmstxt.org/

export const LLMS_TXT = `# HNBCRM

> CRM where humans and AI agents are equal team members.

HNBCRM is an open-source, multi-tenant CRM built on Convex with real-time collaboration between human sales reps and AI agents. It features a kanban pipeline, multi-channel conversations, AI-to-human handoffs, and contact enrichment.

## Documentation

- [Full API Reference](/llms-full.txt): Complete REST API, MCP tools, data model, and enum reference

## Quick Links

- REST API: /api/v1/* endpoints authenticated via X-API-Key header
- MCP Server: npx hnbcrm-mcp (46 tools for AI agents)
- Agent Skill: .claude/skills/hnbcrm/ — portable skill that teaches AI agents how to operate as CRM team members
- Channels: whatsapp, telegram, email, webchat, internal
- Auth: API key passed in X-API-Key header (SHA-256 hashed, stored per team member)
- Permissions: Granular RBAC with 9 categories (leads, contacts, inbox, tasks, reports, team, settings, auditLogs, apiKeys). API keys can have scoped permissions.

## Agent Skill (for AI Agents)

HNBCRM ships an open-standard Agent Skill that teaches any AI agent to operate as a CRM team member. The skill covers lead management, contact enrichment, conversation handling, and AI-to-human handoffs.

### Installation

Copy the skill directory to your agent's workspace:
\`\`\`
git clone <repo> && cp -r .claude/skills/hnbcrm/ ~/.your-agent/skills/hnbcrm/
\`\`\`

Or use the MCP server for tool access: \`npx hnbcrm-mcp\`

### Skill Contents
- SKILL.md — Main skill with role definition, bootstrap checklist, workflows, and best practices
- references/WORKFLOWS.md — Step-by-step playbooks (lead intake, qualification, enrichment, handoffs)
- references/API_REFERENCE.md — Complete MCP tool and REST endpoint mapping
- references/DATA_MODEL.md — All tables, fields, and enum values
- references/SETUP.md — Platform-specific MCP configuration (Claude, Cursor, VS Code, Gemini, OpenClaw)
`;

export const LLMS_FULL_TXT = `# HNBCRM — Full API Reference

> CRM where humans and AI agents are equal team members.

HNBCRM is an open-source, multi-tenant CRM built on Convex. Every table is scoped by organizationId for multi-tenancy. AI agents authenticate via API keys and operate as first-class team members alongside humans.

---

## Authentication

All REST API requests require an \`X-API-Key\` header. API keys are tied to a team member and an organization. The key is SHA-256 hashed before lookup.

API keys resolve permissions in a chain: key-level permissions > team member permissions > role defaults. Keys can have:
- Scoped permissions (restrict to specific operations, e.g. read-only leads)
- Expiration timestamps (expired keys are automatically rejected)

\`\`\`
X-API-Key: your-api-key-here
\`\`\`

---

## Data Model

### Lead
The core sales entity tracked through a pipeline.

| Field | Type | Description |
|-------|------|-------------|
| title | string | Lead title (required) |
| contactId | Id<contacts> | Associated contact |
| boardId | Id<boards> | Pipeline board |
| stageId | Id<stages> | Current stage in pipeline |
| assignedTo | Id<teamMembers> | Assigned team member (human or AI) |
| value | number | Monetary value |
| currency | string | Currency code (default: BRL) |
| priority | enum | low, medium, high, urgent |
| temperature | enum | cold, warm, hot |
| sourceId | Id<leadSources> | Origin source |
| tags | string[] | Tags for categorization |
| customFields | Record<string, any> | User-defined fields |
| qualification | object | BANT scoring: budget, authority, need, timeline (booleans) + score (number) |
| conversationStatus | enum | new, active, waiting, closed |
| handoffState | object | Current handoff status if any |
| closedAt | number | Timestamp if closed |
| closedType | enum | won, lost |

### Contact
A person or company associated with leads.

| Field | Type | Description |
|-------|------|-------------|
| firstName, lastName | string | Name |
| email | string | Email address |
| phone | string | Phone number |
| company | string | Company name |
| title | string | Job title |
| whatsappNumber | string | WhatsApp number |
| telegramUsername | string | Telegram handle |
| tags | string[] | Tags |
| photoUrl | string | Profile photo URL |
| bio | string | Short bio |
| linkedinUrl, instagramUrl, facebookUrl, twitterUrl | string | Social profiles |
| city, state, country | string | Location |
| industry | string | Industry |
| companySize | string | Company size category |
| cnpj | string | Brazilian company ID |
| companyWebsite | string | Company website |
| preferredContactTime | enum | morning, afternoon, evening |
| deviceType | enum | android, iphone, desktop, unknown |
| utmSource | string | UTM source |
| acquisitionChannel | string | How they were acquired |
| instagramFollowers, linkedinConnections | number | Social metrics |
| socialInfluenceScore | number | Influence score (0-100) |
| customFields | Record<string, any> | User-defined fields |
| enrichmentMeta | Record<string, {source, updatedAt, confidence}> | Provenance tracking for enriched fields |
| enrichmentExtra | Record<string, any> | Overflow for AI-discovered data |

### Board (Pipeline)
A kanban board containing stages.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Board name |
| description | string | Description |
| color | string | Display color |
| isDefault | boolean | Whether this is the default board for new leads |
| order | number | Display order |

### Stage
A column within a board.

| Field | Type | Description |
|-------|------|-------------|
| boardId | Id<boards> | Parent board |
| name | string | Stage name |
| color | string | Display color |
| order | number | Display order |
| isClosedWon | boolean | Marks as won stage |
| isClosedLost | boolean | Marks as lost stage |

### Conversation
A message thread on a lead, scoped by channel.

| Field | Type | Description |
|-------|------|-------------|
| leadId | Id<leads> | Associated lead |
| channel | enum | whatsapp, telegram, email, webchat, internal |
| status | enum | active, closed |
| messageCount | number | Total messages |

### Message
An individual message in a conversation.

| Field | Type | Description |
|-------|------|-------------|
| conversationId | Id<conversations> | Parent conversation |
| leadId | Id<leads> | Associated lead |
| direction | enum | inbound, outbound, internal |
| senderId | Id<teamMembers> | Sender (null for contact inbound) |
| senderType | enum | contact, human, ai |
| content | string | Message text |
| contentType | enum | text, image, file, audio |
| isInternal | boolean | Internal note (not visible to contact) |
| mentionedUserIds | Id<teamMembers>[] | @mentioned team members |

### Handoff
An AI-to-human (or human-to-human) handoff request.

| Field | Type | Description |
|-------|------|-------------|
| leadId | Id<leads> | Lead being handed off |
| fromMemberId | Id<teamMembers> | Requester |
| toMemberId | Id<teamMembers> | Target (optional, any human if null) |
| reason | string | Why the handoff is needed |
| summary | string | Conversation summary |
| suggestedActions | string[] | Recommended next steps |
| status | enum | pending, accepted, rejected |

### Team Member
A human or AI agent on the team.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Display name |
| email | string | Email (humans) |
| role | enum | admin, manager, agent, ai |
| type | enum | human, ai |
| status | enum | active, inactive, busy |
| capabilities | string[] | What this member can do |
| permissions | object | Granular RBAC overrides (9 categories). Null = use role defaults |
| mustChangePassword | boolean | Forces password change on first login |
| invitedBy | Id<teamMembers> | Who invited this member |
| userId | Id<users> | Linked auth user |

### API Key
Authentication key for REST API and MCP access, tied to a team member.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Key display name |
| teamMemberId | Id<teamMembers> | Associated team member |
| keyHash | string | SHA-256 hash (never stored in plaintext) |
| isActive | boolean | Whether the key is valid |
| permissions | object | Optional permission overrides (9 categories). Null = inherit from team member |
| expiresAt | number | Optional expiration timestamp |
| lastUsed | number | Last successful use timestamp |

### Permissions (RBAC)
9 permission categories, each with hierarchical levels:

| Category | Levels |
|----------|--------|
| leads | none, view_own, view_all, edit_own, edit_all, full |
| contacts | none, view, edit, full |
| inbox | none, view_own, view_all, reply, full |
| tasks | none, view_own, view_all, edit_own, edit_all, full |
| reports | none, view, full |
| team | none, view, manage |
| settings | none, view, manage |
| auditLogs | none, view |
| apiKeys | none, view, manage |

Role defaults: admin (full), manager (edit_all leads/tasks), agent (edit_own leads/tasks), ai (same as agent). Explicit permissions override role defaults.

### Field Definition (Custom Fields)
Schema for user-defined custom fields.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Display name |
| key | string | Unique key for storage |
| type | enum | text, number, boolean, date, select, multiselect |
| entityType | enum | lead, contact (optional — applies to both if null) |
| options | string[] | Options for select/multiselect types |
| isRequired | boolean | Whether the field is required |
| order | number | Display order |

### Lead Source
Where leads come from.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Source name |
| type | enum | website, social, email, phone, referral, api, other |
| isActive | boolean | Whether currently active |

### Task
A task or reminder in the CRM, optionally linked to leads/contacts.

| Field | Type | Description |
|-------|------|-------------|
| title | string | Task title (required) |
| description | string | Detailed description |
| type | enum | task, reminder |
| status | enum | pending, in_progress, completed, cancelled |
| priority | enum | low, medium, high, urgent |
| activityType | enum | todo, call, email, follow_up, meeting, research |
| dueDate | number | Due date timestamp |
| completedAt | number | Completion timestamp |
| snoozedUntil | number | Snoozed until timestamp |
| leadId | Id<leads> | Associated lead (optional) |
| contactId | Id<contacts> | Associated contact (optional) |
| assignedTo | Id<teamMembers> | Assigned team member |
| createdBy | Id<teamMembers> | Creator |
| recurrence | object | {pattern: daily/weekly/biweekly/monthly, endDate?} |
| parentTaskId | Id<tasks> | Parent task for recurrence instances |
| checklist | array | [{id, title, completed}] embedded subtasks |
| tags | string[] | Tags for categorization |

### Calendar Event
A time-ranged event on the calendar, optionally linked to leads/contacts.

| Field | Type | Description |
|-------|------|-------------|
| title | string | Event title (required) |
| description | string | Detailed description |
| eventType | enum | call, meeting, follow_up, demo, task, reminder, other |
| startTime | number | Start timestamp (Unix ms) |
| endTime | number | End timestamp (Unix ms) |
| allDay | boolean | All-day event flag |
| status | enum | scheduled, completed, cancelled |
| leadId | Id<leads> | Associated lead |
| contactId | Id<contacts> | Associated contact |
| taskId | Id<tasks> | Linked task |
| attendees | Id<teamMembers>[] | Event attendees |
| createdBy | Id<teamMembers> | Creator |
| assignedTo | Id<teamMembers> | Assigned team member |
| location | string | Meeting location |
| meetingUrl | string | Video conference URL |
| recurrence | object | {pattern: daily/weekly/biweekly/monthly, endDate?} |
| parentEventId | Id<calendarEvents> | Parent for recurring instances |
| notes | string | Additional notes |

### Task Comment
A comment on a task.

| Field | Type | Description |
|-------|------|-------------|
| taskId | Id<tasks> | Parent task |
| authorId | Id<teamMembers> | Comment author |
| authorType | enum | human, ai |
| content | string | Comment text |
| mentionedUserIds | Id<teamMembers>[] | @mentioned team members |

### File
File metadata for uploaded files (attachments, photos, documents).

| Field | Type | Description |
|-------|------|-------------|
| storageId | string | Convex storage ID |
| name | string | File name |
| mimeType | string | MIME type |
| size | number | File size in bytes |
| fileType | enum | message_attachment, contact_photo, member_avatar, lead_document, import_file, other |
| messageId | Id<messages> | Linked message (if attachment) |
| contactId | Id<contacts> | Linked contact (if photo) |
| leadId | Id<leads> | Linked lead (if document) |
| teamMemberId | Id<teamMembers> | Linked team member (if avatar) |
| uploadedBy | Id<teamMembers> | Who uploaded the file |
| metadata | Record<string, any> | Additional metadata |

### notificationPreferences
Per-member email notification preferences (opt-out model).
Fields: organizationId, teamMemberId, invite, handoffRequested, handoffResolved, taskOverdue, taskAssigned, leadAssigned, newMessage, dailyDigest, createdAt, updatedAt
Indexes: by_organization, by_organization_and_member, by_member

### Lead Document
Join table for lead-document relationships.

| Field | Type | Description |
|-------|------|-------------|
| leadId | Id<leads> | Associated lead |
| fileId | Id<files> | File record |
| title | string | Document title (optional, defaults to filename) |
| category | enum | contract, proposal, invoice, other |
| uploadedBy | Id<teamMembers> | Who uploaded the document |

---

## REST API Endpoints

All endpoints are at \`/api/v1/*\` and require \`X-API-Key\` header.

### Lead Endpoints

#### POST /api/v1/inbound/lead
Universal lead capture. Creates lead + optional contact + optional conversation.

**Body:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | yes | Lead title |
| contact | object | no | {firstName, lastName, email, phone, company} |
| value | number | no | Deal value (default: 0) |
| currency | string | no | Currency code |
| priority | string | no | low, medium, high, urgent (default: medium) |
| temperature | string | no | cold, warm, hot (default: cold) |
| sourceId | Id | no | Lead source ID |
| tags | string[] | no | Tags |
| customFields | object | no | Custom field values |
| message | string | no | Initial message (creates conversation) |
| channel | string | no | Channel for message (default: webchat) |

**Response:** \`{ success: true, leadId, contactId }\`

#### GET /api/v1/leads
List leads for the organization with cursor-based pagination.

**Query params:** boardId, stageId, assignedTo, limit, cursor (all optional)

**Response:** \`{ leads: [...], nextCursor, hasMore }\`

#### GET /api/v1/leads/get
Get a single lead.

**Query params:** id (required)

**Response:** \`{ lead: {...} }\`

#### POST /api/v1/leads/update
Update lead fields.

**Body:** leadId (required), title, value, priority, temperature, tags, customFields, sourceId

**Response:** \`{ success: true }\`

#### POST /api/v1/leads/delete
Delete a lead.

**Body:** leadId (required)

**Response:** \`{ success: true }\`

#### POST /api/v1/leads/move-stage
Move lead to a different pipeline stage.

**Body:** leadId (required), stageId (required)

**Response:** \`{ success: true }\`

#### POST /api/v1/leads/assign
Assign or unassign a lead.

**Body:** leadId (required), assignedTo (optional, omit to unassign)

**Response:** \`{ success: true }\`

#### POST /api/v1/leads/handoff
Request a handoff for a lead.

**Body:** leadId (required), reason (required), toMemberId, summary, suggestedActions

**Response:** \`{ success: true, handoffId }\`

### Contact Endpoints

#### GET /api/v1/contacts
List contacts for the organization with cursor-based pagination.

**Query params:** limit, cursor (all optional)

**Response:** \`{ contacts: [...], nextCursor, hasMore }\`

#### POST /api/v1/contacts/create
Create a new contact.

**Body:** firstName, lastName, email, phone, company, title, whatsappNumber, telegramUsername, tags, photoUrl, bio, linkedinUrl, instagramUrl, facebookUrl, twitterUrl, city, state, country, industry, companySize, cnpj, companyWebsite, preferredContactTime, deviceType, utmSource, acquisitionChannel, instagramFollowers, linkedinConnections, socialInfluenceScore, customFields

**Response:** \`{ success: true, contactId }\`

#### GET /api/v1/contacts/get
Get a single contact.

**Query params:** id (required)

**Response:** \`{ contact: {...} }\`

#### POST /api/v1/contacts/update
Update contact fields.

**Body:** contactId (required), plus any contact fields to update

**Response:** \`{ success: true }\`

#### POST /api/v1/contacts/enrich
Enrich a contact with data from an external source.

**Body:** contactId (required), fields (required, object with field values), source (required, string describing data source), confidence (optional, 0-1)

**Response:** \`{ success: true }\`

#### GET /api/v1/contacts/gaps
Get enrichment gaps for a contact (which fields are missing).

**Query params:** id (required)

**Response:** \`{ contact: { missingFields: [...], enrichmentMeta: {...} } }\`

### Conversation Endpoints

#### GET /api/v1/conversations
List conversations with cursor-based pagination.

**Query params:** leadId, limit, cursor (all optional)

**Response:** \`{ conversations: [...], nextCursor, hasMore }\`

#### GET /api/v1/conversations/messages
Get messages for a conversation.

**Query params:** conversationId (required)

**Response:** \`{ messages: [...] }\`

#### POST /api/v1/conversations/send
Send a message to a conversation.

**Body:** conversationId (required), content (required), contentType (default: text), isInternal (default: false), mentionedUserIds (optional)

**Response:** \`{ success: true, messageId }\`

### Handoff Endpoints

#### GET /api/v1/handoffs
List handoffs with cursor-based pagination.

**Query params:** status, limit, cursor (all optional)

**Response:** \`{ handoffs: [...], nextCursor, hasMore }\`

#### GET /api/v1/handoffs/pending
List pending handoffs (shortcut for status=pending).

**Response:** \`{ handoffs: [...] }\`

#### POST /api/v1/handoffs/accept
Accept a handoff.

**Body:** handoffId (required), notes (optional)

**Response:** \`{ success: true }\`

#### POST /api/v1/handoffs/reject
Reject a handoff.

**Body:** handoffId (required), notes (optional)

**Response:** \`{ success: true }\`

### Reference Endpoints

#### GET /api/v1/boards
List boards with their stages.

**Response:** \`{ boards: [{ ...board, stages: [...] }] }\`

#### GET /api/v1/team-members
List team members.

**Response:** \`{ members: [...] }\`

#### GET /api/v1/field-definitions
List custom field definitions.

**Response:** \`{ fields: [...] }\`

#### GET /api/v1/lead-sources
List lead sources for the organization.

**Response:** \`{ sources: [...] }\`

### Activity Endpoints

#### GET /api/v1/activities
Get the activity timeline for a lead with cursor-based pagination.

**Query params:** leadId (required), limit (optional, default 50, max 200), cursor (optional)

**Response:** \`{ activities: [...], nextCursor, hasMore }\`

#### POST /api/v1/activities
Create an activity on a lead.

**Body:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| leadId | Id | yes | Lead to log activity on |
| type | string | yes | note, call, email_sent |
| content | string | no | Activity description |
| metadata | object | no | Additional structured data |

**Response:** \`{ success: true, activityId }\`

### Task Endpoints

#### GET /api/v1/tasks
List tasks with optional filters and cursor-based pagination.

**Query params:** status, priority, assignedTo, leadId, contactId, type, activityType, dueBefore, dueAfter, limit, cursor (all optional)

**Response:** \`{ tasks: [...], nextCursor, hasMore }\`

#### GET /api/v1/tasks/get
Get a single task.

**Query params:** id (required)

**Response:** \`{ task: {...} }\`

#### GET /api/v1/tasks/my
Get the authenticated agent's pending and in-progress tasks.

**Response:** \`{ tasks: [...] }\`

#### GET /api/v1/tasks/overdue
List overdue tasks (due date in the past, status pending/in_progress).

**Query params:** limit, cursor (optional)

**Response:** \`{ tasks: [...], nextCursor, hasMore }\`

#### GET /api/v1/tasks/search
Search tasks by text (title, description).

**Query params:** q (required), limit (optional, default 50, max 100)

**Response:** \`{ tasks: [...] }\`

#### POST /api/v1/tasks/create
Create a new task or reminder.

**Body:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | yes | Task title |
| type | string | no | task, reminder (default: task) |
| priority | string | no | low, medium, high, urgent (default: medium) |
| activityType | string | no | todo, call, email, follow_up, meeting, research |
| description | string | no | Detailed description |
| dueDate | number | no | Due date (timestamp ms) |
| leadId | Id | no | Associated lead |
| contactId | Id | no | Associated contact |
| assignedTo | Id | no | Team member to assign |
| recurrence | object | no | {pattern, endDate?} |
| checklist | array | no | [{id, title, completed}] |
| tags | string[] | no | Tags |

**Response:** \`{ success: true, taskId }\`

#### POST /api/v1/tasks/update
Update task fields.

**Body:** taskId (required), title, description, priority, activityType, dueDate, tags

**Response:** \`{ success: true }\`

#### POST /api/v1/tasks/complete
Mark a task as completed.

**Body:** taskId (required)

**Response:** \`{ success: true }\`

#### POST /api/v1/tasks/delete
Delete a task.

**Body:** taskId (required)

**Response:** \`{ success: true }\`

#### POST /api/v1/tasks/assign
Assign or unassign a task.

**Body:** taskId (required), assignedTo (optional, omit to unassign)

**Response:** \`{ success: true }\`

#### POST /api/v1/tasks/snooze
Snooze a task until a future date.

**Body:** taskId (required), snoozedUntil (required, timestamp ms)

**Response:** \`{ success: true }\`

#### POST /api/v1/tasks/bulk
Bulk operations on multiple tasks.

**Body:** taskIds (required, array), action (required: complete, delete, assign), assignedTo (optional, for assign action)

**Response:** \`{ success: true }\`

#### GET /api/v1/tasks/comments
List comments on a task with cursor-based pagination.

**Query params:** taskId (required), limit (optional), cursor (optional)

**Response:** \`{ comments: [...], nextCursor, hasMore }\`

#### POST /api/v1/tasks/comments/add
Add a comment to a task.

**Body:** taskId (required), content (required), mentionedUserIds (optional)

**Response:** \`{ success: true, commentId }\`

### Calendar Endpoints

#### GET /api/v1/calendar/events
List calendar events in a date range with optional filters.

**Query params:** startDate (required), endDate (required), assignedTo, eventType, status, leadId, contactId, includeTasks (all optional)

**Response:** \`{ events: [...] }\`

#### GET /api/v1/calendar/events/get
Get a single calendar event.

**Query params:** id (required)

**Response:** \`{ event: {...} }\`

#### POST /api/v1/calendar/events/create
Create a new calendar event.

**Body:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | yes | Event title |
| eventType | string | yes | call, meeting, follow_up, demo, task, reminder, other |
| startTime | number | yes | Start timestamp (ms) |
| endTime | number | yes | End timestamp (ms) |
| allDay | boolean | no | All-day event |
| description | string | no | Description |
| leadId | Id | no | Associated lead |
| contactId | Id | no | Associated contact |
| assignedTo | Id | no | Assigned team member |
| attendees | Id[] | no | Attendee IDs |
| location | string | no | Location |
| meetingUrl | string | no | Meeting URL |
| recurrence | object | no | {pattern, endDate?} |
| notes | string | no | Notes |

**Response:** \`{ success: true, eventId }\`

#### POST /api/v1/calendar/events/update
Update calendar event fields.

**Body:** eventId (required), title, description, eventType, startTime, endTime, allDay, location, meetingUrl, notes (all optional)

**Response:** \`{ success: true }\`

#### POST /api/v1/calendar/events/delete
Delete a calendar event (cascades to child recurring events).

**Body:** eventId (required)

**Response:** \`{ success: true }\`

#### POST /api/v1/calendar/events/reschedule
Reschedule a calendar event.

**Body:** eventId (required), newStartTime (required), newEndTime (optional — auto-calculated from duration)

**Response:** \`{ success: true }\`

#### POST /api/v1/calendar/events/complete
Mark a calendar event as completed. If recurring, auto-generates next instance.

**Body:** eventId (required)

**Response:** \`{ success: true }\`

### File Storage Endpoints

#### POST /api/v1/files/upload-url
Generate a presigned upload URL for file storage.

**Response:** \`{ uploadUrl }\`

**Flow:**
1. Call this endpoint to get an upload URL
2. POST the file directly to the returned URL
3. Extract \`storageId\` from the response
4. Call POST /api/v1/files to save metadata

#### POST /api/v1/files
Save file metadata after uploading to storage.

**Body:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| storageId | string | yes | Storage ID from upload response |
| name | string | yes | File name |
| mimeType | string | yes | MIME type |
| size | number | yes | File size in bytes |
| fileType | string | yes | message_attachment, contact_photo, member_avatar, lead_document, import_file, other |
| messageId | Id | no | Link to message (for attachments) |
| contactId | Id | no | Link to contact (for photos) |
| leadId | Id | no | Link to lead (for documents) |
| metadata | object | no | Additional metadata |

**Allowed file types:**
- Images: jpeg, png, gif, webp (10MB max)
- Documents: pdf, doc, docx, xls, xlsx (20MB max)
- Text: txt, csv, json (10MB max)
- Audio: mp3, wav, ogg (10MB max)

**Quotas:**
- Free tier: 1GB total storage, 100 uploads/day
- Pro tier: 10GB total storage, 1000 uploads/day

**Response:** \`{ success: true, fileId }\`

#### GET /api/v1/files/:id/url
Get download URL for a file.

**Response:** \`{ url }\` (URL expires after a short time)

#### DELETE /api/v1/files/:id
Delete a file and its metadata.

**Response:** \`{ success: true }\`

### Dashboard Endpoint

#### GET /api/v1/dashboard
Get pipeline analytics and summary statistics for the organization.

**Response:** \`{ totalLeads, leadsByStage, leadsBySource, recentActivity, teamPerformance, ... }\`

### Search Endpoint

#### GET /api/v1/contacts/search
Search contacts by name, email, company, or other text fields.

**Query params:** q (required, search text), limit (optional, default 20, max 100)

**Response:** \`{ contacts: [...] }\`

### Audit Log Endpoint

#### GET /api/v1/audit-logs
Get audit logs with filtering and cursor-based pagination.

**Query params:** entityType, action, severity, actorId, startDate, endDate, cursor, limit (all optional)

**Response:** \`{ logs: [...], nextCursor, hasMore }\`

### Notification Preferences
- GET /api/v1/notifications/preferences — Get notification preferences for the authenticated API key's team member
- PUT /api/v1/notifications/preferences — Update notification preferences. Body: { invite?: boolean, handoffRequested?: boolean, ... }

### Webhooks (Inbound)
- POST /api/v1/webhooks/resend — Resend email delivery webhook (authenticated via RESEND_WEBHOOK_SECRET, not API key)

### Notification Event Types
| Event | Description |
|-------|-------------|
| invite | Team member invited to organization |
| handoffRequested | AI-to-human handoff requested |
| handoffResolved | Handoff accepted or rejected |
| taskOverdue | Assigned task is overdue |
| taskAssigned | Task assigned to member |
| leadAssigned | Lead assigned to member |
| newMessage | New inbound message on assigned lead |
| dailyDigest | Daily summary of CRM activity |

---

## Agent Skill

HNBCRM ships an open-standard Agent Skill at \`.claude/skills/hnbcrm/\` that teaches any AI agent to operate as a CRM team member — managing leads, enriching contacts, handling conversations, and executing handoffs.

### Skill Files
- **SKILL.md** — Main skill: role definition, bootstrap sequence, core workflows, best practices
- **references/WORKFLOWS.md** — Step-by-step playbooks for lead intake, qualification, pipeline advancement, contact enrichment, handoff execution, conversation management
- **references/API_REFERENCE.md** — Complete MCP tool ↔ REST endpoint mapping with parameters and response formats
- **references/DATA_MODEL.md** — All entity tables, fields, and enum values
- **references/SETUP.md** — Platform-specific MCP configuration (Claude Code/Desktop, Cursor, VS Code, Gemini CLI, OpenClaw)

### Getting Started
1. Install the MCP server: \`npx hnbcrm-mcp\` (set HNBCRM_API_URL and HNBCRM_API_KEY env vars)
2. Copy the skill: \`cp -r .claude/skills/hnbcrm/ ~/.your-agent/skills/hnbcrm/\`
3. The agent reads SKILL.md and bootstraps by calling \`crm_list_team\` and \`crm_list_boards\`

---

## MCP Server Tools

The HNBCRM MCP server (\`npx hnbcrm-mcp\`) exposes 46 tools for AI agents:

### Lead Management

#### crm_list_leads
List leads with optional filters.
- **boardId** (string, optional): Filter by board
- **stageId** (string, optional): Filter by stage
- **assignedTo** (string, optional): Filter by assigned team member

#### crm_get_lead
Get a single lead by ID.
- **leadId** (string, required): The lead ID

#### crm_create_lead
Create a new lead via inbound endpoint.
- **title** (string, required): Lead title
- **contact** (object, optional): Contact info {firstName, lastName, email, phone, company}
- **value** (number, optional): Deal value
- **priority** (string, optional): low, medium, high, urgent
- **temperature** (string, optional): cold, warm, hot
- **tags** (string[], optional): Tags
- **customFields** (object, optional): Custom field values
- **message** (string, optional): Initial message
- **channel** (string, optional): Message channel

#### crm_update_lead
Update lead fields.
- **leadId** (string, required): The lead ID
- **title, value, priority, temperature, tags, customFields, sourceId** (optional)

#### crm_delete_lead
Delete a lead.
- **leadId** (string, required): The lead ID

#### crm_move_lead
Move a lead to a different pipeline stage.
- **leadId** (string, required): The lead ID
- **stageId** (string, required): Target stage ID

#### crm_assign_lead
Assign or unassign a lead.
- **leadId** (string, required): The lead ID
- **assignedTo** (string, optional): Team member ID (omit to unassign)

### Contact Management

#### crm_list_contacts
List all contacts in the organization.

#### crm_get_contact
Get a single contact by ID.
- **contactId** (string, required): The contact ID

#### crm_create_contact
Create a new contact.
- **firstName, lastName, email, phone, company, title** and all enrichment fields (optional)

#### crm_update_contact
Update contact fields.
- **contactId** (string, required): The contact ID
- Plus any contact fields to update

#### crm_enrich_contact
Add enrichment data to a contact from an external source.
- **contactId** (string, required): The contact ID
- **fields** (object, required): Field values to enrich
- **source** (string, required): Data source name
- **confidence** (number, optional): Confidence score 0-1

#### crm_get_contact_gaps
Identify missing/enrichable fields on a contact.
- **contactId** (string, required): The contact ID

#### crm_search_contacts
Search contacts by name, email, company, or other text fields.
- **query** (string, required): Search text
- **limit** (number, optional): Max results (default 20, max 100)

### Conversations

#### crm_list_conversations
List conversations, optionally filtered by lead.
- **leadId** (string, optional): Filter by lead

#### crm_get_messages
Get messages for a conversation.
- **conversationId** (string, required): The conversation ID

#### crm_send_message
Send a message to a conversation.
- **conversationId** (string, required): The conversation ID
- **content** (string, required): Message content
- **contentType** (string, optional): text, image, file, audio
- **isInternal** (boolean, optional): Mark as internal note

### Handoffs

#### crm_request_handoff
Request a handoff for a lead.
- **leadId** (string, required): The lead ID
- **reason** (string, required): Why the handoff is needed
- **toMemberId** (string, optional): Target team member
- **summary** (string, optional): Conversation summary
- **suggestedActions** (string[], optional): Recommended next steps

#### crm_list_handoffs
List handoff requests, optionally filtered by status.
- **status** (string, optional): Filter by status (pending, accepted, rejected)

#### crm_accept_handoff
Accept a pending handoff request.
- **handoffId** (string, required): The handoff ID
- **notes** (string, optional): Notes about accepting

#### crm_reject_handoff
Reject a pending handoff request.
- **handoffId** (string, required): The handoff ID
- **notes** (string, optional): Reason for rejection

### Pipeline & Reference Data

#### crm_list_boards
List all pipeline boards with their stages.

#### crm_list_team
List all team members in the organization.

#### crm_get_dashboard
Get pipeline analytics and summary statistics.

### Activities

#### crm_get_activities
Get the activity timeline for a lead.
- **leadId** (string, required): The lead ID
- **limit** (number, optional): Max results (default 50, max 200)

#### crm_create_activity
Log an activity on a lead (note, call, or email).
- **leadId** (string, required): The lead ID
- **type** (string, required): note, call, email_sent
- **content** (string, optional): Activity description
- **metadata** (object, optional): Additional structured data

### Tasks

#### crm_list_tasks
List tasks with optional filters.
- **status** (string, optional): Filter by status (pending, in_progress, completed, cancelled)
- **priority** (string, optional): Filter by priority
- **assignedTo** (string, optional): Filter by assigned team member
- **leadId** (string, optional): Filter by lead
- **contactId** (string, optional): Filter by contact
- **type** (string, optional): Filter by type (task, reminder)
- **activityType** (string, optional): Filter by CRM activity type
- **dueBefore** (number, optional): Due before timestamp
- **dueAfter** (number, optional): Due after timestamp

#### crm_get_task
Get a single task by ID.
- **taskId** (string, required): The task ID

#### crm_get_my_tasks
Get the authenticated agent's pending and in-progress tasks.

#### crm_get_overdue_tasks
List overdue tasks (past due date, not completed).

#### crm_search_tasks
Search tasks by text.
- **query** (string, required): Search text
- **limit** (number, optional): Max results (default 50)

#### crm_create_task
Create a new task or reminder.
- **title** (string, required): Task title
- **type** (string, optional): task, reminder
- **priority** (string, optional): low, medium, high, urgent
- **activityType** (string, optional): todo, call, email, follow_up, meeting, research
- **description** (string, optional): Detailed description
- **dueDate** (number, optional): Due date timestamp
- **leadId** (string, optional): Associated lead
- **contactId** (string, optional): Associated contact
- **assignedTo** (string, optional): Team member to assign
- **checklist** (array, optional): [{id, title, completed}]
- **tags** (string[], optional): Tags

#### crm_update_task
Update task fields.
- **taskId** (string, required): The task ID
- **title, description, priority, activityType, dueDate, tags** (optional)

#### crm_complete_task
Mark a task as completed.
- **taskId** (string, required): The task ID

#### crm_delete_task
Delete a task.
- **taskId** (string, required): The task ID

#### crm_assign_task
Assign or unassign a task.
- **taskId** (string, required): The task ID
- **assignedTo** (string, optional): Team member ID (omit to unassign)

#### crm_snooze_task
Snooze a task until a future date.
- **taskId** (string, required): The task ID
- **snoozedUntil** (number, required): Timestamp to snooze until

#### crm_bulk_task_update
Bulk operations on multiple tasks.
- **taskIds** (string[], required): Task IDs
- **action** (string, required): complete, delete, assign

#### crm_list_task_comments
List comments on a task.
- **taskId** (string, required): The task ID

#### crm_add_task_comment
Add a comment to a task.
- **taskId** (string, required): The task ID
- **content** (string, required): Comment content
- **mentionedUserIds** (string[], optional): Mentioned team member IDs

### Calendar

#### calendar_list_events
List calendar events in a date range with optional filters.
- **startDate** (number, required): Start of date range (timestamp ms)
- **endDate** (number, required): End of date range (timestamp ms)
- **assignedTo** (string, optional): Filter by assigned team member
- **eventType** (string, optional): Filter by event type
- **status** (string, optional): Filter by status
- **leadId** (string, optional): Filter by lead
- **contactId** (string, optional): Filter by contact
- **includeTasks** (boolean, optional): Include tasks with dueDate in range

#### calendar_create_event
Create a new calendar event.
- **title** (string, required): Event title
- **eventType** (string, required): call, meeting, follow_up, demo, task, reminder, other
- **startTime** (number, required): Start timestamp (ms)
- **endTime** (number, required): End timestamp (ms)
- **allDay** (boolean, optional): All-day event
- **description, leadId, contactId, assignedTo, attendees, location, meetingUrl, recurrence, notes** (optional)

#### calendar_get_event
Get a single calendar event by ID.
- **eventId** (string, required): The event ID

#### calendar_update_event
Update calendar event fields.
- **eventId** (string, required): The event ID
- **title, description, eventType, startTime, endTime, allDay, location, meetingUrl, notes** (optional)

#### calendar_delete_event
Delete a calendar event (cascades to recurring children).
- **eventId** (string, required): The event ID

#### calendar_reschedule_event
Reschedule a calendar event to a new time.
- **eventId** (string, required): The event ID
- **newStartTime** (number, required): New start timestamp (ms)
- **newEndTime** (number, optional): New end timestamp (auto-calculated if omitted)

---

## Webhook Events

Webhooks can be configured per organization. Events are triggered after mutations.

| Event | Description |
|-------|-------------|
| lead.created | New lead created |
| lead.updated | Lead fields updated |
| lead.deleted | Lead deleted |
| lead.stage_changed | Lead moved to different stage |
| lead.assigned | Lead assigned or unassigned |
| contact.created | New contact created |
| contact.updated | Contact fields updated |
| conversation.created | New conversation started |
| message.sent | Message sent to conversation |
| handoff.requested | Handoff requested |
| handoff.accepted | Handoff accepted |
| handoff.rejected | Handoff rejected |

Webhook payloads include \`{ event, organizationId, payload, timestamp }\`. Each webhook has a secret for HMAC signature verification.

---

## Enum Reference

### Priority
\`low\` | \`medium\` | \`high\` | \`urgent\`

### Temperature
\`cold\` | \`warm\` | \`hot\`

### Conversation Status
\`new\` | \`active\` | \`waiting\` | \`closed\`

### Conversation Channel
\`whatsapp\` | \`telegram\` | \`email\` | \`webchat\` | \`internal\`

### Message Direction
\`inbound\` | \`outbound\` | \`internal\`

### Message Content Type
\`text\` | \`image\` | \`file\` | \`audio\`

### Sender Type
\`contact\` | \`human\` | \`ai\`

### Handoff Status
\`pending\` | \`accepted\` | \`rejected\`

### Team Member Role
\`admin\` | \`manager\` | \`agent\` | \`ai\`

### Team Member Type
\`human\` | \`ai\`

### Team Member Status
\`active\` | \`inactive\` | \`busy\`

### Permission Category
\`leads\` | \`contacts\` | \`inbox\` | \`tasks\` | \`reports\` | \`team\` | \`settings\` | \`auditLogs\` | \`apiKeys\`

### Lead Source Type
\`website\` | \`social\` | \`email\` | \`phone\` | \`referral\` | \`api\` | \`other\`

### Custom Field Type
\`text\` | \`number\` | \`boolean\` | \`date\` | \`select\` | \`multiselect\`

### Task Type
\`task\` | \`reminder\`

### Task Status
\`pending\` | \`in_progress\` | \`completed\` | \`cancelled\`

### Task Activity Type
\`todo\` | \`call\` | \`email\` | \`follow_up\` | \`meeting\` | \`research\`

### Recurrence Pattern
\`daily\` | \`weekly\` | \`biweekly\` | \`monthly\`

### Activity Type
\`note\` | \`call\` | \`email_sent\` | \`stage_change\` | \`assignment\` | \`handoff\` | \`qualification_update\` | \`created\` | \`message_sent\` | \`event_created\` | \`event_completed\`

### Calendar Event Type
\`call\` | \`meeting\` | \`follow_up\` | \`demo\` | \`task\` | \`reminder\` | \`other\`

### Calendar Event Status
\`scheduled\` | \`completed\` | \`cancelled\`

### Audit Log Action
\`create\` | \`update\` | \`delete\` | \`move\` | \`assign\` | \`handoff\`

### Audit Log Severity
\`low\` | \`medium\` | \`high\` | \`critical\`

### File Type
\`message_attachment\` | \`contact_photo\` | \`member_avatar\` | \`lead_document\` | \`import_file\` | \`other\`

### Lead Document Category
\`contract\` | \`proposal\` | \`invoice\` | \`other\`
`;
