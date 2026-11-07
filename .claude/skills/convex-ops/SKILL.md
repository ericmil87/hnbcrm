---
name: convex-ops
description: Runbook for operating the HNBCRM Convex deployments (DEV tacit-chicken-195 vs PROD careful-anaconda-127) — flags, dry runs, restore re-arm, and the catalog of internal ops functions by area. Use when asked to run, inspect or migrate data on a deployment.
disable-model-invocation: true
argument-hint: "[what to do, e.g. 'backfill closedAt in prod']"
---

# Convex ops runbook (HNBCRM)

Full reasoning: `docs/architecture/ops-dev-prod.md`, `docs/OPS-SEPARAR-DEV-PROD.md`. Never improvise in PROD: dry run → read the plan → real run → verify.

## Targets and flags
- No flag = DEV (`.env.local` → `CONVEX_DEPLOYMENT=dev:tacit-chicken-195`). PROD only with `--prod` on `run`, `env`, `data`, `logs`, `import`, `export`. CLI 1.31.2: `convex data` and `convex logs` IGNORE `CONVEX_DEPLOY_KEY`; only `--prod` switches them.
- `npm run deploy:prod` reads `convex-prod-key.env.local`; never export that key as `CONVEX_DEPLOY_KEY` in a shell where `npx convex dev` could run.
- Component tables: `npx convex data emails --component resend`. Scheduled jobs: `_scheduled_functions`.
- Running as a user (for gated public functions): `npx convex run <fn> '{…}' --identity '{"subject":"<userId>|x","issuer":"<site url>"}'`.

## Standard sequence
```bash
npx convex run --prod <module>:<internalFn> '{"dryRun":true, ...}'      # plan
npx convex run --prod <module>:<internalFn> '{"dryRun":false, ...}'     # execute (re-schedules by cursor)
npx convex logs --prod                                                   # follow
```
Ops print masked PII only. Record what was run in `docs/OPS-SEPARAR-DEV-PROD.md` (section "registro") or the area STATUS doc.

## After a backup restore (no scheduled functions/envs come back)
`internalRearmScheduledMessages`, `internalRearmGroupPosts`, `internalRedispatchStuckOutbound`; then re-check envs (`npx convex env list --prod`) and bridge webhooks (`convex/opsMigration.ts`).

## Ops catalog (all `internal*`, dryRun default true unless noted)
- **Dev×prod separation** `convex/opsMigration.ts`: re-point bridge webhooks, re-apply HMAC, disarm channels, cancel/re-arm scheduled, redispatch stuck outbound.
- **Anonymous legacy** `opsAnonymous:internalListAnonymousUsers {limit?}` (read-only); `opsPurge:internalPurgeAnonymousOrganizations {confirmDeployment, dryRun, maxOrgs, expectTargetIds?}`.
- **Auth/e-mail** `authHelpers:internalNormalizeLegacyEmails {table, dryRun, cursor}` (reports collisions only).
- **AI** `aiSettings:internalReplaceOrgModel`, `aiSettings:internalSetFollowUpMode {organizationId, agentMemberId?, mode?, dryRun}`, `aiSettings:internalSetBotGuard {…, enabled?, tag?}`, `aiSettings:internalSetExternalAgenda {…, apiKey:null keeps}`, `opsAgentProfile:internalSetAgentProfileText`, `opsAgentProfile:internalUpsertFieldDefinitions`, `opsAgentProfile:internalSetDisclosureMode {organizationId, agentMemberId, mode, version?, dryRun}`, `aiSpend:internalBackfillMonthlyUsage {organizationId?, month, dryRun}`, `attendantFollowUp.internalAdoptTask`, `vision:internalSetVisionResult {messageId, status:"failed", error}` + `vision:autoDescribe {messageId}` (reprocess an image), `aiDiagnostics:pingProvider`, `aiDiagnostics:pingChain`, `aiDiagnostics:measureReasoning '{"model":"…","effort":"low"}'`, `opsAttendant:internalBackfillAiResumedAt {organizationId?, dryRun, cursor?, pageSize? (≤ 30)}` (stamps `conversations.aiResumedAt` on conversations returned to the AI before the field existed, so a stale `handoff_pendente`/`ia_pausada`/`suspeita_de_bot` skip stops showing "IA em espera"; ids only in the output, one audit at the end when scoped by org).
- **Bridge/WhatsApp** `channelConfigs:internalResolveBridgePhone`, `channelConfigs:internalBackfillBridgePhone`, `bridge:internalApplyBridgeHistoryConfig`, `bridge:internalBackfillBridgeMediaKeys`, `startConversation:internalProbeGatewayNumber {channelConfigId, phone}` (raw gateway answers), `opsBridgeReparse:internalReparseUnknownBridgeMessages {organizationId?, dryRun, cursor?, pageSize?, deleteContentless}`.
- **Groups** `groupChats:internalBackfillGroupParticipants` → `internalFinishGroupParticipantsMigration` → rollback `internalRestoreGroupArraysFromTable` (pageSize ≤ 50); `groupMediaCleanup:internalPurgeGroupMedia {organizationId?, olderThanDays, kinds?, keepDirected, dryRun, cursor?}`; `groupPosts:sendNow '{"groupPostId":…,"dryRun":true}'` (needs `--identity`, gate `campaigns:manage`).
- **Leads/contacts** `leads:internalBackfillClosedAt {dryRun, cursor?, organizationId?}`, `contacts:internalReportPhoneDuplicates {organizationId?, cursor?, pageSize?}` (read-only).
- **Inbound lead** `inboundLeadWelcome:internalSetInboundLeadSettings {dryRun, …}`.
- **Busca sem acento (07/11/2026)** `opsSearchFold:internalBackfillContactSearchText {dryRun, countAll?, cursor?, pageSize? (≤ 500, default 200), organizationId?}` (dobra `contacts.searchText`; sem o campo, `buildSearchText`) e `opsSearchFold:internalBackfillMessageSearchText {dryRun, countAll?, cursor?, pageSize?, organizationId?, sinceMs?, delayMs? (default 500)}` (grava `messages.searchNorm`; rodar fora do horário). Saída só com contagens (`scanned`, `wouldWrite`, `written`, `totals`); dry run lê UMA página, `countAll:true` segue pelas páginas sem escrever e loga o total no fim (`npx convex logs`). Rodar o dry run com `countAll` antes: o de mensagens escreve ~1 doc por mensagem com texto (custo de I/O). Idempotente. Sequência (DEV, depois PROD com `--prod`): deploy A (índice `search_norm` `staged`) → contatos dry run → real → mensagens dry run `countAll` → real → índice pronto no painel → deploy B (tira `staged`, liga a consulta). Detalhes em `docs/architecture/inbox.md`.
- **Seed** `seed:seedMockData` (DEV only — internal since v0.69.1). Demo engine `demoSim.ts` refuses orgs without `settings.demoMode`.
- **Goldens** `agentEvals:internalSeedCuratedGoldens`.
- **Translation** `translation:internalDetectProbe '{"text":"hola, tienen disponibilidad?"}'` (internal action, read-only, no PII): proves `tinyld/light` loads in the deployment's V8 runtime and returns `{lang?, confidence?, alphaChars, minAlphaChars}` (< 20 letters = no `lang`); run after the first deploy of a deployment or a `tinyld` bump. `translation:pingProviders {organizationId}` is the UI's "Testar conexão" (public action, `settings:manage`, so it needs `--identity`; measures LibreTranslate and the LLM chain with a sample text that has a time and a price) — prefer the Settings button. Envs, set per deployment (PROD only with `--prod`): `LIBRETRANSLATE_URL` (`https://` only; `http://` just for localhost) and `LIBRETRANSLATE_API_KEY`; without the URL the chain is LLM-only. Never print the key; runbook `docs/LIBRETRANSLATE-SETUP.md`.

## Safety checklist before any PROD run
1. Tests green on the code that defines the op. 2. Dry run output read end to end. 3. Scope args (`organizationId`, `expectTargetIds`) set. 4. Backup/export if destructive (`npx convex export --prod`). 5. Log the run.
