# HNBCRM — Future Improvements & Technical Roadmap

**Created:** 2026-02-15
**Current Version:** v0.7.1
**Purpose:** Research-backed catalog of improvements, optimizations, and next-generation features

---

## Table of Contents

1. [Performance Optimizations](#1-performance-optimizations)
2. [Security Hardening](#2-security-hardening)
3. [Code Quality & Technical Debt](#3-code-quality--technical-debt)
4. [Convex Ecosystem Adoption](#4-convex-ecosystem-adoption)
5. [AI-Native Features & RAG](#5-ai-native-features--rag)
6. [MCP Server Improvements](#6-mcp-server-improvements)
7. [Frontend Architecture](#7-frontend-architecture)
8. [Webhook System](#8-webhook-system)
9. [Developer Experience](#9-developer-experience)
10. [Priority Matrix](#10-priority-matrix)

---

## 1. Performance Optimizations

### 1.1 Unbounded `.collect()` Queries

**Problem:** Several queries fetch all records from a table without limits, causing O(n) memory usage and slow queries as data grows.

**Affected files:**
- `convex/dashboard.ts` — `getLeadsBySource` and `getTeamPerformance` use `.collect()` on all org leads
- `convex/contacts.ts` — `getContacts` and `internalGetContacts` have no limit
- `convex/conversations.ts` — conversation fetching loads all conversations per org

**Fix:** Add `.take(limit)` or migrate to cursor-based pagination using `paginationOptsValidator` from Convex. All list queries should accept `limit` and `cursor` arguments.

**Best practice (from Convex docs):** Queries should work with fewer than a few hundred records and aim to finish in less than 100ms.

### 1.2 N+1 Query Patterns

**Problem:** After fetching a list of records, individual lookups are performed for each related record (actor names, lead contacts, assignees).

**Affected files:**
- `convex/dashboard.ts:145-153` — Serial actor lookups for 10 activities = 10 DB calls
- `convex/activities.ts:35-43` — Each of 50 activities triggers an individual actor lookup
- `convex/conversations.ts:46-72` — Each conversation triggers individual lead + contact + assignee lookups

**Fix:** Batch-fetch all related IDs in a single pass:
```
// Instead of: activities.map(a => ctx.db.get(a.actorId))
// Do: Collect unique actorIds, fetch all once, build a Map
const actorIds = [...new Set(activities.map(a => a.actorId).filter(Boolean))];
const actors = await Promise.all(actorIds.map(id => ctx.db.get(id)));
const actorMap = new Map(actors.filter(Boolean).map(a => [a._id, a]));
```

### 1.3 Convex Aggregate & Sharded Counter Components

**Opportunity:** Dashboard stats (pipeline value, lead counts per stage, team performance) currently compute aggregates by fetching all records and counting in-memory.

**Solution:** Use the [`@convex-dev/aggregate`](https://www.convex.dev/components/aggregate) component for pre-computed, scalable COUNT/SUM/MAX operations. For high-write counters (message counts, lead counts), use [`@convex-dev/sharded-counter`](https://www.convex.dev/components/sharded-counter).

**Benefits:**
- O(1) lookups instead of O(n) table scans
- No contention on hot paths (multiple writers to same counter)
- Automatic denormalization with simple interfaces

### 1.4 Cursor-Based Pagination on API Routes

**Problem:** REST API endpoints return all results up to a hardcoded limit (200). No cursor/pagination parameters supported.

**Affected:** `GET /api/v1/leads`, `GET /api/v1/contacts`, `GET /api/v1/conversations`

**Fix:** Accept `limit` and `cursor` query parameters, use Convex `paginationOptsValidator`, return `{ data, nextCursor, isDone }` response format. This is standard REST API practice and required for MCP tool pagination.

### 1.5 Missing Database Indexes

**Problem:** Some common query patterns lack optimized indexes.

| Table | Missing Index | Use Case |
|-------|--------------|----------|
| `activities` | `by_organization_and_created` | Dashboard recent activity sorted by time |
| `auditLogs` | `by_organization_and_actor` | "Audit by actor" admin queries |
| `handoffs` | `by_status_and_created` | Time-sorted handoff queue |

### 1.6 Dashboard Query Consolidation

**Problem:** `getDashboardStats` and `getPipelineStats` duplicate logic — both iterate boards, fetch stages, and aggregate leads.

**Fix:** Consolidate into a single reusable function, or pre-compute stats via scheduled functions that update a `dashboardCache` table on a cron schedule.

---

## 2. Security Hardening

### 2.1 CORS Configuration

**Problem:** `convex/router.ts:11` defaults to `Access-Control-Allow-Origin: *` if `ALLOWED_ORIGIN` env var is not set. Any origin can make API requests.

**Fix:** Fail-secure — if env var is missing, reject all cross-origin requests. In production, explicitly set to the frontend domain(s).

### 2.2 Role-Based Access Control (RBAC)

**Problem:** `requireAuth()` in `convex/lib/auth.ts` only checks org membership. No role-level checks except in `webhooks.ts` and `apiKeys.ts` (manual admin checks).

**Current state:** Schema defines 4 roles (`admin`, `manager`, `agent`, `ai`) but they're largely unused in business logic.

**Fix — Custom Function Wrappers:**

Use the [Convex custom functions pattern](https://stack.convex.dev/custom-functions) (`convex-helpers`) to create middleware-like wrappers:

```typescript
// convex/lib/functions.ts
import { customQuery, customMutation } from "convex-helpers/server/customFunctions";

export const authedQuery = customQuery(query, {
  args: { organizationId: v.id("organizations") },
  input: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    return { ctx: { ...ctx, member }, args };
  },
});

export const adminMutation = customQuery(mutation, {
  args: { organizationId: v.id("organizations") },
  input: async (ctx, args) => {
    const member = await requireAuth(ctx, args.organizationId);
    if (member.role !== "admin") throw new Error("Admin required");
    return { ctx: { ...ctx, member }, args };
  },
});
```

**Benefit:** Eliminates the 8-line auth boilerplate repeated 30+ times across backend files.

### 2.3 API Key Brute-Force Protection

**Problem:** No rate limiting or audit logging for failed API key attempts.

**Fix:** Use [`@convex-dev/ratelimiter`](https://www.convex.dev/components/rate-limiter) component:
- Rate limit API key validation: 10 attempts per minute per IP
- Log failed attempts to audit log with `severity: "warning"`
- After 5 consecutive failures, temporarily block the IP

### 2.4 Scoped API Key Permissions

**Problem:** API keys are all-or-nothing — no permission scoping.

**Fix:** Add `permissions` array to API keys (e.g., `["leads:read", "leads:write", "messages:send"]`). Check permissions in router middleware before executing endpoints. This is in the PRD but not implemented.

### 2.5 Input Validation

**Problem:** REST API endpoints don't validate input beyond basic presence checks. No email format, URL, or phone validation.

**Fix:** Add Zod validation in the router or use [Convex Zod middleware wrappers](https://stack.convex.dev/wrappers-as-middleware-zod-validation) for runtime validation with better error messages.

---

## 3. Code Quality & Technical Debt

### 3.1 Dead Code Removal

**Confirmed dead code (since v0.6.0 router migration):**
- `src/App.tsx` (282 lines) — No longer imported by `main.tsx`
- `src/components/Dashboard.tsx` (82 lines) — Router uses `DashboardOverview` directly

**Action:** Delete both files.

### 3.2 Replace `v.any()` Return Validators

**Problem:** 49 out of ~120 functions use `returns: v.any()`, losing type safety at the Convex boundary.

**Impact:** Frontend receives unvalidated data structures; backend refactoring becomes risky; no TypeScript inference on query returns.

**Files with extensive `v.any()`:**
- `convex/dashboard.ts` — All 4 dashboard queries
- `convex/leads.ts` — `getLeads`, `getLead` + internal variants
- `convex/contacts.ts` — 8 functions
- `convex/conversations.ts` — 4 functions

**Fix:** Replace with specific validators. Start with the most-used queries (leads, contacts, dashboard).

### 3.3 Component Splitting

Large monolithic components that should be split:

| Component | Lines | Recommended Split |
|-----------|-------|-------------------|
| `KanbanBoard.tsx` | 1,151 | Extract `DraggableCard`, `DroppableColumn`, `StageEditPopover`, `AddStageColumn` → `src/components/kanban/` |
| `LeadDetailPanel.tsx` | 1,069 | Extract `ConversationTab`, `DetailsTab`, `ActivityTab` → `src/components/lead/` |
| `Settings.tsx` | 732 | Extract each section (OrgProfile, ApiKeys, CustomFields, LeadSources, Webhooks) → `src/components/settings/` |
| `DashboardOverview.tsx` | 620 | Extract metric cards, activity feed, pipeline widget → `src/components/dashboard/` |
| `ContactDetailPanel.tsx` | 654 | Extract section components |

### 3.4 Extract Shared Utilities

Duplicated patterns that should be extracted to `convex/lib/`:

| Pattern | Currently In | Extract To |
|---------|-------------|------------|
| `diffChanges()` | `contacts.ts:59-77` | `convex/lib/audit.ts` |
| `buildSearchText()` | `contacts.ts:6-15` | `convex/lib/search.ts` |
| Auth boilerplate (8 lines) | 30+ files | `convex/lib/functions.ts` (custom wrappers) |
| Pagination helpers | Various | `convex/lib/pagination.ts` |

### 3.5 Type Safety in Router

**Problem:** `convex/router.ts` uses `any` casts in 25+ places (e.g., `ctx: any`, `board: any`).

**Fix:** Use proper Convex types (`ActionCtx`, `Doc<"tableName">`) throughout.

---

## 4. Convex Ecosystem Adoption

The [Convex components ecosystem](https://www.convex.dev/components) offers production-ready solutions for common patterns. These components should be evaluated for adoption:

### 4.1 AI Agent Framework (`@convex-dev/agent`)

**What it is:** Full-featured AI agent framework with persistent threads, message history, vector/text hybrid search, tool execution, and multi-agent workflows.

**How HNBCRM could use it:**
- Replace the current basic AI team member concept with actual autonomous agents
- Use **Threads** for persistent lead conversation context that agents can pick up
- Use **RAG** to give agents access to conversation history, contact enrichment data, and pipeline context
- Enable **multi-agent workflows**: Qualification Agent → Scheduling Agent → Follow-up Agent
- Built-in **streaming** for real-time AI response generation in the inbox

**Key features:**
- Agents organize LLM prompting with associated models, prompts, and tools
- Threads automatically persist message history and can be shared across agents
- Built-in hybrid vector/text search for messages
- Workflows for durable multi-step operations spanning agents and users
- Supports OpenAI, Anthropic, and other providers via AI SDK

### 4.2 RAG Component (`@convex-dev/rag`)

**What it is:** Document search component for retrieval-augmented generation. Breaks data into chunks, generates embeddings, provides vector search.

**How HNBCRM could use it:**
- Index all lead conversations for semantic search ("find leads discussing enterprise pricing")
- Index contact enrichment data for intelligent matching
- Power the Command Palette (Cmd+K) with semantic search across all entities
- Feed relevant context to AI agents during handoffs and qualification

**Features:** Configurable embedding models, namespaces, custom filtering, importance weighting, chunk context, graceful migrations.

### 4.3 Rate Limiter (`@convex-dev/ratelimiter`)

**What it is:** Application-layer rate limiting with configurable sharding.

**How HNBCRM could use it:**
- Rate limit API key usage (per key, per endpoint)
- Rate limit webhook dispatch to avoid flooding endpoints
- Rate limit AI agent actions (prevent runaway agents)
- Rate limit auth attempts (brute-force protection)

### 4.4 Action Cache (`@convex-dev/action-cache`)

**What it is:** Cache results from expensive external API calls.

**How HNBCRM could use it:**
- Cache contact enrichment API responses (avoid re-fetching same data)
- Cache AI model responses for identical inputs
- Cache webhook endpoint health checks

### 4.5 Workflow Component (`@convex-dev/workflow`)

**What it is:** Long-running flows with retries, delays, and durable execution.

**How HNBCRM could use it:**
- Lead nurturing sequences (send follow-up after 3 days, then 7 days)
- Onboarding drip campaigns
- Multi-step qualification workflows
- Webhook retry with exponential backoff (see Section 8)

### 4.6 Other Relevant Components

| Component | Use Case in HNBCRM |
|-----------|-------------------|
| **Presence** | Real-time "who's online" for team members |
| **Crons (runtime)** | Dynamic scheduled tasks (lead follow-up reminders) |
| **Migrations** | Safe schema migrations without downtime |
| **Stripe** | SaaS billing when ready for monetization |
| **Resend** | Transactional emails (welcome, notifications, handoff alerts) |
| **Expo Push** | Mobile push notifications for handoff alerts |
| **Twilio SMS** | SMS channel integration for lead communication |
| **Action Retrier** | Reliable retry for external API calls (enrichment, webhooks) |

### 4.7 Custom Function Wrappers

**What:** Use `convex-helpers` to create `authedQuery`, `authedMutation`, `adminMutation` wrappers that replace the 8-line auth boilerplate pattern repeated 30+ times.

**Reference:** [Authentication Wrappers as Middleware](https://stack.convex.dev/wrappers-as-middleware-authentication), [Custom Functions](https://stack.convex.dev/custom-functions)

**Benefit:** Reduces each function by ~10 lines, centralizes auth logic, makes RBAC enforcement automatic.

---

## 5. AI-Native Features & RAG

The 2026 CRM market has moved decisively toward AI-native features. Leading platforms (Salesforce, HubSpot, Monday CRM) now offer AI as a core engine, not an add-on. HNBCRM's human-AI collaboration model positions it well, but needs deeper AI capabilities.

### 5.1 RAG-Powered Lead Intelligence

**Concept:** Index all lead data (conversations, activities, enrichment, custom fields) into a vector store. AI agents and the Command Palette query this store for semantic search.

**Implementation path:**
1. Install `@convex-dev/rag` component
2. Index conversations and activities by lead (namespace per org)
3. Generate embeddings on message creation (via action triggered by mutation)
4. Expose semantic search via MCP tool and Cmd+K palette

**Use cases:**
- "Find all leads discussing enterprise pricing in the last month"
- "Which leads mentioned competitor X?"
- Auto-surface relevant past conversations when a new lead shares similar context

### 5.2 AI Co-Pilot Mode

**Concept:** AI generates draft responses that humans review and approve before sending.

**Implementation:**
- New message state: `draft` (AI-generated, awaiting human approval)
- AI drafts appear in the conversation with "Approve / Edit / Reject" buttons
- Human can one-click approve or edit before sending
- Track approval rates for model quality monitoring

**2026 industry trend:** By mid-2026, most leading CRM vendors offer native agent frameworks. Unlike copilots (which require user prompts), agents act on signals — moving a deal forward, initiating outreach, or escalating when thresholds are met.

### 5.3 Conversation Summarization

**Concept:** Auto-generate context summaries for leads, especially during handoffs.

**Implementation:**
- Trigger summarization when: handoff requested, lead idle >3 days, AI agent picks up lead
- Store summaries as internal messages with `senderType: "system"`
- Use the Convex Agent component for structured summarization with tool calls

### 5.4 Predictive Lead Scoring

**Concept:** Score leads based on engagement signals, conversation patterns, and historical outcomes.

**Signals to score:**
- Message frequency and recency
- Response time (lead's and team's)
- Conversation sentiment (if analysis added)
- Stage progression velocity
- Contact completeness (enrichment gaps)
- Similar leads that closed (via RAG similarity search)

**Implementation:** Convex scheduled function runs daily, computes scores, stores as `qualificationData.score`.

### 5.5 Next-Best-Action Recommendations

**Concept:** AI recommends the next step for each lead based on context.

**Examples:**
- "Lead has been in Proposal stage for 7 days — suggest scheduling a follow-up call"
- "Contact lacks phone number — suggest enrichment"
- "Similar lead converted after sending case study — suggest sending case study"

**Implementation:** Combine lead state, activity history, and RAG-retrieved similar outcomes. Surface recommendations in the lead detail panel and dashboard.

### 5.6 Intelligent Auto-Assignment

**Concept:** Go beyond round-robin. Match leads to agents based on capabilities, language, channel expertise, workload, and historical success.

**Strategies (from PRD, not yet implemented):**
- Round-robin among available agents
- By channel (WhatsApp leads → WhatsApp-specialized agent)
- By capability tags (e.g., `"portuguese"`, `"enterprise"`)
- Least loaded (fewest active leads)
- By success rate (agents with best conversion rates for similar leads)

---

## 6. MCP Server Improvements

### 6.1 Streaming Tool Results

**Problem:** Tools return complete results synchronously. Large datasets (conversation history) cause timeouts.

**Fix:** Implement MCP streaming with `CallToolResultBlockDelta` for progressive result delivery. Particularly important for `crm_get_messages` and `crm_list_leads`.

### 6.2 MCP Prompts

**Problem:** No MCP prompts registered. AI clients don't get guided templates.

**Add prompts:**
- `qualify_lead` — "Qualify this lead using BANT framework, then update the qualification data"
- `summarize_for_handoff` — "Summarize the conversation history for a human handoff"
- `suggest_next_action` — "Based on lead status and history, suggest the next best action"
- `enrich_contact` — "Identify missing contact fields and suggest enrichment sources"

### 6.3 Pagination in Tools

**Problem:** `crm_list_leads`, `crm_list_contacts` don't accept cursor/limit parameters.

**Fix:** Add `cursor` and `limit` input parameters to all list tools. Return `nextCursor` in results.

### 6.4 Deferred Tool Loading

**New MCP feature (2026):** Tools can be marked with `defer_loading: true`, excluding them from the initial prompt. The AI searches for them only when needed.

**Benefit:** HNBCRM exposes 23 tools. With deferred loading, only frequently-used tools load initially, reducing prompt size and improving model accuracy.

### 6.5 OAuth 2.0 Support

**MCP 2026 spec:** OAuth 2.0 is now the standard auth flow. Current HNBCRM MCP uses API key env vars.

**Fix:** Implement OAuth flow per MCP specification with scope-based permissions per tool (read vs. write).

### 6.6 Error Handling Improvements

**Problem:** `client.ts` catches errors generically. No retry, no timeout, no status code differentiation.

**Fix:**
- Add timeout handling (10s default)
- Differentiate 401 (auth) vs 404 (not found) vs 429 (rate limit) vs 500 (server error)
- Add retry with backoff for transient failures (5xx, network errors)
- Provide actionable error messages to AI clients

### 6.7 Resource Templates

**Add MCP resource templates:**
- `hnbcrm://leads/{leadId}` — Full lead data with recent conversation
- `hnbcrm://leads/{leadId}/conversation` — Complete conversation history
- `hnbcrm://boards/{boardId}/summary` — Pipeline summary with counts and values per stage

---

## 7. Frontend Architecture

### 7.1 Route-Level Code Splitting

**Problem:** All page components are bundled together. A user visiting the landing page downloads the entire app.

**Fix:** Use [react-router v7.5 lazy loading](https://remix.run/blog/faster-lazy-loading):

```typescript
// src/main.tsx
{
  path: "pipeline",
  lazy: {
    Component: () => import("@/components/KanbanBoard").then(m => ({ default: m.default })),
  },
}
```

**Priority targets (by bundle size):**
- `KanbanBoard.tsx` (1,151 lines) — only needed on pipeline route
- `LeadDetailPanel.tsx` (1,069 lines) — lazy load on lead click
- `DevelopersPage.tsx` (824 lines) — public page, separate chunk
- `LandingPage.tsx` (804 lines) — only for unauthenticated users
- `Settings.tsx` (732 lines) — rarely visited

**Benchmark guidance:** Target anything above 30-50 KB that doesn't render in the first viewport.

### 7.2 List Virtualization

**Problem:** Contact pickers, assignee dropdowns, and lead lists render all items. With 1000+ contacts, this causes jank.

**Fix:** Install `@tanstack/react-virtual` for windowed rendering:
- Contact picker in `LeadDetailPanel` (line 622)
- Assignee picker in `LeadDetailPanel` (line 696)
- Contact list in `ContactsPage`
- Message list in conversation thread (for leads with 500+ messages)

### 7.3 Accessibility (WCAG 2.2)

**Current gaps:**
- No focus trapping in Modal/SlideOver (focus escapes to background)
- Custom dropdowns lack ARIA roles (`role="listbox"`, `role="option"`)
- Some icon-only buttons missing `aria-label`
- `window.confirm()` used instead of accessible confirmation dialog
- No focus restoration after modal close
- No route change announcements for screen readers

**Priority fixes:**
1. Add focus trap to Modal and SlideOver (use `react-focus-lock` or manual implementation)
2. Replace `window.confirm()` with accessible `ConfirmDialog` component
3. Add `aria-live="polite"` region for route change announcements
4. Ensure all interactive elements are `<button>` not `<div onClick>`

**Accessible component libraries to evaluate:** [React Aria](https://react-spectrum.adobe.com/react-aria/) (Adobe), [Radix UI](https://www.radix-ui.com/), [Headless UI](https://headlessui.com/) — provide unstyled, accessible primitives with keyboard navigation and focus management built in.

### 7.4 Tailwind CSS v4 Migration

**What's new in v4:**
- CSS-first configuration (`@theme` directive instead of `tailwind.config.js`)
- Lightning CSS engine — full builds 5x faster, incremental builds 100x faster
- Native CSS variables for theming (HNBCRM already uses CSS vars — good alignment)
- Container queries in core (no plugin needed)
- 3D transform utilities
- OKLCH colors (more vibrant, uniform color space)

**Migration path:** Tailwind provides an [automated upgrade tool](https://tailwindcss.com/docs/upgrade-guide) that handles config migration. HNBCRM's CSS variable-based design system aligns well with v4's CSS-first approach.

**Consideration:** v4 requires Safari 16.4+, Chrome 111+, Firefox 128+. Verify target audience compatibility.

### 7.5 React Compiler

**What:** React 19's compiler (Babel plugin) automatically memoizes components and hooks, eliminating manual `useMemo`, `useCallback`, `React.memo` usage.

**Benefit:** HNBCRM currently has inconsistent memoization — some components memoize, others don't. The compiler would handle this automatically based on the Rules of React.

**Action:** Add `babel-plugin-react-compiler` to Vite config and remove manual memoization calls.

### 7.6 Missing UI Components

Components that should be extracted from inline implementations:

| Component | Currently | Should Be |
|-----------|-----------|-----------|
| `ConfirmDialog` | `window.confirm()` in KanbanBoard | `src/components/ui/ConfirmDialog.tsx` |
| `DropdownMenu` | Inline positioned divs | `src/components/ui/DropdownMenu.tsx` |
| `SearchableSelect` | Custom inline in LeadDetailPanel | `src/components/ui/SearchableSelect.tsx` |
| `Tooltip` | Only `BantInfoTooltip` exists | `src/components/ui/Tooltip.tsx` |
| `Tabs` | Inline tab implementations | `src/components/ui/Tabs.tsx` |
| `Pagination` | No UI component | `src/components/ui/Pagination.tsx` |

---

## 8. Webhook System

### 8.1 Retry with Exponential Backoff + Jitter

**Problem:** Webhooks are fire-and-forget (`convex/nodeActions.ts`). If the endpoint is temporarily down, the event is lost.

**Best practice:** Exponential backoff with jitter:
- Attempt 1: immediate
- Attempt 2: ~1 minute (+ random jitter)
- Attempt 3: ~5 minutes
- Attempt 4: ~30 minutes
- Attempt 5: ~2 hours
- After 5 failures: move to dead letter queue

**Implementation with Convex:**

Option A — Use [`@convex-dev/action-retrier`](https://www.convex.dev/components/action-retrier) component for built-in retry logic.

Option B — Use [`@convex-dev/workflow`](https://www.convex.dev/components/workflow) for the full retry flow with state tracking.

Option C — Manual implementation with `ctx.scheduler.runAfter(delay, ...)`:
```typescript
// Schedule retry with exponential backoff
const delays = [0, 60_000, 300_000, 1_800_000, 7_200_000]; // 0, 1m, 5m, 30m, 2h
if (attempt < delays.length) {
  await ctx.scheduler.runAfter(delays[attempt], internal.nodeActions.retryWebhook, {
    webhookId, payload, attempt: attempt + 1
  });
}
```

### 8.2 Dead Letter Queue

**Concept:** Events that exhaust all retry attempts are stored in a `webhookDeadLetters` table for manual review and replay.

**Fields:** `webhookId`, `event`, `payload`, `attempts`, `lastError`, `lastAttemptAt`, `status` (pending/replayed/discarded)

**UI:** Add "Failed Deliveries" tab in Settings > Webhooks with replay button.

### 8.3 Webhook Delivery Dashboard

**Add to Settings > Webhooks:**
- Delivery success/failure rate per webhook
- Last 50 delivery attempts with status codes
- Average response time
- Retry history per event

### 8.4 Webhook Timeout

**Problem:** No timeout on `fetch()` in `nodeActions.ts`. Webhook could hang indefinitely.

**Fix:** Add 10-second timeout using `AbortController`:
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
await fetch(url, { ...options, signal: controller.signal });
clearTimeout(timeout);
```

---

## 9. Developer Experience

### 9.1 ESLint Configuration

**Problem:** No ESLint configured. Only TypeScript checking via `tsc`.

**Add rules for:**
- React Hooks (`eslint-plugin-react-hooks`) — enforce Rules of Hooks
- Accessibility (`eslint-plugin-jsx-a11y`) — catch a11y violations at lint time
- Import sorting (`eslint-plugin-import`) — consistent import order
- Unused imports/variables — catch dead code early

### 9.2 Testing with Convex Test Framework

**Problem:** No tests exist. CLAUDE.md notes "No test framework is configured."

**Opportunity:** Convex provides a [testing library](https://stack.convex.dev/testing-patterns) that mocks the backend:
- Test mutations (create lead, move stage, accept handoff) in isolation
- Test query results for correctness
- Test auth/RBAC enforcement
- Test webhook triggers
- Tests execute fast (no real backend needed)

**Priority test targets:**
1. Auth helper (`requireAuth`) — test membership, rejection, edge cases
2. Lead mutations — create, move, assign, qualification
3. Handoff workflow — request, accept, reject
4. API key validation — hash, lookup, expired keys
5. Dashboard queries — verify aggregation correctness

### 9.3 CI Pipeline

**Current:** Only `npm run lint` (tsc + convex deploy --once + vite build).

**Add:**
- ESLint check
- Unit tests (once test framework added)
- Bundle size check (fail if build exceeds threshold)
- Type coverage report
- Accessibility audit (axe-core)

### 9.4 Pre-Commit Hooks

**Add `husky` + `lint-staged`:**
- Run ESLint on changed `.ts`/`.tsx` files
- Run TypeScript check on changed files
- Prevent committing `console.log` statements
- Check for `any` type usage in new code

### 9.5 API Documentation Generation

**Current:** Manual docs in `llmsTxt.ts` and `DevelopersPage.tsx`. Must update manually when endpoints change.

**Improvement:** Generate API docs from router endpoint definitions. Each endpoint already has a predictable structure — extract metadata and generate docs automatically.

**Also missing from llms.txt:**
- Code examples (curl, JavaScript)
- Error code reference (400 vs 404 vs 401 vs 422)
- Rate limiting documentation
- Field validation rules
- Webhook signature verification examples

---

## 10. Priority Matrix

### Immediate Impact (do first)

| Improvement | Effort | Impact | Section |
|-------------|--------|--------|---------|
| Delete dead code (`App.tsx`, `Dashboard.tsx`) | 5 min | Low | 3.1 |
| Fix CORS to fail-secure | 15 min | High | 2.1 |
| Add `.take(limit)` to unbounded queries | 1 hour | High | 1.1 |
| Add missing database indexes | 30 min | Medium | 1.5 |
| Add webhook fetch timeout | 15 min | Medium | 8.4 |

### High Value (next sprint)

| Improvement | Effort | Impact | Section |
|-------------|--------|--------|---------|
| Custom function wrappers (auth middleware) | 2 hours | High | 4.7 |
| Replace `v.any()` validators (top 10 queries) | 3 hours | High | 3.2 |
| Route-level code splitting | 2 hours | Medium | 7.1 |
| Batch N+1 query fixes | 2 hours | High | 1.2 |
| Rate limiter component | 1 hour | High | 4.3 |
| ESLint setup | 1 hour | Medium | 9.1 |

### Strategic (plan for)

| Improvement | Effort | Impact | Section |
|-------------|--------|--------|---------|
| Convex Agent framework integration | 1-2 weeks | Very High | 4.1 |
| RAG component for semantic search | 1 week | Very High | 5.1 |
| AI co-pilot mode | 1 week | High | 5.2 |
| Webhook retry + dead letter queue | 3 days | Medium | 8.1-8.2 |
| Component splitting (Kanban, LeadDetail, Settings) | 1 week | Medium | 3.3 |
| Accessibility fixes (WCAG 2.2) | 1 week | Medium | 7.3 |
| Convex test framework | 1 week | Medium | 9.2 |
| Tailwind v4 migration | 2 days | Low | 7.4 |
| MCP prompts + streaming | 3 days | Medium | 6.1-6.2 |

### Future (roadmap)

| Improvement | Effort | Impact | Section |
|-------------|--------|--------|---------|
| Predictive lead scoring | 2 weeks | High | 5.4 |
| Next-best-action recommendations | 2 weeks | High | 5.5 |
| Conversation summarization | 1 week | Medium | 5.3 |
| Intelligent auto-assignment | 1 week | Medium | 5.6 |
| MCP OAuth 2.0 | 3 days | Medium | 6.5 |
| Aggregate/Sharded Counter components | 3 days | Medium | 1.3 |

---

## Sources

- [Convex Best Practices](https://docs.convex.dev/understanding/best-practices/)
- [Convex Components Ecosystem](https://www.convex.dev/components)
- [Convex AI Agents](https://docs.convex.dev/agents)
- [Convex RAG Component](https://docs.convex.dev/agents/rag)
- [Convex Custom Functions](https://stack.convex.dev/custom-functions)
- [Convex Auth Wrappers](https://stack.convex.dev/wrappers-as-middleware-authentication)
- [Convex Testing Patterns](https://stack.convex.dev/testing-patterns)
- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Best Practices](https://mcp-best-practice.github.io/mcp-best-practice/best-practice/)
- [MCP in Production (2026)](https://bytebridge.medium.com/what-it-takes-to-run-mcp-model-context-protocol-in-production-3bbf19413f69)
- [React Router v7 Lazy Loading](https://remix.run/blog/faster-lazy-loading)
- [React Performance Optimization (2025)](https://www.growin.com/blog/react-performance-optimization-2025/)
- [Tailwind CSS v4 Upgrade Guide](https://tailwindcss.com/docs/upgrade-guide)
- [Tailwind v4 Complete Guide](https://devtoolbox.dedyn.io/blog/tailwind-css-v4-complete-guide)
- [AI-Native CRM Guide (2026)](https://www.folk.app/articles/ai-native-crm)
- [2026 CRM Trends](https://www.siroccogroup.com/2026-crm-trends-twelve-practical-shifts-for-revenue-operations/)
- [RAG in CRM (Salesforce)](https://www.salesforce.com/agentforce/what-is-rag/)
- [Webhook Retry Best Practices (Svix)](https://www.svix.com/resources/webhook-best-practices/retries/)
- [Webhook Retry Patterns (Hookdeck)](https://hookdeck.com/webhooks/guides/webhook-retry-best-practices)
- [WCAG 2.2 Accessibility Guide](https://www.allaccessible.org/blog/react-accessibility-best-practices-guide)
- [SPA Accessibility (TestParty)](https://testparty.ai/blog/spa-accessibility)
- [Convex Aggregate Component](https://stack.convex.dev/efficient-count-sum-max-with-the-aggregate-component)

---

*This document is a research reference for planning future development. Items should be moved to the active roadmap in `docs/PROJECT-STATUS.md` as they are prioritized and scheduled.*
