# CLAUDE.md — Convex Backend

## File Layout

| File | Purpose |
|------|---------|
| `schema.ts` | All table definitions, indexes, validators |
| `auth.ts` / `auth.config.ts` | Auth providers (Password + Anonymous) |
| `http.ts` | Wires HTTP routes from `router.ts` |
| `router.ts` | RESTful API endpoints (`/api/v1/*`), API key auth |
| `leads.ts` | Lead CRUD, stage moves, assignment, qualification |
| `contacts.ts` | Contact CRUD |
| `conversations.ts` | Multi-channel conversations + messages |
| `handoffs.ts` | AI-to-human handoff workflow |
| `boards.ts` | Kanban boards and stages |
| `organizations.ts` | Organization CRUD + settings |
| `teamMembers.ts` | Human + AI team member management |
| `activities.ts` | Activity timeline events on leads |
| `auditLogs.ts` | Audit trail queries |
| `dashboard.ts` | Aggregation queries for dashboard |
| `webhooks.ts` | Webhook CRUD |
| `webhookTrigger.ts` | Internal action that fires webhooks |
| `lib/auth.ts` | Shared `requireAuth()` helper (auth + org membership check) |
| `nodeActions.ts` | Node.js actions: API key hashing, webhook dispatch |
| `apiKeys.ts` | API key generation and validation |
| `leadSources.ts` / `fieldDefinitions.ts` | Lead sources + custom fields |
| `seed.ts` | Dev seed data |

## Auth Pattern (copy this for every public function)

```typescript
import { requireAuth } from "./lib/auth";

// In any public query/mutation with organizationId arg:
const userMember = await requireAuth(ctx, args.organizationId);

// For entity-based auth (org comes from the entity, not args):
const entity = await ctx.db.get(args.entityId);
const userMember = await requireAuth(ctx, entity.organizationId);
```

Note: `getAuthUserId` is still used directly in functions without org context (e.g. `getUserOrganizations`).

## Mutation Side Effects Checklist

When writing mutations that create/update/delete entities, include all three:

1. **Activity log** — `ctx.db.insert("activities", { organizationId, leadId, type, actorId, actorType, content, metadata, createdAt })`
2. **Audit log** — `ctx.db.insert("auditLogs", { organizationId, entityType, entityId, action, actorId, actorType, changes: { before, after }, severity, createdAt })`
3. **Webhook trigger** — `ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, { organizationId, event: "entity.action", payload })`

## Key Indexes

All tables use `by_organization` as the primary access pattern. Important compound indexes:
- `leads`: `by_organization_and_stage`, `by_organization_and_assigned`, `by_organization_and_board`
- `conversations`: `by_lead_and_channel`, `by_organization_and_status`
- `messages`: `by_conversation_and_created`
- `stages`: `by_board_and_order`
- `auditLogs`: `by_organization_and_created`, `by_entity`
- `activities`: `by_lead_and_created`
- `apiKeys`: `by_key_hash_and_active`

## HTTP API Pattern (router.ts)

All endpoints use `httpAction` and follow this structure:
```typescript
http.route({
  path: "/api/v1/endpoint",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.method === "OPTIONS") return handleOptions();
    try {
      const { organizationId, teamMemberId } = await authenticateApiKey(ctx, request);
      // call ctx.runMutation / ctx.runQuery
      return jsonResponse(result);
    } catch (e: any) {
      return errorResponse(e.message, 400);
    }
  }),
});
```

## Rules

- Every exported function needs `args` + `returns` validators
- Use `v.null()` for functions that return nothing
- Never use `Date.now()` in queries (breaks Convex reactivity) — pass timestamps as arguments or use them only in mutations
- Only schedule `internal.*` functions, never `api.*`
- Put `"use node";` at the top of any file using Node.js APIs (only valid in actions)
- Use `ctx.db.patch` for partial updates
