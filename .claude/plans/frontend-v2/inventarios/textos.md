# Inventário de textos e vocabulário da interface (HNBCRM)

Fonte: checkout limpo de HEAD em `$W` = `/tmp/claude-1000/-home-eric-projects-ClawCRM-clawcrm-repo/c2ebc17d-081d-4ead-a819-3f659d9babd0/scratchpad/head`. Todos os caminhos abaixo são relativos a `$W/src/`. Somente leitura.

Método das contagens: extraí por script apenas strings visíveis (texto JSX, `placeholder`, `title`, `label`, `aria-label`, `toast.*`, literais com espaço), excluindo testes. Ao contar termos de domínio excluí também `LandingPage`, `DevelopersPage`, `PlaygroundPage`, `PrivacyPage`, `TermsPage`, porque são páginas públicas/técnicas. Os números são aproximados (podem incluir um ou outro comentário JSX ou texto de código), mas a ordem de grandeza é confiável.

---

## 1. Vocabulário de navegação

### 1.1 Menu lateral (desktop) e barra inferior (mobile)

Menu lateral: `components/layout/Sidebar.tsx:42-55`. Barra inferior e menu "Mais": `components/layout/BottomTabBar.tsx:44-61`. Rotas: `lib/routes.ts:4-17`.

| Rota | Rótulo no desktop | Rótulo no mobile | O que faz de fato |
|---|---|---|---|
| `/app/painel` | Painel | Painel | Resumo: valor do funil, leads ativos, repasses pendentes, tarefas, widgets, vitrine de "funcionalidades" (`DashboardOverview.tsx`). |
| `/app/central` | Central | Central | Painel de métricas para quem atende várias unidades (hotéis) num WhatsApp. Módulo opcional, só aparece se ligado (`Sidebar.tsx:43`, `central/CentralPage.tsx`). |
| `/app/pipeline` | Pipeline | Pipeline | Quadro kanban de leads por etapa, com visão lista, filtros, ações em lote (`KanbanBoard.tsx`). |
| `/app/contatos` | Contatos | Contatos | Lista de pessoas/empresas, com detalhe e criação (`ContactsPage.tsx`). |
| `/app/entrada` | Caixa de Entrada | **Entrada** | Conversas de WhatsApp, Instagram, Messenger, grupos; responder, notas internas, rascunhos da IA (`Inbox.tsx`). |
| `/app/repasses` | **Repasses** | **Repasses** | Fila de conversas em que a IA pediu ajuda a um humano; aceitar, rejeitar ou devolver à IA com instrução (`HandoffQueue.tsx`). |
| `/app/tarefas` | Tarefas | Tarefas | Tarefas e projetos em lista/kanban, com etiquetas e subtarefas (`TasksPage.tsx`). |
| `/app/calendario` | Calendário | Calendário | Eventos e tarefas por data. |
| `/app/equipe` | Equipe | Equipe | Membros humanos e agentes de IA, convites, permissões (`TeamPage.tsx`). |
| `/app/auditoria` | Auditoria | Auditoria | Registro de tudo que foi alterado, com filtros (`AuditLogs.tsx`). |
| `/app/formularios` | Formulários | Formulários | Criador de formulários que entram como lead; análises e testes A/B. |
| `/app/campanhas` | Campanhas | Campanhas | Envio em massa de WhatsApp com público, mensagem, limites e opt-out (`CampaignsPage.tsx`). |
| `/app/grupos` | Grupos | Grupos | Grupos de WhatsApp acompanhados e publicações programadas (`groups/GroupsPage.tsx`). |
| `/app/configuracoes` | Configurações | Configurações | 10 abas (ver 1.2). |

Observações sobre a navegação:

- A mesma tela tem três nomes: item "Caixa de Entrada" (`Sidebar.tsx:46`), "Entrada" no celular (`BottomTabBar.tsx:47`), título "Conversas" (`Inbox.tsx:1732`), URL `/entrada`. Em textos internos ainda aparece "inbox" em minúsculas (`HandoffPeekSlideOver.tsx:132`, `AiSection.tsx:2081`, `ChannelsSection.tsx:827`).
- "Repasses" não diz o que a pessoa deve fazer. A tela mostra um título diferente: "Fila de Repasses" (`HandoffQueue.tsx:203`). O Painel diz "Repasses Pendentes" (`DashboardOverview.tsx:111`), "Ver Repasses" (`:129`) e na vitrine "Repasses IA-Humano" (`:688`).
- "Central" aparece em três lugares com três significados: item de menu (relatórios), aba de Configurações (liga/desliga módulos) e "Painel da Central" (H1, `CentralPage.tsx:123`). Na landing é "Central de Atendimento".
- "Pipeline" é o nome do menu, mas o conteúdo é um funil de vendas; o texto de ajuda e a IA falam "funil" (ver seção 2).
- Dois itens exigem permissão de configurações ("Formulários") ou um módulo ("Central"); o rótulo não indica isso.
- `Sidebar.tsx:171`: botão "Sair". `BottomTabBar.tsx:223`: "Mais opções".

### 1.2 Configurações

Abas: `components/Settings.tsx:31-42`. Título: "Configurações" (`Settings.tsx:83`, usa `h2`, não `h1`).

| Aba | Rótulo | O que faz |
|---|---|---|
| general | Geral | Nome da organização, fuso, moeda, país padrão dos telefones (`Settings.tsx:118+`, fusos em `:182-189`). |
| ai | IA | Atendente IA, Copiloto, modelos, imagens, grupos, follow-up, persona, simulador (`settings/AiSection.tsx`, ~3 mil linhas). |
| apikeys | **Chaves API** | Cria chaves para integrações e agentes de IA (`Settings.tsx:308`). |
| fields | Campos Personalizados | Campos extras de lead/contato (`Settings.tsx:583`). |
| sources | **Fontes de Leads** | Lista de origens de lead (`Settings.tsx:702`). |
| webhooks | **Webhooks** | Avisos HTTP para sistemas externos (`Settings.tsx:844`). |
| channels | Canais | Conectar WhatsApp oficial (Cloud API), não oficial (bridge/QR), Instagram/Messenger (`ChannelsSection.tsx`). |
| data | Dados | Importar/exportar (`DataSection.tsx`, `ImportWizard.tsx`). |
| notifications | Notificações | Preferências de aviso e cartão do Telegram (`notifications/*`). |
| central | Central | Liga módulos opcionais, unidades, setores, investimento em mídia (`CentralSection.tsx`). |

Sub-blocos relevantes dentro de IA (`AiSection.tsx`): "Modelo e roteamento" (`:503`), "Limites de resposta" (`:1952`), "Proteção contra robôs e mensagens automáticas" (`:2015`), "Follow-ups agendados pela IA" (`:2064`), "Palavras de repasse" (`:2231`), "Canais não oficiais (bridge)" (`:870`), "Roteamento das publicações programadas" (`:772`). Sub-abas da Central: "Visão geral / Marketing / Atendimento" (`central/CentralPage.tsx:48-51`). Abas de Campanhas: Todas/Ativas/Rascunhos/Pausadas/Concluídas/Canceladas (`CampaignsPage.tsx:30-35`). Abas de Grupos: Grupos/Publicações (`GroupsPage.tsx:43-44`). Abas do Inbox: Ativas/Arquivadas (`Inbox.tsx:1789,1801`) e Todas/Diretas/Grupos (`Inbox.tsx:150-152`).

### 1.3 Títulos de página (H1/H2 de topo)

| Página | Título | Arquivo |
|---|---|---|
| Painel | "Olá, {nome}!" | `DashboardOverview.tsx:78` |
| Pipeline | sem título de página; "Nova Pipeline" no modal de criação | `KanbanBoard.tsx:1653` |
| Contatos | Contatos | `ContactsPage.tsx:297` |
| Caixa de Entrada | Conversas | `Inbox.tsx:1732` |
| Repasses | **Fila de Repasses** | `HandoffQueue.tsx:203` |
| Tarefas | Tarefas | `TasksPage.tsx:446` |
| Equipe | Equipe | `TeamPage.tsx:166` |
| Auditoria | **Logs de Auditoria** | `AuditLogs.tsx:279` |
| Campanhas | Campanhas | `CampaignsPage.tsx:159` |
| Grupos | Grupos | `groups/GroupsPage.tsx:192` |
| Central | **Painel da Central** | `central/CentralPage.tsx:123` |
| Configurações | Configurações | `Settings.tsx:83` |
| Termos / Privacidade | Termos de Uso / Política de Privacidade | `pages/TermsPage.tsx:50`, `PrivacyPage.tsx:50` |

Inconsistência: o título da tela quase nunca é igual ao do menu (Caixa de Entrada/Conversas, Repasses/Fila de Repasses, Auditoria/Logs de Auditoria, Central/Painel da Central). Níveis de título misturam `h1` e `h2`.

---

## 2. Termos de domínio como o usuário os vê

Contagens = ocorrências em strings visíveis (fora páginas públicas/técnicas). Veredito: **OK** = um corretor/dono de PME entende; **Médio** = entende com contexto; **Jargão** = precisa de tradução.

| Termo | Qtd. aprox. | Contextos (arquivo:linha) | Veredito |
|---|---|---|---|
| Repasse / repasse | 28 / 23 | Menu; "Repasse aceito — abrindo a conversa" (`HandoffQueue.tsx:129`); "Repasse pendente — aguardando um humano assumir" (`Inbox.tsx:2133`); preferência "Repasse solicitado" (`NotificationPreferences.tsx:15`) | Jargão: soa como "repassar dinheiro"; ninguém fala assim. Quem usa WhatsApp diria "a IA pediu ajuda". |
| Handoff | 0 na UI logada (5 em páginas técnicas/landing) | `LandingPage.tsx:252` "Handoffs inteligentes" | Jargão em inglês; só vaza na landing. |
| Atendente / Atendente IA / atendente virtual | 23 / 11 / 3 | "Atendente IA ativado em modo sugestão" (`AiSection.tsx:229`); "Atendente virtual desativado" (`:666`); "Sugestão do atendente IA" (`AiDraftCard.tsx:236`) | OK, mas três variações. Na Central, "atendentes" são pessoas (landing `:258`), o que confunde. |
| Copiloto / Copiloto IA | 19 | "Abrir Copiloto IA" (`copilot/CopilotFab.tsx:221`); "Copiloto in-app" (`AiSection.tsx:989`) | Médio: precisa de uma frase ("assistente que mexe no CRM por você"). "in-app" é inglês. |
| Assistente | 7 | Texto do Telegram (`TelegramCard.tsx`), "Assistente no app" (`AiSection.tsx:639`) | Quarto nome para IA. |
| Agente IA / Agentes IA | 10 / 16 | Aba "Agentes IA" (`TeamPage.tsx:209`), "Agente IA criado" (`InviteMemberModal.tsx:166`), "Agente IA" (`Settings.tsx:382`) | Médio: aqui "agente" = integração de IA com chave API, mas "Agente" também é um papel humano (`InviteMemberModal.tsx:50`). Colisão. |
| Autopilot / autopilot | 6 / 14 | "Autopilot ativado — respostas saem sem revisão" (`AiSection.tsx:1532`); botão "Ativar autopilot" (`:1748`); "Autopilot libera com 10+ sugestões revisadas e 60%+ de aceitação" (`:1753`) | Jargão em inglês (aviação). O conceito (responde sozinha) é simples. |
| Sugestão / modo sugestão / Sugerir | 11 / 21 / 2 | "Atendente IA ativado em modo sugestão" (`AiSection.tsx:229`); "Sugerir ação nos repasses" (`TelegramCard.tsx:170`) | OK, mas "modo sugestão" convive com "rascunho" para a mesma coisa. |
| Rascunho | 12 / 22 | "Rascunho da IA aguardando revisão" (`HandoffPeekSlideOver.tsx:327`); "Rascunhos" campanha (`CampaignsPage.tsx:32`); "Salvar rascunho" publicação | OK, porém dois significados (resposta da IA x campanha/formulário não publicado). |
| Lead | 94 / 209 | Em todo lugar: "Criar Lead", "Novo Lead", "Leads Ativos" | Médio: corretor conhece "lead"; dono de loja diz "cliente em potencial" ou "oportunidade". Sempre coexiste com "contato" e "cliente". |
| Contato | 41 / 103 | Menu "Contatos" | OK. Relação lead x contato não é explicada na UI. |
| Cliente | 46 | "Resposta enviada ao cliente" (`AiDraftCard.tsx:145`) | OK; é o termo natural, mas aqui significa qualquer pessoa que escreve. |
| Funil / funil | 8 / 30 | "Abrir no funil" (`ContactDetailPanel.tsx:776`, `Inbox.tsx:836`); "Funil para novos leads" (`AiSection.tsx:2248`); "Como está meu funil?" (`CopilotPanel.tsx:15`) | OK: bem compreendido por vendedores. |
| Pipeline | 42 / 43 | Menu; "Excluir Pipeline" (`DeleteBoardModal.tsx:44`); "Nenhum pipeline encontrado" (`KanbanBoard.tsx:1143`) | Médio/anglicismo: corretor conhece "funil". |
| Board / board | 5 / 30 | "Pipeline por Board" (`DashboardOverview.tsx:391,403`); nomes de código `DeleteBoardModal`, `EditBoardModal` | Jargão em inglês; vaza no Painel. |
| Etapa / Estágio | 33+65 / 7+17 | "Adicionar Etapa" (`KanbanBoard.tsx:593`); "Estágio inicial" (`AiSection.tsx:2269`); "Mover o lead de estágio" (`AiDraftCard.tsx:67`); "Mover para este estágio ao qualificar" (`AiSection.tsx:2290`); "Primeiro estágio" (`forms/builder/FormSettingsPanel.tsx:314`) | Duas palavras para a mesma coisa. "Etapa" domina. |
| Canal / canal | 21 / 33 | Aba "Canais"; "Canal de Aquisição" (`ContactDetailPanel.tsx:518`); "Canal desconectado" (`NotificationPreferences.tsx:27`) | Médio: "canal" é ao mesmo tempo WhatsApp/Instagram (canal de conversa) e de onde veio o lead (canal de aquisição). |
| Bridge / bridge | 2 / 31 | "Canais não oficiais (bridge)" (`AiSection.tsx:870`); "Atendente IA em canais bridge" (`:888`); opção "Bridge" (`CampaignsPage.tsx:196`); toast "Atendente IA ativado — inclusive em canais bridge" (`:228`) | Jargão interno puro. O usuário vê o QR code e "WhatsApp não oficial". |
| Gateway | 3 / 15 | "Gateway desatualizado" (`campaigns/steps/StepChannel.tsx:32`); "Provisionando instância no gateway..." (`ChannelsSection.tsx:1765`); "Falha ao consultar o gateway" (`:1196`); "custo do seu gateway" (`campaigns/steps/StepReview.tsx:109`) | Jargão técnico. |
| Provisionar / instância | 2 / 2 | "Provisionar nova" (`ChannelsSection.tsx:1873`); "Instância provisionada — mostre o QR para parear" (`:1766`); "Instância existente" (`:1861`) | Jargão de infraestrutura. |
| Parear / QR | 14 | "Parear número via QR" (`ChannelsSection.tsx:1216`) | Médio: "conectar com QR code" é mais familiar. |
| Webhook / webhooks | 17 / 30 | Aba "Webhooks" (`Settings.tsx:844`); "Adicionar Webhook" (`:848`) | Jargão técnico; público não técnico não precisa ver. O Painel também mostra "Sistema de Webhooks" (`DashboardOverview.tsx:720`). |
| API / Chaves API / Token | 109 / 4 / 13 | Aba "Chaves API" (`Settings.tsx:308`); "Access Token", "Verify Token" (`ChannelsSection.tsx:1612,1654`); "Admin token do gateway" (`:1947`) | Jargão técnico. Aceitável só numa área "Avançado/Desenvolvedores". |
| LGPD | 9 | "Reconhecimento LGPD registrado" (`AiSection.tsx:995`); "Exigido pela LGPD" (`StepReview.tsx:151`) | OK para brasileiro; o texto de aceite é longo (ver seção 5). |
| Transcrição | 4 | "Transcrição automática ativada" (`ChannelsSection.tsx:320`) | OK. |
| Visão (imagens) / Visão Kanban/Lista | 12 / 13 | "Leitura de imagens ativada" (`AiSection.tsx:687`); "Visão Kanban", "Visão Lista" (`KanbanBoard.tsx:1433,1446`); "Visões Salvas" | "Visão" = view (anglicismo de "view"); em imagens o rótulo já é "Leitura de imagens" (bom). |
| Guardrail / guarda-corpo | 0 / 3 | "Guarda-corpos anti-loop" (`AiSection.tsx:1952`); "serve de guarda-corpo" (`:1268`) | Jargão traduzido literalmente; confuso. |
| Debounce | 0 | Rótulo já é "Agrupar mensagens por (segundos)" (`AiSection.tsx:1924`) | Bom exemplo de tradução. |
| BANT / Qualificação | 8 / 7 | "Qualificação BANT" (`LeadDetailPanel.tsx:1916`); "O que é BANT?" (`:997`); "Atualizar qualificação BANT" (`AiDraftCard.tsx:69`) | Jargão de vendas B2B; existe explicação, mas o rótulo a esconde. |
| Temperatura | 8 | "Temperatura" (`CreateLeadModal.tsx:295`); "Todas Temperaturas" (`KanbanBoard.tsx:1375`); "Leads Quentes" | OK/informal; fácil de entender (frio, morno, quente). |
| Central | 22 | ver 1.1 | Ambíguo. |
| Unidade / Setor | 21 / 14 | "Todas Unidades" (`KanbanBoard.tsx:1410`); "Unidade: ..." (`Inbox.tsx:2164`); "Setor" no cadastro de contato (`CreateContactModal.tsx:394`) e no onboarding ("Qual o setor do seu negócio?" `WizardStep1Welcome.tsx:105`) | "Setor" tem dois sentidos (ramo do negócio x departamento da Central). "Unidade" só faz sentido para quem tem módulo Central, mas filtros aparecem no Pipeline. |
| Desfecho | 2 | "Roteamento e desfecho da conversa" (`inbox/central/ConversationRoutingBar.tsx:189`) | Jargão de atendimento. |
| Campanha | 30 | Menu | OK. |
| Disparo | 5 | "Disparar 1 a 1 para os membros" (`Inbox.tsx:947`) | OK; mas só aparece em grupos/landing. |
| Opt-out | 5 / 8 | Aba "Opt-out" (`CampaignsPage.tsx:251`); "(opt-out)" em `NewConversationModal.tsx:667` | Jargão em inglês. "Pediu para não receber" ou "Lista de bloqueio" é mais claro. |
| Grupo | 44 | Menu | OK. |
| Follow-up / Follow-ups | 16 / 21 | "Follow-ups" (`UpcomingEventsWidget.tsx:43`); "Follow-up executado pela IA" (`inbox/MessageBubble.tsx:559`); tipo de tarefa "Follow-up" (`CreateTaskModal.tsx:27`) | Anglicismo muito comum entre vendedores. |
| Tarefa | 67 | Menu | OK. |
| Projeto | 13 | "Novo projeto" (`TasksPage.tsx`) | OK. |
| Auditoria | 10 | Menu; "Logs de Auditoria" | Médio: "Histórico de alterações" seria mais claro. "Logs" é inglês. |
| Módulo | 1 / 9 | "Módulos opcionais para quem atende várias unidades..." (`CentralSection.tsx:181`) | Médio. |
| Persona | 28 (maior parte "Personalizado") | "Persona (instruções de comportamento)" (`AiSection.tsx:1870`) | Jargão de IA/marketing; "Como a IA deve se comportar" é claro. |
| Modelo / roteamento / BYO / fallback | 8 / 7 / 1 / 7 | "Modelo e roteamento" (`AiSection.tsx:503`); "No modo BYO a rota é uma só, para todos os produtos — e sem fallback." (`:411`); "Auto — OpenCode Go, fallback OpenRouter (padrão)" (`:2997`) | Jargão técnico puro; deveria ficar escondido em "Avançado". |
| Prompt / LLM | 1 / 0 | "entram no prompt para a IA não se repetir" (`groups/posts/StepContent.tsx:187`) | Raro; trocar por "instruções". |
| Quick replies | 0 (já traduzido) | "Resposta rápida criada" (`inbox/QuickReplies.tsx:173`) | OK. |
| Etiqueta / Tag | 56 / 70 | "Etiquetar leads" (`KanbanBoard.tsx:985`), mas "Tags" (`ContactDetailPanel.tsx:351`, `CreateTaskModal.tsx:534`), "Adicionar tag" (`CreateTaskModal.tsx:575`) | Duas palavras para o mesmo conceito. |

### Inconsistências de nome para o mesmo conceito

| Conceito | Variações vistas (exemplos) |
|---|---|
| Funil de vendas | Pipeline (menu), Funil (`AiSection.tsx:2248`, `ContactDetailPanel.tsx:776`), Board (`DashboardOverview.tsx:391`), "Nova Pipeline" (gênero errado, `KanbanBoard.tsx:1653`) |
| Fase do funil | Etapa (`KanbanBoard.tsx:593`), Estágio (`AiSection.tsx:2269`, `FormSettingsPanel.tsx:309`) |
| Caixa de mensagens | Caixa de Entrada (menu), Entrada (mobile), Conversas (título), inbox (textos), "Inbox" (código) |
| IA que conversa | Atendente IA, Atendente virtual, Assistente, "a IA", "IA da sala", "robô"/"bot" (12+16 ocorrências) |
| IA que ajuda a equipe | Copiloto, Copiloto IA, Assistente no app, "assistente" no Telegram |
| IA pede ajuda a humano | Repasse, Handoff, "Passar para humano" (`AiDraftCard.tsx:70` "Repassar para humano"), "Assumir" |
| Resposta pronta da IA | Rascunho, Sugestão, "Resposta" |
| Rótulo para classificar | Etiqueta, Tag |
| Modo da IA | "modo sugestão", "autopilot", "rascunho", "Automático" (Telegram), "Auto" (modelo) |
| WhatsApp oficial / não oficial | "Cloud API (oficial/Meta)", "WhatsApp oficial", "Canal não oficial", "bridge", "gateway", "API não-oficial" |
| Membro com IA | "Agente IA", "agente" (papel humano), "bot" |
| Conectar | Conectar, Parear, Provisionar |

---

## 3. Palavras em inglês e capitalização

### 3.1 Inglês visível ao usuário (amostra, máx. 40)

Inglês que o usuário **vê** (rótulos, placeholders, opções):

| # | Local | Texto |
|---|---|---|
| 1 | `components/Settings.tsx:183-189` | "Eastern Time", "Central Time", "Mountain Time", "Pacific Time", "London", "Berlin" (opções de fuso em inglês; "São Paulo" misturado) |
| 2 | `components/Settings.tsx:619` | "Select" (rótulo de tipo de campo personalizado) |
| 3 | `components/Settings.tsx:769` | "Phone" (tipo de campo) |
| 4 | `components/ContactDetailPanel.tsx:351` | "Tags" |
| 5 | `components/ContactDetailPanel.tsx:517,549` | "UTM Source" |
| 6 | `components/forms/FormSubmissionsPage.tsx:418,596` | "UTM Source" |
| 7 | `components/CreateTaskModal.tsx:534,575` | "Tags", "Adicionar tag" |
| 8 | `components/CampaignsPage.tsx:195,382` | "Cloud API (Meta)", "Cloud API" |
| 9 | `components/CampaignsPage.tsx:196` | "Bridge" |
| 10 | `components/DashboardOverview.tsx:391,403` | "Pipeline por Board" |
| 11 | `components/DashboardOverview.tsx:657-658` | "Pipeline Kanban", "drag-and-drop" |
| 12 | `components/DashboardOverview.tsx:753` | "Busca rápida com Cmd+K" |
| 13 | `components/settings/ChannelsSection.tsx:544` | "WhatsApp Cloud API — Get Started" |
| 14 | `components/settings/ChannelsSection.tsx:526-529` | "Meta for Developers", "Phone Number ID", "WABA ID", "System User", "Business Manager", "App Secret" (passo a passo misturado) |
| 15 | `components/settings/ChannelsSection.tsx:1595,1612,1654,1658` | "Phone Number ID", "Verify Token", "Access Token" |
| 16 | `components/settings/ChannelsSection.tsx:1530` | "Verify token copiado" |
| 17 | `components/settings/AiSection.tsx:3007` | "Custom (OpenAI-compatible)" |
| 18 | `components/settings/AiSection.tsx:411` | "BYO", "fallback" |
| 19 | `components/settings/AiSection.tsx:2544` | "Sandbox: nada aqui toca o WhatsApp..." |
| 20 | `components/forms/builder/FormSettingsPanel.tsx:626` | "Reply-To (opcional)" |
| 21 | `components/forms/FormSubmissionsPage.tsx:880` | "Nome / Email" (resto do app usa "e-mail" no onboarding e "Email" na lista; ver 3.2) |
| 22 | `components/ViewSelector.tsx:75,273` | "Leads Quentes", "Criar Nova Visão" ("visão" = view) |
| 23 | `components/KanbanBoard.tsx:1433,1446` | "Visão Kanban", "Visão Lista" |
| 24 | `components/inbox/central/ConversationRoutingBar.tsx:189` | "Roteamento" (anglicismo: "routing") |
| 25 | `components/Settings.tsx:34` | "Chaves API", e "Webhooks" (`:37`) |
| 26 | `components/team/InviteMemberModal.tsx:52` | "Admin" |
| 27 | `components/SignInForm.tsx:58`, `team/InviteMemberModal.tsx:265`, `LeadDetailPanel.tsx:1532`, `notifications/NotificationPreferences.tsx:164` | "Email" (sem hífen; o aviso de convite usa "e-mail": `WizardInviteResults.tsx:118`) |

Inglês que só vai para o console (não visível, mas sinal de dívida): `CloseReasonModal.tsx:60`, `Settings.tsx:486,506,681,823`, `KanbanBoard.tsx:376,1125`, `ManageStagesModal.tsx:144,162`, `EditBoardModal.tsx:49`, `LeadDetailPanel.tsx:646,1418,1433`, `onboarding/OnboardingWizard.tsx:100,366,378` (`console.error("Failed to ...")`). O usuário vê só o toast PT correspondente, ex.: "Falha ao criar lead" (`KanbanBoard.tsx:371`).

Ícones importados com nome em inglês (`Save`, `Search`, `Send`, `Filter`...) são código, não texto. Emoji em UI (contra a regra de ícones `lucide-react`): `inbox/AiDraftCard.tsx:255` ("📎 Imagem anexada") e, no Telegram, cartões com 🔴 🔄 💡 (CHANGELOG 0.76-0.78).

Ortografia: faltam acentos em `notifications/NotificationPreferences.tsx:16` ("e aceito"), `:21` ("Tarefa atribuida"), `:24` ("Lead atribuido").

### 3.2 Capitalização inconsistente

O app mistura "Title Case" e "sentence case", muitas vezes na mesma tela. Contagem de amostras:

| Padrão | Exemplos |
|---|---|
| Title Case (inglês americano) | "Adicionar Nota" (`LeadDetailPanel.tsx:936`, `Inbox.tsx:2870`), "Excluir Tarefa" (`TaskDetailSlideOver.tsx:1391`), "Nova Tarefa", "Novo Evento", "Convidar Membro" (`InviteMemberModal.tsx:449`), "Criar Contato" (`CreateContactModal.tsx:470`), "Criar Lead" (`CreateLeadModal.tsx:344`), "Salvar Detalhes" (`LeadDetailPanel.tsx:1900`), "Salvar Campos" (`:1325`), "Salvar Qualificação" (`:1916`), "Excluir Etapa" (`KanbanBoard.tsx:553`), "Adicionar Etapa" (`:593`), "Excluir Webhook" (`Settings.tsx:893`), "Todas Prioridades" (`KanbanBoard.tsx:1359`), "Campos Personalizados" (`Settings.tsx:35`), "Fontes de Leads" |
| sentence case | "Nova conversa" (`Inbox.tsx:1740`), "Salvar alterações" (`NotificationPreferences.tsx:190`), "Adicionar etiqueta" (`LabelPicker.tsx:128`), "Excluir projeto" (`TasksPage.tsx:716`), "Excluir etapa" (`ManageStagesModal.tsx:238`), "Criar pipeline" (`KanbanBoard.tsx:1193`), "Salvar agenda" |

Mesma ação com as duas grafias: "Excluir Etapa" (`KanbanBoard.tsx:553`) vs "Excluir etapa" (`ManageStagesModal.tsx:238`); "Criar Pipeline" (`KanbanBoard.tsx:1147`) vs "Criar pipeline" (`:1193`); "Nova Etapa" vs "Nova etiqueta"; "Adicionar Nota" vs "Adicionar etiqueta"; "Nova Senha" vs "Nova senha"; "Editar Pipeline" (`:1291`) vs "Editar projeto". Também "Nova Pipeline" (feminino) vs "O pipeline" (masculino, `KanbanBoard.tsx:1705`).

Outras variações: "Salvar alterações" aparece com "Salvando..." (reticências três pontos) em alguns lugares e "…" (caractere único) em outros (`AiDraftCard.tsx:177,303` usa "…"; `ImportWizard.tsx:406` usa "..."). Hífen/travessão: "Fechado - Ganho" (`KanbanBoard.tsx:524`) x "Atendente IA ativado — inclusive..." (travessão).

---

## 4. Estados vazios, erros e toasts (25 amostras)

| # | Texto (arquivo:linha) | Avaliação |
|---|---|---|
| 1 | "Nenhuma campanha ainda" / "Nada com esse filtro" (`CampaignsPage.tsx:207`) | Claro e curto; falta chamada para criar a primeira. |
| 2 | "Nenhum lead encontrado" (`leads/LeadsListView.tsx:136`) | Seco, sem ação nem causa possível. |
| 3 | "Nenhum pipeline encontrado" + "Crie seu primeiro pipeline de vendas para começar." (`KanbanBoard.tsx:1143-1144`) | Bom, tem ação; palavra "pipeline". |
| 4 | "Nenhum repasse pendente" / "Todos os repasses foram processados." (`HandoffQueue.tsx:211-212`) | Correto mas frio; poderia dizer "Tudo em dia". |
| 5 | "Nenhuma conversa ainda" (`Inbox.tsx:2038`) | Não explica como as conversas chegam (conectar WhatsApp). |
| 6 | "Nenhum grupo acompanhado" (`Inbox.tsx:2020`, `groups/posts/StepTargets.tsx:91`) | "Acompanhar" é conceito interno; ver 5. |
| 7 | "Grupos desligados nos seus números" (`groups/GroupsPage.tsx:227`) | Técnico; não diz como ligar sem ler a descrição. |
| 8 | "Sem acesso" + "Você não tem permissão para ver campanhas. Peça a um administrador." (`CampaignsPage.tsx:149`) | Ótimo: diz o que fazer. |
| 9 | "Sem acesso às publicações" + "exige permissão na categoria Campanhas" (`groups/posts/GroupPostsTab.tsx:132-133`) | "categoria" é detalhe de RBAC; simplificar. |
| 10 | "Painel da Central desligado" + "Um administrador pode ligá-lo em Configurações → Central." (`central/CentralPage.tsx:96-97`) | Claro; orienta. |
| 11 | "Sem movimento neste período" + "o painel se preenche sozinho..." (`CentralPage.tsx:250-251`) | Muito bom, amigável. |
| 12 | "Nenhuma unidade cadastrada" + "Cadastre os hotéis em Configurações → Central" (`central/UnitsTab.tsx:42-43`) | "hotéis" é específico de um cliente; vaza para outros públicos. |
| 13 | "Nenhuma tarefa encontrada" (`TasksPage.tsx:645`) | Genérico. |
| 14 | "Lista vazia" (`campaigns/OptOutsPanel.tsx:160`) | Vago: o que é a lista? |
| 15 | "Nenhum dado de equipe ainda." (`DashboardOverview.tsx:143`) | OK. |
| 16 | "Nenhum lead no pipeline ainda." (`DashboardOverview.tsx:392`) | OK. |
| 17 | Toast "Repasse aceito com sucesso" (`HandoffQueue.tsx:132`) | "com sucesso" é supérfluo; padrão inconsistente (ver 18). |
| 18 | Toasts "Lead criado!" (`KanbanBoard.tsx:370`), "Etapa excluída!" (`:1530`), "Tarefa concluída!" (`TaskKanbanBoard.tsx:460`) x "Projeto criado" (`ProjectFormModal.tsx:92`), "Filtro salvo", "Tarefa excluída" (`TaskDetailSlideOver.tsx:319`) | Mistura com e sem exclamação. |
| 19 | "Falha ao aceitar repasse", "Falha ao rejeitar repasse" (`HandoffQueue.tsx:135,162`) | Diz o quê, não o porquê nem o que fazer. Padrão "Falha ao..." domina (dezenas); soa técnico. |
| 20 | "Erro ao salvar evento" (`calendar/CalendarEventModal.tsx:157`) | Mistura "Erro ao" e "Falha ao". |
| 21 | "Não foi possível copiar. Copie manualmente." (`ChannelsSection.tsx:155`) | Excelente: diz o que fazer. |
| 22 | "Falha ao consultar o gateway — tentando de novo..." (`ChannelsSection.tsx:1196`) | Tranquiliza, mas "gateway". |
| 23 | "Proteção contra robôs: {erro}" (`AiSection.tsx:1605`) | Erro de validação sem contexto; prefixo estranho. |
| 24 | "Por favor, selecione um setor" / "Configure o pipeline antes de continuar" (`OnboardingWizard.tsx:194,200`) | Polido, tom correto. |
| 25 | "Erro ao avançar. Tente novamente." (`OnboardingWizard.tsx:345`) | Bom: orienta. |
| 26 | "Este número pediu para não receber mensagens (opt-out). Enviar mesmo assim é responsabilidade da equipe." (`inbox/NewConversationModal.tsx:667`) | Claro e responsável. |
| 27 | "Mensagem antiga demais para exibir aqui" (`Inbox.tsx:1292`) | Honesto; sem solução. |

Padrões gerais: (a) estados vazios têm tom bom quando orientam (itens 3, 8, 10, 11, 21, 25) e ruim quando são só "Nenhum X encontrado"; (b) erros são quase sempre "Falha ao + verbo", sem causa; (c) mensagens de erro do servidor chegam via `lib/errors.ts` e podem exibir texto técnico.

---

## 5. Microtextos explicativos

### 5.1 `settings/AiSection.tsx`

Presentes e bons (curtos, em linguagem do cliente):

- "Responde clientes no WhatsApp — começa em modo sugestão, com revisão humana." (`:660`)
- "Gera rascunhos que sua equipe revisa e envia — nada sai sozinho." (`:1682`)
- "Mensagens que chegam dentro desse intervalo de silêncio viram uma resposta só." (`:1938`) — ótimo, explica o debounce sem o nome.
- "Fora dessa janela a IA não responde — a conversa espera por um humano." (`:1885`)
- "Palavras que fazem a IA parar na hora e chamar alguém do time." (`:2227`)
- "Desativável a qualquer momento" (`:246`); "Esta ativação fica registrada na auditoria com seu nome e a data." (`:1818`)

Longos ou técnicos:

- `:176-` / `:244-246` onboarding da IA: bom mas denso.
- `:278-` "Aceito e reconheço que a API não-oficial viola os Termos do WhatsApp e pode causar banimento permanente do número, inclusive com uso de IA." Importante legalmente, mas "API não-oficial" é jargão; vale reescrever mantendo o risco.
- `:296-305` aceite LGPD: três frases jurídicas ("controladora dos dados", `:1013`; "transferência internacional de dados", `:305`). Adequado como texto legal, ruim como tela principal.
- `:411` "No modo BYO a rota é uma só, para todos os produtos — e sem fallback." Incompreensível para leigos.
- `:565` "retém dados (retention, residência dataResidency) e sai do padrão zero-retention." Inglês e técnico.
- `:681` "...Cada imagem vai uma única vez ao provedor... Custo medido: cerca de US$ 0,0003 por imagem." Útil, mas longo e técnico (provedor, centavos de dólar).
- `:709, :725` "Tenta os modelos validados em ordem...", "Fixar um modelo desliga o fallover". Técnico.
- `:749` grupos: "Responde quando mencionada no grupo, resume a conversa e aponta oportunidades — nunca manda mensagem privada sozinha. Cada grupo é configurado à parte, e vem desligado..." Parágrafo único com 4 ideias.
- `:1753` "Autopilot libera com 10+ sugestões revisadas e 60%+ de aceitação" (regra do "gate"). Contém símbolos e jargão; ver `:1798` "O gate de métricas existe para...".
- `:1952-1956` "Guarda-corpos anti-loop (para quando o outro lado também é um bot), contados por conversa. Em branco = padrão (...). 0 = sem limite (use só em testes)."
- `:2066-2098` follow-ups: quatro variantes explicadas por frases longas; ok, mas muitas opções.
- `:2709-2711` opções de gasto: "Bloquear (atendente em rascunho + repasse; demais recursos suspensos)".
- Há jargão como "provedor", "roteamento", "rota", "zero-retention", "residência de dados".

Faltam explicações para: o que é "persona" versus "conhecimento" (existem rótulos `:1855` e `:1870` mas o campo "Persona" é nome que o leigo não entende); o que muda entre sugestão e autopilot antes de ativar (aparece apenas ao tentar).

### 5.2 `settings/ChannelsSection.tsx`

- Bom: "Escolha como este número será conectado." (`:1441`), "Recomendado. Aprovado pela Meta, com janela de 24h e templates." (`:1451`), "Aguardando leitura — o QR se renova sozinho." (`:1278`), passo-a-passo do QR "Aparelhos conectados → Conectar um aparelho" (`:1220`).
- Bom, honesto: aviso de risco do canal não oficial (`:1813-1821`) — cinco linhas, claras, usa "Use um número dedicado e descartável".
- Técnico: o passo a passo da Meta (`:526-534`) usa "Meta for Developers", "Phone Number ID", "WABA ID", "System User", "Business Manager", "App Secret" em inglês, sem links; só dá para seguir quem já é desenvolvedor.
- Técnico: "Para números via Cloud API (oficial), use esta URL de callback ao configurar o webhook" (`:488`), "O verify token de cada número..." (`:505`), "Os segredos ficam sempre mascarados..." (`:1663`).
- Provisionamento: "Provisionando instância no gateway..." (`:1765`), "Instância provisionada — mostre o QR para parear" (`:1766`), "Usado só uma vez para criar a instância — não é armazenado. A instância será criada com um..." (`:1955`), "O ID da instância não pode ser alterado." (`:1918`). Linguagem de infraestrutura; no modo gerenciado o usuário só precisa clicar em "Conectar".
- Transcrição: "Transcreve automaticamente os áudios recebidos dos contatos e os enviados pela equipe (pelo HNBCRM ou pelo celular). A transcrição fica no histórico e o Atendente IA a lê." (`:744`) — bom, mas uma frase longa.
- Celular tocando: "O HNBCRM fica invisível como aparelho conectado, então o WhatsApp continua tocando e notificando no telefone. Recomendado." (`:787`) — bom, explica o benefício.
- Histórico: "Recupera mensagens enviadas pelo celular que o CRM não recebeu" (`:977`), "O gateway guarda uma cópia das mensagens deste número e o CRM importa o..." (`:1023`).

### 5.3 `onboarding/*`

- Assistente de 5 passos: "Vamos personalizar seu CRM" / "Responda algumas perguntas para configurar tudo automaticamente" (`WizardStep1Welcome.tsx:95-98`), "Qual o setor do seu negócio?" (`:105`), "Qual seu principal objetivo?" (`:178`), "País padrão dos telefones" + "Usado quando um telefone é digitado ou importado sem o código do país (+DDI)..." (`:285,305`; "+DDI" é jargão).
- Passo 2: "Personalize seu Pipeline" / "Ajuste as etapas do seu funil de vendas" (`WizardStep2Pipeline.tsx:87-90`) — usa as duas palavras no mesmo bloco; placeholder "Ex: Pipeline de Vendas" (`:100`).
- Passo 3: "Explore o CRM com dados realistas gerados automaticamente" (`WizardStep3SampleData.tsx:43`) e lista "1 repasse IA-humano pendente" (`:27`), "3 conversas simuladas multicanal" (`:23`).
- Passo 4: "Adicione membros humanos e agentes de IA para colaborar no CRM" (`WizardStep4TeamInvite.tsx:57`); resultado "Agente IA criado. Gere a chave API em Configurações quando for usar." (`WizardInviteResults.tsx:164`).
- Passo 5: "Seu CRM está configurado e pronto para usar" (`WizardStep5Complete.tsx:39`).
- Checklist: "Parabéns! Todos os passos concluídos!" (`OnboardingChecklist.tsx:154`).
- Avaliação: tom amigável e curto; o onboarding NÃO explica IA, WhatsApp nem repasses; os termos "pipeline", "agentes de IA" e "repasse" entram sem definição. Não há passo para conectar o WhatsApp.
- Fusos do onboarding em português ("América/Nova York (GMT-5)", `WizardStep1Welcome.tsx:62-70`) mas em inglês em Configurações → Geral (`Settings.tsx:183-189`): inconsistência entre as duas telas.

### 5.4 Painel (vitrine de funcionalidades)

`DashboardOverview.tsx:656-760` lista "Pipeline Kanban — Gerencie leads com drag-and-drop entre etapas configuráveis", "Gestão de Leads — Qualificação BANT, temperatura, prioridade e campos personalizados", "Conversas Multicanal", "Repasses IA-Humano — Transferência inteligente de leads entre bots e humanos", "Auditoria Completa", "API REST", "Sistema de Webhooks", "Motor de Automações" (marcado "Em Breve"), "Paleta de Comandos — Busca rápida com Cmd+K". É texto de marketing técnico dentro do app, voltado a desenvolvedores, não a corretores.

---

## 6. Diferenças entre frontend, CHANGELOG e landing

Fontes: CHANGELOG.md (topo e contagens por `grep -c`), `components/LandingPage.tsx`.

| Conceito | App logado | Landing (`LandingPage.tsx`) | CHANGELOG.md |
|---|---|---|---|
| Fila de IA para humano | Repasses / Fila de Repasses | "Repasses IA ↔ Humano" + "Handoffs inteligentes entre agentes de IA e vendedores" (`:251-252`) | "repasse" (29 linhas) e "handoff" (43 linhas) usados juntos |
| WhatsApp não oficial | "WhatsApp não oficial" / "bridge" / "gateway" | "Canal WhatsApp — API oficial (Cloud API) ou bridge não-oficial" (`:234-235`) | "bridge" (23), "gateway" (19), "pareamento" |
| Caixa de mensagens | Caixa de Entrada / Conversas | "Caixa de Entrada Unificada" (`:229`) | "inbox" (42 linhas) vs "caixa de entrada" (7) |
| Funil | Pipeline (menu) | "Pipeline Kanban" (`:214`), "Configure seu pipeline" (`:609`) | "funil" (16) e "pipeline" (39), com "etapa" (6) e "estágio" (6) |
| IA principal | Atendente IA | "IA Copiloto & Atendente" (`:262`); "atendente virtual ... em modo sugestão" | "Atendente" (49), "Atendente IA" |
| Painel | Painel | "Dashboard Tempo Real" (`:297`) | "Painel" |
| Auditoria | Auditoria / Logs de Auditoria | "Auditoria Completa" (`:272`) | idem |
| Central | Central / Painel da Central | "Central de Atendimento" (`:256`), "Setores com filas, transferência de conversas entre atendentes e várias unidades" | "Central" |
| Campanhas | Campanhas | "Disparos segmentados ou por CSV, com limites anti-ban... opt-out automático" (`:241`) | "campanha" |
| Equipe | Equipe | "Equipe Humanos + IA" (`:267`), "Fluxos Multi-Agente" (`:530`), "Scoring de Leads com IA" (`:525`), "Motor de Automações" (`:515`) | idem em partes |
| Visões salvas | Visões (view) | "Visões Salvas" (`:287`) | "visões" |
| Tom | Informal, 2ª pessoa | Mistura de inglês técnico ("Multi-tenancy" `:292`, "Webhooks HMAC-SHA256" `:307`, "API Playground" `:406`, "Agent Skills" `:414`, "Servidor MCP" `:322`) | Interno: cita comandos (`/foco`, `/modo`), campos de código (`aiConfig...`), "PROD", "F1-F8", emojis (🔴 🔄 💡) |

Pontos de atenção:

- O CHANGELOG é descrito como "user-facing, PT-BR", mas o cabeçalho está em inglês ("All notable changes to HNBCRM (formerly ClawCRM)...") e as entradas recentes (0.76-0.78.1) falam de "relay", "gateway", "bridge", "gate", "debounce", "veto", "TTL", comandos de Telegram: é um registro técnico, não uma novidade para o cliente.
- A landing anuncia "bridge" e "anti-ban" a um público que talvez só queira "conectar meu WhatsApp".
- A landing diz "Pipeline Kanban", "Handoffs", "Multi-tenancy", "Scoring" — anglicismos que a própria UI logada já traduziu parcialmente (ex.: "Repasse").
- A landing usa "Gestão de Contatos"/"Gestão de Tarefas" (substantivo + de), enquanto o menu usa só o substantivo.

---

## Glossário proposto (rascunho)

Princípios: um nome por conceito; português do dia a dia; manter o vocabulário do WhatsApp (conversa, contato, mensagem, grupo, número); esconder o técnico em "Avançado".

| Termo atual | Termo proposto | Justificativa |
|---|---|---|
| Repasses / Fila de Repasses (menu) | **Requer atenção** (tela: "Precisam de você") | Diz o que a pessoa deve fazer; hoje "repasse" soa como transferência financeira. |
| Repasse (a ação), "repasse pendente" | **Pedido de ajuda da IA** / "A IA pediu ajuda" | Descreve o fato com palavras de gente. |
| Handoff | (nunca exibir; "pedido de ajuda") | Anglicismo; já tem tradução acima. |
| Aceitar repasse / Assumir | **Assumir a conversa** | Verbo único e direto. |
| Devolver à IA | **Deixar com a IA** (com instrução opcional: "O que a IA precisa saber") | Mais natural; mantém a função. |
| Caixa de Entrada / Entrada / Conversas / inbox | **Conversas** (menu, título, URL, mobile e textos) | É a palavra do WhatsApp; remove três sinônimos. |
| Pipeline / Board / Quadro | **Funil de vendas** (menu "Funil") | Corretor e dono de PME falam "funil". |
| Etapa / Estágio | **Etapa** | Um só termo; "estágio" sai de toda a UI. |
| Lead | **Cliente em potencial** (curto: "Oportunidade" no funil; "Lead" só como apelido) | Linguagem de quem não vem de marketing digital; decisão do dono sobre manter "lead" para quem já usa. |
| Contato | **Contato** | Já é o termo do WhatsApp; manter. |
| Atendente IA / Atendente virtual / Assistente / bot / robô | **Atendente com IA** (curto: "a IA") | Um nome para a IA que responde clientes. |
| Copiloto / Copiloto IA / Assistente no app | **Assistente da equipe** (ícone de faísca) | Distingue de "atendente": um fala com o cliente, outro ajuda o time. Alternativa: manter "Copiloto" se o dono gostar da marca. |
| Autopilot | **Responder sozinha** | Explica o efeito; evita anglicismo. |
| Modo sugestão / Rascunho da IA | **Você revisa antes de enviar** / "Resposta sugerida" | Descreve o controle, não o mecanismo. |
| Rascunho (campanha, post) | **Não publicada** / "Rascunho" só para campanhas | Evita dois sentidos de "rascunho". |
| Canais / Canal de aquisição | **Conexões** (conversas) e **Origem** (de onde veio o cliente) | Separa os dois significados de "canal". |
| Bridge / gateway / canal não oficial | **WhatsApp por QR code** (ou "Conexão por QR code") | Descreve o que o usuário faz; o aviso de risco permanece. |
| Cloud API oficial (Meta) | **WhatsApp oficial da Meta (API oficial)** | Mantém clareza sem sigla. |
| Provisionar instância / Parear | **Conectar número** | Verbo único; esconde infraestrutura. |
| Webhooks | **Avisos para outros sistemas** (em Avançado) | Concentra o técnico num lugar só. |
| Chaves API / Token | **Chaves de integração** (em Avançado) | Linguagem de produto; separa de quem não integra. |
| Auditoria / Logs de Auditoria | **Histórico de alterações** | Mais amigável e descritivo. |
| Central / Painel da Central | **Atendimento por unidade** (módulo opcional) | Remove a ambiguidade com Configurações → Central e com a "central" do dia a dia. |
| Unidade / Setor (Central) | **Unidade** e **Departamento**; "Ramo do negócio" no onboarding | Hoje "setor" tem dois sentidos. |
| Opt-out | **Quem pediu para não receber** (lista de bloqueio) | Remove anglicismo. |
| Follow-up | **Retorno** (ou "Lembrar de retomar") | Natural para vendas em português; ou manter "follow-up" se o público já usa. |
| Tag / Etiqueta | **Etiqueta** | Um nome só. |
| Persona | **Como a IA deve se comportar** | Descreve o campo. |
| Conhecimento | **O que a IA sabe sobre o seu negócio** | Idem. |
| Qualificação BANT | **Perfil do cliente** (orçamento, quem decide, necessidade, prazo) | O sigla BANT some; os quatro itens ficam. |
| Visão (Kanban/Lista/Salva) | **Modo quadro** / **Modo lista** / **Filtros salvos** | "Visão" é calco de "view". |
| Agente IA (membro) | **Assistente de IA** (na Equipe) | Evita colisão com o papel humano "Agente"; renomear o papel humano para "Atendente" ou "Vendedor". |
| Limites de resposta / guarda-corpos anti-loop | **Limite de respostas seguidas** | Remove metáfora técnica. |
| Fallback / Modelo e roteamento / BYO | **Escolha do modelo de IA** (Avançado) | Esconde detalhes para quem não é técnico. |
| Logs, Failed, "Falha ao..." | **"Não deu certo: …. Tente de novo."** | Padrão único de erro com ação. |
| Title Case x sentence case | **Sentence case em todo botão** ("Adicionar nota", "Excluir etapa") | Regra única, mais leve; corrigir "Nova Pipeline" → "Novo funil". |
