# ClawCRM

A multi-tenant CRM where humans and AI agents are equal team members. They collaborate on leads, share conversations, and hand off work to each other seamlessly.

## Core Concepts

**Organizations** have team members. A team member is either a human (logs in normally) or an AI agent (authenticates via API key). Both can own leads, send messages, and move leads through pipeline stages.

**Boards** are pipelines with ordered stages (e.g. New → Contacted → Qualified → Proposal → Won/Lost). An org can have multiple boards.

**Leads** live in a board, sit in a stage, and can be assigned to any team member. Each lead has: title, contact info (name, email, phone), value, priority (low/medium/high/urgent), temperature (cold/warm/hot), source, tags, and a flexible custom fields JSON object.

**Conversations** are the heart. Each lead has conversations — one per channel (whatsapp, telegram, email, webchat, etc). A conversation contains messages with: direction (inbound/outbound/internal), sender info, content, attachments, and delivery status. Internal messages are team-only notes.

**Handoffs** let an AI agent pass a lead to a human (or vice-versa) with a reason, summary, and suggested actions. There's a handoff queue humans can monitor.

## What to Build (MVP)

### Data Model

Tables needed:

- **users** — human accounts (name, email)
- **organizations** — tenants (name, slug, settings)
- **teamMembers** — unified identity for humans AND AI agents within an org. Fields: orgId, type (human/ai_agent), name, role (owner/admin/member/agent/viewer), status (active/inactive/away), capabilities list, AI config (provider, model, system prompt, channels). Link to user if human.
- **apiKeys** — for AI agent auth. Linked to a teamMember. Hashed key, permissions array, expiration.
- **boards** — pipelines per org (name, settings with auto-assign strategy)
- **stages** — ordered columns per board (name, color, sortOrder, type: active/won/lost)
- **leads** — the main entity (orgId, boardId, stageId, title, contact fields, value, priority, temperature, source, tags, assignedTo → teamMember, customFields, conversationStatus, handoffPending, qualificationData with BANT fields)
- **conversations** — per lead per channel (orgId, leadId, channel, externalId, status, participants list)
- **messages** — individual messages (orgId, conversationId, leadId, direction, channel, senderType, senderId, content, contentType, attachments, deliveryStatus, metadata). For AI-sent messages include aiContext (model, confidence, reasoning).
- **activities** — event log per lead (type: note/call/stage_change/assignment/handoff/etc, actorType, content)
- **contacts** — org-wide contact directory (name, email, phone, company, social profiles, tags, customFields)
- **auditLogs** — immutable append-only log of EVERY write operation. Fields: orgId, timestamp, actorId, actorType (human/ai_agent/system/api), actorName, action (machine-readable like "lead.created", "lead.stage_changed", "message.sent"), category, resourceType, resourceId, description (human-readable), changes array (field/oldValue/newValue diffs), severity (info/warning/critical). **No update or delete mutations for this table — append only.**
- **fieldDefinitions** — custom field schemas per org (entity, key, label, type, options)
- **leadSources** — configurable sources per org (name, key, channel)
- **webhooks** — outbound webhook registrations (url, events, secret)

Every table that belongs to an org must be indexed on orgId first. Leads need a search index on title.

### Auth

Two auth paths:
1. Human users log in normally and select their org
2. AI agents authenticate via API key header (`X-API-Key`) — each key maps to a teamMember record

### Backend Functions

**Core CRUD** for: organizations, teamMembers, boards, stages, leads, contacts, conversations, messages, fieldDefinitions, leadSources, apiKeys, webhooks.

**Lead-specific mutations:**
- Move lead to stage (updates stageId + writes audit log + activity)
- Assign lead to team member
- Qualify lead (update BANT data)
- Quick-create lead from inbound data (auto-link contact by email/phone, auto-assign if configured)

**Message mutations:**
- Send message (creates message, updates conversation lastMessageAt and lead lastMessageAt)
- Add internal note (message with direction "internal", not visible to lead)

**Handoff mutations:**
- Request handoff (AI→human or human→AI) with reason, summary, suggested actions
- Accept/reject handoff

**Audit rule:** Every mutation that writes data must also insert an auditLogs entry in the same transaction. Use a shared helper for this.

### HTTP API

REST endpoints exposed via HTTP actions for external access (AI agents, chatbots, webhooks):

- `POST /api/v1/inbound/lead` — Universal lead capture. Accepts: title, contactName, contactEmail, contactPhone, source, value, tags, customFields, initialMessage. Auto-creates contact if new, auto-assigns if configured. This is the most important endpoint.
- CRUD endpoints for leads, contacts, messages, conversations
- `POST /api/v1/leads/:id/handoff` — request handoff
- `GET /api/v1/handoffs` — pending handoffs
- All endpoints auth via API key header, all actions attributed to the linked teamMember

### Frontend (MVP pages)

1. **Login/Register** page
2. **Org switcher** in sidebar
3. **Kanban board** — drag-and-drop leads between stage columns. Lead cards show: title, contact name, value, temperature badge, assignee avatar with human/AI indicator
4. **Lead detail panel** (slide-over) with 3 tabs:
   - **Conversation** — WhatsApp-style message thread showing all channels, with sender avatars, channel badges, internal notes highlighted. Message composer at bottom with text input.
   - **Details** — contact info, custom fields, qualification data, lead metadata
   - **Activity** — chronological timeline of all events
5. **Unified inbox** — list of all conversations across all leads, sorted by last message, filterable by channel and assignee
6. **Handoff queue** — pending handoffs with reason, AI summary, accept/reassign buttons
7. **Team page** — all team members (human + AI) with status, role, active lead count
8. **Audit log viewer** (admin only) — paginated table of all audit entries with filters by actor, action category, severity, date range. Click to expand and see field-level change diffs.
9. **Settings** — org profile, team management, AI agent configuration, custom fields, lead sources, API keys, webhooks
10. **Dashboard** — pipeline value per stage, leads by source, team performance (human vs AI comparison), pending handoffs count, conversation metrics

### Design Notes

- Every lead card and activity entry should clearly show whether the actor was human or AI (icon badge)
- The conversation thread must visually distinguish: messages from contact, messages from human team, messages from AI agent, and internal notes
- The audit log viewer should feel like a security console — filterable, searchable, exportable
- Kanban board must update in realtime when leads are created/moved via API
- Use minimal, clean UI with good information density