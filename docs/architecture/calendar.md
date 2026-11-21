# Agenda (calendarEvents)

> PR de correção do backend (21/11/2026), antes da Agenda v2. Auditoria de origem: `temp/agenda-v2/01-auditoria-backend.md` (local, não versionada). Aqui só o que vale para quem mexer no código.

## Modelo

Tabela `calendarEvents` (compromisso interno da equipe; não é agendamento de cliente): `startTime`/`endTime` em epoch ms, `status` `scheduled|completed|cancelled`, vínculos opcionais `leadId`, `contactId`, `taskId`, `attendees[]`, `assignedTo`, `recurrence` (`pattern`, `endDate?`, `lastGeneratedAt?` = carimbo do SISTEMA) e `parentEventId` (a recorrência encadeia: cada ocorrência gerada é filha da anterior). `getEvents` ainda mescla tarefas com `dueDate` na janela como itens `_source:"task"`.

## Portas

- **Núcleo único**: `convex/lib/calendarCore.ts` (com banco) + `convex/lib/calendarRules.ts` (puro). `calendar.ts` só resolve o ator e registra: app = `requirePermission` + `appActor`; REST/MCP = `internal*` com `teamMemberId` (+ `permissions` da chave) + `restActor`. Nenhum caminho grava `calendarEvents` fora do núcleo; validação, audit, activity (`event_created`/`event_completed` quando há lead) e webhook `calendar_event.*` são os mesmos.
- REST: 8 rotas (`ROUTE_PERMISSIONS`), incluindo `POST /calendar/events/cancel`. Erros de regra = 400, evento inexistente = 404, sem permissão = 403.

## Permissões (provisório: categoria `tasks`)

Leitura exige `tasks:view_own`; com `view_own` o membro vê só eventos em que é criador, responsável ou participante; `view_all` ou mais vê todos. Criar exige `edit_own`. Editar/reagendar/concluir/cancelar/excluir: evento próprio (criador ou responsável) com `edit_own`, de outro membro com `edit_all`. Papéis padrão: admin/manager editam tudo; agent/ai veem tudo, mas só mexem nos próprios. Uma categoria própria virá com a Agenda v2.

## Isolamento e leitura

Escrita: `leadId`, `contactId`, `taskId` e cada participante precisam ser da MESMA org (participante e responsável passam por `assertAssignableMember`); só o que MUDOU numa edição é revalidado. Leitura: referências de outra org já gravadas viram `null` (a org é checada antes de enriquecer) e lead/contato/membro saem em projeção mínima (`{_id,title}`, `{_id,firstName,lastName}`, `{_id,name,type}`). A projeção é na saída: o Convex lê o documento inteiro, então a dependência reativa continua (denormalizar nome no evento é trabalho da v2).

## Consulta de grade

`by_organization_and_start` por faixa, olhando `MAX_EVENT_DURATION_MS` (31 dias) para trás, para pegar evento que começa antes e termina dentro. Teto de leitura `EVENTS_SCAN_CAP`; `getEventsWithMeta` devolve `{items, truncated}` (`getEvents` segue devolvendo só o array). REST: cursor `"<startTime>|<_creationTime>"` ordenado por início; `hasMore`/`nextCursor` continuam mesmo quando o teto de leitura corta a página; `truncated` informa. Filtro por lead/contato usa `by_lead`/`by_contact`. Evento legado com duração acima de 31 dias que começou antes da janela não aparece.

## Recorrência

Só nasce ao concluir (sem cron). Idempotente: só `scheduled` conclui, carimbo `lastGeneratedAt` e filho existente (`by_parent_event`) impedem duplicar. Cálculo na hora de parede do fuso da org (`settings.timezone`, via `localParts` + `localInstant`): atravessar horário de verão não desloca a hora; `monthly` em dia 29–31 fixa no último dia do mês curto. Gotcha: como cada ocorrência é calculada a partir da anterior, 31/01 → 28/02 → 28/03 (sem memória do dia original). Excluir apaga a cadeia inteira (teto de 500).

## Validações

Título não vazio (≤200), `endTime >= startTime`, duração ≤ 31 dias, datas finitas (1970–2100), textos com teto, recorrência com fim ≥ início, ≤ 50 participantes; só `scheduled` conclui, cancela ou reagenda. Erros são `ConvexError` em PT-BR.

## Pendências conhecidas

Índices sem leitor (`by_organization`, `by_organization_and_assigned`, `by_organization_and_type`, `by_organization_and_status`, `by_task`, `search_events`) continuam no schema; remoção só em PR próprio. Sem lembrete/notificação, sem sobreposição de horário, sem como limpar campo opcional pela API, `activities` só em criar/concluir.
