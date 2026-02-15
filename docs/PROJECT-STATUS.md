# HNBCRM — Project Status & Roadmap

**Last Updated:** 2026-02-15
**Current Version:** v0.7.1
**Based on:** PRD v2.0 (2025-02-11)

---

## 1. Project Overview

HNBCRM (Humans & Bots CRM) is a **realtime-first, AI-native, multi-tenant CRM** where humans and AI agents are equal team members. Built on Convex for native reactivity, React + TailwindCSS frontend, dark theme, mobile-first, PT-BR UI.

### Current Stack

| Layer | Technology | Status |
|-------|-----------|--------|
| Backend | Convex (queries, mutations, actions, HTTP) | Production-ready |
| Frontend | React 19 + Vite 6 + TailwindCSS | Production-ready |
| Auth | @convex-dev/auth (Password + Anonymous) | Working |
| Routing | react-router v7 (SPA/library mode) | Working |
| Drag & Drop | @dnd-kit/core + sortable | Working |
| Icons | lucide-react | Working |
| Toasts | sonner | Working |
| MCP Server | hnbcrm-mcp (npm package) | Working |

### Database

**16 application tables** + Convex auth tables. All tables scoped by `organizationId` for multi-tenancy.

---

## 2. Implementation Status by Domain

### Legend

- **DONE** — Fully implemented (backend + frontend)
- **BACKEND DONE** — Backend complete, frontend minimal or missing
- **PARTIAL** — Core exists but missing features from PRD
- **NOT STARTED** — Not yet implemented

---

### 2.1 Organization & Multi-Tenancy — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Create organization | Done | Auto-creates default board, stages, lead sources |
| Organization settings (name, timezone, currency) | Done | Settings UI in Settings > General |
| AI config per org (autoAssign, handoffThreshold) | Done | Stored in org.settings.aiConfig |
| Organization switcher | Done | WelcomeScreen with org cards + sidebar dropdown |
| Multi-org membership | Done | Users can belong to multiple orgs |
| Strict data isolation (orgId scoping) | Done | All queries/mutations enforce orgId |

**Not implemented from PRD:** `plan` field (free/pro/enterprise), `s3Bucket` per org, `retentionDays` config.

**Files:** `convex/organizations.ts`, `src/components/layout/AuthLayout.tsx`

---

### 2.2 Authentication — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Email/password login | Done | via @convex-dev/auth Password provider |
| Anonymous auth | Done | Anonymous provider configured |
| API key auth (X-API-Key header) | Done | SHA-256 hashed, linked to teamMembers |
| API key generation | Done | Secure random `hnbcrm_*` format |
| `requireAuth(ctx, orgId)` helper | Done | Used in all public functions |
| Auth page | Done | Standalone at `/entrar` with redirect guards |
| Auth layout with gates | Done | AuthLayout handles auth → org → onboarding → team member |

**Not implemented from PRD:** OAuth (Google, GitHub), magic link, JWT bearer tokens, scoped API key permissions (currently all-or-nothing).

**Files:** `convex/auth.ts`, `convex/lib/auth.ts`, `convex/apiKeys.ts`, `convex/nodeActions.ts`, `src/components/AuthPage.tsx`, `src/components/layout/AuthLayout.tsx`

---

### 2.3 Team Management (Human + AI) — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Team members table (human + AI types) | Done | `type: "human" \| "ai"` |
| Roles (admin, manager, agent, ai) | Done | 4 roles (PRD has 6 — missing super_admin, viewer) |
| Status (active, inactive, busy) | Done | Status dropdown in Team page |
| Add human team members | Done | Modal with name, email, role |
| Add AI agents as team members | Done | Type selection in modal |
| AI capabilities field | Done | Stored in schema |
| Team page UI | Done | Member list with avatars, roles, status |

**Not implemented from PRD:** AI agent config panel (model, systemPrompt, channels, handoff rules), capability tags UI, team performance detail view, agent activity monitor.

**Files:** `convex/teamMembers.ts`, `src/components/TeamPage.tsx`

---

### 2.4 Board & Pipeline Management — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Multiple boards per org | Done | Board selector tabs on Kanban |
| Create/edit/delete boards | Done | EditBoardModal + inline stage management |
| Default board template (auto-created) | Done | 5 default stages on board creation |
| Custom stages: add, rename, reorder, color | Done | ManageStagesModal + inline column menus |
| Stage color picker (12 presets + custom) | Done | Color picker in stage edit |
| Won/Lost stage types | Done | `isClosedWon` / `isClosedLost` toggles |
| Close reason modal | Done | Prompted when moving lead to closed stage |
| Delete protection (can't delete if leads exist) | Done | Backend enforced |
| Atomic board+stages creation | Done | `createBoardWithStages` mutation |
| Board summary header | Done | Name, lead count, total value per board |
| Stage column summary stats | Done | Lead count + total value per stage |

**Not implemented from PRD:** WIP limits per stage, auto-assignment strategy per board, default currency per board, auto-actions on stage enter/exit.

**Files:** `convex/boards.ts`, `src/components/KanbanBoard.tsx`, `src/components/ManageStagesModal.tsx`, `src/components/EditBoardModal.tsx`

---

### 2.5 Lead Management — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Kanban view (drag-and-drop) | Done | @dnd-kit with drag overlay, snap-scroll mobile |
| Lead cards (title, contact, value, badges) | Done | Priority bar, temp badge, aging indicator, assignee avatar |
| Quick-add lead per stage | Done | Inline form at top of stage column |
| Create lead modal (full form) | Done | With contact selection/creation (3 modes) |
| Lead detail panel (slide-over) | Done | 3 tabs: Conversation, Details, Activity |
| Assign lead to team member | Done | Dropdown with role badges in detail panel |
| Move lead between stages/pipelines | Done | Drag-drop + cascading pipeline>stage picker |
| Lead priority (low/medium/high/urgent) | Done | |
| Lead temperature (cold/warm/hot) | Done | |
| Lead value + currency | Done | |
| Tags | Done | Array field, displayed as badges |
| BANT qualification data | Done | Budget, Authority, Need, Timeline, Score |
| Custom fields on leads | Done | Stored as `customFields` record |
| Lead search (text) | Done | Filter bar on Kanban |
| Filter by priority, temperature, assignee | Done | Filter dropdowns on Kanban |
| Won/Lost close with reason | Done | CloseReasonModal captures reason + final value |
| Aging indicator (days in stage) | Done | Color-coded on lead cards (green/yellow/red) |
| Contact linking/unlinking | Done | Interactive contact section with search picker |
| Conversation status tracking | Done | `conversationStatus` field |
| Handoff state tracking | Done | `handoffState` field on leads |
| Saved views | Done | ViewSelector with default + custom views |

**Not implemented from PRD:** List/table view, bulk actions (multi-select, move, assign, tag, archive), lead merging, `sourceRef` (external ID), `expectedCloseDate`, lead archiving (soft delete).

**Files:** `convex/leads.ts`, `src/components/KanbanBoard.tsx`, `src/components/LeadDetailPanel.tsx`, `src/components/CreateLeadModal.tsx`, `src/components/CloseReasonModal.tsx`, `src/components/ViewSelector.tsx`, `src/components/CreateViewModal.tsx`

---

### 2.6 Contact Management — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Contact directory per org | Done | Contacts tab with search + table |
| Contact CRUD | Done | Create modal (multi-step), detail panel |
| Search contacts (full-text) | Done | Debounced search via `searchText` index |
| Basic fields (name, email, phone, company, title) | Done | |
| Social profiles (LinkedIn, Instagram, Facebook, Twitter) | Done | SocialIcons component |
| 20+ enrichment fields | Done | Location, company info, acquisition data, social metrics |
| Enrichment metadata (source, confidence per field) | Done | `enrichmentMeta` tracking |
| Enrichment gap indicator | Done | Missing fields badge on contact rows |
| Tags | Done | Tag filters on contacts page |
| Contact detail panel | Done | Collapsible sections for all field groups |
| Linked leads view | Done | Shows all leads for a contact with stage info |
| Custom fields on contacts | Done | CustomFieldsRenderer component |
| findOrCreateContact (upsert) | Done | Used by inbound lead API |
| Delete protection (blocked if leads linked) | Done | Backend enforced |
| Responsive layouts | Done | Desktop table + mobile cards |
| REST API (full CRUD) | Done | 5 endpoints |

**Not implemented from PRD:** Auto-create contact from lead email/phone, de-duplication engine, `lastContactedAt` tracking, contact-level conversation aggregation across boards.

**Files:** `convex/contacts.ts`, `src/components/ContactsPage.tsx`, `src/components/ContactDetailPanel.tsx`, `src/components/CreateContactModal.tsx`, `src/components/ui/CollapsibleSection.tsx`

---

### 2.7 Conversations & Messaging — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Conversations table (multi-channel) | Done | whatsapp, telegram, email, webchat, internal |
| Messages table | Done | Direction, senderType, content, attachments schema |
| Conversation thread UI | Done | In LeadDetailPanel > Conversation tab |
| Unified Inbox page | Done | Conversation list + message view, responsive |
| Send messages (outbound) | Done | Via UI and API |
| Internal notes | Done | `isInternal` toggle in message composer |
| @Mentions in internal notes | Done | MentionTextarea with autocomplete, MentionRenderer |
| Message direction (inbound/outbound/internal) | Done | |
| Sender type (contact/human/ai) | Done | Color-coded bubbles |
| `mentionedUserIds` tracking | Done | Stored on internal messages |
| Delivery status field | Done | Schema supports sent/delivered/read/failed |
| Conversation status (active/closed) | Done | |
| API: send message, get conversations, get messages | Done | 3 HTTP endpoints |

**Not implemented from PRD:** Reply-to (quote message), attachment upload (S3 flow), typing indicators, message editing/deletion, rich content types (image/audio/video/location), channel-specific metadata, real channel dispatch (messages stored but not sent to external platforms), conversation claiming/assignment.

**Files:** `convex/conversations.ts`, `src/components/Inbox.tsx`, `src/components/LeadDetailPanel.tsx`, `src/components/ui/MentionTextarea.tsx`, `src/components/ui/MentionRenderer.tsx`, `src/lib/mentions.ts`

---

### 2.8 AI-Human Handoff System — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Handoffs table | Done | from/to member, reason, summary, suggestedActions, status |
| Request handoff (AI→human or human→AI) | Done | Mutation + API endpoint |
| Accept handoff | Done | Assigns lead to acceptor, clears handoffState |
| Reject handoff | Done | Uses `resolvedBy` field, clears handoffState |
| Handoff queue UI | Done | HandoffQueue tab with accept/reject buttons |
| Handoff details (lead, contact, reason) | Done | |
| Pending handoff count on dashboard | Done | |
| API endpoints for handoffs | Done | 4 HTTP endpoints |

**Not implemented from PRD:** Handoff expiration, urgency levels, suggested actions display in UI, handoff notification system, reverse handoff instructions (human→AI with task), AI context summary display.

**Files:** `convex/handoffs.ts`, `src/components/HandoffQueue.tsx`

---

### 2.9 Activities & Timeline — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Activities table | Done | 10 activity types |
| Auto-logging from mutations | Done | All lead mutations create activity entries |
| Activity timeline in lead detail | Done | LeadDetailPanel > Activity tab |
| Actor attribution (human/ai/system) | Done | |
| Recent activities on dashboard | Done | Type badges + PT-BR timestamps |
| `addActivity` internal helper | Done | Used across mutations |

**Files:** `convex/activities.ts`, `src/components/LeadDetailPanel.tsx`, `src/components/DashboardOverview.tsx`

---

### 2.10 Audit Logging — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Audit logs table (append-only) | Done | entityType, action, changes, severity |
| Severity levels (low/medium/high/critical) | Done | |
| Field-level diffs (before/after) | Done | `diffChanges` helper |
| Actor tracking (actorId, actorType) | Done | human, ai, system |
| All mutations audit-logged | Done | Pattern followed across codebase |
| Audit log viewer UI | Done | AuditLogs tab with filters |
| Filter by severity and entity type | Done | |
| CSV export | Done | |
| Indexed by org, entity, actor, severity | Done | 5 indexes |

**Not implemented from PRD:** IP address tracking, API key usage tracking in audit, retention policy (archival to S3), full action catalog (PRD lists 40+ specific actions), `actorName` denormalization, free-text search on audit logs, audit log detail view with full changes diff UI.

**Files:** `convex/auditLogs.ts`, `src/components/AuditLogs.tsx`

---

### 2.11 Custom Fields — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Field definitions table | Done | 6 types: text, number, boolean, date, select, multiselect |
| Field definitions CRUD | Done | Admin/manager only |
| `entityType` filter (lead/contact) | Done | Scoped field lookups |
| Custom fields on leads | Done | Stored in `customFields` JSON |
| Custom fields on contacts | Done | CustomFieldsRenderer component |
| Dynamic field renderer | Done | `CustomFieldsRenderer.tsx` |
| Settings UI for field management | Done | Settings > Custom Fields section |

**Not implemented from PRD:** Per-board fields (currently org-global only), required field enforcement, URL/email/phone/currency/textarea types.

**Files:** `convex/fieldDefinitions.ts`, `src/components/Settings.tsx`, `src/components/CustomFieldsRenderer.tsx`

---

### 2.12 Lead Sources — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Lead sources table | Done | name, type, isActive |
| Source types | Done | website, social, email, phone, referral, api, other |
| Lead sources CRUD | Done | |
| Default sources created with org | Done | 5 defaults on org creation |
| Settings UI for source management | Done | Settings > Lead Sources section |

**Not implemented from PRD:** Channel mapping per source, color/icon per source, source-specific analytics.

**Files:** `convex/leadSources.ts`, `src/components/Settings.tsx`

---

### 2.13 Saved Views — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Saved views table | Done | Filters, sort, columns per view |
| Default views | Done | All, My Items, Unassigned, Hot, High Priority |
| Create custom views | Done | CreateViewModal with rich filter options |
| Shared vs personal views | Done | `isShared` flag |
| View selector UI | Done | ViewSelector dropdown component |
| Update/delete views | Done | Creator or admin only |

**Files:** `convex/savedViews.ts`, `src/components/ViewSelector.tsx`, `src/components/CreateViewModal.tsx`

---

### 2.14 Dashboard & Analytics — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Hero section with org greeting | Done | Personalized with org name |
| Quick stats (pipeline value, leads, handoffs, team) | Done | 4 metric cards |
| Quick actions nav | Done | Horizontal-scroll mobile, grid desktop |
| Feature overview grid | Done | 10 cards with live data badges |
| Coming soon section | Done | 8 planned feature cards |
| Pipeline by stage (board-grouped) | Done | Pill-tab board selector, per-board summary |
| Leads by source | Done | Count badges |
| Team performance | Done | Per-member lead counts with type badges |
| Recent activity feed | Done | Latest 10 activities with type badges |
| Won/Lost badges on stages | Done | Ganho/Perdido indicators |

**Not implemented from PRD:** Conversion funnel visualization, AI vs Human comparison metrics, conversation metrics, lead aging report, date range filtering on dashboard, AI agent activity monitor, security alerts view, webhook delivery log.

**Files:** `convex/dashboard.ts`, `src/components/DashboardOverview.tsx`

---

### 2.15 REST API (HTTP Endpoints) — DONE

| Endpoint Group | Count | Status |
|---------------|-------|--------|
| Lead CRUD + operations | 7 | Done |
| Handoff management | 5 | Done |
| Contact CRUD | 5 | Done |
| Conversations & messages | 3 | Done |
| Boards | 1 | Done |
| Team members | 1 | Done |
| Field definitions | 1 | Done |
| **Total** | **23** | **Done** |

**Key endpoints:**
- `POST /api/v1/inbound/lead` — Universal lead capture
- `GET /api/v1/boards` — List boards with stages
- `GET /api/v1/team-members` — List team members
- `GET /api/v1/field-definitions` — List field definitions

**Not implemented from PRD:** Individual board detail (GET /boards/:id), stage CRUD endpoints, individual team member detail (GET /team/:id), webhook management endpoints via API, lead qualification endpoint, advanced query parameter filtering.

**Files:** `convex/router.ts`, `convex/http.ts`

---

### 2.16 Webhook System — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Webhook table | Done | name, url, events, secret, isActive |
| Webhook CRUD (admin only) | Done | |
| HMAC-SHA256 signing | Done | `X-Webhook-Signature` header |
| Event-based triggering | Done | Fired from mutations via `ctx.scheduler.runAfter` |
| Wildcard subscription (`*`) | Done | |
| Settings UI | Done | Settings > Webhooks section |
| `lastTriggered` tracking | Done | |

**Not implemented from PRD:** Retry with exponential backoff, `failCount` tracking, webhook delivery log UI, webhook testing (send test event).

**Files:** `convex/webhooks.ts`, `convex/webhookTrigger.ts`, `convex/nodeActions.ts`

---

### 2.17 API Key Management — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| API key table | Done | keyHash (SHA-256), teamMemberId link |
| Secure key generation (`hnbcrm_*` format) | Done | Node action with crypto |
| Key validation on API requests | Done | Hash + lookup via compound index |
| `lastUsed` tracking | Done | |
| Admin-only management | Done | |
| Settings UI | Done | Settings > API Keys section |

**Not implemented from PRD:** Scoped permissions per key, key expiration (`expiresAt`), `keyPrefix` display, rate limiting per key.

**Files:** `convex/apiKeys.ts`, `convex/nodeActions.ts`, `src/components/Settings.tsx`

---

### 2.18 Onboarding System — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Onboarding wizard (5 steps) | Done | Welcome, Pipeline, Sample Data, Team Invite, Complete |
| Onboarding checklist | Done | Dashboard widget with progress bar |
| Spotlight tooltips | Done | Contextual feature tips on first visit |
| Confetti celebrations | Done | On milestone completions |
| Onboarding progress tracking | Done | Per team member |
| Org metadata (industry, size, goal) | Done | From wizard |
| Seed data templates | Done | Sample pipelines, leads, contacts |

**Files:** `convex/onboarding.ts`, `convex/onboardingSeed.ts`, `src/components/onboarding/`

---

### 2.19 MCP Server — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| MCP npm package (`hnbcrm-mcp`) | Done | Standalone package in `mcp-server/` |
| HnbCrmClient (API wrapper) | Done | TypeScript client wrapping all REST endpoints |
| Lead tools (search, create, update, move, assign) | Done | |
| Contact tools (search, create, update) | Done | |
| Conversation tools (list, get messages, send) | Done | |
| Handoff tools (list pending, accept, reject) | Done | |
| Pipeline tools (list boards with stages) | Done | |
| Resources (boards, team-members, field-definitions) | Done | Auto-refresh |
| Auth via env vars | Done | `HNBCRM_API_URL` + `HNBCRM_API_KEY` |

**Files:** `mcp-server/src/`

---

### 2.20 URL Routing & Public Pages — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| react-router v7 (SPA mode) | Done | `createBrowserRouter` + `RouterProvider` |
| Public routes (`/`, `/entrar`) | Done | Landing page + auth page |
| App routes (`/app/*`) | Done | 8 app routes with `TAB_ROUTES` mapping |
| AuthLayout with route guards | Done | Auth → org → onboarding → team member gates |
| Sales landing page | Done | Hero, features, pricing, CTA, footer |
| Developer portal (`/developers`) | Done | API docs, MCP setup, SDK examples |
| llms.txt endpoints | Done | `/llms.txt` and `/llms-full.txt` |

**Files:** `src/main.tsx`, `src/lib/routes.ts`, `src/components/layout/AuthLayout.tsx`, `src/components/LandingPage.tsx`, `src/components/AuthPage.tsx`, `src/pages/DevelopersPage.tsx`, `convex/llmsTxt.ts`

---

### 2.21 Frontend Layout & Responsiveness — DONE

| Feature | Status | Notes |
|---------|--------|-------|
| Dark theme (default) | Done | CSS custom properties throughout |
| Mobile-first design | Done | Base styles mobile, `md:` / `lg:` breakpoints |
| Desktop sidebar (collapsible) | Done | w-16 collapsed, lg:w-56 expanded |
| Mobile bottom tab bar | Done | 5 main tabs + "More" dropdown |
| PT-BR UI language | Done | All text in Portuguese |
| Responsive tables/cards | Done | Desktop table, mobile card layouts |
| Modal → bottom sheet on mobile | Done | Adaptive modal component |
| Mobile auto-zoom prevention | Done | Viewport meta + input font sizing |
| Kanban snap-scroll on mobile | Done | |
| Inbox responsive toggle | Done | List/detail toggle on mobile |

**Files:** `src/components/layout/AppShell.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/layout/BottomTabBar.tsx`

---

## 3. PRD Sprint Completion

### Sprint 1 — Foundation: ~95% Complete

| Task | Status |
|------|--------|
| Vite + React 19 + Tailwind scaffold | Done |
| Convex schema (all tables including auditLogs) | Done |
| Auth (Convex Auth) | Done |
| Users, Organizations, TeamMembers CRUD | Done |
| Audit log writer helper | Done |
| API key generation and validation | Done |
| Org switcher UI + basic layout | Done |
| **Missing:** OAuth (Google, GitHub), magic link auth | Not Started |

### Sprint 2 — Core Board + Leads: ~90% Complete

| Task | Status |
|------|--------|
| Boards + Stages CRUD (with audit logging) | Done |
| Leads CRUD with Kanban view + drag-and-drop | Done |
| Lead detail panel with basic fields | Done |
| Activity timeline | Done |
| All mutations audit-logged | Done |
| **Missing:** List/table view for leads | Not Started |

### Sprint 3 — Conversations + Storage: ~80% Complete

| Task | Status |
|------|--------|
| Conversations + Messages tables | Done |
| Conversation thread UI | Done |
| Internal notes with @mentions | Done |
| Message sending via API | Done |
| Unified inbox view | Done |
| **Missing:** S3 presigned URL flow / file attachments | Not Started |

### Sprint 4 — AI Integration + Handoffs: ~80% Complete

| Task | Status |
|------|--------|
| AI agent as team member | Done |
| Handoff system (request, queue, accept, reject) | Done |
| REST API — all lead/handoff/contact/message endpoints | Done |
| Inbound lead capture endpoint | Done |
| **Missing:** AI agent config panel (model, prompt, channels) | Not Started |
| **Missing:** Smart auto-assignment engine | Partial (basic only) |

### Sprint 5 — MCP + Flexibility: ~85% Complete

| Task | Status |
|------|--------|
| MCP server implementation (tools + resources) | Done |
| Custom fields system (definitions + renderer) | Done |
| Lead sources management | Done |
| Saved views / filters | Done |
| **Missing:** Command palette (Cmd+K) global search | Not Started |

### Sprint 6 — Admin, Audit & Polish: ~75% Complete

| Task | Status |
|------|--------|
| Admin audit log dashboard | Done |
| Contacts module (with enrichment) | Done |
| Dashboard metrics (board-grouped) | Done |
| Webhook system | Done |
| Responsive/mobile layout | Done |
| Onboarding flow | Done |
| **Missing:** AI agent activity monitor | Not Started |
| **Missing:** API key usage tracking dashboard | Not Started |
| **Missing:** Automation rules (trigger → action) | Not Started |

---

## 4. What's NOT Built Yet

### Tier 1 — High Impact, Builds on Existing Code

| Feature | PRD Section | Impact |
|---------|------------|--------|
| **List/Table view for leads** | 5.3 | Alternative to Kanban for power users with sorting/filtering columns |
| **Bulk operations** | 5.3 | Multi-select leads for stage move, assign, tag, archive |
| **Command Palette (Cmd+K)** | 5.8 | Global search across leads, contacts, messages |
| **Lead archiving (soft delete)** | 5.3 | Replace hard-delete with archive + restore |
| **AI Agent Config Panel** | 5.5 | UI to configure model, systemPrompt, channels, handoff rules per agent |

### Tier 2 — Core Platform Capabilities

| Feature | PRD Section | Impact |
|---------|------------|--------|
| **Smart auto-assignment engine** | 5.5 | Round-robin, by-channel, by-capability, least-loaded strategies |
| **Notification system** | 11.3 | In-app notification center + real-time alerts |
| **Scoped API key permissions** | 6.1 | Fine-grained access (`leads:read`, `messages:send`, etc.) |
| **Webhook retry with backoff** | 8.5 | Currently fire-and-forget — needs exponential backoff |
| **Reply-to (quote messages)** | 5.4 | Reference specific messages when replying |

### Tier 3 — External Integrations & Storage

| Feature | PRD Section | Impact |
|---------|------------|--------|
| **File storage** | 9B | S3 presigned URLs or Convex file storage for attachments |
| **Channel integrations** | 8 | WhatsApp Business API, Telegram Bot API, email (Resend/SES) |
| **OAuth login** | 2.4 | Google, GitHub providers |

### Tier 4 — Phase 2+ Roadmap

| Feature | PRD Phase | Notes |
|---------|----------|-------|
| Automation rules engine | Phase 2 | Trigger → condition → action system |
| AI lead scoring | Phase 2 | Configurable scoring rules |
| AI conversation summarization | Phase 2 | Auto-generate lead context |
| AI co-pilot mode | Phase 3 | Suggest responses, human approves |
| Multi-agent workflows | Phase 3 | Agent A → Agent B → Human chains |
| Sentiment analysis | Phase 3 | On conversations |
| Calendar integration | Phase 3 | Meeting scheduling |
| Natural language queries | Phase 4 | "Show me hot leads from WhatsApp" |
| Predictive lead scoring | Phase 4 | Based on historical data |
| Custom report builder | Phase 4 | Drag-and-drop reports |
| Data import/export | 10.2 | Beyond current audit CSV export |
| Billing & plans (Stripe) | 11.2 | SaaS monetization |

---

## 5. Architecture Deviations from PRD

| PRD Planned | Actual Implementation | Reason |
|------------|----------------------|--------|
| TanStack Router (file-based routes) | react-router v7 (SPA/library mode) | More mature, wider ecosystem, sufficient for SPA |
| 6 roles (super_admin, owner, admin, member, agent, viewer) | 4 roles (admin, manager, agent, ai) | Simplified for MVP — can expand later |
| Hono HTTP router | Convex native `httpRouter` with `httpAction` | Convex built-in routing sufficient for current endpoints |
| S3 file storage | Not implemented | Deferred — no file uploads yet |
| nuqs for URL state | Not used | react-router handles URL state |
| shadcn/ui components | Custom TailwindCSS design system | Intentional — custom dark theme with brand tokens |
| `automationRules` table | Not in schema | Automation engine deferred to Phase 2 |
| Scoped API key permissions | All-or-nothing access | Simplified for current use |
| Audit log `actorIp`, `apiKeyId` fields | Not tracked | HTTP action context not passed to audit writer |

### Additions Beyond PRD

| Feature | Notes |
|---------|-------|
| Sales landing page | Public page at `/` with hero, features, pricing |
| Developer portal | `/developers` with API docs, MCP setup, SDK examples |
| llms.txt endpoints | AI-readable project documentation |
| Onboarding system | 5-step wizard + checklist + spotlights + confetti |
| Contact enrichment (20+ fields) | Social, location, company, acquisition data |
| Saved views system | Reusable filter configurations |

---

## 6. Key File Reference

### Backend (Convex)

| Domain | File |
|--------|------|
| Schema (all tables) | `convex/schema.ts` |
| Auth config | `convex/auth.ts`, `convex/auth.config.ts` |
| Auth helper | `convex/lib/auth.ts` |
| HTTP entry | `convex/http.ts` |
| REST API routes | `convex/router.ts` |
| Leads | `convex/leads.ts` |
| Boards & stages | `convex/boards.ts` |
| Contacts | `convex/contacts.ts` |
| Conversations & messages | `convex/conversations.ts` |
| Team members | `convex/teamMembers.ts` |
| Handoffs | `convex/handoffs.ts` |
| Activities | `convex/activities.ts` |
| Audit logs | `convex/auditLogs.ts` |
| Dashboard analytics | `convex/dashboard.ts` |
| Organizations | `convex/organizations.ts` |
| API keys | `convex/apiKeys.ts` |
| Webhooks | `convex/webhooks.ts` |
| Webhook internals | `convex/webhookTrigger.ts` |
| Node actions (hash, keys, webhooks) | `convex/nodeActions.ts` |
| Field definitions | `convex/fieldDefinitions.ts` |
| Lead sources | `convex/leadSources.ts` |
| Saved views | `convex/savedViews.ts` |
| Onboarding | `convex/onboarding.ts`, `convex/onboardingSeed.ts` |
| llms.txt | `convex/llmsTxt.ts` |
| Seed data | `convex/seed.ts` |

### Frontend — Pages & Features

| Domain | File |
|--------|------|
| Entry point + router | `src/main.tsx` |
| Route constants | `src/lib/routes.ts` |
| Auth layout + guards | `src/components/layout/AuthLayout.tsx` |
| Layout orchestrator | `src/components/layout/AppShell.tsx` |
| Desktop sidebar | `src/components/layout/Sidebar.tsx` |
| Mobile tab bar | `src/components/layout/BottomTabBar.tsx` |
| Dashboard metrics | `src/components/DashboardOverview.tsx` |
| Kanban board | `src/components/KanbanBoard.tsx` |
| Lead detail panel | `src/components/LeadDetailPanel.tsx` |
| Create lead modal | `src/components/CreateLeadModal.tsx` |
| Close reason modal | `src/components/CloseReasonModal.tsx` |
| Contacts page | `src/components/ContactsPage.tsx` |
| Contact detail panel | `src/components/ContactDetailPanel.tsx` |
| Create contact modal | `src/components/CreateContactModal.tsx` |
| Custom fields renderer | `src/components/CustomFieldsRenderer.tsx` |
| Inbox (conversations) | `src/components/Inbox.tsx` |
| Handoff queue | `src/components/HandoffQueue.tsx` |
| Team page | `src/components/TeamPage.tsx` |
| Audit logs | `src/components/AuditLogs.tsx` |
| Settings (5 sections) | `src/components/Settings.tsx` |
| Saved views | `src/components/ViewSelector.tsx`, `src/components/CreateViewModal.tsx` |
| Manage stages modal | `src/components/ManageStagesModal.tsx` |
| Edit board modal | `src/components/EditBoardModal.tsx` |
| Landing page | `src/components/LandingPage.tsx` |
| Auth page | `src/components/AuthPage.tsx` |
| Developer portal | `src/pages/DevelopersPage.tsx` |

### Frontend — Onboarding

| Component | File |
|-----------|------|
| OnboardingWizard | `src/components/onboarding/OnboardingWizard.tsx` |
| OnboardingChecklist | `src/components/onboarding/OnboardingChecklist.tsx` |
| SpotlightTooltip | `src/components/onboarding/SpotlightTooltip.tsx` |
| ConfettiCanvas | `src/components/onboarding/ConfettiCanvas.tsx` |
| Wizard steps (5) | `src/components/onboarding/WizardStep*.tsx` |
| Step indicator | `src/components/onboarding/WizardStepIndicator.tsx` |

### Frontend — UI Primitives (`src/components/ui/`)

Avatar, Badge, Button, Card, CollapsibleSection, EmptyState, Input, MentionRenderer, MentionTextarea, Modal, Skeleton, SlideOver, Spinner

### Frontend — Utilities (`src/lib/`)

| Utility | File |
|---------|------|
| Route mapping constants | `src/lib/routes.ts` |
| Mention parsing & utilities | `src/lib/mentions.ts` |
| Onboarding seed templates | `src/lib/onboardingTemplates.ts` |
| Celebration triggers | `src/lib/celebrations.ts` |
| cn() class merge | `src/lib/utils.ts` |

### MCP Server (`mcp-server/`)

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server entry point |
| `src/client.ts` | HnbCrmClient API wrapper |
| `src/resources.ts` | MCP resource definitions |
| `src/tools/leads.ts` | Lead tools |
| `src/tools/contacts.ts` | Contact tools |
| `src/tools/conversations.ts` | Conversation tools |
| `src/tools/handoffs.ts` | Handoff tools |
| `src/tools/pipeline.ts` | Pipeline tools |

---

## 7. Overall Assessment

### What We've Achieved

HNBCRM has a **solid, production-grade foundation** at ~85% MVP completion. The core CRM loop — create leads, move through pipeline, manage contacts, track conversations, handle handoffs, audit everything — is fully functional with both UI and API. The MCP server enables AI agent integration, the onboarding system guides new users, and the dark-theme mobile-first UI is polished with URL-based routing.

### Sprint Completion Summary

| Sprint | Coverage | Key Missing |
|--------|----------|-------------|
| 1 — Foundation | 95% | OAuth providers |
| 2 — Board + Leads | 90% | List/table view |
| 3 — Conversations | 80% | File storage / attachments |
| 4 — AI + Handoffs | 80% | Agent config panel, smart auto-assignment |
| 5 — MCP + Flexibility | 85% | Command palette (Cmd+K) |
| 6 — Admin + Polish | 75% | Automation rules, activity monitor |
| **Overall MVP** | **~85%** | |

### Recommended Next Focus

The biggest remaining gaps fall into two categories:

1. **Power-user features** (list view, bulk ops, Cmd+K, soft delete) — these make the existing CRM more usable for teams with many leads.

2. **AI-native differentiators** (agent config panel, smart auto-assignment, automation rules) — these deepen the human-AI collaboration that makes HNBCRM unique.

File storage and channel integrations are important but can be deferred until external platform integrations are actually needed.

---

*This document should be updated as features are completed. See `CHANGELOG.md` for detailed version history.*
