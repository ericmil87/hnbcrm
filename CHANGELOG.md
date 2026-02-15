# Changelog

All notable changes to HNBCRM (formerly ClawCRM) will be documented in this file.

## [0.10.0] - 2026-02-15

### Audit Logs Overhaul — Human-Readable, Filterable, Agent-Friendly

Complete redesign of the audit log system: server-generated PT-BR descriptions, 6 filter dimensions with compound indexes, cursor-based pagination, expandable before/after diffs, and a world-class frontend inspired by Linear/Stripe/WorkOS.

#### Schema & Indexes (`convex/schema.ts`)
- Added `description` optional field to `auditLogs` table — server-generated PT-BR summary
- 4 new compound indexes for filtered queries: `by_organization_and_entity_type_and_created`, `by_organization_and_action_and_created`, `by_organization_and_severity_and_created`, `by_organization_and_actor_and_created`

#### Description Builder (`convex/lib/auditDescription.ts`)
- New `buildAuditDescription()` pure function — maps actions to PT-BR past-tense verbs and entity types to gendered articles
- Special handling for move (stage names), assign (assignee name), handoff (from/to member names)
- Examples: "Criou o lead 'João Silva'", "Moveu o lead 'Maria' de 'Prospecção' para 'Qualificação'"

#### Backend Query Rewrite (`convex/auditLogs.ts`)
- `getAuditLogs` rewritten — cursor-based pagination (replaces offset), 6 filter args (severity, entityType, action, actorId, startDate, endDate), smart index selection (priority: actorId > entityType > action > severity > org+created)
- New `getAuditLogFilters` query — returns actors, all 13 entity types, all 6 actions for filter dropdowns
- New `internalGetAuditLogs` — same logic for HTTP API layer
- Actor enrichment: `actorName`, `actorAvatar`, `actorMemberType`

#### Mutation File Updates (52 sites across 14 files)
- All `ctx.db.insert("auditLogs", ...)` calls now include `description` field via `buildAuditDescription`
- Enriched metadata: leads.ts moves include `fromStageName`/`toStageName`, assigns include `assigneeName`, handoffs include lead title + member names
- Files: leads, contacts, handoffs, boards, webhooks, leadSources, fieldDefinitions, organizations, teamMembers, conversations, savedViews, onboarding, apiKeys, seed

#### HTTP API (`convex/router.ts`)
- New `GET /api/v1/audit-logs` endpoint with all query params (entityType, action, severity, actorId, startDate, endDate, cursor, limit)

#### Frontend Redesign (`src/components/AuditLogs.tsx`)
- Date grouping (Hoje, Ontem, Esta Semana, Este Mês, Anteriores) with group headers
- 6 filter dropdowns (actor, action, entity type, severity) + date presets (24h, 7d, 30d, custom)
- Active filter chips with individual/bulk clear
- Expandable log rows with before/after diff table (responsive 3-col desktop, stacked mobile)
- Entity-type icons, action badges, severity dots, actor avatars with AI indicator
- Skeleton shimmer loading, contextual empty states
- Cursor-based pagination (next/prev with cursor stack)
- CSV export with UTF-8 BOM and PT-BR headers
- Client-side PT-BR fallback for old logs without server `description`

## [0.9.0] - 2026-02-15

### MCP Server Improvements & New API Endpoints

Major upgrade to the MCP server: 7 new tools (19→26), 1 new resource (3→4), 5 new REST API endpoints (23→28), SDK upgrade, structured error handling, and expanded field coverage.

#### MCP SDK & Infrastructure
- **SDK upgrade** — `@modelcontextprotocol/sdk` `^1.12.1` → `^1.26.0`
- **Structured error handling** — All 26 tools wrapped in try/catch with `isError: true` responses instead of raw exceptions
- **`errorResult()` / `successResult()` helpers** — New `mcp-server/src/utils.ts` for consistent MCP response formatting
- **Tool annotations** — All tools annotated with `readOnlyHint`, `destructiveHint`, `idempotentHint` per MCP spec

#### New MCP Tools (7 added)
- **`crm_enrich_contact`** — Write enrichment data to a contact with source/confidence tracking
- **`crm_get_contact_gaps`** — Get which contact fields are missing (guides AI research)
- **`crm_search_contacts`** — Full-text search on contacts by name, email, or company
- **`crm_reject_handoff`** — Reject a pending handoff with optional feedback
- **`crm_get_activities`** — Get activity timeline for a lead
- **`crm_create_activity`** — Log notes, calls, or emails on a lead
- **`crm_get_dashboard`** — Pipeline analytics overview (stage distribution, team performance, pending handoffs)

#### New MCP Resource
- **`hnbcrm://lead-sources`** — Lead source reference data for setting correct source on new leads

#### Expanded Contact Field Coverage
- `crm_create_contact` and `crm_update_contact` now expose 17 additional fields: `tags`, `whatsappNumber`, `telegramUsername`, `bio`, `linkedinUrl`, `instagramUrl`, `facebookUrl`, `twitterUrl`, `city`, `state`, `country`, `industry`, `companySize`, `cnpj`, `companyWebsite`, `acquisitionChannel`, `customFields`

#### New REST API Endpoints (5 added)
- `GET /api/v1/activities?leadId={id}&limit={n}` — Activity timeline for a lead
- `POST /api/v1/activities` — Create activity (note, call, email_sent) on a lead
- `GET /api/v1/dashboard` — Full dashboard analytics (pipeline stats, sources, team, handoffs)
- `GET /api/v1/contacts/search?q={text}&limit={n}` — Full-text contact search
- `GET /api/v1/lead-sources` — List configured lead sources

#### Backend Internal Functions (4 added)
- `convex/activities.ts` — `internalGetActivities`, `internalCreateActivity`
- `convex/dashboard.ts` — `internalGetDashboardStats`
- `convex/contacts.ts` — `internalSearchContacts`
- `convex/leadSources.ts` — `internalGetLeadSources`

## [0.8.0] - 2026-02-15

### Backend Performance & Query Optimization

Eliminates N+1 query patterns, adds query bounds to all unbounded `.collect()` calls, replaces `.filter()` with compound indexes, and adds pagination support to REST API endpoints.

#### Batch Fetch Utility (`convex/lib/batchGet.ts`)
- New `batchGet()` helper — deduplicates IDs, fetches in parallel, returns `Map` for O(1) lookup
- Replaces `Promise.all(items.map(async => ctx.db.get(...)))` N+1 patterns across 7 backend files

#### N+1 Query Elimination
- **activities.ts** — Batch actor name resolution
- **auditLogs.ts** — Batch actor name resolution
- **contacts.ts** — Batch stage + assignee lookup for contact leads
- **conversations.ts** — Batch lead + contact + assignee lookup (public + internal)
- **dashboard.ts** — Batch actor names in activity feeds
- **handoffs.ts** — Batch lead + member + contact lookup (public + internal)
- **leads.ts** — Batch contact + stage + assignee lookup (public + internal)

#### Unbounded Query Bounds (`.collect()` → `.take(N)`)
- **auditLogs** — `.take(500)`
- **boards/stages** — `.take(100)`
- **contacts** — `.take(500)`, leads per contact `.take(100)`
- **messages** — `.take(500)`
- **dashboard leads** — `.take(2000)`, handoffs `.take(200)`
- **fieldDefinitions** — `.take(100)`
- **leadSources** — `.take(100)`
- **organizations** — `.take(50)` on user orgs
- **savedViews** — `.take(100)`
- **teamMembers** — `.take(200)`
- **webhooks/webhookTrigger** — `.take(100)`

#### Compound Index Migration (`.filter()` → `.withIndex()`)
- New `by_organization_and_user` index on `teamMembers` — used in `requireAuth()` and 12+ auth checks across activities, apiKeys, auditLogs, fieldDefinitions, leadSources, teamMembers, webhooks
- Eliminates in-memory `.filter(q => q.eq(q.field("userId"), userId))` pattern

#### New Schema Indexes (`convex/schema.ts`)
- `teamMembers.by_organization_and_user` — compound auth lookups
- `handoffs.by_status_and_created` — time-sorted handoff queues
- `activities.by_organization_and_created` — dashboard activity feeds
- `auditLogs.by_organization_and_actor` — actor-scoped audit queries

#### REST API Pagination (`convex/router.ts`)
- `GET /api/v1/leads` — accepts `limit` param (max 500), returns `hasMore`
- `GET /api/v1/contacts` — accepts `limit` param (max 500), returns `hasMore`
- `GET /api/v1/conversations` — accepts `limit` param (max 500), returns `hasMore`
- `GET /api/v1/handoffs` — accepts `limit` param (max 500), returns `hasMore`
- `internalGetContacts` now accepts optional `limit` argument

#### Documentation
- **docs/GOING-PUBLIC.md** — Checklist for making the repository public (secrets audit, .gitignore, rename, visibility)
- **docs/IMPROVEMENTS.md** — Technical roadmap: performance, security, AI features, MCP, frontend, webhooks, DX

## [0.7.1] - 2026-02-15

### Fixed — Mobile Auto-Zoom on Input Focus

Prevents iOS Safari auto-zoom when tapping form inputs (triggered by `font-size < 16px`).

- **Viewport meta** (`index.html`) — Added `maximum-scale=1.0, user-scalable=no` to prevent auto-zoom and pinch-zoom
- **CSS** (`src/index.css`) — Added `touch-action: manipulation` on `html` to prevent double-tap zoom
- **Input.tsx** — Changed `text-sm` → `text-base md:text-sm` (16px on mobile, 14px on desktop)
- **Settings.tsx** — Two `<select>` elements: `text-sm` → `text-base md:text-sm`
- **CustomFieldsRenderer.tsx** — `inputClass`: `text-sm` → `text-base md:text-sm`

## [0.7.0] - 2026-02-15 (continued)

### Documentation Overhaul

Rewrites all documentation to professional open-source standards.

- **README.md** — Full rewrite: logo header, badges, features list, tech stack table, quick start, project structure, API & integrations section
- **LICENSE** — Added MIT license
- **CONTRIBUTING.md** — Added contribution guide with setup instructions, code style, PR process, commit conventions
- **mcp-server/README.md** — Removed PT-BR duplicate section, fixed GitHub URLs, added license link
- **convex/README.md** — Replaced generic Convex boilerplate with project-specific backend guide (file layout, auth, REST API)
- **CLAUDE.md** — Removed redundant Skills and Agents sections (auto-discoverable)
- **src/CLAUDE.md** — Added DevelopersPage to structure tree, removed Path Alias and Key Dependencies sections
- **convex/CLAUDE.md** — Added llmsTxt.ts and onboarding files to file layout table
- **vercel.json** — Added SPA routing rewrite for Vercel deployment
- **README.md** — Added Deploy section (Vercel + Convex production)
- **CONTRIBUTING.md** — Added environment variables section

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
