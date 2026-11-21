---
paths:
  - "convex/scheduling*.ts"
  - "convex/schema.ts"
  - "convex/opsPurge.ts"
  - "convex/exports.ts"
  - "convex/lib/leadCascade.ts"
  - "convex/lib/sched*.ts"
  - "convex/schedulingPort.test.ts"
  - "convex/schedBooking.test.ts"
  - "convex/schedFoundation.test.ts"
  - "src/components/agenda/**"
---

# Agenda v2 (módulo `scheduling`)

Leia `docs/architecture/agenda.md` antes de mexer. Tabelas `sched*`; `calendarEvents` (compromisso interno) é outra coisa.

- Toda função do motor chama `assertModule(ctx, orgId, "scheduling")` (leitura que alimenta a tela com o módulo desligado devolve vazio). Permissão pela categoria `agenda` (`view_own < view_all < edit < manage`); nunca `tasks`.
- Configuração sempre por `resolveSchedSettings(doc)` (`lib/schedSettingsDefaults.ts`); constantes em `lib/schedConstants.ts`. Doc `schedSettings` ausente = padrões.
- `schedAllocations` só tem linha de agendamento ATIVO (cancelar, remarcar e faltar apagam); capacidade dura usa `coreStart/coreEnd`, folga usa `blockStart/blockEnd`. Não crie índice por org nessa tabela (quente); purga e cascata vão por `by_appointment`.
- Tabela nova de agenda = registrar em `opsPurge.ts` e em `exports.ts` (`BACKUP_TABLES` com índice `by_organization`, ou `EXCLUDED_BACKUP_TABLES` com o motivo).
- Tipo novo de notificação entra com as 5 pontas juntas (`notificationTypesParity.test`), no PR que o usa.
- Ligar o módulo passa por `setOrgModulesCore` (gate de plano só na transição desligado → ligado). Verbo de UI: "Marcar horário"; "Agendar" é envio programado de mensagem.
- Arquivo novo em `convex/` (inclusive `convex/lib/`) = duas linhas à mão em `convex/_generated/api.d.ts`, em ordem alfabética.
- Bloco = duração (com variantes) + folgas ≤ `MAX_BLOCK_MIN`: toda escrita de serviço e toda alocação recusa mais que isso (alocação maior fica invisível à checagem de capacidade e fura a capacidade). `schedAllocations.exclusive` mantém o recurso inteiro ocupado se a capacidade subir.
- Exceção da org inteira só por `by_organization_and_date`. Nunca consulte `by_resource_and_date`, `by_lead_and_start`, `by_contact_and_start`, `by_team_member` com valor `undefined` (lê documento de outra org).
- Contato apagado: agendamento perde `contactId`, `contactName`, `guestName`, `notes`, `cancelReason` (`cascadeContactRefs`). Import/restauração reconstrói as alocações pela porta (ficam fora do backup).
- O `convex-test` NÃO valida `returns` (o runtime recusa campo a mais). Todo validator de retorno de `scheduling*` precisa de teste que compare as chaves devolvidas com o validator, ou ser construído da mesma fonte; módulos novos: `modulesValidatorsParity.test.ts`.
- Nome de índice lista todos os campos (`by_organization_and_status_and_created`).
- **Escrita em `schedAppointments`/`schedAllocations` só em `lib/schedBookingOps.ts`** (guard `schedulingPort.test.ts`: insert, `"schedAllocations"` e `patch/replace/delete` com a tabela citada, fora da lista com motivo). Só `assertCapacityAndAllocate` lê a faixa de capacidade e insere alocação; depende de `L = MAX_BLOCK_MIN` fixo, da leitura na MESMA mutation e do `.collect()` da faixa `[bs − L, be)`. Nunca decida disponibilidade com dado de query, argumento ou oferta: leia dentro da mutation.
- Marcar = `bookAppointmentCore`/`bookPartyCore`; remarcar/cancelar/status/desfazer/trocar sala = os cores irmãos. Nunca crie `schedAppointments` nem libere alocação por outro caminho. `force` só para a classe `staff` e só para `warn`; capacidade ninguém força (exceto `conflictToQueue`, origem `human_message`). IA e link: `pending_approval` por padrão, sem nome de recurso/terceiro na mensagem.
- Um relógio por ato: a mutation lê `Date.now()` uma vez e passa `now` ao core. Todo ato escreve `auditLogs` (com `metadata.statusChange` quando muda status; é o que o desfazer lê), `activities` só com lead, webhook só por `scheduleWebhookEvent`; etapa do funil só por `moveLeadToStageCore` e sem derrubar o ato. Não crie tipo de notificação fora das 5 pontas (`NOTIFY:` marca o ponto de chamada).
- Teste de mutation de agenda: `ConvexError.data` chega como string JSON no `convex-test`; compare as chaves devolvidas com o validator (ver `matchesValidator` em `schedBooking.test.ts`).

