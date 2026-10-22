---
paths:
  - "convex/attendant*.ts"
  - "convex/aiSettings.ts"
  - "convex/aiSpend.ts"
  - "convex/aiDiagnostics.ts"
  - "convex/agentRuns.ts"
  - "convex/agentEvals.ts"
  - "convex/vision.ts"
  - "convex/handoffs.ts"
  - "convex/copilot*.ts"
  - "convex/groupAgent.ts"
  - "convex/groupPost*.ts"
  - "convex/inboundLeadWelcome.ts"
  - "convex/opsAgentProfile.ts"
  - "convex/lib/agent*.ts"
  - "convex/lib/llm/**"
  - "convex/lib/llmOutputGuard.ts"
  - "convex/lib/prompt*.ts"
  - "convex/lib/followUp*.ts"
  - "convex/lib/botGuard*.ts"
  - "convex/lib/aiSpend.ts"
  - "convex/lib/disclosure.ts"
  - "convex/lib/externalAgenda.ts"
  - "convex/lib/whatsappText.ts"
  - "convex/lib/chatText.ts"
  - "convex/lib/mediaEnrichment.ts"
---

# AI pipeline (copilot, attendant, vision, group agent, generated posts)

Rules distilled from incidents in production. Reasoning and timelines: `docs/architecture/ai-core.md`, `ai-attendant.md`, `ai-vision-media.md`, `ai-copilot.md`, `groups.md`.

## Gates (all opt-in; `undefined` semantics differ — check before adding a flag)
- Master: `orgAiActive` = `aiConfig.enabled === true` + LGPD ack. `copilotEnabled`/`attendantEnabled`: `undefined` = ON. `visionEnabled`, `groupAgentEnabled`: `undefined` = OFF. `agentProfile.includeCurrentDateTime`, `botGuard.enabled`: `undefined` = ON (only `false` disables). `followUps.mode` absent = `"draft"`. `disclosureMode` absent = `"first_reply"`.
- Bridge channels need `aiConfig.bridgeAiAck`; group autopilot needs its own `groupAutopilotAck`; early autopilot needs `autopilotRiskAck` (audit `high`). Acks go through `requireAccountWithEmail`.
- Eligibility (`evaluateEligibility`, 13 conditions incl. `suspeita_de_bot`, `handoff_pendente`, budget) is evaluated at enqueue AND re-checked inside the transactional commit (`internalCommitAiReply`) — TOCTOU is the design. Every reason code must exist in `AI_STATE_REASON_CODES` (`convex/lib/aiStateReasons.ts`) and have a PT-BR label in `src/lib/aiStateReasons.ts` (parity test).
- Per transport (Meta Messaging F3): `findAttendantForConversation` accepts `whatsapp|instagram|messenger`; Instagram/Messenger also need module `metaMessaging` on and the connection `authState:"ok"` (else no queue at all). Condition 11 uses `aiWindowClosed` (single source, also measures follow-up degradation): bridge none, WhatsApp official 24 h, Instagram/Messenger the Meta window (24 h, 7 days by `windowOpenedByAdAt`) MINUS 15 min margin (`META_AI_WINDOW_MARGIN_MS`); unresolved transport = WhatsApp official, EXCEPT an Instagram/Messenger conversation whose config no longer resolves = closed (fail-closed). Outside WhatsApp the system prompt gets a fixed platform line "Canal desta conversa: Instagram|Messenger." right after the persona (industry personas say "no WhatsApp"). Follow-up copy is per channel (`describeFollowUpReason(code, channelName)`; `getForTask` exposes `channelLabel`). Condition 13 (after 11): last contact inbound with `metadata.standby` (another app owns the thread) → `outro_app_controla`, IG/Messenger only; pass `lastInboundStandby` from `lastInboundIsStandby` at every call site.

## Queue and turns (`convex/attendant.ts`)
- Ingest only ENQUEUES (`aiReplyQueue`, debounce + coalescing); claim takes the OCC lock `conversations.aiTurnLock`; commit is the only place that sends. The reactive turn always wins over a follow-up item (`yieldFollowUpItemToReactiveTurn`, same transaction).
- `origin` values: `inbound`, `coach`, `return_to_ai`, `follow_up`, `group_mention`. Human-initiated turns (`coach`, `return_to_ai`) ALWAYS produce a draft, even in autopilot, and are excluded from acceptance metrics (`humanInitiated`, `proactive`).
- Follow-up turn (`origin:"follow_up"`): plain text without a tool is NEVER sent; "nothing to send" is success when decided by `resolveFollowUp`, else `needs_human` without retry. `lastInboundAt > runStartedAt` aborts (`cliente_falou`). Every terminal path goes through `resolveFollowUpOutcome`. Completion is tied to the DELIVERY hook, not the commit.
- `fire` guard order is load-bearing (idempotency → task re-read → early-fire guard `nextFireAt` → archived conversation → archived lead → attendant lookup → mode off → opt-out (Instagram/Messenger: by IDENTITY `contactChannelIdentities.optedOutAt` of the conversation's config, no identity = `needs_human` `sem_identidade`; WhatsApp: by phone) → bridge down backoff → quiet window ∩ schedule → queue busy → chain cap → daily cap (bridge 30, WA 100, IG/Messenger 50) → eligibility). Add new guards in place, do not reorder. A contact without a phone must never mean "no opt-out". `cancelArmedFollowUp` is the ONLY way to clear `schedulerFnId`.
- "pare"/"parar"/"stop"/"sair" alone in an IG/Messenger inbound → `metaMessaging.internalMarkIdentityOptOut` (from `internalIngestEvent`): sets `optedOutAt`, cancels active follow-ups of that contact on that config (`opt_out`). It does NOT silence the attendant (no `aiOptOut`); a later inbound does not revert it, only `internalClearIdentityOptOut`.
- Team notes (`conversations.aiTeamNotes`, cap 20) enter every later prompt and outrank persona rules; only platform MANDATORY RULES stay above them.
- Bot guard: heuristic layer (`evaluateBotSignals`, threshold 4, current episode only) runs after keyword handoff and eligibility, before inference; model layer tool `flagAutomatedSender` is processed FIRST in its round and discards all other tool calls. Only humans clear suspicion (`clearBotSuspicion` via `returnToAi` or rejecting a `bot_suspect` handoff).
- Handoff keywords: `matchesHandoffKeyword` (whole word/phrase, accent-insensitive); defaults are intent phrases; bare "atendente"/"humano" match only in ≤ 3-word messages.

## Model output — nothing technical reaches a customer
- Every text that could become a message passes `detectLeakedModelMarkup` (`convex/lib/llmOutputGuard.ts`): leak → discard the WHOLE round (text and tools), retry once with a nudge, then fail. Applies to attendant, follow-up, simulator, group agent (`sanitizeGroupReply` returns null), generated posts (raw AND cleaned). Build guard: `llmOutputGuardWiring.test.ts`. Copilot (in-app, human reads) is exempt.
- `finish_reason:"length"` discards the whole response (providers close truncated tool JSON), retries once with "reason briefly, ≤ 500 chars", then fails. Reactive turn cap 2000 tokens; follow-up/post generation 3000 with `withReasoningEffort(routes, "low")` (OpenRouter only).
- Markdown → WhatsApp formatting is deterministic at the funnel exit (`toWhatsAppText`, `convex/lib/whatsappText.ts`) before `commitArgsBase`, in the simulator, `sanitizeGroupReply`, `cleanGeneratedPost` (before truncation). Never apply to human messages, quick replies, campaigns, copilot or the disclosure text.
- Attendant exit is `formatReplyForTransport` (runtime and simulator, always AFTER `detectLeakedModelMarkup`): Instagram/Messenger get PLAIN text (`toPlainChatText`, `convex/lib/chatText.ts`: no `*`/`_`/`~`/`#`/backticks, links `t (u)`, lists `- `); everything else `toWhatsAppText`. Splitting into parts is the dispatcher's job (`lib/metaSend.ts`). Build guard: `llmOutputGuardWiring.test.ts`.
- Group agent and generated posts: plain text without a tool is never published; posts need REGRA 7 ("no tools in this task"); agenda is injected as text (`formatAgendaForPrompt`), past events removed in the publication's `schedule.timezone`.
- Date/time block goes at the END of the system prompt (prefix caching); never at the top. Timezone: `schedule.timezone` valid → org → `America/Sao_Paulo`.

## Tools (`convex/lib/agentTools.ts`, `convex/lib/agentSecurity.ts`)
- Static registry; 4 layers: `assertAgentCan` (RBAC of the acting member), per-record scope, `TOOL_DENYLIST` (build guard `agentToolSecurity.test.ts`), untrusted envelope (`convex/lib/promptEnvelope.ts`). The model never receives ids for follow-ups (`INJECTED_PARAM_NAMES`); it acts by ordinal index on the list it was shown (`createdAt <= turnStartedAt`).
- Tool args influenced by the customer are sanitized before persistence (`sanitizeFollowUpNote`/`sanitizeFollowUpTitle`: URLs, e-mails, UUIDs, CPF/CNPJ, phones removed). `replyToCustomer.imageUrl` is accepted only if equal to an `image` returned by `consultarAgenda` in the SAME turn.
- `consultarAgenda` + `replyToCustomer` in the same round → reply discarded (`{status:"descartado"}`), model asked again. Loss-stage `moveThisLead` requires `reason`; in suggest mode a proposal without it is refused before becoming a card.
- Copilot tools act AS the user (`actorType:"human"`, `metadata.via:"copilot"`), destructive ones via `pendingActions` (two-phase). `launchCampaign` never launches from the copilot.
- Suggest-mode previews use the SAME planner as execution (`planFollowUpSchedule`); approving a stale card with a past `dueAt` is an error, not a silent past schedule.

## Providers, routes, cost (`convex/lib/llm/`, `convex/lib/agentRoutes.ts`)
- Route precedence: product (`providerConfig.products.<copilot|attendant|vision>.order`) > org `platformOrder` > env `LLM_PLATFORM_ORDER` > `auto`. BYO key is org-wide (no fallback). `OPENROUTER_ONLY_MODELS` skip the OpenCode Go hop; OpenCode Go has returned 400 `x-opencode-session` since 2026-09 (dead route). `DEFAULT_MODELS` must work for orgs without OpenRouter.
- OpenRouter body: `data_collection:"deny"` + `require_parameters` are the ZDR lock; `allow_fallbacks:true` everywhere (primary-provider 429s took the attendant down). Vision has its own failover loop (any error = next hop, 45 s timeout, `max_tokens` 1500) and an explicit model allowlist per route (`VISION_MODELS_BY_PROVIDER`, fail-closed); image-dropped detection via `imagem_recebida` field + `VISION_TEXT_ONLY_PROMPT_TOKENS` floor (re-measure when the vision prompt changes — a test enforces it).
- Vision runs ONCE per image (`vision.autoDescribe`, result as text in `messages.imageDescription`); the attendant stays text-only. PDFs/videos are never readable: `historyTextOf` says so (not gated by `visionEnabled`). D13: the AI reads a receipt but never confirms payment.
- Cost: `MODEL_PRICES` per model (USD/1M, official provider or median of OpenRouter endpoints — never the top of `/models`), build test requires a price for every registry model; unknown → highest price + `costEstimated`. Helpers in `convex/lib/aiSpend.ts`; monthly counter `aiUsageMonthly` updated in `agentRuns.internalFinishRun` (idempotent). `spendCap.mode:"block"` turns the attendant into drafts + one `ai_budget` handoff per lead/month and suspends other products via `internalSpendGate`.
- Diagnostics: `aiDiagnostics:pingChain` shows each hop's real error (the queue stores only the last hop's); `measureReasoning`. Runs in `agentRuns` carry tokens/cost/tools, never transcripts or PII.

## Prompt text and simulator
- Prompt/persona edits via `opsAgentProfile.internalSetAgentProfileText` (UTF-16 length cap, audit with before/after). Curated goldens (`CURATED_GOLDENS`, 7) protect: audio, receipt image + D13, PDF, "receipt arrived → no follow-up", "customer silent → gentle resume", Instagram and Messenger plain text (channel comes from the tag via `goldenTransport`, no schema field). Re-run them when touching prompts.
- `simulateAttendant` accepts `audio`/`image`/`file` transcript items, `followUp`, `simulatedNow`, `transport` (`instagram`/`messenger` = plain-text exit + channel name in the default persona); it must mirror production guards (output guard, no plain-text send in follow-up). `agentEvals.replayEval` runs on the live clock (known drift for date goldens).
