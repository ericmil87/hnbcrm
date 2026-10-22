# HTTP API REST, API keys e MCP

> Histórico técnico movido **verbatim** do `CLAUDE.md` da raiz em 22/10/2026 (snapshot do commit 1f51a2f). Ordem = ordem de versão. Pegadinhas que mudam a forma de codar foram destiladas em `.claude/rules/`; este arquivo é a fonte completa, para ler quando se mexe nesta área.

## Estado atual

Rotas `/api/v1/*` em `convex/router.ts`, RBAC fail-closed por rota (`ROUTE_PERMISSIONS`), rate limit por key, servidor MCP em `mcp-server/`. Para rotas de áreas específicas ver `campaigns.md`, `groups.md`, `inbox.md` (Nova conversa), `data-export-import.md`.

## Decisões, pegadinhas medidas e histórico

### HTTP API

**HTTP API:** `convex/router.ts` has RESTful endpoints at `/api/v1/` authenticated via `X-API-Key` header. API keys resolve permissions from key → team member → role defaults. **RBAC enforçado em TODAS as rotas (v0.47):** mapa único `ROUTE_PERMISSIONS` (`"MÉTODO /rota"` → categoria+nível espelhando o `requirePermission` da função app equivalente, ou `"authenticated"` p/ rotas self-scoped) + `requireRoutePermission` logo após `authenticateApiKey` em cada handler; fail-closed (rota sem entrada = 403 "Permissão insuficiente"); teste de build `routerPermissions.test.ts` garante completude e gate em cada handler. Rate limit por key: 300 req/min (fixed window em `apiKeys.updateLastUsed`, 429). Routes wired in `convex/http.ts`.


## Notas vindas de convex/CLAUDE.md (22/10/2026)

Trechos movidos literalmente do `convex/CLAUDE.md` ao enxugá-lo (identificadores que não existiam em nenhum outro lugar).

- `llmsTxt.ts` — `/llms.txt` and `/llms-full.txt` endpoint content
