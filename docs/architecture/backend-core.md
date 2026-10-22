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

## Desvios do PRD original (PRD v2.0, 2025-02-11)

> Tabela preservada de `docs/PROJECT-STATUS.md` (retrato da v0.33, removido em 22/10/2026 por duplicar o `CHANGELOG.md`). Estado em fev/2026; vários itens "não implementados" já existem hoje (file storage via Convex, export/import, notificações, Anonymous removido na v0.68.1) — ver o CHANGELOG.

| PRD Planned | Actual Implementation | Reason |
|------------|----------------------|--------|
| TanStack Router (file-based routes) | react-router v7 (SPA/library mode) | More mature, wider ecosystem, sufficient for SPA |
| 6 roles (super_admin, owner, admin, member, agent, viewer) | 4 roles (admin, manager, agent, ai) | Simplified for MVP — can expand later |
| Hono HTTP router | Convex native `httpRouter` with `httpAction` | Convex built-in routing sufficient for current endpoints |
| S3 file storage | Not implemented | Deferred — no file uploads yet |
| nuqs for URL state | Not used | react-router handles URL state |
| shadcn/ui components | Custom TailwindCSS design system | Intentional — custom dark theme with brand tokens |
| `automationRules` table | Not in schema | Automation engine deferred to Phase 2 |
| Scoped API key permissions | Implemented — key-level + member-level + role defaults | Full permission resolution chain |
| Audit log `actorIp`, `apiKeyId` fields | Not tracked | HTTP action context not passed to audit writer |

### Additions Beyond PRD

| Feature | Notes |
|---------|-------|
| Calendar view (day/week/month) | `/app/calendario` with drag-to-reschedule, merged tasks, REST API, MCP tools |
| Sales landing page | Public page at `/` with hero, features, pricing |
| Developer portal | `/developers` with API docs, MCP setup, SDK examples |
| llms.txt endpoints | AI-readable project documentation |
| Onboarding system | 5-step wizard + checklist + spotlights + confetti |
| Contact enrichment (20+ fields) | Social, location, company, acquisition data |
| Saved views system | Reusable filter configurations |
| Agent Skills (AgentSkills.io) | Portable skill package with workflows, data model, multi-platform setup |
