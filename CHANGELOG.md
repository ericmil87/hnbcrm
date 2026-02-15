# Changelog

All notable changes to HNBCRM (formerly ClawCRM) will be documented in this file.

## [0.7.0] - 2026-02-15

### MCP Server, Developer Portal & llms.txt

Adds an MCP server for AI agent integration, a developer portal page, llms.txt endpoints, new REST API endpoints, and renames all remaining ClawCRM references to HNBCRM.

#### MCP Server (`mcp-server/`)
- **hnbcrm-mcp** npm package — Model Context Protocol server for AI agent integration
- **HnbCrmClient** — TypeScript API client wrapping all REST endpoints
- **Tools** — leads (search, create, update, move stage, assign), contacts (search, create, update), conversations (list, get messages, send), handoffs (list pending, accept, reject), pipeline (list boards with stages)
- **Resources** — `hnbcrm://boards`, `hnbcrm://team-members`, `hnbcrm://field-definitions` with auto-refresh
- Auth via `HNBCRM_API_URL` + `HNBCRM_API_KEY` environment variables

#### Developer Portal (`src/pages/DevelopersPage.tsx`)
- Public page at `/developers` with REST API docs, MCP server setup, and SDK examples
- Tabbed code blocks for Claude Desktop, Cursor, and environment variable configs
- Added "Developers" link to LandingPage header and footer

#### llms.txt (`convex/llmsTxt.ts`, `convex/router.ts`)
- `/llms.txt` and `/llms-full.txt` HTTP endpoints for AI-readable project documentation
- Describes API capabilities, authentication, and endpoint reference

#### New REST API Endpoints (`convex/router.ts`)
- `GET /api/v1/boards` — List boards with stages (for MCP resources)
- `GET /api/v1/team-members` — List team members (for MCP resources)
- `GET /api/v1/field-definitions` — List field definitions (for MCP resources)

#### Internal (`convex/fieldDefinitions.ts`)
- Added `internalGetFieldDefinitions` query for HTTP API router access

#### Landing Page (`src/components/LandingPage.tsx`)
- Moved "Servidor MCP" from Coming Soon to built Features section
- Removed "Em Breve" badge from MCP in pricing tier

#### Rebrand Cleanup
- Renamed all remaining `ClawCRM` references to `HNBCRM` across 19 files
- Updated npm package name, API key prefix (`hnbcrm_`), localStorage keys, seed email domains, env var names, MCP resource URIs, TypeScript class names, config keys, and doc headings

## [0.6.0] - 2026-02-15

### URL Routing & Sales Landing Page

Adds react-router v7 for URL-based navigation and a public sales landing page for unauthenticated visitors.

#### URL Routing (`src/main.tsx`, `src/lib/routes.ts`)
- **react-router v7** in SPA/library mode with `createBrowserRouter` + `RouterProvider`
- Public routes: `/` (LandingPage), `/entrar` (AuthPage)
- App routes: `/app/painel`, `/app/pipeline`, `/app/contatos`, `/app/entrada`, `/app/repasses`, `/app/equipe`, `/app/auditoria`, `/app/configuracoes`
- **`TAB_ROUTES` / `PATH_TO_TAB`** shared route mapping constants in `src/lib/routes.ts`

#### AuthLayout (`src/components/layout/AuthLayout.tsx`)
- New route layout consolidating auth → org selection → onboarding wizard → team member gates
- Unauthenticated users redirected to `/entrar`; authenticated users on `/entrar` redirected to `/app`
- Passes `organizationId` to child routes via `useOutletContext<AppOutletContext>()`
- Wraps page content with `ErrorBoundary`

#### Sales Landing Page (`src/components/LandingPage.tsx`)
- **Hero** with radial orange glow, staggered fade-in animations, floating CTA pill (IntersectionObserver)
- **Social Proof Bar** — 3 capability highlights
- **Features Section** — 12 built feature cards in responsive grid
- **Coming Soon** — 8 upcoming features with "Em Breve" badges
- **How It Works** — 3 step cards
- **Pricing** — 3 tiers (Starter free, Pro highlighted, Enterprise) — all free during beta
- **CTA Section** + **Footer**
- Fully responsive (375px → 768px → 1024px), accessible landmarks, PT-BR text

#### Auth Page (`src/components/AuthPage.tsx`)
- Standalone auth screen at `/entrar` with back-to-landing link
- Auth redirect guard: already-authenticated users sent to `/app`

#### Navigation Refactor (`src/components/layout/`)
- **Sidebar** and **BottomTabBar** now derive active tab from `useLocation()` and navigate via `useNavigate()` — removed `activeTab`/`onTabChange` props
- **AppShell** simplified — no longer passes tab state props
- **OnboardingChecklist** uses `useNavigate` + `TAB_ROUTES` instead of `onTabChange` prop

#### Page Components
- All 8 page components (DashboardOverview, KanbanBoard, ContactsPage, Inbox, HandoffQueue, TeamPage, AuditLogs, Settings) now use `useOutletContext<AppOutletContext>()` for `organizationId` instead of receiving it as a prop
- `DashboardOverview` derives `onTabChange` via `useNavigate` + `TAB_ROUTES`

#### Cleanup
- `App.tsx` and `Dashboard.tsx` are now dead code (superseded by router + AuthLayout + Outlet)

## [0.5.3] - 2026-02-15

### @Mentions in Internal Notes & Onboarding System

Adds Slack-like @mention autocomplete for internal notes and a full onboarding experience for new organizations.

#### @Mentions (`src/lib/mentions.ts`, `src/components/ui/MentionTextarea.tsx`, `src/components/ui/MentionRenderer.tsx`)
- **MentionTextarea** — Custom textarea with @mention autocomplete dropdown; type `@` after space/start to trigger, fuzzy-filters team members, keyboard navigation (arrows, Enter/Tab to select, Escape to close), accessible with ARIA attributes
- **MentionRenderer** — Renders `@[Name](id)` tokens as brand-colored inline pills in message content
- **Mention utilities** — Pure functions for parsing, insertion, ID extraction, and accent-normalized fuzzy filtering
- Mentions only active for internal notes (`isInternal=true`), disabled for external messages
- `mentionedUserIds` field added to messages schema for tracking who was mentioned

#### Backend (`convex/conversations.ts`, `convex/router.ts`)
- Added `mentionedUserIds` arg to `sendMessage` and `internalSendMessage` mutations (only stored for internal notes)
- HTTP API `/api/v1/conversations/send` forwards `mentionedUserIds`

#### Onboarding System (`convex/onboarding.ts`, `src/components/onboarding/`)
- **OnboardingWizard** — 5-step wizard for new organizations: Welcome, Pipeline Setup, Sample Data, Team Invite, Complete
- **OnboardingChecklist** — Dashboard widget tracking first-use milestones with progress bar
- **SpotlightTooltip** — Contextual feature tooltips on first visit to key pages (Inbox, Contacts, Pipeline, etc.)
- **ConfettiCanvas** — Celebration animation on milestone completions
- `onboardingProgress` table tracks wizard state, checklist dismissal, seen spotlights, and celebrated milestones per team member
- `onboardingMeta` field on organizations stores industry, company size, and main goal from wizard
- Seed data templates for sample pipelines, leads, and contacts

## [0.5.2] - 2026-02-15

### Contact Enrichment & Enhanced UI

Adds 20+ enrichment fields to contacts, full REST API for contacts, and a major frontend upgrade to the contacts experience.

#### Schema & Backend (`convex/contacts.ts`, `convex/schema.ts`)
- **20+ enrichment fields** on contacts: social URLs (LinkedIn, Instagram, Facebook, Twitter), location (city, state, country), company info (industry, companySize, CNPJ, companyWebsite), acquisition data (utmSource, acquisitionChannel, deviceType), social metrics (instagramFollowers, linkedinConnections, socialInfluenceScore), custom fields, and enrichment metadata
- **`enrichContact` internal mutation** — AI-agent-friendly enrichment with per-field source/confidence tracking via `enrichmentMeta`
- **`getContactEnrichmentGaps` query** — Returns missing fields for a contact (public + internal variants)
- **`getContactWithLeads` query** — Contact with linked leads, stage info, and assignees
- **`diffChanges` helper** — Extracted shared change-tracking logic, replacing duplicated per-field if-blocks in update mutations
- **`buildSearchText` expanded** — Now indexes city, state, country, industry, and bio

#### REST API (`convex/router.ts`)
- Full contacts CRUD: `GET /api/v1/contacts`, `GET /api/v1/contacts/:id`, `POST /api/v1/contacts`, `PUT /api/v1/contacts/:id`, `DELETE /api/v1/contacts/:id`

#### Field Definitions (`convex/fieldDefinitions.ts`)
- Added `entityType` filter (`lead` | `contact`) to `getFieldDefinitions` query
- New `by_organization_and_entity` index for scoped field lookups
- `createFieldDefinition` now accepts optional `entityType`

#### Frontend
- **ContactDetailPanel** — Collapsible sections for social links, location, company info, acquisition data, custom fields; photo display; enrichment gap indicator
- **CreateContactModal** — Multi-step form (basic info → enrichment fields) with all new fields
- **ContactsPage** — Tag filters, enrichment gap badges on contact rows, improved search
- **CustomFieldsRenderer** — New component for rendering and editing custom fields on contacts
- **SocialIcons** — New component for social media link icons (LinkedIn, Instagram, Facebook, Twitter)
- **CollapsibleSection** — New reusable UI primitive for expandable content sections
- **Settings** — Added contact custom fields management section

#### Seed Data (`convex/seed.ts`)
- Enhanced seed contacts with social URLs, location, industry, and company data

## [0.5.1] - 2026-02-14

### Dashboard Home Page & Pipeline Widget Redesign

#### Dashboard Home Page
- **Hero section** — Personalized greeting with org name and HNBCRM tagline
- **Quick Stats row** — 4 metric cards: pipeline value, active leads, pending handoffs, team members
- **Quick Actions** — Horizontal-scroll (mobile) / 4-col grid (desktop) nav cards to Pipeline, Inbox, Handoffs, Team
- **Feature Overview grid** — 10 interactive cards showcasing existing platform features with live data badges
- **Coming Soon section** — 8 "Em Breve" cards for planned features (MCP Server, Automations, AI Co-pilot, etc.)
- **Recent Activity feed** — Latest 10 activities with type badges and PT-BR timestamps

#### Pipeline Widget — Board-Grouped with Tabs
- **Pill-tab board selector** — Stages now grouped by pipeline; tab row with colored dot per board (hidden when only 1 board)
- **Board summary header** — Shows board name, lead count, and total value per pipeline
- **Won/Lost badges** — Stages marked as closedWon/closedLost show "Ganho"/"Perdido" badge
- **Rate limiting** — Leads queried per-board via `by_organization_and_board` index with `.take(500)` cap; remaining org-wide queries capped at `.take(2000)`; handoffs capped at `.take(100)`

#### Backend (`convex/dashboard.ts`)
- `getDashboardStats` restructured: `pipelineStats` now returns board-grouped array instead of flat stage list
- `getPipelineStats` updated with same board-grouped structure
- Added `organizationName` and `teamMemberCount` to dashboard stats return

## [0.5.0] - 2026-02-14

### Contacts, Saved Views, Pipeline Management & Kanban UX Overhaul

Major feature release adding contacts management, saved views, pipeline CRUD modals, and a kanban UX overhaul based on research of Pipedrive, HubSpot, and modern CRM patterns.

#### Contacts Page & Management
- **ContactsPage** — New dedicated contacts tab with search, table view, and contact detail panel
- **ContactDetailPanel** — SlideOver panel showing contact info and linked leads
- **CreateContactModal** — Modal for creating new contacts with full field support
- **Contacts nav** — Added "Contatos" tab to both Sidebar (desktop) and BottomTabBar (mobile); moved "Equipe" to "Mais" menu on mobile
- Contact search text indexing (`searchText` field + `buildSearchText` helper) for full-text search
- **CreateLeadModal** improved — Contact selection now supports three modes: none, select existing, or create new

#### Saved Views
- **savedViews.ts** backend — CRUD queries/mutations for saved views with filters, sort, and column preferences
- **ViewSelector** — Dropdown component for selecting and managing saved views
- **CreateViewModal** — Modal for creating new saved views with filter configuration

#### Pipeline Management Modals
- **EditBoardModal** — Modal for editing pipeline name, description, and color
- **ManageStagesModal** — Full stage management: rename, recolor, reorder (up/down), add, delete, toggle closedWon/closedLost

#### Lead Detail Panel Overhaul
- **Contact link/unlink** — Interactive contact section replaces read-only text; searchable contact picker dropdown with link, change, and unlink buttons
- **Assignee selector** — Dropdown of all team members with role badges (Admin/Gerente/Agente/IA) and "Não atribuído" option
- **Stage/Pipeline selector** — Cascading pipeline > stage picker with closedWon/closedLost badges, move leads between pipelines from the detail panel

#### Deal Aging & Stage Stats
- **Days-in-stage indicator** on kanban cards — Clock icon with color-coded aging (green < 3d, yellow 3-7d, red > 7d)
- **Stage column summary stats** — Each column header now shows lead count and total value (e.g. "8 leads · R$ 125.000")

#### Win/Loss Reason Capture
- Added `closedAt`, `closedReason`, `closedType` fields to leads schema
- **CloseReasonModal** intercepts drag-to-close and stage-change-to-close, capturing reason (required for lost) and final value
- `moveLeadToStage` mutation now accepts `closedReason` and `finalValue`, auto-sets close fields for closedWon/closedLost stages

#### Pipeline & Stage Management UX
- **Pipeline selector redesign** — Color dot indicators, visible "+" Novo button in tab bar, gear icon for active pipeline only
- **Inline stage management** — "..." menu on each column header for rename, change color, mark as won/lost, delete stage
- **Add stage column** — Dashed placeholder column at the far right of the kanban for quick stage creation
- **Pipeline creation with default stages** — New pipelines auto-include 5 stages (Novo Lead, Qualificado, Proposta, Negociação, Fechado) via new `createBoardWithStages` mutation

#### UI Components
- **EmptyState** — Reusable empty state component with icon, title, description, and action button

#### Bug Fixes
- Fixed null safety in `conversations.ts` and `handoffs.ts` when accessing `lead.contactId` (could crash if contactId was undefined)

## [0.4.1] - 2026-02-14

### Fixed
- Logo distortion in AuthScreen and WelcomeScreen — added `object-contain` to prevent squeezing of non-square (528x488) image in square containers

### Improved
- **WelcomeScreen** is now the primary org selection/creation interface:
  - Displays existing organizations as interactive cards with icon, name, slug, and role badge
  - "Criar Organização" card opens a modal creation form with auto-generated slug
  - Auto-selects newly created org; works on both desktop and mobile
- **OrganizationSelector** simplified to just a `<select>` dropdown for switching orgs in the sidebar — removed buried absolute-positioned popup and inline creation form

## [0.4.0] - 2026-02-14

### HNBCRM Rebrand & Frontend Overhaul

Complete UI transformation from light-theme prototype to dark-theme-first, mobile-first, orange-branded CRM with Portuguese (BR) interface.

#### Brand & Identity
- Rebranded from ClawCRM to **HNBCRM** (Humans & Bots CRM)
- Orange handshake logo with 3 variants (orange/white/black on transparent)
- Updated `index.html`: `lang="pt-BR"`, `class="dark"`, favicon, title "HNBCRM"
- Created `STYLE_GUIDE.md` — comprehensive design system documentation (PT-BR)

#### Design System Foundation
- Rewrote `tailwind.config.js`: `darkMode: 'class'`, brand orange palette (50–900), surface/border/text CSS variable tokens, custom shadows, animations, keyframes
- Rewrote `src/index.css`: CSS custom properties (dark default + `.light` override), auth underline inputs, pill buttons, skeleton shimmer, custom scrollbar, safe-area utility, reduced-motion support
- Created `src/lib/utils.ts` with `cn()` utility (clsx + tailwind-merge)
- Added `lucide-react` for tree-shakeable SVG icons (replacing all emoji icons)

#### UI Component Library (`src/components/ui/`)
- `Button.tsx` — Pill button with 5 variants (primary, secondary, ghost, dark, danger) and 3 sizes
- `Input.tsx` — Bordered form input with label, error state, icon support
- `Badge.tsx` — Semantic status badge (default, brand, success, error, warning, info)
- `Card.tsx` — Dark surface card with 3 variants (default, sunken, interactive)
- `Modal.tsx` — Bottom sheet (mobile) / centered dialog (desktop) with Esc/click-outside
- `SlideOver.tsx` — Full-screen (mobile) / 480px side panel (desktop)
- `Spinner.tsx` — Brand-colored loading spinner with sr-only PT-BR text
- `Skeleton.tsx` — Shimmer loading placeholder (text, circle, card variants)
- `Avatar.tsx` — Initials avatar with AI bot badge and online/busy/offline status dot

#### Layout & Navigation (`src/components/layout/`)
- `AppShell.tsx` — Orchestrates responsive layout (sidebar vs bottom tab bar)
- `Sidebar.tsx` — Desktop fixed left nav, collapsed icons at md, expanded with labels at lg
- `BottomTabBar.tsx` — Mobile fixed bottom tabs (5 main + "Mais" menu for Audit/Settings)

#### App Shell Refactor
- `App.tsx` — Integrated `AppShell`, moved nav out, dark auth screen with orange logo
- `Dashboard.tsx` — Removed inline tab navigation (now handled by AppShell), simplified to content-only renderer

#### Component Restyling (all 13 components)
- Applied dark theme (surface tokens, border tokens, text tokens) to every component
- Translated all user-facing text to Portuguese (BR)
- Replaced all emoji icons with `lucide-react` icons
- Integrated reusable UI components (Button, Badge, Card, Modal, SlideOver, Avatar, Spinner)
- Made responsive: Inbox list/detail toggle on mobile, Kanban snap-scroll, stacked filters
- `SignInForm.tsx` — Underline inputs, pill button, PT-BR auth flow
- `KanbanBoard.tsx` — Dark columns, Badge/Avatar, mobile snap-scroll
- `LeadDetailPanel.tsx` — Uses SlideOver, dark message bubbles, PT-BR forms
- `CreateLeadModal.tsx` — Uses Modal component, dark form styling
- `Inbox.tsx` — Responsive list/detail with mobile toggle, dark message bubbles
- `HandoffQueue.tsx` — Card + Avatar, accept/reject with brand buttons
- `TeamPage.tsx` — Avatar with AI indicator, Modal for add member
- `AuditLogs.tsx` — Dark table with Badge for actions/severity, responsive filters
- `Settings.tsx` — All 5 sub-sections restyled with Modal, pill section tabs
- `OrganizationSelector.tsx` — Dark dropdown, sidebar-compatible
- `ErrorBoundary.tsx` — Dark error state, PT-BR text

#### Developer Tooling
- Created `.claude/agents/frontend-specialist.md` — Sonnet-powered agent for all frontend UI tasks
- Updated `src/CLAUDE.md` — new component tree, dark theme patterns, PT-BR notes

## [0.3.0] - 2026-02-14

### Security & Performance Hardening

#### Auth & Access Control
- Created `convex/lib/auth.ts` with shared `requireAuth()` helper, replacing duplicated 8-line auth boilerplate across all backend files
- Added authentication to `createConversation` and `getOrganizationBySlug` (previously unprotected)
- `getOrganizationBySlug` now returns only safe fields (`_id`, `name`, `slug`) instead of full org settings

#### Query Performance
- Added `limit` argument with `.take()` to `getLeads`, `getConversations`, `getHandoffs` (and internal variants) — default 200, prevents unbounded `.collect()`
- Added `by_organization_and_board` index on leads for efficient board-scoped queries
- Added `by_key_hash_and_active` compound index on apiKeys, eliminating in-memory `isActive` filtering
- `getConversations` now uses `by_lead_and_channel` index when `leadId` is provided instead of full org scan
- Split `getDashboardStats` into 4 focused queries: `getPipelineStats`, `getLeadsBySource`, `getTeamPerformance`, `getDashboardSummary`

#### Webhook Coverage
- Added webhook triggers to `updateLead`, `deleteLead`, `assignLead`, `updateLeadQualification` (and internal variants)
- Added webhook triggers to `acceptHandoff` and `rejectHandoff` (and internal variants)

#### Bug Fixes
- Fixed `rejectHandoff` incorrectly setting `acceptedBy` — now uses `resolvedBy` field
- Added `resolvedBy` field to handoffs schema; set on both accept and reject

#### Frontend Improvements
- Changed `organizationId` prop type from `string` to `Id<"organizations">` across all 12 components, removing unsafe `as` casts
- Replaced `console.error`/`alert` with `toast.error()` for consistent user-facing error handling
- Added `ErrorBoundary` component wrapping all dashboard tab contents
- Fixed `any` types in `Inbox.tsx` message styling and `Settings.tsx` org finder

#### Cleanup
- Renamed package from `flex-template` to `clawcrm`
- Deleted unused `src/lib/utils.ts`
- Typed `router.ts` helper functions — `jsonResponse` accepts `Record<string, unknown>`, typed `.find()` callbacks

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
