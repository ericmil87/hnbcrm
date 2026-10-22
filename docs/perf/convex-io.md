# Database I/O do Convex — registro de medição (out/2026)

**Estado em 22/10/2026 ~01:50 UTC: todas as fases (1, 2, 3, 4a, 4b+limpeza, 4c, 4d) publicadas em `main` (PRs #5–#12), prod e dev; migrações de dados concluídas em prod. Próximo passo: leitura 2 do painel (~29/10) para fechar o antes/depois em bytes.**

Contexto: plano Free estourou **Database bandwidth** (2,04 GB de 2 GB) com Function Calls em 249K de 2M. O gargalo é bytes lidos/escritos, não número de chamadas. Dev (`tacit-chicken-195`) e prod (`careful-anaconda-127`) consomem a mesma cota.

Auditoria de origem (somente leitura, 21/10/2026): `projects_manager/prompts/convex-io/auditoria-convex-dossie.md`, seções "HNBCRM — backend" e "HNBCRM — frontend".

Como o Convex cobra (premissas usadas aqui): cada leitura conta o documento inteiro (projetar campos no `return` não reduz); toda query reativa é reexecutada por completo quando qualquer documento que ela leu muda; cron roda igual em dev e prod.

## Como medir

Dashboard Convex → **Usage** → selecionar o deployment (prod e dev separados) → métrica **Database bandwidth** → quebra por função → mês atual. Colar os números abaixo antes e depois de cada fase.

## Medição do painel (colada pelo Eric)

### Leitura 1 — 22/10/2026 ~00:50 UTC (período corrente do plano; Fases 1–4b já em prod há 2–27 h, então mistura antes e depois)

| Métrica (projeto, prod + dev) | Valor |
|---|---|
| Function Calls | 181K |
| **Database I/O** | **1,46 GB** (o estouro relatado em 21/10 era 2,04 GB de 2 GB) |
| Database Storage | 44,34 MB |
| Action Compute | 0,51 GB-h |
| Data Egress | 333,24 MB |

Quebra por **Function Calls** (top; o painel de I/O por função ainda não foi colado): `/webhooks/bridge` 29K prod + 2,2K dev; `channelConfigs.internalGetConfigByBridgeInstanceId` 29K prod; `conversations.internalApplyGroupReceipt` 10K prod + 805 dev; `tasks.processOverdueReminders` 6K dev + 5,5K prod (cron de 5 min até 21/10); `channelHealth.internalGetProbeTarget`/`internalRecordHealthCheck` 5,1K prod; `formPartials.internalMarkAbandoned` 3K dev + 2,7K prod; `getConversations` 2,4K prod + 266 dev; `getMessages` 1K prod; `getInboxUnreadCount` 1,2K prod; `getTaskCounts` 825 prod + 330 dev; `getDashboardStats` 209 prod; crons horários ≈465 prod / ≈505 dev cada.

Leitura: as chamadas de cron no dev (6K lembretes, 3K parciais, 1,7K health, ≈505 por cron horário) somem com `CRONS_DISABLED=1`; os 5,5K + 6K de `processOverdueReminders` viram ≈744/mês cada; `internalGetConfigByBridgeInstanceId` (29K) continua (1 doc de 1–2 KB por webhook, fora do escopo). **Falta a quebra "Database I/O" por função** para fechar o antes/depois em bytes.

### Leitura 2 — _pendente_ (colar ~7 dias depois do último deploy, prod e dev separados, aba "Database I/O" da quebra por função)

## Fase 1 — crons que rodam sem usuário

Branch: `perf/convex-io-fase1` → PR #5, mergeado em `main` (9aae88b) e PUBLICADO em prod pelo Vercel em 21/10/2026 ~21:17 UTC; dev recebeu as funções via `convex dev --once` no mesmo dia e tem `CRONS_DISABLED=1`. `opsTasks:internalCountCronBacklog` em prod logo após o deploy: **0** lembretes vencidos pendentes e **0** recorrências sem sucessor em todos os ranges — nenhum carimbo foi necessário, sem burst.

### Mudanças

| Cron | Antes | Depois |
|---|---|---|
| `tasks.processOverdueReminders` (resgate de lembretes) | a cada 5 min, `take(500)` de `tasks` SEM range (deployment inteiro), filtro em JS; com >500 tasks, orgs no fim do índice nunca recebiam lembrete | a cada 1 h, índice `by_type_and_status_and_reminder_and_due` (`type, status, reminderTriggered, dueDate`), 4 ranges (`pending`/`in_progress` × `undefined`/`false`) com `.gt("dueDate", undefined).lte("dueDate", now)`; lê só o que está vencido e não disparado |
| `tasks.processRecurringTasks` (recorrência) | a cada 1 h, `take(500)` sem range + uma varredura extra agendada a cada conclusão | a próxima instância nasce NA CONCLUSÃO (`generateNextRecurrence` em `lib/taskOps.ts`, chamado por `applyTaskCompletion` e por `updateTask` com status `completed`); o cron vira resgate pelo índice `by_status_and_recurrence_pattern_and_generated` (só concluídas que nunca geraram, 4 padrões × 50); carimba `lastGeneratedAt` também ao pular por `endDate`/sucessor/erro |
| `groupAgent.internalRunGroupDigests` | `groupChats.take(200)` sem índice de hora em hora (salas acompanhadas carregam `participants` de até 1.024 itens, 60–90 KB cada) | índice `by_monitored_and_digest_at` (`monitored, ai.dailyDigestAt`): só salas acompanhadas COM digest configurado; cache de org no loop |
| `email.sendDailyDigest` | por org com destinatário: 500 leads + 500 tasks lidos só para contar 24 h | `leads.by_organization_and_created` (range 24 h), `tasks.by_organization_and_completed_at` (range 24 h), `tasks.by_organization_and_status_and_due_date` (2 status × `< now`); teto 500 por range |
| `exports.internalCleanupExpired` | BUG: job limpo continuava `completed` com `expiresAt` passado → os mesmos 100 jobs relidos toda hora para sempre, e jobs vencidos depois deles nunca limpos | status novo `expired` (schema, front "Expirado", OpenAPI, llms.txt); job sem blob também vira `expired`; retorno `{deleted, expired}` |
| `formPartials.internalMarkAbandoned` | `.collect()` | `take(200)` por rodada (10 min) |
| Todos os 10 crons | rodam igual em dev | `convex/lib/cronGuard.ts`: `if (cronsDisabled()) return …` na 1ª linha de cada handler; `CRONS_DISABLED=1` só no deployment DEV (env em runtime — env lida em `crons.ts` só é reavaliada no deploy) |

Índices novos (schema aditivo, sem migração): `tasks.by_type_and_status_and_reminder_and_due`, `tasks.by_status_and_recurrence_pattern_and_generated`, `tasks.by_organization_and_status_and_due_date`, `tasks.by_organization_and_completed_at`, `groupChats.by_monitored_and_digest_at`. Custo único: backfill dos índices no deploy (uma leitura de `tasks` e de `groupChats`).

### Mudanças de comportamento visíveis

- Lembrete de RESGATE (agendamento por task perdido) chega em até 1 h em vez de 5 min. O lembrete normal continua por `runAfter` no create/snooze, e agora TAMBÉM na instância recorrente e ao mudar o prazo de um lembrete (antes dependiam do cron).
- Orgs com mais de 500 tasks passam a receber lembrete pelo cron (bug corrigido).
- Próxima instância de tarefa recorrente aparece no instante da conclusão, não até 1 h depois.
- Export vencido aparece como "Expirado" na tela de Dados (sem download, sem "expira em").
- Digest diário: contagem de atrasadas cobre todas as pendentes/em andamento vencidas (até 500 por status); antes só as que estivessem entre as 500 tasks mais recentes.
- `triggerReminder` (job por task) passou a ignorar job cujo `dueDate` ainda está mais de 1 min no futuro: ao adiar o prazo de um lembrete, o job do prazo antigo não dispara mais cedo; o novo job, agendado na edição, dispara no prazo novo.
- Com `CRONS_DISABLED=1` no dev, nenhum cron faz nada lá (lembrete por task e recorrência na conclusão continuam funcionando).

### Burst do primeiro deploy em prod (decisão do operador)

Os índices novos alcançam o deployment inteiro: lembretes vencidos antigos que o `take(500)` nunca via dispararão notificação + e-mail "Tarefa atrasada", e recorrentes concluídas antigas sem `lastGeneratedAt` gerarão uma instância. Logo após o deploy (o primeiro tick pode vir em até 1 h), medir e, se relevante, carimbar o legado sem notificar (`convex/opsTasks.ts`; usa os MESMOS ranges dos crons; lembrete adiado com `snoozedUntil` futuro fica de fora; recorrente sem `completedAt` conta como antiga):

```bash
npx convex run --prod opsTasks:internalCountCronBacklog '{}'
npx convex run --prod opsTasks:internalStampLegacyCronBacklog '{}'                 # dryRun: ids por org
npx convex run --prod opsTasks:internalStampLegacyCronBacklog '{"dryRun":false}'   # repetir enquanto truncated:true
npx convex run --prod opsTasks:internalCountCronBacklog '{}'                       # sobra só < 7 dias
```

`olderThanDays` (default 7) e `limit` (default 500, teto 2000) são ajustáveis. O que tiver menos dias que o corte continua elegível e dispara normalmente.

### Limites conhecidos (documentados no código)

- Lembrete adiado (`reminderTriggered:false`, prazo vencido, `snoozedUntil` futuro) ocupa vaga no range `false`; com >100 adiados no deployment, vencidos reais depois deles esperam a rodada seguinte.
- O resgate de recorrência não cobre "reabrir e concluir de novo" (`lastGeneratedAt` já existe); esse caso é do caminho de conclusão.
- Preexistente: `triggerReminder` (job por task) grava activity + webhook; o cron grava notificação + e-mail. Como o cron agora alcança todas as orgs, o canal do aviso depende de quem disparou primeiro.

### Estimativa de redução (por deployment e por mês; S = tamanho médio do doc, desconhecido)

| Item | Antes | Depois |
|---|---|---|
| Lembretes | min(N_tasks, 500) × S × 8.928 ticks → ≈1,2 GB com 200 tasks de 0,7 KB; ≈3 GB com ≥500 | ≈0 (ranges quase sempre vazios, 720 ticks) |
| Recorrência | ≈100 MB (200 × 0,7 KB × 744) + varredura por conclusão | ≈0 |
| Digest de grupos | ≈190 MB (20 salas, 3 acompanhadas de 75 KB, 744 ticks) | ≈0 (nenhuma sala com digest configurado hoje) |
| Digest diário | ≈170 MB (5 orgs × 1.000 docs × 31) | alguns MB |
| Exports | ≈70 MB (100 jobs presos × 1 KB × 744) | 1 leitura por job |
| **Total** | **≈1,5–1,8 GB** com 200 tasks (mais com N maior) | **< 20 MB** |

Com `CRONS_DISABLED=1` no dev, o I/O de cron do dev vai a zero. A conta depende de N_tasks e S reais — a medição do dashboard é que fecha o número.

### Medição depois

| Deployment | Database bandwidth (mês) | Observação |
|---|---|---|
| prod | _pendente_ | |
| dev | _pendente_ | |

## Fase 2 — frontend: queries reativas caras

Branch: `perf/convex-io-fase2` → PR #6, mergeado em `main` (79fd1ba) e PUBLICADO em prod pelo Vercel em 21/10/2026 ~22:51 UTC (bundle `index-DreHCUuq.js`); dev via `convex dev --once` (3 índices). Sem erros nos logs de prod; Inbox e funil conferidos no navegador (org Eric Milfont: 17 conversas ativas, abaixo do lote de 50).

### Mudanças

| Query / tela | Antes | Depois |
|---|---|---|
| `conversations.getConversations` (Inbox) | `take(200)` por `by_organization_and_last_message`, arquivadas filtradas DEPOIS do take; batchGet de lead/contato/responsável/canal/grupo + última mensagem por conversa | índice `by_organization_and_archived_and_last_message`: ativas `eq(archivedAt, undefined)`, arquivadas `gt(archivedAt, undefined)`; default **50** (teto 500); "Carregar mais conversas" (+50) com `useKeepPrevious` (sem piscar); `LeadDetailPanel` `limit: 20`, `ForwardModal` `limit: 50`; ramos da Central mantêm `max(limit, 200)` até terem índice próprio |
| `conversations.getMessages` (conversa aberta) | `take(500)` ASC = as 500 mais ANTIGAS (bug) com `metadata.raw` e anexos | `limit` (default 50, teto 500) `.order("desc")` + inversão; "Carregar mensagens anteriores" no topo com rolagem preservada; busca/citação sobe o lote de 100 em 100 e no teto avisa; `HandoffPeekSlideOver` `limit: 30` |
| `conversations.markConversationRead` | até 20 `patch` em `messages` reescrevendo `metadata` inteiro (`readAt`), cada um invalidando a thread aberta | só `lastReadAt` + `unreadCount` na conversa; marca d'água por `_creationTime` (em grupo `createdAt` é o `sentAt`); nada escrito sem inbound novo; recibos do bridge inalterados |
| `conversations.getInboxUnreadCount` (Sidebar/BottomTabBar, sempre vivo) | `.collect()` de toda conversa com unread > 0 (arquivadas inclusive) | índice `by_organization_and_archived_and_unread`, `take(100)` ("99+" já existia); arquivar (single/bulk) zera `unreadCount` |
| `KanbanBoard` | `getDashboardStats` (≈5.000 docs: boards, 500 leads/board, 2.000 leads, 2.000 tasks…) só para contar leads por board | `boards.getLeadCountsByBoard` com índice `leads.by_organization_and_board_and_archived`, ≤ 500 leads por board ativo ("500+" ao saturar) |
| `getTaskCounts` em TasksPage / UpcomingTasksWidget / MyTasksWidget | `now` novo a cada 60 s nos args = assinatura nova + execução completa por minuto por aba; Dashboard com 2 assinaturas distintas | `useRoundedNow` (15 min, um `setTimeout` por fronteira; puro em `src/lib/roundedNow.ts`) compartilhado → 4 execuções/h por aba e 1 assinatura no Dashboard |
| `UpcomingTasksWidget` | `getTasks` sem limit (600 docs: as 600 criadas mais recentes, concluídas inclusive) | `tasks.getUpcomingTasks({organizationId, now, limit})`: só pendentes/em andamento, faixas futuras ASC + atrasadas mais recentes DESC + sem prazo, ≤ 300 docs |
| `CopilotPanel` fechado | `getThreadMessages` assinado com o painel fechado | `"skip"` quando `!open`, cache do último resultado por `threadId` |

### Mudanças de comportamento visíveis

- Inbox começa com 50 conversas e 50 mensagens recentes; desde o PR #13 (22/10/2026) rolar até o fim da lista ou até o topo da thread carrega o próximo lote automaticamente (scroll infinito, `useInfiniteSentinel`), e os botões "Carregar mais conversas" / "Carregar mensagens anteriores" ficam como fallback. Conversa com >500 mensagens passa a mostrar as mais RECENTES (antes mostrava as 500 mais antigas).
- Desarquivar uma conversa não restaura o contador de não lidas (foi zerado ao arquivar).
- Contadores "atrasadas"/"vence hoje" avançam a cada 15 min (na fronteira do relógio) e na hora quando uma tarefa muda; uma tarefa vencida há poucos minutos só conta na próxima fronteira.
- Widget do painel mostra tarefas abertas por prazo (futuras e as atrasadas mais recentes), não as 600 criadas mais recentemente.
- Kanban mostra "500+" quando um funil passa de 500 leads.
- Copiloto reabre rolado até o fim.

### Limites conhecidos (follow-up)

- Ramos da Central (`departmentId`/`unitId`) ainda usam índices por criação e filtram arquivadas depois do take; precisam de índice `[organizationId, departmentId, archivedAt, lastMessageAt]`.
- "Carregar mais" depende de o lote voltar cheio; filtros aplicados depois do take (canal, responsável) podem escondê-lo mesmo havendo mais.
- Ao chegar mensagem nova com o lote em 50, a mais antiga sai do topo e a rolagem desloca a altura dela (cosmético).
- `getTaskCounts` calcula "hoje" com `setHours` no fuso do servidor (preexistente).
- `conversations` arquivadas pelos caminhos de `groupChats.ts` não zeram `unreadCount` (não contam mais no badge graças ao índice, mas o campo fica).

### Estimativa de redução (por EXECUÇÃO; multiplica pelo nº de reexecuções = webhooks × abas abertas)

| Query | Antes | Depois |
|---|---|---|
| `getConversations` | ≈200 × (conv + lead + contato + msg) ≈ 1–1,6 MB | ≈50 × idem ≈ 0,25–0,4 MB (−75%) |
| `getMessages` | min(N, 500) × 1–3 KB ≈ até 1,5 MB | 50 × 1–3 KB ≈ 75–150 KB (−90% em conversa longa) |
| `markConversationRead` | 1 patch na conversa + até 20 patches de `metadata` + 20 invalidações da thread | 1 patch (ou nenhum) |
| `getInboxUnreadCount` | todas as não lidas, arquivadas inclusive | ≤ 100 docs ativos |
| Kanban (contador) | ≈5.000 docs | ≤ 500 × funis ativos |
| `getTaskCounts` | 60 execuções/h/aba × 2.000 docs | 4 execuções/h/aba × 2.000 docs (−93%) |
| `UpcomingTasksWidget` | 600 docs | ≤ 300 docs |

### Medição depois

| Deployment | Database bandwidth (mês) | Observação |
|---|---|---|
| prod | _pendente_ | |
| dev | _pendente_ | |

## Fase 3 — writes que invalidam o Inbox

Branch: `perf/convex-io-fase3` → PR #7, mergeado em `main` (7232003) e PUBLICADO em prod pelo Vercel em 21/10/2026 23:11 UTC; dev via `convex dev --once`. Revisão independente: 1 achado médio (claim do número no "Testar conexão") + baixos, corrigidos antes do merge.

### Mudanças

| Ponto | Antes | Depois |
|---|---|---|
| `conversations.internalApplyGroupReceipt` (10K/mês prod) | `patch` SEMPRE, inclusive `{}` ("delivered" do 2º membro em diante); `appendReadBy` sempre gerava array novo (releitura reescrevia `readBy`); hook de campanha a cada recibo | `readBy` só com jid NOVO (primeira leitura vence); patch só com o que mudou, `continue` quando vazio; hook de campanha só na transição de status com `metadata.campaign` |
| `conversations.internalUpdateDeliveryStatus` (recibos 1 a 1 do bridge e `statuses` da Meta) | gravava `deliveryStatus` incondicionalmente (rebaixava `read → delivered` fora de ordem) e chamava o hook de campanha sempre (consulta `campaignRecipients.by_message` por recibo) | `DELIVERY_RANK` compartilhado: status só sobe, `failed` sempre aplica; sem mudança = sem patch e sem hook; hook exige `metadata.campaign` |
| `channelConfigs.internalRecordHealthCheck` (cron de 15 min + manual) | patch com `lastHealthCheckAt`/`updatedAt` = `Date.now()` em TODO tick → reexecutava `getConversations` em toda aba a cada 15 min; `claimBridgePhone` (`.collect()`) a cada tick | patch campo a campo (vazio não grava); `updatedAt` só com mudança real; `lastHealthCheckAt` com mudança, a cada 6 h (`HEALTH_STAMP_INTERVAL_MS`) ou `forceStamp` (botão "Testar conexão"); `claimBridgePhone` só com número novo ou canal que não estava conectado; `pauseCampaignsForChannel` só na transição |
| `lib/groupChatCore.recordParticipantFromMessage` | patch de `participants` (até 1.024 itens, 60–90 KB) em TODA mensagem de grupo acompanhado; `lastMessageAt`/`updatedAt` a cada mensagem | `mergeParticipantWithFlag` → `{list, changed}`; `participants` só com mudança; `lastMessageAt` com granularidade de 60 s (`GROUP_ACTIVITY_GRANULARITY_MS`); patch vazio não grava |
| `conversations.internalReceiveGroupMessage` | agendava `internalEnqueueFromGroup` em toda mensagem (mutation com 4 leituras, inclusive a sala) e lia `channelConfigs` sempre | agenda só com `group.ai.mode === "mention"`; lê a config só quando há `mentions` |
| `whatsapp.internalRouteInbound` | `findAttendantForChannel` (`.collect()` de membros IA com `agentProfile.systemPrompt/knowledge`) + leitura da org em TODA mensagem 1 a 1 | `ensureLeadForContact` recebe `resolvePipeline` chamado só ao CRIAR o lead; lead existente não lê org nem membros IA |

Sem mudança de schema. Fora de escopo (documentado): `configSnapshot` do `/webhooks/bridge` (config lida 3× por mensagem, ~45 MB/mês); `internalReceiveGroupDeviceMessage` ainda grava `lastMessageAt` incondicional.

### Mudanças de comportamento visíveis

- `readBy.at` de um membro não é atualizado numa releitura (vale a primeira).
- "Checado às HH:MM" do card do canal avança a cada 6 h no cron; o botão "Testar conexão" ainda atualiza na hora.
- Se outra conta parear o MESMO número depois, é a conexão dela que desativa o nosso canal; o tick de rotina não desativa o rival.
- "Ativo há X" das salas com granularidade de 1 min.

### Estimativa (por mês, prod)

- Recibos de grupo: ≈7–9K patches a menos (de 10K), cada um uma reexecução a menos de `getMessages` por aba.
- Recibos 1 a 1: ≈3–9K patches a menos (duplicados/fora de ordem) + ≈29K consultas a `campaignRecipients` evitadas.
- Health check: ≈2.976 → ≈124 escritas em `channelConfigs` (cada uma reexecutava `getConversations` em toda aba) + outras tantas varreduras de `by_bridge_phone`.
- Grupo acompanhado: doc de 60–90 KB não reescrito quando o mesmo membro fala de novo no mesmo minuto; o Inbox deixa de reexecutar 2× por mensagem.
- 1 a 1 com lead existente: dezenas de KB (membros IA com knowledge) a menos por mensagem.

### Medição depois

| Deployment | Database bandwidth (mês) | Observação |
|---|---|---|
| prod | _pendente_ | |
| dev | _pendente_ | |

## Fase 4 — estrutural (aprovada pelo Eric em 21/10/2026, dividida em 4 PRs)

### 4a — retenção (PR #8, mergeado em `main` 9fbc785 em 22/10/2026 ~00:05 UTC)

Cron diário `data retention` (07:30 UTC) em `convex/retention.ts`: lotes de 200 por transação, uma tabela por vez, teto 20.000 docs/dia, reagendamento até esgotar, corte fixado na 1ª chamada.

| Tabela | O que sai | Janela | Índice |
|---|---|---|---|
| `notifications` | lidas (`readAt`) | 90 d | novo `by_read_at` |
| `aiReplyQueue` | `done`/`skipped`/`failed` por `updatedAt` | 90 d | novo `by_status_and_updated` |
| `agentRuns` | `done`/`error`/`aborted` por `startedAt` | 90 d | novo `by_status_and_started` |
| `formPartials` | `abandoned` por `lastActivityAt` | 30 d | existente |
| `auditLogs` | só `low`, nunca ação `delete` | 180 d | novo `by_severity_and_action_and_created` |

Kill switches `RETENTION_DISABLED=1` (sempre) e `CRONS_DISABLED=1` (só o cron); janelas por env `RETENTION_<TABELA>_DAYS` (piso 7). Ops: `retention:internalRetentionPreview` (só leitura) e `retention:internalRunRetentionNow {dryRun default true, table?, maxDocs?}`. `aiSpend:internalBackfillMonthlyUsage` recusa `dryRun:false` para mês anterior à janela de `agentRuns` e nunca reduz o agregado. Revisado: o gate do autopilot só vale na transição (sem rebaixamento automático); a taxa de parciais de formulário passa a refletir os abandonos dos últimos 30 d (efeito aceito).

### 4b — `conversationRuntime` (PR #9, mergeado em `main` 2ca9b3c e publicado em prod 22/10/2026 ~00:20 UTC; limpeza dos campos legados rodada em prod e dev; PR #11 removeu os 3 campos do schema e o fallback transitório, publicado ~01:05 UTC)

`contactPresence`, `aiTurnLock` e `nextDispatchAt` saem do doc `conversations` para `conversationRuntime` (1 doc por conversa, índices `by_conversation`/`by_organization`; helper único `lib/conversationRuntime.ts`). Cada patch neles reexecutava ~9 queries que leem a conversa (lista do Inbox, `getConversationById`, `getMessages`, chip da IA, follow-ups, roteamento, repasse pendente, agendadas, lista do painel do lead) em toda aba. Presença: query nova `getConversationPresence` assinada só pela conversa aberta. Lock: claim lê a linha pelo índice e grava na mesma transação (OCC preservado). Pacing por conversa lido/gravado no runtime. Limpeza `conversations:internalClearLegacyRuntimeFields {dryRun, cursor}`; rodada em prod e dev em 22/10/2026; os 3 campos e o fallback transitório do lock foram removidos depois (fase 4b — limpeza), junto com a própria op de limpeza. Tabela fora do backup; apagada na cascata/purga.

### 4c — desnormalizar em `conversations` (PR #10, mergeado em `main` ae5cd9a e publicado em prod 22/10/2026 ~00:57 UTC; backfill `internalBackfillListFields` rodado em prod e dev — 1ª página: 200 prévias, 42 providers, 6 grupos; 2ª passagem: 0)

`lastMessagePreview`/`Direction`/`ContentType`/`BridgeType`/`Revoked` + `lastMessageId` (helper único nos ~14 pontos de insert + revoke/edit + nota de transferência), `groupSubject`/`groupParticipantsCount` (6 escritores) e `channelProvider` (4 escritores), para `getConversations` deixar de fazer `batchGet` de `groupChats` (60–90 KB cada) e `channelConfigs` e o `first()` em `messages` por conversa. Nome do contato fica FORA (≈10 escritores, drift por PushName/IA/import; o `batchGet` de contatos/leads é barato). Leitura com fallback por campo ausente + kill switch por env; backfill paginado.

### 4d — `groupParticipants`/`groupTimeline` (PR #12, mergeado em `main` 5679937 e publicado em prod 22/10/2026 ~01:40 UTC; migração em prod: backfill de 6 salas, finish com `divergent` 0 e `timelineDivergent` 0, 6 salas migradas; dev sem salas a migrar)

Tabelas `groupParticipants` (`by_group`, `by_group_and_key`, `by_group_and_phone`, `by_organization_and_contact`, `by_organization`) e `groupTimeline` (`by_group_and_at`, cap 100), store único `lib/groupParticipantsStore.ts`. Migração em 2 passos: dual-write + leitura pelo array enquanto `groupChats.participantsMigratedAt` não existe; `internalBackfillGroupParticipants` copia; `internalFinishGroupParticipantsMigration` confere membros, grava `participantsMigratedAt`, remove `participants`/`timeline` (o doc encolhe de 60–90 KB para ~1–2 KB) e recalcula `participantsCount`; `internalRestoreGroupArraysFromTable` é o rollback. ~25 leitores trocados; shape de `getGroup`/REST/MCP idêntico. Trade-off: `getGroup` de sala com 1.024 membros lê ~250 KB em linhas (follow-up: query de membros separada). Limites: ops com 10 salas/página (máx. 12); `syncGroups` de canal com >15 salas acompanhadas grandes pode precisar de paginação (follow-up).

### Onda 2 — membros de grupo paginados (`perf/io2-groups-members`)

`groupChats.listGroupMembers` (página de até 50, busca por nome ou começo do telefone) e `resolveGroupMemberNames` substituem a lista inteira no `getGroup` público. Busca por nome usa `groupParticipants.searchName` (nome sem acento/minúsculas, `lib/groupMemberSearch.ts`, gravado pelo store em todo upsert; o search index `search_name` é sobre ele — o Convex não ignora acento). Telefone: prefixo com/sem 55 e com/sem o 9º dígito BR; busca pelo FIM do número (••••5729) não existe. Sala não acompanhada/removida/abandonada devolve vazio nas duas queries (LGPD, até a purga assíncrona terminar). `groupChats.lastSyncAt` da sala passou a significar "última mudança vinda do sync" (a REST/MCP devolvem o doc cru).

**Ordem em prod (e dev):** (1) deploy; (2) `npx convex run --prod groupChats:internalBackfillParticipantSearchName '{}'` (dryRun, 1 página) e depois `'{"dryRun":false}'` (200 linhas/página, se reagenda; idempotente). Até o backfill, linha antiga sem `searchName` não aparece na busca por NOME (listagem e telefone não dependem dele).

## Follow-ups menores (fora das fases)

- Índice `[organizationId, departmentId|unitId, archivedAt, lastMessageAt]` para os ramos da Central em `getConversations` (hoje `max(limit, 200)`).
- Remover `conversations.by_organization_and_unread` (sem uso desde a Fase 2).
- `configSnapshot` do `/webhooks/bridge` (config lida 3× por mensagem, ~45 MB/mês).
- `getTaskCounts` calcula "hoje" com `setHours` no fuso do servidor.
- Caminhos de arquivamento em `groupChats.ts` não zeram `unreadCount` (não afeta mais o badge).
