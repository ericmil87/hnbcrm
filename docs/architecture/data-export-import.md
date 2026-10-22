# Export/Import de dados

> Histórico técnico movido **verbatim** do `CLAUDE.md` da raiz em 22/10/2026 (snapshot do commit 1f51a2f). Ordem = ordem de versão. Pegadinhas que mudam a forma de codar foram destiladas em `.claude/rules/`; este arquivo é a fonte completa, para ler quando se mexe nesta área.

## Estado atual

CSV por entidade, backup JSON versionado, wizard de import com rollback (v0.46), RBAC em todas as rotas REST (v0.47). Código: `convex/exports.ts`, `convex/imports.ts`, `convex/importRun.ts`, `convex/lib/csv.ts`.

## Decisões, pegadinhas medidas e histórico

### Export/Import de dados (v0.46)

**Export/Import de dados (v0.46):** aba "Dados" em Configurações (`src/components/settings/DataSection.tsx`, deep-link `/app/configuracoes?secao=data`) — tudo atrás de `settings:manage` (default: só admin) e auditado a cada transição de job (backup completo = severity `high`). **Export** (`convex/exports.ts` + `lib/exportColumns.ts`): CSV por entidade (contatos/leads/tarefas, colunas desnormalizadas + `cf_<key>`, BOM + RFC 4180) e backup JSON versionado (`hnbcrm-backup` v1, 22 tabelas core na ordem da seção 7 do plano, sanitizado por `lib/exportSanitize.ts` — teste de build `exportSecurity.test.ts` quebra se segredo vazar); resultado vai para o File Storage (fora da quota de `files`), expira em 7 dias (cron horário `internalCleanupExpired`); paginação de 500 via `lib/cursor.ts`; 1 job ativo por org. **Import** (`convex/imports.ts` + `convex/importRun.ts`): wizard server-side de contatos/leads — upload padrão de `files` com `fileType:"import_file"` → detecção de headers + sugestão de mapeamento (`lib/importMapping.ts`: aliases PT-BR/EN, coerções data/número/booleano/tags, custom fields `cf:<key>` validados contra `fieldDefinitions`) → dry-run com caps (50 erros de amostra, 10 preview, teto 10k linhas) → execução em lotes de 50 com trilha de rollback em `importJobBatches` (`createdIds` + `before` só dos campos alterados; `null` = campo não existia) → rollback deleta criados e reverte atualizados; leads resolvem board/estágio por nome (fallback board default), find-or-create de contato por email/telefone, estratégias `skip`/`update`/`create` (update nunca apaga, tags somam). **Pegadinha:** chaves dos records `mapping`/`suggestedMapping` são `encodeHeaderKey(header)` (= encodeURIComponent; Convex rejeita acento em nome de campo) — helper compartilhado em `convex/lib/importKeys.ts` (front e REST usam o mesmo); `getFailedRowsCsv` é ACTION (lê storage). CSV: `convex/lib/csv.ts` é a referência única (parse RFC 4180 + auto-detect `,`/`;` + serialize com BOM). UI: `ImportWizard.tsx` (5 passos, retoma pelo status do job) + `FileDropZone.tsx`. REST: 12 rotas `/api/v1/exports/*` e `/api/v1/imports/*` (desde a v0.47 TODAS as rotas da API enforçam permissão — ver abaixo); download com `Content-Disposition: attachment`; import inline ≤ 5 MB ou via `fileId`. CSVs de export escapam fórmulas (`'` antes de `=`/`+`/`@`; números negativos preservados) e o import desfaz o prefixo no round-trip. Webhooks: `export.completed/failed`, `import.completed/failed/rolled_back`. **Exceção DELIBERADA ao checklist de side effects:** import/rollback NÃO gravam activity/audit/webhook por linha (contato/lead) — só por transição de job (decisão 9 da seção 2 do plano; 10k linhas = 10k schedulers); a trilha por registro fica em `importJobBatches`. FORA de escopo v1: restore do backup JSON, tools MCP, XLSX, export com filtros das list views.


## Notas vindas de convex/CLAUDE.md (22/10/2026)

Trechos movidos literalmente do `convex/CLAUDE.md` ao enxugá-lo (identificadores que não existiam em nenhum outro lugar).

- `imports.ts` — Superfície do wizard de import (contatos/leads): createImportJob/updateMapping/runPreview/confirmImport/rollbackImport/cancelImport + `getFailedRowsCsv` (ACTION — lê storage); chaves do `mapping` = `encodeHeaderKey(header)` (Convex rejeita acento em field name); trilha de rollback em `importJobBatches` (`before` só dos campos alterados, `null` = não existia)
- `importRun.ts` — Actions do import: `internalDetectHeaders` (parse + sugestão de mapeamento), `internalRunDryRun` (caps 50 erros/10 preview/10k linhas), `internalRunImport` (lotes de 50, claim por `startedAt`), `internalRunRollback`
- `lib/importKeys.ts` — Puro: `encodeHeaderKey`/`invalidHeader`/`mappingForHeaders` — compartilhado com front e REST
- `lib/exportSanitize.ts` — Denylist central de segredos (`*token*`/`*secret*`/`*keyHash*` + caminhos) aplicada a todo doc do backup; verificada por `exportSecurity.test.ts`
