# HNBCRM API Reference

Complete mapping of MCP tools to REST API endpoints.

All REST endpoints are at `/api/v1/*` and require an `X-API-Key` header. MCP tools handle authentication automatically via environment variables.

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

Members have `type: "human" | "ai"` and `role: "admin" | "manager" | "agent" | "ai"`.

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

## Pending Handoffs Shortcut

**REST only:** `GET /api/v1/handoffs/pending`

Shortcut for `GET /api/v1/handoffs?status=pending`.

**Response:** `{ handoffs: [...] }`
