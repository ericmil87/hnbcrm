# Tarefas (projetos, kanban, subtarefas, notificações)

> Histórico técnico movido **verbatim** do `CLAUDE.md` da raiz em 22/10/2026 (snapshot do commit 1f51a2f). Ordem = ordem de versão. Pegadinhas que mudam a forma de codar foram destiladas em `.claude/rules/`; este arquivo é a fonte completa, para ler quando se mexe nesta área.

## Estado atual

Gestor de tarefas P1 (v0.43/0.44). O follow-up que a IA executa a partir de uma tarefa está em `ai-attendant.md` (v0.60).

## Decisões, pegadinhas medidas e histórico

### Tasks (P1)

**Tasks (P1):** Full task manager beyond the original lead/contact-linked reminders. Projects/lists (`taskProjects`) each with kanban columns (`taskColumns` — done column, WIP limit informative only) and manual card ordering; org-wide labels with color (`taskLabels`); multiple assignees per task (`assigneeIds`, humans and AI — `assignedTo` always mirrors the first one for backward compatibility); real subtasks (`parentTaskId` hierarchy, with aggregated progress) plus informative dependencies (`blockedBy`, not enforced server-side); recurrence lineage moved to its own field (`recurrenceSourceId`) so it no longer collides with subtasks; per-task early reminder (`reminderMinutesBefore`) in addition to the due-date reminder; `@mentions` in task comments that actually notify; in-app notifications (`notifications` table, bell in the header) alongside existing e-mail notifications; server-side full-text search and saved filters (`savedViews` for `entityType: "tasks"`) wired into the UI. **Task↔lead linkage (v0.44):** lead chip on task rows/cards, "Lead" section in the task detail (link/change/unlink via `updateTask` — `leadId`/`contactId` accept `null` to clear, new links validated against the task's org — plus jump to the lead's conversation), Lead field in CreateTaskModal. **Deep-links:** `/app/tarefas?task=<id>` (task detail), `/app/pipeline?lead=<id>` (board switches to the lead's board and opens LeadDetailPanel; panel open/close syncs the param so browser back works), `/app/entrada?conversation=<id>` (inbox selects the conversation; only matches the loaded non-archived list). Lead panel's Tarefas tab navigates to the task deep-link. New webhook events: `task.moved`, `task.due_soon`, `task_project.*`, `task_label.*`. The REST API (`/api/v1/tasks/*`) and MCP tools were NOT extended with write params for the new fields (project/labels/assignees still create/update only through the app UI) — GET responses do include the new raw document fields. Key files: `convex/taskProjects.ts`, `convex/taskLabels.ts`, `convex/notifications.ts`, `convex/lib/notify.ts`, `src/components/tasks/`, `src/components/notifications/`.


## Notas vindas de convex/CLAUDE.md (22/10/2026)

Trechos movidos literalmente do `convex/CLAUDE.md` ao enxugá-lo (identificadores que não existiam em nenhum outro lugar).

- `tasks.ts` — Task CRUD (projects/columns, labels, multi-assignee `assigneeIds`, real subtasks via `parentTaskId` + `getSubtasks`, informative `blockedBy` deps, manual kanban order, pre-due reminders, recurrence via `recurrenceSourceId`); `updateTask` aceita `null` p/ limpar `projectId`/`parentTaskId`/`assignedTo`/`leadId`/`contactId` (vínculos novos validados contra a org da task); `internal*` variants power the REST API + MCP (write params unchanged by P1; todas escopadas por org da API key — see `router.ts`); todo escritor de prazo/estado/responsável chama `syncFollowUpForTask` (v0.60 — mantém `aiFollowUps` casado com a tarefa) e `deleteTask`/`internalDeleteTask`/bulk deletes chamam `resolveFollowUpForDeletedTask` ANTES do delete; recorrência recusa tarefa com follow-up de IA ativo; `internalGetTask` (REST `GET /api/v1/tasks/get` + MCP `crm_get_task`) devolve `aiFollowUp` (resumo do estado)
- `taskComments.ts` — Task comments, `authorType` human\|ai, `@mention` → in-app + e-mail notification via `lib/notify.ts`; núcleo em `lib/taskOps.ts:addTaskCommentCore`
- `notifications.ts` — In-app notifications: list/unreadCount/markRead/markAllRead (bell in `AppShell`); tipos de tarefa + `handoff_requested`/`handoff_resolved`/`ai_draft_pending`/`ai_followup_needs_human` (v0.60 — a IA não conseguiu executar um follow-up que ela mesma agendou), com ponteiros `handoffId`/`conversationId`/`taskId` p/ o deep-link do item
