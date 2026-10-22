# Arquitetura — decisões e histórico por área

Cada arquivo tem **Estado atual** (curto) e **Decisões, pegadinhas medidas e histórico** (parágrafos por versão, movidos do `CLAUDE.md` da raiz em 22/10/2026). O `CHANGELOG.md` conta a mesma história em linguagem de usuário; aqui fica o *porquê* técnico e o que foi medido.

**Quando ler:** antes de mexer na área correspondente, quando um teste de build quebrar sem motivo óbvio, ou quando um comportamento parecer "estranho" — provavelmente é uma decisão registrada aqui.

| Arquivo | Área | Leia quando mexer em… |
|---|---|---|
| [`ops-dev-prod.md`](ops-dev-prod.md) | Comandos, CI, deployments dev × prod | qualquer `npx convex …`, deploy, CI, `.env.local` |
| [`backend-core.md`](backend-core.md) | Multi-tenancy, side effects, Convex rules | qualquer mutation nova |
| [`auth-multi-org.md`](auth-multi-org.md) | Autenticação, RBAC, convites e multi-org | `convex/lib/auth.ts`, `teamMembers.ts`, `organizations.ts`, convites, login, troca de org |
| [`security.md`](security.md) | Segurança: login anônimo removido, Onda 0, cabeçalhos HTTP | auth pública, `seed.ts`, `vercel.json`, ops de purga, CI |
| [`email.md`](email.md) | E-mail transacional e notificações | `email.ts`, `emailTemplates.ts`, `notificationPreferences`, Resend, reset de senha |
| [`api.md`](api.md) | HTTP API REST, API keys e MCP | `router.ts`, `apiKeys.ts`, `mcp-server/`, OpenAPI |
| [`whatsapp-bridge.md`](whatsapp-bridge.md) | Canal WhatsApp: Meta Cloud API e bridge (wuzapi/whatsmeow) | `whatsapp.ts`, `bridge.ts`, `channelConfigs.ts`, `lib/bridge*.ts`, `channelHealth.ts` |
| [`inbox.md`](inbox.md) | Inbox: transcrição, busca, respostas rápidas, agendadas, Nova conversa | `conversations.ts`, `startConversation.ts`, `src/components/inbox/`, transcrição, agendadas |
| [`tasks.md`](tasks.md) | Tarefas (projetos, kanban, subtarefas, notificações) | `tasks.ts`, `taskProjects.ts`, `notifications.ts`, `src/components/tasks/` |
| [`ai-core.md`](ai-core.md) | IA — runtime, provedores, rotas, custo e data/hora | `lib/llm/`, `lib/agentRoutes.ts`, `aiSettings.ts`, `aiSpend.ts`, `agentRuns`, `lib/promptDateTime.ts`, `lib/whatsappText.ts` |
| [`ai-attendant.md`](ai-attendant.md) | Atendente IA — repasses, follow-up, agenda externa, guardrails | `attendant.ts`, `attendantFollowUp.ts`, `handoffs.ts`, `lib/agentTools.ts`, `lib/botGuard*.ts`, `lib/llmOutputGuard.ts`, `attendantAgenda.ts`, `inboundLeadWelcome.ts` |
| [`ai-vision-media.md`](ai-vision-media.md) | Atendente IA — visão de imagens e mídia inbound | `vision.ts`, `lib/mediaEnrichment.ts`, `internalSaveInboundAttachment`, `lib/fileRefs.ts`, simulador/goldens |
| [`ai-copilot.md`](ai-copilot.md) | Copiloto in-app | `copilot.ts`, `copilotHttp.ts`, `src/components/copilot/`, `src/lib/markdown.ts` |
| [`leads-pipeline.md`](leads-pipeline.md) | Leads, funis e etapas | `leads.ts`, `boards.ts`, `lib/leadStageMove.ts`, `lib/leadCascade.ts`, `lib/leadAttribution.ts`, `LeadDetailPanel` |
| [`phones-contacts.md`](phones-contacts.md) | Telefones e contatos | `lib/phone.ts`, `lib/orgPhone.ts`, `contacts.ts`, `lib/inboundRouting.ts` |
| [`data-export-import.md`](data-export-import.md) | Export/Import de dados | `exports.ts`, `imports.ts`, `importRun.ts`, `lib/csv.ts`, `DataSection.tsx` |
| [`campaigns.md`](campaigns.md) | Campanhas de WhatsApp (disparo em massa) | `campaigns.ts`, `campaignWorker.ts`, `lib/campaign*.ts`, `optOuts.ts`, `whatsappTemplates.ts` |
| [`groups.md`](groups.md) | Grupos de WhatsApp (bridge) | `groupChats.ts`, `groupPosts.ts`, `groupPostWorker.ts`, `groupAgent.ts`, `lib/group*.ts`, `src/components/groups/` |
| [`central.md`](central.md) | Central de atendimento (unidades, setores, desfecho, atribuição, painel) | `conversationRouting.ts`, `centralAnalytics.ts`, `adSpend.ts`, `demoSim.ts`, `lib/orgModules.ts` |
| [`frontend.md`](frontend.md) | Frontend — arquitetura, build e SEO | `vite.config.ts`, `src/main.tsx`, rotas, SEO, chunks |

Outros documentos vivos: `docs/perf/convex-io.md` (I/O do Convex), `docs/OPS-SEPARAR-DEV-PROD.md` (runbook dev×prod), `docs/GRUPOS-WHATSAPP-STATUS.md`, `docs/*-PLAN.md` (planos originais).
