# Arquitetura — decisões e histórico por área

Cada arquivo tem **Estado atual** (curto) e **Decisões, pegadinhas medidas e histórico** (parágrafos por versão, movidos do `CLAUDE.md` da raiz em 22/10/2026). O `CHANGELOG.md` conta a mesma história em linguagem de usuário; aqui fica o *porquê* técnico e o que foi medido.

**Quando ler:** antes de mexer na área correspondente, quando um teste de build quebrar sem motivo óbvio, ou quando um comportamento parecer "estranho" — provavelmente é uma decisão registrada aqui.

| Arquivo | Área | Leia quando mexer em… |
|---|---|---|
| [`ops-dev-prod.md`](ops-dev-prod.md) | Comandos, CI, deployments dev × prod | qualquer `npx convex …`, deploy, CI, `.env.local` |
| [`backend-core.md`](backend-core.md) | Multi-tenancy, side effects, Convex rules | qualquer mutation nova |
| [`auth-multi-org.md`](auth-multi-org.md) | Autenticação, RBAC, convites e multi-org | `convex/lib/auth.ts`, `teamMembers.ts`, `organizations.ts`, convites, login, troca de org |
| [`security.md`](security.md) | Segurança: login anônimo removido, Onda 0, cabeçalhos HTTP, busca segura de URL e extratores do onboarding | auth pública, `seed.ts`, `vercel.json`, ops de purga, CI, `safeFetch` e extratores de HTML/PDF |
| [`email.md`](email.md) | E-mail transacional e notificações | `email.ts`, `emailTemplates.ts`, `notificationPreferences`, Resend, reset de senha |
| [`api.md`](api.md) | HTTP API REST, API keys e MCP | `router.ts`, `apiKeys.ts`, `mcp-server/`, OpenAPI |
| [`whatsapp-bridge.md`](whatsapp-bridge.md) | Canal WhatsApp: Meta Cloud API e bridge (wuzapi/whatsmeow) | `whatsapp.ts`, `bridge.ts`, `channelConfigs.ts`, `lib/bridge*.ts`, `channelHealth.ts` |
| [`meta-messaging.md`](meta-messaging.md) | Canais Instagram + Facebook Messenger (Facebook Login for Business, API oficial) | `metaMessaging.ts`, `lib/meta*.ts`, `lib/channelTransport.ts`, `lib/outboundDispatch.ts`, `lib/orgModules.ts` (módulo `metaMessaging`), `ChannelOriginBadge` |
| [`inbox.md`](inbox.md) | Inbox: transcrição, busca, respostas rápidas, agendadas, Nova conversa | `conversations.ts`, `startConversation.ts`, `src/components/inbox/`, transcrição, agendadas |
| [`translation.md`](translation.md) | Tradução automática de conversas (módulo opcional: LibreTranslate → IA, detecção, prévia, guards de texto e números) | `translation.ts`, `lib/translation*.ts`, `lib/languages.ts`, `lib/languageDetect.ts`, `lib/outboundDispatch.ts` (desvio de tradução antes do canal), `infra/libretranslate/`, `docs/LIBRETRANSLATE-SETUP.md` |
| [`notifications.md`](notifications.md) | Notificações: sino (lidas, agrupamento, caixa de entrada), preferências/pausa, escada de canais, Web Push e PWA | `notifications.ts`, `notificationPreferences.ts`, `push.ts`, `pushNode.ts`, `lib/notify.ts`, `lib/notification*.ts`, `lib/webPush.ts`, `src/sw.ts`, `src/lib/push/`, `src/lib/pwa/`, `src/components/notifications/` |
| [`tasks.md`](tasks.md) | Tarefas (projetos, kanban, subtarefas, notificações) | `tasks.ts`, `taskProjects.ts`, `notifications.ts`, `src/components/tasks/` |
| [`ai-core.md`](ai-core.md) | IA — runtime, provedores, rotas, custo e data/hora | `lib/llm/`, `lib/agentRoutes.ts`, `aiSettings.ts`, `aiSpend.ts`, `agentRuns`, `lib/promptDateTime.ts`, `lib/whatsappText.ts` |
| [`ai-attendant.md`](ai-attendant.md) | Atendente IA — repasses, follow-up, agenda externa, guardrails | `attendant.ts`, `attendantFollowUp.ts`, `handoffs.ts`, `lib/agentTools.ts`, `lib/botGuard*.ts`, `lib/llmOutputGuard.ts`, `attendantAgenda.ts`, `inboundLeadWelcome.ts` |
| [`ai-vision-media.md`](ai-vision-media.md) | Atendente IA — visão de imagens e mídia inbound | `vision.ts`, `lib/mediaEnrichment.ts`, `internalSaveInboundAttachment`, `lib/fileRefs.ts`, simulador/goldens |
| [`ai-copilot.md`](ai-copilot.md) | Copiloto in-app (e o loop `lib/copilotTurn.ts` que o Telegram reaproveita) | `copilot.ts`, `copilotHttp.ts`, `src/components/copilot/`, `src/lib/markdown.ts` |
| [`onboarding.md`](onboarding.md) | Onboarding conversacional v2 (`/comecar`): pipeline leitor em quarentena + entrevistador, orçamento de custo, rate limit e corte diário, modelos por env, código de e-mail, resposta em áudio, conversa e blocos no front, red team de injeção e leads do HNBCRM (o Rascunho de Operação e a aplicação estão em `leads-pipeline.md`) | `onboardingBudget.ts`, `onboardingChat.ts`, `onboardingHttp.ts`, `emailVerification.ts`, `hnbcrmLeads.ts`, `lib/onboarding*.ts`, `src/components/onboarding-chat/`, `attendant.simulateAttendant` |
| [`leads-pipeline.md`](leads-pipeline.md) | Leads, funis e etapas (inclui o Rascunho de Operação do onboarding) | `leads.ts`, `boards.ts`, `onboardingSessions.ts`, `lib/onboardingDraft*.ts`, `lib/onboardingApply.ts`, `lib/leadStageMove.ts`, `lib/leadCascade.ts`, `lib/leadAttribution.ts`, `LeadDetailPanel` |
| [`phones-contacts.md`](phones-contacts.md) | Telefones e contatos | `lib/phone.ts`, `lib/orgPhone.ts`, `contacts.ts`, `lib/inboundRouting.ts` |
| [`data-export-import.md`](data-export-import.md) | Export/Import de dados | `exports.ts`, `imports.ts`, `importRun.ts`, `lib/csv.ts`, `DataSection.tsx` |
| [`campaigns.md`](campaigns.md) | Campanhas de WhatsApp (disparo em massa) | `campaigns.ts`, `campaignWorker.ts`, `lib/campaign*.ts`, `optOuts.ts`, `whatsappTemplates.ts` |
| [`groups.md`](groups.md) | Grupos de WhatsApp (bridge) | `groupChats.ts`, `groupPosts.ts`, `groupPostWorker.ts`, `groupAgent.ts`, `lib/group*.ts`, `src/components/groups/` |
| [`telegram.md`](telegram.md) | Copiloto no Telegram: bot da plataforma para a equipe (vínculo, notificações e ações, comandos e relatórios, Copiloto e modos, arquivos, quotas e pacing, ops) | `telegram*.ts`, `opsTelegram.ts`, `lib/telegram*.ts`, `lib/copilotTurn.ts`, módulo `telegram` em `lib/orgModules.ts` |
| [`central.md`](central.md) | Central de atendimento (unidades, setores, desfecho, atribuição, painel) | `conversationRouting.ts`, `centralAnalytics.ts`, `adSpend.ts`, `demoSim.ts`, `lib/orgModules.ts` |
| [`billing.md`](billing.md) | Planos, entitlements e medição (precificação por uso: plano na org, livro de atendimentos IA, envios de campanha, Uso e fatura) | `lib/plans.ts`, `lib/billingMath.ts`, `lib/entitlements*.ts`, `lib/attendanceLedger.ts`, `lib/usageMeter.ts`, `billing.ts`, `opsBilling.ts`, `src/lib/pricing.ts` |
| [`frontend.md`](frontend.md) | Frontend — arquitetura, build, SEO, landing nova, preços, marca e prerender | `vite.config.ts`, `src/main.tsx`, `src/appRoutes.tsx`, `scripts/prerenderPlugin.ts`, rotas, SEO, chunks, `src/components/landing/` |

Outros documentos vivos: `docs/META-MESSAGING-SETUP.md` (guia versionado: app Meta, envs, webhooks, conectar e testar Instagram/Messenger), `docs/perf/convex-io.md` (I/O do Convex), `docs/OPS-SEPARAR-DEV-PROD.md` (runbook dev×prod), `docs/GRUPOS-WHATSAPP-STATUS.md`, `docs/LIBRETRANSLATE-SETUP.md` (subir o LibreTranslate da tradução automática, modelos, firewall e envs), `docs/*-PLAN.md` (planos originais).
