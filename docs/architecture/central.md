# Central de atendimento (unidades, setores, desfecho, atribuição, painel)

> Histórico técnico movido **verbatim** do `CLAUDE.md` da raiz em 22/10/2026 (snapshot do commit 1f51a2f). Ordem = ordem de versão. Pegadinhas que mudam a forma de codar foram destiladas em `.claude/rules/`; este arquivo é a fonte completa, para ler quando se mexe nesta área.

## Estado atual

Módulos opcionais por org (`settings.modules`), `conversationRouting.ts`, `centralAnalytics`, `adSpend`, `demoMode`/`demoSim` (v0.63).

## Decisões, pegadinhas medidas e histórico

### Central de atendimento — unidades, setores, desfecho, atribuição e painel (v0.63, opcional por org)

**Central de atendimento — unidades, setores, desfecho, atribuição e painel (v0.63, opcional por org):** quatro módulos em `organizations.settings.modules` (`units`, `departments`, `attribution`, `central`), todos `undefined` = DESLIGADO; org sem módulo vê o app idêntico ao anterior (queries devolvem vazio/`null`, mutations lançam "Módulo não habilitado"; gate em `lib/orgModules.ts`, hook `useOrgModules`). Tabelas `units`, `departments`, `conversationTransfers`, `adSpend`; campos `conversations.unitId/departmentId/assignedTo/contactKind/firstInboundAt/firstResponseAt/firstResponderType` e `leads.unitId/contactKind/attribution`. `conversationRouting.ts` (transferir — núcleo em `lib/conversationTransfer.ts`, atribuir, unidade, tipo, `markConversationOutcome` que reusa `lib/leadStageMove.ts`, o MESMO núcleo do `moveLeadToStage` do Kanban), `centralAnalytics.getCentralDashboard` (+ `lib/centralDashboard.ts`; **ROAS/CAC só de mídia paga** — reservas cuja `source+campaignKey` tem gasto; o funil só conta `contactKind` lead), `adSpend.ts` (`campaignKey` via `normalizeCampaignKey`, igual ao de `leads.attribution`). `referral` do Click-to-WhatsApp (Meta) vira `metadata.referral` sempre e `leads.attribution` só com o módulo ligado. **`settings.demoMode`**: o dispatch do WhatsApp (ponto único em `whatsapp.ts`) marca `delivered` sem rede; `demoSim.ts` é um motor GENÉRICO de demonstração (só `internal*`, recusa org sem demoMode; o conteúdo de cliente fica fora do git). Pendências: tools de IA `routeToDepartment`/`setUnit`/`markOutcome`; escopo por unidade para gestores (e `leads.getLeads`/inbox não aplicam `view_own` no backend); reabrir desfecho. Testes: `central.test.ts`, `demoSim.test.ts`, `src/components/inbox/central/centralMeta.test.ts`, `src/components/central/adSpendCsv.test.ts`.

