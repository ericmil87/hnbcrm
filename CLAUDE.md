# CLAUDE.md

HNBCRM: multi-tenant CRM where humans and AI agents work as one team. Backend **Convex** (TypeScript), frontend **React 19 + Vite + TailwindCSS + react-router v7**, tests **vitest + convex-test**, deploy **Vercel** (front) + Convex Cloud. UI language is **Brazilian Portuguese**; code, identifiers and this file are English. Detailed decisions and measured gotchas live in `docs/architecture/` (index: `docs/architecture/README.md`) and load on demand via `.claude/rules/`. Do not grow this file: new feature → one paragraph in `docs/architecture/<area>.md`, at most a few bullets in `.claude/rules/<area>.md`.

## Layout

- `convex/` backend (≈200 modules; pure helpers in `convex/lib/`; tests `convex/**/*.test.ts`). See `convex/CLAUDE.md`.
- `src/` frontend (`src/components/<area>/`, primitives in `src/components/ui/`, pure logic in `src/lib/`). See `src/CLAUDE.md`, `STYLE_GUIDE.md`.
- `mcp-server/` MCP server (68 `crm_*` tools) over the REST API. `scripts/claude/` hook scripts + no-loss guard. `docs/` plans, status, architecture. `temp/` gitignored scratch.

## Commands

```bash
npm run dev              # Vite + Convex dev (DEV deployment) in parallel
npm run test             # vitest + convex-test (≈2.4k tests, ~2 min)
npm run lint             # tsc (convex, app) → convex dev --once (pushes DEV) → vite build
npx tsc -p convex && npx tsc -p tsconfig.app.json && npx tsc -p tsconfig.node.json   # typecheck only (what CI runs)
npx convex dev --once    # push schema/functions to DEV, no watch
npm run deploy:prod      # publish backend to PROD (reads convex-prod-key.env.local) — only with green tests
```

CI (`.github/workflows/ci.yml`): `npm ci` → 3× `tsc` → `npm run test` → `npx vite build`, Node from `.nvmrc`. CI has no Convex deployment, so `npm run lint` is not what CI runs. Do not change the `{ retry: 2 }` in `groupMediaPolicy.test.ts` (load-sensitive).

## Deployments: DEV vs PROD (never confuse them)

| | PROD `careful-anaconda-127` | DEV `tacit-chicken-195` |
|---|---|---|
| Serves | hnbcrm.com and real customers | development, tests, demos (demo org and test account: `CLAUDE.local.md`, not in git) |
| Reached by | `npm run deploy:prod`, Vercel on push to `main`, or any CLI call with `--prod` | `npx convex dev`, `npx convex run`, … without flags (`.env.local` → `CONVEX_DEPLOYMENT=dev:tacit-chicken-195`) |
| Key | `convex-prod-key.env.local` (gitignored, never commit) | `CONVEX_DEV_ADMIN_KEY` in `.env.local` — never name it `CONVEX_DEPLOY_KEY` or `npx convex deploy` would target DEV |
| State | real data, real webhooks | neutralized (`RESEND_TEST_MODE=true`, channels disarmed, frozen copy of 02/10/2026 data) |

Rules: (1) no flag = DEV; PROD only with `--prod` (`run`, `env`, `data`, `logs`, `import`, `export`). CLI 1.31.2 gotcha: `convex data` and `convex logs` ignore `CONVEX_DEPLOY_KEY` — only `--prod` switches them. (2) Schema changes must be additive: both deployments must accept the same documents. (3) Every PROD op runs with `dryRun` first. (4) Runbook and migration ops: `docs/OPS-SEPARAR-DEV-PROD.md`, `convex/opsMigration.ts`. (5) A Convex backup restore brings no scheduled functions or envs: afterwards run `internalRearmScheduledMessages`, `internalRearmGroupPosts`, `internalRedispatchStuckOutbound`. Full text: `docs/architecture/ops-dev-prod.md`.

## Non-negotiable invariants

- **Multi-tenant**: every table has `organizationId`; every query/mutation scopes to the caller's org via `requireAuth(ctx, organizationId)` or `requirePermission(ctx, organizationId, category, level)` (`convex/lib/auth.ts`, RBAC in `convex/lib/permissions.ts`, 10 categories). Removed members (`removedAt`) must not authenticate; new assignments go through `assertAssignableMember`.
- **Critical doors require an account with e-mail** (`requireAccountWithEmail`): org creation, channel provisioning, API keys, invites, AI toggles, campaign launch. Never add an anonymous auth provider (`anonymousLogin.test.ts` fails the build).
- **Side effects**: mutations write `activities` + `auditLogs` and emit webhooks only via `scheduleWebhookEvent(ctx, {organizationId, event, payload})` (`convex/lib/webhookDispatch.ts`); scheduling `internal.nodeActions.triggerWebhooks` directly fails the build.
- **Single ports** (never bypass): stage moves `moveLeadToStageCore` (`convex/lib/leadStageMove.ts`), handoffs `createHandoffCore`, outbound e-mail `sendTransactionalEmail`, phones `convex/lib/phone.ts`, blob deletes `convex/lib/fileRefs.ts`, group sends `convex/lib/groupGuard.ts`, lead deletion `hardDeleteLead` (`convex/lib/leadCascade.ts`), follow-up outcomes `resolveFollowUpOutcome`.
- **Ops functions** are `internal*`, take `dryRun` (default true) and a `cursor`, and are run with `npx convex run` — never public.
- **REST** (`convex/router.ts`): every route has an entry in `ROUTE_PERMISSIONS` and calls `requireRoutePermission` (fail-closed; `routerPermissions.test.ts`).
- **AI is opt-in per org** (`aiConfig.enabled` + LGPD ack); eligibility is re-checked inside the transactional commit; anything the model could send to a customer passes the output guard (`convex/lib/llmOutputGuard.ts`). Details: `.claude/rules/ai-pipeline.md`.
- **Secrets**: never commit tokens (`secretScan.test.ts`), never log full phone numbers or e-mails in ops output, never persist WhatsApp `MediaKey` material.
- **UI**: PT-BR copy, mobile-first, `lucide-react` icons (no emoji), 44 px touch targets, dark theme default.
- **Git**: no AI attribution lines (no `Co-Authored-By: Claude`) in commits or PRs. Branch → PR → review → merge; `main` deploys PROD via Vercel.

## Convex rules (summary; full set in `.claude/rules/convex-official.md`)

- New function syntax with `args` AND `returns` validators on every function; `internalQuery`/`internalMutation`/`internalAction` for anything not called from the client.
- Never `.filter()` on a query — use `.withIndex()`; index names `by_<field>` / `by_<a>_and_<b>`. Paginate large sets (`paginationOptsValidator`).
- Never `Date.now()` inside a query. Never schedule `api.*` — only `internal.*`.
- Node APIs only in a separate file with `"use node";`. `ctx.db.patch` for partial updates, `ctx.db.replace` for full.
- Handlers thin; business logic in plain TypeScript (`convex/lib/`). Frontend: `useQuery(fn, args ?? "skip")` when args are not ready.

## Where to look

- `docs/architecture/README.md` — map of 20 area files (auth, e-mail, WhatsApp bridge, groups, campaigns, AI attendant/vision/core, leads, inbox, tasks, central, export/import, security, frontend, ops). Read the area file before touching the area.
- `.claude/rules/` — auto-loaded by path: `convex-official`, `backend-invariants` (convex/**), `whatsapp-bridge`, `ai-pipeline`, `frontend` (src/**), `tests` (*.test.ts).
- Skills: `/convex-ops` (dev×prod runbook, ops catalog), `/release` (version bump, CHANGELOG, docs). Agents: `frontend-specialist`, `convex-backend`, `reviewer`.
- `CHANGELOG.md` (PT-BR, user-facing). Plans, status logs, ops runbooks and `docs/perf/` are LOCAL files (gitignored, see `CLAUDE.local.md`); `docs/architecture/` is the public, anonymized record.

## Working conventions

- Default to the smallest change that satisfies the request; look for the existing single port before writing a new path.
- Every new behavior ships with a test (`convex/*.test.ts` or `src/**/*.test.ts`); build-guard tests exist on purpose — if one fails, read its message, do not delete it.
- Update docs with the code: `CHANGELOG.md` entry (PT-BR), the area file in `docs/architecture/`, and the area rule if a gotcha changes how code must be written. Never add history here.
- Do not run `npx convex dev`/`deploy` unless asked: Eric runs the dev watcher himself.
