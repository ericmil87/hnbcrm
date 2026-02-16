// llms.txt and llms-full.txt content for LLM-readable documentation
// See https://llmstxt.org/

export const LLMS_TXT = `# HNBCRM

> CRM where humans and AI agents are equal team members.

HNBCRM is an open-source, multi-tenant CRM built on Convex with real-time collaboration between human sales reps and AI agents. It features a kanban pipeline, multi-channel conversations, AI-to-human handoffs, and contact enrichment.

## Documentation

- [Full API Reference](/llms-full.txt): Complete REST API, MCP tools, data model, and enum reference

## Quick Links

- REST API: /api/v1/* endpoints authenticated via X-API-Key header
- MCP Server: npx hnbcrm-mcp (26 tools for AI agents)
- Agent Skill: .claude/skills/hnbcrm/ — portable skill that teaches AI agents how to operate as CRM team members
- Channels: whatsapp, telegram, email, webchat, internal
- Auth: API key passed in X-API-Key header (SHA-256 hashed, stored per team member)

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

The HNBCRM MCP server (\`npx hnbcrm-mcp\`) exposes 26 tools for AI agents:

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

### Lead Source Type
\`website\` | \`social\` | \`email\` | \`phone\` | \`referral\` | \`api\` | \`other\`

### Custom Field Type
\`text\` | \`number\` | \`boolean\` | \`date\` | \`select\` | \`multiselect\`

### Activity Type
\`note\` | \`call\` | \`email_sent\` | \`stage_change\` | \`assignment\` | \`handoff\` | \`qualification_update\` | \`created\` | \`message_sent\`

### Audit Log Action
\`create\` | \`update\` | \`delete\` | \`move\` | \`assign\` | \`handoff\`

### Audit Log Severity
\`low\` | \`medium\` | \`high\` | \`critical\`
`;
