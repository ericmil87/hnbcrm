# P1 Tasks — Contrato de implementação (agentes paralelos)

> **Status 2026-08-14:** implementado (v0.43.0), 348 testes verdes, lint completo, E2E vivo validado.

Implementação dos itens P1 de `docs/VIKUNJA-GAP-ANALYSIS.md`. Escopo FECHADO: P1.1–P1.7. Nada de P0/P2 (sem RBAC novo, sem tocar mcp-server/REST além do necessário para compilar).

**O schema JÁ ESTÁ PRONTO** (`convex/schema.ts`) — não edite o schema; construa sobre ele:
- `tasks` ganhou: `projectId?`, `columnId?`, `order?`, `labelIds?`, `assigneeIds?`, `blockedBy?`, `recurrenceSourceId?`, `reminderMinutesBefore?`, `preDueReminderSentAt?`. Índices novos: `by_recurrence_source`, `by_organization_and_project`, `by_column`.
- Tabelas novas: `taskProjects`, `taskColumns`, `taskLabels`, `notifications`.
- `savedViews.filters` ganhou campos de task (statuses, priorities, taskType, activityType, projectId, labelIds, assigneeIds, dueFilter).
- `notificationPreferences` ganhou `taskCommentMention?`, `taskDueSoon?`.
- `convex/lib/notify.ts` exporta `createNotification(ctx, {organizationId, memberId, type, title, body?, taskId?, actorId?})` — insere in-app notification na mesma transação, pula membros IA e auto-notificação. `convex/notifications.ts` (list/unreadCount/markRead/markAllRead) JÁ EXISTE.

## Regras semânticas (valem para todos)

1. **Multi-assignee:** `assignedTo` é SEMPRE espelho de `assigneeIds[0]`. Leitura: `assigneeIds ?? (assignedTo ? [assignedTo] : [])`. Toda escrita que mexe em responsáveis atualiza os dois. E-mail/in-app `taskAssigned` vai para cada assignee NOVO (não re-notificar existentes; não notificar o ator).
2. **parentTaskId = subtarefa** (hierarquia). Linhagem de recorrência usa `recurrenceSourceId`. `processRecurringTasks` deve passar a gravar `recurrenceSourceId` (e NÃO `parentTaskId`); a task gerada herda `projectId/columnId/labelIds/assigneeIds/reminderMinutesBefore` e resete `preDueReminderSentAt`.
3. **Kanban:** colunas pertencem a um projeto. Task com `projectId` deve ter `columnId` de coluna desse projeto (default: coluna de menor `order` que não seja done) e `order` (`max+1000` na coluna). Mover para coluna `isDoneColumn` completa a task (mesmo fluxo do completeTask, incluindo recorrência); completar task com projeto move para a done column se existir; tirar da done column reabre (`status: "pending"`, limpa `completedAt`). WIP limit é informativo (UI) — backend armazena, não bloqueia.
4. **Dependências (`blockedBy`):** informativas. Não bloquear complete no backend; UI avisa.
5. **Lembrete antecipado:** `reminderMinutesBefore` + `dueDate` ⇒ agendar `ctx.scheduler.runAfter` para `dueDate - minutes*60_000`; o trigger interno re-checa (task existe, não completed/cancelled, dueDate igual ao esperado, `preDueReminderSentAt` ausente, snooze não cobre o horário) e então: in-app `task_due_soon` p/ todos assignees + e-mail `taskDueSoon` + webhook `task.due_soon`; grava `preDueReminderSentAt`. Reagendar ao mudar dueDate/reminderMinutesBefore (limpar `preDueReminderSentAt`).
6. **Menção em comentário:** `addComment` com `mentionedUserIds` ⇒ in-app `task_comment_mention` + e-mail `taskCommentMention` para cada mencionado (menos o autor). eventType de e-mail é `v.string()` — chame `internal.email.dispatchNotification` com `eventType: "taskCommentMention"`; o template é responsabilidade do Agente B2.
7. **searchText** de task passa a incluir nomes de labels e nome do projeto (buscar nomes no momento da escrita).
8. **Side effects:** siga o checklist do `convex/CLAUDE.md` (activity quando há lead, auditLog, webhook, e-mail). Eventos webhook novos: `task.due_soon`, `task_project.created/updated/archived/deleted`, `task_label.created/updated/deleted`, `task.moved` (mudança de coluna).
9. **Auth:** `requireAuth` como o tasks.ts atual (P0.1 fora de escopo). Gestão de projetos/colunas/labels (create/update/delete): check `["admin","manager"].includes(member.role)` como em `boards.ts`.
10. **Validators sempre** (`args` + `returns`), sem `.filter()` de query, sem `Date.now()` em query, PT-BR nas strings de UI/e-mail.
11. **Compat:** NÃO quebrar funções `internal*` usadas pelo router/MCP nem as assinaturas públicas existentes — só adicionar args opcionais.

## Propriedade de arquivos (NUNCA edite arquivo de outro agente)

### Agente B1 — backend-tasks
- `convex/tasks.ts`, `convex/taskComments.ts`, `convex/crons.ts`, novo `convex/tasksP1.test.ts`.
- Entregas: filtros novos em `getTasks` (projectId, columnId, labelIds any-match, assigneeId cobrindo assigneeIds); `getMyTasks` cobrindo assigneeIds; `getSubtasks(taskId)`; `createTask`/`updateTask` com os campos novos (incl. `parentTaskId`, `blockedBy`, `reminderMinutesBefore`, `labelIds`, `assigneeIds`, `projectId`/`columnId`); `setAssignees`; `moveTaskToColumn(taskId, columnId, order?)` c/ regra 3; ordenação manual (`reorderTask`); complete/cancel/delete atualizados (delete: órfã subtarefas — limpa parentTaskId dos filhos; remove task de `blockedBy` alheios); recorrência → `recurrenceSourceId`; lembrete antecipado (regra 5); menções (regra 6, in-app via `createNotification` + e-mail); in-app `task_assigned` em atribuições; migração `migrateTasksP1` (internalMutation, batches: move parentTaskId existente → recurrenceSourceId e limpa parentTaskId — hoje TODO parentTaskId é linhagem de recorrência; backfill `assigneeIds=[assignedTo]`).

### Agente B2 — backend-services
- Novos: `convex/taskProjects.ts`, `convex/taskLabels.ts`, `convex/taskProjectsP1.test.ts`. Editar: `convex/emailTemplates.ts`, `convex/email.ts`, `convex/savedViews.ts`, `convex/notificationPreferences.ts` (expor os 2 flags novos).
- `taskProjects.ts`: CRUD projetos (create cria 3 colunas default: "A fazer", "Em andamento", "Concluído" `isDoneColumn:true`), archive/unarchive, reorder; CRUD colunas (create/update/delete/reorder; delete move tasks da coluna p/ a default; PROIBIDO deletar a última; `wipLimit`); `getProjects` (com contagem de tasks abertas), `getProject`, `getColumns(projectId)`; delete de projeto: tasks ficam sem projeto (limpa projectId/columnId/order das tasks).
- `taskLabels.ts`: CRUD + `getLabels(organizationId)`; delete remove o id de `tasks.labelIds` (varrer por `by_organization` + filtro JS é aceitável).
- E-mail: templates PT-BR `buildTaskCommentMentionTemplate` e `buildTaskDueSoonTemplate` no padrão dos existentes; wire no `buildTemplate` de `email.ts`.
- `savedViews.ts`: garantir create/update aceitando os novos filtros de task e query de listagem por `entityType:"tasks"` (seguir o padrão leads existente).

### Onda 2 (frontend, depois do backend)
- F1: `src/components/TasksPage.tsx` + novos componentes em `src/components/tasks/` de página (seletor/gestão de projetos, kanban por colunas, filtros novos, saved filters, busca server-side via `api.tasks.searchTasks`/`getTasks({search})`, deep-link `?task=<id>` abrindo o slide-over).
- F2: `src/components/CreateTaskModal.tsx`, `src/components/TaskDetailSlideOver.tsx` + pickers compartilhados em `src/components/tasks/` (LabelPicker, AssigneesPicker, ReminderSelect, seção Subtarefas, seção Dependências).
- F3: sino — `src/components/notifications/NotificationBell.tsx` + painel; montar no header do layout (`src/components/layout/`).

## Superfície de API pronta (Onda 1 CONCLUÍDA — frontend consome isto)

### tasks (B1)
- `api.tasks.getTasks` — filtros novos opcionais: `projectId`, `columnId`, `labelIds` (any-match), `assigneeId` (casa assignedTo OU assigneeIds); `sortBy: "order"` para ordem manual do kanban. Args antigos inalterados.
- `api.tasks.getMyTasks` / `getTaskCounts` — já consideram assigneeIds; `unassigned` = nenhum responsável.
- `api.tasks.getTask({taskId})` — retorna também: `assignees` (docs teamMembers), `labels` (`{_id,name,color}[]`), `project` (`{_id,name,color}|null`), `column` (`{_id,name,isDoneColumn}|null`), `subtaskProgress` (`{total,completed}`), `blockers` (`{_id,title,status}[]`). Campos antigos intactos.
- `api.tasks.getSubtasks({taskId})` → `{subtasks: EnrichedTask[], total, completed}`.
- Listagens (`getTasks`/`getMyTasks`/`searchTasks`) devolvem cada task com `assignees` + `labels` além dos antigos `assignee`/`lead`/`contact`.
- `api.tasks.createTask` — novos opcionais: `projectId`, `columnId`, `order`, `labelIds`, `assigneeIds`, `parentTaskId`, `blockedBy`, `reminderMinutesBefore`.
- `api.tasks.updateTask` — os mesmos + `assignedTo`; `projectId`/`parentTaskId`/`assignedTo` aceitam `null` para LIMPAR; arrays vazios (`labelIds: []` etc.) também limpam.
- `api.tasks.setAssignees({taskId, memberIds})`, `api.tasks.moveTaskToColumn({taskId, columnId, order?})`, `api.tasks.reorderTask({taskId, order})`.
- Deep-link canônico de task: `/app/tarefas?task=<id>` (e-mails e sino apontam para ele).

### taskProjects / taskLabels (B2)
- `api.taskProjects.getProjects({organizationId, includeArchived?})` → `Array<TaskProject & {columns: TaskColumn[], openTaskCount}>`; `getProject({projectId})`; `getColumns({projectId})` (ordenadas).
- Mutations: `createProject({organizationId,name,description?,color?})` (cria 3 colunas default), `updateProject`, `archiveProject`/`unarchiveProject`, `reorderProject`, `deleteProject`; `createColumn({projectId,name,color?,wipLimit?})`, `updateColumn({columnId,name?,color?,wipLimit?,isDoneColumn?})`, `deleteColumn` (erro se última), `reorderColumn`. Gestão = admin/manager.
- `api.taskLabels.getLabels({organizationId})`; `createLabel({organizationId,name,color})` (nome único case-insensitive), `updateLabel`, `deleteLabel`. Qualquer membro.
- `api.savedViews.*` aceita `entityType:"tasks"` + filtros de task (ver validators em `convex/savedViews.ts`).

### notifications (Onda 0)
- `api.notifications.list({organizationId, paginationOpts})` (desc), `unreadCount({organizationId})` (cap 100), `markRead({organizationId, notificationId})`, `markAllRead({organizationId})`. Doc: `{type, title, body?, taskId?, actorId?, readAt?, createdAt}`.

## Propriedade de arquivos — Onda 2 (frontend)
- **F1 (página):** `src/components/TasksPage.tsx` + novos em `src/components/tasks/` SOMENTE: `ProjectSwitcher.tsx`, `ProjectFormModal.tsx`, `ColumnsEditorModal.tsx`, `TaskKanbanBoard.tsx`, `TaskFiltersBar.tsx`, `SavedFiltersMenu.tsx`. NÃO importa componentes do F2 (filtros são autocontidos). Renderiza o `TaskDetailSlideOver` existente sem mudar as props dele; pode passar `defaultProjectId` (prop opcional nova do F2) ao CreateTaskModal.
- **F2 (modais):** `src/components/CreateTaskModal.tsx`, `src/components/TaskDetailSlideOver.tsx` + novos em `src/components/tasks/`: `LabelPicker.tsx`, `AssigneesPicker.tsx`, `ReminderSelect.tsx`, `SubtasksSection.tsx`, `DependenciesSection.tsx`. Props existentes dos dois modais permanecem retrocompatíveis; adições só como props opcionais (`defaultProjectId` no CreateTaskModal).
- **F3 (sino):** `src/components/notifications/NotificationBell.tsx` + `NotificationPanel.tsx`; montar no header em `src/components/layout/` (menor edição possível no AppShell/Header).

## Testes
- Cada agente escreve testes convex-test no SEU arquivo `*P1.test.ts` (padrão dos testes existentes; `npx vitest run convex/<arquivo>` para focar). Suíte inteira (318 na baseline) precisa continuar verde ao final — validação roda `npm run test` e `npm run lint`.
