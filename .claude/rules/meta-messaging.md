---
paths:
  - "convex/metaMessaging*.ts"
  - "convex/lib/meta*.ts"
  - "convex/lib/channelTransport.ts"
  - "convex/lib/outboundDispatch.ts"
  - "convex/lib/channelResolve.ts"
  - "convex/__fixtures__/meta/**"
  - "src/lib/channelAccounts.ts"
  - "src/components/inbox/ChannelOriginBadge.tsx"
---

# Meta Messaging: Instagram + Facebook Messenger (official Graph API)

Gotchas that change how code must be written. Full reasoning: `docs/architecture/meta-messaging.md`.

## Transport, not provider
- `configTransport(config)` (`convex/lib/channelTransport.ts`) decides by `channel` BEFORE `provider`: `whatsapp` → `meta`|`bridge`, `instagram`, `messenger`; unknown channel throws. `configProvider()` is WhatsApp-only and throws for any other channel — never call it on a config that came from a generic listing without `config.channel === "whatsapp"` first.
- `resolveConversationChannelConfig` is strict for non-WhatsApp conversations: only `conversation.channelConfigId` (same org). The "first active WhatsApp config" fallback exists only for `channel:"whatsapp"`; an Instagram conversation must never resolve to a WhatsApp number.
- Every send goes through `scheduleOutboundDispatch` (`convex/lib/outboundDispatch.ts`). Until F1 lands, `instagram`/`messenger` outbound is marked `failed` ("ainda não está disponível") instead of silently staying `sent`.

## Credential and identity
- Page token lives ONLY in `metaConnections.tokenEncrypted` (`encryptSecret`); one connection per Page serves both the `messenger` and the `instagram` config (`channelConfigs.metaConnectionId`, index `by_meta_connection`). The OAuth user token is never persisted. `META_MESSAGING_APP_SECRET`/`APP_ID`/`LOGIN_CONFIG_ID`/`WEBHOOK_VERIFY_TOKEN` are platform envs, never per-tenant.
- PSID (Messenger) and IGSID (Instagram) are NOT phones: they go to `contactChannelIdentities` keyed `(channelConfigId, externalId)` via `findOrCreateContactByMetaIdentity` (`convex/lib/metaIdentity.ts`); contacts created from them have no `phone`/`whatsappNumber`. Same person on IG and Messenger = two contacts until a manual link.
- Webhook routing: `object:"page"` → `entry.id` in `channelConfigs.by_messenger_page_id`; `object:"instagram"` → `by_instagram_account_id`. Org comes from the config, never from the payload. Signature (`X-Hub-Signature-256`, app secret) is verified BEFORE parsing; unknown account → 200 and drop (no tenant leak, stops retries); config not `active` or org module off → 200 and drop.
- Exclusivity is deployment-wide (like `claimBridgePhone`): same Page or same IG account in another org → `conta_em_uso`, without naming the org.
- Never log/audit/emit full PSID, IGSID, `mid`, token or message text together; 4 last digits at most. Fixtures in `convex/__fixtures__/meta/` use obviously fake ids (`1000000000000001`).

## Module `metaMessaging` (`settings.modules`)
- Off by default. `assertModule(ctx, org, "metaMessaging")` guards `startMetaConnect`, OAuth finalization, reconnect; disconnect/delete never require it. It is NOT part of `assertAnyModule`/`anyEnabled` (that is the Central gate).
- Turning the module off sets Meta configs to `status:"disabled"` + `disabledByModuleAt`; turning it on re-enables only those, and only when the connection is `ok`.

## Inbox label (D11)
- The account label (Page name / `@handle`) is NEVER denormalized into conversations. Conversations keep `channel`, `channelConfigId`, `channelProvider` (`meta|bridge|instagram|messenger`); the UI joins with the small `getInboxChannelAccounts` query (F1). `ChannelOriginBadge` shows icon + channel.

## Parser (`convex/lib/metaMessagingParse.ts`, pure)
- Never throws: garbage → `{object:null, events:[]}`, unknown fields → `kind:"unknown"`. Events are sorted by `timestamp` inside a batch (Meta redelivers out of order). Messenger echoes come in `message_echoes` with `app_id`; Instagram echoes come inside `messages` with `is_echo` (and maybe no `app_id`, §13 item 5). `entry[].standby[]` → `standby:true` (another app controls the thread: AI must not answer).
