# Changelog

All notable changes to HNBCRM (formerly ClawCRM) will be documented in this file.

## [0.46.0] - 2026-08-23

### Exportação e importação de dados — backup, migração e portabilidade LGPD

- **Aba "Dados" em Configurações**: exportar e importar num lugar só, com histórico reativo de jobs (status, progresso, "Baixar", "expira em X dias") — o card "Importar/Exportar" do Painel saiu do "em breve"
- **Export CSV por entidade** (contatos, leads, tarefas) com colunas legíveis e desnormalizadas — lead traz contato/funil/estágio/responsável, tarefa traz projeto/coluna/etiquetas — e custom fields achatados (`cf_<chave>`); BOM + RFC 4180 (abre no Excel/LibreOffice com acentos corretos)
- **Backup completo JSON versionado** (`hnbcrm-backup` v1) com as 22 tabelas core na ordem de dependência; segredos NUNCA saem (denylist central `exportSanitize` + teste de build que quebra se vazar) — atende portabilidade LGPD art. 18
- **Import CSV de contatos com wizard de 5 passos**: upload (drag-and-drop) → mapeamento com sugestões automáticas PT-BR/EN (inclusive custom fields) → dry-run com contagem de novos/atualizações/erros e preview de 10 linhas → execução com barra reativa → resultado; fechar e reabrir o wizard retoma de onde parou (o job vive no servidor)
- **Import CSV de leads**: resolve funil/estágio por nome (case-insensitive, com fallback para o board padrão), vincula ou cria o contato por e-mail/telefone e aceita responsável por e-mail
- **Estratégias de duplicata**: pular (padrão), atualizar (célula vazia não apaga nada; etiquetas somam) ou criar mesmo assim
- **Desfazer importação**: rollback apaga os registros criados e reverte os atualizados ao estado anterior, campo a campo
- **"Baixar linhas com erro"**: CSV só com as linhas rejeitadas, pronto para corrigir e reimportar
- Blobs de export ficam no File Storage por **7 dias** (cron horário de limpeza) e não contam na quota de arquivos da org
- **REST API**: 12 rotas novas em `/api/v1/exports/*` e `/api/v1/imports/*` — as primeiras do produto com enforcement de permissão (`settings:manage` → 403); OpenAPI, llms.txt e referências da skill atualizados
- **Webhooks novos**: `export.completed`, `export.failed`, `import.completed`, `import.failed`, `import.rolled_back`
- **RBAC e auditoria**: tudo atrás de `settings:manage` (padrão: só admin); cada transição de job auditada — backup completo com severidade alta
- Limites v1: arquivo ≤ 10 MB, ≤ 10.000 linhas por importação, lotes de 50, 1 job ativo por org por tipo
- 508 testes verdes (34 arquivos) · lint completo

**Arquivos novos:**

| Arquivo | Propósito |
|------|---------|
| `convex/lib/csv.ts` | Parser/serializador CSV RFC 4180 (BOM, auto-detect `,`/`;`) — referência única |
| `convex/lib/importMapping.ts` | Aliases PT-BR/EN → campos, sugestão de mapeamento, coerções e validação por linha |
| `convex/lib/importKeys.ts` | Codificação das chaves do mapeamento (compartilhado por backend, REST e front) |
| `convex/lib/exportColumns.ts` | Colunas por entidade com desnormalização e datas ISO |
| `convex/lib/exportSanitize.ts` | Denylist central de segredos aplicada ao backup |
| `convex/exports.ts` | Jobs de export (CSV/JSON), download, limpeza de expirados |
| `convex/imports.ts` + `convex/importRun.ts` | Wizard server-side: detecção de headers, dry-run, lotes de 50, rollback |
| `src/components/settings/DataSection.tsx` | Aba "Dados" (exportar + importar + históricos) |
| `src/components/settings/ImportWizard.tsx` | Wizard de importação em 5 passos |
| `src/components/ui/FileDropZone.tsx` | Zona de drag-and-drop de arquivo acessível |

**Modificados:** `convex/schema.ts` (3 tabelas novas), `convex/router.ts` (12 rotas + preflights), `convex/crons.ts`, `convex/openapiSpec.ts`, `convex/llmsTxt.ts`, `convex/auditLogs.ts`, `convex/lib/auditDescription.ts`, `src/components/Settings.tsx` (seção Dados + deep-link `?secao=`), `src/components/DashboardOverview.tsx`, `src/pages/DevelopersPage.tsx`, refs da skill hnbcrm.

## [0.45.0] - 2026-08-14

### Repasses IA ↔ Humano fluidos + loop de coaching

- **Sino avisa o repasse**: quando a IA pede ajuda, uma notificação in-app chega para o destinatário (ou para todo mundo que pode responder no inbox, quando não há destinatário) — antes só existia e-mail
- **Espiar antes de assumir**: em Repasses, "Espiar conversa" abre um painel só-leitura com o resumo estruturado e a qualificação BANT; deep-link `/app/repasses?handoff=<id>`
- **Aceitar assume de verdade**: pausa a IA, atribui o lead, desarquiva a conversa e leva direto para o chat em Caixa de Entrada — sem procurar a conversa na lista
- **Rejeitar devolve à IA na hora**; criar um repasse não pausa mais a conversa (a IA já segura sozinha enquanto o pedido está pendente)
- **Banner na conversa** com repasse pendente, com aceitar sem sair do inbox
- **Instruir e regenerar o rascunho da IA**: chips ("Mais formal", "Mais curto", "Mais caloroso", "Oferecer alternativa") e campo livre — o rascunho antigo fica registrado como revisado e não conta nas métricas que liberam o autopilot
- **"Pedir sugestão à IA"**: rascunho do zero, com instrução opcional, mesmo sem mensagem nova do cliente
- **"Devolver para IA"** com instrução opcional: despausa, reatribui ao atendente e cancela o repasse pendente
- Rascunho pedido por humano **sempre** volta para revisão, mesmo em organização no autopilot
- **Webhooks novos**: `handoff.canceled` e `conversation.returned_to_ai`; `handoff.requested` agora inclui `conversationId` e `origin`, `handoff.accepted` inclui `conversationId`
- `GET /api/v1/handoffs` passa a devolver `conversationId` nos itens e aceita `status=canceled` (nenhuma rota nova; o coaching é só pela interface)
- Nova preferência de notificação: "Rascunho da IA aguardando revisão"
- 410 testes verdes

## [0.44.0] - 2026-08-14

### Vínculo tarefa ↔ lead visível e navegável

- **Chip do lead** nas linhas da lista e nos cards do kanban de tarefas — clique leva direto ao lead
- **Seção "Lead" no detalhe da tarefa**: vincular/trocar/remover o vínculo (select), abrir o lead no funil e pular direto para a **Conversa** no inbox
- **Campo Lead no criar tarefa** (antes só dava para vincular pelo painel do lead)
- **Deep-links novos**: `/app/pipeline?lead=<id>` abre o funil com o painel do lead; `/app/entrada?conversation=<id>` abre a conversa; "Ver no funil" do inbox agora cai no painel do lead
- **Aba Tarefas do lead**: clicar numa tarefa abre o detalhe completo em Tarefas; o voltar do navegador refaz o caminho (painel do lead reabre)
- `updateTask` aceita `null` para limpar lead/contato e valida a org do vínculo
- 369 testes verdes · E2E vivo validado (ida e volta tarefa→lead→conversa)

## [0.43.0] - 2026-08-14

### Gestor de tarefas completo — projetos, kanban, etiquetas, multi-responsável e notificações

- **Projetos/listas de tarefas** (`taskProjects`) com kanban por colunas customizáveis (`taskColumns`, coluna de conclusão, WIP limit informativo, 3 colunas padrão ao criar: "A fazer", "Em andamento", "Concluído") e ordenação manual dos cards por drag-and-drop
- **Etiquetas org-wide com cor** (`taskLabels`), substituindo o antigo campo livre `tags` como forma primária de categorizar
- **Múltiplos responsáveis por tarefa** (`assigneeIds`, humanos e IA) — `assignedTo` continua espelhando o primeiro responsável para compatibilidade
- **Subtarefas reais** (`parentTaskId` promovido a hierarquia de verdade, com progresso agregado) e **dependências informativas** (`blockedBy` — não bloqueia conclusão, só avisa na UI); linhagem de recorrência passou a usar `recurrenceSourceId`
- **Lembrete antecipado** configurável por tarefa (`reminderMinutesBefore`) além do aviso no vencimento, com e-mail `taskDueSoon`
- **Menções `@` em comentários de tarefa** agora notificam de verdade — in-app e e-mail `taskCommentMention`
- **Notificações in-app** — sino no cabeçalho (tabela `notifications`), cobrindo atribuição, menção, lembrete antecipado e atraso
- **Busca full-text de tarefas na UI** (antes só client-side por título), **filtros salvos** (`savedViews` para `entityType: "tasks"`) e deep-link `/app/tarefas?task=<id>`
- **Webhooks novos**: `task.moved`, `task.due_soon`, `task_project.created/updated/archived/deleted`, `task_label.created/updated/deleted`
- Migração `tasks:migrateTasksP1` (linhagem de recorrência existente movida de `parentTaskId` para `recurrenceSourceId`, backfill de `assigneeIds`) e fix de `updateTask` para gravar `completedAt` corretamente
- 348 testes verdes (26 arquivos) · lint completo · E2E vivo validado

## [0.37.0] - 2026-07-28

### IA v4.2 — Ativação em 1 fluxo + atendente que preenche o CRM

- **Wizard de ativação única**: liga a IA, registra LGPD + aceite de risco do bridge e cria o atendente numa tela só (`activateOneFlow`, mesma auditoria do caminho em passos); CTA no Painel quando a IA está desligada
- **Atendente nasce 24h** (sem horário) — em modo sugestão nada sai sem revisão; o aviso de horário migrou para o toggle de autopilot
- **Fim do skip silencioso**: elegibilidade reprovada deixa rastro e o inbox mostra "IA em espera: <motivo>" / "IA preparando resposta…" (`getConversationAiState`)
- **Captura de dados pela IA**: tools `updateThisContact` (nome/e-mail) e `updateThisLeadInfo` (título/valor/temperatura + custom fields com whitelist `captureFields` validada por tipo/opções no servidor)
- **Ações aprováveis no rascunho**: as ações propostas viram checkboxes com rótulo humano; aprovar envia o texto E executa as marcadas pelo mesmo executor gated do autopilot (`acceptAiDraft` + `actionIndexes`; resultados em `appliedActions`)
- **Descoberta do lead**: inbox mostra funil→estágio com "Ver no funil" (deep-link `?board=`), pipeline lembra o último board por org, card do atendente mostra onde os leads novos caem
- 270 testes verdes (20 arquivos) · lint completo

## [0.36.0] - 2026-07-26

### AI Agent Config — Copiloto in-app + Atendente WhatsApp (opt-in total)

Dois produtos de IA nativos num runtime LLM provider-agnostic (OpenAI-compatible; default OpenCode Go, fallback OpenRouter implementado e inativo sem key). Tudo opt-in por organização: `aiConfig.enabled` nasce `false` e a ativação exige aceite LGPD.

- **Copiloto** — chat SSE autenticado que age COMO o usuário logado (RBAC dele, auditoria `via:"copilot"`); tools de leitura/escrita; ações destrutivas via confirmação two-phase
- **Atendente WhatsApp** — fila com debounce/coalescing, lock OCC por conversa e commit transacional que re-checa 11 condições de elegibilidade (TOCTOU); modo sugestão default (rascunho revisado no inbox); autopilot com gate server-side (10+ sugestões revisadas, 60%+ aceitação)
- **Segurança em 4 camadas** — `assertAgentCan` (RBAC+org), escopo por registro, TOOL_DENYLIST com teste de build, envelope de dado não-confiável
- **Bridge opt-in** — atendente atua em canais não-oficiais SOMENTE com aceite de risco org-level (`bridgeAiAck`), re-checado no commit (revogar aborta runs em voo)
- **Fila de envio anti-ban (todos os envios WhatsApp)** — pacing em dois níveis: cursor por conversa (pair rate Meta 6,5s) + cursor por número (`channelPacing`; Meta 1–3s, bridge reativo 4–10s / frio 8–15s com jitter); typing simulado no bridge para envios de IA/agendados; retry com backoff oficial 4^X (131056/130429/80007); erro 131048 (spam-flag) congela o canal 30min + alerta
- **Toggles separados** Copiloto × Atendente sob o mestre
- **Regras de pipeline do atendente** — board/estágio inicial no roteamento inbound, avanço determinístico por qualificação BANT, `allowMoveStages` com enforcement server-side, regras de funil em linguagem natural no prompt
- **Config/UX** — Configurações → IA: ativação com modal LGPD, atendente 1-toque com personas por indústria, simulador sandbox, medidor de uso/custo, budget mensal, seletor de modelos com selo ZDR/residência, BYO key cifrada
- 257 testes verdes (18 arquivos) · lint completo · E2E browser 10/10

## [0.35.0] - 2026-07-24

### Lista de Leads + Operações em Massa + Arquivamento

- Visão de lista dos leads (alternável com o kanban) com ordenação e seleção múltipla
- Barra de ações em massa: mover estágio, atribuir, etiquetar, arquivar
- Arquivamento de leads fora do fluxo padrão
- Form-builder page legada removida

## [0.29.0 – 0.34.0] - 2026-07-19

### Canal WhatsApp (Cloud API + Bridge) + Upgrade do Inbox

- **WhatsApp oficial (Meta Cloud API)** — configs por organização com credenciais cifradas, ingress multi-tenant (`/webhooks/whatsapp` roteado por `phoneNumberId`), janela de 24h com templates, painel de saúde do canal
- **WhatsApp bridge (não-oficial, opt-in)** — gateway wuzapi self-hosted (whatsmeow), pareamento por QR, ingress HMAC-SHA256, mídia bidirecional, presença de digitação e recibos nos dois sentidos; aceite de risco obrigatório
- **Inbox** — transcrição de notas de voz via Whisper self-hosted (busca inclui transcrições), busca full-text de mensagens, respostas rápidas (`/`), mensagens agendadas com contagem regressiva, etiquetas + arquivamento com ações em massa, reações/replies/encaminhamento

## [0.26.0] - 2026-03-01

### Full UTM Capture + Native A/B Testing for Forms

Two major upgrades: fix the UTM capture bug and extend to all 5 standard params with cross-session persistence, and build a complete native A/B testing system — a competitive differentiator since Typeform, Jotform, HubSpot, and Tally all lack it.

#### Feature 1: URL Parameter Prefill + Auto UTM Capture

Fixes a backend bug where body-sent UTM values were silently dropped (only `Referer` header parsing worked). Adds `utm_content` and `utm_term` support. Implements cross-page UTM persistence via sessionStorage + 30-day cookie. Forwards parent-page UTMs to embedded iframes automatically.

- **`convex/schema.ts`** — Added `utmContent`, `utmTerm` to `formSubmissions` and `formPartials` tables
- **`convex/router.ts`** — Fixed UTM bug: body values now take priority over referrer-parsed ones in both submit and partial endpoints. All 5 UTM params passed through to processing functions
- **`convex/formSubmissions.ts`** — `internalProcessSubmission` accepts and stores `utmContent`, `utmTerm` in all 3 insert paths (spam, error, success)
- **`convex/formPartials.ts`** — `internalSavePartial` accepts and stores `utmContent`, `utmTerm`
- **`src/lib/utmPersistence.ts`** (new) — UTM resolution cascade: URL params → sessionStorage → 30-day first-party cookie. `resolveUtmParams()` + `persistUtm()` exports
- **`src/pages/PublicFormPage.tsx`** — Uses `resolveUtmParams` instead of raw `searchParams.get()`, sends all 5 UTM params in submit payload
- **`src/embed/loader.ts`** — Forwards parent page's `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` to iframe src
- **`convex/embedScript.ts`** — Rebuilt with UTM forwarding logic

#### Feature 2: UTM Analytics Enhancement

- **`convex/formSubmissions.ts`** — `getFormAnalytics` now returns breakdowns for all 5 UTM dimensions (`utmSources`, `utmMediums`, `utmCampaigns`, `utmContents`, `utmTerms`) using shared `buildUtmBreakdown` helper
- **`src/components/forms/FormAnalyticsPage.tsx`** — Replaced single UTM source table with tabbed section: Fonte | Midia | Campanha | Conteudo | Termo. Each tab shows bar-chart breakdown with count badges

#### Feature 3: Native A/B Testing

Complete A/B testing system built from scratch. Deterministic variant assignment via MurmurHash3, Bayesian statistics with Monte Carlo simulation for statistical significance.

- **`convex/schema.ts`** — 2 new tables: `formExperiments` (status lifecycle: draft → running → paused → concluded), `formExperimentVariants` (traffic weights in basis points, view/conversion counters). Added `experimentId`, `variantId`, `visitorId` to `formSubmissions` and `formPartials`
- **`convex/formExperiments.ts`** (new) — Full experiment backend:
  - Mutations: `createExperiment` (duplicates form for variant B, 50/50 split), `startExperiment`, `pauseExperiment`, `resumeExperiment`, `concludeExperiment` (records winner), `updateTrafficSplit` (validates sum=10000), `deleteExperiment`, `internalRecordView`, `internalRecordConversion`
  - Queries: `getExperiment` (with Bayesian stats), `getExperimentByForm`, `listExperiments`, `internalGetActiveExperiment`
  - Bayesian stats: Beta-Binomial model, 10,000 Monte Carlo samples via xorshift32 PRNG, 95% credible intervals, probability of winning per variant
- **`convex/router.ts`** — GET `/api/v1/forms/public` returns experiment config (variants with keys/weights) alongside form data. New POST `/api/v1/forms/experiment/view` for view tracking. Submit endpoint passes `experimentId`/`variantId`/`visitorId` through
- **`convex/formSubmissions.ts`** — After successful submission with `variantId`, calls `internalRecordConversion` to increment variant counter
- **`src/lib/abTesting.ts`** (new) — MurmurHash3 (32-bit), `getVisitorId()` (localStorage-persisted), `selectVariant()` (hash-based bucketing into 0-10000 range)
- **`src/pages/PublicFormPage.tsx`** — After fetching form, checks for active experiment, selects variant deterministically, fetches variant form data if non-control, fires view tracking (fire-and-forget with keepalive), includes experiment data in submit payload
- **`src/components/forms/FormExperimentPage.tsx`** (new) — Experiment dashboard: status management (start/pause/resume), variant comparison table (visitors, conversions, rate, probability), visual probability bar, traffic split slider, winner declaration with ConfirmDialog
- **`src/components/forms/experiment/ExperimentSetupModal.tsx`** (new) — Modal for creating experiments: name input, hypothesis textarea, info card explaining variant B creation
- **`src/components/forms/FormBuilderPage.tsx`** — Experiment bar between header and content: shows "Criar Teste A/B" button or active experiment status/stats with link to dashboard
- **`src/components/forms/FormListPage.tsx`** — A/B badge (FlaskConical icon) on form cards with active experiments
- **`src/main.tsx`** — New route: `/app/formularios/:formId/experimento/:experimentId`

#### Files Created (5)

| File | Purpose |
|------|---------|
| `src/lib/utmPersistence.ts` | UTM resolution: URL → sessionStorage → cookie |
| `src/lib/abTesting.ts` | MurmurHash3, visitorId, deterministic variant selection |
| `convex/formExperiments.ts` | Experiment CRUD, variant management, Bayesian stats |
| `src/components/forms/FormExperimentPage.tsx` | A/B test dashboard page |
| `src/components/forms/experiment/ExperimentSetupModal.tsx` | Create experiment modal |

#### Files Modified (10)

| File | Changes |
|------|---------|
| `convex/schema.ts` | +`utmContent`/`utmTerm` on 2 tables, +`experimentId`/`variantId`/`visitorId` on 2 tables, +2 new tables |
| `convex/router.ts` | UTM body-priority bug fix, experiment in form GET, view tracking endpoint, experiment fields in submit |
| `convex/formSubmissions.ts` | UTM + experiment args, conversion tracking, 5-dimension UTM analytics |
| `convex/formPartials.ts` | UTM + experiment args |
| `convex/embedScript.ts` | Rebuilt with UTM forwarding |
| `src/pages/PublicFormPage.tsx` | UTM persistence, A/B variant routing, experiment submit data |
| `src/embed/loader.ts` | Forward parent UTMs to iframe |
| `src/components/forms/FormAnalyticsPage.tsx` | Tabbed 5-dimension UTM breakdown |
| `src/components/forms/FormBuilderPage.tsx` | Experiment bar with status/stats |
| `src/components/forms/FormListPage.tsx` | A/B badge on cards |
| `src/main.tsx` | Experiment route |

---

## [0.25.0] - 2026-03-01

### Partial Submission Recovery + Popup/Widget Embeds

Two Tier 1 features: recover data from the 67% of forms that are abandoned mid-fill, and embed forms as popups, slide-ins, and side tabs that convert 3-5x better than static iframes.

#### Feature 1: Partial Submission Recovery

Automatically captures field data as visitors fill out forms, even if they never submit. A cron job marks stale sessions as abandoned, and successful submissions convert the partial record.

- **`convex/schema.ts`** — New `formPartials` table (sessionId, status, data, completedFieldIds, completionPercent, 5 indexes), `sessionId` on `formSubmissions`, `partialCaptureEnabled` in form settings
- **`convex/formPartials.ts`** (new) — `internalSavePartial` (upsert with 2s server-side throttle), `internalMarkConverted`, `internalMarkAbandoned` (15-min threshold + `form.abandoned` webhook), `getFormPartials`, `getPartialStats`
- **`convex/crons.ts`** — 10-minute cron for abandoned partial detection
- **`convex/formSubmissions.ts`** — `internalProcessSubmission` accepts `sessionId`, stores on record, calls `internalMarkConverted` on success
- **`convex/forms.ts`** — `deleteForm` deletes related `formPartials`
- **`convex/router.ts`** — `POST /api/v1/forms/public/partial` (public, handles `sendBeacon` text/plain), `sessionId` passed through submit endpoint, `partialCaptureEnabled` in GET response
- **`src/components/forms/renderer/usePartialCapture.ts`** (new) — Client hook: `sessionId` via `crypto.randomUUID()` persisted in `sessionStorage`, debounced save (2s), `navigator.sendBeacon` on `beforeunload`, periodic save (45s), immediate save on step change
- **`src/components/forms/renderer/FormRenderer.tsx`** — Integrates `usePartialCapture` hook, LGPD transparency notice, `onBlur` callback for partial tracking
- **`src/components/forms/renderer/FormField.tsx`** — `onBlur` prop added to all input types (text, email, phone, number, date, url, select, textarea, checkbox, radio)
- **`src/components/forms/FormSubmissionsPage.tsx`** — "Parciais" tab with stats bar (total, abandoned, converted, conversion rate), status filter tabs, progress bar per partial, expandable data preview, mobile cards
- **`src/components/forms/builder/FormSettingsPanel.tsx`** — "Captura parcial" toggle section
- **`src/pages/PublicFormPage.tsx`** — Passes `formSlug`, `siteUrl`, `onSessionId` to `FormRenderer`, includes `sessionId` in submit request body

#### Feature 2: PostMessage Protocol (Embed Bridge)

- **`src/pages/PublicFormPage.tsx`** — Detects `?embed=1` query param for embed mode (minimal wrapper, no min-height), `ResizeObserver` → `hnbcrm:resize`, posts `hnbcrm:ready` and `hnbcrm:submitted`, listens for `hnbcrm:prefill` from parent

#### Feature 3: Popup/Widget Embed System

Lightweight vanilla JS loader (2.63 KB gzipped) that external sites include via a single `<script>` tag. Zero dependencies.

- **`src/embed/loader.ts`** (new) — IIFE reading `data-*` attributes from its own script tag. 4 display modes: **inline** (auto-height iframe in container), **popup** (overlay + centered dialog, fade animation), **slidein** (fixed bottom-right panel, slide-up), **sidetab** (persistent edge tab + expandable panel). 4 triggers: **click** (`[data-hnbcrm-open]` elements), **delay** (configurable seconds), **scroll** (percentage threshold), **exit_intent** (desktop mouseleave + mobile swipe detection). Suppression via `localStorage` with configurable days. PostMessage handling for resize/ready/submitted. All CSS injected via `<style>`, `hnbcrm-` prefixed classes. Closes on Escape key and overlay click.
- **`vite.embed.config.ts`** (new) — Separate Vite config: lib mode, IIFE format, esbuild minification, `publicDir: false`
- **`convex/embedScript.ts`** (new) — Exports embed loader as string constant for HTTP serving
- **`convex/router.ts`** — `GET /api/v1/embed.js` serves script with 24h cache + CORS
- **`package.json`** — `build:embed` script

#### Feature 4: Embed Configuration UI

- **`src/components/forms/builder/EmbedConfigPanel.tsx`** (new) — Mode selector (4 visual cards), trigger selector (popup/slidein), trigger-specific inputs (delay seconds, scroll %), suppression days, tab label + position (sidetab), live-updating code snippet with copy button
- **`src/components/forms/builder/PublishDialog.tsx`** — Rewritten with tabbed interface: "Status" tab (existing publish/unpublish flow) + "Incorporacao" tab (embed configuration)

#### Files Created (6)

| File | Purpose |
|------|---------|
| `convex/formPartials.ts` | Partial submission CRUD + cron handler |
| `convex/embedScript.ts` | Embed loader JS content for HTTP serving |
| `src/components/forms/renderer/usePartialCapture.ts` | Client-side partial capture hook |
| `src/components/forms/builder/EmbedConfigPanel.tsx` | Embed config UI panel |
| `src/embed/loader.ts` | Standalone embed loader (vanilla TS, 2.63 KB gzipped) |
| `vite.embed.config.ts` | Vite build config for embed script |

#### Files Modified (12)

| File | Changes |
|------|---------|
| `convex/schema.ts` | `formPartials` table, `sessionId` on submissions, `partialCaptureEnabled` setting |
| `convex/router.ts` | `POST /partial`, `GET /embed.js` endpoints, `sessionId` in submit, `partialCaptureEnabled` in GET |
| `convex/formSubmissions.ts` | `sessionId` arg + storage, `internalMarkConverted` call |
| `convex/forms.ts` | Partials cleanup on form deletion |
| `convex/crons.ts` | Abandonment detection cron (10 min) |
| `src/pages/PublicFormPage.tsx` | PostMessage protocol, embed mode, partial capture integration |
| `src/components/forms/renderer/FormRenderer.tsx` | `usePartialCapture` hook, LGPD notice, `onBlur` wiring |
| `src/components/forms/renderer/FormField.tsx` | `onBlur` prop on all input types |
| `src/components/forms/builder/PublishDialog.tsx` | Tabbed UI (Status + Incorporacao) |
| `src/components/forms/builder/FormSettingsPanel.tsx` | Partial capture toggle |
| `src/components/forms/builder/types.ts` | `partialCaptureEnabled` in FormSettings |
| `package.json` | `build:embed` script |

---

## [0.24.0] - 2026-03-01

### Form Builder v2 — 7 Major Upgrades

Complete overhaul of the form builder with submission management, 6 new field types, conditional logic, multi-step forms, analytics dashboard, server-side validation, and post-submission experience.

#### Phase 1: Submission Management View

- **`FormSubmissionsPage.tsx`** (new) — Paginated table with status filter tabs (Todas/Processadas/Spam/Erros), expandable rows showing all field values, desktop table + mobile card layout, CSV export with UTF-8 BOM
- **`formSubmissions.ts`** — Added `getFormSubmissionsPaginated` query using cursor-based pagination (`paginationOptsValidator`) with optional status filter via `by_form_and_status` index
- **`formSubmissions.ts`** — Added `getFormAnalytics` query returning daily breakdown, UTM source analysis, spam rate
- **`schema.ts`** — Added `by_form_and_status` index to `formSubmissions` table
- **`main.tsx`** — Route `/app/formularios/:formId/submissoes`
- **`FormListPage.tsx`** — Added "Ver submissoes" and "Analytics" quick links per form card

#### Phase 2: Additional Field Types (6 new)

Expanded from 8 to 14 field types: `radio`, `url`, `hidden`, `heading`, `divider`, `rating`.

- **`schema.ts`** — Expanded field type union with 6 new literals
- **`convex/lib/formFieldTypes.ts`** (new) — Shared `LAYOUT_FIELD_TYPES` and `OPTIONS_FIELD_TYPES` constants
- **`builder/types.ts`** — Rewritten with `FieldType` union, `ConditionalLogic`, `FormStep`, expanded `FormSettings`
- **`builder/FieldPalette.tsx`** — Split into "Campos de Entrada" (12 types) and "Layout" (2 types) sections
- **`builder/FieldCard.tsx`** — Extended icon/label maps for 6 new types
- **`builder/FieldConfigPanel.tsx`** — Per-type config: hidden (valor fixo), heading (titulo text), divider (visual-only message), rating (simplified), radio (reuses options editor)
- **`renderer/FormField.tsx`** — Rewritten with renderers for all 14 types including `RatingInput` (clickable stars with hover state), radio fieldset, url input, hidden input, heading `<h3>`, divider `<hr>`
- **`FormBuilderPage.tsx`** — Updated `DEFAULT_LABELS` and `createNewField()` for new types

#### Phase 3: Conditional Logic / Field Visibility Rules

Show/hide fields based on other field values with AND/OR logic and 8 operators.

- **`schema.ts`** — Added optional `conditionalLogic` object to field definition: `action` (show/hide), `logic` (all/any), `conditions[]` with `fieldId`, `operator` (equals, not_equals, contains, not_contains, is_empty, is_not_empty, greater_than, less_than), `value`
- **`builder/ConditionalLogicEditor.tsx`** (new) — Toggle + condition rows UI with field/operator/value selectors, SegmentControl for action/logic, filters out current field and layout fields
- **`builder/FieldConfigPanel.tsx`** — Integrated ConditionalLogicEditor section, added `allFields` prop
- **`renderer/FormRenderer.tsx`** — `evaluateFieldVisibility()` callback; hidden fields get `display: none`; excluded from submit payload
- **`formSubmissions.ts`** — Server-side `evaluateFieldVisibilityServer()` mirrors client logic; only visible fields mapped to CRM

#### Phase 4: Multi-Step Forms

Step grouping with progress bar, per-step validation, and backward-compatible design.

- **`schema.ts`** — Added optional `steps` array to forms table: `{ id, title, description?, fieldIds[] }`
- **`builder/StepManager.tsx`** (new) — Enable toggle, step cards with field assignment (pill-based add/remove), reorder, add/delete, unassigned fields warning
- **`FormBuilderPage.tsx`** — "Etapas" tab in editor, `steps` state with dirty tracking, save/publish includes steps
- **`renderer/FormRenderer.tsx`** — Multi-step rendering: one step at a time, Anterior/Proximo/Enviar buttons, `StepProgressBar` component, per-step validation
- **`forms.ts`** — `publishForm` validates every field assigned to exactly one step; `updateForm`/`duplicateForm` include steps
- **`router.ts`** — Public form GET includes `steps` in response

#### Phase 5: Form Analytics Dashboard

- **`FormAnalyticsPage.tsx`** (new) — Summary cards (total, 7d, 30d, spam rate), inline SVG sparkline chart (polyline + gradient fill), status breakdown with semantic badges, UTM source table with horizontal bar chart
- **`main.tsx`** — Route `/app/formularios/:formId/analytics`

#### Phase 6: Server-Side Validation + Duplicate Prevention

- **`formSubmissions.ts`** — `validateSubmissionData()` helper mirroring client validation (required, email regex, url, rating, min/max, pattern); called in `internalProcessSubmission`; invalid submissions stored as `processingStatus: "error"`
- **`formSubmissions.ts`** — `hashSubmissionData()` for duplicate detection; queries recent submissions (60s window); rejects if fingerprint matches
- **`router.ts`** — Returns `422` for validation errors, `409` for duplicates with structured JSON responses

#### Phase 7: Custom Thank You Page + Confirmation Email

- **`schema.ts`** — Expanded `settings`: `successTitle`, `successSubtitle`, `successCta` (label + url), `confirmationEmail` (enabled, subject, body, replyTo)
- **`builder/FormSettingsPanel.tsx`** — "Pagina de sucesso" section (title/subtitle with `{variable}` hint, CTA button fields) + "Email de confirmacao" section (toggle, subject, body textarea, reply-to)
- **`renderer/FormSuccess.tsx`** — Rewritten with `replaceVariables()` for `{field}` template support, optional CTA button, fallback to simple message
- **`email.ts`** — Added `sendConfirmationEmail` internal mutation using Resend component
- **`emailTemplates.ts`** — Added `buildFormConfirmationTemplate()` with variable replacement + "formConfirmation" dispatcher case
- **`router.ts`** — Public form GET includes `successTitle`, `successSubtitle`, `successCta`

#### Files Created (5)

| File | Purpose |
|------|---------|
| `convex/lib/formFieldTypes.ts` | Shared constants for layout/options field types |
| `src/components/forms/FormSubmissionsPage.tsx` | Paginated submissions table with filters + CSV export |
| `src/components/forms/FormAnalyticsPage.tsx` | Analytics dashboard with sparkline + UTM breakdown |
| `src/components/forms/builder/ConditionalLogicEditor.tsx` | Conditional logic rule editor |
| `src/components/forms/builder/StepManager.tsx` | Multi-step form manager |

#### Files Modified (18)

| File | Changes |
|------|---------|
| `convex/schema.ts` | 6 new field types, conditionalLogic, steps, expanded settings, new index |
| `convex/formSubmissions.ts` | Paginated query, analytics, server validation, dedup, conditional logic eval, confirmation email |
| `convex/forms.ts` | Step validation in publish, steps in update/duplicate, layout field filtering |
| `convex/router.ts` | Steps + success settings in GET, 422/409 responses in submit |
| `convex/email.ts` | `sendConfirmationEmail` internal mutation |
| `convex/emailTemplates.ts` | `buildFormConfirmationTemplate` + dispatcher case |
| `src/main.tsx` | 2 new lazy routes (submissions, analytics) |
| `src/components/forms/FormBuilderPage.tsx` | Steps state, StepManager tab, allFields to config panel |
| `src/components/forms/FormListPage.tsx` | Quick links (submissions, analytics) |
| `src/components/forms/builder/types.ts` | FieldType union, ConditionalLogic, FormStep, expanded FormSettings |
| `src/components/forms/builder/FieldPalette.tsx` | Grouped sections, 6 new field buttons |
| `src/components/forms/builder/FieldCard.tsx` | 6 new icon/label entries |
| `src/components/forms/builder/FieldConfigPanel.tsx` | Per-type configs, ConditionalLogicEditor integration |
| `src/components/forms/builder/FormSettingsPanel.tsx` | Success page + confirmation email settings |
| `src/components/forms/renderer/FormField.tsx` | 6 new field renderers (rating, radio, url, hidden, heading, divider) |
| `src/components/forms/renderer/FormRenderer.tsx` | Conditional logic, multi-step, new field types, error handling |
| `src/components/forms/renderer/FormSuccess.tsx` | Variable replacement, CTA button |

---

## [0.23.0] - 2026-03-01

### Landing Page & Developer Portal — GitHub + Open-Source Overhaul

GitHub presence, open-source credibility, and community links added across landing page and developer portal. Shared footer, extracted hook, and section reorder for better conversion flow.

#### New Files

- **`src/hooks/useInView.ts`** — Extracted shared `useInView` IntersectionObserver hook (was inline in LandingPage)
- **`src/components/landing/OpenSourceSection.tsx`** — Replaces SocialProofBar with open-source credibility section: MIT License badge, 3 stat cards (v0.22.0, 44+ MCP tools, TypeScript 99%), tech stack badges (React, Convex, TailwindCSS, TypeScript), centered GitHub CTA
- **`src/components/landing/Footer.tsx`** — Shared 4-column footer used by both LandingPage and DevelopersPage: Brand column, Produto (Funcionalidades, Precos, Roadmap, Entrar), Desenvolvedores (Docs, Playground, MCP, Agent Skills), Comunidade (GitHub, npm, Contribuir, Seguranca). Copyright 2026 + MIT License link

#### Landing Page (`src/components/LandingPage.tsx`)

- **Header** — Added GitHub icon link (lucide-react `Github`) before Developers/Entrar nav items
- **Hero CTAs** — Replaced "Ver Funcionalidades" scroll button with "Ver no GitHub" external link with Github icon
- **Section reorder** — `OpenSourceSection → Features → Developer → HowItWorks → ComingSoon → Pricing → CTA` (HowItWorks moved before ComingSoon for better conversion flow)
- **DeveloperSection** — Added 5th card "Codigo Aberto" linking to GitHub repo; grid updated to `lg:grid-cols-5`; external link handling for non-internal routes
- **CTASection** — Added "ou explore o codigo no GitHub" soft text link below primary CTA button
- **Footer** — Replaced inline footer with shared `<Footer />` component
- **Cleanup** — Removed `SocialProofBar` function, inline `useInView` hook, unused imports (`Sparkles`, `TrendingUp`, `Zap as Lightning`)

#### Developer Portal (`src/pages/DevelopersPage.tsx`)

- **Header** — Added GitHub icon link before "Voltar" button
- **Desktop sidebar** — Added GitHub external link at bottom with divider separator
- **Hero section** — Added "Open Source — MIT License" badge linking to GitHub and "npm: hnbcrm-mcp" linking to npmjs.com
- **Quick Start** — Added self-host card before existing steps: `git clone`, `npm install`, `npm run dev` in CodeBlock
- **Footer** — Replaced inline footer with shared `<Footer />` component

#### Links

- All GitHub links → `github.com/ericmil87/hnbcrm` (new tab)
- All npm links → `npmjs.com/package/hnbcrm-mcp` (new tab)
- Copyright updated from 2025 to 2026

---

## [0.22.0] - 2026-02-19

### Form Builder — WYSIWYG Editor, Public Forms & Embeds

Complete embeddable form system: visual form builder with drag-and-drop fields, customizable themes, CRM field mapping, public form URLs, honeypot spam protection, and iframe/script embed codes.

#### Schema — 2 New Tables (`convex/schema.ts`)

- **`forms` table** — Form definitions with embedded field array, theme config, lead creation settings, assignment modes
  - **8 field types**: text, email, phone, number, select, textarea, checkbox, date
  - **CRM mapping**: Each field optionally maps to a contact or lead entity field
  - **Theme object**: primaryColor, backgroundColor, textColor, borderRadius, showBranding
  - **Settings object**: submitButtonText, successMessage, redirectUrl, leadTitle template, boardId/stageId/sourceId, assignmentMode (none/specific/round_robin), defaultPriority, defaultTemperature, tags, honeypotEnabled, submissionLimit, notifyOnSubmission, notifyMemberIds
  - **4 indexes**: `by_organization`, `by_organization_and_status`, `by_slug`, `by_organization_and_slug`
- **`formSubmissions` table** — Submission data with lead/contact linkage, UTM tracking, spam detection
  - **Processing statuses**: processed, spam, error
  - **3 indexes**: `by_form`, `by_form_and_created`, `by_organization_and_created`

#### Backend — `convex/forms.ts` (10 functions)

- **Queries**: `getForms`, `getForm`, `checkSlugAvailability`, `internalGetPublishedForm`
- **Mutations**: `createForm` (with default fields + auto-slug), `updateForm`, `publishForm`, `unpublishForm`, `archiveForm`, `deleteForm` (cascade deletes submissions), `duplicateForm`
- All mutations include audit logging and webhook triggers

#### Backend — `convex/formSubmissions.ts` (3 functions)

- **`internalProcessSubmission`** — Processes public submission: validates honeypot, extracts CRM-mapped fields, finds/creates contact, creates lead (with assignment mode logic), stores submission, logs activity/audit, triggers webhooks, sends email notifications
- **`getFormSubmissions`** — Paginated submission list per form
- **`getFormStats`** — Submission analytics: total, processed, spam, error, last 7d, last 30d

#### HTTP API — 2 Public Endpoints (`convex/router.ts`)

- **`GET /api/v1/forms/public?slug=xxx`** — Fetch published form by slug (no auth required, returns sanitized fields/theme/settings)
- **`POST /api/v1/forms/public/submit`** — Submit form data (no auth, body: `{ slug, data, _honeypot }`), returns `{ success, leadId, contactId }`
- CORS preflight routes for both endpoints

#### Frontend — 14 New Components (`src/components/forms/`)

**Builder components** (`builder/`):
- **FieldPalette.tsx** — Sidebar palette with 8 draggable field types
- **FieldCanvas.tsx** — Drag-and-drop canvas for arranging form fields
- **FieldCard.tsx** — Individual field card in the canvas (draggable, click to configure)
- **FieldConfigPanel.tsx** — Property editor for selected field (label, placeholder, required, validation, width)
- **CrmMappingSelect.tsx** — Contact/lead field mapping selector
- **FormSettingsPanel.tsx** — Lead creation settings (title template, board, stage, source, assignment, priority, temperature, tags)
- **ThemePanel.tsx** — Visual theme editor (colors, border radius, branding toggle) with live preview
- **PublishDialog.tsx** — Publish confirmation with shareable URL, iframe embed code, and script embed code
- **types.ts** — Shared TypeScript types for the builder

**Renderer components** (`renderer/`):
- **FormRenderer.tsx** — Renders form from field definitions with validation and submission
- **FormField.tsx** — Individual field renderer (8 types) with error states
- **FormSuccess.tsx** — Post-submission success screen with custom message

**Page components**:
- **FormListPage.tsx** — Form management list with status badges, submission counts, quick actions (route: `/app/formularios`)
- **FormBuilderPage.tsx** — Full WYSIWYG form builder with tabbed panels (Fields, Settings, Theme), live preview, auto-save (route: `/app/formularios/:id`)

#### Public Form Page (`src/pages/PublicFormPage.tsx`)

- Standalone page at `/f/:slug` — fetches form via public HTTP endpoint, renders with FormRenderer
- No authentication required — accessible to anyone with the link
- Honeypot field for spam protection, UTM parameter tracking
- SEO meta tags via `<SEO />` component

#### Navigation

- New `/app/formularios` route in `src/lib/routes.ts`
- New `/app/formularios/:id` route for form builder
- New `/f/:slug` public route for form rendering
- "Formularios" tab added to Sidebar (desktop) and BottomTabBar (mobile)

#### Documentation Updates

- **`convex/CLAUDE.md`** — Added `forms.ts` and `formSubmissions.ts` to file layout table
- **`src/CLAUDE.md`** — Added `forms/` directory tree and `PublicFormPage.tsx` to component structure
- **`convex/llmsTxt.ts`** — Added Form and FormSubmission data models, public form endpoints
- **`README.md`** — Added "Embeddable Forms" to features list
- **`.claude/skills/hnbcrm/SKILL.md`** — Mentioned form submission workflow
- **`.claude/skills/hnbcrm/references/WORKFLOWS.md`** — Added Workflow 8: Form Submission
- **`.claude/skills/hnbcrm/references/API_REFERENCE.md`** — Added public form endpoints
- **`.claude/skills/hnbcrm/references/DATA_MODEL.md`** — Added Form and FormSubmission entities

---

## [0.21.0] - 2026-02-19

### Email Notification System — Resend Integration, Templates & Preferences

Complete transactional email system using `@convex-dev/resend` with 8 PT-BR templates, per-member opt-out preferences, daily digest cron, and full MCP/REST API integration.

#### Backend — Email Infrastructure

**`convex/email.ts`** — Central email module
- **Resend component instance** — `@convex-dev/resend` wrapper with `testMode: true` (dev safety) and event webhook handler
- **`dispatchNotification` internal mutation** — Single entry point for all email sends; checks recipient is human with email, checks opt-out preferences, builds template, sends via Resend
- **`sendDailyDigest` internal mutation** — Iterates all orgs, gathers 24h stats (new leads, completed tasks, pending handoffs, overdue tasks), sends digest to eligible members
- **`handleEmailEvent`** — Resend webhook handler for delivery status tracking

**`convex/emailTemplates.ts`** — 8 PT-BR dark-theme email templates
- **`invite`** — Welcome email with temp credentials and CTA button
- **`handoffRequested`** — Handoff request with lead details and suggested actions
- **`handoffResolved`** — Handoff accepted/rejected notification with status color
- **`taskOverdue`** — Overdue task reminder with due date
- **`taskAssigned`** — New task assignment notification
- **`leadAssigned`** — Lead assignment with value and contact info
- **`newMessage`** — New inbound message with preview and channel label
- **`dailyDigest`** — 4-metric summary card (new leads, completed tasks, pending handoffs, overdue tasks)
- All templates use shared `baseTemplate` with HNBCRM branding (orange accent, dark card, pill CTA button)

**`convex/convex.config.ts`** — Convex component registration
- Registers `@convex-dev/resend` component for email delivery

#### Schema & Preferences (`convex/schema.ts`, `convex/notificationPreferences.ts`)

- **`notificationPreferences` table** — Per-member opt-out model (no row = all enabled)
- **8 boolean fields** — `invite`, `handoffRequested`, `handoffResolved`, `taskOverdue`, `taskAssigned`, `leadAssigned`, `newMessage`, `dailyDigest`
- **3 indexes** — `by_organization`, `by_organization_and_member`, `by_member`
- **Public queries/mutations** — `getMyPreferences`, `updateMyPreferences` (upsert), `getMemberPreferences` (admin)
- **Internal functions** — `shouldNotify`, `internalGetPreferences`, `internalUpsertPreferences`

#### Email Triggers Wired (4 backend files, 10 call sites)

- **`handoffs.ts`** — `requestHandoff` → `handoffRequested` to target member; `acceptHandoff`/`rejectHandoff` → `handoffResolved` to requester (both public + internal variants)
- **`leads.ts`** — `assignLead` → `leadAssigned` to assignee (both public + internal)
- **`tasks.ts`** — `createTask`/`assignTask` → `taskAssigned` to assignee; `processOverdueReminders` → `taskOverdue` to assignee (both public + internal)
- **`nodeActions.ts`** — `inviteHumanMember` → `invite` email with org name, credentials, and login URL

#### Cron Job (`convex/crons.ts`)

- **Daily digest** — `sendDailyDigest` scheduled at 11:00 UTC (08:00 BRT) via `crons.daily()`

#### HTTP API (`convex/router.ts`)

- **`GET /api/v1/notifications/preferences`** — Get notification preferences for authenticated API key's team member
- **`PUT /api/v1/notifications/preferences`** — Update notification preferences (partial update, upsert)
- **`POST /api/v1/webhooks/resend`** — Resend email delivery webhook endpoint (authenticated via RESEND_WEBHOOK_SECRET)
- CORS preflight routes added for both new paths

#### MCP Server — Notification Tools (`mcp-server/src/tools/notifications.ts`)

- **`crm_get_notification_preferences`** — Get current agent's email notification preferences
- **`crm_update_notification_preferences`** — Update preferences (e.g., disable `dailyDigest`)
- **`HnbCrmClient.put()` method** — Added PUT support to MCP client
- Tool count updated: 44 → **46 tools across 9 categories**

#### Frontend — Notification Preferences (`src/components/notifications/NotificationPreferences.tsx`)

- **NotificationsSection** — Settings tab with toggle switches for each notification type
- Integrated into `Settings.tsx` as "Notificacoes" section tab

#### Documentation Updates

- **`CLAUDE.md`** — Added Email/Notifications section with env vars, domain config, dispatch pattern
- **`convex/CLAUDE.md`** — Added `email.ts`, `emailTemplates.ts`, `convex.config.ts`, `notificationPreferences.ts` to file layout; added email dispatch to mutation side-effects checklist
- **`src/CLAUDE.md`** — Added `notifications/NotificationPreferences.tsx` to component tree
- **`README.md`** — Added full "Email Setup (Resend)" section with domain config, env vars, webhook setup, test mode, and architecture overview
- **`convex/llmsTxt.ts`** — Added `notificationPreferences` data model, notification preference endpoints, event type reference table; updated MCP tool count to 46
- **`.claude/skills/hnbcrm/SKILL.md`** — Added "Email Notifications" section with MCP tool references
- **`.claude/skills/hnbcrm/references/API_REFERENCE.md`** — Added notification tools mapping
- **`.claude/skills/hnbcrm/references/DATA_MODEL.md`** — Added notification preferences entity and `Notification Event Type` enum
- **`.claude/skills/hnbcrm/references/WORKFLOWS.md`** — Added workflow 7: Email Notifications
- **`mcp-server/README.md`** — Added Notifications category (2 tools), updated totals to 46 tools / 9 categories

#### Dependencies Added

- `@convex-dev/resend` ^0.2.3 — Convex component for Resend email delivery
- `convex-helpers` ^0.1.112 — Convex utility helpers (peer dep)

#### Docs Housekeeping

- **Archived** — `docs/GOING-PUBLIC.md` and `docs/OPTIMIZATION-RESULTS.md` moved to `docs/archive/`
- **New** — `docs/PRODUCTION-DEPLOYMENT-PLAN.md` — Production deployment checklist

---

## [0.20.0] - 2026-02-19

### MCP Server Published to npm + OpenClaw Integration

Published the `hnbcrm-mcp` package to npm for one-command installation (`npx hnbcrm-mcp`). Added dedicated OpenClaw setup docs and updated homepage/developer portal with corrected tool counts and OpenClaw integration highlights.

#### npm Publishing (`mcp-server/`)
- **Published `hnbcrm-mcp@0.1.0` to npm** — 44 MCP tools across 8 categories, 11.9 KB compressed
- **`package.json`** — Added `files` whitelist, `repository`, `homepage`, `bugs`, `author`, expanded `keywords` (15 terms including `openclaw`, `claude`, `cursor`, `modelcontextprotocol`)
- **`LICENSE`** — Created MIT license file (was declared but missing)
- **`README.md`** — Added npm badge, OpenClaw config section, missing Tasks (12 tools) and Calendar (6 tools) to Tools Reference, fixed total count to 44

#### Homepage (`src/components/LandingPage.tsx`)
- **REST API card** — Fixed "30 endpoints" → "44 endpoints"
- **MCP Server card** — Fixed "26 ferramentas" → "44 ferramentas", added OpenClaw to compatible platforms
- **Agent Skills card** — Added OpenClaw to compatible platforms list

#### Developer Portal (`src/pages/DevelopersPage.tsx`)
- **New "OpenClaw" section** — Dedicated nav entry + full section with setup guide (3 steps: npm install, MCP JSON config, optional skill copy) and 6-item capabilities list
- **MCP installation section** — Added npm link after the `npx` command
- **New imports** — `Bot` and `Check` icons from lucide-react

#### Agent Skill (`.claude/skills/hnbcrm/references/SETUP.md`)
- **Expanded OpenClaw section** — From 2 lines to full 3-step guide with MCP JSON config block and bootstrap sequence note

---

## [0.19.1] - 2026-02-17

### Post-Launch Public Repo Cleanup

Community health files, corrected URLs, and GitHub repository metadata for the public release at github.com/ericmil87/hnbcrm.

#### Documentation Fixes

- **README.md** — Version badge corrected to `0.19.0`; clone URL corrected from `hnbcrm/hnbcrm` → `ericmil87/hnbcrm`
- **CONTRIBUTING.md** — Clone URL corrected to `ericmil87/hnbcrm`

#### New Community Health Files

- **SECURITY.md** — Security policy: scope (auth, data isolation, API keys, webhooks), reporting email (`security@hnbcrm.com`), SLA (48h ack, 14-day critical patch), out-of-scope list
- **CODE_OF_CONDUCT.md** — Contributor Covenant 2.1 adapted; enforcement contact `conduct@hnbcrm.com`

#### GitHub Issue & PR Templates (`.github/`)

- **`.github/ISSUE_TEMPLATE/bug_report.md`** — Bug report template with steps to reproduce, expected/actual behavior, and environment table
- **`.github/ISSUE_TEMPLATE/feature_request.md`** — Feature request template with problem statement, proposed solution, alternatives, and context
- **`.github/PULL_REQUEST_TEMPLATE.md`** — PR template with change summary, type-of-change checklist, and project-specific lint/validator checklist

#### Repository Metadata

- **`.gitignore`** — Added 4 internal planning docs (`docs/EXPORT-IMPORT-PLAN.md`, `docs/FEATURE-ROADMAP-RESEARCH.md`, `docs/I18N-IMPLEMENTATION-PLAN.md`, `docs/MCP-PUBLISHING-PLAN.md`) to prevent accidental commits
- **GitHub topics** — Added via `gh repo edit`: `crm`, `ai`, `convex`, `react`, `typescript`, `mcp`

---

## [0.19.0] - 2026-02-17

### Onboarding — AI Agents, Currency/Timezone in Step 1, Pipeline Fix & Logo Polish

#### AI Agent Support in Team Invite Step (`src/components/onboarding/`)

**`WizardStep4TeamInvite.tsx`** — Full rewrite
- Each invite row has a leading type icon: `User` (brand-500) for humans, `Bot` (semantic-warning) for AI agents
- Human rows: email input + role select with brand-colored focus rings (unchanged UX)
- AI rows: name input + "IA" badge (warning color); no email or role needed
- Focus ring color matches member type: brand for human, warning for AI
- Two add buttons replace single "Adicionar outro": `+ Humano` (User icon) and `+ Agente IA` (Bot icon) — stacked on mobile, side-by-side on sm+
- Remove button shows spacer `<div className="w-8" />` when only 1 row remains (keeps layout stable)
- Single `update(index, patch)` helper replaces separate email/role handlers

**`OnboardingWizard.tsx`** — Four targeted changes
- `InviteRow` interface extended with `type: "human" | "ai"` and `name: string` fields
- Initial state updated: `{ type: "human", name: "", email: "", role: "agent" }`
- Defensive hydration on progress restore: fills missing `type`/`name` from persisted wizard data (backwards compatible with older sessions)
- Step 3→4 processes both types: AI members use name only (`role: "ai"`, `type: "ai"`); human members derive name from email if blank
- `inviteCount` on Step 5 uses type-aware filter (AI: name non-empty; human: email non-empty)

No backend changes — `createTeamMember` already accepts `type: "ai"` / `role: "ai"`.

#### Currency & Timezone Fields Moved to Step 1 (`src/components/onboarding/WizardStep1Welcome.tsx`)

- Added **Section 4 — Moeda principal**: visual card picker for BRL 🇧🇷, USD 🇺🇸, EUR 🇪🇺 — matching the interactive card pattern used for industry/goal/size
- Added **Section 5 — Fuso horário**: dropdown with 12 common timezones (Americas, Europe, Asia, UTC)
- Props extended: `currency`, `timezone`, `onCurrencyChange`, `onTimezoneChange`
- Selection persists into wizard state and is saved to org settings on completion

#### Save Timezone & Currency to Org on Wizard Complete (`convex/onboarding.ts`)

- `completeWizard` mutation now patches `organization.settings` with `timezone` and `currency` from wizard data
- Fetches existing org first to preserve `settings.aiConfig` (avoids clobbering existing AI configuration)

#### Pipeline Stage Insert Fix (`src/components/onboarding/WizardStep2Pipeline.tsx`)

- `handleAddStage`: new stage now inserts before the **first** closed (Won/Lost) stage instead of always at `length - 2`; falls back to appending if no closed stages exist

#### Logo Rendering Fix (`src/components/LandingPage.tsx`, `src/pages/DevelopersPage.tsx`, `src/pages/PlaygroundPage.tsx`)

- Added `object-contain` to all logo `<img>` elements to prevent distortion of the non-square (528×488) asset

#### Removed Stale Preload (`index.html`)

- Removed `<link rel="preload">` for unused `orange_icon_logo_transparent_bg_full-700x700.png`

#### Fix: Missing `@auth/core` Peer Dependency (`package.json`)

- Explicitly added `@auth/core: ^0.37.0` to `dependencies`
- Root cause: `.npmrc` sets `legacy-peer-deps=true` (required for react-helmet-async compatibility), which prevents npm from auto-installing peer dependencies — so `@auth/core` (a peer dep of `@convex-dev/auth`) was never installed, causing Convex bundler errors on every `convex dev` run

## [0.18.0] - 2026-02-17

### Bundle Optimization & SEO Enhancement

Major performance release achieving **77% bundle size reduction** and **Lighthouse Performance score improvement from 89 to 94**. Implements state-of-the-art 2026 optimization techniques with code splitting, lazy loading, multi-level compression, and comprehensive SEO.

#### Bundle Optimization

**Manual Chunking Strategy (`vite.config.ts`)**
- Split monolithic bundle into 4 vendor chunks + main bundle
- `react-vendor` (29.93 KB brotli) - React, ReactDOM, React Router
- `convex-vendor` (20.14 KB brotli) - Convex client + auth
- `utils-vendor` (15.13 KB brotli) - clsx, tailwind-merge, sonner
- `icons-vendor` (7.43 KB brotli) - Lucide React icons
- `index` main bundle (84.47 KB brotli) - App core + routing
- **Total initial load: 157 KB brotli** (down from ~1 MB baseline)

**Route-Level Lazy Loading (`src/main.tsx`)**
- All authenticated routes (`/app/*`) converted to `React.lazy()` dynamic imports
- 10 lazy-loaded route chunks (5-15 KB each) load on-demand
- Suspense boundaries with branded loading spinner fallback
- `LazyRoute` wrapper component for consistent loading UX
- **Result:** ~324 KB of code NOT loaded on first visit (~70% initial bundle reduction)

**Multi-Level Compression (`vite.config.ts`)**
- Gzip compression for universal browser support (~182 KB total)
- Brotli compression for modern browsers (~157 KB total, 10% better than gzip)
- Both formats generated at build time via `vite-plugin-compression`
- Server automatically selects best format based on browser support

**Bundle Visualization**
- `rollup-plugin-visualizer` generates interactive treemap at `dist/stats.html`
- Visualize chunk distribution, compression effectiveness, and dependency sizes
- Opens automatically after production builds

#### SEO Enhancement

**Dynamic Meta Tags (`src/components/SEO.tsx`)**
- Reusable `<SEO />` component using `react-helmet-async`
- Full meta tag coverage: title, description, keywords, author, robots, canonical
- Open Graph meta tags for rich social sharing (Facebook, LinkedIn)
- Twitter Card meta tags for Twitter/X preview cards
- Automatic `VITE_SITE_URL` environment variable support
- Integrated into all public pages: LandingPage, DevelopersPage, PlaygroundPage, AuthPage

**Structured Data (`src/components/StructuredData.tsx`)**
- JSON-LD structured data for rich search results
- `OrganizationStructuredData` component with SoftwareApplication schema
- Enables Google rich snippets and enhanced search listings

**Search Engine Optimization**
- `public/robots.txt` - Crawler directives (allow `/`, disallow `/app/` and `/entrar`)
- `public/sitemap.xml` - URL sitemap with priorities and change frequencies
- Preload hints in `index.html` for critical assets (logo, main.tsx)
- Preconnect hints for external domains (Google Fonts)
- `HelmetProvider` wrapper in `src/main.tsx` for SSR-ready meta tag management

#### Scroll Restoration

**React Router v7 Pattern (`src/components/layout/AuthLayout.tsx`, `src/components/layout/AppShell.tsx`)**
- `<ScrollRestoration />` component from React Router v7
- Window-level scrolling (removed nested scroll containers from AppShell)
- Automatic scroll position save/restore on navigation and page reloads
- Persists scroll state to sessionStorage
- Native browser-like back button UX

#### Image Optimization Infrastructure

**WebP Conversion Script (`scripts/convert-images.js`)**
- Node.js script using Sharp library for PNG → WebP conversion
- `npm run convert-images` command added to package.json
- Converts all PNG images in public folder with 85% quality
- Ready for manual image reference updates to .webp extensions

#### Performance Metrics

**Lighthouse Scores (Before → After)**
- **Performance:** 89 → 94 (+5.6%)
- **Accessibility:** - → 90
- **Best Practices:** - → 97
- **SEO:** - → 80

**Core Web Vitals**
- **First Contentful Paint (FCP):** 2.2s → 1.9s (-13.6%)
- **Largest Contentful Paint (LCP):** 3.5s → 3.3s (-5.7%)
- **Total Blocking Time (TBT):** - → 30ms (excellent)
- **Cumulative Layout Shift (CLS):** - → 0 (perfect)
- **Speed Index:** - → 1.9s (very good)

#### Business Impact

**User Experience**
- 77% smaller initial download (especially beneficial for mobile users)
- ~50% faster Time to Interactive (~4-5s → ~2s)
- Instant perceived performance on landing page
- Optimized caching (vendor chunks cached long-term)

**Estimated SEO & Conversion Improvements**
- +10-15% organic traffic (better Google ranking with Performance 94+)
- +5-8% conversion rate (faster load = more sign-ups)
- -20% bounce rate (< 2s load time threshold)

**Infrastructure Savings**
- -83% bandwidth per first-time visitor
- Lower CDN costs (less data transferred)
- Better cache hit rates (vendor chunks rarely change)

#### Dependencies Added

- `react-helmet-async` ^2.0.5 - Dynamic meta tag management
- `rollup-plugin-visualizer` ^6.0.5 (dev) - Bundle analysis
- `vite-plugin-compression` ^0.5.1 (dev) - Gzip/Brotli compression
- `sharp` ^0.34.5 (dev) - Image optimization

#### Configuration Files

- `.npmrc` - Added `legacy-peer-deps=true` for react-helmet-async compatibility
- `vite.config.ts` - Manual chunking, compression plugins, visualizer
- `index.html` - Preload hints, removed hardcoded meta tags (now managed by react-helmet-async)
- `.env.example` - Added `VITE_SITE_URL` for canonical URLs and OG tags

#### Documentation

- **`docs/OPTIMIZATION-RESULTS.md`** - Comprehensive 470-line performance analysis with screenshots, metrics, bundle breakdown, user journey analysis, and business impact estimates
- **`CLAUDE.md`** - Added `npm run convert-images` command, documented build optimizations and SEO patterns
- **`src/CLAUDE.md`** - Added SEO components to tree, documented lazy loading and scroll restoration patterns
- **`.claude/agents/frontend-specialist.md`** - Added SEO components to reusable list, extended workflow with SEO and lazy loading steps

#### Future Optimizations

Roadmap for continued performance improvements:
1. **Image Optimization** - Convert PNGs to WebP (script ready)
2. **Font Optimization** - Self-host fonts, add font-display: swap
3. **Further Code Splitting** - Dynamic imports for heavy modals/components
4. **PWA** - Service worker for offline support
5. **SEO Score Boost** - Improve from 80 to 90+ (more structured data)

## [0.17.1] - 2026-02-17

### Dashboard Enhancements — Activity, Events & Tasks Widgets

Improved dashboard with three new interactive widgets providing quick access to recent activity, upcoming events, and pending tasks.

#### Frontend — Dashboard Widgets (`src/components/`)
- **RecentActivityWidget.tsx** — Recent audit log activity with date/action filters (24h/7d/30d/all), expandable change diffs, actor avatars, entity icons
- **UpcomingEventsWidget.tsx** — Upcoming calendar events with time range filters (Hoje/Amanhã/7d/30d), event type filters, assignee filters, day-grouped view
- **UpcomingTasksWidget.tsx** — Upcoming tasks with smart filters (Hoje/Atrasadas/Esta Semana/Minhas Tarefas), priority filters, date-grouped buckets, overdue badges, one-click complete
- **calendar/TaskDetailSlideOver.tsx** — Task detail slide-over with completion/cancellation actions, checklist progress, linked records
- All widgets integrated into `DashboardOverview.tsx` with responsive grid layout

#### Shared Utilities (`src/lib/auditUtils.ts`)
- Extracted audit log utilities: entity icons, action labels, field labels, date grouping (`getDateGroup`), relative time formatting (`formatRelativeTime`), client-side description builder (`buildClientDescription`), diff value formatter (`formatDiffValue`)
- Reused by both `AuditLogs.tsx` and `RecentActivityWidget.tsx` for consistency

## [0.17.0] - 2026-02-17

### File Storage System — Complete Upload and Management Infrastructure

Major feature release adding Convex file storage with message attachments, contact photos, member avatars, and lead document management.

#### Backend — File Storage (`convex/files.ts`)
- **Core mutations** — `generateUploadUrl`, `saveFile`, `deleteFile` with full validation and quota checking
- **Queries** — `getFileUrl`, `getFile`, `getLeadDocuments` with organization-scoped access control
- **File validation** — MIME type whitelist (images: jpeg/png/gif/webp, documents: pdf/doc/docx/xls/xlsx, text: csv/txt/json, audio: mp3/wav/ogg)
- **Size limits** — Images (10MB), Documents (20MB), Text (10MB), Audio (10MB)
- **Quotas by tier** — Free (1GB storage, 100 uploads/day), Pro (10GB storage, 1000 uploads/day)
- **Security** — Organization-scoped access, permission-gated uploads (requires `leads: edit_own`), file type whitelist
- **Audit trail** — All file operations logged to `auditLogs` with actor tracking

#### Schema — New Tables (`convex/schema.ts`)
- **`files` table** — Central storage for file metadata (storageId, name, mimeType, size, fileType, relations to messages/contacts/leads/members)
- **`leadDocuments` table** — Join table for lead ↔ document relationships with title and category (contract/proposal/invoice/other)
- **Schema updates** — `messages.attachments` now array of file IDs, `contacts.photoFileId`, `teamMembers.avatarFileId`
- **9 indexes** — `by_organization`, `by_organization_and_type`, `by_message`, `by_contact`, `by_lead`, `by_storage_id`

#### HTTP API — File Endpoints (`convex/router.ts`)
- **4 REST endpoints** at `/api/v1/files/*`:
  - `POST /api/v1/files/upload-url` — Generate presigned upload URL
  - `POST /api/v1/files` — Save file metadata after upload (validates, checks quota, creates record)
  - `GET /api/v1/files/:id/url` — Get download URL for file
  - `DELETE /api/v1/files/:id` — Delete file and metadata from storage

#### Frontend — File Upload Components (`src/components/ui/`)
- **FileUploadButton.tsx** — Reusable upload component with multi-file support (max 5), progress tracking, validation, staging area with remove buttons
- **AttachmentPreview.tsx** — Image thumbnails (240x180px) with click-to-open + document rows with file icons, names, sizes, download buttons
- **AvatarUpload.tsx** — Circular avatar with camera icon overlay, image-only (max 5MB), click-to-select with validation

#### Message Attachments — Full Integration
- **Backend** (`convex/conversations.ts`) — `sendMessage` accepts `attachments` array of file IDs, links files back to messages; `getMessages` batch-fetches attachment files and generates URLs
- **Frontend** (`LeadDetailPanel.tsx` ConversationTab) — File upload button in composer, staged attachments with remove, inline attachment display in messages

#### Contact/Member Photos
- **Backend** — `updateContactPhoto` mutation in `contacts.ts`, `updateMemberAvatar` mutation in `teamMembers.ts` (both delete old file, update new, log audit)
- **Queries** — `getContact`, `getContactWithLeads`, `getTeamMembers` all resolve file IDs to URLs
- **Frontend** — `AvatarUpload` integrated into `ContactDetailPanel.tsx` and `MemberDetailSlideOver.tsx`

#### Lead Documents
- **Backend** (`convex/leads.ts`) — `addLeadDocument` mutation (creates join entry with category), `removeLeadDocument` mutation (deletes document + file from storage)
- **Frontend** (`LeadDocuments.tsx`) — Document list with upload modal (title input, category select, file picker), download/delete buttons per document
- **Integration** — Added to `LeadDetailPanel.tsx` DetailsTab below BANT qualification

#### Documentation Updates
- **`convex/llmsTxt.ts`** — Added File and LeadDocument data models, documented all file storage endpoints, added file type and category enums
- **README.md** — Added "File Storage" to features list
- **CHANGELOG.md** — This entry

## [0.16.0] - 2026-02-16

### Calendar System — Full Time-Based Event Management

Major feature release adding a complete calendar system with recurring events, drag-to-reschedule, multi-view navigation, and full backend/frontend/MCP integration.

#### Backend — Calendar Events (`convex/calendar.ts`)
- **12 functions** — 6 queries (list, get, getUpcoming, getByLead, getByContact, search) + 6 mutations (create, update, delete, reschedule, complete, generateRecurringInstances)
- **Recurring event support** — Daily/weekly/biweekly/monthly patterns with auto-generation of child instances; completion auto-creates next occurrence
- **Event types** — `call`, `meeting`, `follow_up`, `demo`, `task`, `reminder`, `other`
- **Event statuses** — `scheduled`, `completed`, `cancelled`
- **Rich metadata** — Attendees, location, meetingUrl, notes, linked lead/contact/task
- **Smart scheduling** — All-day event flag, time range validation, overlap detection
- **Full audit trail** — Every mutation logs to `activities` + `auditLogs` and triggers webhooks

#### Schema — `calendarEvents` Table (`convex/schema.ts`)
- **9 indexes** — `by_organization`, `by_organization_and_created`, `by_organization_and_start_time`, `by_organization_and_assigned`, `by_organization_and_event_type`, `by_lead`, `by_contact`, `by_parent_event`, `search_text`
- **Full-text search** — `searchText` field for title/description/location/notes
- **Recurrence tracking** — `parentEventId` links recurring instances to their parent
- **Cascade delete** — Deleting parent event deletes all child instances

#### HTTP API — Calendar Endpoints (`convex/router.ts`)
- **7 REST endpoints** at `/api/v1/calendar/events/*`:
  - `GET /api/v1/calendar/events` — List events in date range with filters (assignedTo, eventType, status, lead, contact, includeTasks)
  - `GET /api/v1/calendar/events/get` — Get single event
  - `POST /api/v1/calendar/events/create` — Create event with optional recurrence
  - `POST /api/v1/calendar/events/update` — Update event fields
  - `POST /api/v1/calendar/events/delete` — Delete event (cascades to children)
  - `POST /api/v1/calendar/events/reschedule` — Reschedule to new time
  - `POST /api/v1/calendar/events/complete` — Mark completed (auto-generates next if recurring)

#### MCP Tools — Calendar Integration (`mcp-server/src/tools/calendar.ts`)
- **6 calendar tools** for AI agents:
  - `calendar_list_events` — List events in date range with filters
  - `calendar_get_event` — Get single event details
  - `calendar_create_event` — Create event with full field support
  - `calendar_update_event` — Update event fields
  - `calendar_delete_event` — Delete event
  - `calendar_reschedule_event` — Reschedule to new time

#### Frontend — Calendar Views (`src/components/calendar/`)
- **15 components** — Complete calendar UI with three view modes:
  - **MonthView.tsx** — 7-column month grid with event dots (color-coded by type)
  - **WeekView.tsx** — 7-column time grid (06:00-22:00) with event blocks
  - **DayView.tsx** — Single column time grid with date strip navigation
- **Drag-to-reschedule** — `@dnd-kit/core` integration for drag-and-drop event rescheduling across time slots
- **CalendarPage.tsx** — Main calendar page with view state, DnD context, data queries
- **CalendarHeader.tsx** — View toggle (Dia/Semana/Mês), date navigation (Hoje/Anterior/Próximo), filter popover
- **TimeGrid.tsx** — Shared 06:00-22:00 time grid with current time indicator (red line)
- **EventBlock.tsx** — Draggable event block with type icon, time, title (useDraggable)
- **EventDot.tsx** — Small colored dot for month view
- **DayCell.tsx** — Day cell in month view with droppable support (useDroppable)
- **CalendarEventModal.tsx** — Create/edit event form with all fields, recurrence configuration
- **EventDetailSlideOver.tsx** — Event detail slide-over panel with edit/delete/complete actions
- **CalendarFilters.tsx** — Filter popover (team member, event type)
- **useCalendarState.ts** — Custom hook managing calendar state (view, date, filters)
- **constants.ts** — PT-BR labels, color mappings (event types, team members)
- **Mobile responsive** — Touch-friendly drag, compact header, stacked filters

#### Navigation
- New `/app/calendario` route in `src/lib/routes.ts`
- "Calendário" tab added to Sidebar (desktop) and BottomTabBar (mobile)
- Calendar icon from `lucide-react`

#### Documentation Updates
- Fixed tool count across all docs: **44 MCP tools** (was incorrectly stated as 26 or 46)
- Added **Tasks section** (12 tools) to SKILL.md, DevelopersPage.tsx, llmsTxt.ts
- Added **Calendar section** (6 tools) to SKILL.md, DevelopersPage.tsx, llmsTxt.ts
- Updated API_REFERENCE.md with calendar endpoints
- Updated DATA_MODEL.md with calendarEvents table schema
- Updated openapiSpec.ts with calendar endpoint definitions

## [0.15.1] - 2026-02-16

### Team Management UX — AI Agent Creation & API Key Management

Streamlined AI agent creation flow, auto-generated API key names, and full API key lifecycle management from the member detail panel.

#### AI Agent Creation UX (`src/components/team/InviteMemberModal.tsx`)
- **Type selection step** — Visual cards to choose between Human and AI Agent before entering form
- **Descriptive agent info** — Explains what agents are and how API keys work inline
- **Auto-generate API key** — Toggle (on by default) creates an API key immediately after agent creation
- **Slug-style key naming** — API key name auto-derived from bot name (e.g., "Bot de Vendas" → `bot-de-vendas`), no extra field to fill
- **Result step** — Shows generated API key with reveal/copy and security warning (matches human temp password UX)
- **Permissions editor** — Optional toggle to customize agent permissions at creation time

#### API Key Management in Member Detail (`src/components/team/MemberDetailSlideOver.tsx`)
- **Keys section** — AI agent members now show a "Chaves API" section listing all their keys
- **Key metadata** — Each key shows name, creation date, last used, and status badges (Revogada/Expirada)
- **Create new key** — "Nova Chave" button with pre-filled slug name from agent name
- **Key reveal flow** — Newly created key shown with eye toggle, copy button, and security warning
- **Revoke key** — Per-key revoke button with confirmation dialog

#### Backend
- **`getApiKeysForMember` query** (`convex/apiKeys.ts`) — New query using `by_team_member` index to fetch keys for a specific agent
- **`createTeamMember` mutation** — Now accepts optional `permissions` arg for setting agent permissions at creation
- **Fix: dynamic import crash** (`convex/teamMembers.ts`) — Removed `await import("./lib/permissions")` that caused `inviteHumanMember` to fail (Convex doesn't support dynamic imports)
- **Fix: openapiSpec.ts** — Fixed template literal backtick syntax error in description string

## [0.15.0] - 2026-02-16

### RBAC Permissions System & Human Invite Flow

Complete role-based access control implementation with granular permissions, admin-managed team invites with auto-generated passwords, and permission-scoped API keys.

#### Permissions System (`convex/lib/permissions.ts`)
- **9 permission categories** — `leads`, `contacts`, `inbox`, `tasks`, `reports`, `team`, `settings`, `auditLogs`, `apiKeys`
- **Hierarchical permission levels** — Each category has 3-6 levels (e.g., leads: `none` → `view_own` → `view_all` → `edit_own` → `edit_all` → `full`)
- **Role defaults** — Admin (full access), Manager (edit_all leads/contacts/tasks, manage team), Agent (view_all + edit_own), AI (view_all + edit_own, no settings/audit)
- **Permission overrides** — Admins can set explicit per-member permissions that override role defaults
- **Level comparison** — `hasPermission(actual, required)` checks hierarchical level sufficiency
- **Shared types** — Used by both backend (auth) and frontend (guards/hooks)

#### Backend — Permission Enforcement (`convex/lib/auth.ts`)
- **`requirePermission(ctx, organizationId, category, level)`** — Extends `requireAuth` with RBAC checks; throws if user lacks required permission level
- **`resolvePermissions(role, explicitPermissions?)`** — Falls back to role defaults when no explicit override exists
- Permission resolution used in `requirePermission`, API key validation, and team member queries

#### Schema Updates (`convex/schema.ts`)
- **`teamMembers.permissions`** — Optional explicit permission overrides (uses shared `permissionsValidator`)
- **`teamMembers.mustChangePassword`** — Flag for forcing password change on first login (invite flow)
- **`teamMembers.invitedBy`** — Tracks which team member sent the invite
- **`apiKeys.permissions`** — Optional permission scoping for API keys (defaults to creator's permissions)

#### Invite Flow (`convex/nodeActions.ts`, `convex/authHelpers.ts`, `convex/teamMembers.ts`)
- **`inviteHumanMember` action** — Admins invite humans by email; auto-generates temp password via `crypto.randomBytes(16)`, creates Convex user + password auth account via bcrypt, sets `mustChangePassword: true`, returns temp credentials
- **`changePassword` action** — Users change password (requires current password); hashes new password with bcrypt, updates auth account, clears `mustChangePassword` flag
- **`authHelpers.ts`** — Internal queries/mutations for auth table operations: `queryUserByEmail`, `queryAuthAccountForCurrentUser`, `updateAuthAccountPassword`, `queryUserById`
- **`updateTeamMemberRole` mutation** — Now accepts optional `permissions` arg for explicit overrides
- **Audit logging** — All invite/role/permission changes logged to `auditLogs` with actor tracking

#### Frontend — Permission Guards & Hooks
- **`usePermissions(organizationId)` hook** (`src/hooks/usePermissions.ts`) — Resolves current user's permissions; returns `{ permissions, hasPermission(category, level), isLoading }`
- **`<PermissionGate>` component** (`src/components/guards/PermissionGate.tsx`) — Declarative permission-based rendering; hides children if user lacks required permission
- **TeamPage overhaul** (`src/components/TeamPage.tsx`) — Invite member button (admin-only), member detail slide-over with permission editor, role change confirmation
- **ChangePasswordScreen** (`src/components/team/ChangePasswordScreen.tsx`) — Full-page forced password change screen for new invitees
- **InviteMemberModal** (`src/components/team/InviteMemberModal.tsx`) — Modal for inviting humans with email + optional explicit permissions
- **MemberDetailSlideOver** (`src/components/team/MemberDetailSlideOver.tsx`) — View/edit member role, permissions, status; deactivate/reactivate member
- **PermissionsEditor** (`src/components/team/PermissionsEditor.tsx`) — UI for editing all 9 permission categories with level dropdowns and role default fallbacks
- **App.tsx** — Intercepts users with `mustChangePassword: true` and shows ChangePasswordScreen instead of main app

#### Permission-Gated UI Updates (8 components)
- **Settings.tsx** — Webhooks section gated by `settings.manage`, API keys by `apiKeys.manage`, custom fields by `settings.manage`
- **TeamPage.tsx** — Invite button gated by `team.manage`, role/permission edits gated by `team.manage`
- **ContactsPage.tsx** — Create contact button gated by `contacts.edit`, delete gated by `contacts.full`
- **KanbanBoard.tsx** — Create lead gated by `leads.edit_own`, stage management gated by `settings.manage`
- **LeadDetailPanel.tsx** — Edit lead gated by `leads.edit_*` (checks ownership), assign gated by `leads.edit_all`, delete gated by `leads.full`
- **Inbox.tsx** — Reply gated by `inbox.reply`, conversation actions by `inbox.full`
- **TasksPage.tsx** — Create/edit tasks gated by `tasks.edit_*` (checks ownership)
- **AuditLogs.tsx** — Entire page gated by `auditLogs.view`
- **Sidebar/BottomTabBar** — Nav items hidden when user lacks view permission for that section

#### HTTP API — Permission Scoping (`convex/router.ts`, `convex/apiKeys.ts`)
- **API key permission resolution** — Keys inherit creator's permissions unless explicitly scoped; `getApiKeyPermissions(apiKey, keyTeamMember)` returns effective permissions
- **Permission enforcement** — All `/api/v1/*` endpoints now check permissions before executing (e.g., POST /leads requires `leads.edit_own`, DELETE requires `leads.full`)
- **`hasApiPermission(effectivePermissions, category, level)` helper** — Used in router to gate API operations

#### Developer Docs (`convex/CLAUDE.md`, `.claude/skills/hnbcrm/`)
- **CLAUDE.md** — Added permissions pattern section with `requirePermission` usage examples
- **SKILL.md** — Updated with permission categories and levels reference
- **API_REFERENCE.md** — Documented permission requirements for all MCP tools
- **DATA_MODEL.md** — Added `permissions` field docs to teamMembers and apiKeys

#### Miscellaneous
- **llms.txt** — Added permissions system documentation section
- **openapiSpec.ts** — Updated team member and API key schemas with `permissions` field
- **docs/IMPROVEMENTS.md** — Moved "Permissions System" from TODO to DONE
- **docs/PROJECT-STATUS.md** — Updated to reflect RBAC completion

## [0.14.1] - 2026-02-16

### API Playground UX — Request Builder Polish

- **Two-row URL bar header** (`RequestBuilder.tsx`) — Split single-row header into two rows (method+path / controls+Enviar) to fix "Enviar" button being clipped by `overflow-hidden` at narrow panel widths
- **Syntax-highlighted JSON editor** (`RequestBuilder.tsx`) — Replaced plain textarea with overlay editor using `highlightJson()` from `JsonHighlighter.tsx` (sky-blue keys, green strings, amber numbers, purple booleans); transparent textarea over highlighted `<pre>` with synced scroll
- **Full-height JSON editor** — JSON body textarea now fills all available vertical space (`flex-1`) instead of fixed `rows={15}`
- **Exported `highlightJson`** (`JsonHighlighter.tsx`) — Made highlight function reusable across components

## [0.14.0] - 2026-02-16

### API Playground v2 — Cursor Pagination, Resizable Panels, URL Routing, UX Polish

Backend cursor pagination for all list endpoints, resizable playground panels, URL-persisted endpoint selection, and response pagination UI.

#### Backend — Cursor Pagination (5 endpoints)
- **Shared cursor utilities** (`convex/lib/cursor.ts`) — Extracted `parseCursor`, `buildCursorFromCreationTime`, `buildCursorFromCreatedAt`, `paginateResults` into a shared module; `auditLogs.ts` refactored to use it
- **`GET /api/v1/leads`** — Added `cursor` query param; response now returns `{ leads, nextCursor, hasMore }`
- **`GET /api/v1/contacts`** — Added `cursor` query param; response now returns `{ contacts, nextCursor, hasMore }`
- **`GET /api/v1/conversations`** — Added `cursor` query param; response now returns `{ conversations, nextCursor, hasMore }`
- **`GET /api/v1/handoffs`** — Added `cursor` query param; response now returns `{ handoffs, nextCursor, hasMore }`
- **`GET /api/v1/activities`** — Added `cursor` query param; response now returns `{ activities, nextCursor, hasMore }`
- All 5 internal queries (`internalGetLeads`, `internalGetContacts`, `internalGetConversations`, `internalGetHandoffs`, `internalGetActivities`) now accept optional `cursor` arg and return paginated results

#### Frontend — API Playground Improvements
- **Resizable panels** (`ApiPlayground.tsx`) — Drag-to-resize handles between sidebar, request builder, and response viewer; widths persist to localStorage; min/max constraints (sidebar 180-320px, request 280-500px)
- **URL routing** (`PlaygroundPage.tsx`) — Selecting an endpoint updates URL to `?endpoint=list-leads`; deep-linking and refresh preserve selection
- **Sidebar UI polish** (`PlaygroundSidebar.tsx`) — Shows title as primary text + short path segment instead of full truncated paths; hover tooltip shows full path
- **Response pagination** (`ResponseViewer.tsx`) — When response includes `nextCursor` + `hasMore: true`, shows pagination bar with "Anterior" / page badge / "Proxima" buttons
- **API registry** (`apiRegistry.ts`) — Added `cursor` query param to all 5 list endpoint definitions; updated response examples with `nextCursor`

## [0.13.0] - 2026-02-16

### Developer Portal & API Playground Overhaul

Full-page API Playground, OpenAPI 3.1.0 spec, 2 new MCP tools, and complete tool name sync across docs.

#### Full-Page API Playground (`src/pages/PlaygroundPage.tsx`)
- New `/developers/playground` route — dedicated full-screen playground with breadcrumb header
- `PlaygroundConfigProvider` context — shared config state across playground components
- `JsonHighlighter` — regex-based JSON syntax highlighting (keys, strings, numbers, booleans, null)
- Mobile UX: request/response tab switcher with auto-switch on response, compact endpoint selector
- Desktop UX: 3-column layout (sidebar + request builder + response viewer)

#### Playground Component Improvements
- **RequestBuilder** — URL bar header with method badge + path, form validation with field-level errors and shake animation, JSON format button, type badges on all fields, support for PUT/DELETE methods, reset state on endpoint change
- **PlaygroundConfig** — Collapsible config bar (compact view with masked key when configured)
- **ResponseViewer** — Compact status bar with line count + byte size, `JsonHighlighter` replaces `CodeBlock`
- **PlaygroundSidebar** — Method color coding (GET green, POST blue, PUT yellow, DELETE red), tighter spacing

#### OpenAPI Spec (`convex/openapiSpec.ts`, `convex/router.ts`)
- Full OpenAPI 3.1.0 specification for all REST API endpoints
- Served at `GET /api/v1/openapi.json`

#### MCP Server — Missing Tools (`mcp-server/src/tools/`)
- Added `crm_reject_handoff` tool to `handoffs.ts` (was defined in REST API but not registered in MCP)
- Added `crm_get_dashboard` tool to `pipeline.ts` (was defined in REST API but not registered in MCP)

#### Developer Docs Sync
- **DevelopersPage** — Updated all MCP tool names to `crm_*` prefix, corrected tool counts (contacts 4→7, handoffs 3→4), added Pipeline (3 tools) and Activities (2 tools) sections, fixed MCP config examples (`-y` flag, `HNBCRM_API_URL` env var)
- **llms.txt** — Synced all 26 tool names to `crm_*` prefix, added missing `crm_list_handoffs`/`crm_accept_handoff`/`crm_reject_handoff` docs
- Playground section on DevelopersPage replaced with CTA card linking to full-page playground

#### Misc
- `.gitignore` — Added `.mcp.json` (contains API keys)
- `tailwind.config.js` — Added `shake` keyframe animation for form validation feedback

## [0.12.0] - 2026-02-16

### UX — Replace Native Dialogs with Design System Components

Eliminates all `alert()` and `confirm()` browser dialogs across the app, replacing them with elegant modal components that match the dark theme design system.

#### New Components
- **`ConfirmDialog`** (`src/components/ui/ConfirmDialog.tsx`) — Reusable confirmation modal wrapping `Modal` + `Button`, with `danger` variant (red button + AlertTriangle icon) and PT-BR default labels ("Confirmar" / "Cancelar")
- **`ApiKeyRevealModal`** (`src/components/ui/ApiKeyRevealModal.tsx`) — API key reveal modal with masked/revealed toggle (Eye/EyeOff), one-click copy with toast feedback, and security warning with ShieldAlert icon

#### Replacements (8 native dialogs removed)
- **Settings.tsx** — `alert()` for API key creation → `ApiKeyRevealModal`; 3 `confirm()` calls (custom fields, lead sources, webhooks) → `ConfirmDialog` with danger variant
- **ManageStagesModal.tsx** — `confirm()` for stage deletion → `ConfirmDialog`
- **ContactDetailPanel.tsx** — `confirm()` for contact deletion → `ConfirmDialog`
- **KanbanBoard.tsx** — 2 `confirm()` calls (stage deletion in popover, pipeline deletion) → `ConfirmDialog`

## [0.11.0] - 2026-02-15

### Agent Skills, Developer Portal & llms.txt Updates

Introduces an open Agent Skill (AgentSkills.io standard) for AI agents to connect to HNBCRM, updates the developer portal and landing page to surface it, expands llms.txt with missing endpoints, and fixes a bug where MCP activity tools were never registered.

#### Agent Skill (`.claude/skills/hnbcrm/`)
- **SKILL.md** — Main skill file with role definition, bootstrap sequence, 26 MCP tools listing, core workflows, best practices
- **references/WORKFLOWS.md** — 6 detailed step-by-step playbooks with `crm_*` tool call examples
- **references/API_REFERENCE.md** — Complete MCP tool ↔ REST endpoint mapping for all 26 tools
- **references/DATA_MODEL.md** — All entity tables, fields, and complete enum reference
- **references/SETUP.md** — Platform configs for Claude Code, Claude Desktop, Cursor, VS Code, Gemini CLI, OpenClaw, REST-only
- **scripts/verify-connection.sh** — Bash script to verify API connectivity

#### MCP Server Bug Fix (`mcp-server/src/index.ts`)
- Fixed `crm_get_activities` and `crm_create_activity` tools never being registered — `registerActivityTools` was defined in `tools/activities.ts` but never imported/called in the server entry point

#### llms.txt Updates (`convex/llmsTxt.ts`)
- Added Agent Skill section to both `/llms.txt` and `/llms-full.txt`
- Added 6 missing endpoint docs to `/llms-full.txt`: `GET/POST /api/v1/activities`, `GET /api/v1/dashboard`, `GET /api/v1/contacts/search`, `GET /api/v1/lead-sources`, `GET /api/v1/audit-logs`
- Added 4 missing MCP tools to the MCP Server Tools section: `search_contacts`, `get_dashboard`, `get_activities`, `create_activity`
- Updated MCP server tool count to 26

#### Landing Page (`src/components/LandingPage.tsx`)
- Added "Agent Skills" card to the Developer Section with link to `/developers#agent-skills`
- Updated developer grid from 3-col to 4-col layout
- Updated MCP Server card: 19 → 26 ferramentas

#### Developer Portal (`src/pages/DevelopersPage.tsx`)
- Added Agent Skills section with skill contents listing, quick setup steps, and compatible platforms
- Updated MCP tools count: 19 → 26 ferramentas

## [0.10.0] - 2026-02-15

### Audit Logs Overhaul — Human-Readable, Filterable, Agent-Friendly

Complete redesign of the audit log system: server-generated PT-BR descriptions, 6 filter dimensions with compound indexes, cursor-based pagination, expandable before/after diffs, and a world-class frontend inspired by Linear/Stripe/WorkOS.

#### Schema & Indexes (`convex/schema.ts`)
- Added `description` optional field to `auditLogs` table — server-generated PT-BR summary
- 4 new compound indexes for filtered queries: `by_organization_and_entity_type_and_created`, `by_organization_and_action_and_created`, `by_organization_and_severity_and_created`, `by_organization_and_actor_and_created`

#### Description Builder (`convex/lib/auditDescription.ts`)
- New `buildAuditDescription()` pure function — maps actions to PT-BR past-tense verbs and entity types to gendered articles
- Special handling for move (stage names), assign (assignee name), handoff (from/to member names)
- Examples: "Criou o lead 'João Silva'", "Moveu o lead 'Maria' de 'Prospecção' para 'Qualificação'"

#### Backend Query Rewrite (`convex/auditLogs.ts`)
- `getAuditLogs` rewritten — cursor-based pagination (replaces offset), 6 filter args (severity, entityType, action, actorId, startDate, endDate), smart index selection (priority: actorId > entityType > action > severity > org+created)
- New `getAuditLogFilters` query — returns actors, all 13 entity types, all 6 actions for filter dropdowns
- New `internalGetAuditLogs` — same logic for HTTP API layer
- Actor enrichment: `actorName`, `actorAvatar`, `actorMemberType`

#### Mutation File Updates (52 sites across 14 files)
- All `ctx.db.insert("auditLogs", ...)` calls now include `description` field via `buildAuditDescription`
- Enriched metadata: leads.ts moves include `fromStageName`/`toStageName`, assigns include `assigneeName`, handoffs include lead title + member names
- Files: leads, contacts, handoffs, boards, webhooks, leadSources, fieldDefinitions, organizations, teamMembers, conversations, savedViews, onboarding, apiKeys, seed

#### HTTP API (`convex/router.ts`)
- New `GET /api/v1/audit-logs` endpoint with all query params (entityType, action, severity, actorId, startDate, endDate, cursor, limit)

#### Frontend Redesign (`src/components/AuditLogs.tsx`)
- Date grouping (Hoje, Ontem, Esta Semana, Este Mês, Anteriores) with group headers
- 6 filter dropdowns (actor, action, entity type, severity) + date presets (24h, 7d, 30d, custom)
- Active filter chips with individual/bulk clear
- Expandable log rows with before/after diff table (responsive 3-col desktop, stacked mobile)
- Entity-type icons, action badges, severity dots, actor avatars with AI indicator
- Skeleton shimmer loading, contextual empty states
- Cursor-based pagination (next/prev with cursor stack)
- CSV export with UTF-8 BOM and PT-BR headers
- Client-side PT-BR fallback for old logs without server `description`

## [0.9.0] - 2026-02-15

### MCP Server Improvements & New API Endpoints

Major upgrade to the MCP server: 7 new tools (19→26), 1 new resource (3→4), 5 new REST API endpoints (23→28), SDK upgrade, structured error handling, and expanded field coverage.

#### MCP SDK & Infrastructure
- **SDK upgrade** — `@modelcontextprotocol/sdk` `^1.12.1` → `^1.26.0`
- **Structured error handling** — All 26 tools wrapped in try/catch with `isError: true` responses instead of raw exceptions
- **`errorResult()` / `successResult()` helpers** — New `mcp-server/src/utils.ts` for consistent MCP response formatting
- **Tool annotations** — All tools annotated with `readOnlyHint`, `destructiveHint`, `idempotentHint` per MCP spec

#### New MCP Tools (7 added)
- **`crm_enrich_contact`** — Write enrichment data to a contact with source/confidence tracking
- **`crm_get_contact_gaps`** — Get which contact fields are missing (guides AI research)
- **`crm_search_contacts`** — Full-text search on contacts by name, email, or company
- **`crm_reject_handoff`** — Reject a pending handoff with optional feedback
- **`crm_get_activities`** — Get activity timeline for a lead
- **`crm_create_activity`** — Log notes, calls, or emails on a lead
- **`crm_get_dashboard`** — Pipeline analytics overview (stage distribution, team performance, pending handoffs)

#### New MCP Resource
- **`hnbcrm://lead-sources`** — Lead source reference data for setting correct source on new leads

#### Expanded Contact Field Coverage
- `crm_create_contact` and `crm_update_contact` now expose 17 additional fields: `tags`, `whatsappNumber`, `telegramUsername`, `bio`, `linkedinUrl`, `instagramUrl`, `facebookUrl`, `twitterUrl`, `city`, `state`, `country`, `industry`, `companySize`, `cnpj`, `companyWebsite`, `acquisitionChannel`, `customFields`

#### New REST API Endpoints (5 added)
- `GET /api/v1/activities?leadId={id}&limit={n}` — Activity timeline for a lead
- `POST /api/v1/activities` — Create activity (note, call, email_sent) on a lead
- `GET /api/v1/dashboard` — Full dashboard analytics (pipeline stats, sources, team, handoffs)
- `GET /api/v1/contacts/search?q={text}&limit={n}` — Full-text contact search
- `GET /api/v1/lead-sources` — List configured lead sources

#### Backend Internal Functions (4 added)
- `convex/activities.ts` — `internalGetActivities`, `internalCreateActivity`
- `convex/dashboard.ts` — `internalGetDashboardStats`
- `convex/contacts.ts` — `internalSearchContacts`
- `convex/leadSources.ts` — `internalGetLeadSources`

## [0.8.0] - 2026-02-15

### Backend Performance & Query Optimization

Eliminates N+1 query patterns, adds query bounds to all unbounded `.collect()` calls, replaces `.filter()` with compound indexes, and adds pagination support to REST API endpoints.

#### Batch Fetch Utility (`convex/lib/batchGet.ts`)
- New `batchGet()` helper — deduplicates IDs, fetches in parallel, returns `Map` for O(1) lookup
- Replaces `Promise.all(items.map(async => ctx.db.get(...)))` N+1 patterns across 7 backend files

#### N+1 Query Elimination
- **activities.ts** — Batch actor name resolution
- **auditLogs.ts** — Batch actor name resolution
- **contacts.ts** — Batch stage + assignee lookup for contact leads
- **conversations.ts** — Batch lead + contact + assignee lookup (public + internal)
- **dashboard.ts** — Batch actor names in activity feeds
- **handoffs.ts** — Batch lead + member + contact lookup (public + internal)
- **leads.ts** — Batch contact + stage + assignee lookup (public + internal)

#### Unbounded Query Bounds (`.collect()` → `.take(N)`)
- **auditLogs** — `.take(500)`
- **boards/stages** — `.take(100)`
- **contacts** — `.take(500)`, leads per contact `.take(100)`
- **messages** — `.take(500)`
- **dashboard leads** — `.take(2000)`, handoffs `.take(200)`
- **fieldDefinitions** — `.take(100)`
- **leadSources** — `.take(100)`
- **organizations** — `.take(50)` on user orgs
- **savedViews** — `.take(100)`
- **teamMembers** — `.take(200)`
- **webhooks/webhookTrigger** — `.take(100)`

#### Compound Index Migration (`.filter()` → `.withIndex()`)
- New `by_organization_and_user` index on `teamMembers` — used in `requireAuth()` and 12+ auth checks across activities, apiKeys, auditLogs, fieldDefinitions, leadSources, teamMembers, webhooks
- Eliminates in-memory `.filter(q => q.eq(q.field("userId"), userId))` pattern

#### New Schema Indexes (`convex/schema.ts`)
- `teamMembers.by_organization_and_user` — compound auth lookups
- `handoffs.by_status_and_created` — time-sorted handoff queues
- `activities.by_organization_and_created` — dashboard activity feeds
- `auditLogs.by_organization_and_actor` — actor-scoped audit queries

#### REST API Pagination (`convex/router.ts`)
- `GET /api/v1/leads` — accepts `limit` param (max 500), returns `hasMore`
- `GET /api/v1/contacts` — accepts `limit` param (max 500), returns `hasMore`
- `GET /api/v1/conversations` — accepts `limit` param (max 500), returns `hasMore`
- `GET /api/v1/handoffs` — accepts `limit` param (max 500), returns `hasMore`
- `internalGetContacts` now accepts optional `limit` argument

#### Documentation
- **docs/GOING-PUBLIC.md** — Checklist for making the repository public (secrets audit, .gitignore, rename, visibility)
- **docs/IMPROVEMENTS.md** — Technical roadmap: performance, security, AI features, MCP, frontend, webhooks, DX

## [0.7.1] - 2026-02-15

### Fixed — Mobile Auto-Zoom on Input Focus

Prevents iOS Safari auto-zoom when tapping form inputs (triggered by `font-size < 16px`).

- **Viewport meta** (`index.html`) — Added `maximum-scale=1.0, user-scalable=no` to prevent auto-zoom and pinch-zoom
- **CSS** (`src/index.css`) — Added `touch-action: manipulation` on `html` to prevent double-tap zoom
- **Input.tsx** — Changed `text-sm` → `text-base md:text-sm` (16px on mobile, 14px on desktop)
- **Settings.tsx** — Two `<select>` elements: `text-sm` → `text-base md:text-sm`
- **CustomFieldsRenderer.tsx** — `inputClass`: `text-sm` → `text-base md:text-sm`

## [0.7.0] - 2026-02-15 (continued)

### Documentation Overhaul

Rewrites all documentation to professional open-source standards.

- **README.md** — Full rewrite: logo header, badges, features list, tech stack table, quick start, project structure, API & integrations section
- **LICENSE** — Added MIT license
- **CONTRIBUTING.md** — Added contribution guide with setup instructions, code style, PR process, commit conventions
- **mcp-server/README.md** — Removed PT-BR duplicate section, fixed GitHub URLs, added license link
- **convex/README.md** — Replaced generic Convex boilerplate with project-specific backend guide (file layout, auth, REST API)
- **CLAUDE.md** — Removed redundant Skills and Agents sections (auto-discoverable)
- **src/CLAUDE.md** — Added DevelopersPage to structure tree, removed Path Alias and Key Dependencies sections
- **convex/CLAUDE.md** — Added llmsTxt.ts and onboarding files to file layout table
- **vercel.json** — Added SPA routing rewrite for Vercel deployment
- **README.md** — Added Deploy section (Vercel + Convex production)
- **CONTRIBUTING.md** — Added environment variables section

## [0.7.0] - 2026-02-15

### MCP Server, Developer Portal & llms.txt

Adds an MCP server for AI agent integration, a developer portal page, llms.txt endpoints, new REST API endpoints, and renames all remaining ClawCRM references to HNBCRM.

#### MCP Server (`mcp-server/`)
- **hnbcrm-mcp** npm package — Model Context Protocol server for AI agent integration
- **HnbCrmClient** — TypeScript API client wrapping all REST endpoints
- **Tools** — leads (search, create, update, move stage, assign), contacts (search, create, update), conversations (list, get messages, send), handoffs (list pending, accept, reject), pipeline (list boards with stages)
- **Resources** — `hnbcrm://boards`, `hnbcrm://team-members`, `hnbcrm://field-definitions` with auto-refresh
- Auth via `HNBCRM_API_URL` + `HNBCRM_API_KEY` environment variables

#### Developer Portal (`src/pages/DevelopersPage.tsx`)
- Public page at `/developers` with REST API docs, MCP server setup, and SDK examples
- Tabbed code blocks for Claude Desktop, Cursor, and environment variable configs
- Added "Developers" link to LandingPage header and footer

#### llms.txt (`convex/llmsTxt.ts`, `convex/router.ts`)
- `/llms.txt` and `/llms-full.txt` HTTP endpoints for AI-readable project documentation
- Describes API capabilities, authentication, and endpoint reference

#### New REST API Endpoints (`convex/router.ts`)
- `GET /api/v1/boards` — List boards with stages (for MCP resources)
- `GET /api/v1/team-members` — List team members (for MCP resources)
- `GET /api/v1/field-definitions` — List field definitions (for MCP resources)

#### Internal (`convex/fieldDefinitions.ts`)
- Added `internalGetFieldDefinitions` query for HTTP API router access

#### Landing Page (`src/components/LandingPage.tsx`)
- Moved "Servidor MCP" from Coming Soon to built Features section
- Removed "Em Breve" badge from MCP in pricing tier

#### Rebrand Cleanup
- Renamed all remaining `ClawCRM` references to `HNBCRM` across 19 files
- Updated npm package name, API key prefix (`hnbcrm_`), localStorage keys, seed email domains, env var names, MCP resource URIs, TypeScript class names, config keys, and doc headings

## [0.6.0] - 2026-02-15

### URL Routing & Sales Landing Page

Adds react-router v7 for URL-based navigation and a public sales landing page for unauthenticated visitors.

#### URL Routing (`src/main.tsx`, `src/lib/routes.ts`)
- **react-router v7** in SPA/library mode with `createBrowserRouter` + `RouterProvider`
- Public routes: `/` (LandingPage), `/entrar` (AuthPage)
- App routes: `/app/painel`, `/app/pipeline`, `/app/contatos`, `/app/entrada`, `/app/repasses`, `/app/equipe`, `/app/auditoria`, `/app/configuracoes`
- **`TAB_ROUTES` / `PATH_TO_TAB`** shared route mapping constants in `src/lib/routes.ts`

#### AuthLayout (`src/components/layout/AuthLayout.tsx`)
- New route layout consolidating auth → org selection → onboarding wizard → team member gates
- Unauthenticated users redirected to `/entrar`; authenticated users on `/entrar` redirected to `/app`
- Passes `organizationId` to child routes via `useOutletContext<AppOutletContext>()`
- Wraps page content with `ErrorBoundary`

#### Sales Landing Page (`src/components/LandingPage.tsx`)
- **Hero** with radial orange glow, staggered fade-in animations, floating CTA pill (IntersectionObserver)
- **Social Proof Bar** — 3 capability highlights
- **Features Section** — 12 built feature cards in responsive grid
- **Coming Soon** — 8 upcoming features with "Em Breve" badges
- **How It Works** — 3 step cards
- **Pricing** — 3 tiers (Starter free, Pro highlighted, Enterprise) — all free during beta
- **CTA Section** + **Footer**
- Fully responsive (375px → 768px → 1024px), accessible landmarks, PT-BR text

#### Auth Page (`src/components/AuthPage.tsx`)
- Standalone auth screen at `/entrar` with back-to-landing link
- Auth redirect guard: already-authenticated users sent to `/app`

#### Navigation Refactor (`src/components/layout/`)
- **Sidebar** and **BottomTabBar** now derive active tab from `useLocation()` and navigate via `useNavigate()` — removed `activeTab`/`onTabChange` props
- **AppShell** simplified — no longer passes tab state props
- **OnboardingChecklist** uses `useNavigate` + `TAB_ROUTES` instead of `onTabChange` prop

#### Page Components
- All 8 page components (DashboardOverview, KanbanBoard, ContactsPage, Inbox, HandoffQueue, TeamPage, AuditLogs, Settings) now use `useOutletContext<AppOutletContext>()` for `organizationId` instead of receiving it as a prop
- `DashboardOverview` derives `onTabChange` via `useNavigate` + `TAB_ROUTES`

#### Cleanup
- `App.tsx` and `Dashboard.tsx` are now dead code (superseded by router + AuthLayout + Outlet)

## [0.5.3] - 2026-02-15

### @Mentions in Internal Notes & Onboarding System

Adds Slack-like @mention autocomplete for internal notes and a full onboarding experience for new organizations.

#### @Mentions (`src/lib/mentions.ts`, `src/components/ui/MentionTextarea.tsx`, `src/components/ui/MentionRenderer.tsx`)
- **MentionTextarea** — Custom textarea with @mention autocomplete dropdown; type `@` after space/start to trigger, fuzzy-filters team members, keyboard navigation (arrows, Enter/Tab to select, Escape to close), accessible with ARIA attributes
- **MentionRenderer** — Renders `@[Name](id)` tokens as brand-colored inline pills in message content
- **Mention utilities** — Pure functions for parsing, insertion, ID extraction, and accent-normalized fuzzy filtering
- Mentions only active for internal notes (`isInternal=true`), disabled for external messages
- `mentionedUserIds` field added to messages schema for tracking who was mentioned

#### Backend (`convex/conversations.ts`, `convex/router.ts`)
- Added `mentionedUserIds` arg to `sendMessage` and `internalSendMessage` mutations (only stored for internal notes)
- HTTP API `/api/v1/conversations/send` forwards `mentionedUserIds`

#### Onboarding System (`convex/onboarding.ts`, `src/components/onboarding/`)
- **OnboardingWizard** — 5-step wizard for new organizations: Welcome, Pipeline Setup, Sample Data, Team Invite, Complete
- **OnboardingChecklist** — Dashboard widget tracking first-use milestones with progress bar
- **SpotlightTooltip** — Contextual feature tooltips on first visit to key pages (Inbox, Contacts, Pipeline, etc.)
- **ConfettiCanvas** — Celebration animation on milestone completions
- `onboardingProgress` table tracks wizard state, checklist dismissal, seen spotlights, and celebrated milestones per team member
- `onboardingMeta` field on organizations stores industry, company size, and main goal from wizard
- Seed data templates for sample pipelines, leads, and contacts

## [0.5.2] - 2026-02-15

### Contact Enrichment & Enhanced UI

Adds 20+ enrichment fields to contacts, full REST API for contacts, and a major frontend upgrade to the contacts experience.

#### Schema & Backend (`convex/contacts.ts`, `convex/schema.ts`)
- **20+ enrichment fields** on contacts: social URLs (LinkedIn, Instagram, Facebook, Twitter), location (city, state, country), company info (industry, companySize, CNPJ, companyWebsite), acquisition data (utmSource, acquisitionChannel, deviceType), social metrics (instagramFollowers, linkedinConnections, socialInfluenceScore), custom fields, and enrichment metadata
- **`enrichContact` internal mutation** — AI-agent-friendly enrichment with per-field source/confidence tracking via `enrichmentMeta`
- **`getContactEnrichmentGaps` query** — Returns missing fields for a contact (public + internal variants)
- **`getContactWithLeads` query** — Contact with linked leads, stage info, and assignees
- **`diffChanges` helper** — Extracted shared change-tracking logic, replacing duplicated per-field if-blocks in update mutations
- **`buildSearchText` expanded** — Now indexes city, state, country, industry, and bio

#### REST API (`convex/router.ts`)
- Full contacts CRUD: `GET /api/v1/contacts`, `GET /api/v1/contacts/:id`, `POST /api/v1/contacts`, `PUT /api/v1/contacts/:id`, `DELETE /api/v1/contacts/:id`

#### Field Definitions (`convex/fieldDefinitions.ts`)
- Added `entityType` filter (`lead` | `contact`) to `getFieldDefinitions` query
- New `by_organization_and_entity` index for scoped field lookups
- `createFieldDefinition` now accepts optional `entityType`

#### Frontend
- **ContactDetailPanel** — Collapsible sections for social links, location, company info, acquisition data, custom fields; photo display; enrichment gap indicator
- **CreateContactModal** — Multi-step form (basic info → enrichment fields) with all new fields
- **ContactsPage** — Tag filters, enrichment gap badges on contact rows, improved search
- **CustomFieldsRenderer** — New component for rendering and editing custom fields on contacts
- **SocialIcons** — New component for social media link icons (LinkedIn, Instagram, Facebook, Twitter)
- **CollapsibleSection** — New reusable UI primitive for expandable content sections
- **Settings** — Added contact custom fields management section

#### Seed Data (`convex/seed.ts`)
- Enhanced seed contacts with social URLs, location, industry, and company data

## [0.5.1] - 2026-02-14

### Dashboard Home Page & Pipeline Widget Redesign

#### Dashboard Home Page
- **Hero section** — Personalized greeting with org name and HNBCRM tagline
- **Quick Stats row** — 4 metric cards: pipeline value, active leads, pending handoffs, team members
- **Quick Actions** — Horizontal-scroll (mobile) / 4-col grid (desktop) nav cards to Pipeline, Inbox, Handoffs, Team
- **Feature Overview grid** — 10 interactive cards showcasing existing platform features with live data badges
- **Coming Soon section** — 8 "Em Breve" cards for planned features (MCP Server, Automations, AI Co-pilot, etc.)
- **Recent Activity feed** — Latest 10 activities with type badges and PT-BR timestamps

#### Pipeline Widget — Board-Grouped with Tabs
- **Pill-tab board selector** — Stages now grouped by pipeline; tab row with colored dot per board (hidden when only 1 board)
- **Board summary header** — Shows board name, lead count, and total value per pipeline
- **Won/Lost badges** — Stages marked as closedWon/closedLost show "Ganho"/"Perdido" badge
- **Rate limiting** — Leads queried per-board via `by_organization_and_board` index with `.take(500)` cap; remaining org-wide queries capped at `.take(2000)`; handoffs capped at `.take(100)`

#### Backend (`convex/dashboard.ts`)
- `getDashboardStats` restructured: `pipelineStats` now returns board-grouped array instead of flat stage list
- `getPipelineStats` updated with same board-grouped structure
- Added `organizationName` and `teamMemberCount` to dashboard stats return

## [0.5.0] - 2026-02-14

### Contacts, Saved Views, Pipeline Management & Kanban UX Overhaul

Major feature release adding contacts management, saved views, pipeline CRUD modals, and a kanban UX overhaul based on research of Pipedrive, HubSpot, and modern CRM patterns.

#### Contacts Page & Management
- **ContactsPage** — New dedicated contacts tab with search, table view, and contact detail panel
- **ContactDetailPanel** — SlideOver panel showing contact info and linked leads
- **CreateContactModal** — Modal for creating new contacts with full field support
- **Contacts nav** — Added "Contatos" tab to both Sidebar (desktop) and BottomTabBar (mobile); moved "Equipe" to "Mais" menu on mobile
- Contact search text indexing (`searchText` field + `buildSearchText` helper) for full-text search
- **CreateLeadModal** improved — Contact selection now supports three modes: none, select existing, or create new

#### Saved Views
- **savedViews.ts** backend — CRUD queries/mutations for saved views with filters, sort, and column preferences
- **ViewSelector** — Dropdown component for selecting and managing saved views
- **CreateViewModal** — Modal for creating new saved views with filter configuration

#### Pipeline Management Modals
- **EditBoardModal** — Modal for editing pipeline name, description, and color
- **ManageStagesModal** — Full stage management: rename, recolor, reorder (up/down), add, delete, toggle closedWon/closedLost

#### Lead Detail Panel Overhaul
- **Contact link/unlink** — Interactive contact section replaces read-only text; searchable contact picker dropdown with link, change, and unlink buttons
- **Assignee selector** — Dropdown of all team members with role badges (Admin/Gerente/Agente/IA) and "Não atribuído" option
- **Stage/Pipeline selector** — Cascading pipeline > stage picker with closedWon/closedLost badges, move leads between pipelines from the detail panel

#### Deal Aging & Stage Stats
- **Days-in-stage indicator** on kanban cards — Clock icon with color-coded aging (green < 3d, yellow 3-7d, red > 7d)
- **Stage column summary stats** — Each column header now shows lead count and total value (e.g. "8 leads · R$ 125.000")

#### Win/Loss Reason Capture
- Added `closedAt`, `closedReason`, `closedType` fields to leads schema
- **CloseReasonModal** intercepts drag-to-close and stage-change-to-close, capturing reason (required for lost) and final value
- `moveLeadToStage` mutation now accepts `closedReason` and `finalValue`, auto-sets close fields for closedWon/closedLost stages

#### Pipeline & Stage Management UX
- **Pipeline selector redesign** — Color dot indicators, visible "+" Novo button in tab bar, gear icon for active pipeline only
- **Inline stage management** — "..." menu on each column header for rename, change color, mark as won/lost, delete stage
- **Add stage column** — Dashed placeholder column at the far right of the kanban for quick stage creation
- **Pipeline creation with default stages** — New pipelines auto-include 5 stages (Novo Lead, Qualificado, Proposta, Negociação, Fechado) via new `createBoardWithStages` mutation

#### UI Components
- **EmptyState** — Reusable empty state component with icon, title, description, and action button

#### Bug Fixes
- Fixed null safety in `conversations.ts` and `handoffs.ts` when accessing `lead.contactId` (could crash if contactId was undefined)

## [0.4.1] - 2026-02-14

### Fixed
- Logo distortion in AuthScreen and WelcomeScreen — added `object-contain` to prevent squeezing of non-square (528x488) image in square containers

### Improved
- **WelcomeScreen** is now the primary org selection/creation interface:
  - Displays existing organizations as interactive cards with icon, name, slug, and role badge
  - "Criar Organização" card opens a modal creation form with auto-generated slug
  - Auto-selects newly created org; works on both desktop and mobile
- **OrganizationSelector** simplified to just a `<select>` dropdown for switching orgs in the sidebar — removed buried absolute-positioned popup and inline creation form

## [0.4.0] - 2026-02-14

### HNBCRM Rebrand & Frontend Overhaul

Complete UI transformation from light-theme prototype to dark-theme-first, mobile-first, orange-branded CRM with Portuguese (BR) interface.

#### Brand & Identity
- Rebranded from ClawCRM to **HNBCRM** (Humans & Bots CRM)
- Orange handshake logo with 3 variants (orange/white/black on transparent)
- Updated `index.html`: `lang="pt-BR"`, `class="dark"`, favicon, title "HNBCRM"
- Created `STYLE_GUIDE.md` — comprehensive design system documentation (PT-BR)

#### Design System Foundation
- Rewrote `tailwind.config.js`: `darkMode: 'class'`, brand orange palette (50–900), surface/border/text CSS variable tokens, custom shadows, animations, keyframes
- Rewrote `src/index.css`: CSS custom properties (dark default + `.light` override), auth underline inputs, pill buttons, skeleton shimmer, custom scrollbar, safe-area utility, reduced-motion support
- Created `src/lib/utils.ts` with `cn()` utility (clsx + tailwind-merge)
- Added `lucide-react` for tree-shakeable SVG icons (replacing all emoji icons)

#### UI Component Library (`src/components/ui/`)
- `Button.tsx` — Pill button with 5 variants (primary, secondary, ghost, dark, danger) and 3 sizes
- `Input.tsx` — Bordered form input with label, error state, icon support
- `Badge.tsx` — Semantic status badge (default, brand, success, error, warning, info)
- `Card.tsx` — Dark surface card with 3 variants (default, sunken, interactive)
- `Modal.tsx` — Bottom sheet (mobile) / centered dialog (desktop) with Esc/click-outside
- `SlideOver.tsx` — Full-screen (mobile) / 480px side panel (desktop)
- `Spinner.tsx` — Brand-colored loading spinner with sr-only PT-BR text
- `Skeleton.tsx` — Shimmer loading placeholder (text, circle, card variants)
- `Avatar.tsx` — Initials avatar with AI bot badge and online/busy/offline status dot

#### Layout & Navigation (`src/components/layout/`)
- `AppShell.tsx` — Orchestrates responsive layout (sidebar vs bottom tab bar)
- `Sidebar.tsx` — Desktop fixed left nav, collapsed icons at md, expanded with labels at lg
- `BottomTabBar.tsx` — Mobile fixed bottom tabs (5 main + "Mais" menu for Audit/Settings)

#### App Shell Refactor
- `App.tsx` — Integrated `AppShell`, moved nav out, dark auth screen with orange logo
- `Dashboard.tsx` — Removed inline tab navigation (now handled by AppShell), simplified to content-only renderer

#### Component Restyling (all 13 components)
- Applied dark theme (surface tokens, border tokens, text tokens) to every component
- Translated all user-facing text to Portuguese (BR)
- Replaced all emoji icons with `lucide-react` icons
- Integrated reusable UI components (Button, Badge, Card, Modal, SlideOver, Avatar, Spinner)
- Made responsive: Inbox list/detail toggle on mobile, Kanban snap-scroll, stacked filters
- `SignInForm.tsx` — Underline inputs, pill button, PT-BR auth flow
- `KanbanBoard.tsx` — Dark columns, Badge/Avatar, mobile snap-scroll
- `LeadDetailPanel.tsx` — Uses SlideOver, dark message bubbles, PT-BR forms
- `CreateLeadModal.tsx` — Uses Modal component, dark form styling
- `Inbox.tsx` — Responsive list/detail with mobile toggle, dark message bubbles
- `HandoffQueue.tsx` — Card + Avatar, accept/reject with brand buttons
- `TeamPage.tsx` — Avatar with AI indicator, Modal for add member
- `AuditLogs.tsx` — Dark table with Badge for actions/severity, responsive filters
- `Settings.tsx` — All 5 sub-sections restyled with Modal, pill section tabs
- `OrganizationSelector.tsx` — Dark dropdown, sidebar-compatible
- `ErrorBoundary.tsx` — Dark error state, PT-BR text

#### Developer Tooling
- Created `.claude/agents/frontend-specialist.md` — Sonnet-powered agent for all frontend UI tasks
- Updated `src/CLAUDE.md` — new component tree, dark theme patterns, PT-BR notes

## [0.3.0] - 2026-02-14

### Security & Performance Hardening

#### Auth & Access Control
- Created `convex/lib/auth.ts` with shared `requireAuth()` helper, replacing duplicated 8-line auth boilerplate across all backend files
- Added authentication to `createConversation` and `getOrganizationBySlug` (previously unprotected)
- `getOrganizationBySlug` now returns only safe fields (`_id`, `name`, `slug`) instead of full org settings

#### Query Performance
- Added `limit` argument with `.take()` to `getLeads`, `getConversations`, `getHandoffs` (and internal variants) — default 200, prevents unbounded `.collect()`
- Added `by_organization_and_board` index on leads for efficient board-scoped queries
- Added `by_key_hash_and_active` compound index on apiKeys, eliminating in-memory `isActive` filtering
- `getConversations` now uses `by_lead_and_channel` index when `leadId` is provided instead of full org scan
- Split `getDashboardStats` into 4 focused queries: `getPipelineStats`, `getLeadsBySource`, `getTeamPerformance`, `getDashboardSummary`

#### Webhook Coverage
- Added webhook triggers to `updateLead`, `deleteLead`, `assignLead`, `updateLeadQualification` (and internal variants)
- Added webhook triggers to `acceptHandoff` and `rejectHandoff` (and internal variants)

#### Bug Fixes
- Fixed `rejectHandoff` incorrectly setting `acceptedBy` — now uses `resolvedBy` field
- Added `resolvedBy` field to handoffs schema; set on both accept and reject

#### Frontend Improvements
- Changed `organizationId` prop type from `string` to `Id<"organizations">` across all 12 components, removing unsafe `as` casts
- Replaced `console.error`/`alert` with `toast.error()` for consistent user-facing error handling
- Added `ErrorBoundary` component wrapping all dashboard tab contents
- Fixed `any` types in `Inbox.tsx` message styling and `Settings.tsx` org finder

#### Cleanup
- Renamed package from `flex-template` to `clawcrm`
- Deleted unused `src/lib/utils.ts`
- Typed `router.ts` helper functions — `jsonResponse` accepts `Record<string, unknown>`, typed `.find()` callbacks

## [0.2.0] - 2026-02-13

### Developer Tooling & AI Agent Support

- Added `convex-agent-plugins` submodule (18 best-practice rules, 7 skills, 2 agents)
- Created `CLAUDE.md` (root) — commands, architecture, mandatory Convex rules, skill/agent catalog
- Created `convex/CLAUDE.md` — backend file map, auth pattern, mutation side-effects checklist, index reference, HTTP API pattern
- Created `src/CLAUDE.md` — component tree, data fetching/mutation patterns, styling conventions
- Added PostToolUse hooks: auto-validate Convex functions for missing validators, auto-codegen after schema edits
- Added `convex/seed.ts` for development seeding

## [0.1.0] - 2026-02-11

### Initial MVP Release

#### Bug Fixes
- Fixed critical crash when Kanban board loaded with null `boardId` by using Convex `"skip"` pattern

#### Phase 1 — Core Functionality
- Added `activities` table to schema for lead activity tracking
- Created `convex/activities.ts` — getActivities, createActivity, addActivity (internal)
- Created `convex/auditLogs.ts` — getAuditLogs query with severity/entityType filters and pagination
- Added `updateLead` and `deleteLead` mutations to `convex/leads.ts`
- Wired activity logging into createLead, moveLeadToStage, assignLead, updateLeadQualification, sendMessage, requestHandoff, acceptHandoff
- Created `LeadDetailPanel` component with 3 tabs: Conversation, Details, Activity
- Created `CreateLeadModal` component with contact selection/creation
- Updated `KanbanBoard` with lead card click-to-open and "Create Lead" button
- Updated `AuditLogs` component to use real data with filters

#### Phase 2 — Complete CRUD
- Created `convex/fieldDefinitions.ts` — full CRUD for custom field definitions
- Created `convex/leadSources.ts` — full CRUD for lead sources
- Created `convex/webhooks.ts` — full CRUD for webhooks (admin only)
- Created `convex/dashboard.ts` — getDashboardStats query (pipeline stats, leads by source, team performance, pending handoffs, recent activities)
- Added `updateContact`, `deleteContact`, `getContact` to `convex/contacts.ts`
- Added `updateOrganization` mutation to `convex/organizations.ts`
- Created `DashboardOverview` component with summary cards, pipeline chart, team stats
- Added Dashboard tab as default tab in main Dashboard component
- Expanded `Settings` page with sections: General, API Keys, Custom Fields, Lead Sources, Webhooks

#### Phase 3 — HTTP API Expansion
- Expanded `convex/router.ts` with full REST API:
  - Lead endpoints: GET, update, delete, move-stage, assign, handoff
  - Contact endpoints: list, create, get, update
  - Conversation endpoints: list, get messages, send message
  - Handoff endpoints: list, pending, accept, reject
- Added CORS headers and OPTIONS preflight handlers
- Standardized error/success response format

#### Phase 4 — Polish
- Added Human/AI indicator badges on lead cards and assignee avatars
- Added message color coding by sender type: contact (gray), human (blue), AI (purple), internal notes (yellow dashed)
- Added CSV export to Audit Logs page
- Created `convex/webhookTrigger.ts` — webhook trigger system with HMAC signatures
- Wired webhook triggers into lead.created, lead.stage_changed, message.sent, handoff.requested events
