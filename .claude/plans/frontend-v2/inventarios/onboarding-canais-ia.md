# Inventário: onboarding de organização e configuração inicial (HEAD)

Fonte: checkout limpo de HEAD (`$W` = `/tmp/claude-1000/-home-eric-projects-ClawCRM-clawcrm-repo/c2ebc17d-081d-4ead-a819-3f659d9babd0/scratchpad/head`). Todos os caminhos abaixo são relativos a `$W`. Somente leitura.

Legenda de permissão: `RP(cat,nível)` = `requirePermission`; `RA` = `requireAuth` (qualquer membro); `admin/manager` = checagem manual de `role`; `+email` = também `requireAccountWithEmail`.

---

## 1. Fluxo atual de onboarding

### 1.1 Gating (`src/components/layout/AuthLayout.tsx`)
Ordem de decisão no render:
1. `isLoading` → spinner. `!isAuthenticated` → `<Navigate to="/entrar">`.
2. Espera `loggedInUser`, `organizations` (`api.organizations.getUserOrganizations`) e `mustChangePassword`.
3. `mustChangePassword` → tela de troca de senha (usa `passwordOrgId`).
4. Sem `activeOrgId` (org escolhida em `localStorage` `SELECTED_ORG_KEY`; auto-seleciona se houver só 1) → `OrgPicker`/`CreateOrganizationForm` (modal; o switcher também cria org).
5. Espera `currentMember` (`api.teamMembers…` do membro atual).
6. **Wizard**: `onboardingProgress = useQuery(api.onboarding.getOnboardingProgress)`; mostra `<OnboardingWizard>` se `!wizardClosedOrgs.has(orgId) && shouldShowWizard(progress, role)`. `shouldShowWizard` lê `progress.shouldShowWizard === true` (ramo legado: só admin e `wizardCompleted === false`). `onComplete`/`onSkip` só fecham localmente (`wizardClosedOrgs`, estado React, não persiste).
7. Senão renderiza o app (`<Outlet context={{organizationId}}>`).

Regra do servidor (`convex/onboarding.ts` `computeShouldShowWizard`): só **admin**; falso se `organizations.onboardingMeta.wizardCompletedAt` existe; com registro `onboardingProgress` do membro → `!wizardCompleted`; sem registro → falso se a org já tem algum lead ou contato (orgs legadas).

### 1.2 Criação da org (`convex/organizations.ts`)
- `createOrganization` (mutation) args `{name, slug}`; `getAuthUserId` + **`requireAccountWithEmail`** (sessão anônima legada não cria). Slug único (`by_slug`), erro `ConvexError` com a palavra "slug".
- Cria na mesma transação: org com `settings {timezone:"America/Sao_Paulo", currency:"BRL", aiConfig:{enabled:false, autoAssign:false, handoffThreshold:0.8}}`; `teamMembers` admin (humano); board **"Funil de Vendas"** (`isDefault`, cor `#3B82F6`) com 6 estágios (Novo lead, Qualificado, Proposta, Negociação, Ganho `isClosedWon`, Perdido `isClosedLost`); 6 `leadSources` (Website, Redes Sociais, Campanha de E-mail, Telefone, Indicação, API); `auditLogs`; agenda `authEmails.sendWelcomeEmail`.
- NÃO cria: canal, atendente IA, campos personalizados, quick replies, `onboardingMeta`.
- `updateOrganization` args `{organizationId, name?, settings?:{timezone, currency, defaultCountryCode?, aiConfig?}}` — **admin** only (checagem manual); aceita `aiConfig` inteiro (cuidado: é substituição, não merge).

### 1.3 Flags no schema (`convex/schema.ts`)
- `organizations.onboardingMeta?: {industry?, companySize?, mainGoal?, wizardCompletedAt?}` (linha ~713). `wizardCompletedAt` é a fonte de verdade "wizard concluído" e também o item 1 do checklist.
- `onboardingProgress` (linha ~2282, por membro): `organizationId, teamMemberId, wizardCompleted, wizardCurrentStep, wizardData?: any, checklistDismissed, seenSpotlights[], celebratedMilestones[]`; índices `by_organization`, `by_organization_and_member`.
- `organizations.settings.modules` (`lib/orgModules.ts`): `units, departments, attribution, central, metaMessaging, telegram` — tudo OFF por padrão; `demoMode`.
- Não existe campo "IA configurada"/"canal conectado" de onboarding.

### 1.4 Wizard (`src/components/onboarding/`)
`OnboardingWizard.tsx` (538 linhas) com 5 passos (`currentStep` 0–4); botão "Próximo" vira "Finalizar" no passo 3; passo 4 é a tela de conclusão. Estado salvo a cada avanço por `persistState` → `updateWizardStep` (merge em `wizardData`). Retoma do passo salvo.

| Passo | Componente | Coleta | Mutations/actions |
|---|---|---|---|
| 0 | `WizardStep1Welcome` | setor (`industry`, 8 templates em `src/lib/onboardingTemplates.ts`: imobiliaria, ecommerce, saas, servicos, educacao, saude, financeiro, outro), porte (`solo`,`2-5`,`6-20`,`21-50`,`50+`), objetivo (`vendas`,`contatos`,`atendimento`,`tudo`), moeda (BRL/USD/EUR; sugere fuso), fuso (12 opções), país padrão (`defaultCountryCode`) | só `persistState`. Validação: exige `industry` |
| 1 | `WizardStep2Pipeline` | nome do board + lista de estágios (nome, cor, ordem, ganho/perda), pré-preenchida pelo template do setor | ao avançar: `onboarding.setupPipelineFromWizard` (idempotente por `pipelineKey` no cliente; falha vira toast e segue) |
| 2 | `WizardStep3SampleData` | toggle "dados de exemplo" | ao avançar, se ligado: `onboarding.requestSampleData {organizationId, industry}` (fire-and-forget + animação de 2,4 s) |
| 3 | `WizardStep4TeamInvite` | convites: humano (nome/e-mail/papel) ou agente IA (só nome) | humano: `nodeActions.inviteHumanMember {organizationId,name,email,role}` (devolve senha temporária, `emailSent`); IA: `teamMembers.createTeamMember {…role:"ai",type:"ai"}` (cria **membro IA sem `agentProfile`**) |
| 4 | `WizardStep5Complete` + `WizardInviteResults` + `ConfettiCanvas` | resumo dos convites | `onboarding.completeWizard` |

**O wizard não cobre canal WhatsApp, transcrição, visão nem atendente IA.** O "agente IA" do passo 3 é só um `teamMembers` nome/role `ai` — não é o atendente configurável (`agentProfile`).

Mutations de `convex/onboarding.ts` (todas `RA`, exceto as marcadas):
- `getOnboardingProgress {organizationId}` (query; devolve `shouldShowWizard`), `getOnboardingChecklist {organizationId}` (query), `initOnboardingProgress {organizationId}`, `updateWizardStep {organizationId, step, wizardData?: any}`, `completeWizard {organizationId}` (grava `onboardingMeta {industry, companySize, mainGoal, wizardCompletedAt}` e faz merge em `settings` com `currency/timezone/defaultCountryCode` do `wizardData`; marca progresso concluído; audit), `markSpotlightSeen {organizationId, spotlightId…}`, `markMilestoneCelebrated {…}`, `dismissChecklist {organizationId}`.
- `setupPipelineFromWizard {organizationId, boardName, boardColor?, stages:[{name,color,isClosedWon?,isClosedLost?}]}` — **admin**; **APAGA todos os boards/estágios/origens** da org e recria; recusa se `wizardCompletedAt` já existe ou se há leads.
- `requestSampleData {organizationId, industry}` — admin; agenda `internal.onboardingSeed.generateSampleData` (cria 8 contatos brasileiros, leads, conversas e membros de exemplo sobre o board/estágios existentes).

### 1.5 `OnboardingChecklist`
- Local: só em `src/components/DashboardOverview.tsx:93`, visível se `canConfigure`. Card colapsável, com "Dispensar" (`dismissChecklist`) e marcos celebrados (`markMilestoneCelebrated`).
- `getOnboardingChecklist` calcula **de dados reais** (6 itens, `totalCount: 6`): `pipelineCustomized` (= `onboardingMeta.wizardCompletedAt`), `firstLeadCreated`, `firstContactAdded`, `teamMemberInvited` (>1 teamMember), `webhookOrApiKey` (≥1 webhook ou apiKey), `customFieldsExplored` (≥1 `fieldDefinitions`).
- Navegação por item via `ITEM_NAV` → `TAB_ROUTES` (board/contacts/team/settings).
- **Nenhum item sobre WhatsApp, IA, transcrição, visão ou atendente.**

---

## 2. WhatsApp via bridge (wuzapi/whatsmeow), modo gerenciado

### 2.1 UI (`src/components/settings/ChannelsSection.tsx`, 1985 linhas)
- Lista `api.channelConfigs.getChannelConfigs {organizationId}` (RP settings,view). Cards por canal com badge de estado, "Testar conexão", "Mostrar QR", toggle de transcrição, toggle "Notificações no celular" (só bridge), histórico do aparelho (`BridgeHistory…`), `ChannelHealthPanel`, `BridgeGroupsPanel`.
- Formulário bridge (`BridgeForm`, linha ~1700): `bridgeDefaults = getBridgeProvisionDefaults`; modo default `assisted` quando `managedAvailable`, senão `manual`; escolha `managed`/`custom` de gateway. O usuário só digita o **nome de exibição** no modo gerenciado. Exige checkbox de **aceite de risco de banimento** (`riskAccepted`) antes de salvar (só UI; o aceite persistente de IA em bridge é outro, ver 5.4).
- `webhookUrl` é montado **no cliente**: `VITE_CONVEX_URL` com `.convex.cloud`→`.convex.site` + `/webhooks/bridge`. Qualquer driver server-side precisa reproduzir isso (`CONVEX_SITE_URL`).
- `QrModal` (linha ~1111): chama `getBridgeQrCode` imediatamente e a cada **4 s** (`QR_POLL_INTERVAL_MS`); renova o QR sozinho; ao detectar `connected` chama `checkChannelHealth` (persiste estado), mostra sucesso e fecha em 1,5 s; mostra `displacedFrom` (contas que perderam o número). Botão "Atualizar QR" manual.
- **A UI web só usa QR.** O pareamento por código (`pairphone`) existe só no backend e é usado pelo Telegram.

### 2.2 Funções de backend (`convex/channelConfigs.ts`)
| Função | Tipo | Args (abrev.) | Permissão / notas |
|---|---|---|---|
| `getBridgeProvisionDefaults` | query | `{organizationId}` → `{managedAvailable, managedGatewayUrl}` | RA. `managedAvailable` = `WA_BRIDGE_DEFAULT_URL` && `WA_BRIDGE_ADMIN_TOKEN` setados |
| `provisionBridgeChannel` | action | `{organizationId, displayName, webhookUrl, useManagedGateway?, bridgeBaseUrl?, adminToken?}` → `Id<channelConfigs>` | `internalRequireSettingsManage` = RP(settings,manage) **+email**. Gera token de instância (uuid), nome `org_<orgId>_<base36>`, `POST /admin/users` no gateway com `hmacKey = WA_BRIDGE_HMAC_SECRET` (≥32 chars, senão erro), ativa HMAC no cache vivo, cria `channelConfigs` provider `bridge` com token cifrado. No modo gerenciado o admin token nunca sai do servidor |
| `createChannelConfig` | action | Meta: `{phoneNumberId, wabaId, verifyToken, appSecret, accessToken}`; bridge: `{bridgeBaseUrl, bridgeInstanceId, bridgeToken}` | `internalInsertConfig` → RP(settings,manage). **Sem +email** neste caminho manual |
| `getBridgeQrCode` | action | `{configId}` → `{state, qrCode?, displayPhoneNumber?, error?, displacedFrom?}` | `internalGetConfigForMember` RP(settings,manage). Delega a `lib/channelReconnectCore.runBridgeReconnectStep({mode:"qr"})` (status → connect → QR) |
| `checkChannelHealth` | action | `{configId}` → `{ok, displayPhoneNumber?, verifiedName?, error?, bridgeSessionState?, displacedFrom?}` | Persiste estado via `internalRecordHealthCheck`; ao ficar `connected` faz `claimBridgePhone` (1 número = 1 conta, deployment-wide) |
| `updateChannelConfig` | action | `{configId, displayName?, bridge*/meta*…, bridgePhoneNotifications?, autoTranscribeAudio?}` | RP(settings,manage) via `internalPatchConfig`. **É o porta do toggle de transcrição** |
| `setChannelConfigStatus` | mutation | `{configId, status: active/disabled/error}` | RP(settings,manage) |
| `deleteChannelConfig` | mutation | `{configId, force?}` | RP(settings,manage); logout da instância (`internalLogoutBridgeInstance`) |
| `getInboxChannelAccounts`, `getChannelStats` | query | | leitura |
| `bridge.setBridgeHistoryConfig` / `bridge.syncBridgeHistory` | action | histórico opt-in por número (limite/dias) | |

### 2.3 Estados do canal
- `channelConfigs.status`: `active | disabled | error`.
- `channelConfigs.bridgeSessionState` (`lib/bridgeSession.ts` `BridgeSessionState`): `connected` (pareado+online), `connecting` (pareado, socket reconectando), `qr` (não pareado, QR disponível), `disconnected` (nunca pareado/deslogado/sem QR), `banned`, `logged_out`, `temporarily_banned`, `outdated`. Detalhes: `bridgeSessionDetail`, `bridgeSessionExpiresAt`, `bridgeConnectedAt`, `bridgePhone` (dígitos), `bridgeUnhealthySince`, `bridgeSessionAlertedAt`.
- Fluxo típico: provisionar (cria config, estado inicial vazio) → `getBridgeQrCode` (`qr`) → usuário escaneia → `connected` (+ `claimBridgePhone`, presença `unavailable` agendada ~2 s depois, `bridgePhone` resolvido) → cron de saúde 15 min (`internalChannelHealthTick`) → eventos `LoggedOut`/`TemporaryBan`/`ClientOutdated` viram `session_event` (alerta, pausa campanhas/posts, notificação `channel_session_lost`, **sem** mudar `status`).
- **Reconexão**: só `logged_out`/`disconnected` são reconectáveis (`isReconnectableState`). Web: reabrir o QR (`getBridgeQrCode`). Telegram: `convex/telegramReconnect.ts` (connect → `pairphone` por código `XXXX-XXXX`, validado só em sonda, falta um pareamento completo), limite 3 tentativas/hora/canal. Core compartilhada: `lib/channelReconnectCore.ts` (modos `"qr"` e `"code"`, usa `channelConfigs.bridgePhone`).

### 2.4 Pré-requisitos (envs Convex)
`WA_BRIDGE_DEFAULT_URL` + `WA_BRIDGE_ADMIN_TOKEN` (modo gerenciado), `WA_BRIDGE_HMAC_SECRET` (≥32 chars; também verifica o ingress `POST /webhooks/bridge`), `WHISPER_SERVICE_URL`/`WHISPER_SERVICE_TOKEN` (áudio de saída é transcodificado via `/convert`). Servidor do gateway: `WUZAPI_AUTO_PRESENCE=unavailable` (v0.72). Conta com e-mail verificado (`requireAccountWithEmail`). Admin da org (`settings:manage`).

### 2.5 Meta Cloud API, Instagram, Messenger (breve)
- **WhatsApp Meta** (`provider:"meta"`): formulário manual com 5 campos (phoneNumberId, wabaId, verifyToken, appSecret, accessToken — cifrados); webhook `GET/POST /webhooks/whatsapp`; janela de 24 h e templates (`whatsappTemplates.syncMetaTemplates`). Exige conta Meta Business do cliente. O wizard deve ter bridge como default.
- **Instagram/Messenger** (`channelConfigs.channel` = `instagram|messenger`): atrás do módulo `settings.modules.metaMessaging` (default OFF). OAuth: `metaMessaging.startMetaConnect {organizationId, connectionId?}` → URL (envs `META_MESSAGING_APP_ID`, `META_MESSAGING_LOGIN_CONFIG_ID`, `CONVEX_SITE_URL`); retorno em `finalizeMetaOAuth {organizationId, state}`; seleção de páginas em `MetaPageSelectionModal`. Passo a passo em `docs/META-MESSAGING-SETUP.md`; App Review da Meta ainda pendente (depende do Eric).

---

## 3. Transcrição de áudio

- **Gate de produto (um só toggle)**: `channelConfigs.autoTranscribeAudio` (por canal/número; ausente = off) **OU** atendente IA ativo (`lib/mediaEnrichment.shouldTranscribeAudio`). Vale para áudio do cliente, da equipe e do celular (v0.72). Não há campo em `aiConfig` nem env por org.
- **UI**: `ChannelsSection` → card do canal → linha "Transcrição automática" com switch (`handleToggleAutoTranscribe` → `updateChannelConfig {configId, autoTranscribeAudio}`).
- **Backend** (`convex/transcription.ts`): `transcribe` (action pública, botão manual, RP), `autoTranscribe` (internalAction agendada pela **porta única** `lib/mediaEnrichment.scheduleAudioTranscription(ctx,{messageId,contentType,attachments,isInternal?,metadata?})`), `internalTranscribeStoredAudio` (Telegram), `internalGetAudioMessageIfEligible`, `internalSetTranscriptionPending/Result`. Resultado em `messages.metadata.transcription {status,text,language,durationSec,engine:"faster-whisper",error?,at}` e espelhado em `messages.transcriptText`. Nunca transcreve nota interna, `deletedByCustomer` ou histórico importado.
- **Pré-requisitos**: serviço Whisper próprio (faster-whisper, deploy em `docs/whatsmeow/deploy/whisper/`, gitignored) + envs `WHISPER_SERVICE_URL`, `WHISPER_SERVICE_TOKEN`; sem URL a transcrição falha com "WHISPER_SERVICE_URL não configurado no Convex". Timeout 120 s, teto 25 MB. É infraestrutura **compartilhada do deployment** (sem custo de API por org; custo é de servidor). Não há tela que diga se o Whisper está disponível.

---

## 4. Visão de imagens do atendente

- **Flag**: `organizations.settings.aiConfig.visionEnabled` (opt-in, `undefined` = DESLIGADO — inverso de `copilotEnabled/attendantEnabled`). Gate efetivo `visionEnabledForOrg` = `orgAiActive` (`enabled && lgpdAck`) **e** `visionEnabled===true`.
- **UI**: `AiSection` → `FeatureTogglesCard` → `ProductRow` "Ler imagens recebidas" (switch + "Modelo de visão" via `getVisionModelOptions` + `RoutingSelect` de rota). Só aparece depois que a IA está ativa e com atendente (`needsActivation` esconde os cards).
- **Escrita**: `aiSettings.setFeatureToggles {organizationId, copilotEnabled?, attendantEnabled?, visionEnabled?, groupAgentEnabled?}` — RP(settings,manage), **sem +email**, audit `medium`. Modelo/rota: `aiSettings.setProductRouting {organizationId, product:"vision", order?, model?}`.
- **Backend**: `convex/vision.ts` (`autoDescribe` agendado no ingest, `describeImage` manual, `internalDescribeImageForCopilot` para o Telegram); respeita teto de gasto (`aiSpend.internalSpendGate`), 5 MB, allowlist de mime. Custo medido ~US$ 0,0003/imagem.
- **Pré-requisitos**: IA ativa + LGPD; chaves de LLM da plataforma (`OPENROUTER_API_KEY` e/ou `OPENCODE_GO_API`, `lib/agentRoutes.ts`; ordem `LLM_PLATFORM_ORDER`) ou BYO (`setProviderMode`). A imagem do cliente sai para provedor externo (por isso é opt-in).

---

## 5. Atendente IA

### 5.1 Onde mora a configuração
- **Org** (`organizations.settings.aiConfig`, `aiConfigValidator` em `convex/schema.ts:152-215`): `enabled` (mestre, default false), `autoAssign`, `handoffThreshold`, `lgpdAck? {acceptedAt, acceptedBy}`, `copilotEnabled?`, `attendantEnabled?` (undefined = ligado), `bridgeAiAck? {…}` (aceite de risco do bridge; sem ele o atendente NUNCA atende canal bridge), `visionEnabled?` (undefined = off), `groupAgentEnabled?`, `groupAutopilotAck?`, `providerConfig?` (modo platform/byo, `platformOrder`, `strictZdr`, `models {copilot, attendant, classify, complex?}`, `products {attendant, vision, groupPosts, groupAgent, telegramCopilot…}`), `monthlyConversationBudget?`, `spendCap? {mode: off|warn|block, monthlyBrl?, usdBrlRate?, warnPct?}`. Runtime só roda com `enabled && lgpdAck` (`orgAiActive`).
- **Atendente** = `teamMembers` com `type:"ai"`, `role:"ai"`, `agentProfile` (validator em `convex/schema.ts:~230-345`): `kind: copilot|attendant`, `mode: suggest|autopilot`, `language`, `channelConfigIds?`, `boardIds?`, `schedule? {timezone,startHour,endHour,days?}`, `includeCurrentDateTime?` (undefined = ligado), `botGuard? {enabled?, tag?}` (undefined = ligado), `handoffKeywords?`, `maxRepliesPerConversation?` (default 20), `maxRepliesPerHour?` (default 10), `messageDebounceSeconds?` (default 5, 1–120), `maxToolCallsPerRun?`, `model?`, `temperature?`, `disclosure?`, `disclosureMode? first_reply|on_demand`, `pipelineConfig? {boardId, initialStageId, advanceRules, qualifiedStageId, qualifyThreshold (1–4), allowMoveStages, captureFields[]}`, `autopilotEarlyAck?`, `followUps? {mode: off|draft|send, maxChain, quietStartHour, quietEndHour, dailyCap, eventDateField}`, `externalAgenda? {enabled,url,…}`, `onboarding? {step, doneAt}` (linha ~3404, outro contexto).
- **Texto grande** (persona/prompt + conhecimento) mora em tabela própria `agentProfileTexts`; leitura/escrita só por `lib/agentProfileTexts.ts` (`readAgentTexts`, `writeAgentTexts`, `insertAgentTextsForNewMember`); `agentProfile.systemPrompt/knowledge` são legado enquanto `textsMigratedAt` ausente. Quick replies alimentam o conhecimento inicial (`seedAttendant`).
- **Personas prontas** (`lib/agentPersonas.ts` `AGENT_PERSONAS`): `geral`, `imobiliaria`, `clinica`, `ecommerce`, `servicos_b2b`; `personaForIndustry(onboardingMeta.industry)` escolhe a default. Cada uma traz `systemPrompt`, `handoffKeywords`, `advanceRules`.

### 5.2 Mutations/actions públicas de `convex/aiSettings.ts` (portas de escrita)
| Função | Args (abrev.) | Permissão / notas |
|---|---|---|
| `setAiEnabled` | `{organizationId, enabled, lgpdAck?}` | RP(settings,manage) **+email**. Na 1ª ativação exige `lgpdAck:true` (grava `lgpdAck`); audit |
| `activateOneFlow` | `{organizationId, lgpdAck, bridgeRiskAck?, personaId?, attendantName?}` → `{attendantId, bridgeEnabled, createdAttendant}` | RP(settings,manage) **+email**. Liga IA + LGPD + (se há canal bridge ativo e `bridgeRiskAck`) `bridgeAiAck` + cria atendente via `seedAttendant` (modo `suggest`, sem horário/24 h, sem `channelConfigIds`). **É o caminho de 1 clique da UI** |
| `createAttendantOneClick` | `{organizationId, name?, personaId?}` → `Id<teamMembers>` | RP(settings,manage); exige IA ativa+LGPD; **sem +email** |
| `updateAgentProfile` | `{agentMemberId, patch, autopilotRiskAck?}` | RP(settings,manage) **sem +email**. `patch` (`agentProfilePatchValidator`): `mode?, systemPrompt?, knowledge?, language?, channelConfigIds?, boardIds?, schedule? (null limpa), includeCurrentDateTime?, botGuard? (null), followUps? (null), handoffKeywords?, maxRepliesPerConversation?, maxRepliesPerHour?, messageDebounceSeconds?, model?, temperature?, disclosure?, disclosureMode?, pipelineConfig? (null)`. **Autopilot**: exige ≥10 sugestões revisadas e ≥60% de aceitação, ou `autopilotRiskAck:true` (grava `autopilotEarlyAck`, audit `high`). Valida ranges, horários e que funil/estágios/campos pertencem à org |
| `setFeatureToggles` | `{organizationId, copilotEnabled?, attendantEnabled?, visionEnabled?, groupAgentEnabled?}` | RP(settings,manage) **sem +email**; exige `aiConfig` existente |
| `setBridgeAiAck` | `{organizationId, accept, riskAck?}` | RP(settings,manage) **+email**; `riskAck:true` obrigatório ao aceitar |
| `setGroupAutopilotAck` | `{organizationId, accept, riskAck?}` | idem |
| `setSpendCap` | `{organizationId, mode, monthlyBrl?|null, usdBrlRate?|null, warnPct?|null}` | RP(settings,manage) |
| `setMonthlyBudget` | `{organizationId, budget: number|null}` | RP(settings,manage) |
| `setModels` | `{organizationId, models {copilot, attendant, classify, complex?}, nonZdrAck?}` | RP(settings,manage) |
| `setProviderMode` | `{organizationId, mode: platform|byo, byo? {provider, baseUrl?, orgSecretId}, nonZdrAck?}` | RP(settings,manage); BYO usa `orgSecrets.createOrgSecret` |
| `setPlatformOrder` | `{organizationId, platformOrder: auto|openrouter-first|opencode-only|openrouter-only}` | RP(settings,manage) |
| `setProductRouting` | `{organizationId, product: copilot|attendant|vision|groupPosts|groupAgent|telegramCopilot, order?, model?}` | RP(settings,manage) |
| `setStrictZdr` | `{organizationId, strictZdr}` | RP(settings,manage) |
| `setExternalAgenda` | action `{organizationId, agentMemberId, enabled, url, headerName?, apiKey?}` | agenda externa (consulta HTTP do site do cliente) |
| Leitura | `getAiStatus`, `listAttendants`, `getAttendantTexts {agentMemberId}`, `getAttendantMetrics`, `getAiUsage`, `getModelOptions`, `getVisionModelOptions`, `getExternalAgendaConfig` | RA / RP(settings,view|manage) |
| Ops (internas, `dryRun` default true) | `aiSettings.internalSetBotGuard`, `internalSetFollowUpMode`, `internalReplaceOrgModel`; `opsAgentProfile.internalSetAgentProfileText`, `internalUpsertFieldDefinitions`, `internalSetDisclosureMode`, `internalSetPipelineRules` | só `npx convex run`; sem sessão |

Porta de tarefa/follow-up: `convex/attendantFollowUp.ts`. Não há mutation pública única "salvar persona"; o prompt e o conhecimento passam por `updateAgentProfile.patch`.

### 5.3 Gate LGPD e conta com e-mail
- LGPD: `aiConfig.lgpdAck` obrigatório (modal "Ativar IA — LGPD" em `ActivationCard`/`ActivationWizardModal`, checkbox). Org legada com `enabled:true` sem `lgpdAck` continua com IA desligada.
- `requireAccountWithEmail` aparece em `setAiEnabled`, `activateOneFlow`, `setBridgeAiAck`, `setGroupAutopilotAck`. **Não** aparece em `updateAgentProfile`, `setFeatureToggles`, `createAttendantOneClick`, `setModels` etc. (mas todas exigem `settings:manage`).

### 5.4 Aceites relacionados
`bridgeAiAck` (atendente em canal bridge), `autopilotEarlyAck` (autopilot sem gate), `groupAutopilotAck`, `nonZdrAck` (modelo/provider sem zero-retention). Cada um tem aviso + aceite explícito + audit (princípio "avisar, não travar").

### 5.5 `AiSection.tsx` (3309 linhas) — organização
Raiz `AiSection`: se `!status.active || !status.hasAttendant` (`getAiStatus`) mostra **somente** `ActivationWizardCard` (modal `ActivationWizardModal`: persona `<select>` com os 5 `PERSONAS`, checkbox LGPD, checkbox de risco do bridge se `hasBridgeChannel`, chama `activateOneFlow`). Depois mostra os cards:
1. `ActivationCard` — mestre ligar/desligar (+ modal LGPD) → `setAiEnabled`.
2. `FeatureTogglesCard` — linhas `ProductRow`: Copiloto do CRM, Atendente virtual, **Ler imagens recebidas** (+ modelo de visão), IA em grupos de WhatsApp, Copiloto no Telegram; modelos por produto (`setModels`, `setProductRouting`).
3. `BridgeAiCard` — aceite de risco do bridge (`setBridgeAiAck`).
4. `AttendantCard` → `AttendantConfig` (editor, ao expandir "Personalizar"). Seções (`FieldGroup`):
   - **Persona**: *Conhecimento do negócio* (textarea → `knowledge`), *Persona (instruções de comportamento)* (textarea → `systemPrompt`). Textos carregados sob demanda por `getAttendantTexts`.
   - **Horário de atendimento**: início (h), fim (h) → `schedule` (fuso, dias).
   - **Comportamento da conversa**: *Agrupar mensagens por (s)* (`messageDebounceSeconds`), *Máx. por conversa* / *Máx. por hora* (`0` = sem limite), *Informar data e hora atuais à IA* (`includeCurrentDateTime`), *Proteção contra robôs* (`botGuard.enabled`, etiqueta `botGuard.tag`).
   - **Follow-ups agendados pela IA**: `FollowUpModeCard` (Desligado / Preparar rascunho / Enviar sozinho → `followUps.mode`), máx. seguidos sem resposta (`maxChain`), janela silenciosa (`quietStartHour/EndHour`), teto diário por número (`dailyCap`), campo com a data do evento (`eventDateField`).
   - **Repasse para humanos**: *Palavras de repasse* (`handoffKeywords`).
   - `ExternalAgendaSection` (agenda externa).
   - **Opções avançadas** (`CollapsibleSection`): *Funil para novos leads* (`pipelineConfig.boardId`), *Estágio inicial*, *Mover para este estágio ao qualificar* (`qualifiedStageId`), *Limiar BANT*, *Quando avançar o lead* (`advanceRules`), switch *Atendente pode mover leads* (`allowMoveStages`), *Campos que a IA captura* (`captureFields`), divulgação (`disclosureMode`, só com módulo Meta).
   - Modo: botão *Ativar autopilot* (gate: 10+ revisadas e 60%+; modal "Ativar o autopilot antes do gate" → `autopilotRiskAck`) / *Voltar ao modo sugestão*; métricas (`getAttendantMetrics`).
   - Botão **Testar** → `SimulatorModal` (ver 7).
5. `UsageCard` — uso/custo do mês, teto de conversas (`setMonthlyBudget`) e de gasto (`setSpendCap`).
6. `PrivacyCard` — ZDR estrito (`setStrictZdr`), ordem dos provedores (`setPlatformOrder`), BYO (`setProviderMode`, `orgSecrets.createOrgSecret`, `aiDiagnostics.testOrgConnection`).

---

## 6. Pipeline (funis)

- Default na criação da org: board "Funil de Vendas" + 6 estágios (1.2). `onboardingTemplates.ts` (frontend) tem 8 templates por setor com nome de board e estágios (só no cliente; o servidor recebe o resultado).
- `convex/boards.ts` (todas checam `role in [admin, manager]` à mão, não `requirePermission`): `getBoards {organizationId}`, `getStages {boardId}`, `getLeadCountsByBoard`, `createBoard {organizationId,name,description?,color}`, `createBoardWithStages {organizationId,name,description?,color,stages:[{name,color,isClosedWon?,isClosedLost?}]}` (cria funil completo numa chamada), `createStage {boardId,name,color,isClosedWon?,isClosedLost?}`, `updateBoard {boardId,name?,description?,color?}`, `updateStage {stageId,name?,color?,isClosedWon?,isClosedLost?}`, `reorderStages {boardId,stageIds[]}`, `deleteStage`, `archiveBoard/unarchiveBoard`, `getBoardDeletionImpact`, `deleteBoard`. Destruição do funil inicial pelo wizard é a `setupPipelineFromWizard` (1.4).
- Campos personalizados: `fieldDefinitions.createFieldDefinition {organizationId,name,key,type(text|number|boolean|date|select|multiselect),entityType?(lead|contact),options?,isRequired,order}` (admin/manager). Quick replies: `quickReplies.create {organizationId,shortcut,content}` (RP inbox,reply). O atendente captura campos listados em `pipelineConfig.captureFields`.

---

## 7. Simulador do atendente

Existe e é reutilizável num passo "teste seu agente":
- Backend: `attendant.simulateAttendant` (action pública, `convex/attendant.ts:5018`). Args: `{organizationId, agentMemberId, transcript:[{role:"customer"|"agent", content, audio?, image?, file?, senderName?}] (últimas 20), simulatedNow?, followUp?{title,note?}, transport?: meta|bridge|instagram|messenger, group?{subject,participantsCount?,extraInstructions?}}` → `{reply|null, actions[], error|null, imageUrl?}`. Gate: `internalGetSimulatorSetup` → RP(settings,view). Usa o **mesmo** formatador de histórico e as mesmas tools do runtime (mas nada é enviado nem persistido; lead/contato fictícios). Resolve rotas LLM da org (`resolveOrgRoutes`); sem provider → erro "Nenhum provider disponível".
- Pré-requisitos: atendente existente (`agentMemberId`); provider LLM (chaves da plataforma ou BYO). A simulação funciona **mesmo com `aiConfig.enabled=false`?** O setup só checa a org/agente; não vimos exigência de `orgAiActive` na action (confirmar ao implementar). Gasto da simulação não foi verificado se entra no teto.
- UI: `SimulatorModal` em `AiSection.tsx:2465` (`SIM_KINDS` texto/áudio/imagem/arquivo, transportes, modo grupo).
- Demo/sim relacionados: `convex/demoSim.ts` (`internalEnsureDemoOrg`, `internalApplyOps`, `internalResetDemo`, `internalDemoStatus`…) é ferramenta interna de demonstração com `demoMode`; não é o simulador do atendente.

---

## 8. Copiloto

### 8.1 Ferramentas (`convex/lib/agentTools.ts`, 58 tools; `COPILOT_READ_TOOLS` linha 381, `COPILOT_WRITE_TOOLS` 679)
Registry estático; o modelo nunca fornece IDs de escopo; cada tool tem `permission` (checada por `assertAgentCan`), `effect` (`read|write|destructive`) e `resultFields` (whitelist).

**Copiloto — leitura:** `getPipelineOverview` (funil, contagem/valor), `listLeads`, `getLeadDetail`, `searchContacts`, `getDashboardStats`, `listTeamMembers`, `listBoardsAndStages`, `listQuickReplies`, `listTasks`, `listMyOpenTasks`, `listCampaigns`, `getCampaignReport`, `previewCampaignAudience`, `listGroups`, `getGroupDetail`, `listGroupPosts`, `getGroupPostHistory`, `getConversationHistory`.

**Copiloto — escrita direta:** `createLead`, `updateLead`, `moveLead`, `assignLead`, `createContact`, `createTask`, `completeTask`, `snoozeTask`, **`createBoard`** (settings,manage; "usado no onboarding": board + até 12 estágios, executor em `convex/copilot.ts:1591`, não passa por `boards.createBoard`), **`createFieldDefinition`** (settings,manage), **`createQuickReply`**, `createCampaignDraft`, `pauseCampaign`, `resumeCampaign`, `launchCampaign` (não lança: devolve instrução), `createGroupPostDraft`, `pauseGroupPost`, `getGroupSummary`, `createLeadFromGroupMember`, `instructAttendant`, `regenerateAiReply`, `acceptHandoff`, `sendCustomerReply` (propõe).

**Copiloto — destrutivas/two-phase (`effect:"destructive"`):** `deleteLead`, `cancelCampaign`, `activateGroupPost`, `sendGroupMessage`.

**Atendente (`ATTENDANT_TOOLS`):** `replyToCustomer`, `moveThisLead`, `scheduleFollowUp`, `resolveFollowUp`, `qualifyThisLead`, `updateThisContact`, `updateThisLeadInfo`, `requestHandoff`, `flagAutomatedSender`, mais `consultarAgenda` (agenda externa) conforme config. **Agente de grupo:** `replyToGroup`, `flagOpportunity`.

### 8.2 Two-phase (`pendingActions`)
- Tabela `pendingActions {organizationId, requestedBy, threadId?, tool, args(record), preview(PT-BR), status: pending|executed|canceled|expired, expiresAt (TTL), createdAt, executedAt?}`, índice `by_organization_and_status`.
- Fase 1: o executor de uma tool `destructive` em `convex/copilot.ts` (~linha 1856–1900) insere `pendingActions` com `preview` e devolve ao modelo "aguardando confirmação".
- Fase 2: `convex/lib/copilotPendingActions.confirmPendingActionCore(ctx,{pending, member, now, via})` — só quem pediu confirma, TTL re-checado, **permissão re-checada na confirmação** (`assertAgentCan`), status só muda depois de executar. `switch (pending.tool)` hoje cobre `deleteLead` e `cancelCampaign` (e delega a grupos/atendente por `isGroupPendingTool`/`isAttendantPendingTool`). Entradas: `copilot.confirmPendingAction`/`cancelPendingAction` (web, `requireAuth`) e `internalConfirmPendingAction`/`internalCancel…` (Telegram). Regra do repo: ferramenta two-phase nova entra como `case` aqui, nunca num segundo switch.

### 8.3 O Copiloto altera `aiConfig`/persona/prompt?
**Não.** Confirmado: nenhuma tool do registry toca `settings.aiConfig`, `agentProfile`, `agentProfileTexts`, `channelConfigs`, `transcription` ou visão (o grep de `aiConfig|agentProfile|aiSettings|systemPrompt|channelConfig` em `lib/copilot*.ts` e `lib/agentTools.ts` só acha leitura de `agentProfile.mode` para `instructAttendant` e a descrição da agenda externa). O Copiloto só configura o CRM de dados: board/estágios, campos, quick replies. O system prompt (`lib/copilotTurn.buildSystemPrompt`) já tem uma instrução "ONBOARDING": entrevistar o usuário (ramo, etapas, campos), propor plano e criar só após OK, passo a passo.
Também sem rotas REST/MCP: `ROUTE_PERMISSIONS` e os 68 `crm_*` não expõem config de IA, persona ou canais de escrita (só `crm_list_whatsapp_channels`, `crm_list_boards`).

---

## 9. Demo/seed

- `convex/onboardingSeed.ts` `generateSampleData {organizationId, industry}` (internalMutation, agendada por `requestSampleData`): 8 contatos brasileiros (empresas de setores variados), leads distribuídos nos estágios existentes, conversas/mensagens e membros de exemplo; descobre board/estágios por índice (funciona com funil customizado); exige que exista board.
- `convex/seed.ts` `seedMockData {organizationId}` (internalMutation, só DEV via `npx convex run`): dados mock em inglês dependentes dos nomes de estágio ("New Lead", "Qualified"…) — **não funciona com o funil PT-BR atual**.
- `convex/demoSim.ts`: org demo (`settings.demoMode`), `internalEnsureDemoOrg {ownerEmail, scenario}`, `internalApplyOps`, `internalSeedAdSpend`, `internalResetDemo`, `internalDemoStatus`, `internalListOpenConversations`. Interna, usada em demos (org demo em DEV).
- Nenhum seed cria canal, atendente ou configuração de IA.

---

## Lacunas observadas

- Nenhum passo do wizard cobre canal WhatsApp, atendente IA, transcrição ou visão; o "agente IA" do passo 3 é um `teamMembers` vazio, sem `agentProfile`.
- O checklist não tem itens de canal/IA/atendente/teste; precisa de itens derivados de `channelConfigs.bridgeSessionState`, `getAiStatus` e `agentProfile.mode`.
- `setupPipelineFromWizard` apaga todos os funis e só roda uma vez (e recusa com leads); um passo de pipeline guiado por IA precisaria de caminho incremental (`createBoardWithStages`/`updateStage`) ou ajustar essa regra.
- Nenhuma tool do Copiloto escreve `aiConfig`, `agentProfile`, persona/prompt/conhecimento, horário, handoff, follow-up ou canal; falta uma família de tools (com two-phase para as sensíveis) ou um executor de "proposta de configuração".
- Sem mutation que salve persona/conhecimento isoladamente com diff/versão; `updateAgentProfile.patch` é o único caminho e não guarda histórico (só audit).
- Aceites humanos (LGPD, risco do bridge, autopilot antecipado, não-ZDR) são mutations separadas com checkbox; uma IA não pode "aceitar por" o usuário, o wizard precisa de passo explícito de aceite e o Copiloto precisa de botão de confirmação out-of-band.
- Pareamento do WhatsApp na web é só QR; `pairphone` (código) existe no core mas não tem action web nem UI (úteis para quem está no próprio celular).
- `webhookUrl` do bridge é montado no front; falta uma query/constante server-side (ex.: dentro de `provisionBridgeChannel`) para não depender do cliente.
- Não há tela/query que diga se o Whisper (`WHISPER_SERVICE_URL`) e as chaves de LLM da plataforma estão disponíveis; o wizard ligaria transcrição/visão sem saber se funcionam. Falta um `getPlatformCapabilities` (managed bridge, Whisper, LLM).
- Visão e transcrição estão em lugares diferentes (`aiConfig.visionEnabled` vs `channelConfigs.autoTranscribeAudio` por número); a transcrição só vale depois de existir um canal, a visão só depois de IA ativa+LGPD+atendente (a UI esconde o toggle antes disso).
- `setFeatureToggles`, `updateAgentProfile`, `createAttendantOneClick` e `createChannelConfig` não exigem `requireAccountWithEmail` (as "portas críticas" `setAiEnabled`/`activateOneFlow`/`provisionBridgeChannel` exigem); confirmar se é intencional antes de um wizard encadear chamadas.
- `activateOneFlow` cria o atendente sem `channelConfigIds`, sem horário e sem `boardIds`/`pipelineConfig`; vincular o atendente ao canal recém-pareado e ao funil criado exige um `updateAgentProfile` posterior.
- Simulador: `simulateAttendant` aceita `agentMemberId` real e roda com o prompt salvo; falta confirmar se bloqueia org sem IA ativa e se entra no teto de gasto; não há modo "rascunho de persona não salva" (testar antes de gravar).
- Sem conceito de estado de progresso do wizard para IA/canal (o `wizardData` é `v.any()` e só guarda o passo/escolhas do assistente atual); um wizard novo precisa definir o contrato (por passo: `pending|done|skipped`) ou derivar tudo de dados reais.
- `getOnboardingProgress` e `AuthLayout` decidem o wizard só para admin e fecham em estado local; reabrir o wizard depois de "Pular" exige nova rota/flag persistida.
- Seed de exemplo e `seed.ts` não geram conversas realistas para testar o atendente; falta cenário de teste do atendente (perguntas típicas por persona) para o passo "teste seu agente".
