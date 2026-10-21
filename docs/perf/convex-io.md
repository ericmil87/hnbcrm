# Database I/O do Convex — registro de medição (out/2026)

Contexto: plano Free estourou **Database bandwidth** (2,04 GB de 2 GB) com Function Calls em 249K de 2M. O gargalo é bytes lidos/escritos, não número de chamadas. Dev (`tacit-chicken-195`) e prod (`careful-anaconda-127`) consomem a mesma cota.

Auditoria de origem (somente leitura, 21/10/2026): `projects_manager/prompts/convex-io/auditoria-convex-dossie.md`, seções "HNBCRM — backend" e "HNBCRM — frontend".

Como o Convex cobra (premissas usadas aqui): cada leitura conta o documento inteiro (projetar campos no `return` não reduz); toda query reativa é reexecutada por completo quando qualquer documento que ela leu muda; cron roda igual em dev e prod.

## Como medir

Dashboard Convex → **Usage** → selecionar o deployment (prod e dev separados) → métrica **Database bandwidth** → quebra por função → mês atual. Colar os números abaixo antes e depois de cada fase.

## Baseline (antes da Fase 1)

| Deployment | Database bandwidth (mês) | Function calls (mês) | Top funções por bandwidth |
|---|---|---|---|
| prod `careful-anaconda-127` | _pendente_ | _pendente_ | _pendente_ |
| dev `tacit-chicken-195` | _pendente_ | _pendente_ | _pendente_ |

Chamadas conhecidas (dashboard, out/2026): `/webhooks/bridge` 29K prod; `channelConfigs.internalGetConfigByBridgeInstanceId` 29K prod; `conversations.internalApplyGroupReceipt` 10K prod; `tasks.processOverdueReminders` 5,9K dev + 5,5K prod; `channelHealth.internalGetProbeTarget` 5,1K prod.

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

Branch: `perf/convex-io-fase2`. Status: _em andamento (21/10/2026)_.

## Fase 3 — writes que invalidam o Inbox

_não iniciada_

## Fase 4 — estrutural

_não iniciada (requer aprovação explícita)_
