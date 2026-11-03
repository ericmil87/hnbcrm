---
paths:
  - "convex/telegram*.ts"
  - "convex/opsTelegram.ts"
  - "convex/lib/telegram*.ts"
---

# Copilot on Telegram (team bot)

Gotchas that change how code must be written. Full reasoning: `docs/architecture/telegram.md`.

- `convex/lib/telegramApi.ts` is the ONLY code that talks to `api.telegram.org` or reads `TELEGRAM_BOT_TOKEN` (guard `telegramApiPort.test.ts`). Everything else calls its wrappers; never `fetch` the Bot API elsewhere.
- Button and prompt actions go ONLY through `convex/lib/telegramActions.ts`: `authorizeTelegramActor` (org of the tapped card, live member, module, RBAC like the public mutation) before every port; ids from `callback_data` via `normalizeId` of the expected table. No other telegram file references domain `internal.*` or cores (guard `telegramActionsPort.test.ts`).
- Notifications reach Telegram only through `createNotification` (fan-out after the insert); every notification type needs a template or an `IGNORED_FOR_TELEGRAM` entry (parity test).
- The hooks in `lib/telegramRelay.ts` are the only pipeline hooks (`internalReceiveMessage`, `internalCommitAiReply`, accept/reject/cancel handoff cores); they never throw into the caller; never relay a group conversation.
- Revocation has one door: `revokeTelegramLink` (`convex/lib/telegramLinks.ts`) — status, audit `telegram.unlinked`, cleanup (farewell, `deleteMessage` ≤ 48 h, chat pointer). Member removal calls `revokeTelegramLinksForMember`.
- "Member alive" = `isLinkMemberAlive` (same org, human, same `userId`, not removed; `busy` is alive). Re-check it on every update; never trust a link row alone.
- Never log the token, the request URL, a chat id next to a name, or any message text (member's or customer's). Bot API `description` is not logged by the port.
- Webhook: wrong/missing secret → 401; 200 always after a valid secret, except when the ingest mutation itself failed and nothing was stored (then 500, so Telegram retries; ingest is idempotent by `update_id`). A non-2xx blocks that chat's queue. Callback acks go in the response body.
- Decide in a mutation, send in an action: routing mutations return `replies`; only actions call the port. No `fetch` in mutations.
- `parse_mode: "HTML"`: every dynamic value through `escapeHtml`; LLM/customer Markdown through `markdownToTelegramHtml` (raw HTML is escaped, links only http(s)); long text through `splitMessage`.
- Private chats only. A group chat must never receive CRM data.
- DEV ≠ PROD bots, each deployment with its own token. The webhook URL is always `${CONVEX_SITE_URL}/webhooks/telegram/platform` of the running deployment; never add a URL override to ops.
- Ops in `opsTelegram.ts`: `internalAction`, `dryRun` default true, output never contains the token or the webhook secret.
- Reports (`telegramReports.ts`): the hourly tick stamps the local date on the link BEFORE scheduling (idempotent); `internalSendReport` with `trigger:"command"` (`/hoje`) never stamps; data only through `internalBuildReportData` (bounded indexes, "50+" caps, no `.collect()`).
- F2 commands (`telegramCommands.ts`) read only through bounded indexes, authorize with `resolveTelegramViewer` + RBAC per list, and never touch domain tables for writes; F2 callbacks (`cmd:`/`pg:`/`fc:`/`mu:`/`org:`) are parsed BEFORE F1's `handleTelegramCallback` and every id in them is re-validated (`normalizeId`, same org, ownership). Mute applies to ALL active links of the chat. `Reply.persistentKeyboard` is the reply keyboard; a message carries only one `reply_markup` (inline wins).
- Schema is additive: fields for later phases stay `v.optional`; new telegram tables go to `retention.ts` and `EXCLUDED_BACKUP_TABLES`.
- Tests always stub `fetch` (`vi.stubGlobal`) and use fake tokens (`123456:FAKE-TOKEN-…`).
