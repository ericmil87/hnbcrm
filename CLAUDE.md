# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Start frontend (Vite) + backend (Convex) in parallel
npm run dev:frontend     # Start only Vite dev server
npm run dev:backend      # Start only Convex dev server
npm run build            # Build frontend (vite build)
npm run convert-images   # Convert PNG images to WebP format
npm run lint             # Full check: tsc (convex + app) → convex dev --once → vite build
npx convex dev --once    # Push schema/functions to Convex without watching
```

Tests: `npm run test` (vitest + convex-test; `*.test.ts` em `convex/`). Seed data is available via `convex/seed.ts`.

## Architecture

Multi-tenant CRM with human-AI team collaboration. Convex backend, React + TailwindCSS frontend.

**Multi-tenancy:** Every table has `organizationId`. All queries must be scoped to the user's org.

**Auth flow:** `requireAuth(ctx, organizationId)` from `convex/lib/auth.ts` handles auth + org membership. Returns the team member. `requirePermission(ctx, organizationId, category, level)` extends this with granular RBAC checks. A few functions without org context (e.g. `getUserOrganizations`) still use `getAuthUserId` directly.

**Permissions (RBAC):** 9 permission categories (leads, contacts, inbox, tasks, reports, team, settings, auditLogs, apiKeys) with hierarchical levels. Defined in `convex/lib/permissions.ts`. Each role (admin, manager, agent, ai) has sensible defaults; admins can override per-member. Frontend uses `usePermissions(organizationId)` hook and `<PermissionGate>` component.

**Invite flow:** Admins invite humans via `inviteHumanMember` action (creates auth account with bcrypt-hashed temp password). New users must change password on first login (`mustChangePassword` flag). Users auto-linked to org via `afterUserCreatedOrUpdated` auth callback.

**Side effects in mutations:** Most mutations insert into `activities` + `auditLogs` and trigger webhooks via `ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, ...)`.

**Email/Notifications:** `@convex-dev/resend` component for email delivery. Central dispatch via `convex/email.ts` — all events go through `internal.email.dispatchNotification`. Templates in `convex/emailTemplates.ts` (PT-BR). Per-member preferences in `notificationPreferences` table (opt-out model — no row means all enabled). Convex components registered in `convex/convex.config.ts`. **Email env vars:** `RESEND_API_KEY`, `APP_URL`, `RESEND_FROM_EMAIL` (default: `HNBCRM <noreply@mail.hnbcrm.com>`), `RESEND_WEBHOOK_SECRET`. Domain: `mail.hnbcrm.com` (subdomain to avoid Gmail MX conflict).

**HTTP API:** `convex/router.ts` has RESTful endpoints at `/api/v1/` authenticated via `X-API-Key` header. API keys resolve permissions from key → team member → role defaults. Routes wired in `convex/http.ts`.

**WhatsApp channel:** Per-organization channel configs (`convex/channelConfigs.ts`, `channelConfigs` table) with `provider: "meta" | "bridge"` — two transports on the same `whatsapp` channel. `meta` = official WhatsApp Cloud API (Graph API, 24h service window, message templates); ingress at `GET/POST /webhooks/whatsapp` (`convex/whatsapp.ts`). `bridge` = self-hosted wuzapi gateway (WhatsApp Web protocol via whatsmeow, QR pairing, no 24h window, no templates); ingress at `POST /webhooks/bridge` verified by HMAC-SHA256 via env `WA_BRIDGE_HMAC_SECRET` (`convex/bridge.ts`). Managed provisioning: envs `WA_BRIDGE_DEFAULT_URL` + `WA_BRIDGE_ADMIN_TOKEN` (both set = "Servidor HNBCRM" default in the provisioning form — user only types a display name; admin token never leaves the server; advanced users can still point to their own gateway). Bridge is opt-in per org and carries a permanent-ban risk (unofficial protocol, violates WhatsApp ToS). Key files: `convex/bridge.ts`, `convex/lib/bridgeParse.ts` (pure parser), `convex/lib/bridgeSend.ts` (text), `convex/lib/bridgeMedia.ts` (media), `convex/lib/bridgeSession.ts` (QR/status/provisioning). Outbound dispatch in `convex/whatsapp.ts` branches by provider (voice notes are transcoded to ogg/opus via the Whisper service's `/convert`). Typing presence and delivery/read receipts flow both ways (`sendTypingState`, `markConversationRead`, `ChatPresence`/`ReadReceipt` webhook events). UI in `src/components/settings/ChannelsSection.tsx` (+ `ChannelHealthPanel` with 7-day delivery stats).

**Inbox features:** Voice-note transcription via self-hosted Whisper (`convex/transcription.ts`, env `WHISPER_SERVICE_URL`/`WHISPER_SERVICE_TOKEN`, opt-in per org via `channelConfigs.autoTranscribeAudio`; transcript mirrored to `messages.transcriptText`). Full-text message search (search indexes `search_content` + `search_transcript` on `messages`, query `conversations.searchMessages`). Quick replies (`convex/quickReplies.ts`, "/" trigger in the composer). Scheduled messages (`convex/scheduledMessages.ts`, `ctx.scheduler.runAt`). Conversation archiving + org-scoped labels (`conversations.ts`, `conversationLabels` table) with bulk actions. Inbox UI pieces live in `src/components/inbox/`.

**Tasks (P1):** Full task manager beyond the original lead/contact-linked reminders. Projects/lists (`taskProjects`) each with kanban columns (`taskColumns` — done column, WIP limit informative only) and manual card ordering; org-wide labels with color (`taskLabels`); multiple assignees per task (`assigneeIds`, humans and AI — `assignedTo` always mirrors the first one for backward compatibility); real subtasks (`parentTaskId` hierarchy, with aggregated progress) plus informative dependencies (`blockedBy`, not enforced server-side); recurrence lineage moved to its own field (`recurrenceSourceId`) so it no longer collides with subtasks; per-task early reminder (`reminderMinutesBefore`) in addition to the due-date reminder; `@mentions` in task comments that actually notify; in-app notifications (`notifications` table, bell in the header) alongside existing e-mail notifications; server-side full-text search and saved filters (`savedViews` for `entityType: "tasks"`) wired into the UI. **Task↔lead linkage (v0.44):** lead chip on task rows/cards, "Lead" section in the task detail (link/change/unlink via `updateTask` — `leadId`/`contactId` accept `null` to clear, new links validated against the task's org — plus jump to the lead's conversation), Lead field in CreateTaskModal. **Deep-links:** `/app/tarefas?task=<id>` (task detail), `/app/pipeline?lead=<id>` (board switches to the lead's board and opens LeadDetailPanel; panel open/close syncs the param so browser back works), `/app/entrada?conversation=<id>` (inbox selects the conversation; only matches the loaded non-archived list). Lead panel's Tarefas tab navigates to the task deep-link. New webhook events: `task.moved`, `task.due_soon`, `task_project.*`, `task_label.*`. The REST API (`/api/v1/tasks/*`) and MCP tools were NOT extended with write params for the new fields (project/labels/assignees still create/update only through the app UI) — GET responses do include the new raw document fields. Key files: `convex/taskProjects.ts`, `convex/taskLabels.ts`, `convex/notifications.ts`, `convex/lib/notify.ts`, `src/components/tasks/`, `src/components/notifications/`.

**AI Agent Config (opt-in total):** dois produtos de IA num runtime provider-agnostic (OpenAI-compatible, default OpenCode Go — env `OPENCODE_GO_API`; fallback OpenRouter implementado, inativo sem `OPENROUTER_API_KEY`). (1) **Copiloto** in-app: chat SSE autenticado (`convex/copilotHttp.ts`, rota `/api/copilot/stream`), age COMO o usuário (actorType "human" + metadata.via:"copilot", RBAC dele via `assertAgentCan`), tools de leitura/escrita em `convex/copilot.ts`, destrutivo via `pendingActions` (two-phase, confirmação humana). (2) **Atendente** WhatsApp (`convex/attendant.ts`): gatilho de ingest ENFILEIRA em `aiReplyQueue` (debounce+coalescing), pacing por-org (`aiPacing`), lock OCC por conversa (`conversations.aiTurnLock`), envio só via `internalCommitAiReply` transacional que re-checa elegibilidade (TOCTOU); modo `suggest` default (rascunho revisado no inbox — `AiDraftCard`), `autopilot` só após métricas de aceitação (gate server-side); canais Meta sempre, bridge SOMENTE com aceite de risco org-level (`aiConfig.bridgeAiAck` — condição de elegibilidade re-checada no commit). Toggles separados `copilotEnabled`/`attendantEnabled` sob o mestre. **Pacing de envio (v4.1):** cursor em dois níveis em `lib/whatsappDispatch.ts` — por conversa (6,5s pair rate) + por número (`channelPacing`; Meta 1-3s, bridge reativo 4-10s, bridge frio 8-15s com jitter), typing humanizado no bridge p/ envios de IA/agendados, retry com backoff oficial 4^X (131056/130429/80007) e congelamento de canal em 131048; helper único de resolução de config em `lib/channelResolve.ts`. **Pipeline do atendente (P4):** `agentProfile.pipelineConfig` (board/estágio inicial no roteamento inbound, avanço determinístico pós-qualificação BANT, `allowMoveStages` com enforcement no executor, seção "REGRAS DO FUNIL" no prompt). Segurança: 4 camadas em `convex/lib/agentSecurity.ts` (assertAgentCan, escopo por registro, `TOOL_DENYLIST` + teste de build `agentToolSecurity.test.ts`, envelope de dado não-confiável `lib/promptEnvelope.ts`). Registry estático de tools: `convex/lib/agentTools.ts`. Camada LLM pura: `convex/lib/llm/` (adapter openaiCompatible, registry ZDR/modelos, fallback chain, sanitize). Config por-org em `organizations.settings.aiConfig` — `enabled` default FALSE + aceite LGPD obrigatório (`orgAiActive`); UI em Configurações → IA (`AiSection.tsx`). Runs auditadas em `agentRuns` (tokens/custo/tools — sem transcrições/PII). BYO key: `orgSecrets` (cifrada) + `lib/agentRoutes.ts`. **Roteamento de provider (por org + ops):** `providerConfig.platformOrder` ("auto" | "openrouter-first" | "*-only") reordena/filtra a cadeia da plataforma; UI em Configurações → IA (card "Provider, modelos e privacidade": roteamento, BYO key e botão "Testar conexão" → `aiDiagnostics.testOrgConnection`); override de ops via env `LLM_PLATFORM_ORDER` (vale p/ orgs sem escolha própria). Diagnóstico: `npx convex run aiDiagnostics:pingProvider '{}'` (cadeia com fallback) e `aiDiagnostics:pingChain '{}'` (cada hop isolado, expõe o erro real). Guard anti-vazamento de segredos: `convex/secretScan.test.ts` (quebra o build se um token real-parecido for commitado).

**Frontend:** SPA with react-router v7. Dark theme default, mobile-first, PT-BR UI. `src/main.tsx` → `HelmetProvider` → `ConvexAuthProvider` → `RouterProvider`. Public routes: `/` (LandingPage), `/entrar` (AuthPage). App routes: `/app/*` wrapped by `AuthLayout` → `ScrollRestoration` → `AppShell` → `<Outlet />`. Page components get `organizationId` via `useOutletContext`. Reusable UI in `src/components/ui/`, layout in `src/components/layout/`. State is Convex reactive queries + local `useState`. Path alias `@/` → `src/`.

**Build optimizations:** Vite configured with manual chunking (react-vendor, convex-vendor, utils-vendor, icons-vendor), lazy loading for authenticated routes via React.lazy(), gzip/brotli compression, and bundle visualization (rollup-plugin-visualizer). Initial bundle: ~157 KB brotli (77% reduction from 1 MB baseline).

**SEO:** react-helmet-async for dynamic meta tags, Open Graph + Twitter Cards, JSON-LD structured data, sitemap.xml, robots.txt. Reusable `<SEO />` component in `src/components/SEO.tsx`.

## Convex Rules (mandatory)

Rules from `.cursor/rules/convex_rules.mdc` and `.claude/convex-agent-plugins/rules/`:

- **Always** use new function syntax: `query({ args: {}, returns: v.null(), handler: async (ctx, args) => {} })`
- **Always** include `args` and `returns` validators on every function
- **Never** use `.filter()` on queries — use `.withIndex()` instead
- **Never** use `Date.now()` inside queries — breaks reactivity
- **Never** schedule `api.*` functions — only schedule `internal.*` functions
- Use `internalQuery`/`internalMutation`/`internalAction` for non-public functions
- Actions using Node.js APIs must include `"use node";` directive and be in a separate file
- Use `ctx.db.patch` for partial updates, `ctx.db.replace` for full replacement
- Index naming: `by_<field>` or `by_<field1>_and_<field2>`
- Use `"skip"` pattern: pass `"skip"` to `useQuery` when args aren't ready
- Keep query/mutation handlers thin — extract business logic into plain TypeScript functions
- Use cursor-based pagination (`paginationOptsValidator`) for large datasets
