---
paths:
  - "convex/**/*.test.ts"
  - "src/**/*.test.ts"
  - "vitest.config.mts"
---

# Test rules (vitest + convex-test)

## Running
- Whole suite: `npm run test` (`vitest run`, ~140 test files, ≈2.4k tests, ~1.5–2 min). One file: `npx vitest run convex/x.test.ts`. Add `-t "name"` for one case.
- `vitest.config.mts`: environment `edge-runtime`, `convex-test` inlined, includes `convex/**/*.test.ts` and `src/**/*.test.ts`. Do not add files outside those globs.
- CI runs the same suite; it must not depend on `.env.local` or a real deployment.

## Bootstrapping a convex-test test
- Header `/// <reference types="vite/client" />`, then `import { convexTest, TestConvex } from "convex-test"`, `schema from "./schema"`, and `const modules = import.meta.glob("./**/!(*.*.*)*.*s");`.
- There is no shared helper: each file defines its own `seed(t)` inside `t.run(async ctx => ...)`. Insert `organizations`, then per member a `users` row plus a `teamMembers` row (`organizationId`, `userId`, `name`, `role`, `type`, `status:"active"`, timestamps), then boards/stages as needed. Template: `convex/leadDelete.test.ts`.
- Act as a user with `t.withIdentity({ subject: "<userId>|s1" })`. Internal functions are called with `t.mutation(internal.x.y, ...)` without identity.
- Fake timers in `beforeEach` (`vi.useFakeTimers()`), `vi.useRealTimers()` in `afterEach`; create `t = convexTest(schema, modules)` per test.
- Pure functions (`convex/lib/*.ts`, `src/lib/*.ts`) need no convex-test: plain `describe`/`it`, sibling `*.test.ts` (example `src/lib/contactName.test.ts`). Files that read source from disk start with `// @vitest-environment node`.

## Scheduled functions
- Drain with `await t.finishAllScheduledFunctions(vi.runAllTimers)` under fake timers. Never interleave `finishInProgressScheduledFunctions` with `t.run`.
- To assert scheduling without running jobs, read `_scheduled_functions` via `ctx.db.system`. If jobs would fire after the test ("Write outside of transaction"), end with `cancelPendingJobs(t)`: cancel every `pending` job in `t.run`, then `await t.finishInProgressScheduledFunctions()` (pattern in `convex/bridgeSessionEvents.test.ts`).
- Webhook-scheduling assertions need an ACTIVE webhook seeded in the org (`webhooks` row with `events:["*"]`, `isActive:true`); without it `scheduleWebhookEvent` schedules nothing (see `convex/leadStageMove.test.ts`).

## E-mail
- The Resend component is NOT registered in tests, so `sendTransactionalEmail` always returns `false`. `toBe(false)` proves nothing for an opt-out. Prove it with `vi.spyOn(console, "error")` and a valid address: the "falha ao enfileirar" log appears only when the send was attempted (`convex/alertEmails.test.ts`). Always `mockRestore()` in `finally`.

## Do not change
- `convex/groupMediaPolicy.test.ts` "fetch do sob demanda tem timeout menor que a trava" keeps `{ retry: 2 }` and its timings; it is load-sensitive.
- Fixtures must be short and obviously fake (`sk-test-...`, `fake-hmac-secret-...`); `secretScan` fails the build on real-looking tokens. Bridge fixtures in `convex/__fixtures__/` are real or marked synthetic in the JSON; keep that marking.

## Build-guard tests (read source, fail the build when a rule is broken)
- `secretScan`: no real-looking secret in any tracked file.
- `anonymousLogin`: `Anonymous` provider / `signIn("anonymous"` must not return.
- `seedSecurity`: `seed.ts` exports only internal functions.
- `routerPermissions`: every REST route has a `ROUTE_PERMISSIONS` entry and a permission gate (fail-closed).
- `webhookDispatchPort`: webhooks scheduled only through `lib/webhookDispatch`.
- `leadStageMovePort`: `leads.stageId` changes only inside `lib/leadStageMove` (exceptions listed in the test with a reason).
- `llmOutputGuardWiring`: attendant, group posts and group agent import `detectLeakedModelMarkup`.
- `agentToolSecurity`: AI tools never expose denylisted functions, secret-like result fields or injected scope params.
- `agentTextsPort`: agent `systemPrompt`/`knowledge` accessed only through the texts store.
- `storageUsage`: `files` rows are inserted only through `lib/storageUsage.ts` (keeps the quota counter right).
- `bridgeIngress` also reads `bridge.ts`/`whatsapp.ts` source to pin ingest wiring.
- `exportSecurity`: backups never carry secrets. `emailConfig`: real sending is the default, sandbox is opt-in.
- `openapiSpec`: served OpenAPI text parses as JSON. `claudeMdNoLoss`: no identifier from the baseline CLAUDE.md disappears from the docs.
- When you add a port or invariant, add a guard in the same style instead of relying on review.

History: `docs/architecture/`
