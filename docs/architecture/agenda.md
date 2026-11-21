# Agenda v2 (módulo `scheduling`, tabelas `sched*`)

> Agenda de agendamentos de cliente por recurso (salas, profissionais, equipamentos). Convive com a agenda interna de compromissos (`calendarEvents`, ver `calendar.md`), que NÃO muda de tabela. Plano de origem: `temp/agenda-v2/10-PLANO-IMPLEMENTACAO.md` (local, não versionado). Cada PR da v2 acrescenta aqui o parágrafo da sua parte.

## Estado atual (PR A1, fundação)

Só dados, módulo, plano e permissão. Nenhuma função do motor existe ainda (vêm em A2, A3a, A3b…). Org que não liga o módulo lê tudo desligado e nada muda.

- **Nomes.** Módulo `scheduling` (`OrgModuleKey`, `GatedModule`); categoria de permissão `agenda`; prefixo de tabela `sched` (não colide com `scheduledMessages`); arquivos `convex/scheduling*.ts` e libs `convex/lib/sched*.ts`; componentes `src/components/agenda/`. UI: "Marcar horário" / "Agendamento" ("Agendar" já é programar envio de mensagem).
- **Tabelas** (`convex/schema.ts`, todas novas, aditivas): `schedSettings` (1 doc por org, opcional), `schedResources`, `schedServices`, `schedExceptions` (fechamento/horário especial/extra/bloqueio por DATA local), `schedAppointments`, `schedAllocations` (tabela quente: só agendamento ATIVO tem linha), `schedConflicts`, `schedConversationState` (ofertas por conversa, fora do doc quente `conversations`), `schedInterpretations` (nunca guarda texto). Validadores exportados do schema: `schedOrigin`, `schedStatus`, `smartMode`, `minuteInterval`. Lista de espera (`schedWaitlist`) e links públicos (`schedPublicLinks`) nascem nas fases G e H.
- **Literais novos em tabelas existentes:** `orgModulesValidator.scheduling`, `permissionsValidator.agenda`, `activities.type` `appointment_booked|appointment_changed|appointment_completed`. Os tipos de `notifications.type` do plano (§3.7) NÃO entram no A1: `notificationTypesParity.test` exige as 5 pontas juntas (cópia, ícone do sino, flag de preferência, push, Telegram), então cada tipo entra no PR que primeiro o usa.
- **Constantes** (`convex/lib/schedConstants.ts`) e **padrões de configuração** (`convex/lib/schedSettingsDefaults.ts`, `resolveSchedSettings(doc | null)`): quem lê a configuração SEMPRE passa por ela; o doc `schedSettings` ausente = padrões.

## Módulo e plano

Gate de plano em `PLANS[*].modules` (os 4 planos pagos, teste incluído por usar o Profissional; `legacy`/sem billing = livre) e `MODULE_GATE.scheduling`. `setOrgModulesCore` (`lib/orgModulesOps.ts`) chama `checkModule` SÓ na transição desligado → ligado de `scheduling`: reenviar `true` com o módulo já ligado e desligar nunca recusam. Conta em modo leitura, cancelada ou com teste vencido tem `modules` zerado e recusa ligar ("modo leitura"). Os outros módulos seguem sem checar o plano ao ligar (decisão pendente do dono). Ligar exige `settings:manage` e gera `auditLogs` (antes/depois com `scheduling`). `scheduling` fica fora de `assertAnyModule` (não acende a Central).

## Permissão `agenda`

Hierarquia `none < view_own < view_all < edit < manage`. Defaults: `admin: manage`, `manager: edit`, `agent: edit`, `ai: edit` (hoje qualquer membro cria compromisso; restringir é escolha da org; a autonomia da IA vem de `schedSettings.ai`, não daqui). O campo é `v.optional` em `permissionsValidator` e `resolvePermissions` completa `agenda` (como `campaigns`) com o default do papel: membro ou chave de API com permissões explícitas gravadas antes da categoria existir NÃO fica sem acesso. `PermissionsEditor` itera `CATEGORY_LABELS`, então a categoria já aparece ali; as rotas de calendário passam a usá-la no PR A1b.

## Purga, backup, cascata

- Purga da org (`opsPurge.ts`): todas as tabelas novas. `schedAllocations` sai junto do agendamento (`by_appointment`; não tem índice por org de propósito, é a tabela quente) e `schedConversationState` junto da conversa (`by_conversation`).
- Backup (`exports.ts`): `schedSettings`, `schedResources`, `schedServices`, `schedExceptions`, `schedAppointments`. Ficam em `EXCLUDED_BACKUP_TABLES` (derivados/efêmeros): `schedAllocations`, `schedConflicts`, `schedConversationState`, `schedInterpretations`. O `internalCollectPage` pagina só por `by_organization`; por isso `schedAppointments` e `schedExceptions` têm esse índice além do de data/início.
- Excluir lead/contato (`lib/leadCascade.ts`): o agendamento FICA (histórico da operação) e perde `leadId`/`contactId` (índices `by_lead_and_start`/`by_contact_and_start`), como `calendarEvents`. Excluir a conversa apaga `schedConversationState` e `schedInterpretations` dela. `schedAppointments.conversationId` pode ficar apontando para conversa apagada (não há índice; toda leitura trata `null`).
