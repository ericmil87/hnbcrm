# Grupos de WhatsApp — STATUS / TODO por etapa

Plano: `docs/GRUPOS-WHATSAPP-PLAN.md`. Orquestração iniciada em 2026-09-16 (Fable orquestra; agentes Opus/Sonnet implementam). Regras para quem atualiza: marcar `[x]` só com teste verde; anotar decisões tomadas fora do plano em "Desvios"; nunca commitar (o Eric commita); sem browser/computer use nesta fase; nunca enviar mensagem real de WhatsApp nem mudar estado do gateway.

Legenda: `[ ]` a fazer · `[~]` em andamento · `[x]` feito · `[-]` descartado

## Resumo (2026-09-17)

**Concluídas:** F0 (medição, com a ressalva das fixtures sintéticas), F1 (núcleo
backend), F2 (UI base), F3 (publicações programadas, backend + UI), F4 (IA em
grupos), F5 (campanhas para salas e para membros), F5.5 (REST, MCP e
preferências) e F8 na parte de review + docs. **Nada commitado** — o Eric commita.

**Números finais:** suíte inteira **1272 testes verdes em 68 arquivos**; 13
arquivos de teste são de grupos e somam **403 testes**
(`lib/bridgeGroups` 28, `bridgeGroupIngress` 41, `bridgeGroupDispatch` 10,
`groupChats` 41, `lib/groupPostSchedule` 31, `lib/groupPostCore` 38,
`groupPosts` 46, `lib/groupAgentCore` 28, `groupAgent` 42, `copilotGroups` 22,
`lib/campaignAudience` 32, `campaignsGroups` 31, `groupsApi` 13).
`npm run lint` verde (tsc convex + app + node, `npx convex dev --once`,
`vite build`) e `npm run build` do mcp-server verde. 44 arquivos novos
(39 de grupos) e 77 tocados na árvore de trabalho.

**Sobras do review fechadas nesta rodada** (as três estão marcadas nas seções
abaixo): segurança 14 (`internalExecuteSendNow` revalida a org do canal), UI do
aceite `groupAutopilotAck` no `GroupAiPolicyModal`, e a parte 2 da correção 22
(o público `group_members` RECUSA quando a identidade própria do número é
desconhecida).

### Pendente

1. **E2E vivo no Grupo-Teste-Eric, com o Eric** — nada foi exercitado contra o
   gateway e nenhuma mensagem real saiu. Passos, na ordem:
   1. **Reassinar os eventos**: `GroupInfo`/`JoinedGroup` entraram em
      `BRIDGE_WEBHOOK_EVENTS`, e o wuzapi só reescreve `users.events` no
      `Connect()` — reconectar o canal em Configurações → Canais é o que faz o
      gateway passar a mandar os dois.
   2. **Ligar grupos no card do número** (aceite `bridgeGroupsAck`, D12) e
      "Atualizar lista" — conferir contra o `/group/list` real que a contagem de
      membros veio do `Participants.length`, não do `ParticipantCount`.
   3. **Acompanhar o Grupo-Teste-Eric**, ver a conversa aparecer no inbox com o
      filtro "Grupos", o painel de membros com telefone mascarado e o "você"
      marcado pelo servidor (`isSelf`).
   4. **Mandar uma menção ao número do CRM** na sala e conferir o rascunho da IA
      no inbox (modo sugestão), mais os recibos por membro no tique (`readBy`).
   5. **Publicação programada**: criar, usar "Testar agora" com `dryRun` (não
      escreve nada) e só então um envio real fora da agenda.
   6. **Campanha para 1 grupo** (`source: "groups"`, uma sala só) — validar o
      relatório por sala antes de qualquer teste do público `group_members`.
   7. **Revalidar as fixtures sintéticas** `bridgeGroupInfoEvent.json` e
      `bridgeJoinedGroup.json` contra os eventos reais que chegarem.
2. ~~**Cláusula de Termos / LGPD** (segurança 13)~~ — **FEITO em 2026-09-17.**
   `TermsPage.tsx` ganhou a cláusula 6 ("Grupos de WhatsApp": opt-in por grupo,
   controlador/operador sobre dados de terceiros, webhooks que carregam JID/LID e
   telefone, IA na sala, disparo para membros e direitos dos titulares) e
   `PrivacyPage.tsx` a cláusula 5 (finalidade, base legal a cargo do Cliente,
   retenção enquanto acompanhado, compartilhamento com provedor LLM e webhooks),
   mais a categoria de dados "membros de grupos de WhatsApp" na cláusula 2. As
   duas páginas foram renumeradas e a vigência passou a 17 de setembro de 2026.
   **Falta:** revisão jurídica pelo Eric antes de ligar em produção.
3. ~~**MCP `crm_update_notification_preferences` sem os flags novos**~~ (Desvio 10
   da F5.5) — **FEITO em 2026-09-17.** O schema zod declara os 19 flags de
   `PREFERENCE_FLAG`: além dos seis de grupo e de
   `aiDraftPending`/`campaignCompleted`/`campaignPaused`, também faltavam
   `taskDueSoon` e `taskCommentMention` (desde a v0.43). Doc da tool atualizada no
   README do mcp-server e em `.claude/skills/hnbcrm/references/API_REFERENCE.md`;
   `npm run build` do mcp-server verde.
4. **F6 (gestão avançada)** — criar grupo, adicionar/remover/promover membro,
   pedidos de entrada. **Aguardando aprovação do Eric**: é a operação com relato
   direto de banimento.
5. **F7 (Meta Groups API)** — **BLOQUEADA**. **Lembrete: detalhar a §14 do plano
   assim que o Eric aprovar o caminho do bridge.** O esboço já diz o essencial —
   máximo de 8 participantes por grupo, só o negócio cria, não existe
   `POST /participants` — e é isso que decide se a fase vale a pena.
6. **Achados do review aceitos sem correção**, com motivo registrado nas seções
   abaixo: `internalListDigestDue` varre `groupChats` com `.take(200)`
   deployment-wide; cada mensagem reescreve o array inteiro de participantes numa
   sala grande; o "dia" do teto por grupo é UTC, não o fuso da campanha; o anexo
   da biblioteca é uma linha de `files` apontada por N mensagens.

## F0 — Medição
- [x] `/group/list`, `/group/info`, `/user/lid`, `/user/info` medidos no Grupo-Teste-Eric (plano §1.1.1)
- [x] Fixture real de `Message` de grupo (texto, modo lid): `convex/__fixtures__/bridgeGroupMessage.json`
- [ ] Fixtures reais: `fromMe` em grupo, menção, quote, mídia, reação, `Receipt.MessageSender`, `ChatPresence` (precisa do Eric mandar no grupo + `GET /chat/history`)
- [ ] Fixtures reais: `GroupInfo`, `JoinedGroup` (precisam da assinatura nova na instância — E2E da F8). **A F1 criou fixtures SINTÉTICAS** (`convex/__fixtures__/bridgeGroupInfoEvent.json`, `bridgeJoinedGroup.json`, marcadas no próprio JSON) a partir das structs do whatsmeow — revalidar na F8 antes de tratar os nomes de campo como confirmados
- [x] Fixture real de `/group/list`: `convex/__fixtures__/bridgeGroupList.json` (extraída do §1.1.1; trava as 3 pegadinhas)

## F1 — Núcleo backend (bridge → conversa de grupo) — CONCLUÍDA (2026-09-16, sem commit)
- [x] Schema: `groupChats`, `conversations.kind/externalChatId/groupChatId` + `leadId` opcional, `messages.senderLid/senderPhone/senderName/senderContactId/mentions/quotedParticipantJid/readBy` + `leadId` opcional, `handoffs.leadId` opcional, `channelConfigs.bridgeGroupsEnabled/bridgeGroupsAck/bridgeLid/bridgeGroupsLastSyncAt`, `notifications.type` += `group_joined`/`group_mention` (+ flags em `notificationPreferences`), `aiConfig.groupAgentEnabled`
- [x] `BRIDGE_WEBHOOK_EVENTS` += `GroupInfo`, `JoinedGroup`
- [x] Parser: `group_message` (lid/pn, SenderAlt, PushName, menção, quote c/ participant, mídia), `group_reaction`, `group_info`, `joined_group`, `group_presence` — `lib/bridgeParse.ts`
- [x] Ingest: `bridge.internalIngestGroupMessage`; grupo desconhecido/não monitorado = no-op; `conversations.internalReceiveGroupMessage` / `internalReceiveGroupDeviceMessage`; mídia pelo mesmo `downloadInboundMedia` do 1:1 (allowlist/quota/25 MB/sem MediaKey); SEM `applyCampaignInboundHooks`; participantes atualizados (PushName + `contactId` quando o telefone já é contato)
- [x] `GroupInfo`/`JoinedGroup` → upsert/patch + timeline + webhooks `group.updated`/`group.left`/`group.joined` + notificação `group_joined`
- [x] `groupChats.syncGroups` (+ `Groups:null`, `ParticipantCount` da lista, 500 com `success:true`), `bridgeLid` via `/user/lid`
- [x] Dispatch: `internalGetDispatchContext` com `externalChatId`; quote com `participant` do autor; menção `MentionedJID`; reação/markread (um lote por autor)/presence para grupo; Meta recusa grupo com erro claro
- [x] Recibos em grupo → `readBy` (`MessageSender`, cap 50), status no 1º delivered/read e nunca rebaixa
- [x] Mutations/queries app: `groupChats.listGroups/getGroup/setMonitored/setAiPolicy/leaveGroup/joinByInviteLink/syncGroups` + `acceptGroupsAck`/`setGroupsEnabled`; `getConversations`/`getConversationById` com `kind` + `groupChat`; `getMessages` com `senderContact`; `sendMessage` aceita `mentions`
- [x] Audit + webhooks (`llmsTxt.ts`, `DevelopersPage.tsx`) + backup (`BACKUP_TABLES`) + cascata de exclusão de canal (`internalCascadeDeleteChannelGroups`, batched)
- [x] As 3 cópias do núcleo de side effects aceitam conversa sem lead (`lib/outboundSideEffects`, `sendMessage`/`internalSendMessage`, `scheduledMessages.deliver`) — fluxo 1:1 inalterado
- [x] Testes: `lib/bridgeGroups.test.ts` (28), `bridgeGroupIngress.test.ts` (24), `bridgeGroupDispatch.test.ts` (10), `groupChats.test.ts` (27) = 89 novos; suíte inteira **951 verdes** em 60 arquivos; `npm run lint` verde (tsc convex + app + node, `convex dev --once`, vite build)

## F2 — UI base — CONCLUÍDA (2026-09-16, sem commit)
- [x] Inbox: conversa de grupo na lista (ícone `Users`, subject, "N membros"), filtro segmentado Todas/Diretas/Grupos persistido em `localStorage`, `senderName` + avatar + cor estável por `senderLid ?? senderPhone` na bolha, chip do contato quando o membro já é contato, menção recebida em negrito, `readBy` no tooltip do tique, "digitando…" agregado, `@` no composer com autocomplete dos membros (texto `@<nome>` + `mentions[]` no envio), header com subject + botão "N membros", sem funil/"Ver lead", menu ⋮ com Ver membros / Resumo por IA (desabilitado, F4) / Parar de acompanhar / Sair do grupo, sem controles de IA e sem "Devolver à IA"
- [x] Slide-over de membros (`src/components/inbox/GroupMembersPanel.tsx`): busca, badge admin/dono, "você", telefone mascarado (inteiro só com `inbox:view_all`), chip do contato, "Criar lead deste membro", seleção múltipla com "Criar leads dos selecionados" (sequencial, com progresso) e "Disparar para selecionados" desabilitado (gancho `onDispatchSelected` p/ F5)
- [x] Canais → card do número bridge → `src/components/settings/BridgeGroupsPanel.tsx`: interruptor + modal de aceite (D12), "Atualizar lista" com `bridgeGroupsLastSyncAt` relativo, lista com membros/admin/anúncio/temporárias/"ativo há X", por grupo Acompanhar + IA (modal) + "Abrir no inbox" + Sair, "Entrar por link" em duas etapas (prévia → confirmar)
- [x] Página `/app/grupos` (`src/components/groups/GroupsPage.tsx`, rota lazy + item "Grupos" na sidebar e no menu "Mais", gate `inbox:view_own`) com abas Grupos e Publicações (`groups/posts/GroupPostsTab.tsx` = STUB da F3); aba "Grupos" no `ContactDetailPanel`
- [x] Backend acrescentado (só em `convex/groupChats.ts`): `listChannelGroupSettings`, `createLeadFromMember`, `listGroupsForContact`, `selfKey` no retorno de `getGroup`; 9 testes novos em `groupChats.test.ts`
- [x] `npm run lint` inteiro verde (tsc convex + app + node, `npx convex dev --once`, `vite build`) e `npm run test` verde (1034 em 62 arquivos, já com os testes da F3 em curso)

## F3 — Publicações programadas — BACKEND + UI CONCLUÍDOS (2026-09-16, sem commit)
- [x] Schema `groupPosts` (+ `lastSlotKey`, `channelConfigId` denormalizado, `tickToken`/`schedulerFnId`/`nextRunAt`, `pending`, `stats`, `timeline` cap 100; índices `by_organization`, `by_organization_and_status`, `by_channel_config`, `by_status_and_next_run`) + `BACKUP_TABLES` += `groupPosts` + `channelPacing.groupPostDaily` + `notifications.groupPostId` + `aiConfig.products.groupPosts` + `agentRuns.kind` += `group_post`
- [x] `lib/groupPostSchedule.ts` (puro: `validateGroupPostSchedule`, `nextRunAt` c/ DST e jitter determinístico, `slotKey` p/ idempotência, `describeSchedule` PT-BR) — 25 testes verdes (2026-09-16, sonnet)
- [x] `lib/groupPostCore.ts` (puro: `pickLibraryItem` sequencial/aleatório c/ `noRepeatWindow`, `buildPostVars`/`renderPostText`, `validateGroupPostContent`, `generateAtFor`, teto diário por canal, `appendPostTimeline`) + `lib/groupPostPrompt.ts` (puro: prompt da "mensagem do dia" + `cleanGeneratedPost`) + `lib/groupPostOps.ts` (agendamento/timeline/pausa/encerramento compartilhados)
- [x] `groupPosts.ts`: `list`, `get`, `getHistory`, `create`, `update`, `activate`, `pause`, `end`, `remove`, `approvePending`, `rejectPending`, `sendNow({dryRun})`
- [x] Worker `groupPostWorker.tick` (tickToken, biblioteca sequencial/aleatória c/ noRepeatWindow, IA gera N min antes, aprovação, missed skip/send, canal caído/grupos desligados/sessão banida pausam, `campaignFrozenUntil` adia, teto 10 slots/dia por canal, slot atrasado > 1 h é pulado, destino perdido sai da lista) + `generate`/`internalStorePending`/`internalRecordGenerateFailure` + `internalSendNow`/`internalExecuteSendNow` + `internalWatchdog` (cron horário)
- [x] Notificações `group_post_pending/failed` (in-app + e-mail, `lib/notify.ts` + `emailTemplates.ts`), audit (`entityType: "groupPost"`, ativar e "sem aprovação" = `high`), webhooks `group.post.activated|pending|sent|failed|paused|ended` (`llmsTxt.ts` + `DevelopersPage.tsx`), `NotificationPanel` com ícone + deep-link `/app/grupos?post=<id>`
- [x] UI: aba Publicações em `/app/grupos` (`groups/posts/`, o stub da F2 substituído) — lista com pill de status/agenda/alvos/próximo envio e badge "aguardando aprovação", filtros por status, wizard 3 passos (destinos → agenda → conteúdo/aprovação) com prévia `WhatsAppPreview` por item, detalhe em slide-over (card do pendente com edição inline + contagem regressiva, destinos, canal, stats, ativar/pausar/encerrar/excluir, "Testar agora" por `dryRun` e envio real atrás de digitar ENVIAR) e histórico com link para a mensagem no inbox; deep-link `?post=<id>` abre o detalhe (destino da notificação `group_post_pending`). `npx tsc -p tsconfig.app.json --noEmit` sem erros nos arquivos da fase e `npm run build` verde
- [x] Testes: `lib/groupPostSchedule.test.ts` (25), `lib/groupPostCore.test.ts` (38), `groupPosts.test.ts` (37, fake timers) — suíte inteira **1034 verdes** em 62 arquivos; `npm run lint` verde

## F4 — IA — CONCLUÍDA (2026-09-16, sem commit)
- [x] `groupAgent`: gatilho por menção/quote/nosso número digitado/palavra-chave opt-in (`ai.keywords`), fila `aiReplyQueue` com `origin:"group_mention"` (debounce + coalescing + backoff reaproveitados), elegibilidade PRÓPRIA (`evaluateGroupEligibility`, 14 condições), tetos por grupo (10/h, 30/dia; 0 = sem teto), prompt "VOCÊ ESTÁ NUM GRUPO" com as regras da sala, histórico `membro:<nome>`/`ia`/`equipe` no envelope não-confiável, tools `replyToGroup`/`requestGroupHandoff`/`flagOpportunity`, `suggest` default com o mesmo `AiDraftCard` (aceitar envia com `mentions`), autopilot só com o gate do atendente vencido ou `autopilotEarlyAck`, commits transacionais que re-checam tudo
- [x] Resumo sob demanda (`api.groupChats.summarizeGroup`, 24 h/7 dias, grava `groupChats.summary`) + `GroupSummaryModal` no menu ⋮ do grupo + digest diário opt-in (`ai.dailyDigestAt`, cron horário `internalRunGroupDigests`, notificação `group_digest`) + alerta por palavra sem LLM (`ai.alertKeywords` → `group_mention`)
- [x] Radar de oportunidade (`ai.opportunityRadar`, default OFF): lote de 15 min por grupo com coalescing, 1 chamada JSON (`max_tokens` 300), notificação `group_opportunity` com `groupChatId` + `data.participantKey`/`data.suggestedDm` e botão "Criar lead + abrir no privado" no sino (a IA NUNCA manda DM)
- [x] Copiloto: 4 tools de leitura (`listGroups`, `getGroupDetail`, `listGroupPosts`, `getGroupPostHistory`) + 6 de escrita (`getGroupSummary`, `createGroupPostDraft`, `pauseGroupPost` diretas; `activateGroupPost` e `sendGroupMessage` via `pendingActions`; `createLeadFromGroupMember`), executores em `lib/groupCopilotTools.ts`, `TOOL_DENYLIST` += os internals de grupo que carregam o contexto do canal
- [x] `products.groupAgent` (rota por produto) + `getAiStatus.groupAgentEnabled`/`products.groupAgent|groupPosts` + `setFeatureToggles({groupAgentEnabled})` + card "IA em grupos de WhatsApp" em Configurações → IA (com a rota das publicações no mesmo card); simulador com alternador "grupo" + `senderName` por turno
- [x] Testes: `lib/groupAgentCore.test.ts` (41), `groupAgent.test.ts` (38), `copilotGroups.test.ts` (21) + 3 casos novos em `agentToolSecurity.test.ts` = 103 novos; suíte inteira **1193 verdes** em 67 arquivos; `npm run lint` verde (tsc convex + app + node, `convex dev --once`, `vite build`)
- [ ] E2E vivo (F8): menção real no Grupo-Teste-Eric, resumo, radar e o rascunho no inbox — nada foi exercitado contra o gateway

## F5 — Campanhas: grupos e membros — CONCLUÍDA (2026-09-16, sem commit)
- [x] Schema: `campaigns.audience.source` += `groups`/`group_members` + `audience.groupChatIds`/`memberFilters` (validator novo `campaignMemberFiltersValidator`), `campaigns.safety.groupMembersDmAck`, `campaigns.stats.byGroup` (contador por grupo de origem), `campaignRecipients.groupChatId`/`sourceGroupChatId`/`memberName`
- [x] `audience.source:"groups"` (D9): 1 destinatário por sala (`phone` = JID inteiro), `groupCaps` (20 salas/dia, 8/h, ≥60 s; teto duro 50/dia) via `safeDefaultsFor({audienceSource})` + `clampToHardCap`, worker posta na conversa do grupo sem criar contato/lead, `checkNumbersFirst` ignorado, relatório por sala
- [x] `audience.source:"group_members"` (D15): `lib/campaignAudience.ts` (`buildGroupMembersAudience` com funil total→com telefone→sem duplicata→sem opt-out→finais, dedupe entre grupos pelo 1º escolhido, self nunca entra, 5 filtros do §7.1), `sourceGroupChatId`/`memberName`, `groupMemberCaps` (10/grupo/dia no modo seguro, teto duro 50) com espalhamento em dias via `scheduledFor` no snapshot, aceite `groupMembersDmAck` no lançamento, tag `grupo:<slug>` no lead criado
- [x] Wizard: cartões "Grupos" e "Membros de grupos" (só canal bridge com sala acompanhada), seleção múltipla, filtros do §7.1, prévia com funil + amostra mascarada + "N destinatários → ~M dias", aceite no passo Revisão; 3 portas de entrada (`/app/campanhas?novo=1&source=…`, botão em `/app/grupos`, menu ⋮ do grupo no inbox e "Disparar para selecionados" no painel de membros)
- [x] Relatório por grupo de origem (`getCampaignReport().byGroup`, seção em `CampaignDetail`); REST (`preview-audience`, `create`, `launch`, `recipients`, `safe-defaults`), MCP (`crm_create_campaign`, `crm_launch_campaign`, `crm_add_campaign_recipients`) e copiloto (`previewCampaignAudience`/`createCampaignDraft` por NOME do grupo); `llmsTxt.ts` + `apiRegistry.ts` documentados
- [x] Gancho `replied` específico de grupo (`applyCampaignGroupReplyHook`) chamado no ingest de grupo — SEM opt-out (D13)
- [x] Testes: `lib/campaignAudience.test.ts` (23), `lib/campaignPacing.test.ts` (+10, total 28), `campaignsGroups.test.ts` (25); suíte inteira **1193 verdes** em 67 arquivos e `npm run lint` verde (tsc convex + app + node, `convex dev --once`, `vite build`)
- [x] **Seleção de membros na prévia (2026-09-17):** `memberFilters.includeKeys?: string[]` (chave do participante = `lid ?? phone`, teto 1024 recusado no rascunho, chave desconhecida IGNORADA — a seleção recorta o público, nunca cria destinatário) aplicado como ÚLTIMO filtro do `buildGroupMembersAudience`, de modo que `not_selected` significa "passaria, mas ninguém marcou" e os outros motivos continuam vencendo (admin escolhido com `excludeAdmins` sai como `admin`). A prévia de `group_members` passou a devolver `members[]` (todo participante ainda na sala, cap `MEMBER_LIST_MAX` = 500 com `membersTruncated`/`membersTotal`/`membersLimit`): `{ key, name?, phoneMasked, phone?, isAdmin, groupChatId, groupSubject, isContact, excludedReason? }` — o telefone CRU só sai para quem tem `inbox:view_all` (decidido no servidor por `groupsActorHas` e filtrado dentro do builder, via `memberList.revealPhones`). Seção "Quem vai receber" em `GroupAudienceTabs.tsx`: busca, checkbox por pessoa, "Selecionar todos os elegíveis"/"Limpar seleção", "N selecionados de M elegíveis", excluídos esmaecidos com o motivo, lista truncada desliga a seleção individual (marcar parte de 500 de 900 cortaria o resto em silêncio). Marcar todos grava `undefined`, não a lista inteira. Copiloto/REST/MCP aceitam `includeKeys` dentro de `memberFilters`; o audit do lançamento grava `selectedMembers: N` em vez das 1024 chaves. Testes: `lib/campaignAudience.test.ts` (44 no total) e `campaignsGroups.test.ts` (39 no total, incluindo a regressão do modo seguro que realinha o pacing em vez de exigir "ENTENDO")

## F5.5 — REST/MCP/preferências — CONCLUÍDA (2026-09-16, sem commit)
- [x] REST `/api/v1/groups/*` (6 rotas): `GET /groups` (`channelConfigId?`, `includeRemoved?`), `GET /groups/get?groupChatId=` (com participantes + `selfKey`), `GET /groups/messages?groupChatId=&limit=` (mais RECENTES primeiro, autor do grupo resolvido), `POST /groups/send {groupChatId, content, mentions?, replyToMessageId?, attachments?}`, `POST /groups/monitor {groupChatId, monitored}`, `POST /groups/sync {channelConfigId}`
- [x] REST `/api/v1/group-posts/*` (8 rotas): `list`, `get`, `create`, `update`, `activate`, `pause`, `approve`, `reject` — caminhos FLAT, como as campanhas
- [x] `convex/groupsInternal.ts` (wrappers `internal*` com `actorMemberId`/`via`) + `convex/lib/groupAuth.ts` (`authorizeGroups`, espelho de `campaignAuth.ts` com a CATEGORIA como argumento — grupos atravessam `inbox`, `settings` e `campaigns`); `groupChats.ts` e `groupPosts.ts` convertidos ao padrão `xArgs`/`xHandler`
- [x] `ROUTE_PERMISSIONS` + preflight OPTIONS das 14 rotas; `routerPermissions.test.ts` verde (19 testes, completude + gate por handler)
- [x] MCP: `mcp-server/src/tools/groups.ts` com 8 tools (`crm_list_groups`, `crm_get_group`, `crm_send_group_message`, `crm_list_group_posts`, `crm_get_group_post`, `crm_create_group_post`, `crm_pause_group_post`, `crm_approve_group_post`), registradas em `src/index.ts`; `npm run build` do mcp-server verde
- [x] Contagem de tools 58 → 66 em `mcp-server/package.json`, `mcp-server/README.md` (seção nova "WhatsApp Groups"), `README.md`, `llmsTxt.ts` e `DevelopersPage.tsx`
- [x] Docs da API: `llmsTxt.ts` (tabela rota→permissão + seções REST "WhatsApp Group Endpoints" e "Scheduled Group Post Endpoints" + tools MCP), `src/lib/apiRegistry.ts` (categoria "Grupos", 14 endpoints no playground), `DevelopersPage.tsx` (tabela de 8 tools), `.claude/skills/hnbcrm/references/API_REFERENCE.md` (14 linhas na tabela + seção "WhatsApp Groups" com as regras para agentes)
- [x] Preferências de notificação: os 6 tipos de grupo (`groupJoined`, `groupMention`, `groupPostPending`, `groupPostFailed`, `groupOpportunity`, `groupDigest`) em `DEFAULTS`/`getMyPreferences`/`updateMyPreferences` e numa seção "Grupos de WhatsApp" em `NotificationPreferences.tsx`
- [x] Filtro de canal na aba Publicações (`GroupPostsTab.tsx`), visível só com 2+ canais com grupos ligados — fecha o Desvio 6 da "F3 UI"
- [x] Testes: `convex/groupsApi.test.ts` (13); suíte inteira **1209 verdes** em 68 arquivos; `npm run lint` verde (tsc convex + app + node, `convex dev --once`, `vite build`) e build do mcp-server verde
- [ ] E2E vivo (F8): nenhuma rota foi exercitada contra o gateway e nenhuma mensagem real saiu

## F6 — Gestão avançada (só com aprovação do Eric)
- [ ] criar grupo, add/remove/promote/demote, link de convite, pedidos de entrada — atrás de "ENTENDO" + tetos + audit

## F7 — Meta Groups API (BLOQUEADA até o OK do Eric no bridge)
- [ ] detalhar §14 → implementar

## F8 — Review, E2E vivo e docs (checklist)
- [x] code-review + security-review das fases (25 + 14 achados; correções na seção seguinte)
- [ ] E2E vivo no Grupo-Teste-Eric (assinar eventos, monitorar, menção, IA suggest, publicação, campanha) — com o Eric (passos no Resumo)
- [x] CLAUDE.md (2 parágrafos "Grupos de WhatsApp (v0.57)") e `llmsTxt` (REST/MCP)
- [x] landing (card "Grupos de WhatsApp" + contadores 113 endpoints / 66 tools MCP) e cláusula de Termos/LGPD (segurança 13) — 2026-09-17

## F8 — Review e correções

Itens do review de correção (`review-correctness`, 2026-09-16). Frente
**publicações + campanhas + UI** (itens 7–11, 18–20, 24–25). A frente do núcleo
(1–6, 12–17, 21–23) é de outro agente.

### Corrigidos

- **7 — `slotKey` colidia com jitter.** A chave do slot passou a NASCER com o
  agendamento: `nextRun(schedule, after, {seed})` devolve `{at, slotKey}` e o par
  é gravado em `groupPosts.nextRunAt` + `nextSlotKey` (campo novo). `nextRunAt()`
  virou um wrapper fino do `at` (a UI e a prévia seguem usando). `slotKey()`
  continua existindo só como FALLBACK para documento antigo. `validateGroupPostSchedule`
  passou a recusar `jitterMinutes >= smallestTimeGapMinutes(times)` — com dois
  horários a 20 min e jitter de 30, um disparo invadia o horário seguinte.
  Arquivos: `lib/groupPostSchedule.ts`, `lib/groupPostOps.ts` (`computeNextRun`),
  `groupPostWorker.ts`, `groupPosts.ts`, `lib/groupCopilotTools.ts`, `schema.ts`.
- **8 — a prévia do "enviar agora" apagava destinos.** `pruneTargets` ganhou
  `opts.persist`; o caminho `dryRun` passa `persist: false` e não escreve nada
  (nem destino, nem linha do tempo). Além disso o destino inválido não sai mais
  na primeira ocorrência: fica marcado com `targets[].missingSince` (campo novo) e
  só é removido depois de `TARGET_GRACE_MS` (24 h) — um grupo desmarcado por
  engano volta sozinho quando o operador conserta.
- **9 — `group_members` estourava o limite de transação.** O conjunto bruto passou
  a ser TRUNCADO no teto ANTES do loop de leituras por telefone (era o bug: o
  `limit` só valia na chamada final do builder), e os filtros que dependem de
  leitura (`activeKeys`, `excludeGroupChatIds`) são resolvidos antes dele.
  `GROUP_MEMBERS_SNAPSHOT_MAX` caiu de 2.000 para **800** — o orçamento medido é
  ~4 faixas de índice por membro (3 no resolve + 1 no insert) contra o limite de
  4.096 do Convex, e com os dois filtros ligados a transação falhava por volta de
  1.365. `activeKeysForGroups` ganhou teto TOTAL (`ACTIVE_SCAN_TOTAL_MAX` = 12.000
  docs) além do teto por sala. O builder passou a devolver `truncated`/`overLimit`
  e a prévia mostra "Público maior que o teto de N: M pessoa(s) ficam de fora"
  (antes o número 2.000 estava escrito na mão na tela).
- **10 — espalhamento group-major.** `assignSpreadDays` mantém o dia por grupo mas
  devolve a lista em ordem DIA CRESCENTE, intercalando os grupos (round-robin)
  dentro de cada dia. E `nextPendingRecipient` deixou de ler "os 50 primeiros por
  criação": índice novo `campaignRecipients.by_campaign_and_status_and_scheduled`
  (`scheduledFor` ausente ordena primeiro = pronto agora).
- **11 — "Disparar para selecionados" contornava o D15.** Helper novo
  `targetsGroupMembers(audience)` em `lib/campaignPacing.ts` (true para
  `group_members` E para `manual` com `audience.groupChatIds`). Passou a valer em
  três lugares: o aceite `groupMembersDmAck` no `launchCampaign` (+ registro em
  `safety` e no audit), o `perGroupPerDay` do `campaignWorker.tick`, e o
  `byGroup` do relatório. `addManualRecipients` também espalha em dias quando há
  grupo de origem. UI: `needsGroupMembersDmAck` no `CampaignWizard`/`StepReview`.
- **18 — blip da sessão pausava para sempre.** Estado transitório
  (`disconnected`) agora ADIA com backoff (`CHANNEL_RETRY_DELAYS_MS` = 2/5/15 min,
  contador em `groupPosts.channelRetries`, campo novo, zerado quando o canal
  responde) e só pausa depois de esgotar as tentativas; `banned` continua pausando
  na hora. E RETOMAR uma publicação já ativada virou `campaigns:manage` — o par do
  `pause`, que também é `manage`. A PRIMEIRA ativação segue exigindo `campaigns:full`.
- **19 — editar publicação ativa engolia o slot.** `update` passou a olhar se o
  `nextRunAt` já venceu sem ter sido resolvido: sem mudança de agenda, PRESERVA o
  par (`nextRunAt`, `nextSlotKey`) e reagenda o tique para agora; com mudança de
  agenda, grava um `skipped` explícito na linha do tempo e nas `stats` antes de
  seguir para o próximo horário.
- **20 — deep-link inválido derrubava a página.** `<ErrorBoundary key={id}
  fallback={<></>}>` em volta de `GroupPostDetail` (`GroupPostsTab`) e de
  `CampaignWizard`/`CampaignDetail` (`CampaignsPage`), como o `?conversation=` do
  inbox já fazia. Somado a isso: `StepChannel` limpa `audience.groupChatIds` ao
  trocar de canal, e `GroupAudienceTabs` filtra a seleção contra os grupos
  carregados (`useValidSelection`) antes de chamar `previewAudience`.
- **24 — desligar o interruptor de grupos.** `ConfirmDialog` no ramo que desliga,
  dizendo quantos grupos serão desmarcados e que religar NÃO restaura as escolhas.
- **25 — `0` nos tetos da IA.** Legenda "0 = sem limite" nos dois campos do
  `GroupAiPolicyModal` + aviso âmbar quando algum dos dois está em 0, apontando
  para o modo "Desligada".
- **Extra (pedido do lead) — aceite do autopilot em grupo.** A mutation
  `aiSettings.setGroupAutopilotAck` já existia quando cheguei: o modal agora lê
  `getAiStatus().groupAutopilotAckDone` e, ao escolher "Autopilot" sem o aceite,
  mostra o aviso de risco + botão "Entendo o risco — ativar" (`settings:manage`;
  sem permissão, orienta a pedir a um administrador).

### Achados menores corrigidos (nos meus arquivos)

- `lib/campaignAudience.ts:484` — funil truncado: `truncated`/`overLimit` no
  resultado, `afterFilters` conta quem passou nos filtros e `final` quem a
  campanha leva (só divergem quando o teto corta).
- `campaigns.ts:809` — `byGroup` agora inclui a campanha `manual` vinda do painel
  de membros (era justo a porta que carimba `sourceGroupChatId` para isso).
- `campaigns.ts:2065` — exceção em `snapshotGroupAudience` deixava a campanha
  presa em `scheduled` com total 0 e sem rastro: agora vira `pauseCampaignCore`
  com o motivo.
- `groupPostWorker.ts:1250` — o watchdog escreve na linha do tempo no MÁXIMO uma
  vez por dia (cap 100 FIFO; um laço de alguns dias apagava o histórico de envios).
- `groupPostWorker.ts:785` — `internalStorePending` valida um
  `contentFingerprint` do `content.ai` tirado no início da geração; conteúdo
  editado durante a action descarta o texto em vez de virar pendente com o prompt
  antigo.
- `lib/groupPostSchedule.ts:36` — mensagem do `activate` diz "nos próximos 400
  dias", em vez de sugerir que a agenda acabou.
- `posts/PendingApprovalCard.tsx:67` — com prazo vencido o card distingue "ainda
  publica se o tique chegar em até 1 h" de "passou de 1 h: este horário será
  pulado" (o `SLOT_GRACE_MS` do worker).

### Encostam nas duas frentes (resolvidos, anotados para não se perderem)

- **Segurança 14 — `internalExecuteSendNow` não revalidava a org do canal.** Ficou
  igual ao `tick`: `config.organizationId !== post.organizationId` recusa o envio.
  A guarda e o teste ("envio real revalida a organização do canal, como o tique")
  entraram por `fix-core` dentro de `groupPostWorker.ts`/`groupPosts.test.ts`;
  verificado no arquivo.
- **Correção 22, parte 2 — público de membros com identidade própria desconhecida.**
  A causa raiz ficou com a outra frente (`channelConfigs.internalLearnBridgeIdentity`
  aprende `bridgeLid`/`bridgePhone` de uma mensagem `fromMe` de grupo). A RECUSA
  também: `groupsWithUnknownSelf` + `unknownSelfMessage`, com a prévia devolvendo
  `blockedReason` em vez de LANÇAR (uma query que lança apagaria o passo do
  wizard — a lição do item 20) e o snapshot pausando a campanha com o motivo.
  Escrevi uma versão paralela disso e a REMOVI ao ver a da outra frente, que é
  melhor. Ficou meu o teste que cobre os dois lados da porta: a prévia bloqueada
  com `blockedReason` e o público "Grupos" seguindo normal (ele não precisa saber
  quem somos dentro da sala). A UI de `GroupAudienceTabs.tsx` já mostra o motivo.

### NÃO corrigidos (com motivo)

- `lib/exportSanitize.ts:88` (`groupPosts.schedulerFnId` fora da `DENY_PATHS`) —
  arquivo de outra frente nesta rodada; avisado ao agente dono.
- `lib/campaignPacing.ts:454` (o "dia" do teto por grupo é UTC, não o fuso da
  campanha) — exige passar o fuso por `capsExceeded`, `bumpSourceGroupCounter` e
  `nextPendingRecipient`, e hoje TODOS os contadores de canal usam dia UTC.
  Mudar só o de grupo criaria duas noções de "hoje" no mesmo tick.
- `lib/groupPostSchedule.ts:123` (horário local inexistente no início do DST
  publica 1 h antes) — o Brasil não tem DST; o seletor oferece New York e Lisboa,
  onde o efeito é 1 h em um dia do ano.
- `groupPostWorker.ts:339` (o anexo da biblioteca é UMA linha de `files` apontada
  por N mensagens; apagar a primeira mensagem quebra os slots seguintes) — a
  correção fica em `lib/fileRefs.ts`/`files.ts`, fora desta frente.
- Itens 1–6, 12–17, 21–23 e os menores em `conversations.ts`, `groupChats.ts`,
  `groupAgent.ts`, `copilot.ts`, `Inbox.tsx`, `GroupMentionComposer.tsx`,
  `BridgeGroupsPanel.tsx:340`/`GroupsPage.tsx:205` ("ativo sem atividade") — outra
  frente.
- **Parte server do item 24**: `setGroupsEnabled(false)` continua desmarcando
  `monitored` e arquivando as conversas (não "suspende"). Mudar isso é
  `convex/groupChats.ts`, da outra frente; a UI já avisa o que vai acontecer.

### Frente núcleo + IA + segurança (correção 1–6, 12–17, 21–23; segurança 1–12, 14)

Review de correção `review-correctness` e review de segurança `review-security`
(ambos 2026-09-16). A frente de publicações/campanhas/UI está acima.

#### Corrigidos — review de CORREÇÃO

- **1 — encaminhar publicava na sala inteira.** `conversations.forwardMessage`
  recusa destino de grupo E origem de grupo (mensagem de dezenas de terceiros não
  sai por um clique); `ForwardModal` filtra `kind === "group"` da lista de
  destinos e o botão "Encaminhar" some da bolha dentro de uma sala
  (`MessageActionsBar.onForward` virou opcional).
- **2 — envio em sala sem guarda.** Helper único
  `assertGroupConversationSendable` em `convex/lib/groupGuard.ts` (acompanhado,
  não saímos, grupos ligados no número), chamado em `sendMessage`,
  `internalSendMessage` (REST/MCP), `forwardMessage`, `scheduledMessages.schedule`
  e `scheduledMessages.deliver` (aí virando `status: "failed"` com o motivo, em
  vez de publicar). `setConversationArchived(false)` também passa por ele: a
  conversa de uma sala desmarcada não volta ao inbox por `inbox:reply`.
- **3 — `GET /api/v1/conversations` devolvia salas.** `internalGetConversations`
  ganhou `kind` com DEFAULT `direct`; a rota aceita `?kind=direct|group|all` e
  recusa outro valor com 400. Toda linha carrega `kind` explícito e a de grupo
  carrega `groupChat`. Documentado em `llmsTxt.ts`, `apiRegistry.ts` e no
  `crm_list_conversations` do MCP (que ganhou o mesmo parâmetro).
- **4 (= segurança 1) — telefone de membro de sala NÃO acompanhada.** Ver abaixo.
- **5 — os tetos da IA paravam de valer na sala movimentada.**
  `countGroupAiReplies` passou a ler `.order("desc")`: em ordem ascendente o
  `.take(300)` pegava as mensagens MAIS ANTIGAS das últimas 24 h, então numa sala
  com mais de 300 mensagens/dia as respostas recentes da IA ficavam fora da
  janela e `teto_hora`/`teto_dia` nunca disparavam. Espelha `countAiReplies` do
  atendente 1 a 1.
- **6 — aceitar repasse de grupo matava a IA para sempre.** `acceptHandoffCore`
  grava `aiPausedUntil = now + GROUP_HANDOFF_PAUSE_MS` (24 h) quando a conversa é
  de grupo, e mantém `MAX_SAFE_INTEGER` no 1 a 1. "Devolver à IA" passou a
  existir para sala: item no menu ⋮ da conversa (aparece só com a IA pausada) e
  `attendant.returnToAi` com ramo próprio de grupo — despausa, cancela o repasse
  pendente daquela conversa, grava a instrução como nota da equipe e audita. NÃO
  dispara turno: o gatilho do agente de grupo é a MENÇÃO, e publicar um texto
  avulso numa sala é escrever para dezenas de pessoas sem ninguém ter perguntado.
- **12 (= segurança 6) — `.take(100)` de repasses pendentes.** Índice novo
  `handoffs.by_conversation_and_status` e consulta direta com `.first()`, nos
  dois pontos: a deduplicação de `createHandoffCore` (repasse sem lead) e a
  elegibilidade do agente de grupo.
- **13 — card de repasse de grupo sem título.** `handoffs.subjectLabel` virou
  campo persistido (só quando não há lead) e `enrichHandoffs` devolve `title`
  (lead ou sala) + `isGroup`. `HandoffQueue` mostra o nome da sala com ícone de
  grupo e "Grupo de WhatsApp" no subtítulo; `HandoffPeekSlideOver` deixou de
  dizer "Repasse — Lead". Documentado em `llmsTxt.ts` (a REST devolve os dois).
- **14 — rejeitar com instrução jogava a instrução fora.**
  `attendant.internalQueueInstructedTurn` ganhou ramo de grupo ANTES do
  `getLeadRef` (era ali que a instrução morria): a instrução vira nota da equipe
  da sala, o repasse pendente é cancelado e a conversa despausa. O texto da tela
  deixou de prometer resposta imediata — em grupo a orientação "vale a partir da
  próxima menção na sala".
- **15 — menção perdida durante a geração.** `internalCheckMissedMention` (gêmeo
  do `internalCheckMissedInbound` do atendente) roda no pós-commit e reapresenta
  a mensagem mais recente de membro ao `internalEnqueueFromGroup`, que reavalia o
  gatilho. Uma mensagem que não chama a IA volta a ser no-op.
- **16 — recibo de grupo não movia a campanha.** `internalApplyGroupReceipt`
  chama `applyCampaignDeliveryUpdate` quando a linha tem `metadata.campaign`. A
  regra "nunca rebaixa" continua sendo a de `transitionRecipient`.
- **17 — filtro "Grupos" persistido deixava a caixa vazia sem saída.** Os chips
  aparecem quando há grupo na lista OU quando o filtro guardado não é "Todas", e
  a mensagem de estado vazio considera o filtro ANTES de "arquivadas" (com o
  filtro em Grupos e nenhum grupo arquivado, a tela dizia "Nenhuma conversa
  arquivada" enquanto havia conversas diretas arquivadas escondidas).
- **21 — `group_mention`/`group_joined` eram clique morto.** `NotificationPanel`
  navega para `/app/entrada?conversation=<id>` e para `/app/grupos`.
- **22 — em gateway self-hosted três regras nasciam mortas.** A mensagem `fromMe`
  DE GRUPO é a única fonte de identidade própria (numa sala o `Chat` é o grupo e
  o `Info.Sender`/`SenderAlt` somos nós): `bridge.internalIngestGroupMessage`
  chama `channelConfigs.internalLearnBridgeIdentity`, que só PREENCHE o que está
  vazio e passa o telefone pelo MESMO `claimBridgePhone` do health check (a regra
  "um número, uma conta" da v0.56 continua valendo). Com isso o gatilho por
  menção, o `weLeft` do `GroupInfo` e o filtro "nunca mandar DM para nós mesmos"
  voltam a funcionar. `getGroup` devolve `selfKnown` para a UI poder avisar
  quando o número ainda é desconhecido.
- **23 — mensagem de grupo entrava no webhook 1 a 1.** Outbound de sala dispara
  `group.message.sent` (simétrico ao `group.message.received`); `message.sent`
  voltou a ser exclusivo do 1 a 1, sempre com `leadId`. Vale nos quatro caminhos
  (`sendMessage`, `internalSendMessage`, `lib/outboundSideEffects`,
  `scheduledMessages.deliver`). Documentado em `llmsTxt.ts` e `DevelopersPage`.

#### Corrigidos — review de SEGURANÇA

- **1 (= correção 4) — dado de membro de sala não acompanhada.**
  `participantsForStorage` (`lib/groupChatCore.ts`) é o ponto único: com
  `monitored !== true` grava `participants: []` e guarda só
  `participantsCount`. Aplicado em `internalUpsertGroupsFromSync`,
  `internalApplyGroupInfoEvent` (inclusive quando NÓS saímos: aí a lista é
  apagada) e `recordParticipantFromMessage` (que em sala não acompanhada só bate
  `lastMessageAt`, sem aprender PushName nem telefone). `setMonitored(false)`
  APAGA a lista; `setMonitored(true)` agenda `internalRefreshGroup` para
  repopular pelo `/group/info`. `countParticipants` faz a contagem cair no campo
  guardado quando a lista está vazia — lista vazia significa "não sei quem", não
  "zero pessoas". **Decisão registrada:** `lib/exportSanitize.ts` NÃO mascara
  `participants[].phone`. É dado de negócio de uma sala que a org escolheu
  acompanhar (D3 aceita isso para grupo monitorado), e mascarar quebraria o
  backup como cópia fiel. O que mudou é o CONJUNTO: só sala acompanhada tem
  lista, então o backup deixou de carregar os grupos de família e de escola.
- **2 — copiloto criava CONTATO com `leads:edit_own`.** O executor de
  `createLeadFromGroupMember` chama `assertAgentCan(..., "contacts", "edit")`
  antes do núcleo, espelhando a mutation da tela.
- **3 — `summarizeGroup` sem frescor e sem teto.** `internalAssertCanSummarize`
  devolve o resumo guardado quando tem menos de 1 h E é do MESMO período (igual
  à tool do copiloto) e um `overQuota` a partir de 20 runs `group_summary` na
  org na última hora (índice `agentRuns.by_organization_and_kind_and_started`).
  Sem cache e acima do teto, a action devolve erro amigável sem chamar provider.
- **4 — menção sem validação.** `resolveGroupMentions` (`lib/groupGuard.ts`)
  filtra os JIDs contra `groupChats.participants` em `sendMessage`,
  `internalSendMessage` e na entrega do agendado. Casa por LID, por telefone e
  pelo "usuário" antes do `@`.
- **5 — autopilot de grupo herdava o bypass do 1 a 1.** `effectiveReplyMode`
  passou a exigir o atendente DE FATO em `autopilot` ou o aceite próprio
  `aiConfig.groupAutopilotAck`; o `autopilotEarlyAck` do atendente não vale mais
  na sala. Mutation nova `aiSettings.setGroupAutopilotAck` (`settings:manage`,
  audit `high`, exige `riskAck: true`), `getAiStatus.groupAutopilotAckDone` para
  a UI, e `groupChats.setAiPolicy` RECUSA salvar `autopilot` sem o aceite, com
  mensagem dizendo onde assiná-lo. Filosofia "avisar, não travar": o operador
  decide, com o aviso na frente e o rastro no audit.
- **6 (= correção 12)** — acima.
- **7 — arrays do `GroupInfo` sem cap.** `jidList` corta em
  `GROUP_EVENT_JID_CAP` (1024) no parser puro, e `internalApplyGroupInfoEvent`
  reaplica o corte nas quatro listas (defesa em profundidade: a mutation é
  `internal` e pode ganhar outro caller).
- **8 — `subject`/`topic` sem teto.** `GROUP_SUBJECT_CAP` (200) e
  `GROUP_TOPIC_CAP` (512) em `lib/groupChatCore.ts`, aplicados em
  `groupFieldsFromGateway` (sincronização), no patch do `GroupInfo`, na linha do
  tempo e no payload do webhook.
- **9 — `getGroup` devolvia a chave do nosso número a `inbox:view_own`.** Cada
  participante vem com `isSelf` decidido no SERVIDOR; `selfKey` cru só sai para
  quem tem `settings:manage` (`groupsActorHas` em `lib/groupAuth.ts`), e
  `selfKnown` diz apenas se o CRM conhece o número. `GroupMembersPanel` usa
  `participant.isSelf`.
- **10 — `listChannelGroupSettings` expunha estado de canal.** O gate FICOU em
  `inbox:view_own` de propósito: além de Configurações → Canais, hoje consomem a
  query o filtro de canal de `/app/grupos` e o wizard de publicações, telas que
  um `agent` legitimamente abre. O que mudou é o recorte —
  `bridgeSessionState` e `groupsAckAt` só saem com `settings:manage`.
- **11 — o teste de build não cobriria id de grupo em tool.**
  `INJECTED_PARAM_NAMES` ganhou `groupChatId` e `groupPostId`; o teste isenta o
  copiloto pelo mesmo mecanismo de `leadId`/`contactId`.
- **12 — telefone completo na notificação de oportunidade.** `maskGroupPhone`
  (`lib/groupAgentCore.ts`), no padrão do resto do produto.

#### Menores também corrigidos

- `lib/exportSanitize.ts` — `groupPosts.schedulerFnId` entrou na `DENY_PATHS`
  (pedido da outra frente).
- `attendant.evaluateEligibility` — condição 0 recusa `kind: "group"`: as
  condições 5 e 6 usam `lead?.` e atravessariam em silêncio.
- `groupAgent` — a idempotência do digest diário saiu de `summary.at` para o
  campo próprio `ai.lastDigestAt` (um "Resumo por IA" manual à tarde cancelava o
  digest do dia); `setAiPolicy` preserva o campo ao salvar a política.
- `groupAgent.internalFinishRadar` — recebe o slot que a run serviu e só limpa
  `radar.scheduledFor` quando é o mesmo (ou já venceu): um lote agendado DURANTE
  a action deixou de virar agendamento órfão.
- `lib/groupChatCore.recordParticipantFromMessage` — `lastMessageAt` é atualizado
  mesmo quando o evento não traz nem LID nem telefone.
- `Inbox.tsx` — `GroupMembersPanel` montado com `key={groupChatId}` (busca e
  seleção vazavam entre salas); `setShowGroupSummary(false)` ao trocar de
  conversa; banner âmbar de repasse pendente também em sala (query nova
  `handoffs.getPendingHandoffForConversation`, por conversa).
- Agendar numa sala passou a carregar as MENÇÕES (`scheduledMessages.mentions`,
  campo novo, revalidado contra os participantes na entrega) — antes o "@fulano"
  sobrevivia como texto e não notificava ninguém.
- `GroupMentionComposer` — membro sem PushName vira `@<telefone>` em vez de
  `@••••5729` no texto enviado, e dois membros com o mesmo primeiro nome ganham
  rótulos distintos (sufixo com os 4 últimos dígitos), então uma menção deixa de
  notificar os dois.
- `GroupsPage` — `activityLabel()` em vez de "ativo " + `relativeTime()`, que
  produzia "12 membros · ativo sem atividade".
- `copilot.resolveGroupNames` — nome parcial que casa mais de um grupo devolve
  erro pedindo o nome exato, em vez de escolher o primeiro em silêncio.

#### NÃO corrigidos (com motivo)

- **Segurança 13 (webhooks de grupo mandam JID de terceiro para fora)** — não é
  código. Entra na cláusula nova de LGPD dos Termos, junto com a de grupos
  monitorados. **Pendência registrada para a F8/docs.**
- **Segurança 14 (`internalExecuteSendNow` não revalida a org do canal)** —
  `groupPostWorker.ts`, arquivo da outra frente nesta rodada. Sem impacto
  prático (o `channelConfigId` vem do próprio post, validado na criação); é
  divergência entre dois caminhos que deveriam ter as mesmas guardas.
- **Parte 2 do item 22 (`lib/campaignAudience.ts:430`, o self nunca casava e o
  NOSSO número virava destinatário)** — arquivo da outra frente. A causa raiz
  está corrigida (o `selfKey` agora é aprendido em self-hosted), então o filtro
  passa a funcionar sem mudança lá; o que falta é a decisão de RECUSAR o público
  `group_members` quando o self é desconhecido.
- **UI do aceite `groupAutopilotAck`** — o modal de política da sala
  (`GroupAiPolicyModal.tsx`) é da outra frente. O backend está pronto e RECUSA
  `autopilot` sem aceite, com mensagem dizendo onde assinar; a UI precisa chamar
  `aiSettings.setGroupAutopilotAck` com o texto de aviso.
- **`groupAgent.internalListDigestDue` varre `groupChats` com `.take(200)`
  DEPLOYMENT-WIDE** — passando de 200 grupos somados no deployment, os mais novos
  nunca entram no digest. A correção pede índice novo (campo derivado de
  `ai.dailyDigestAt`) e um backfill; ficou fora desta rodada para não misturar
  migração de dados com correção de review.
- **`lib/groupChatCore.ts:176` (cada mensagem reescreve o array inteiro de
  participantes)** — mitigado de lado pelo item de segurança 1 (sala não
  acompanhada não escreve mais nada), mas numa sala GRANDE acompanhada a escrita
  continua sendo o doc inteiro. Sair disso pede tabela própria de participante.
- **`GroupMentionComposer` no protocolo** — o WhatsApp destaca a menção casando
  `@<dígitos>` no texto; com nome o destaque não acontece (a notificação, que vem
  do `MentionedJID`, acontece). Trocar todos os rótulos por número deixaria o
  texto ilegível — fica como está, agora sem o caso do telefone mascarado.

## Desvios do plano (registrar aqui)

### F5.5
1. **`authorizeGroups` recebe a CATEGORIA como argumento**, diferente de
   `authorizeCampaigns`, que fixa `campaigns`. Grupos atravessam três categorias de RBAC —
   `inbox` (ler e escrever numa sala é ler e escrever numa conversa), `settings` (acompanhar
   e sincronizar mexem na configuração do NÚMERO) e `campaigns` (publicações). Três helpers
   quase idênticos seriam pior que um argumento.
2. **`POST /groups/send` é DUAS chamadas, não uma.** A rota resolve a conversa do grupo
   (`internalResolveGroupConversation`, que re-checa RBAC + org + "está acompanhado") e só
   então chama `conversations.internalSendMessage` — o MESMO caminho de
   `POST /conversations/send`, com pacing, webhook e dispatch. A alternativa era extrair uma
   QUARTA cópia do núcleo de inserção de mensagem; `lib/outboundSideEffects.ts` já documenta
   o que isso custou antes. Para isso `internalSendMessage` ganhou o arg `mentions`, com a
   mesma semântica (e o mesmo teto de 1024) da mutation pública `sendMessage`.
3. **`GET /groups/messages` NÃO reusa `conversations.internalGetMessages`.** Aquela devolve
   as 500 mais ANTIGAS (`.take` ascendente), que num grupo movimentado é exatamente o que
   ninguém quer ler. A query nova lê em ordem decrescente com `limit` (default 50, teto 200)
   e resolve o autor do jeito do grupo: `senderName` vem do PushName, e `senderContactName`
   só existe quando o telefone já era contato (D3).
4. **`syncGroups` trocou `channelConfigs.internalRequireSettingsManage` por
   `groupChats.internalAuthorizeGroupAccess`.** A action precisa autorizar com um ator
   EXPLÍCITO quando a chamada vem da REST (não há sessão). A query nova mora em
   `groupChats.ts` de propósito: se morasse em `groupsInternal.ts` (que importa `groupChats`)
   o par viraria um ciclo de módulos.
5. **A F5.5 acrescentou `update` e `reject` de publicação à REST**, que não estavam na lista
   da §10. Sem `update` a API cria rascunho e não consegue corrigir uma vírgula; sem `reject`
   um texto pendente de IA fica preso até alguém abrir o app. Ambos em `campaigns:manage`,
   iguais à UI.
6. **MCP ficou nas 8 tools pedidas — sem `crm_activate_group_post`.** Ativar é o momento em
   que o CRM passa a escrever sozinho numa sala de gente real; é a mesma postura de
   `crm_launch_campaign`, que também não lança pelo copiloto. A rota REST existe (com
   `campaigns:full`); o agente cria o rascunho e um humano ativa. Também ficaram de fora
   `crm_list_group_messages` e `crm_update_group_post`/`crm_reject_group_post` — as rotas
   existem, só não há tool.
7. **Sem `join`/`leave`/`create`/participantes em REST**, como a §10 manda — está escrito no
   cabeçalho de `groupsInternal.ts` e na doc pública para não ser "esquecimento" da próxima vez.
8. **Lacuna pré-existente fechada junto:** `internalGetPreferences` e
   `internalUpsertPreferences` (a via REST/MCP das preferências) não tinham `aiDraftPending`,
   `campaignCompleted` nem `campaignPaused` desde a v0.45/v0.55. Entraram com os seis de grupo.
9. **`DevelopersPage` dizia "85 no total" de rotas REST — já estava desatualizado** antes
   desta fase (eram 99 com a F5). Passou a 113 com as 14 novas.
10. **`crm_update_notification_preferences` (MCP) segue sem os flags novos no schema zod.**
    O backend aceita (`updates: v.any()`), mas a tool não os declara — vale um passe à parte,
    junto com os três de campanha/rascunho que já faltavam.

### F4
1. **A tool de repasse do grupo chama-se `requestGroupHandoff`, não `requestHandoff`.** Os
   nomes de tool são únicos no registry inteiro (há teste de build) e `requestHandoff` já é a
   do atendente 1:1, que exige lead. Reusar o nome exigiria um spec compartilhado entre dois
   registries com permissões e executores diferentes — mais acoplamento do que o nome vale.
2. **`createHandoffCore` passou a aceitar repasse SEM lead.** `leadId` virou opcional; sem ele
   são obrigatórios `organizationId` + `conversationId`, e `subjectLabel` (o nome do grupo) vira
   o título do card. Como não existe `lead.handoffState` para segurar a duplicata, a chave
   passou a ser a CONVERSA: três menções sensíveis seguidas na mesma sala abrem UM repasse.
   `activities` continua só com lead (o campo é obrigatório lá); o audit registra os dois casos.
3. **`groupAgentEnabled` desligado é no-op SILENCIOSO — não grava item `skipped`.** O plano
   pedia rastro de "IA em espera"; ele existe para os gates POR NÚMERO (aceite de grupos,
   grupos desligados no número, bridge sem aceite, tetos, horário, repasse pendente). Com o
   produto inteiro desligado na org não há espera a explicar, e uma linha por menção numa org
   que não usa IA é custo puro — é a mesma regra do atendente com `orgAiActive` falso.
4. **O radar é agendado POR GRUPO (`internalScheduleRadar({groupChatId})`), não por mensagem.**
   O checklist falava em `internalRadar({messageId})`; o coalescing de 15 min do próprio plano
   (§9.3) é por sala, e guardar o lote no doc do grupo (`groupChats.radar.scheduledFor`) é o que
   garante 1 chamada por janela em vez de 1 por mensagem. `radar.lastRunAt` delimita o lote
   seguinte e é sempre liberado, inclusive em erro — senão uma falha congelaria o radar da sala.
5. **Texto puro sem tool NÃO vira mensagem no grupo.** No 1:1 o runtime aproveita a resposta em
   texto quando o modelo esquece `replyToCustomer`. Numa sala isso publicaria o que o modelo
   "pensou em voz alta" na frente de clientes: aqui o turno termina em `sem_resposta`, que não é
   falha — sem retry e sem repasse, porque a IA decidir não responder é legítimo.
6. **O loop de coaching não existe no grupo.** `requestAiDraft`/`returnToAi` continuam recusando
   conversa de grupo (a mensagem de erro ficou explícita) e o `AiDraftCard` esconde o bloco
   "Instruir a IA" em rascunho de grupo (`metadata.groupAgent`). O gatilho da sala é a MENÇÃO;
   pedir um rascunho avulso é escrever para dezenas de pessoas sem ninguém ter perguntado nada.
7. **`getGroupSummary` do copiloto é tool de ESCRITA.** Ela precisa poder DISPARAR a geração
   (agendar a action), e o executor de leitura roda em query. Resumo com menos de 1 h é
   devolvido na hora; senão ela agenda e responde `gerando`, com o resumo velho junto quando
   existe.
8. **`createGroupPostDraft` do copiloto cria uma publicação MÍNIMA** (biblioteca de textos +
   horários + dias), não a rotina completa da tela. `groupPosts.create` é uma mutation pública e
   não dá para chamá-la de dentro de outra mutation; extrair o handler inteiro mexeria fundo num
   arquivo da F3. `days` vazio vira "todos os dias" — "todo dia às 12h" é o pedido mais comum.
9. **Ativar publicação pelo copiloto é `pendingActions`:** a confirmação re-checa
   `campaigns:full`, re-valida TODOS os destinos (alguém pode ter parado de acompanhar entre a
   proposta e o clique) e audita como `high`.
10. **`products.groupAgent` só escolhe ROTA, não modelo.** O modelo vem do atendente da org
    (mesma persona, mesmo conhecimento); só a visão escolhe modelo por produto. O resumo e o
    radar usam o modelo `classify` da org, que é onde mora o barato.
11. **(resolvido na F5.5)** Sem REST e sem MCP nesta fase, como na F1/F3 — não estava no
    checklist da F4.
12. **(resolvido na F5.5)** A UI de preferências não listava `group_opportunity`/
    `group_digest` — nem `groupJoined`/`groupMention`/`groupPost*` da F1/F3. Os seis entraram
    de uma vez, numa seção "Grupos de WhatsApp".
13. **A geração de texto das PUBLICAÇÕES (F3) continua atrás de `groupAgentEnabled`**, como a
    F3 a deixou: um interruptor liga as duas coisas, e o card em Configurações → IA diz isso.

### F5
1. **`campaignRecipients.phone` de uma SALA guarda o JID inteiro** (`120…@g.us`),
   não só os dígitos. Com o "@" ele nunca colide com um telefone real no índice
   `by_organization_and_phone` nem na lista de supressão, e é literalmente o que
   vai no campo `Phone` do envio. Em troca, `isPhoneSuppressed` é PULADO para
   recipient de sala (opt-out de grupo é parar de acompanhar — D13).
2. **O "espalhar em dias" nasce no SNAPSHOT, não no worker.** `assignSpreadDays`
   dá um `dayIndex` por pessoa dentro do grupo de origem e o snapshot grava
   `scheduledFor = início + dia × 24 h`. O worker já sabia adiar pendente
   agendado para o futuro, então não precisou de lógica nova — e o operador vê
   no lançamento, não só depois, que a lista leva N dias.
3. **O teto por grupo é avaliado ao ESCOLHER o destinatário, não só no
   `capsExceeded`.** Se o grupo A já mandou os 10 de hoje e o B não, parar a
   campanha inteira até amanhã seria pior que continuar pelo B:
   `nextPendingRecipient` pula os candidatos de grupo estourado e só adia o tick
   para a virada do dia quando TODOS estão barrados. O `capsExceeded` ganhou o
   argumento `sourceGroup` como rede de segurança (retomada manual, retry).
4. **Contador por grupo em `campaigns.stats.byGroup`, não em tabela nova.**
   `{ sent, sentToday, sentTodayKey }` por `Id<"groupChats">`, na mesma
   transação do envio. Uma tabela só para contar 10/dia custaria um índice e uma
   leitura extra por envio. A quebra COMPLETA do relatório (entregues/lidas/
   respostas por grupo) é calculada varrendo `campaignRecipients` — e só nos
   públicos de grupo, porque varrer 5 mil destinatários de um segmento para
   montar uma seção que nem apareceria seria caro à toa.
5. **Teto de 50 salas por campanha e 2.000 membros no snapshot**
   (`GROUP_AUDIENCE_MAX`, `GROUP_MEMBERS_SNAPSHOT_MAX`). O snapshot de grupo roda
   numa transação só, diferente do segmento (que pagina) — com 50 salas de 1024
   membros o pior caso já é grande o bastante. A prévia avisa quando trunca.
6. **O público "grupos" não herda o `campaignDefaults` da org** nem o teto do
   bridge 1:1: são escalas diferentes (uma sala de 300 pessoas não é "um
   envio"). `safeDefaultsFor`/`clampToHardCap` ganharam o argumento
   `audienceSource` e aplicam a tabela de grupos ANTES da do provider.
7. **`activeInGroupWithinDays` casa por LID E por telefone.** O plano fala em
   LID; num grupo em modo `pn` a mensagem não traz LID nenhum, e casar só por
   ele zeraria o filtro em silêncio (o pior modo de falha: público vazio sem
   explicação).
8. **A seleção do painel de membros vira público `manual` com
   `audience.groupChatIds = [origem]`.** `addManualRecipients` lê dali (ou do
   argumento novo `sourceGroupChatId`) e carimba `sourceGroupChatId` em cada
   linha — sem isso a campanha "manual" perderia de onde os números vieram e o
   relatório por grupo ficaria vazio justo na porta de entrada mais usada.
9. **O copiloto escolhe grupo por NOME** (`groupNames`), não por id, e só entre
   os monitorados; o id nunca aparece numa conversa de chat. Nome que não casa
   devolve a lista dos disponíveis em vez de erro seco.
10. **"Criar leads dos selecionados" já existia na F2** e não foi tocado — o
    checklist da F5 o mencionava, mas ele é ação de lead (D3), não de campanha.
11. **Sem rota REST nova.** Os dois públicos entram pelas rotas que já existem
    (`preview-audience`, `create`, `launch`, `recipients`, `safe-defaults`), então
    `ROUTE_PERMISSIONS` não mudou e `routerPermissions.test.ts` segue verde sem
    entrada nova.

### F3 UI
1. **O rascunho só nasce quando o CONTEÚDO já é válido.** A tarefa pedia "salvar
   rascunho ao avançar", mas `groupPosts.create` valida `content` (biblioteca vazia e IA
   sem prompt são recusadas), e não existe conteúdo no passo 1. Então: publicação NOVA
   vive em estado local até o conteúdo passar na validação (na prática, o passo 3) e só aí
   é criada; publicação EXISTENTE salva a cada "Próximo" por `update`, mandando
   nome/grupos/agenda sempre e `content` só quando válido. Alternativa descartada: criar com
   um item "…" de mentira só para ter id — geraria publicação-lixo se a pessoa desistisse.
2. **O cliente IMPORTA os módulos puros do backend** (`describeSchedule`, `nextRunAt`,
   `validateGroupPostSchedule`, `validateGroupPostContent`, `buildPostVars`, os tetos),
   como `usePermissions` já faz com `lib/permissions`. Reescrever a descrição da agenda em
   `src/lib` produziria uma tela que promete um horário e um worker que dispara em outro.
3. **Início/fim são `<input type="date">` lidos no FUSO DA AGENDA** (00:00 e 23:59 de lá,
   não do navegador). `zonedTimeToUtc` não é exportado, então `postUtils.dateInputToEpoch`
   repete a conversão de duas passadas usando o `localParts` exportado — uma passada só
   erraria por 1 h no dia da virada de horário de verão.
4. **Uploader próprio de anexo (`AttachmentField`), não o `FileUploadButton`.** O botão
   compartilhado aceita até 5 arquivos e o servidor recusa mais de um anexo por item. Mesmo
   caminho de `files` (`generateUploadUrl` → POST no storage → `saveFile` com
   `fileType: "message_attachment"`), com teto de 16 MB avisado no cliente.
5. **`cursor` e `recentIndexes` viajam de volta no `update`.** O `update` substitui
   `content` inteiro; sem carregar esses dois, corrigir uma vírgula numa mensagem
   reiniciaria a sequência da biblioteca do zero. `noRepeatWindow` é clampado a
   `items.length - 1` no cliente, senão apagar mensagens deixaria um rascunho que só falha
   na hora de salvar.
6. **(resolvido na F5.5)** A lista filtrava só por status; `groupPosts.list` também aceita
   `channelConfigId`. O seletor de canal entrou na aba Publicações, visível só quando a org
   tem 2+ canais com grupos ligados.
7. **Aprovar/rejeitar continua disponível com o prazo vencido.** O card troca a contagem
   regressiva por "prazo vencido" e diz o que vai acontecer (`onMissedApproval`), mas não
   esconde os botões: `approvePending` não olha o relógio, e com `onMissedApproval: "send"`
   o texto aprovado ainda é usado no tique seguinte.
8. **`GroupsPage`: `?post=<id>` força a aba Publicações** (a notificação linka sem `?aba=`),
   e trocar para a aba Grupos limpa o `post` — o param residual reabriria Publicações na hora.
9. **Typecheck do repositório vermelho por arquivo de OUTRA fase** no fim desta entrega:
   `src/components/notifications/NotificationPanel.tsx` não tem `group_opportunity` nem
   `group_digest` no mapa de ícones (tipos novos da F4). Nada nos arquivos da F3 UI.

### F3 backend
1. **O tick é `internal.groupPostWorker.tick`, não `internal.groupPosts.tick`.** O plano (§6)
   falava em `internal.groupPosts.tick`/`generate`; o worker virou arquivo próprio, como nas
   campanhas (`campaigns.ts` + `campaignWorker.ts`). As rotinas que os DOIS precisam (agendar o
   tick, escrever a linha do tempo, pausar, encerrar) ficaram em `lib/groupPostOps.ts` — cada
   arquivo importar o outro fecharia um ciclo de módulos que degrada a inferência de tipos da API
   gerada, exatamente o que `lib/outboundSideEffects.ts` documenta ter custado caro antes.
2. **O teto de 10/dia por canal conta SLOTS, não mensagens.** Contador novo
   `channelPacing.groupPostDaily` (COM enforcement, ao lado de `campaignDaily`). Um disparo que
   posta em 5 grupos consome 1: contar mensagens faria uma publicação com 11 grupos nunca caber no
   teto, e espaçar as 5 mensagens já é trabalho do pacing por número. Bater no teto PULA o slot
   sem pausar a publicação — pausar por teto exigiria alguém reativar à mão todo dia.
3. **Slot atrasado mais de 1 h é pulado** (`SLOT_GRACE_MS`), o que não estava no plano. Sem isso um
   canal congelado por 4 h faria o "bom dia" das 9h sair às 13h, e uma fila travada de madrugada
   despejaria a publicação de ontem no meio da noite.
4. **`campaigns:full` para ativar, encerrar, excluir e "enviar agora" de verdade.** O D11 dizia
   "`manage` cria/pausa, `full` ativa/cancela"; a F3 acrescentou `full` para a exclusão (apaga o
   histórico) e para o envio manual real (manda mensagem para gente real num grupo, fora de
   qualquer agenda). A PRÉVIA do "enviar agora" (`dryRun`) fica em `manage` — não escreve nada.
5. **Persona da IA: prompt PRÓPRIO, não o `buildAttendantSystemPrompt`.** O prompt do atendente é
   de atendimento 1:1 — fala em "cliente", obriga `replyToCustomer`, tem regras de repasse, de
   funil e de captura de dados. Aproveitamos dele o que de fato se aproveita: o `systemPrompt` e o
   `knowledge` do atendente IA da org (`lib/groupPostPrompt.ts`). Nome de grupo e publicações
   recentes viajam dentro do envelope de dado não-confiável.
6. **Produto de IA novo: `products.groupPosts`** (`aiConfig.providerConfig.products` +
   `AiProduct` em `lib/agentRoutes.ts`), ausente = herda a rota da org. O §3.3 previa
   `products.groupAgent` — esse é o agente que RESPONDE dentro do grupo (F4), outro produto.
   `agentRuns.kind` ganhou `group_post`.
7. **`content.library.recentIndexes` e `content.ai.customPersona` não estavam no §3.2.** O primeiro
   é o estado mínimo do `noRepeatWindow` (só os últimos N índices, não um histórico); o segundo é o
   texto da persona quando `persona: "custom"` — o plano declarava o modo sem dizer onde o texto
   ficaria.
8. **O histórico de envios sai da `timeline`, não de um índice em `messages`.** `getHistory` lê as
   entradas `kind: "sent"|"skipped"|"failed"` (cap 100, com `messageId` por grupo). Indexar
   `metadata.groupPost` custaria um índice novo na maior tabela do produto por causa de uma tela de
   consulta. Consequência aceita: uma publicação com MUITO evento que não é envio pode empurrar os
   envios mais antigos para fora da janela de 100.
9. **Watchdog horário novo** (`crons.ts` → `groupPostWorker.internalWatchdog`, índice
   `by_status_and_next_run` deployment-wide). As campanhas não têm um porque duram dias; uma
   publicação dura MESES, e perder o agendamento em março sem ninguém notar até junho é o modo de
   falha mais provável deste recurso.
10. **Anexo: `files.messageId` fica com a PRIMEIRA mensagem do slot.** O campo é 1:1 e o mesmo
    arquivo vai para N grupos. O blob é compartilhado e `lib/fileRefs.ts` já protege o delete; só a
    "posse" do anexo é de uma mensagem só. Um anexo por item (limite do bridge) é validado.
11. **(resolvido na F5.5)** Sem REST e sem MCP nesta fase — como na F1, não estava no
    checklist. As rotas `/api/v1/group-posts/*` e a entrada em `ROUTE_PERMISSIONS` saíram na F5.5.
12. **O worker nunca envia por Meta.** Só canal bridge com `bridgeGroupsEnabled` — é a mesma
    restrição da F1 (o dispatch Meta recusa conversa de grupo), aplicada já na validação dos
    destinos em vez de falhar na hora do disparo.

### F2
1. **`contactPresence` ficou como está — "digitando…" no grupo NÃO nomeia quem.**
   O Desvio 1 da F1 deixou a decisão para a F2, e a resposta é não: o campo por
   participante (`typingParticipants`) exige mexer em `convex/schema.ts`, que é
   de outro agente nesta rodada, e o ganho é cosmético. A UI mostra "alguém está
   digitando…" em grupo e "digitando…" no 1:1, lendo o mesmo estado agregado.
   Se a F4 quiser nomear, o campo ainda pode nascer depois.
2. **A política de IA do grupo virou MODAL, não popover.** São seis controles
   (modo, modo de resposta, dois tetos, instruções extras) e a UI é mobile-first:
   um popover ancorado num item de lista ficaria ilegível no celular.
   `src/components/groups/GroupAiPolicyModal.tsx`, reutilizado por Canais.
3. **`getGroup` passou a devolver `selfKey`.** A UI precisa marcar "você" na
   lista de membros, e o dado (`channelConfigs.bridgeLid`) mora no documento do
   canal, que a query jamais devolve (carrega o token). `selfKey` é só a chave
   do participante (`bridgeLid ?? bridgePhone`), LID antes do telefone pelo
   mesmo motivo do `findSelfParticipant`.
4. **`listChannelGroupSettings` existe porque `getChannelConfigs` mascara.**
   O card do número precisa de `bridgeGroupsEnabled/Ack/LastSyncAt` e
   `convex/channelConfigs.ts` é de outro agente nesta rodada. A query devolve
   só nome, status, estado de sessão e os três campos de grupo — sem token e
   sem URL de gateway (há teste). Gate `inbox:view_own`, como `listGroups`.
5. **`createLeadFromMember` exige `leads:edit_own` E `contacts:edit`** (os
   mesmos gates de `leads.createLead` e `contacts.createContact`), não um nível
   "create" — ele não existe na hierarquia de `leads`. Cria também a conversa
   1:1 VAZIA do lead no canal do grupo, que é onde a equipe vai puxar a pessoa
   para o privado; a conversa do grupo continua separada.
6. **Menção: o rótulo inserido é só o PRIMEIRO nome.** O WhatsApp corta a
   menção no espaço, então "@João Silva" destacaria apenas "@João". O JID
   completo vai em `mentions[]`; o texto leva `@João`. Na hora do envio só
   viajam os JIDs cujo rótulo ainda está no texto — apagar o "@Fulano" desfaz
   a menção.
7. **(resolvido) O typecheck do repositório esteve quebrado por arquivos de
   outras fases durante a F2** — `convex/lib/groupPostCore.test.ts:31` (TS7022,
   f3-backend) e `src/components/notifications/NotificationPanel.tsx` sem os
   tipos `group_post_pending`/`group_post_failed`. Os donos corrigiram; a F2
   fechou com `npm run lint` inteiro verde, incluindo `npx convex dev --once`.
8. **A aba "Publicações" de `/app/grupos` é um STUB.** `GroupPostsTab` recebe
   `{ organizationId }` e só isso; a F3 substitui o conteúdo do arquivo sem
   mexer na página, na rota nem na aba.

### F1
1. **`contactPresence` continua um estado só por conversa.** O plano (§3.3) previa
   `typingParticipants?: [{jid, name?, at}]` para mostrar QUEM está digitando no grupo.
   A F1 parseia `group_presence` e grava o estado agregado no campo existente — nomear
   quem digita é enfeite de UI e o campo por participante entraria sem nenhum consumidor.
   **F2 decide** se vale o campo novo.
2. **`leadId` opcional resolvido com um helper, não com 63 guardas soltas.**
   `convex/lib/leadRef.ts` (`getLeadRef`) substitui `ctx.db.get(conversation.leadId)` em
   todo ponto que passou a receber `undefined` — sem ele o TypeScript infere a união de
   TODAS as tabelas como retorno de `db.get` e o erro real se esconde. Onde o `leadId`
   era obrigatório de verdade (`activities`), o insert ficou condicionado a existir lead.
3. **Sem enquete, sem REST e sem MCP na F1** — nenhum dos três estava no checklist da fase.
   As rotas `/api/v1/groups/*` da §10 saíram na F5.5 (com a entrada em `ROUTE_PERMISSIONS`);
   enquete continua fora.
4. **Grupo conhecido mas NÃO monitorado carimba atividade** (`lastMessageAt` + PushName do
   membro), como o plano permitia ("grava só lastMessageAt/participante se existir").
   Nenhum conteúdo de mensagem é persistido. É o que faz a lista de grupos mostrar
   "ativo há 5 min" antes de alguém decidir acompanhar.
5. **Recibo de grupo não passa pelo descarte de `IsFromMe`.** Num recibo de grupo o
   `Sender` do evento é a NOSSA conta (§1.2) e quem leu vem em `MessageSender` — manter a
   guarda do 1:1 mataria TODO recibo de grupo. A leitura do próprio aparelho continua fora
   por outro caminho (`read-self`/`played-self` não mapeiam para status nenhum).
6. **`weAreAdmin` compara o LID ANTES do telefone** (`findSelfParticipant`). Num canal
   reprovisionado o `bridgePhone` gravado pode estar defasado, e casar pelo telefone errado
   diria que somos admin de um grupo onde não somos.
7. **`requestAiDraft`/`returnToAi` recusam conversa de grupo** com erro explícito, em vez de
   falharem com "Lead da conversa não encontrado". O agente de grupo é F4.
8. **Exclusão de canal apaga só o que é do CANAL:** `groupChats` + conversas de grupo +
   mensagens + blobs. As conversas 1:1 pertencem a LEADS e sobrevivem à troca de número.

## Log
- 2026-09-16 — **F8, frente núcleo + IA + segurança: correção 1–6, 12–17, 21–23 e
  segurança 1–12 corrigidos**, sem commit. Schema: índice
  `handoffs.by_conversation_and_status`, `handoffs.subjectLabel`,
  `aiConfig.groupAutopilotAck`, `groupChats.ai.lastDigestAt`,
  `scheduledMessages.mentions`. Novo: `convex/lib/groupGuard.ts`
  (`assertGroupConversationSendable` + validação de menção contra os
  participantes). Tocados: `conversations.ts`, `scheduledMessages.ts`,
  `groupChats.ts`, `groupAgent.ts`, `handoffs.ts`, `attendant.ts`,
  `aiSettings.ts`, `copilot.ts`, `bridge.ts`, `channelConfigs.ts`, `router.ts`,
  `llmsTxt.ts`, `lib/{groupChatCore,groupAgentCore,groupAuth,groupCopilotTools,
  outboundSideEffects,bridgeParse,agentTools,exportSanitize}.ts`,
  `src/components/{Inbox,HandoffQueue}.tsx`,
  `src/components/inbox/{ForwardModal,MessageBubble,MessageActionsBar,
  GroupMembersPanel,GroupMentionComposer,types}.tsx`,
  `src/components/handoffs/HandoffPeekSlideOver.tsx`,
  `src/components/notifications/NotificationPanel.tsx`,
  `src/components/groups/GroupsPage.tsx`, `src/lib/{groupDisplay,apiRegistry}.ts`,
  `src/pages/DevelopersPage.tsx`, `mcp-server/src/tools/conversations.ts`.
  27 testes novos em `bridgeGroupIngress.test.ts`, `groupAgent.test.ts`,
  `groupChats.test.ts`, `bridgeParse.test.ts`, `copilotGroups.test.ts`
  (+ testes existentes atualizados para as regras novas); suíte inteira
  **1263 verdes** em 68 arquivos e `npm run lint` verde. Pendências registradas
  na seção F8: cláusula de LGPD dos Termos (segurança 13), segurança 14 e a UI
  do aceite `groupAutopilotAck` (arquivos da outra frente), varredura do digest.
- 2026-09-16 — **F8, frente publicações/campanhas/UI: itens 7–11, 18–20, 24–25 do
  review corrigidos**, sem commit. Schema (só nas tabelas desta frente):
  `groupPosts.nextSlotKey`, `groupPosts.channelRetries`,
  `groupPosts.targets[].missingSince`, índice
  `campaignRecipients.by_campaign_and_status_and_scheduled`. Tocados:
  `lib/groupPostSchedule.ts`, `lib/groupPostOps.ts`, `groupPostWorker.ts`,
  `groupPosts.ts`, `lib/groupCopilotTools.ts`, `campaigns.ts`, `campaignWorker.ts`,
  `lib/campaignAudience.ts`, `lib/campaignPacing.ts`, `CampaignsPage.tsx`,
  `campaigns/{CampaignWizard,types}.tsx`,
  `campaigns/steps/{StepChannel,StepReview,GroupAudienceTabs}.tsx`,
  `groups/GroupAiPolicyModal.tsx`, `groups/posts/{GroupPostsTab,PendingApprovalCard}.tsx`,
  `settings/BridgeGroupsPanel.tsx`. `GROUP_MEMBERS_SNAPSHOT_MAX` 2.000 → 800
  (orçamento de leituras da transação). 21 testes novos/ajustados em
  `groupPosts.test.ts`, `lib/groupPostSchedule.test.ts`, `campaignsGroups.test.ts`,
  `lib/campaignAudience.test.ts`, `lib/campaignPacing.test.ts`. Fechamento com as
  duas frentes integradas: `npm run lint` sai 0 (tsc convex + app + node,
  `convex dev --once`, `vite build`) e `npm run test` dá **1272 verdes em 68
  arquivos**. Os testes de worker de campanha têm `timeout` próprio e ficam no
  limite sob carga — duas execuções da suíte inteira acusaram 1 falha cada, em
  testes diferentes, todos verdes isolados e na execução seguinte.
- 2026-09-16 — **F5.5 (REST, MCP e preferências) concluída**, sem commit. Novos:
  `convex/groupsInternal.ts`, `convex/lib/groupAuth.ts`, `convex/groupsApi.test.ts`,
  `mcp-server/src/tools/groups.ts`. Tocados: `groupChats.ts` e `groupPosts.ts` (padrão
  `xArgs`/`xHandler` + `authorizeGroups`), `conversations.ts` (`mentions` em
  `internalSendMessage`), `router.ts` (14 rotas + `ROUTE_PERMISSIONS` + OPTIONS),
  `llmsTxt.ts`, `notificationPreferences.ts`, `mcp-server/src/index.ts`,
  `mcp-server/package.json`, `mcp-server/README.md`, `README.md`,
  `src/lib/apiRegistry.ts`, `src/pages/DevelopersPage.tsx`,
  `src/components/notifications/NotificationPreferences.tsx`,
  `src/components/groups/posts/GroupPostsTab.tsx`,
  `.claude/skills/hnbcrm/references/API_REFERENCE.md`. 13 testes novos; suíte 1209 verde em
  68 arquivos, `npm run lint` verde e build do mcp-server verde. Falta o E2E vivo (F8).
- 2026-09-16 — **F4 (IA nos grupos) concluída**, sem commit. Novos: `convex/groupAgent.ts`,
  `convex/lib/groupAgentCore.ts`, `convex/lib/groupCopilotTools.ts`,
  `convex/lib/groupMemberLead.ts`, `src/components/inbox/GroupSummaryModal.tsx` (+
  `lib/groupAgentCore.test.ts`, `groupAgent.test.ts`, `copilotGroups.test.ts`). Tocados:
  `schema.ts`, `crons.ts`, `conversations.ts` (ponto de extensão do ingest + alerta por
  palavra), `attendant.ts` (simulador de grupo, `acceptAiDraft` com menções,
  `hasMediaAwaitingEnrichment` exportado), `handoffs.ts` (repasse sem lead), `groupChats.ts`
  (`setAiPolicy` + `summarizeGroup`), `aiSettings.ts`, `agentRuns.ts`, `lib/agentTools.ts`,
  `lib/agentSecurity.ts`, `lib/agentRoutes.ts`, `lib/notify.ts`, `copilot.ts`, `AiSection.tsx`,
  `Inbox.tsx`, `inbox/AiDraftCard.tsx`, `inbox/types.ts`, `notifications/NotificationPanel.tsx`,
  `groups/GroupAiPolicyModal.tsx`. 103 testes novos; suíte 1193 verde em 67 arquivos e
  `npm run lint` verde. Falta o E2E vivo (F8).
- 2026-09-16 — **F5 (campanhas para grupos e para membros) concluída**, sem commit.
  Novos: `convex/campaignsGroups.test.ts`, `convex/lib/campaignAudience.test.ts`,
  `src/components/campaigns/steps/GroupAudienceTabs.tsx`. Tocados: `schema.ts`,
  `campaigns.ts`, `campaignWorker.ts`, `lib/campaignAudience.ts`,
  `lib/campaignPacing.ts` (+teste), `lib/campaignHooks.ts`, `conversations.ts`
  (1 chamada no ingest de grupo), `router.ts`, `copilot.ts`, `lib/agentTools.ts`,
  `llmsTxt.ts`, `mcp-server/src/tools/campaigns.ts`, `src/lib/apiRegistry.ts`,
  `src/components/CampaignsPage.tsx`, `campaigns/{types,wizardState,CampaignWizard,
  CampaignDetail}.tsx`, `campaigns/steps/{StepAudience,StepReview}.tsx`,
  `groups/GroupsPage.tsx`, `Inbox.tsx`, `inbox/GroupMembersPanel.tsx`.
  58 testes novos; suíte 1193 verde em 67 arquivos e `npm run lint` verde.
  Falta o E2E vivo (nenhuma mensagem real foi enviada nesta fase).
- 2026-09-16 — plano v1 + F0 parcial (fixture real de mensagem de grupo). Orquestração iniciada.
- 2026-09-16 — **F3 (UI das publicações programadas) concluída**, sem commit. Novos em
  `src/components/groups/posts/`: `GroupPostsTab.tsx` (substitui o stub da F2),
  `GroupPostWizard.tsx`, `StepTargets.tsx`, `StepSchedule.tsx`, `StepContent.tsx`,
  `GroupPostDetail.tsx`, `PendingApprovalCard.tsx`, `SendNowDialog.tsx`,
  `AttachmentField.tsx`, `wizardState.ts`, `postUtils.ts`, `types.ts`. Tocado:
  `groups/GroupsPage.tsx` (2 edições cirúrgicas no deep-link `?post=`). `npx tsc -p
  tsconfig.app.json --noEmit` sem erro nos arquivos da fase e `npm run build` verde (chunk
  `GroupsPage` 65,6 kB / 16,2 kB brotli). Falta o E2E vivo (F8): nenhuma mensagem real foi
  enviada — `sendNow` sem `dryRun` não foi chamado.
- 2026-09-16 — **F3 (backend das publicações programadas) concluído**, sem commit. Novos:
  `convex/groupPosts.ts`, `convex/groupPostWorker.ts`, `convex/lib/groupPostCore.ts`,
  `convex/lib/groupPostOps.ts`, `convex/lib/groupPostPrompt.ts` (+ `groupPosts.test.ts` e
  `lib/groupPostCore.test.ts`). Tocados: `schema.ts`, `crons.ts`, `exports.ts`,
  `emailTemplates.ts`, `llmsTxt.ts`, `lib/notify.ts`, `lib/agentRoutes.ts`, `agentRuns.ts`,
  `DevelopersPage.tsx`, `NotificationPanel.tsx`. 75 testes novos; suíte 1034 verde em 62 arquivos
  e `npm run lint` verde. Falta a UI (aba Publicações) e o E2E vivo.
- 2026-09-16 — **F1 (núcleo backend) concluída**, sem commit. 3 arquivos novos em `convex/lib/` (`bridgeGroups.ts`, `groupChatCore.ts`, `leadRef.ts`), `convex/groupChats.ts` novo, parser/ingest/dispatch/schema tocados; 89 testes novos; suíte 951 verde e `npm run lint` verde. Fixtures de `GroupInfo`/`JoinedGroup` são SINTÉTICAS — revalidar na F8.
- 2026-09-16 — **F2 (UI base) concluída**, sem commit. Novos: `src/lib/groupDisplay.ts`,
  `src/components/inbox/GroupMembersPanel.tsx`, `GroupMentionText.tsx`,
  `GroupMentionComposer.tsx`, `src/components/settings/BridgeGroupsPanel.tsx`,
  `src/components/groups/GroupsPage.tsx`, `GroupAiPolicyModal.tsx`,
  `groups/posts/GroupPostsTab.tsx` (stub da F3). Tocados: `Inbox.tsx`,
  `inbox/MessageBubble.tsx`, `inbox/types.ts`, `inbox/ConversationActionsMenu.tsx`
  (slot `renderExtraItems`), `settings/ChannelsSection.tsx`, `ContactDetailPanel.tsx`,
  `layout/Sidebar.tsx`, `layout/BottomTabBar.tsx`, `lib/routes.ts`, `main.tsx`,
  e `convex/groupChats.ts` (+ 3 funções, `selfKey`) com 9 testes novos.
  `npm run lint` inteiro verde e suíte 1034 verde em 62 arquivos.
- 2026-09-17 — **Termos/LGPD, landing e flags do MCP de preferências**, sem
  commit. `src/pages/TermsPage.tsx`: cláusula 6 "Grupos de WhatsApp" (opt-in por
  grupo; só sala acompanhada guarda participantes e conteúdo; desmarcar apaga a
  lista e arquiva a conversa; controlador/operador sobre dados de terceiros;
  webhooks e API que carregam JID/LID, telefone e conteúdo; IA na sala e o aceite
  extra para publicar sem revisão; disparo para membros com base legal declarada,
  tetos e supressão, remetendo ao risco de ban da cláusula 5; direitos dos
  titulares), seções 6–11 renumeradas para 7–12.
  `src/pages/PrivacyPage.tsx`: categoria de dados "membros de grupos de WhatsApp"
  na cláusula 2, cláusula 5 nova (finalidade, base legal a cargo do Cliente,
  retenção, compartilhamento com provedor LLM e webhooks do Cliente), parágrafos
  de IA/webhooks em Compartilhamento, retenção de grupo em Retenção e os membros
  em Direitos do titular; seções 5–11 renumeradas para 6–12. Vigência das duas
  páginas: 17 de setembro de 2026. `src/components/LandingPage.tsx`: card
  "Grupos de WhatsApp" (ícone `MessagesSquare`) e contadores corrigidos —
  113 endpoints REST (era 64) e 66 tools MCP (era 46), conferidos contra
  `convex/router.ts` e `mcp-server/src/tools/`.
  `mcp-server/src/tools/notifications.ts`: os 19 flags de `PREFERENCE_FLAG`
  declarados no zod, com descrições PT-BR (faltavam 11, não 9 — `taskDueSoon` e
  `taskCommentMention` também não estavam lá); doc no README do mcp-server e em
  `.claude/skills/hnbcrm/references/API_REFERENCE.md`. Validação:
  `npx tsc -p tsconfig.app.json --noEmit` limpo, `npm run build` da raiz verde,
  `npm run build` do mcp-server verde. Contadores desatualizados FORA do escopo
  desta tarefa, não tocados: `DevelopersPage.tsx` (64, em edição por outra
  frente), `PlaygroundPage.tsx` (44) e `DashboardOverview.tsx` (64).
- 2026-09-17 — **Fechamento da rodada (orquestração)**: sobras do review (segurança 14, UI do `groupAutopilotAck`, correção 22 parte 2) fechadas; seção nova no `CLAUDE.md`; validação final pelo orquestrador: `npm run test` 1272/1272 em 68 arquivos, `npm run lint` verde, build do mcp-server verde. Nada commitado. Pendente: E2E vivo com o Eric, Termos/LGPD, flags novos no MCP de preferências, F6/F7 aguardando aprovação (F7 = lembrete de detalhar a Meta Groups API após o OK do bridge).
- 2026-09-17 — Termos/Privacidade (cláusula de grupos, revisão jurídica pendente), card na landing, 11 flags no zod do MCP e contadores de rotas (113) corrigidos em Playground/Dashboard/Developers. `npm run dev` deixado rodando para o E2E vivo do Eric (Vite em http://localhost:5173, Convex dev tacit-chicken-195).
- 2026-09-17 — **Seleção de membros no wizard (§7.1)**, sem commit. O público
  "Membros de grupos" passou a mostrar QUEM vai receber, não só quantos:
  `memberFilters.includeKeys` (novo, `convex/schema.ts`), `includeKeys` +
  `memberList` em `buildGroupMembersAudience` (`convex/lib/campaignAudience.ts`,
  com o motivo `not_selected` e `normalizeIncludeKeys`), `members[]` na resposta
  de `campaigns.previewAudience` com o telefone cru só sob `inbox:view_all`,
  seção "Quem vai receber" em `src/components/campaigns/steps/GroupAudienceTabs.tsx`
  e contagem "escolhidas a dedo" no passo Revisão. Copiloto (`resolveMemberFilters`),
  tools (`lib/agentTools.ts`), MCP (`mcp-server/src/tools/campaigns.ts`) e docs
  (`llmsTxt.ts`, `apiRegistry.ts`) acompanham. Regressão do lançamento em modo
  seguro coberta por 2 testes novos. Validação: `campaignsGroups` 39,
  `lib/campaignAudience` 44, `campaigns` + `routerPermissions` + `campaignsApi`
  verdes (120 no conjunto pedido), `npx tsc -p convex --noEmit` e
  `npx tsc -p tsconfig.app.json --noEmit` limpos.
- 2026-09-17 — E2E vivo (Eric): 3 correções — (1) `StepChannel` zerava o grupo pré-selecionado do botão "Disparar 1 a 1" ao escolher o canal; (2) `StepLimits` pedia defaults seguros sem `audienceSource` (pacing 1:1 acima do teto de sala) + `launchCampaign` em modo seguro agora REALINHA ao seguro em vez de exigir ENTENDO; erros de `campaigns.ts` viraram `ConvexError` (mensagem chega ao toast); (3) Inbox fixava a conversa do deep-link no topo de "Arquivadas" mesmo ativa — só fixa quando bate com a aba e o filtro. Seleção de membros na prévia (`memberFilters.includeKeys`) entregue.
