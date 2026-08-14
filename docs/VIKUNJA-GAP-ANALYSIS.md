# HNBCRM como gestor de tarefas — dá para substituir o Vikunja?

> **Status 2026-08-14:** P1 implementado (v0.43.0) — ver `docs/P1-TASKS-PLAN.md`.

**Data:** 2026-08-13 · **Escopo:** análise, sem implementação.
**Método:** 3 agentes em paralelo — inventário de features do Vikunja (docs oficiais + specs OpenAPI v1/v2 da instância pública), mapeamento do backend Convex de tarefas do HNBCRM, e mapeamento da UI + das três superfícies de IA (MCP, Copiloto, Atendente).

---

## Veredito

**Hoje: substituição parcial. Com os gaps P0+P1 fechados: sim, e com vantagem.**

- O **núcleo de tarefa** do HNBCRM já cobre o dia a dia: título/descrição, prioridade, due date, recorrência, checklist, snooze (que o Vikunja nem tem), comentários, tags, busca full-text, calendário que mescla tarefas + eventos, API REST completa, webhooks e e-mails PT-BR.
- O que falta para paridade humana é a camada de **organização**: projetos/listas, kanban de tarefas com colunas customizáveis, subtarefas reais, múltiplos responsáveis, labels com cor, filtros salvos e ordenação manual. Tarefa no HNBCRM hoje só "mora" em lead/contato/responsável — trabalho genérico de projeto não tem onde ficar.
- Para o critério central — **ser bom para humanos E agentes IA** — nenhum dos dois entrega hoje, mas o HNBCRM está muito mais perto: já tem 3 superfícies de IA, papel `ai` no time, fila com debounce (`aiReplyQueue`), modo suggest com revisão humana e auditoria (`agentRuns`). Falta ligar essa infraestrutura a tarefas: **atribuir tarefa a um membro IA hoje é puramente cosmético** — nada acorda o agente. O Vikunja atacou exatamente isso na 2.4.0 (bot users + CLI `veans`), e o desenho deles é uma boa referência (seção "Humanos + IA" abaixo).
- Dois achados sérios de segurança/consistência precisam ser resolvidos antes de qualquer uso como gestor de tarefas de time: **o RBAC de tarefas não é aplicado em nenhuma função** e **tarefas criadas por IA pulam auditLog/webhook**.

---

## 1. Comparativo por categoria

| Categoria | Vikunja | HNBCRM hoje | Situação |
|---|---|---|---|
| Campos da tarefa | título, desc rich-text, done, due/start/end, prioridade 1–5, % done manual, cor, favorito | título, desc, status 4 estados, prioridade 4 níveis, due date, tipo de atividade, snooze | ✅ paridade no essencial; falta start date, cor, favorito, % done |
| Responsáveis | **múltiplos** assignees | **um** `assignedTo` | ⚠️ gap |
| Labels | tabela própria, cor, cross-project, criação inline | `tags: string[]` livre, sem cor (a tabela `conversationLabels` é só do inbox) | ⚠️ gap |
| Subtarefas | relação parent↔subtask em profundidade arbitrária | `checklist` embutido (itens sem due/assignee/prioridade); `parentTaskId` existe mas é só linhagem de recorrência | ⚠️ gap |
| Relações/dependências | 11 tipos (blocked by, precedes, duplicate…) | nenhuma | ⚠️ gap |
| Recorrência | `repeat_after` em segundos + 3 modos; **a tarefa nunca fica done** (se auto-desmarca) | daily/weekly/biweekly/monthly; completar gera **nova instância** e a atual fica done de verdade | ✅ semântica do HNBCRM é **melhor**; faltam intervalos custom/anual |
| Lembretes | múltiplos por tarefa, absolutos **e relativos** ("1h antes do due") | 1 por tarefa (type reminder), dispara **no** vencimento; cron de segurança 5 min | ⚠️ gap (sem "avise antes") |
| Notificações | sino in-app via WebSocket, e-mail, menção @ notifica, feed Atom | e-mail `taskAssigned`/`taskOverdue` com preferências opt-out; **sem sino in-app; menções gravadas mas nunca notificam** | ⚠️ gap |
| Organização | projetos hierárquicos, Inbox pessoal, arquivar/duplicar/favoritar, identificador `MOVE-42` | tarefa vive solta na org; contêineres = lead/contato/responsável; boards/stages são **só de leads** | ❌ maior gap estrutural |
| Views | List, Table, Kanban (buckets custom, WIP limit, done bucket, filter buckets), Gantt; views extras por projeto, cada uma com filtro próprio | lista agrupada por vencimento + kanban fixo de 3 colunas de status; calendário dia/semana/mês | ⚠️ gap |
| Filtros/busca | sintaxe `dueDate < now+7d/d && labels in x`, saved filters com views próprias, busca global Ctrl+K | filtros por pills + dropdown; busca **client-side só no título** (índice full-text existe no backend e a UI não usa); `savedViews` existe mas moldado p/ leads | ⚠️ gap |
| Quick add | Quick Add Magic (`*label @pessoa +projeto !3 tomorrow every week`), multi-linha, indentação = subtarefa | modal de criação tradicional | ⚠️ gap (barato, alto valor) |
| Colaboração | 3 níveis por projeto (read/write/admin), times, **link share público** | RBAC 6 níveis por categoria… **não aplicado em tasks** (ver P0.1) | ❌ bug > gap |
| Anexos | por tarefa, preview de imagem/PDF, imagem de capa no kanban | tabela `files` **sem** `task_attachment` nem `taskId` | ⚠️ gap |
| API | REST v1 (126 rotas) + v2 OpenAPI 3.1 (133), tokens com escopo | 14 rotas de tasks + 7 de calendar em `/api/v1/`, X-API-Key com RBAC por key | ✅ suficiente |
| Webhooks | 16 eventos de projeto + 3 de usuário, HMAC, **sem retry** | ~15 eventos `task.*`/`calendar_event.*` | ✅ paridade |
| CalDAV/ICS | CalDAV **alpha auto-declarado** (iOS não sincroniza) | nada | ➖ baixa prioridade (nem no Vikunja funciona bem) |
| Import/export | Todoist, Trello, TickTick, MS To-Do, CSV, WeKan; export ZIP | plano próprio em `EXPORT-IMPORT-PLAN.md`; nada de tarefas | ➖ só importa se houver dado no Vikunja a migrar |
| Time tracking / audit / admin | **pago (Vikunja Pro, beta privado)** | auditLogs **grátis** (mas IA pula, ver P0.3); sem time tracking | ✅ vantagem HNBCRM em audit |
| IA | bot users + CLI `veans` (2.4.0): agente reivindica tarefa, para em "In Review", nunca fecha a própria | 3 superfícies (MCP 12 tools de task + 6 calendar; Copiloto 2; Atendente 1) mas **assignee IA não dispara nada** | ⚠️ os dois incompletos; HNBCRM com muito mais infra pronta |

---

## 2. Onde o HNBCRM já é melhor

1. **Contexto de CRM de graça** — tarefa nasce ligada a lead/contato/conversa, com aba de tarefas no painel do lead, activity log e webhook. No Vikunja isso não existe.
2. **Semântica de recorrência correta** — completar uma recorrente gera a próxima como registro novo (histórico limpo). No Vikunja a tarefa recorrente *nunca* fica concluída (se auto-desmarca e empurra as datas) — reclamação conhecida ([issue #2795](https://github.com/go-vikunja/vikunja/issues/2795)).
3. **Snooze** — não existe no Vikunja.
4. **Audit logs e notificações por e-mail grátis** — no Vikunja, audit log é feature paga (Pro Business/Enterprise).
5. **Calendário integrado** — `calendar.getEvents` já mescla eventos + tarefas com due date (`_source: "event"|"task"`), com drag-and-drop e recorrência própria; eventos aceitam múltiplos participantes.
6. **Infra de IA nativa** — 3 superfícies, RBAC por API key, `agentRuns` auditado, modo suggest com aprovação humana, `pendingActions` two-phase. O Vikunja só agora começou (veans), e como CLI externo.

---

## 3. O que falta — priorizado

Esforço: **P** pequeno · **M** médio · **G** grande.

### P0 — bloqueadores (segurança + o coração humano/IA)

| # | Gap | Detalhe | Esforço |
|---|---|---|---|
| P0.1 | **RBAC de tasks não é aplicado** | A categoria `tasks` (none/view_own/view_all/edit_own/edit_all/full) existe em `convex/lib/permissions.ts` e na UI, mas **zero** funções chamam `requirePermission(..., "tasks", ...)` — `tasks.ts`, `taskComments.ts`, `calendar.ts` e `boards.ts` usam só `requireAuth`. Hoje qualquer membro da org vê, edita, reatribui e **deleta** qualquer tarefa, mesmo com permissão `none`. Inaceitável para gestor de tarefas de time (e vale também para o papel `ai`: o nível `edit_own` do agente não é imposto). | M |
| P0.2 | **Atribuir tarefa a membro IA não faz nada** | Schema e UI aceitam assignee IA (dropdown sem filtro, badge no avatar), mas `email.ts` pula não-humanos explicitamente e **não existe** análogo da `aiReplyQueue` para tarefas: nenhum scheduler, webhook interno ou trigger acorda o agente. A única forma de uma IA saber das suas tarefas é polling externo via API. Esse é O gap para "bom para os 2" — ver seção 4. | G |
| P0.3 | **Superfícies de IA inconsistentes e sem side effects** | (a) Copiloto tem só 2 tools de task (listar/criar — sem completar/atribuir/comentar/snooze) e cria tarefa **sem assignee, sem auditLog e sem webhook**; (b) Atendente tem 1 (criar follow-up, write-only, também sem audit/webhook); (c) `.claude/skills/hnbcrm/SKILL.md` documenta 3 tools que **não existem** (`crm_get_my_tasks`, `crm_assign_task`, `crm_get_overdue_tasks` — os dois últimos existem só como REST, nunca viraram tool MCP); (d) `internalUpdateTask` (API) não aceita status/leadId/recurrence, ao contrário da mutation pública. Paridade de vocabulário + side effects é pré-requisito para confiar tarefas a agentes. | M |

### P1 — essenciais para substituir o Vikunja no dia a dia

| # | Gap | Detalhe | Esforço |
|---|---|---|---|
| P1.1 | **Projetos/listas de tarefas** ✅ entregue | Um contêiner de trabalho que não seja lead/contato (ex.: tabela `taskProjects` org-scoped, ou generalizar `boards` para `entityType: "leads"\|"tasks"`). Sem isso, trabalho genérico ("migrar VPS", "conteúdo do blog") não tem morada — é o maior bloqueio estrutural. Hierarquia profunda estilo Vikunja é opcional; um nível já resolve. | M–G |
| P1.2 | **Kanban de tarefas de verdade** ✅ entregue | Colunas customizáveis por projeto (não os 3 status fixos), done bucket, ordenação manual dos cards (campo `order`), opcionalmente WIP limit. A infra de dnd-kit já está na TasksPage. | M |
| P1.3 | **Subtarefas reais e/ou dependências** ✅ entregue | Promover `parentTaskId` a hierarquia geral (hoje só linhagem de recorrência) com due/assignee próprios; ou no mínimo relação `blockedBy`. Importante também para IA: decompor trabalho em subtarefas atribuíveis a agentes. | M |
| P1.4 | **Múltiplos assignees** ✅ entregue | `assignedTo` → array (ou tabela de junção). Caso de uso direto humano+IA: par humano revisor + agente executor na mesma tarefa. `calendarEvents.attendees` já é array — precedente no próprio schema. | M |
| P1.5 | **Labels de tarefa com cor** ✅ entregue | Generalizar `conversationLabels` para org-wide (`labels` com `entityType`) em vez de `tags` string livre. | P–M |
| P1.6 | **Filtros salvos + busca server-side na UI** ✅ entregue | A TasksPage busca por substring client-side só no título enquanto `search_tasks` (título+desc+tags) está pronto no backend; `savedViews` já suporta `entityType: "tasks"` mas o objeto `filters` é de leads e nenhuma query de tasks o lê. Ligar as pontas. | P–M |
| P1.7 | **Notificações completas** ✅ entregue | (a) menção `@` em comentário de tarefa (`mentionedUserIds` é gravado e **nunca** notifica ninguém); (b) lembrete relativo "X antes do vencimento" (hoje só dispara no due date); (c) sino/feed in-app (hoje só e-mail — Convex reativo torna isso barato). | M |

### P2 — ergonomia e paridade fina

| # | Gap | Detalhe | Esforço |
|---|---|---|---|
| P2.1 | Quick add com sintaxe (`!alta amanhã @joao #projeto`) no composer e no comando do Copiloto | melhor razão valor/esforço da lista | P–M |
| P2.2 | Anexos em tarefa (`files.fileType: "task_attachment"` + `taskId`) | | P |
| P2.3 | Recorrência com intervalo custom ("a cada 3 dias"), anual e dias úteis (RRULE-lite) | a semântica base já é boa | M |
| P2.4 | Ordenação na UI (o backend aceita `sortBy` e a TasksPage nunca passa) + sort manual em lista | | P |
| P2.5 | View de tabela com colunas configuráveis | | M |
| P2.6 | Bulk snooze e bulk assign/delete na UI (backend já suporta assign/delete em bulk; snooze nem no backend) | | P |
| P2.7 | Unificar os dois `TaskDetailSlideOver` (o do calendário tem 319 linhas sem checklist/comentários/snooze — experiência pior pela mesma tarefa) | | P–M |
| P2.8 | Campo de lead no `CreateTaskModal` (o state existe, o `<select>` nunca é renderizado — hoje só dá para vincular lead abrindo o modal a partir do lead) | | P |
| P2.9 | Vincular handoffs ↔ tarefas (sistemas hoje 100% desacoplados; um handoff aceito poderia gerar/ligar tarefa) | | M |
| P2.10 | Start date, cor e favorito na tarefa; "% concluído" derivado do checklist (melhor que o manual do Vikunja) | | P–M |

### P3 — não priorizar (ou nem replicar)

- **CalDAV** — no próprio Vikunja é alpha assumido e não sincroniza com iOS. Se quiser algo, um **feed ICS read-only** do calendário resolve 80% por 20% do custo.
- **Gantt** — só se surgir demanda real; o Vikunja nem permite filtrar nessa view.
- **Link shares públicos, reactions, duplicar tarefa** — nice-to-have.
- **Time tracking, painel admin** — no Vikunja são **pagos** (Pro, beta privado); não são baseline de paridade.
- **Modo offline** — nenhum dos dois tem (só um app iOS de terceiros).
- **Importador do Vikunja** — script one-off via export ZIP ou API v2 (envelope paginado, `$schema` por recurso), só se houver base de tarefas a migrar.

---

## 4. Humanos + agentes IA: o modelo alvo

O critério do Eric — "tem que ser bom para os 2" — é onde o HNBCRM pode passar o Vikunja em vez de só alcançá-lo. A referência de desenho é o próprio Vikunja 2.4.0 (`veans`): bot users sem senha, o agente **reivindica** a tarefa, trabalha, move para "In Review" e **nunca fecha a própria tarefa** — um humano fecha. Traduzindo para a infraestrutura que o HNBCRM já tem:

1. **Fila de tarefas para IA** (resolve P0.2): quando `assignedTo` é membro `type: "ai"`, enfileirar num análogo da `aiReplyQueue` (debounce, pacing por org, lock OCC) e acordar o runtime do agente com a tool-belt completa de tarefas.
2. **Estado de revisão = modo suggest de tarefas**: agente entrega em `in_review` (ou usa `pendingActions` para o "concluir"); humano aprova — espelho exato do `AiDraftCard` do atendente. Agente nunca marca `completed` sozinho; o gate server-side já existe como padrão no código.
3. **Comentários como canal de colaboração**: `authorType: "human"|"ai"` já existe em `taskComments`; falta menção notificar (P1.7a) nos dois sentidos — humano menciona o agente para acioná-lo, agente menciona o humano para pedir revisão.
4. **Mesmo vocabulário em toda superfície** (resolve P0.3): humano e IA precisam conseguir as mesmas operações — hoje o Copiloto não completa nem atribui tarefa, e o Atendente não lê nenhuma.
5. **Auditoria simétrica**: toda escrita de IA com auditLog + webhook como a de humano (hoje pula), custo/tokens já vão para `agentRuns`.
6. **RBAC imposto de verdade** (resolve P0.1): o papel `ai` com `edit_own` só significa algo quando `requirePermission` for chamado.

Com 1–6, o HNBCRM vira algo que nem o Vikunja Pro oferece: tarefas onde humano delega para IA (e vice-versa via handoff) dentro do mesmo board, com revisão e trilha de auditoria.

---

## 5. Observações técnicas achadas de passagem (dívidas, independem da decisão)

- `processOverdueReminders` (cron 5 min) varre `by_organization_and_type` sem filtro de valor — até 500 tasks/org por rodada; vale um índice melhor.
- `getTasks` público não tem paginação por cursor (`take(limit*3)` + slice, default 200) — as internas da API já usam `lib/cursor.ts`; alinhar.
- `savedViews.filters` tipado para leads impede reuso limpo para tasks (relaciona com P1.6).
- `boards.ts` faz check de role hardcoded (`["admin","manager"]`) em vez de usar RBAC.
- `mcp-server/README.md` está 100% correto; a `SKILL.md` do repo é que está desatualizada (P0.3c).

## 6. Fontes

- **Vikunja:** vikunja.io/features, help/* (tasks, dates-and-reminders, quick-add-magic, views, filters, saved-filters, sharing-and-teams, permissions, caldav, import-and-export, webhooks, settings, accessibility), docs/* (api-documentation, api-v2, filters, pro, veans), changelogs 2.3.0/2.4.0, e specs OpenAPI ao vivo (`try.vikunja.io/api/v1/docs.json`, `/api/v2/openapi.json`) — o schema real diverge da doc de recorrência (não há RRULE; só `repeat_after` em segundos + 3 modos).
- **HNBCRM:** `convex/schema.ts` (tasks:672, taskComments:737, calendarEvents:752), `convex/tasks.ts`, `convex/taskComments.ts`, `convex/calendar.ts`, `convex/crons.ts`, `convex/lib/permissions.ts`, `convex/router.ts:1520-2063`, `convex/email.ts`, `convex/lib/agentTools.ts`, `convex/copilot.ts`, `convex/attendant.ts`, `mcp-server/src/tools/{tasks,calendar}.ts`, `.claude/skills/hnbcrm/SKILL.md`, `src/components/TasksPage.tsx`, `CreateTaskModal.tsx`, `TaskDetailSlideOver.tsx`, `calendar/*`, `DashboardOverview.tsx`, `LeadDetailPanel.tsx`.
