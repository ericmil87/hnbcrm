# Backend — núcleo da arquitetura

> Parágrafos movidos **verbatim** do `CLAUDE.md` da raiz em 22/10/2026 (commit 1f51a2f).

Multi-tenant CRM with human-AI team collaboration. Convex backend, React + TailwindCSS frontend.

### Multi-tenancy

**Multi-tenancy:** Every table has `organizationId`. All queries must be scoped to the user's org.

### Side effects in mutations

**Side effects in mutations:** Most mutations insert into `activities` + `auditLogs` and trigger webhooks via `scheduleWebhookEvent(ctx, {organizationId, event, payload})` (`lib/webhookDispatch.ts`) — gate na mutation: só agenda `internal.nodeActions.triggerWebhooks` quando a org tem webhook ativo inscrito no evento (ou `"*"`), então org sem webhook não gera job nem action; a action refiltra com o mesmo `webhookMatches`. Agendar a action direto quebra o build (`webhookDispatchPort.test.ts`); teste que afirma o agendamento precisa semear um webhook ativo na org.

### Convex Rules (resumo que estava na raiz)

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

## Notas vindas de convex/CLAUDE.md (22/10/2026)

Trechos movidos literalmente do `convex/CLAUDE.md` ao enxugá-lo (identificadores que não existiam em nenhum outro lugar).

- Índices principais de `auditLogs` (convex/CLAUDE.md): `auditLogs`: `by_organization_and_created`, `by_entity`, `by_organization_and_entity_type_and_created`, `by_organization_and_action_and_created`, `by_organization_and_severity_and_created`, `by_organization_and_actor_and_created`
