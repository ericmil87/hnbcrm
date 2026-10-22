---
name: review-checklist
description: HNBCRM code-review checklist (multi-tenant, RBAC, single ports, Convex, side effects, tests, prod safety). Background knowledge for the reviewer agent.
user-invocable: false
---

# HNBCRM review checklist

Walk every item against the diff. Cite file:line for each finding.

## Tenant and auth
- Every new/changed public function calls `requireAuth`/`requirePermission` with the org from args; no `ctx.db.get(id)` on a caller-supplied id without checking `organizationId` afterwards.
- Lists use org-scoped indexes; no `.filter()`; no `collect()` on unbounded tables.
- Assignments go through `assertAssignableMember`; notifications/e-mails cannot reach another org (`dispatchNotification` guard) and never carry customer text to the outside.
- Critical doors keep `requireAccountWithEmail`; REST routes have `ROUTE_PERMISSIONS` entries + `requireRoutePermission`; MCP tools map to REST with the same permission.

## Single ports (bypass = block)
- Stage change only via `moveLeadToStageCore`; handoff via `createHandoffCore`; e-mail via `sendTransactionalEmail`; webhooks via `scheduleWebhookEvent`; phones via `convex/lib/phone.ts`; blob delete via `convex/lib/fileRefs.ts`; lead delete via `hardDeleteLead`; follow-up terminal states via `resolveFollowUpOutcome`; group sends via `groupGuard`.

## Convex correctness
- `args` + `returns` validators present and exact; `internal*` for non-client functions; only `internal.*` scheduled; `"use node"` files contain no non-Node registrations; no `Date.now()` in queries.
- Schema additive; new fields optional; indexes named `by_…`; no array growth on hot docs; denormalized previews kept in sync.
- OCC: hot-document writes minimized; counters idempotent per run; scheduled jobs carry a token and a watchdog.

## AI-specific (if touched)
- Eligibility re-checked in the commit; untrusted text wrapped in the envelope; customer-influenced args sanitized before persistence; any model text that can reach a customer passes `detectLeakedModelMarkup` and `toWhatsAppText`; `finish_reason:"length"` handled; new reason codes added to both `AI_STATE_REASON_CODES` and the frontend labels.
- Gates respect the `undefined` semantics of each flag; new acks audited `high`.

## Side effects and ops
- `activities` + `auditLogs` written where state changes; audit severity right; webhook event names documented in `DevelopersPage`/`llmsTxt` when new.
- Ops functions: `internal*`, `dryRun` default true, cursor/pagination, masked PII, idempotent, re-schedule by cursor.
- Prod safety: nothing in the diff runs against PROD implicitly; migration notes for both deployments.

## Frontend (if touched)
- PT-BR copy, mobile-first, `lucide-react`, 44 px targets, `ui/` primitives, `useQuery(..., "skip")`, permission gates, URL as source of truth for deep links, pure logic in `src/lib` with tests.

## Tests and docs
- New behavior has a test; build-guard tests untouched (or the change explained); `{ retry: 2 }` in `groupMediaPolicy.test.ts` unchanged.
- `CHANGELOG.md` entry (PT-BR), `docs/architecture/<area>.md` updated, rule updated if a gotcha changed; root `CLAUDE.md` NOT grown.
