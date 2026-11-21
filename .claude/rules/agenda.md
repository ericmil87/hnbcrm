---
paths:
  - "convex/scheduling*.ts"
  - "convex/lib/sched*.ts"
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
