---
paths:
  - "convex/telegram*.ts"
  - "convex/opsTelegram.ts"
  - "convex/lib/telegram*.ts"
---

# Copilot on Telegram (team bot)

Gotchas that change how code must be written. Full reasoning: `docs/architecture/telegram.md`.

- `convex/lib/telegramApi.ts` is the ONLY code that talks to `api.telegram.org` or reads `TELEGRAM_BOT_TOKEN` (guard `telegramApiPort.test.ts`). Everything else calls its wrappers; never `fetch` the Bot API elsewhere.
- Button actions (F1+) go through the future `convex/lib/telegramActions.ts`, which re-authorizes (live member + RBAC + entity org) before calling the domain port. Never call a domain `internal*` straight from Telegram code.
- Revocation has one door: `revokeTelegramLink` (`convex/lib/telegramLinks.ts`) — status, audit `telegram.unlinked`, cleanup (farewell, `deleteMessage` ≤ 48 h, chat pointer). Member removal calls `revokeTelegramLinksForMember`.
- "Member alive" = `isLinkMemberAlive` (same org, human, same `userId`, not removed; `busy` is alive). Re-check it on every update; never trust a link row alone.
- Never log the token, the request URL, a chat id next to a name, or any message text (member's or customer's). Bot API `description` is not logged by the port.
- Webhook: wrong/missing secret → 401; 200 always after a valid secret, except when the ingest mutation itself failed and nothing was stored (then 500, so Telegram retries; ingest is idempotent by `update_id`). A non-2xx blocks that chat's queue. Callback acks go in the response body.
- Decide in a mutation, send in an action: routing mutations return `replies`; only actions call the port. No `fetch` in mutations.
- `parse_mode: "HTML"`: every dynamic value through `escapeHtml`; LLM/customer Markdown through `markdownToTelegramHtml` (raw HTML is escaped, links only http(s)); long text through `splitMessage`.
- Private chats only. A group chat must never receive CRM data.
- DEV ≠ PROD bots, each deployment with its own token. The webhook URL is always `${CONVEX_SITE_URL}/webhooks/telegram/platform` of the running deployment; never add a URL override to ops.
- Ops in `opsTelegram.ts`: `internalAction`, `dryRun` default true, output never contains the token or the webhook secret.
- Schema is additive: fields for later phases stay `v.optional`; new telegram tables go to `retention.ts` and `EXCLUDED_BACKUP_TABLES`.
- Tests always stub `fetch` (`vi.stubGlobal`) and use fake tokens (`123456:FAKE-TOKEN-…`).
