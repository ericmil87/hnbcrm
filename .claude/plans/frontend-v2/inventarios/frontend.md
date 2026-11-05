# Inventário do frontend do HNBCRM (HEAD 41ce687, v0.78.1)

Fonte: checkout limpo `$W` = `/tmp/claude-1000/-home-eric-projects-ClawCRM-clawcrm-repo/c2ebc17d-081d-4ead-a819-3f659d9babd0/scratchpad/head`. Todos os caminhos abaixo são relativos a `$W`. Somente leitura. Contagens por `grep`/script sobre `src/`; onde for heurística, está dito.

Números gerais: ~87,7 mil linhas em `src/` (sem testes), 26 arquivos de teste, 22 primitivos em `src/components/ui/`, 10 hooks, 53 módulos em `src/lib/`.

---

## 1. Rotas e shell

### 1.1 Rotas (`src/main.tsx:46-86`)

Router `createBrowserRouter`. Públicas (eager, exceto onde indicado):

| Path | Componente | Obs. |
|---|---|---|
| `/` | `LandingPage` | eager (911 linhas) |
| `/developers` | `pages/DevelopersPage` | eager (1486 linhas + `lib/apiRegistry.ts` 1398) |
| `/developers/playground` | `pages/PlaygroundPage` | eager |
| `/entrar` | `AuthPage` | eager |
| `/termos`, `/privacidade` | `TermsPage`, `PrivacyPage` | lazy |
| `/f/:formSlug` | `PublicFormPage` | lazy |

Autenticadas: `/app` → `layout/AuthLayout` (eager, 530 linhas) com `<Outlet>`; todos os filhos lazy via `LazyRoute`:

| Path | Componente | Aba (`lib/routes.ts`) |
|---|---|---|
| `/app` (index) | `Navigate` → `painel` | |
| `/app/painel` | `DashboardOverview` | dashboard |
| `/app/pipeline` | `KanbanBoard` | board |
| `/app/contatos` | `ContactsPage` | contacts |
| `/app/entrada` | `Inbox` | inbox |
| `/app/tarefas` | `TasksPage` | tasks |
| `/app/calendario` | `calendar/CalendarPage` | calendar |
| `/app/repasses` | `HandoffQueue` | handoffs |
| `/app/equipe` | `TeamPage` | team |
| `/app/auditoria` | `AuditLogs` | audit |
| `/app/formularios` | `forms/FormListPage` | forms |
| `/app/formularios/:formId` | `FormBuilderPage` | (sem aba) |
| `/app/formularios/:formId/submissoes` | `FormSubmissionsPage` | (sem aba) |
| `/app/formularios/:formId/analytics` | `FormAnalyticsPage` | (sem aba) |
| `/app/formularios/:formId/experimento/:experimentId` | `FormExperimentPage` | (sem aba) |
| `/app/campanhas` | `CampaignsPage` | campaigns |
| `/app/grupos` | `groups/GroupsPage` | groups |
| `/app/central` | `central/CentralPage` | central |
| `/app/configuracoes` | `Settings` | settings |

Não há rota 404 (nenhum `path: "*"`), nem `errorElement` no router. `ErrorBoundary` só envolve o `<Outlet>` em `AuthLayout.tsx:~410` (com `resetKey={location.pathname}`). Toaster fixo `theme="dark"` (`main.tsx:93`).

### 1.2 Navegação

`lib/routes.ts` (22 linhas): `TAB_ROUTES: Record<Tab, string>` e `PATH_TO_TAB` (derivado, **match exato por pathname**). O tipo `Tab` vive em `components/layout/BottomTabBar.tsx` (lib importa de componente).

**Sidebar desktop** (`layout/Sidebar.tsx:36-51`), na ordem, com filtro por permissão e módulo:

| # | Item | Permissão | Módulo |
|---|---|---|---|
| 1 | Painel | nenhuma | |
| 2 | Central | reports:view | `central` |
| 3 | Pipeline | leads:view_own | |
| 4 | Contatos | contacts:view | |
| 5 | Caixa de Entrada | inbox:view_own | |
| 6 | Repasses | inbox:view_own | |
| 7 | Tarefas | tasks:view_own | |
| 8 | Calendário | tasks:view_own | |
| 9 | Equipe | team:view | |
| 10 | Auditoria | auditLogs:view | |
| 11 | Formulários | settings:manage | |
| 12 | Campanhas | campaigns:view | |
| 13 | Grupos | inbox:view_own | |
| 14 | Configurações | settings:view | |

14 itens planos, sem agrupamento nem separadores. Badges reativos: Entrada (`getInboxUnreadCount`), Repasses (`getPendingHandoffCount`), Campanhas (`getPausedCount`). Rodapé: `OrgSwitcherTrigger` + Sair. Largura `w-16 lg:w-56` (colapsa a ícones em `md`).

**BottomTabBar mobile** (`layout/BottomTabBar.tsx:43-61`): 5 abas primárias (Painel, Pipeline, **Calendário**, Entrada, Tarefas) + botão "Mais" que abre sheet com 9 itens (Central, Contatos, Repasses, Equipe, Auditoria, Formulários, Campanhas, Grupos, Configurações) + troca de org + sair. A lista de itens está **duplicada** entre Sidebar e BottomTabBar (`NavItem` declarado nos dois, com permissões repetidas). Ordem e rótulos divergem: "Caixa de Entrada" (Sidebar) vs "Entrada" (BottomTabBar); Calendário é primária no mobile e 8º no desktop; Contatos fica no "Mais".

### 1.3 Layout (`layout/AppShell.tsx`, 84 linhas)

- Desktop: `Sidebar` fixa (`fixed left-0`, `hidden md:flex`), `<main className="md:ml-16 lg:ml-56">`.
- Header sticky (`h-14 md:h-16`): no mobile mostra a org atual (botão do `OrgSwitcher`), no desktop só o `NotificationBell` à direita. Não há título de página nem breadcrumbs.
- Conteúdo: `<div className="p-4 md:p-6">{children}</div>` com `pb-20 md:pb-0` (espaço da tab bar). Largura não limitada (sem `max-w`), cada página decide.
- Mobile: `BottomTabBar` fixa.
- **Copiloto**: montado no próprio `AppShell` (`AppShell.tsx:66-80`) só quando `aiSettings.getAiStatus` devolve `active && copilotEnabled`: `CopilotFab` (arrastável, posição em localStorage, `lib/fabPosition.ts`) + `CopilotPanel`. Estado `copilotOpen` local (não vai para a URL).
- `AuthLayout` (530 linhas) concentra: gate de auth, seleção/troca de org (localStorage), aviso de convites, onboarding wizard, troca de senha obrigatória, e **toda a resolução de deep-link de entidade** (`?task=`, `?lead=`, `?conversation=`, `?handoff=` → descobre a org do item, troca de org, ~linhas 220-300). Monta `AppShell` com `key={activeOrgId}` (remonta tudo ao trocar org).

### 1.4 Navegação em Configurações (`?secao=`)

`Settings.tsx:32-42`: 10 seções (`general, ai, apikeys, fields, sources, webhooks, channels, data, notifications, central`), renderizadas como "pills" `flex-wrap` (sem scroll, quebram em várias linhas no mobile). `central` só aparece com `settings:manage` ou algum módulo ligado. Estado: `useState` inicializado do `?secao=` + efeito que re-sincroniza se o param **mudar** (`Settings.tsx:53-67`). **Clicar numa pill NÃO escreve a URL** (só `setActiveSection`): refresh/back/compartilhar volta para a seção do param original ou "Geral". Quem escreve o param são deep-links externos: `DashboardOverview.tsx:202` (`data`), `GroupPostsTab.tsx:333` (`ai`), `GroupsPage.tsx:166` (`channels`), `NotificationPanel.tsx:145,172` (`channels`, `ai`), `CentralPage.tsx:100` (`central`), `ChannelsSection.tsx:186` (retorno OAuth Meta: `?secao=channels&meta=…&pendente=…`).

### 1.5 Inconsistências observadas

- **Sub-rotas sem item ativo**: `PATH_TO_TAB[location.pathname]` é match exato, então `/app/formularios/:id[/…]` deixa a sidebar e a tab bar sem item ativo (e "Mais" sem destaque).
- **Calendário ignora a URL**: `UpcomingEventsWidget.tsx:220` navega para `/app/calendario?date=…&event=…`, mas `calendar/CalendarPage.tsx` e `useCalendarState.ts` não leem `searchParams` (grep vazio). O link cai na visão "day" de hoje (`useState<CalendarView>("day")`, `new Date()`).
- **Painéis só por deep-link ou por clique interno**: grupos de formulário (`/formularios/:formId/*`) só chegam pela lista; `?nova=` (Inbox), `?novo=1&source=&groupChatId=&phones=` (Campanhas) são portas de entrada de outras telas sem entrada própria no menu.
- **Páginas públicas `/developers`, `/developers/playground`** não têm link dentro do app (só da Landing).
- **Gating por módulo**: apenas "Central" é módulo-gated na nav (`module: "central"`); Settings/Central usa regra própria (`manage || anyEnabled`). Módulo `metaMessaging` altera cards em Canais mas não a nav. `units/departments/attribution` aparecem em Inbox/Lead/Kanban por flags.
- **Gating por permissão divergente do rótulo**: "Formulários" exige `settings:manage`; "Grupos" e "Repasses" reusam `inbox:view_own`; "Calendário" reusa `tasks:view_own`.
- `components/Dashboard.tsx` (8 linhas) é um stub legado "Legacy component" sem uso (grep: nenhum import).
- Tema: `src/index.css` define `:root` dark e override `.light`, mas **nenhum código aplica a classe `light`** nem há alternador de tema (grep por `"light"`/`classList` só acha embed e WhatsAppPreview). `Toaster theme="dark"` fixo.

---

## 2. Estrutura de código

### 2.1 Arquivos > 800 linhas e responsabilidades misturadas

Entre parênteses: contagem de `useState` / `useQuery` / `useMutation|useAction` / `useEffect`.

**`components/settings/AiSection.tsx` (3309)**
- 48-85 `Switch` local (role=switch); 87-93 `PERSONAS`; 95-124 `AiSection` (orquestra 6 cards); 126-155 tipo `AiStatus`.
- 157-362 wizard de ativação 1-fluxo (`ActivationWizardCard`, `ActivationWizardModal`).
- 343-514 seletores de roteamento de modelo (`RoutingSelect*`, `RouteNote`, `ProductRow`).
- 516-813 `FeatureTogglesCard` (Copiloto, Atendente, Ler imagens, IA em grupos, Copiloto Telegram).
- 815-931 `BridgeAiCard`; 933-1081 `ActivationCard` (LGPD ack).
- 1083-1173 `AttendantCard`; 1175-1325 helpers de validação (`FieldGroup`, `WarningNote`, `read*`/`*Warning`, constantes de follow-up).
- 1326-1366 `FollowUpModeCard`; **1368-2463 `AttendantConfig` (~1100 linhas)**: persona, horário, comportamento da conversa, follow-ups, repasse, opções avançadas (`CollapsibleSection` na 2243).
- 2465-2695 `SimulatorModal` (simulador de conversa); 2697-2994 `UsageCard` (uso/custo); 2996-3309 `PrivacyCard` (provider/BYO).

**`components/Inbox.tsx` (3103)** — um único componente `Inbox()` de 186 a 3043 (~2850 linhas): 40 `useState`, 19 `useQuery`, 16 mutations/actions, 13 `useEffect`.
- 186-340 estado/URL/filtros persistidos em localStorage (conversa, nova, arquivadas, etiqueta, direto/grupo, canal/conta).
- 339-470 paginação da lista e do thread (lotes 50→500), scroll infinito.
- 480-625 agendamento de mensagem, respostas rápidas, auto-scroll/âncora da thread.
- 676-790 modo grupo (v0.57): menções, nomes por JID.
- 790-1056 funil do lead, repasse pendente, aceitar, suspeita de bot, parar de monitorar/sair do grupo.
- 1057-1260 presença/typing, markread, envio (`handleSendMessage`, voz, reação, transcrever, descrever imagem, baixar mídia).
- 1271-1490 salto para resultado de busca, sincronia URL↔estado (`?conversation=`), rascunho vindo de `location.state`, nova conversa.
- 1490-1711 seleção múltipla/lote.
- 1712-2314 JSX da lista de conversas; 2315-2904 JSX do thread + composer; 2905-3043 painéis sobrepostos (lead, contato, membros, resumo). 3044 `ScheduledPendingRow`.
- Já extraídos em `components/inbox/` (30 arquivos, 6053 linhas): `MessageBubble` (704), `AiDraftCard` (609), `NewConversationModal` (760), `GroupMembersPanel`, `QuickReplies`, `VoiceRecorder`…; a lista de conversas e o composer **não** foram extraídos.

**`components/LeadDetailPanel.tsx` (2259)** (38/17/16/9)
- 101-176 shell + abas (`activeTab` em `useState`, `initialTab`); 177-301 `LeadActionsMenu`.
- **302-975 `ConversationTab`**: reimplementa o thread/composer do Inbox (comentário "Paridade com o Inbox", linhas 318, 372, 461, 491, 532-570): markread, presença nossa e do contato, janela de serviço, auto-scroll, scroll infinito no topo, respostas rápidas, emoji. Mesmos termos em ambos: `composing` 4/4, `markConversationRead` 4/3, `handleLoadOlder` 3/3, `useInfiniteSentinel` 3/2, `QuickReplies` 3/3, `serviceWindow` 6/5. Só o Inbox tem `VoiceRecorder` e agendamento.
- 976-1079 `BantInfoTooltip`/`BantInfoContent`; 1080-1335 editor de campos personalizados.
- **1336-2024 `DetailsTab` (~690 linhas)**: contato, responsável, etapa, campos editáveis, personalizados, BANT, documentos, cada um com seu picker/estado.
- 2025-2186 `TasksTab`; 2187-2259 `ActivityTab`.

**`components/settings/ChannelsSection.tsx` (1985)**
- 112-158 helpers de badge; 159-590 `ChannelsSection` (lista, criação, Meta OAuth return, handlers); 592-883 `ChannelCard` (inclui o toggle de transcrição automática, ~linha 750-775); 884-1127 `BridgeHistoryPanel`; 1128-1353 `BridgeQrModal`; 1354-1414 `ChannelFormModal`; 1415-1490 `ProviderChooser`; 1491-1685 `MetaForm`; 1686-1985 `BridgeForm`.
- Montados a partir daqui: `ChannelHealthPanel`, `MetaMessagingCard`, `MetaChannelCards`, `BridgeGroupsPanel` (687 linhas; embute `GroupMediaDefaultsSection`).

**`components/KanbanBoard.tsx` (1787)** (39/9/15/4)
- 92-123 helpers de label/variante; 125-337 card, draggable, droppable; 338-414 `QuickAddForm`; 415-563 `StageEditPopover` (posiciona com `window.innerWidth/innerHeight`, linhas 450-451); 564-650 `AddStageColumn`; 651-669 deep-link resolver.
- 670-1787 `KanbanBoard()` (~1100 linhas): busca/filtros (699), modo Kanban/Lista + seleção (710, 909), DnD sensors (781), board inicial via param/localStorage (791-806), `?lead=` (807-844), filtros client-side (845), ordenação (886), ações em lote (934), e ~12 modais/diálogos montados no fim (1583-1771: criar board, editar, gerir etapas, arquivar, excluir, motivo de fechamento…).

**`components/TaskDetailSlideOver.tsx` (1600)** (23/10/14/3)
- 90-118 `detectMentionTrigger`; 119-1403 componente (~1280 linhas): navegação interna com pilha (127), follow-up IA (146, 179), @menção em comentário (152, 570-600), seletor de lead (194), "Executar agora" (422); JSX: barra de ações (665), snooze (759), título/badges (808), follow-up IA (898), campos (914-1079), responsáveis, labels, lembrete, descrição (1110), checklist (1145), subtarefas, dependências, comentários (1242-1361), metadados (1362).
- 1404 `FieldRow`; 1437 `FollowUpCard`.
- **Existe um segundo `TaskDetailSlideOver`** em `components/calendar/TaskDetailSlideOver.tsx` (284 linhas) com o mesmo nome, importado por `calendar/CalendarPage.tsx`; o grande é importado por `TasksPage.tsx`.

**`pages/DevelopersPage.tsx` (1486)**: página pública de docs (conteúdo estático + `lib/apiRegistry.ts` 1398 linhas de dados). Carregada eager em `main.tsx`.

**`components/TasksPage.tsx` (1297)**: `TasksPage()` 88-746 (~660 linhas: filtros, smart pills, vista lista/status, `?task=`), `SmartPill`, `ListView`, `TaskGroup`, `TaskRow` (896-1043), `StatusBoardView/Column/DraggableStatusCard/StatusCard` (1044-1288) — duplica parte de `tasks/TaskKanbanBoard.tsx` (760).

**`components/forms/FormSubmissionsPage.tsx` (1261)**: helpers de formatação e `exportToCsv` (77-251), `SubmissionRow` (252), `SubmissionCard` (463), página (615-1253, ~640 linhas).

**`components/settings/CentralSection.tsx` (1190)**: `Switch` exportado (116), `ModulesCard`, `ColorField`, `UnitsCard`+`UnitModal`, `DepartmentsCard`+`DepartmentModal`, `AdSpendCard`+`AdSpendModal`+`PasteCsvModal` (parse de CSV).

**`components/settings/ImportWizard.tsx` (1164)**: utilitários de download exportados (131-170, usados por `DataSection`), `StepTrail`, 5 passos (`StepFile` 593, `StepMapping` 722, `StepPreview` 892, `StepRunning` 1048, `StepResult` 1088), `ImportProgressBar`.

**`components/ContactDetailPanel.tsx` (1002)**: painel 95-702 (9 `CollapsibleSection`, aba `info|leads|groups` em `useState`), `LinkedLeadCard`, `ViewField`/`EditField`, `ContactOptOutControl`, `ContactGroupsTab`.

**`components/Settings.tsx` (945)**: shell de abas (48-115) + 5 seções inline: `OrgProfileSection` 118-241, `ApiKeysSection` 242-442, `CustomFieldsSection` 443-647, `LeadSourcesSection` 648-785, `WebhooksSection` 786-945. As quatro últimas repetem o padrão lista + formulário inline + `ConfirmDialog` de exclusão (`showForm`/`editingId`/`form`/`confirmDeleteId`).

**Outros 800+**: `components/LandingPage.tsx` (911, pública, eager) e `components/forms/FormExperimentPage.tsx` (929), `campaigns/steps/StepAudience.tsx` (940).
Entre 700 e 800: `FormBuilderPage` 834, `GroupAudienceTabs` 789, `StepMessage` 771, `DashboardOverview` 769, `AuditLogs` 763, `TaskKanbanBoard` 760, `NewConversationModal` 760.

### 2.2 Padrões duplicados (candidatos a primitivo)

Contagens por grep em `src/`:

| Padrão | Ocorrências | Onde |
|---|---|---|
| Switch/Toggle reimplementado | **7 funções** (`Switch` em `settings/AiSection.tsx:48`, `settings/CentralSection.tsx:116` (exportada), `ToggleSwitch` em `forms/builder/{FieldConfigPanel:76, FormSettingsPanel:27, ConditionalLogicEditor:48, StepManager:35, ThemePanel:33}`) + 12 arquivos com `role="switch"` inline (`ChannelsSection` ×3, `InviteMemberModal` ×3, `BridgeGroupsPanel` ×2, `MemberDetailSlideOver`, `NotificationPreferences`) | |
| `<select>` nativo cru | 111 usos, 36+ arquivos; classes repetidas em `StepContent.tsx:26` (`SELECT_CLASS`), `TaskFiltersBar.tsx:60`, `CentralPage.tsx:31`, `AiSection.tsx:3018` (`SELECT_CLS`), `ConditionalLogicEditor.tsx:138`, `ContactDetailPanel.tsx:840` | maiores: `AiSection` 14, `CreateViewModal` 7, `StepAudience` 7, `Settings` 6 |
| `<textarea>` cru | 36 | |
| `<input>` cru vs `Input` | 184 `<input` vs 115 `<Input` | |
| `<button>` cru vs `Button` | 523 vs 396 | |
| `type="checkbox"` cru vs `Checkbox` | 11 vs 54 | |
| Abas/segmented | **0 `role="tab"`/`tablist`**, 1 `aria-selected` (só em `MentionTextarea`). Abas ad-hoc: `Settings.tsx:85-100` (pills), `LeadDetailPanel.tsx:102`, `ContactDetailPanel.tsx:97`, `PublishDialog.tsx:104`, `FormAnalyticsPage.tsx:306`, `Settings.tsx:447` (`entityTab`), `CentralPage` e `GroupsPage` (`?aba=`), `GroupAudienceTabs`; ~15 usos de `border-b-2` | |
| Cabeçalho de página | **sem componente**: cada página escreve o seu `<h2 className="text-2xl font-bold …">` (Settings, TeamPage, passos do onboarding, calendar slide-overs…); só 5 arquivos acham o padrão `h2 text-(xl|2xl) font-bold`, os demais variam | |
| Cabeçalho de card/seção | 46 ocorrências de `text-lg font-semibold text-text-primary` (maioria `<h3>` de cards em Settings/AI/Canais/Telegram/Notificações) | |
| Barra "Salvar" / formulário com `saving` | 23 `setSaving(true)` manuais; ~5 botões "Salvar" literais; sem `FormField`/`FormActions` | |
| Label + helper + erro de campo | `Input` tem `label/error/icon`; `select`/`textarea` não têm wrapper equivalente (labels `text-[13px] font-medium text-text-secondary mb-1.5` copiadas à mão, ex. `AiSection.tsx:2247`) | |
| Menu/popover/dropdown | ad-hoc: `ConversationActionsMenu`, `LeadActionsMenu` (`LeadDetailPanel:177`), `ViewSelector`, `ProjectSwitcher` (posiciona com `window.innerWidth`), `StageEditPopover`, `SavedFiltersMenu`, `AssigneesPicker`, `LabelPicker`, `QuickReplies`, `ReactionPicker`, `EmojiPickerButton` | |
| Stepper/wizard | `ImportWizard.StepTrail`, `WizardStepIndicator`, `campaigns/CampaignWizard`, `groups/posts/GroupPostWizard`, `StepManager` (forms) — 4 implementações de indicador de passos | |
| Formatação de datas/valores | 111 `toLocaleString/DateString/TimeString/Intl`; 22 funções `formatDate/DateTime/RelativeDate/timeAgo/Time/Currency/BRL/Count/Phone` espalhadas (ex.: `formatRelativeDate` em `ContactDetailPanel:703`, `UpcomingTasksWidget:540`, `FormListPage:38`, `TaskKanbanBoard:156`; `formatBRL` em `centralFormat.ts:19` e `inbox/central/centralMeta.ts:126`; `formatCurrency` em `DashboardOverview:765` e `leads/LeadsListView:79`) | |
| Slide-overs de detalhe | `TaskDetailSlideOver` ×2, `EventDetailSlideOver`, `MemberDetailSlideOver`, `HandoffPeekSlideOver` com cabeçalho/barra de ações próprios | |
| Thread de mensagens + composer | Inbox × `LeadDetailPanel.ConversationTab` (ver 2.1) | |

### 2.3 Onde mora o estado (URL × local)

**Usam `useSearchParams` (11 arquivos):** `Inbox` (`conversation`, `nova`), `KanbanBoard` (`board`, `lead`), `TasksPage` (`task`), `HandoffQueue` (`handoff`), `CampaignsPage` (`campanha`, `novo`, `source`, `groupChatId`, `phones`), `GroupsPage` (`aba`, `post`), `GroupPostsTab` (`post`), `CentralPage` (`aba`), `Settings` (`secao`, só leitura), `ChannelsSection` (`meta`, `pendente`, `state`), `PlaygroundPage` (`endpoint`).

**Estado de tela que NÃO está na URL (violam "URL é fonte da verdade", ou ao menos não restauram em refresh/back):**
- `Settings.tsx:56` seção ativa (clique não escreve `?secao=`).
- `LeadDetailPanel.tsx:102` aba ativa; `ContactDetailPanel.tsx:97` aba (`info|leads|groups`); `ContactsPage.tsx:51` `selectedContactId` (**o contato aberto não vai para a URL**, ao contrário de lead/tarefa/conversa), busca (49), colunas (72, local), página (141).
- `calendar/useCalendarState.ts:6-7` visão (`day|week|month`) e data (veja 1.5), `CalendarEventModal`, `EventDetailSlideOver`.
- `AuditLogs.tsx:40-50` 7 filtros + `expandedLogId` + `cursorStack`; `TeamPage.tsx:69-71` busca/membro selecionado; `CampaignsPage.tsx:49-50` filtros de status/provider; `TasksPage.tsx:99-103` `viewMode`, `smartFilter`, `filters` (apenas `?task=` está na URL); `KanbanBoard` modo Kanban/Lista e filtros (699-730).
- `AppShell.tsx` `copilotOpen` e `showMore` locais.
- localStorage como persistência de preferência (try/catch conforme regra): `Inbox` (filtro direto/grupo, canal/conta), `KanbanBoard` (último board por org), `ContactsPage` (colunas), `CopilotFab`, `AuthLayout` (org ativa, orgs conhecidas), `EmojiPickerButton`, `lib/channelAccounts.ts`, `hooks/useCopilotStream.ts`, `lib/abTesting.ts`, `developers/*`, `embed/loader.ts`.
- Deep-links com ressalva: `Inbox` documenta uma janela de corrida URL↔estado (`Inbox.tsx:1347-1378`, `setSearchParams` assíncrono) tratada com refs; `AuthLayout` resolve a org do item por `resolveEntityOrg`.

---

## 3. Configurações (`components/Settings.tsx` + `components/settings/*`)

Profundidade = cliques a partir do shell autenticado (Sidebar/"Mais" → Configurações = 1; no mobile, "Mais" → Configurações = 2).

| Seção (pill) | Componente | Conteúdo | 
|---|---|---|
| Geral | `Settings.tsx:OrgProfileSection` | nome, fuso, moeda, país padrão |
| IA | `settings/AiSection.tsx` | ver detalhe abaixo |
| Chaves API | `Settings.tsx:ApiKeysSection` + `ui/ApiKeyRevealModal` | |
| Campos Personalizados | `Settings.tsx:CustomFieldsSection` | abas lead/contato |
| Fontes de Leads | `Settings.tsx:LeadSourcesSection` | |
| Webhooks | `Settings.tsx:WebhooksSection` | |
| Canais | `settings/ChannelsSection.tsx` | WhatsApp Cloud/bridge, Instagram/Messenger (`MetaMessagingCard`, `MetaChannelCards`), saúde (`ChannelHealthPanel`), histórico e grupos do bridge |
| Dados | `settings/DataSection.tsx` (595) | exportar/importar (`ImportWizard`) |
| Notificações | `notifications/NotificationPreferences.tsx` | e-mail + `TelegramCard` (567 linhas, QR do Telegram) |
| Central | `settings/CentralSection.tsx` | módulos opcionais, unidades, departamentos, investimento em anúncios |

Sub-painéis dentro de IA (ordem de render quando ativa e com atendente, `AiSection.tsx:112-122`): `ActivationCard` (LGPD) → `FeatureTogglesCard` → `BridgeAiCard` → `AttendantCard` → `UsageCard` → `PrivacyCard`. Antes disso (IA inativa ou sem atendente) a seção mostra só `ActivationWizardCard`. Outros painéis relacionados mas fora de `settings/`: `ExternalAgendaSection` (dentro do atendente, `AiSection.tsx:2240`), `GroupMediaDefaultsSection` (dentro de `BridgeGroupsPanel`, que está dentro do `ChannelCard` de um bridge).

Como achar cada pedido típico (caminho observado no código):

| O usuário procura | Caminho | Cliques (desktop) |
|---|---|---|
| Transcrição de áudio (automática) | Configurações → Canais → card do canal (toggle "Transcrever áudios automaticamente", `ChannelsSection.tsx:757-775`; só `settings:manage`) | 3. É **por canal**, não na seção IA. Transcrição por mensagem fica no Inbox (`Inbox.tsx:1214 handleTranscribe`). Atendente que "ouve" voice notes não tem toggle próprio visível em `AiSection` (grep de "transcri" só acha o simulador, 2436-2546) |
| Visão / ler imagens | Configurações → IA → "Produtos de IA" (`FeatureTogglesCard`, "Ler imagens recebidas", `AiSection.tsx:680`) + modelo em `RoutingSelect` | 2-3 (só com IA ativa e atendente; senão cai no wizard) |
| Persona do atendente | Configurações → IA → card "Atendente virtual" → botão que abre `showCustomize` (`AiSection.tsx:1381, 1717`) → bloco "Persona" (1849) | 3-4 |
| Horário, comportamento, repasse, follow-up, opções avançadas, agenda externa | idem, blocos de `AttendantConfig` (1884, 1918, 2064, 2226, 2243 + 2240) | 3-4 (dentro de bloco gigante de ~1100 linhas) |
| QR do bridge (WhatsApp) | Configurações → Canais → card do canal bridge → botão que abre `BridgeQrModal` (`ChannelsSection.tsx:1128`) | 3 (+ modal) |
| Notificações | Configurações → Notificações (e-mail + Telegram); sino do header abre `NotificationPanel` (lista, não preferências) | 2 |
| Simulador do atendente | Configurações → IA → Atendente → `SimulatorModal` (2465) | 4 |
| Uso/custo de IA, provider/BYO | Configurações → IA → `UsageCard` / `PrivacyCard` (final da página longa) | 2 + rolagem |
| Copiloto no Telegram | toggle em IA → Produtos (`AiSection.tsx:781`) + vínculo em Notificações → `TelegramCard` | 2 seções distintas |
| Importar/exportar | Configurações → Dados | 2 |
| Módulos (Central) | Configurações → Central | 2 |

Observações: não há busca em Configurações; as pills não agrupam por tema (conta × canais × IA × desenvolvedor); `AiSection` e `ChannelsSection` são páginas longas sem sumário/âncoras; vários toggles de IA/canal estão espalhados (IA: produtos; Canais: transcrição por canal, IA no bridge em `BridgeAiCard`; Grupos: política de IA/mídia no `GroupsPage` e em `BridgeGroupsPanel`).

---

## 4. Primitivos de UI (`src/components/ui/`, 22 arquivos)

| Arquivo | Props principais |
|---|---|
| `Button.tsx` | `variant`: primary, secondary, ghost, dark, danger; `size`: sm (h-8), md (h-10), lg (h-12); `forwardRef`, sem prop `loading` |
| `Badge.tsx` | `variant`: default, brand, success, error, warning, info |
| `Card.tsx` | `variant`: default, sunken, interactive |
| `Input.tsx` | `label`, `error`, `icon` (+ atributos de input) |
| `Checkbox.tsx` | `label`, `description` |
| `Modal.tsx` | `open`, `onClose`, `title?`, `className`; portal, bottom-sheet no mobile |
| `SlideOver.tsx` | `open`, `onClose`, `title?`, `titleIcon`, `headerActions`, `className`, `bodyClassName` |
| `ConfirmDialog.tsx` | `open`, `onClose`, `title`, `description?`, `variant`: danger/default, textos de botão |
| `CollapsibleSection.tsx` | `title`, `defaultOpen`, `filledCount`, `totalCount` (usado em 10 lugares: `ContactDetailPanel` ×9, `AiSection` ×1) |
| `EmptyState.tsx` | `icon`, `title`, `description?`, `action {label,onClick}` |
| `Pagination.tsx` | anterior/próximo |
| `Skeleton.tsx` | `variant`: text, circle, card |
| `Spinner.tsx` | `size` |
| `Avatar.tsx` | `name`, `type` (human/ai), `size`, `status`, `imageUrl` |
| `AvatarUpload.tsx`, `FileDropZone.tsx`, `FileUploadButton.tsx`, `AttachmentPreview.tsx` | upload/preview |
| `Markdown.tsx` (+ `CopyButton`), `MentionRenderer.tsx`, `MentionTextarea.tsx` | texto rico |
| `ApiKeyRevealModal.tsx` | específico de domínio |

**Sem primitivo (e com implementações ad-hoc verificadas por grep):**

| Necessidade | Evidência |
|---|---|
| Switch/Toggle | 7 funções próprias + 12 arquivos `role="switch"` inline (seção 2.2) |
| Select | 111 `<select>` nativos com classes copiadas (5+ constantes `selectClass`) |
| Tabs / SegmentedControl / pills | 0 `role="tab"`; ao menos 8 implementações (2.2); Settings usa pills sem `aria-selected` |
| FormField (label + hint + erro) para select/textarea | só `Input` tem; 36 `<textarea>` sem wrapper |
| PageHeader (título + descrição + ações) | cada página escreve o seu |
| SectionCard/CardHeader (ícone + título + descrição + ação) | 46 `h3 text-lg font-semibold` repetidos |
| Stepper | 4 implementações |
| Tooltip | 322 usos de `title=` nativo; tooltip custom só em `BantInfoTooltip` (`LeadDetailPanel:976`) e `SpotlightTooltip` (onboarding) |
| Popover/Menu/Dropdown | ≥10 implementações (2.2), posicionamento com `window.innerWidth/innerHeight` em `KanbanBoard:450` e `ProjectSwitcher:84` |
| Button com `loading`/`icon-only` | `Button` não tem; `saving` manual em 23 lugares |
| DatePicker/DateTime | `<input type="datetime-local">` nativo |
| Toast | `sonner` (ok) |
| Drawer/Sheet de filtros no mobile | não há |
| `SearchInput` | ad-hoc em ContactsPage, TeamPage, Inbox, TaskFiltersBar |

---

## 5. Hooks e `src/lib`

### 5.1 `src/hooks/` (10)

`useCopilotStream.ts` (194), `useDebouncedValue.ts` (11), `useInboxChannelAccounts.ts` (25), `useInfiniteSentinel.ts` (85), `useInView.ts` (26), `useKeepPrevious.ts` (18), `useOrgModules.ts` (+ teste), `usePermissions.ts` (64), `useRoundedNow.ts` (27). Mais hooks locais fora da pasta: `calendar/useCalendarState.ts`, `useDepartments` em `settings/CentralSection.tsx:512`, `developers/PlaygroundConfigProvider.tsx`. Há debounce manual duplicado: `Inbox.tsx:308`, `ContactsPage.tsx:50` (`debouncedSearch`) em vez de `useDebouncedValue`.

### 5.2 `src/lib/` (53 módulos)

Lógica de domínio já testada: `aiStateReasons`, `bridgeSpecialMessage`, `channelAccounts`, `channelCapabilities`, `contactName`, `defaultCountry`, `fabPosition`, `followUp`, `groupMedia`, `groupMentionFilter`, `inboxPaging`, `infiniteScroll`, `markdown` (573), `messageTime`, `metaConnect`, `metaSpecialMessage`, `orgSwitch`, `roundedNow`, `serviceWindow`, `teamMembers`, `telegramLink`, `whatsappFormat`.
Sem teste: `abTesting`, `apiRegistry` (dados), `auditUtils` (157), `celebrations`, `errors`, `groupDisplay` (117), `mentions` (102), `onboardingTemplates` (170), `routes`, `utils`, `utmPersistence` (105).

### 5.3 Lógica pura dentro de componentes (candidata a `src/lib` + teste)

- `components/campaigns/campaignUtils.ts` (formatação, `formatPhone`, XLSX→CSV) e `components/groups/posts/postUtils.ts`, `components/campaigns/wizardState.ts`, `groups/posts/wizardState.ts`, `central/centralFormat.ts`, `inbox/central/centralMeta.ts`: já são módulos puros, mas moram em `components/`; só `adSpendCsv`, `centralMeta` e `inbox/types` têm teste.
- `settings/AiSection.tsx:1220-1325`: `readDebounceSeconds`, `debounceWarning`, `readReplyLimit`, `replyLimitWarning`, `readFollowUp*` e constantes (validação/limites) — sem teste, dentro do componente; `formatBrlApprox/formatUsd/parseDecimal` (2716-2729).
- `settings/ImportWizard.tsx`: `stepFromStatus`, `importStatusMeta`, `formatCount`, `formatPreviewValue`, `isEmptyPreviewValue`, `saveBlob/downloadFromUrl` (131-270); importados por `DataSection`.
- `forms/FormSubmissionsPage.tsx:77-251`: `extractNameAndEmail`, `statusConfig`, `timeAgo`, `exportToCsv` (parte já tem CSV injection no backend; o export do front não tem teste).
- `settings/CentralSection.tsx`: parse de CSV de investimento em `PasteCsvModal`; `central/adSpendCsv.ts` existe separado.
- `Inbox.tsx`: `activeBotSuspicion`, `isHandoffPending`, `aiStateChipInfo`, `readKindFilter` (113-170); lógica de lote/paginação/âncora de scroll e janela de corrida URL↔estado (1347-1378) inline.
- `KanbanBoard.tsx:92-123` (labels/variantes), filtros client-side (845) e ordenação (886) inline; `TasksPage.tsx` `isDueToday` (1289) e filtros inteligentes.
- `LeadDetailPanel.tsx`: `toDateInputValue` (1080), validações BANT.
- `TaskDetailSlideOver.tsx:90 detectMentionTrigger` (duplica `ui/MentionTextarea` / `lib/mentions.ts`?).
- `layout/AuthLayout.tsx`: `entityDeepLink`, `withoutSearchParam`, `pathAfterOrgSwitch` já em `lib/orgSwitch.ts` (testado); a máquina de resolução (~220-300) fica no componente.

---

## 6. Testes de frontend

- 26 arquivos `src/**/*.test.ts`, 239 casos (`it`/`test`). Rodam no ambiente `edge-runtime` (`vitest.config.mts`: `include: ["convex/**/*.test.ts","src/**/*.test.ts"]`); **não há testes `.tsx`**, nem jsdom/happy-dom, nem Testing Library, nem Playwright.
- Localização: 22 em `src/lib/`, 1 em `src/hooks/` (`useOrgModules.test.ts`), 3 em `src/components/` (`central/adSpendCsv`, `inbox/central/centralMeta`, `inbox/types`).
- Maiores: `lib/whatsappFormat` 25, `metaConnect` 20, `markdown` 19, `contactName` 17, `followUp` 16.
- **Zero cobertura**: todos os componentes React, páginas, roteamento (`routes.ts`, `AuthLayout` além de `orgSwitch`), hooks `useCopilotStream`, `useInfiniteSentinel`, `usePermissions`, `useDebouncedValue`, `useInView`, `useKeepPrevious`, `useRoundedNow`, `useInboxChannelAccounts`; libs `abTesting`, `auditUtils`, `celebrations`, `groupDisplay`, `mentions`, `onboardingTemplates`, `utmPersistence`; `campaigns/campaignUtils`, `campaigns/wizardState`, `groups/posts/{postUtils,wizardState}`, `central/centralFormat`; `embed/loader.ts` (script injetado em sites de terceiros).
- Build guards no front: o resto do front depende de `tsc -p tsconfig.app.json` (CI) e `vite build`.

---

## 7. Acessibilidade e mobile (varredura rápida)

- **Botões só com ícone sem nome acessível**: varredura multi-linha em 512 `<button>…</button>` achou 19 sem `aria-label`/`title`/texto estático; **a maioria é falso positivo** (texto vem de expressão `{label}`/ternário ou de `<span>` com texto: `SignInForm.tsx:81`, `CampaignsPage.tsx:403`, `FormListPage.tsx:154`, `Button.tsx:26`, etc.). Sem ícone-puro confirmado em amostra. Há 386 `aria-label` no total. Risco real maior: 322 `title=` como único tooltip (não aparece em toque).
- **Abas sem semântica**: nenhum `role="tab"/tablist`, 1 `aria-selected` (ver 2.2/4).
- **Cores hex cruas em `.tsx/.ts` de `components/` e `pages/`**: 151 ocorrências (6 dígitos + 3 dígitos). Top arquivos: `campaigns/WhatsAppPreview.tsx` 28 (verde do WhatsApp, intencional, com variantes `[.light_&]:`), `KanbanBoard.tsx` 22, `settings/CentralSection.tsx` 12, `forms/renderer/FormField.tsx` 11, `tasks/LabelPicker.tsx` 10, `tasks/ProjectFormModal.tsx` 9, `inbox/ConversationActionsMenu.tsx` 8, `onboarding/ConfettiCanvas.tsx` 7, `forms/FormAnalyticsPage.tsx` 5, `forms/renderer/FormRenderer.tsx` 4, `SocialIcons.tsx` 3, `ManageStagesModal.tsx` 3. Parte são paletas de cor escolhida pelo usuário (etiquetas, projetos, etapas) e tema de formulário público (legítimo). Mais 31 classes Tailwind arbitrárias `(bg|text|border)-[#…]`.
- **Hacks de viewport**: `window.innerWidth/innerHeight` em `KanbanBoard.tsx:450-451` (popover de etapa), `tasks/ProjectSwitcher.tsx:84-87` (menu), `copilot/CopilotFab.tsx:68-70` (breakpoint `<768` manual, com `visualViewport`), `onboarding/ConfettiCanvas.tsx:85-86`. Não há `matchMedia`/hook `useMediaQuery` (breakpoint duplicado em JS só no `CopilotFab`).
- **Altura de viewport**: 31 usos de `100vh`/`h-screen`/`min-h-screen`; apenas 1 uso de `dvh` (`Inbox.tsx:1713`, container fixo da caixa de entrada). `AppShell` usa `min-h-[calc(100vh-3.5rem)]` (barra de endereço do mobile pode causar salto).
- **Scroll aninhado**: 67 `overflow-y-auto/scroll`; concentrados em `LeadDetailPanel` (8), `forms/FormBuilderPage` (4), `KanbanBoard` (3), `CentralSection` (2), `AiSection` (2), `LeadsBulkActionBar` (2), `Inbox` (2), `HandoffPeekSlideOver` (2). A regra do projeto (`.claude/rules/frontend.md`) diz para evitar scroll aninhado em conteúdo de página; Inbox e painéis de detalhe usam containers próprios por necessidade (lista + thread).
- **Texto minúsculo**: 238 usos de `text-[9|10|11px]`, 491 de `text-[10-13px]` (a regra do guia lista caption 11-12px).
- **Alvos de toque**: 151 usos de `min-h-[44px]`/`h-11`/`min-w-[44px]`, porém `Button` `sm` é `h-8` (32px) e `md` `h-10` (40px) — abaixo de 44px; Settings pills `py-2` (~36px).
- **Sidebar**: botões de navegação com `title` + `aria-label` só quando há badge; ícone-only em `md` (colapsada) depende de `title`.
- `prefers-reduced-motion`: há 1 bloco em `src/index.css`; uso nos componentes não auditado.

---

## 8. Build

`vite.config.ts` (plugins: `@vitejs/plugin-react`, hook "inject-chef-dev" só em dev, `rollup-plugin-visualizer` em produção com `open: !CI`, `vite-plugin-compression` gzip + brotli). `manualChunks`:

| Chunk | Conteúdo |
|---|---|
| `react-vendor` | react, react-dom, react-router |
| `convex-vendor` | convex/react, @convex-dev/auth/react |
| `utils-vendor` | clsx, tailwind-merge, sonner |
| `icons-vendor` | lucide-react |
| `xlsx-vendor` | xlsx (só por `import("xlsx")` em `campaigns/campaignUtils.ts:265`) |

`chunkSizeWarningLimit: 600`. Embed separado: `vite.embed.config.ts` (IIFE de `src/embed/loader.ts` → `dist-embed/embed.js`).

`package.json` (v0.78.1), `dependencies`: `@auth/core ^0.37.0`, `@convex-dev/auth ^0.0.80`, `@convex-dev/resend ^0.2.3`, `@dnd-kit/core ^6.3.1`, `@dnd-kit/modifiers ^9.0.0`, `@dnd-kit/sortable ^10.0.0`, `@dnd-kit/utilities ^3.2.2`, `clsx ^2.1.1`, `convex ^1.31.2`, `convex-helpers ^0.1.112`, `lucide-react ^0.564.0`, `qrcode.react ^4.2.0`, `react ^19.2.1`, `react-dom ^19.2.1`, `react-helmet-async ^2.0.5`, `react-router ^7.13.0`, `sonner ^2.0.3`, `tailwind-merge ^3.1.0`, `xlsx ^0.18.5`.
Principais `devDependencies`: `vite ^6.2.0`, `typescript ~5.7.2`, `tailwindcss ~3`, `vitest ^4.1.10`, `convex-test 0.0.41` (CLAUDE.md fala em 0.0.62 numa avaliação; HEAD fixa 0.0.41), `eslint ^9.21`, `sharp`, `rollup-plugin-visualizer`.

Pontos de peso/carregamento:
- **Eager no bundle de entrada** (`main.tsx`): `LandingPage` (911 linhas, imagens), `AuthPage`, `AuthLayout` (+ `AppShell`, `Sidebar`, `BottomTabBar`, `OnboardingWizard`, `OrgSwitcher`, `NotificationBell`, `CopilotFab/Panel` + `Markdown`/`useCopilotStream`), **`DevelopersPage` + `PlaygroundPage` + `lib/apiRegistry.ts` (1398) + `components/developers/*`** — páginas públicas pesadas que entram no carregamento de quem abre o app. Só rotas internas e termos/privacidade/form público são lazy.
- `@dnd-kit/*` entra via rotas lazy (Kanban, Tasks, Calendar, Forms) — não é eager.
- `qrcode.react` só em `notifications/TelegramCard.tsx` (carregado com Settings). O QR do bridge vem como imagem do backend (`result.qrCode`).
- `xlsx` já é dinâmico (bom). `lucide-react` importado por ícone individual (tree-shake) mas agrupado num chunk `icons-vendor`.
- `react-helmet-async` (SEO) está no provider raiz também para o app autenticado.
- `public/` tem 3,9 MB (imagens); `scripts/convert-images.js` existe.
- `index.css` 126 linhas; tokens em `:root` (dark) e `.light`; `tailwind.config.js` 135 linhas.

---

## Oportunidades observadas

1. Unificar a lista de navegação: uma única definição (id, rótulo, ícone, permissão, módulo, grupo) consumida por `Sidebar` e `BottomTabBar` (hoje duplicada, com rótulos e ordem diferentes, e `Tab` definido em componente).
2. Corrigir o destaque de item ativo em sub-rotas (`/app/formularios/:id/*`) trocando match exato por prefixo em `PATH_TO_TAB`.
3. Fazer a seção de Configurações escrever `?secao=` ao clicar e agrupar as 10 pills por tema (Conta, Canais e IA, Equipe/Dados, Desenvolvedor); considerar busca ou sumário em `AiSection`/`ChannelsSection`.
4. Reunir configurações espalhadas de IA e canais: transcrição automática (hoje só por canal em Canais), visão, atendente, grupos e Telegram têm toggles em 4 lugares diferentes.
5. Criar primitivos `Switch`, `Select`, `Tabs`/`SegmentedControl`, `FormField`, `PageHeader`, `SectionCard` e `Popover/Menu`, substituindo as 7 cópias de switch, 111 `<select>` e ~46 cabeçalhos de card.
6. Dar semântica de acessibilidade às abas (`role=tab`, `aria-selected`) e substituir `title=` por tooltip acessível em toque.
7. Quebrar `AiSection` (3309), `Inbox` (3103), `LeadDetailPanel` (2259), `ChannelsSection` (1985), `KanbanBoard` (1787) e `TaskDetailSlideOver` (1600) por responsabilidade; `Inbox()` e `AttendantConfig` são cada um um único componente de ~1000-2850 linhas.
8. Extrair um `MessageThread`/`Composer` compartilhado entre `Inbox` e `LeadDetailPanel.ConversationTab` (markread, presença, janela de serviço, scroll de lote, respostas rápidas já duplicados).
9. Resolver nomes duplicados: dois `TaskDetailSlideOver` (grande e `calendar/`), e apagar `components/Dashboard.tsx` (stub sem uso).
10. Levar para a URL o que hoje é só estado local: contato aberto, aba do lead/contato, visão/data do calendário (`?date=&event=` já é emitido por `UpcomingEventsWidget` mas ignorado), filtros de Auditoria/Tarefas/Campanhas.
11. Consolidar formatadores (22 funções de data/moeda/telefone) em `src/lib/format*.ts` com testes; mover validações de `AiSection`, `ImportWizard` e `FormSubmissionsPage` para `src/lib` com testes.
12. Corrigir/decidir o tema: a classe `.light` e os tokens claros existem mas nada os ativa; `Toaster` fixo em dark.
13. Reduzir o bundle de entrada: carregar sob demanda `DevelopersPage`, `PlaygroundPage` (e `apiRegistry`), `LandingPage` e `OnboardingWizard`; considerar `errorElement`/rota `*` (404) no router.
14. Testes de componentes: não há ambiente de DOM; hooks de URL/paginação (`useInfiniteSentinel`, `usePermissions`) e `lib` restantes sem cobertura.
15. Revisar alvos de toque e altura de viewport: `Button` sm/md abaixo de 44px, pills de Settings, `100vh` em vez de `dvh` no shell, e 238 textos de 9-11px.
