# ClawCRM MVP - Remaining Work

Status comparison of the current codebase against the requirements in `mvp_prompt.md`.

---

## 1. Data Model (Schema)

| Table | Status | Notes |
|---|---|---|
| users | Done | Via Convex Auth tables |
| organizations | Done | name, slug, settings with timezone/currency/aiConfig |
| teamMembers | Done | Human + AI types, roles, capabilities |
| apiKeys | Done | keyHash, permissions, isActive |
| boards | Done | Per org, with order |
| stages | Done | Per board, ordered, closedWon/closedLost flags |
| leads | Done | Full fields including BANT qualification, handoffState |
| conversations | Done | Per lead per channel, status, messageCount |
| messages | Done | direction, senderType, content, attachments, deliveryStatus |
| activities | **MISSING** | Event log per lead (note/call/stage_change/assignment/handoff). Currently no separate table - audit logs partially cover this but don't match the MVP spec for per-lead activity timeline |
| contacts | Done | firstName, lastName, email, phone, company, tags |
| auditLogs | Done | entityType, action, actorType, changes, severity |
| fieldDefinitions | Done | Schema exists, but no CRUD functions |
| leadSources | Done | Schema exists, but no CRUD functions |
| webhooks | Done | Schema exists, but no CRUD functions |

### Schema gaps to fix:
- [ ] Add `activities` table (type: note/call/stage_change/assignment/handoff/etc, actorType, actorId, content, leadId, orgId)
- [ ] Add `aiContext` object field to messages (model, confidence, reasoning) for AI-sent messages
- [ ] Add search index on leads `title` field for text search
- [ ] MVP spec says auditLogs should have: `action` as machine-readable string like "lead.created" (current: generic "create"/"update"/"delete"), `category` field, `description` (human-readable), `changes` as array of field/oldValue/newValue diffs. Current schema is close but doesn't match exactly.
- [ ] MVP teamMembers spec includes: `capabilities` list, `aiConfig` (provider, model, system prompt, channels). Current schema has capabilities but missing structured aiConfig.

---

## 2. Backend Functions

### Implemented:
- [x] Organizations CRUD (create, get by slug, list user orgs)
- [x] TeamMembers CRUD (create, list, get current, update status)
- [x] Boards (create, list per org)
- [x] Stages (create, list per board)
- [x] Leads (create, list with filters, get with related data, move to stage, assign, update qualification)
- [x] Contacts (create, list, find-or-create)
- [x] Conversations (create, list with filters, get messages)
- [x] Messages (send message, internal notes)
- [x] Handoffs (request, accept, reject, list)
- [x] API Keys (create, list, validate by hash)
- [x] Audit logging helper (used in all mutations)

### Missing:
- [ ] **fieldDefinitions** - CRUD queries/mutations (create, list, update, delete custom field definitions)
- [ ] **leadSources** - CRUD queries/mutations (create, list, update, delete; currently only seeded on org creation)
- [ ] **webhooks** - Full CRUD + trigger system (create, list, update, delete, fire webhook on events)
- [ ] **auditLogs query** - No public query to read/filter/paginate audit logs (logs are written but can never be viewed)
- [ ] **activities** - CRUD for the activities table (once created)
- [ ] **Quick-create lead** - Backend mutation for creating lead from inbound data with auto-contact-linking and auto-assign (partially exists in HTTP router but not as a reusable mutation)
- [ ] **Lead update** - General-purpose lead update mutation (edit title, value, priority, temperature, tags, custom fields)
- [ ] **Lead delete** - Soft or hard delete
- [ ] **Contact update/delete** - Edit and remove contacts
- [ ] **Organization update** - Edit org settings
- [ ] **TeamMember update** - Edit role, capabilities, AI config
- [ ] **TeamMember remove** - Deactivate or remove team member
- [ ] **Conversation status update** - Close/reopen conversations
- [ ] **API key revoke/delete** - Deactivate API keys

---

## 3. HTTP API Endpoints

### Implemented:
- [x] `POST /api/v1/inbound/lead` - Universal lead capture (the most important one)
- [x] `GET /api/v1/leads` - List leads with filters
- [x] `GET /api/v1/handoffs/pending` - Pending handoffs

### Missing (per MVP spec):
- [ ] `GET /api/v1/leads/:id` - Get single lead
- [ ] `PUT /api/v1/leads/:id` - Update lead
- [ ] `DELETE /api/v1/leads/:id` - Delete lead
- [ ] `POST /api/v1/leads/:id/stage` - Move lead to stage
- [ ] `POST /api/v1/leads/:id/assign` - Assign lead
- [ ] `POST /api/v1/leads/:id/handoff` - Request handoff
- [ ] `GET /api/v1/contacts` - List contacts
- [ ] `POST /api/v1/contacts` - Create contact
- [ ] `GET /api/v1/contacts/:id` - Get contact
- [ ] `PUT /api/v1/contacts/:id` - Update contact
- [ ] `GET /api/v1/conversations` - List conversations
- [ ] `GET /api/v1/conversations/:id/messages` - Get messages
- [ ] `POST /api/v1/conversations/:id/messages` - Send message
- [ ] `GET /api/v1/handoffs` - All handoffs (not just pending)
- [ ] `POST /api/v1/handoffs/:id/accept` - Accept handoff
- [ ] `POST /api/v1/handoffs/:id/reject` - Reject handoff

### API improvements needed:
- [ ] Production-grade API key hashing (current implementation is simplified)
- [ ] Rate limiting
- [ ] Proper error response format standardization
- [ ] API versioning headers

---

## 4. Frontend Pages & Components

### Implemented:
- [x] **Login/Register** (`SignInForm.tsx`) - Email/password + anonymous sign-in
- [x] **Org Switcher** (`OrganizationSelector.tsx`) - Dropdown in header with create org
- [x] **Kanban Board** (`KanbanBoard.tsx`) - Drag-and-drop leads between stages, board selector
- [x] **Unified Inbox** (`Inbox.tsx`) - Conversation list + WhatsApp-style message thread
- [x] **Handoff Queue** (`HandoffQueue.tsx`) - Pending handoffs with accept/reject
- [x] **Team Page** (`TeamPage.tsx`) - List members, add human/AI team members
- [x] **Settings** (`Settings.tsx`) - API key management + API docs
- [x] **Audit Logs** (`AuditLogs.tsx`) - Skeleton with filters (placeholder data only)

### Missing or Incomplete:

#### Lead Detail Panel (HIGH PRIORITY)
- [ ] Slide-over panel when clicking a lead card on the Kanban board
- [ ] **Conversation tab** - WhatsApp-style message thread per lead, message composer, channel badges, internal notes highlighted differently
- [ ] **Details tab** - Contact info, custom fields editor, BANT qualification data, lead metadata (source, tags, temperature, priority, value)
- [ ] **Activity tab** - Chronological timeline of all events (stage changes, assignments, handoffs, notes, messages)

#### Dashboard with Metrics (HIGH PRIORITY)
- [ ] Pipeline value per stage (bar/funnel chart)
- [ ] Leads by source (pie/bar chart)
- [ ] Team performance (human vs AI comparison)
- [ ] Pending handoffs count widget
- [ ] Conversation metrics (response time, volume)
- Currently the Dashboard component is just the tab router - it has no actual dashboard/overview page

#### Audit Log Viewer (MEDIUM)
- [ ] Connect to real audit log query (backend query doesn't exist yet either)
- [ ] Paginated table with real data
- [ ] Filters: by actor, action category, severity, date range
- [ ] Click to expand and see field-level change diffs
- [ ] Exportable (CSV/JSON)
- [ ] "Security console" feel per MVP spec

#### Settings Expansion (MEDIUM)
- [ ] Org profile editing (name, slug, timezone, currency)
- [ ] Team management (edit roles, remove members, AI agent configuration)
- [ ] Custom fields management (create/edit/delete field definitions)
- [ ] Lead sources configuration
- [ ] Webhook management (create, test, view logs)

#### UI/UX Gaps (per MVP design notes):
- [ ] Human/AI indicator badges on lead cards (icon showing if assignee is human or AI)
- [ ] Human/AI badges on activity entries
- [ ] Conversation thread should visually distinguish: contact messages, human team messages, AI agent messages, internal notes (different colors/styles)
- [ ] Lead cards should show: temperature badge, assignee avatar with human/AI indicator (partially done - has priority/temperature badges but no AI indicator)
- [ ] Create lead form (currently no way to create leads from the UI)
- [ ] Edit lead form
- [ ] Contact management page
- [ ] Real-time Kanban updates when leads are created/moved via API

---

## 5. Auth

### Implemented:
- [x] Human login via email/password (Convex Auth with Password provider)
- [x] Anonymous sign-in option
- [x] API key auth for HTTP endpoints (X-API-Key header)

### Missing:
- [ ] API key auth should map to teamMember and attribute all actions to that member (partially done in router.ts)
- [ ] Role-based access control enforcement (schema has roles but no permission checks beyond basic org membership)
- [ ] Admin-only routes/pages (audit logs should be admin-only per MVP)

---

## 6. Priority Order for Remaining Work

### Phase 1 - Core Functionality (do first)
1. Create `activities` table + mutations
2. Add `auditLogs` query function
3. Add lead update/delete mutations
4. Build **Lead Detail Panel** (slide-over with 3 tabs)
5. Build **Create Lead** form
6. Connect **Audit Logs** viewer to real data

### Phase 2 - Complete CRUD
7. Add fieldDefinitions CRUD
8. Add leadSources CRUD
9. Add webhooks CRUD
10. Add contact update/delete
11. Build **Dashboard** with real metrics
12. Expand **Settings** page (org profile, custom fields, lead sources)

### Phase 3 - HTTP API Expansion
13. Add remaining REST endpoints for leads, contacts, messages, conversations, handoffs
14. Standardize API error responses
15. Improve API key hashing

### Phase 4 - Polish
16. Human/AI indicator badges throughout UI
17. Conversation thread visual distinction (contact vs human vs AI vs internal)
18. Real-time Kanban updates
19. Audit log export
20. Webhook trigger system
