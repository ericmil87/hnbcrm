# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Start frontend (Vite) + backend (Convex) in parallel
npm run dev:frontend     # Start only Vite dev server
npm run dev:backend      # Start only Convex dev server
npm run build            # Build frontend (vite build)
npm run convert-images   # Convert PNG images to WebP format
npm run lint             # Full check: tsc (convex + app) → convex dev --once → vite build
npx convex dev --once    # Push schema/functions to Convex without watching
```

No test framework is configured. Seed data is available via `convex/seed.ts`.

## Architecture

Multi-tenant CRM with human-AI team collaboration. Convex backend, React + TailwindCSS frontend.

**Multi-tenancy:** Every table has `organizationId`. All queries must be scoped to the user's org.

**Auth flow:** `requireAuth(ctx, organizationId)` from `convex/lib/auth.ts` handles auth + org membership. Returns the team member. `requirePermission(ctx, organizationId, category, level)` extends this with granular RBAC checks. A few functions without org context (e.g. `getUserOrganizations`) still use `getAuthUserId` directly.

**Permissions (RBAC):** 9 permission categories (leads, contacts, inbox, tasks, reports, team, settings, auditLogs, apiKeys) with hierarchical levels. Defined in `convex/lib/permissions.ts`. Each role (admin, manager, agent, ai) has sensible defaults; admins can override per-member. Frontend uses `usePermissions(organizationId)` hook and `<PermissionGate>` component.

**Invite flow:** Admins invite humans via `inviteHumanMember` action (creates auth account with bcrypt-hashed temp password). New users must change password on first login (`mustChangePassword` flag). Users auto-linked to org via `afterUserCreatedOrUpdated` auth callback.

**Side effects in mutations:** Most mutations insert into `activities` + `auditLogs` and trigger webhooks via `ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, ...)`.

**Email/Notifications:** `@convex-dev/resend` component for email delivery. Central dispatch via `convex/email.ts` — all events go through `internal.email.dispatchNotification`. Templates in `convex/emailTemplates.ts` (PT-BR). Per-member preferences in `notificationPreferences` table (opt-out model — no row means all enabled). Convex components registered in `convex/convex.config.ts`. **Email env vars:** `RESEND_API_KEY`, `APP_URL`, `RESEND_FROM_EMAIL` (default: `HNBCRM <noreply@mail.hnbcrm.com>`), `RESEND_WEBHOOK_SECRET`. Domain: `mail.hnbcrm.com` (subdomain to avoid Gmail MX conflict).

**HTTP API:** `convex/router.ts` has RESTful endpoints at `/api/v1/` authenticated via `X-API-Key` header. API keys resolve permissions from key → team member → role defaults. Routes wired in `convex/http.ts`.

**Frontend:** SPA with react-router v7. Dark theme default, mobile-first, PT-BR UI. `src/main.tsx` → `HelmetProvider` → `ConvexAuthProvider` → `RouterProvider`. Public routes: `/` (LandingPage), `/entrar` (AuthPage). App routes: `/app/*` wrapped by `AuthLayout` → `ScrollRestoration` → `AppShell` → `<Outlet />`. Page components get `organizationId` via `useOutletContext`. Reusable UI in `src/components/ui/`, layout in `src/components/layout/`. State is Convex reactive queries + local `useState`. Path alias `@/` → `src/`.

**Build optimizations:** Vite configured with manual chunking (react-vendor, convex-vendor, utils-vendor, icons-vendor), lazy loading for authenticated routes via React.lazy(), gzip/brotli compression, and bundle visualization (rollup-plugin-visualizer). Initial bundle: ~157 KB brotli (77% reduction from 1 MB baseline).

**SEO:** react-helmet-async for dynamic meta tags, Open Graph + Twitter Cards, JSON-LD structured data, sitemap.xml, robots.txt. Reusable `<SEO />` component in `src/components/SEO.tsx`.

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
