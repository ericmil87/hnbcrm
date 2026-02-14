# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Start frontend (Vite) + backend (Convex) in parallel
npm run dev:frontend     # Start only Vite dev server
npm run dev:backend      # Start only Convex dev server
npm run build            # Build frontend (vite build)
npm run lint             # Full check: tsc (convex + app) → convex dev --once → vite build
npx convex dev --once    # Push schema/functions to Convex without watching
```

No test framework is configured. Seed data is available via `convex/seed.ts`.

## Architecture

Multi-tenant CRM with human-AI team collaboration. Convex backend, React + TailwindCSS frontend.

**Multi-tenancy:** Every table has `organizationId`. All queries must be scoped to the user's org.

**Auth flow:** `getAuthUserId(ctx)` → lookup teamMember via `by_organization` index → check role (`admin` | `manager` | `agent` | `ai`).

**Side effects in mutations:** Most mutations insert into `activities` + `auditLogs` and trigger webhooks via `ctx.scheduler.runAfter(0, internal.webhookTrigger.triggerWebhooks, ...)`.

**HTTP API:** `convex/router.ts` has RESTful endpoints at `/api/v1/` authenticated via `X-API-Key` header. Routes wired in `convex/http.ts`.

**Frontend:** Single-page app, no router. `src/main.tsx` → `ConvexAuthProvider` → `App.tsx` → `Dashboard.tsx` (tab nav: Dashboard, Pipeline, Inbox, Handoffs, Team, Audit, Settings). State is Convex reactive queries + local `useState`. Path alias `@/` → `src/`.

## Convex Rules (mandatory)

Rules from `.cursor/rules/convex_rules.mdc` and `.claude/convex-agent-plugins/rules/`:

- **Always** use new function syntax: `query({ args: {}, returns: v.null(), handler: async (ctx, args) => {} })`
- **Always** include `args` and `returns` validators on every function
- **Never** use `.filter()` on queries — use `.withIndex()` instead
- **Never** use `Date.now()` inside queries — breaks reactivity
- **Never** schedule `api.*` functions — only schedule `internal.*` functions
- Use `internalQuery`/`internalMutation`/`internalAction` for non-public functions
- Actions using Node.js APIs must include `"use node";` directive and be in a separate file
- Use `ctx.db.patch` for partial updates, `ctx.db.replace` for full replacement
- Index naming: `by_<field>` or `by_<field1>_and_<field2>`
- Use `"skip"` pattern: pass `"skip"` to `useQuery` when args aren't ready
- Keep query/mutation handlers thin — extract business logic into plain TypeScript functions
- Use cursor-based pagination (`paginationOptsValidator`) for large datasets

## Available Skills

Invoke via Skill tool with `convex-agent-plugins:<name>`:

- **schema-builder** — Design schemas with validation, indexes, relationships
- **function-creator** — Create queries/mutations/actions with proper auth and validation
- **migration-helper** — Plan and execute safe schema migrations
- **auth-setup** — Set up authentication and access control patterns
- **convex-helpers-guide** — Use `convex-helpers` utilities (relationships, custom functions, filters)
- **components-guide** — Feature encapsulation with Convex components
- **convex-quickstart** — Initialize Convex from scratch

## Available Agents

- **convex-reviewer** — Review Convex code for security, performance, and anti-patterns
- **convex-advisor** — Recommend Convex patterns for backend/real-time needs
