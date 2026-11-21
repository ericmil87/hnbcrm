# Agenda (calendarEvents)

> PR de correção do backend (21/11/2026), antes da Agenda v2. Auditoria de origem: `temp/agenda-v2/01-auditoria-backend.md` (local, não versionada). Aqui só o que vale para quem mexer no código.

## Modelo

Tabela `calendarEvents` (compromisso interno da equipe; não é agendamento de cliente): `startTime`/`endTime` em epoch ms, `status` `scheduled|completed|cancelled`, vínculos opcionais `leadId`, `contactId`, `taskId`, `attendees[]`, `assignedTo`, `recurrence` (`pattern`, `endDate?`, `lastGeneratedAt?` = carimbo do SISTEMA) e `parentEventId` (a recorrência encadeia: cada ocorrência gerada é filha da anterior). `getEvents` ainda mescla tarefas com `dueDate` na janela como itens `_source:"task"`.

## Portas

- **Núcleo único**: `convex/lib/calendarCore.ts` (com banco) + `convex/lib/calendarRules.ts` (puro). `calendar.ts` só resolve o ator e registra: app = `requirePermission` + `appActor`; REST/MCP = `internal*` com `teamMemberId` (+ `permissions` da chave) + `restActor`. Nenhum caminho grava `calendarEvents` fora do núcleo; validação, audit, activity (`event_created`/`event_completed` quando há lead) e webhook `calendar_event.*` são os mesmos.
- REST: 8 rotas (`ROUTE_PERMISSIONS`), incluindo `POST /calendar/events/cancel`. Erros de regra = 400, evento inexistente = 404, sem permissão = 403.

## Permissões (categoria `agenda`)

Categoria `agenda` (`none < view_own < view_all < edit < manage`), a mesma da Agenda v2. `view_own` lê só os eventos em que o membro é criador, responsável ou participante; `view_all` lê todos; `edit` lê todos, cria e altera/reagenda/conclui/cancela/exclui QUALQUER compromisso da org (é o nível da recepção, que remarca o compromisso de um colega); `manage` = `edit` + configuração do módulo (serviços, recursos, regras). `view_all` nunca escreve, nem o próprio evento. Defaults: admin `manage`; manager/agent/ai `edit` (portanto agent/ai voltam a mexer em compromisso de colega, como antes da correção que limitou a escrita aos próprios; a mudança é por decisão de produto). `canEdit` por item = `canEditEvent` (nível `edit`); tarefa mesclada segue `false`. Sem `view_own` as queries devolvem vazio/`null` e as mutations lançam "Permissão insuficiente". Membro com permissões explícitas gravadas sem `agenda` cai no default do papel (`resolvePermissions`), NÃO no nível de `tasks`.

**Chave de API legada.** Chave com `permissions` gravadas antes de existir `agenda` não tem a chave; `completeLegacyPermissions` (`lib/permissions.ts`, pura) deriva `agenda` do `tasks` da PRÓPRIA chave: `none→none`, `view_own→view_own`, `view_all→view_all`, `edit_own|edit_all|full→edit` (nunca `manage`). Aplicada em `authenticateApiKey` (`router.ts`, vale para toda rota e para o `permissions` repassado ao calendário), em `startConversation.resolveStartActor` (teto da chave) e em `calendarRules.memberPermissions` (override da chave). Idempotente: chave que já tem `agenda` (inclusive `none`) não muda. Efeito colateral aceito: uma chave com `tasks: edit_own` ganha `edit` e passa a poder alterar evento de colega pelo REST (antes só os próprios). Chave sem `permissions` (herda o membro) usa `resolvePermissions` e já tem `agenda`.

## Isolamento e leitura

Escrita: `leadId`, `contactId`, `taskId` e cada participante precisam ser da MESMA org (participante e responsável passam por `assertAssignableMember`); só o que MUDOU numa edição é revalidado. Leitura: referências de outra org já gravadas viram `null` (a org é checada antes de enriquecer) e lead/contato/membro saem em projeção mínima (`{_id,title}`, `{_id,firstName,lastName}`, `{_id,name,type}`). A projeção é na saída: o Convex lê o documento inteiro, então a dependência reativa continua (denormalizar nome no evento é trabalho da v2).

## Consulta de grade

Duas faixas de índice (o widget "Hoje" não lê 32 dias): eventos curtos por `by_organization_and_start` em [início − 1 dia, fim]; eventos longos (duração > 1 dia) por `by_organization_and_long_start` em [início − 31 dias, fim]. `longStart` (= `startTime`) só existe em evento longo e é mantido em create/update/reschedule/recorrência (`longStartFor`); legado sem o campo: `opsCalendar:internalBackfillCalendarLongStart` (`dryRun` default true; rodar em DEV e PROD). Até rodar, evento longo legado que começou mais de 1 dia antes da janela não aparece (igual a antes). Teto de leitura `EVENTS_SCAN_CAP` por faixa; `truncated` = teto atingido OU mais itens que o limite (`EVENTS_APP_LIMIT` = 1000 no app; o REST pagina com máx. 500, por isso o app tem limite maior). `getEventsWithMeta` devolve `{items, truncated}` (`getEvents` segue devolvendo só o array). Cada item traz `canEdit` (calculado para o chamador; tarefa mesclada = `false`). Sem permissão de ver nada (`agenda: none`) as queries devolvem `[]`/`null` em vez de lançar: o Painel monta `getEvents` em toda abertura. REST: cursor `"<startTime>|<_creationTime>"` ordenado por início; `hasMore`/`nextCursor` continuam mesmo quando o teto de leitura corta a página (a partir da última linha lida da faixa cortada); `truncated` informa. Filtro por lead/contato usa `by_lead`/`by_contact`: se o lead tem mais de 1500 eventos devolve `hasMore:false` + `truncated:true` (sem cursor). Evento com duração acima de 31 dias não é encontrado a partir de 31 dias depois do início.

## Recorrência

Só nasce ao concluir (sem cron). Idempotente: só `scheduled` conclui, carimbo `lastGeneratedAt` e filho existente (`by_parent_event`) impedem duplicar. Cálculo na hora de parede do fuso da org (`settings.timezone`, via `localParts` + `localInstant`): atravessar horário de verão não desloca a hora; `monthly` em dia 29–31 fixa no último dia do mês curto. `recurrence.anchorDay` (só o servidor grava; mensal) guarda o dia original: 31/01 → 28/02 → 31/03; série antiga sem o campo deriva do dia atual como antes; mover o início re-ancora. Excluir apaga o evento e só os descendentes ainda `scheduled`; concluídos/cancelados ficam com `parentEventId` limpo; o audit guarda quantos foram apagados e preservados; cadeia acima de `DELETE_DESCENDANTS_CAP` (400) não apaga nada.

## Validações

Título não vazio (≤200), `endTime >= startTime`, duração ≤ 31 dias, datas finitas (1970–2100), textos com teto, recorrência com fim ≥ início, ≤ 50 participantes; só `scheduled` conclui, cancela ou reagenda. Erros são `ConvexError` em PT-BR.

## Pendências conhecidas

Índices sem leitor (`by_organization_and_assigned`, `by_organization_and_type`, `by_organization_and_status`, `by_task`, `search_events`; `by_organization` é lido por `opsPurge.ts` e `opsCalendar.ts`) continuam no schema; remoção só em PR próprio. Sem lembrete/notificação, sem sobreposição de horário, sem como limpar campo opcional pela API, `activities` só em criar/concluir.
