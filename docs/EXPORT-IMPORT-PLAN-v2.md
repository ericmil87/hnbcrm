# Export/Import de Dados — Contrato de implementação (agentes paralelos)

> **Status 2026-08-23:** **IMPLEMENTADO (F1–F8, v0.46.0)** — ondas S → A‖B → C‖D executadas conforme o contrato; 508 testes verdes (baseline 410 + 98 novos), lint completo. F9 (MCP), F10, F11 e restore de backup JSON continuam FORA (não implementar sem pedido explícito). Deltas de contrato aplicados na execução: (1) chaves dos records `mapping`/`suggestedMapping` são `encodeHeaderKey(header)` (= encodeURIComponent) de `convex/lib/importKeys.ts` — o Convex rejeita acento em nome de campo; (2) `imports.getFailedRowsCsv` é ACTION, não query (query não lê blob do storage); (3) `scope=entity` exige `format=csv` e `full_backup` exige `json`; (4) REST devolve 400 (não 500) no catch, seguindo o padrão documentado do `convex/CLAUDE.md`. E2E vivo (seção 9) pendente. Substitui `docs/EXPORT-IMPORT-PLAN.md` (v1, EN, git-ignorado, escrito antes do files.ts/cursor.ts/notifications e nunca executado).

**Data:** 2026-08-23 · **Escopo:** contrato fechado para implementação em ondas com agentes paralelos · **Baseline:** v0.45.0, 410 testes verdes · **Kickoff:** seção 11 tem o prompt pronto para colar numa sessão nova.

---

## 1. Visão e escopo

Hoje o HNBCRM não tem import/export nenhum no backend. Só existem dois CSVs client-side (`AuditLogs.tsx:221` e `FormSubmissionsPage.tsx:182`, apenas a página carregada) e um card "Importar/Exportar" morto em "em breve" no `DashboardOverview.tsx:709`. Usuários não conseguem fazer backup, migrar de outro CRM nem cumprir portabilidade LGPD (art. 18) sem suporte manual.

**Entra no v1 (este plano):**

| ID | Feature | Prioridade |
|---|---|---|
| F1 | Export CSV por entidade: **contatos, leads, tarefas** (colunas legíveis + custom fields achatados) | **P0** |
| F2 | Export JSON "Backup completo" da org (tabelas core, segredos removidos, formato versionado) | **P0** |
| F3 | Import CSV de **contatos** com wizard: upload → mapeamento → dry-run → execução → resultado | **P0** |
| F4 | Import CSV de **leads** (resolve board/estágio por nome, vincula/cria contato por email/telefone) | **P1** |
| F5 | Rollback de import (desfaz criados, reverte atualizados) | **P1** |
| F6 | UI: aba "Dados" em Configurações + wizard + histórico de jobs reativo | **P0/P1** |
| F7 | REST API `/api/v1/exports/*` e `/api/v1/imports/*` (+ OpenAPI + llms.txt) | **P1** |
| F8 | Eventos de webhook `export.completed/failed`, `import.completed/failed/rolled_back` | **P1** |
| F9 | Tools MCP (`crm_export_data`, `crm_import_data`, …) | **P2** |
| F10 | Export CSV a partir das list views com filtros ativos (leads/contatos/tarefas) | **P2** |
| F11 | Import de tarefas; export CSV de atividades/mensagens | **P2** |

**FORA de escopo (não implementar sem pedido explícito):**
- **Restore de backup JSON** (import do F2 de volta) — exige remapeamento de IDs em ordem de dependência; é um projeto próprio (P3).
- XLSX (só CSV com BOM, abre no Excel), exports agendados/recorrentes, binários de arquivos no backup (só metadados), i18n.

---

## 2. Decisões fechadas (deltas vs plano v1)

1. **Resultado de export vai para o Convex File Storage** (`ctx.storage.store(new Blob(...))` — precedente em `bridge.ts:230` e `whatsapp.ts:357`), com `resultStorageId` no doc do job. O plano v1 propunha "chunks de string de 500KB no documento" — descartado: hoje existe infra completa de storage. Blobs de export **não contam** na quota de `lib/fileQuotas.ts` (não criam linha em `files`) e **expiram em 7 dias** via cron de limpeza.
2. **Arquivo de import entra pelo fluxo padrão de upload** (`files.generateUploadUrl` → POST → `files.saveFile`) com `fileType: "import_file"` — **o union já existe no schema** (`schema.ts:1244`), nada escreve nele hoje. A action de processamento lê via `ctx.storage.get(storageId)`.
3. **Sem novas dependências npm.** Parser/serializador CSV RFC 4180 feito à mão em `convex/lib/csv.ts` (puro, testável) — aspas, quebra de linha em campo, BOM, `;` e `,` como delimitadores auto-detectados. Já há dois serializadores manuais no front; o novo módulo vira a referência única.
4. **RBAC: `requirePermission(ctx, org, "settings", "manage")`** para criar/executar/baixar/rolar de volta jobs. Default = só admin (manager tem `settings: view`); admins podem conceder via override por membro. Export completo é exfiltração em potencial — gate alto e auditado.
5. **As rotas REST novas ENFORÇAM permissão** com `hasPermission(auth.permissions, "settings", "manage")` → 403. Hoje o `router.ts` resolve permissões e não checa em nenhum endpoint — as rotas de export/import inauguram o padrão (não retrofitar as antigas neste plano).
6. **Progresso/rollback em tabela satélite `importJobBatches`** (um doc por lote de 50 linhas com `createdIds` + `updated[{id, before}]` + erros), não em arrays gigantes no doc do job — mesmo racional dos cursores `aiPacing`/`channelPacing` (`schema.ts:1353`): evita OCC e docs > 1 MiB.
7. **Dedup de contatos segue o precedente `internalFindOrCreateContact`** (`contacts.ts:455`): match por `by_organization_and_email`, depois `by_organization_and_phone`. Estratégias: `skip` (default) | `update` | `create`.
8. **Limites v1:** arquivo de import ≤ 10 MB (`lib/fileValidation.ts` já valida `text/csv`), ≤ **10.000 linhas** por job (erro claro acima), lotes de **50 linhas por mutation**, paginação de export em **500 docs por internalQuery** (`lib/cursor.ts`), **1 job ativo por org por tipo** (export/import).
9. **Um turno de auditoria por transição de job** (`auditLogs`: create/complete/fail/rollback; export completo = severidade `high`) + webhook por evento (F8). Notificação in-app fica para P2 (a tela de jobs é reativa).
10. **Doc/UI PT-BR**, ícones lucide, `toast.promise`, padrão `"skip"` — tudo conforme `src/CLAUDE.md`.

---

## 3. Schema (Agente S entrega EXATAMENTE isto)

Adicionar a `convex/schema.ts` (3 tabelas novas; nenhuma existente muda):

```ts
exportJobs: defineTable({
  organizationId: v.id("organizations"),
  requestedBy: v.id("teamMembers"),
  status: v.union(v.literal("queued"), v.literal("running"), v.literal("completed"), v.literal("failed")),
  format: v.union(v.literal("csv"), v.literal("json")),
  scope: v.union(v.literal("entity"), v.literal("full_backup")),
  entity: v.optional(v.union(v.literal("contacts"), v.literal("leads"), v.literal("tasks"))), // obrigatório quando scope=entity
  columns: v.optional(v.array(v.string())),        // subconjunto de colunas p/ CSV (precedente: savedViews.columns)
  progress: v.object({ processed: v.number(), total: v.optional(v.number()), currentEntity: v.optional(v.string()) }),
  resultStorageId: v.optional(v.id("_storage")),
  resultFileName: v.optional(v.string()),
  resultSize: v.optional(v.number()),
  rowCount: v.optional(v.number()),
  error: v.optional(v.string()),
  expiresAt: v.number(),                            // createdAt + 7 dias; cron limpa o blob
  createdAt: v.number(), startedAt: v.optional(v.number()), finishedAt: v.optional(v.number()),
})
  .index("by_organization", ["organizationId"])
  .index("by_organization_and_status", ["organizationId", "status"])
  .index("by_status_and_expires", ["status", "expiresAt"]),

importJobs: defineTable({
  organizationId: v.id("organizations"),
  requestedBy: v.id("teamMembers"),
  status: v.union(
    v.literal("mapping"),        // arquivo carregado, headers detectados, aguardando mapeamento
    v.literal("previewing"),     // dry-run rodando
    v.literal("preview_ready"),  // dry-run pronto, aguardando confirmação
    v.literal("running"),
    v.literal("completed"), v.literal("completed_with_errors"),
    v.literal("failed"), v.literal("rolled_back"), v.literal("canceled"),
  ),
  entity: v.union(v.literal("contacts"), v.literal("leads")),
  fileId: v.id("files"),                            // fileType: "import_file"
  fileName: v.string(),
  detectedHeaders: v.optional(v.array(v.string())),
  suggestedMapping: v.optional(v.record(v.string(), v.string())),
  mapping: v.optional(v.record(v.string(), v.string())), // header → campo | "cf:<key>" | "__ignore__"
  duplicateStrategy: v.union(v.literal("skip"), v.literal("update"), v.literal("create")),
  matchFields: v.optional(v.array(v.string())),     // default contatos: ["email","phone"]
  dryRun: v.optional(v.object({
    totalRows: v.number(), validRows: v.number(), errorRows: v.number(),
    newRows: v.number(), updateRows: v.number(), skipRows: v.number(),
    sampleErrors: v.array(v.object({ row: v.number(), field: v.optional(v.string()), message: v.string() })), // cap 50
    preview: v.array(v.record(v.string(), v.any())), // 10 primeiras linhas já mapeadas
  })),
  progress: v.object({
    processed: v.number(), total: v.number(),
    created: v.number(), updated: v.number(), skipped: v.number(), failed: v.number(),
  }),
  error: v.optional(v.string()),
  createdAt: v.number(), startedAt: v.optional(v.number()), finishedAt: v.optional(v.number()),
})
  .index("by_organization", ["organizationId"])
  .index("by_organization_and_status", ["organizationId", "status"]),

importJobBatches: defineTable({
  organizationId: v.id("organizations"),
  jobId: v.id("importJobs"),
  batchIndex: v.number(),
  createdIds: v.array(v.string()),                  // ids de contacts/leads criados neste lote
  updated: v.array(v.object({ id: v.string(), before: v.record(v.string(), v.any()) })), // só campos alterados
  errors: v.array(v.object({ row: v.number(), message: v.string() })),
  createdAt: v.number(),
})
  .index("by_job", ["jobId"])
  .index("by_organization", ["organizationId"]),
```

---

## 4. Regras semânticas (valem para TODOS os agentes)

1. **Org-scoping sempre**: todo doc lido/escrito é validado contra `organizationId`; jobs de outra org = "Not authorized". Nada de `.filter()` — só `.withIndex()`.
2. **Validators `args` + `returns` em toda função**; `internal*` para tudo que não é chamado pelo front; só `internal.*` no scheduler; nunca `Date.now()` em query.
3. **Gate**: `requirePermission(ctx, organizationId, "settings", "manage")` em toda mutation/query pública de export/import (inclusive listagem e download). No `router.ts`, `hasPermission(auth.permissions, "settings", "manage")` → `errorResponse("Permissão insuficiente", 403)`.
4. **Segredos NUNCA saem** (ver seção 8): denylist central em `convex/lib/exportSanitize.ts` + teste de build `convex/exportSecurity.test.ts` que falha se o backup contiver campo proibido (mesmo espírito do `secretScan.test.ts`).
5. **Nunca `.collect()` sem limite em tabela grande**: export pagina com `lib/cursor.ts` em blocos de 500; import processa lotes de 50 por `internalMutation`, encadeados pela action (que tem 10 min de budget — abortar com erro claro se estourar).
6. **Cada transição de job** grava `auditLogs` (actor = requestedBy; export `full_backup` = severity `high`, resto `medium`) e dispara `ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, ...)` com o evento F8 correspondente.
7. **CSV**: sempre com BOM `﻿`, escape RFC 4180 (aspas duplicadas), datas ISO no export; no import aceitar ISO + `dd/mm/aaaa`, números com vírgula decimal, booleanos `sim/não/true/false`, tags separadas por `;`. Custom fields: colunas `cf_<key>` (export) e mapeamento `cf:<key>` validado contra `fieldDefinitions` da org (tipo E options, como o executor do atendente já faz).
8. **Import de leads**: `boardName`/`stageName` resolvidos por nome case-insensitive (fallback: board default + primeiro estágio); contato vinculado via `internalFindOrCreateContact`; `assignedTo` por email do membro (opcional); `customFields` obrigatório no insert (`{}` se vazio) — o validator exige.
9. **Rollback (F5)**: percorre `importJobBatches` do job; deleta `createdIds` (se ainda existirem), reverte `updated` aplicando `before` via `ctx.db.patch`. Disponível só para jobs `completed`/`completed_with_errors`. Não tenta reverter efeitos colaterais (activities/webhooks já disparados ficam).
10. **UI PT-BR** com `sonner`, `lucide-react`, `cn()`, `useQuery(..., cond ? args : "skip")`, spinner em `undefined`. Progresso = query reativa no doc do job (nada de polling).
11. **Testes**: `convex/*.test.ts` com o boilerplate canônico (`tasksP1.test.ts:1-60`, incluindo o `afterEach` que cancela e drena `_scheduled_functions` — obrigatório porque os jobs se auto-agendam). Nomes de teste em PT-BR. Suíte inteira verde (baseline 410) + `npm run lint` antes de encerrar.
12. **Sem dependências npm novas.** Sem créditos ao Claude em commits.
13. **NUNCA edite arquivo de outro agente** (tabela da seção 5). Conflito de necessidade = reportar, não editar.

---

## 5. Ondas, agentes e propriedade de arquivos

### Onda 0 — Agente S (fundação, serial, bloqueia tudo) — **P0 · M**

| Cria | Modifica |
|---|---|
| `convex/lib/csv.ts` · `convex/lib/csv.test.ts` · `convex/lib/importMapping.ts` · `convex/lib/importMapping.test.ts` | `convex/schema.ts` (seção 3, literal) |

Entregáveis:
- `csv.ts`: `parseCsv(text): { headers, rows }` (RFC 4180, BOM, auto-detect `,`/`;`, linhas vazias ignoradas) e `serializeCsv(headers, rows): string` (BOM + escape).
- `importMapping.ts` (puro, sem deps Convex): dicionário de aliases PT-BR/EN → campos (`nome→firstName`, `sobrenome→lastName`, `e-mail/email→email`, `telefone/celular/whatsapp→phone`, `empresa→company`, `cargo→title`, `cidade/estado/país`, `etiquetas/tags→tags`, `título→title` (lead), `valor→value`, `board/funil→boardName`, `estágio/etapa→stageName`, `responsável→assigneeEmail`, …); `suggestMapping(headers, entity, fieldDefs)`; `coerceAndValidateRow(row, mapping, entity, fieldDefs)` → `{ ok, value } | { ok: false, errors }` com as coerções da regra 7.
- `npx convex dev --once` limpo (schema no ar).

### Onda 1 — paralelo (após S)

#### Agente A — backend de export (F1, F2, F8-export) — **P0 · L**

| Cria | Modifica |
|---|---|
| `convex/exports.ts` · `convex/lib/exportColumns.ts` · `convex/lib/exportSanitize.ts` · `convex/exports.test.ts` · `convex/exportSecurity.test.ts` | `convex/crons.ts` (cron `cleanup expired exports`, a cada 1h) |

Entregáveis:
- `exports.ts`: `createExportJob` (mutation; valida 1 ativo/org, insere `queued`, agenda `internalRunExport`), `getExportJobs` / `getExportJob` (queries), `getExportDownloadUrl` (query; `ctx.storage.getUrl`), internals de página (`internalCollectPage` com cursor de 500) e `internalRunExport` (action: itera entidade(s), monta CSV (via `lib/csv.ts` + `lib/exportColumns.ts`) ou JSON de backup, `ctx.storage.store`, patch do job, audit + webhook), `internalCleanupExpired`.
- `exportColumns.ts`: colunas por entidade com desnormalização — leads: `contactName/contactEmail/contactPhone`, `boardName`, `stageName`, `assignedToName`, `sourceName`, `cf_<key>`…; tarefas: `projectName`, `columnName`, `labels` (join `;`), `assigneeEmails`; contatos: campos + `cf_<key>`.
- Backup JSON (seção 7) com `exportSanitize.ts` aplicado.
- Testes: job CSV de contatos ponta-a-ponta no convex-test (storage in-memory funciona — precedente `bridgeDispatch.test.ts:303`), paginação >500 docs, sanitização, concorrência (2º job ativo rejeitado), RBAC (agent recebe "Permissão insuficiente").

#### Agente B — backend de import (F3, F4, F5, F8-import) — **P0/P1 · L**

| Cria | Modifica |
|---|---|
| `convex/imports.ts` · `convex/importRun.ts` · `convex/imports.test.ts` | — |

Entregáveis:
- `imports.ts` (superfície pública): `createImportJob` (mutation; recebe `fileId` já salvo via `files.saveFile` com `fileType:"import_file"`, valida MIME/tamanho, agenda `internalDetectHeaders`, status `mapping`), `updateMapping`, `runPreview` (agenda dry-run, status `previewing`), `confirmImport` (só de `preview_ready`; status `running`), `rollbackImport`, `cancelImport`, `getImportJobs` / `getImportJob`, e as internals de leitura/patch.
- `importRun.ts` (actions): `internalDetectHeaders` (lê blob, `parseCsv`, salva `detectedHeaders` + `suggestedMapping` via `lib/importMapping.ts` + fieldDefs da org); `internalRunDryRun` (valida todas as linhas, checa duplicatas em lotes via internalQuery nos índices email/phone, grava `dryRun` com caps — 50 erros de amostra, 10 linhas de preview, cap 10k linhas); `internalRunImport` (lotes de 50 → `internalProcessBatch` mutation: cria/atualiza/pula conforme estratégia, grava `importJobBatches`, patch de `progress`; ao final status `completed`/`completed_with_errors` + audit + webhook); `internalRunRollback` (regra 9).
- Regras de leads da regra 8 (board/estágio por nome, find-or-create de contato, `customFields: {}`).
- `getFailedRowsCsv` (query/internal): re-gera CSV só com as linhas com erro (a partir do arquivo original + erros dos batches) para reimport.
- Testes: wizard completo contatos (mapping→dry-run→confirm→completed), estratégias skip/update/create contra duplicata real, import de leads com resolução de board/estágio + vínculo de contato, rollback (deleta criados E reverte atualizados), caps (11k linhas → erro), RBAC.

### Onda 2 — paralelo (após A + B)

#### Agente C — REST + OpenAPI + llms.txt + MCP (F7, F9) — **P1/P2 · M**

| Cria | Modifica |
|---|---|
| `mcp-server/src/tools/dataOps.ts` | `convex/router.ts` · `convex/openapiSpec.ts` · `convex/llmsTxt.ts` · `mcp-server/src/index.ts` · `.claude/skills/hnbcrm/references/{API_REFERENCE,WORKFLOWS,DATA_MODEL}.md` |

Rotas (todas com check de permissão da regra 3 + OPTIONS preflight no bloco `:2150+`):
`POST /api/v1/exports` · `GET /api/v1/exports` · `GET /api/v1/exports/get?id=` · `GET /api/v1/exports/download?id=` (httpAction: `ctx.storage.get` → `Response` com `Content-Disposition: attachment`) · `POST /api/v1/imports` (body com CSV inline ≤ 5 MB OU `fileId` de upload prévio) · `GET /api/v1/imports` · `GET /api/v1/imports/get?id=` · `POST /api/v1/imports/mapping` · `POST /api/v1/imports/preview` · `POST /api/v1/imports/confirm` · `POST /api/v1/imports/rollback` · `GET /api/v1/imports/failed-rows?id=`.
MCP (P2): `crm_export_data`, `crm_get_export_status`, `crm_import_data`, `crm_preview_import`, `crm_confirm_import`, `crm_rollback_import` — mesmo padrão dos tools existentes.

#### Agente D — frontend (F6, F10 fica P2) — **P0/P1 · L** — usar o agente `frontend-specialist`

| Cria | Modifica |
|---|---|
| `src/components/settings/DataSection.tsx` · `src/components/settings/ImportWizard.tsx` · `src/components/ui/FileDropZone.tsx` | `src/components/Settings.tsx` (3 edições: union `:24`, array `:40`, render `:73`) · `src/components/DashboardOverview.tsx` (card "Importar/Exportar" vira disponível → navega p/ Configurações) |

Entregáveis:
- **Aba "Dados"** (`DataSection.tsx`): duas partes. *Exportar*: botões rápidos (Contatos CSV, Leads CSV, Tarefas CSV, Backup completo JSON) → `createExportJob` com `toast.promise`; histórico reativo de jobs (status, progresso, "Baixar" quando `completed` usando `getExportDownloadUrl`, erro quando `failed`, "expira em X dias"). *Importar*: botão "Nova importação" abre o wizard + histórico de imports (status, contadores criados/atualizados/pulados/erros, "Baixar linhas com erro", "Desfazer" quando aplicável, com `ConfirmDialog`).
- **`ImportWizard.tsx`**: multi-step no padrão `OnboardingWizard` (useState de step + validateStep), dentro de `Modal`/`SlideOver`. Passos: (1) entidade + `FileDropZone` + upload padrão 3 etapas (`generateUploadUrl` → POST → `saveFile` com `fileType:"import_file"`) + estratégia de duplicata; (2) mapeamento — tabela header→campo com sugestões pré-preenchidas (verde), não mapeados em âmbar, opção "Ignorar", custom fields no dropdown (precedente `CrmMappingSelect.tsx`); (3) dry-run — cards de resumo (total/válidas/erros/novos/atualizações), preview de 10 linhas, amostra de erros; (4) execução — barra de progresso reativa (`progress.processed/total`); (5) resultado. Job persiste server-side ⇒ reabrir wizard retoma pelo status.
- **`FileDropZone.tsx`**: drag-and-drop + clique (hoje só existe `<input type="file">` escondido); aceita `.csv`, mostra nome/tamanho, aviso >10 MB.
- Gate visual: seção só renderiza conteúdo com `can("settings","manage")` (senão aviso padrão `ShieldAlert`).

### Onda 3 — fechamento (serial, sessão principal) — **P0 · S**

`npm test` (tudo verde) + `npm run lint` → atualizar `CHANGELOG.md` (formato com tabela de arquivos), bump minor em `package.json`, sincronizar `CLAUDE.md` raiz/`convex/CLAUDE.md`/`src/CLAUDE.md`, atualizar o bloco de status deste doc, revisão final (code-review dos diffs). Commit só com aprovação do Eric.

---

## 6. Superfície Convex (contrato para C e D consumirem)

| Função | Tipo | Args (resumo) |
|---|---|---|
| `exports.createExportJob` | mutation | `organizationId, format, scope, entity?, columns?` → `jobId` |
| `exports.getExportJobs` | query | `organizationId` → últimos 20 |
| `exports.getExportJob` | query | `organizationId, jobId` |
| `exports.getExportDownloadUrl` | query | `organizationId, jobId` → `string \| null` |
| `imports.createImportJob` | mutation | `organizationId, entity, fileId, fileName, duplicateStrategy` → `jobId` |
| `imports.updateMapping` | mutation | `organizationId, jobId, mapping` |
| `imports.runPreview` | mutation | `organizationId, jobId` |
| `imports.confirmImport` | mutation | `organizationId, jobId` |
| `imports.rollbackImport` | mutation | `organizationId, jobId` |
| `imports.cancelImport` | mutation | `organizationId, jobId` (status pré-execução) |
| `imports.getImportJobs` / `getImportJob` | query | idem exports |
| `imports.getFailedRowsCsv` | query | `organizationId, jobId` → `string` (CSV) |

---

## 7. Backup completo JSON (F2) — formato e conteúdo

```json
{ "format": "hnbcrm-backup", "version": 1, "exportedAt": 0, "organizationId": "...", "entities": { "<tabela>": [ ... ] } }
```

**Incluídas (nesta ordem):** `organizations` (a própria, settings sanitizados), `teamMembers` (sem `userId`), `boards`, `stages`, `leadSources`, `fieldDefinitions`, `taskProjects`, `taskColumns`, `taskLabels`, `conversationLabels`, `quickReplies`, `contacts`, `leads`, `conversations`, `messages` (com `transcriptText`; `attachments` só como ids), `activities`, `tasks`, `taskComments`, `handoffs`, `calendarEvents`, `savedViews`, `webhooks` (**sem `secret`**).

**Excluídas SEMPRE:** `apiKeys`, `orgSecrets`, `channelConfigs` (contém tokens de provider), `aiReplyQueue`, `aiPacing`, `channelPacing`, `agentRuns`, `agentEvals`, `copilotThreads`, `copilotMessages`, `pendingActions`, `notifications`, `notificationPreferences`, `onboardingProgress`, `scheduledMessages`, `forms*`/`formSubmissions`/`formPartials`/`formExperiments*` (P2 sob flag), `files`/`leadDocuments` (binários; P2 metadados), tabelas de auth, `auditLogs` (grande; P2 sob flag).

**Sanitização (`lib/exportSanitize.ts`):** denylist de caminhos (`webhooks.secret`, `organizations.settings.aiConfig.*` chaves sensíveis se houver, qualquer campo `*token*`/`*secret*`/`*keyHash*`) — aplicada a todo doc antes de serializar, e verificada pelo `exportSecurity.test.ts`.

---

## 8. Segurança e LGPD

- Gate `settings:manage` em todas as superfícies (app, REST, MCP) — regra 3/4.
- Download de export: URL assinada do storage (curta duração) via query autenticada; na REST, streaming pelo endpoint autenticado — nunca URL pública persistida.
- Auditoria completa (quem exportou o quê e quando) — export é o evento mais sensível do produto.
- O backup completo atende portabilidade LGPD art. 18 (mencionar na UI: "Backup completo — inclui todos os dados da organização, exceto segredos e chaves").
- `contacts.aiOptOut` e demais dados pessoais saem no export normalmente (é o titular dos dados da org exportando os próprios registros) — sem tratamento especial no v1.

---

## 9. Critérios de aceite (E2E na conta Acme Corp Test)

1. Exportar Contatos CSV → baixar → abrir no LibreOffice: acentos corretos (BOM), custom fields presentes.
2. Backup completo JSON → validar formato/versão, conferir ausência de `secret`/`keyHash`/tokens (grep).
3. Importar CSV de contatos com colunas PT-BR bagunçadas → sugestões de mapeamento corretas → dry-run acusa erros e duplicatas → confirmar → contatos no CRM.
4. Reimportar o mesmo arquivo com `skip` (0 criados) e com `update` (campos atualizados).
5. Import de leads com `boardName`/`stageName` → leads no board certo, contatos vinculados.
6. Rollback → criados somem, atualizados voltam ao estado anterior.
7. CSV com 11k linhas → erro amigável; job de export concorrente → rejeitado.
8. REST: criar export via curl com API key → poll → download com `Content-Disposition`. Key de membro `agent` → 403.
9. Membro `agent` no app não vê a aba Dados funcional.
10. Suíte completa verde + `npm run lint` limpo.

---

## 10. Ordem de execução e dependências

```
Onda 0:  S (schema + libs)                              ← serial, ~1 sessão de agente
Onda 1:  A (export)  ‖  B (import)                      ← paralelo, dependem de S
Onda 2:  C (REST/MCP)  ‖  D (frontend)                  ← paralelo, dependem de A+B
Onda 3:  fechamento (testes, lint, changelog, docs)     ← serial
```

Se for preciso cortar escopo: F9/F10/F11 caem primeiro; F4/F5 podem escorregar para uma segunda rodada; F1+F2+F3+F6 são o núcleo inegociável.

---

## 11. Prompt de kickoff (colar numa sessão nova)

```
Implemente o plano docs/EXPORT-IMPORT-PLAN-v2.md (export/import de dados do HNBCRM).

1. Leia o doc INTEIRO antes de qualquer código — ele é o contrato (schema literal na seção 3,
   regras normativas na seção 4, propriedade de arquivos na seção 5).
2. Execute em ondas:
   - Onda 0 (serial): Agente S — schema + convex/lib/csv.ts + convex/lib/importMapping.ts + testes.
   - Onda 1 (paralelo): lance Agente A (export) e Agente B (import) JUNTOS, cada um com o prompt:
     "Você é o Agente <X> do docs/EXPORT-IMPORT-PLAN-v2.md do repo. Leia o doc inteiro, depois
      implemente SOMENTE os entregáveis da sua seção, tocando SOMENTE nos seus arquivos da tabela
      de propriedade. Siga as regras da seção 4 à risca. Rode seus testes antes de reportar."
   - Onda 2 (paralelo): Agente C (REST/OpenAPI/llms.txt/MCP) e Agente D (frontend — use o
     subagente frontend-specialist).
   - Onda 3 (você, serial): npm test (baseline 410 + novos, tudo verde), npm run lint,
     CHANGELOG.md, bump minor de versão, sincronizar CLAUDE.md (raiz/convex/src) e o status do doc.
3. Escopo FECHADO: só F1–F8 (P0/P1). F9/F10/F11 e restore de backup JSON NÃO entram sem eu pedir.
4. Não faça commit sem eu aprovar. Quando eu autorizar: sem créditos ao Claude no commit.
5. Se um agente precisar tocar arquivo de outro, ele reporta e VOCÊ arbitra — nunca editar direto.
Ao final, me entregue: resumo do que foi feito, contagem de testes, e o checklist da seção 9
com o que dá para validar via convex-test vs. o que fica para E2E vivo comigo.
```
