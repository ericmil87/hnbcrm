# Changelog

All notable changes to ClawCRM will be documented in this file.

## [0.2.0] - 2026-02-13

### Developer Tooling & AI Agent Support

- Added `convex-agent-plugins` submodule (18 best-practice rules, 7 skills, 2 agents)
- Created `CLAUDE.md` (root) — commands, architecture, mandatory Convex rules, skill/agent catalog
- Created `convex/CLAUDE.md` — backend file map, auth pattern, mutation side-effects checklist, index reference, HTTP API pattern
- Created `src/CLAUDE.md` — component tree, data fetching/mutation patterns, styling conventions
- Added PostToolUse hooks: auto-validate Convex functions for missing validators, auto-codegen after schema edits
- Added `convex/seed.ts` for development seeding

## [0.1.0] - 2026-02-11

### Initial MVP Release

#### Bug Fixes
- Fixed critical crash when Kanban board loaded with null `boardId` by using Convex `"skip"` pattern

#### Phase 1 — Core Functionality
- Added `activities` table to schema for lead activity tracking
- Created `convex/activities.ts` — getActivities, createActivity, addActivity (internal)
- Created `convex/auditLogs.ts` — getAuditLogs query with severity/entityType filters and pagination
- Added `updateLead` and `deleteLead` mutations to `convex/leads.ts`
- Wired activity logging into createLead, moveLeadToStage, assignLead, updateLeadQualification, sendMessage, requestHandoff, acceptHandoff
- Created `LeadDetailPanel` component with 3 tabs: Conversation, Details, Activity
- Created `CreateLeadModal` component with contact selection/creation
- Updated `KanbanBoard` with lead card click-to-open and "Create Lead" button
- Updated `AuditLogs` component to use real data with filters

#### Phase 2 — Complete CRUD
- Created `convex/fieldDefinitions.ts` — full CRUD for custom field definitions
- Created `convex/leadSources.ts` — full CRUD for lead sources
- Created `convex/webhooks.ts` — full CRUD for webhooks (admin only)
- Created `convex/dashboard.ts` — getDashboardStats query (pipeline stats, leads by source, team performance, pending handoffs, recent activities)
- Added `updateContact`, `deleteContact`, `getContact` to `convex/contacts.ts`
- Added `updateOrganization` mutation to `convex/organizations.ts`
- Created `DashboardOverview` component with summary cards, pipeline chart, team stats
- Added Dashboard tab as default tab in main Dashboard component
- Expanded `Settings` page with sections: General, API Keys, Custom Fields, Lead Sources, Webhooks

#### Phase 3 — HTTP API Expansion
- Expanded `convex/router.ts` with full REST API:
  - Lead endpoints: GET, update, delete, move-stage, assign, handoff
  - Contact endpoints: list, create, get, update
  - Conversation endpoints: list, get messages, send message
  - Handoff endpoints: list, pending, accept, reject
- Added CORS headers and OPTIONS preflight handlers
- Standardized error/success response format

#### Phase 4 — Polish
- Added Human/AI indicator badges on lead cards and assignee avatars
- Added message color coding by sender type: contact (gray), human (blue), AI (purple), internal notes (yellow dashed)
- Added CSV export to Audit Logs page
- Created `convex/webhookTrigger.ts` — webhook trigger system with HMAC signatures
- Wired webhook triggers into lead.created, lead.stage_changed, message.sent, handoff.requested events
