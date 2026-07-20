# HNBCRM Data Model

Complete reference for tables, fields, and enum values.

---

## Entity Tables

### Lead

The core sales entity tracked through a pipeline.

| Field | Type | Description |
|-------|------|-------------|
| title | string | Lead title (required) |
| contactId | Id\<contacts\> | Associated contact |
| boardId | Id\<boards\> | Pipeline board |
| stageId | Id\<stages\> | Current stage in pipeline |
| assignedTo | Id\<teamMembers\> | Assigned team member (human or AI) |
| value | number | Monetary value |
| currency | string | Currency code (default: BRL) |
| priority | enum | `low`, `medium`, `high`, `urgent` |
| temperature | enum | `cold`, `warm`, `hot` |
| sourceId | Id\<leadSources\> | Origin source |
| tags | string[] | Tags for categorization |
| customFields | Record\<string, any\> | User-defined fields |
| qualification | object | BANT scoring (see below) |
| conversationStatus | enum | `new`, `active`, `waiting`, `closed` |
| handoffState | object | Current handoff status if any |
| closedAt | number | Timestamp if closed |
| closedType | enum | `won`, `lost` |
| lastActivityAt | number | Timestamp of last activity |

**Qualification object:**
| Field | Type | Description |
|-------|------|-------------|
| budget | boolean | Can afford the solution |
| authority | boolean | Is the decision-maker |
| need | boolean | Has a clear pain point |
| timeline | boolean | Has urgency to buy |
| score | number | Count of true values (0-4) |

---

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
| linkedinUrl | string | LinkedIn profile |
| instagramUrl | string | Instagram profile |
| facebookUrl | string | Facebook profile |
| twitterUrl | string | Twitter/X profile |
| city, state, country | string | Location |
| industry | string | Industry |
| companySize | string | Company size category |
| cnpj | string | Brazilian company ID |
| companyWebsite | string | Company website |
| preferredContactTime | enum | `morning`, `afternoon`, `evening` |
| deviceType | enum | `android`, `iphone`, `desktop`, `unknown` |
| utmSource | string | UTM source |
| acquisitionChannel | string | How they were acquired |
| instagramFollowers | number | Instagram follower count |
| linkedinConnections | number | LinkedIn connections |
| socialInfluenceScore | number | Influence score (0-100) |
| customFields | Record\<string, any\> | User-defined fields |
| enrichmentMeta | Record\<string, object\> | Provenance tracking (see below) |
| enrichmentExtra | Record\<string, any\> | Overflow for AI-discovered data |

**enrichmentMeta value:**
| Field | Type | Description |
|-------|------|-------------|
| source | string | Where the data came from |
| updatedAt | number | When it was last enriched |
| confidence | number | Confidence score (0.0-1.0) |

---

### Board (Pipeline)

A kanban board containing stages.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Board name |
| description | string | Description |
| color | string | Display color |
| isDefault | boolean | Default board for new leads |
| order | number | Display order |

---

### Stage

A column within a board.

| Field | Type | Description |
|-------|------|-------------|
| boardId | Id\<boards\> | Parent board |
| name | string | Stage name |
| color | string | Display color |
| order | number | Display order |
| isClosedWon | boolean | Marks as won stage (terminal) |
| isClosedLost | boolean | Marks as lost stage (terminal) |

---

### Conversation

A message thread on a lead, scoped by channel.

| Field | Type | Description |
|-------|------|-------------|
| leadId | Id\<leads\> | Associated lead |
| channel | enum | `whatsapp`, `telegram`, `email`, `webchat`, `internal` |
| status | enum | `active`, `closed` |
| messageCount | number | Total messages |
| lastMessageAt | number | Timestamp of last message |

---

### Message

An individual message in a conversation.

| Field | Type | Description |
|-------|------|-------------|
| conversationId | Id\<conversations\> | Parent conversation |
| leadId | Id\<leads\> | Associated lead |
| direction | enum | `inbound`, `outbound`, `internal` |
| senderId | Id\<teamMembers\> | Sender (null for contact inbound) |
| senderType | enum | `contact`, `human`, `ai` |
| content | string | Message text |
| contentType | enum | `text`, `image`, `file`, `audio` |
| isInternal | boolean | Internal note (not visible to contact) |
| mentionedUserIds | Id\<teamMembers\>[] | @mentioned team members |

---

### Handoff

An AI-to-human (or human-to-human) handoff request.

| Field | Type | Description |
|-------|------|-------------|
| leadId | Id\<leads\> | Lead being handed off |
| fromMemberId | Id\<teamMembers\> | Requester |
| toMemberId | Id\<teamMembers\> | Target (optional, any human if null) |
| reason | string | Why the handoff is needed |
| summary | string | Conversation summary |
| suggestedActions | string[] | Recommended next steps |
| status | enum | `pending`, `accepted`, `rejected` |
| notes | string | Resolution notes |

---

### Team Member

A human or AI agent on the team.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Display name |
| email | string | Email (humans) |
| role | enum | `admin`, `manager`, `agent`, `ai` |
| type | enum | `human`, `ai` |
| status | enum | `active`, `inactive`, `busy` |
| capabilities | string[] | What this member can do |
| permissions | object | Granular RBAC overrides (9 categories — see Permissions below). If null, role defaults apply |
| mustChangePassword | boolean | Forces password change on next login (set for new invited users) |
| invitedBy | Id\<teamMembers\> | Who invited this member |
| userId | Id\<users\> | Linked auth user (set on signup or invite) |

**Permissions object (9 categories):**
| Category | Possible Levels |
|----------|----------------|
| leads | `none`, `view_own`, `view_all`, `edit_own`, `edit_all`, `full` |
| contacts | `none`, `view`, `edit`, `full` |
| inbox | `none`, `view_own`, `view_all`, `reply`, `full` |
| tasks | `none`, `view_own`, `view_all`, `edit_own`, `edit_all`, `full` |
| reports | `none`, `view`, `full` |
| team | `none`, `view`, `manage` |
| settings | `none`, `view`, `manage` |
| auditLogs | `none`, `view` |
| apiKeys | `none`, `view`, `manage` |

Levels are hierarchical within each category. Roles have default permissions: admin (full everything), manager (edit_all leads/tasks, full inbox), agent (edit_own leads/tasks, reply inbox), ai (same as agent). Explicit `permissions` overrides role defaults.

---

### Calendar Event

A time-ranged event on the calendar, optionally linked to leads and contacts.

| Field | Type | Description |
|-------|------|-------------|
| title | string | Event title (required) |
| description | string | Detailed description |
| eventType | enum | `call`, `meeting`, `follow_up`, `demo`, `task`, `reminder`, `other` |
| startTime | number | Start timestamp (Unix ms) |
| endTime | number | End timestamp (Unix ms) |
| allDay | boolean | Whether this is an all-day event |
| status | enum | `scheduled`, `completed`, `cancelled` |
| leadId | Id\<leads\> | Associated lead (optional) |
| contactId | Id\<contacts\> | Associated contact (optional) |
| taskId | Id\<tasks\> | Linked task (optional) |
| attendees | Id\<teamMembers\>[] | Event attendees |
| createdBy | Id\<teamMembers\> | Creator |
| assignedTo | Id\<teamMembers\> | Assigned team member |
| location | string | Meeting location |
| meetingUrl | string | Video conference URL |
| color | string | Custom color override |
| recurrence | object | Recurrence config (see below) |
| parentEventId | Id\<calendarEvents\> | Parent event (for recurring instances) |
| notes | string | Additional notes |

**Recurrence object:**
| Field | Type | Description |
|-------|------|-------------|
| pattern | enum | `daily`, `weekly`, `biweekly`, `monthly` |
| endDate | number | Optional end date for recurrence |

---

### Activity

A timeline event on a lead.

| Field | Type | Description |
|-------|------|-------------|
| leadId | Id\<leads\> | Associated lead |
| type | enum | `note`, `call`, `email_sent`, `stage_change`, `assignment`, `handoff`, `qualification_update`, `created`, `message_sent` |
| actorId | Id\<teamMembers\> | Who performed the action |
| actorType | enum | `human`, `ai`, `system` |
| content | string | Activity description |
| metadata | Record\<string, any\> | Additional structured data |

---

### Field Definition (Custom Fields)

Schema for user-defined custom fields.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Display name |
| key | string | Unique key for storage |
| type | enum | `text`, `number`, `boolean`, `date`, `select`, `multiselect` |
| entityType | enum | `lead`, `contact` (null = both) |
| options | string[] | Options for select/multiselect types |
| isRequired | boolean | Whether the field is required |
| order | number | Display order |

---

### Lead Source

Where leads come from.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Source name |
| type | enum | `website`, `social`, `email`, `phone`, `referral`, `api`, `other` |
| isActive | boolean | Whether currently active |

---

### Audit Log

Change tracking for compliance and debugging.

| Field | Type | Description |
|-------|------|-------------|
| entityType | string | Table name (e.g. "leads", "contacts") |
| entityId | string | Entity ID |
| action | enum | `create`, `update`, `delete`, `move`, `assign`, `handoff` |
| actorId | Id\<teamMembers\> | Who performed the action |
| actorType | enum | `human`, `ai`, `system` |
| changes | object | `{ before: {...}, after: {...} }` |
| description | string | Human-readable description |
| severity | enum | `low`, `medium`, `high`, `critical` |

---

### API Key

Authentication key for REST API and MCP access, tied to a team member.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Key display name |
| teamMemberId | Id\<teamMembers\> | Associated team member |
| keyHash | string | SHA-256 hash of the key (never store plaintext) |
| isActive | boolean | Whether the key is currently valid |
| permissions | object | Optional permission overrides (same structure as Team Member permissions). If null, inherits from team member |
| expiresAt | number | Optional expiration timestamp. Expired keys are rejected |
| lastUsed | number | Timestamp of last successful use |
| createdAt | number | Creation timestamp |

---

### Notification Preferences

Per-member email notification preferences. Opt-out model — when no record exists, all notifications are enabled.

| Field | Type | Description |
|-------|------|-------------|
| organizationId | Id\<organizations\> | Organization |
| teamMemberId | Id\<teamMembers\> | Team member |
| invite | boolean | Receive invite notifications |
| handoffRequested | boolean | Receive handoff request notifications |
| handoffResolved | boolean | Receive handoff resolved notifications |
| taskOverdue | boolean | Receive task overdue notifications |
| taskAssigned | boolean | Receive task assigned notifications |
| leadAssigned | boolean | Receive lead assigned notifications |
| newMessage | boolean | Receive new message notifications |
| dailyDigest | boolean | Receive daily digest emails |

---

### Form

An embeddable form that creates leads/contacts on submission.

| Field | Type | Description |
|-------|------|-------------|
| name | string | Form name |
| slug | string | URL-friendly slug (globally unique) |
| description | string | Optional description |
| status | enum | `draft`, `published`, `archived` |
| publishedAt | number | Timestamp when published |
| fields | array | Embedded field definitions (see below) |
| theme | object | Visual theme config |
| settings | object | Lead creation and assignment settings |
| createdBy | Id\<teamMembers\> | Form creator |
| submissionCount | number | Total submissions received |
| lastSubmissionAt | number | Timestamp of last submission |

**Form field definition:**
| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique field identifier |
| type | enum | `text`, `email`, `phone`, `number`, `select`, `textarea`, `checkbox`, `date` |
| label | string | Display label |
| placeholder | string | Placeholder text |
| helpText | string | Help text below the field |
| isRequired | boolean | Whether the field is required |
| validation | object | `{ minLength?, maxLength?, min?, max?, pattern? }` |
| options | string[] | Options for select type |
| defaultValue | string | Default value |
| width | enum | `full`, `half` |
| crmMapping | object | `{ entity: "lead" \| "contact", field: string }` |

**Theme object:**
| Field | Type | Description |
|-------|------|-------------|
| primaryColor | string | Primary accent color (hex) |
| backgroundColor | string | Form background color |
| textColor | string | Text color |
| borderRadius | enum | `none`, `sm`, `md`, `lg`, `full` |
| showBranding | boolean | Show HNBCRM branding |

**Settings object:**
| Field | Type | Description |
|-------|------|-------------|
| submitButtonText | string | Submit button label |
| successMessage | string | Message shown after submission |
| redirectUrl | string | Optional redirect after submission |
| leadTitle | string | Template for lead title (`{email}`, `{name}`, `{firstName}`, etc.) |
| boardId | Id\<boards\> | Target pipeline board (optional, defaults to org default) |
| stageId | Id\<stages\> | Target stage (optional, defaults to first stage) |
| sourceId | Id\<leadSources\> | Lead source (optional) |
| assignmentMode | enum | `none`, `specific`, `round_robin` |
| assignedTo | Id\<teamMembers\> | Fixed assignee (when mode=specific) |
| defaultPriority | enum | `low`, `medium`, `high`, `urgent` |
| defaultTemperature | enum | `cold`, `warm`, `hot` |
| tags | string[] | Tags applied to created leads |
| honeypotEnabled | boolean | Enable honeypot spam protection |
| submissionLimit | number | Max submissions allowed (optional) |
| notifyOnSubmission | boolean | Send email on new submissions |
| notifyMemberIds | Id\<teamMembers\>[] | Members to notify |

---

### Form Submission

A submission from a public form.

| Field | Type | Description |
|-------|------|-------------|
| formId | Id\<forms\> | Parent form |
| data | Record\<string, any\> | Submitted field values (keyed by field ID) |
| leadId | Id\<leads\> | Created lead (if processed) |
| contactId | Id\<contacts\> | Created/matched contact (if processed) |
| ipAddress | string | Submitter IP address |
| userAgent | string | Browser user agent |
| referrer | string | Referrer URL |
| utmSource | string | UTM source parameter |
| utmMedium | string | UTM medium parameter |
| utmCampaign | string | UTM campaign parameter |
| honeypotTriggered | boolean | Whether the honeypot was triggered |
| processingStatus | enum | `processed`, `spam`, `error` |
| errorMessage | string | Error details (when status=error) |

---

## Complete Enum Reference

| Enum | Values |
|------|--------|
| Priority | `low`, `medium`, `high`, `urgent` |
| Temperature | `cold`, `warm`, `hot` |
| Conversation Status | `new`, `active`, `waiting`, `closed` |
| Channel | `whatsapp`, `telegram`, `email`, `webchat`, `internal` |
| Message Direction | `inbound`, `outbound`, `internal` |
| Content Type | `text`, `image`, `file`, `audio` |
| Sender Type | `contact`, `human`, `ai` |
| Handoff Status | `pending`, `accepted`, `rejected` |
| Team Member Role | `admin`, `manager`, `agent`, `ai` |
| Team Member Type | `human`, `ai` |
| Team Member Status | `active`, `inactive`, `busy` |
| Lead Source Type | `website`, `social`, `email`, `phone`, `referral`, `api`, `other` |
| Custom Field Type | `text`, `number`, `boolean`, `date`, `select`, `multiselect` |
| Activity Type | `note`, `call`, `email_sent`, `stage_change`, `assignment`, `handoff`, `qualification_update`, `created`, `message_sent`, `event_created`, `event_completed` |
| Calendar Event Type | `call`, `meeting`, `follow_up`, `demo`, `task`, `reminder`, `other` |
| Calendar Event Status | `scheduled`, `completed`, `cancelled` |
| Notification Event Type | `invite`, `handoffRequested`, `handoffResolved`, `taskOverdue`, `taskAssigned`, `leadAssigned`, `newMessage`, `dailyDigest` |
| Audit Action | `create`, `update`, `delete`, `move`, `assign`, `handoff` |
| Audit Severity | `low`, `medium`, `high`, `critical` |
| Form Status | `draft`, `published`, `archived` |
| Form Field Type | `text`, `email`, `phone`, `number`, `select`, `textarea`, `checkbox`, `date` |
| Form Field Width | `full`, `half` |
| Form Border Radius | `none`, `sm`, `md`, `lg`, `full` |
| Form Assignment Mode | `none`, `specific`, `round_robin` |
| Form Submission Status | `processed`, `spam`, `error` |
| Preferred Contact Time | `morning`, `afternoon`, `evening` |
| Device Type | `android`, `iphone`, `desktop`, `unknown` |
