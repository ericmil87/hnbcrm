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
- Every send goes through `scheduleOutboundDispatch` (`convex/lib/outboundDispatch.ts`) → `scheduleMetaMessagingDispatch` (`convex/lib/metaDispatch.ts`) → `metaMessaging.internalDispatchMessage`. The service window (24 h, 7 days when `conversations.windowOpenedByAdAt`) is checked server-side in BOTH the port and the dispatcher; closed = `failed` with copy, no network. Destination = the contact's `contactChannelIdentities` row for the conversation's `channelConfigId`, never another config's.
- Every outbound carries `message.metadata = "hnb:<messageId>"`; echoes with our `app_id` are no-ops (link the mid), echoes from another app/no app are device messages (`via:"device"` + `viaApp`). Error 190 sets the CONNECTION to `reauth_required` (both configs stop sending), never the config `status`.

## Credential and identity
- Page token lives ONLY in `metaConnections.tokenEncrypted` (`encryptSecret`); one connection per Page serves both the `messenger` and the `instagram` config (`channelConfigs.metaConnectionId`, index `by_meta_connection`). The OAuth user token is never persisted. `META_MESSAGING_APP_SECRET`/`APP_ID`/`LOGIN_CONFIG_ID`/`WEBHOOK_VERIFY_TOKEN` are platform envs, never per-tenant.
- PSID (Messenger) and IGSID (Instagram) are NOT phones: they go to `contactChannelIdentities` keyed `(channelConfigId, externalId)` via `findOrCreateContactByMetaIdentity` (`convex/lib/metaIdentity.ts`); contacts created from them have no `phone`/`whatsappNumber`. Same person on IG and Messenger = two contacts until a manual link.
- Webhook routing: `object:"page"` → `entry.id` in `channelConfigs.by_messenger_page_id`; `object:"instagram"` → `by_instagram_account_id`. Org comes from the config, never from the payload. Signature (`X-Hub-Signature-256`, app secret) is verified BEFORE parsing; unknown account → 200 and drop (no tenant leak, stops retries); config not `active` or org module off → 200 and drop.
- Exclusivity is deployment-wide (like `claimBridgePhone`): same Page or same IG account in another org → `conta_em_uso`, without naming the org.
- Never log/audit/emit full PSID, IGSID, `mid`, token or message text together; 4 last digits at most. Fixtures in `convex/__fixtures__/meta/` use obviously fake ids (`1000000000000001`).

## OAuth in two legs (F6)
- `GET /oauth/meta/callback` never finalizes: it checks the state (exists, unused, not expired, no code yet), stores the `code` ENCRYPTED in `oauthStates.codeEncrypted` (+ `codeReceivedAt`), ROTATES `nonceHash` to a fresh nonce and redirects `?meta=finalizar&state=<fresh nonce>`. The initiator knows only the original nonce, so a Meta URL forwarded to another Page owner cannot be finished by the initiator; the victim's browser gets the fresh nonce but is not the state's member.
- `finalizeMetaOAuth({organizationId, state})` (action, `settings:manage` + `requireAccountWithEmail`) → `internalClaimOAuthCode`: same org AND `state.memberId` = the caller's membership, else `sem_papel`/`expirado` and nothing is consumed; on success `usedAt` + code wiped in the same mutation, then code → short → long token → `/me` → permissions → `/me/accounts` → `finalizeConnection` or `metaOAuthPending`. TTL stays 10 min from `startMetaConnect`. The code never goes into a URL or a log.

## Delete, reconnect and routing (F6)
- `deleteChannelConfig` refuses an Instagram/Messenger config that has conversations ("Use Desconectar"). A NEW Meta config schedules `internalRelinkMetaOrphans` (identities then conversations whose `channelConfigId` is dead, same org and channel; batches of 200 by cursor) ONLY when it is the org's single config of that channel: PSID/IGSID are per account, so with another live account the orphan's origin is unknown.
- A connection whose IG disappeared or changed disables its `instagram` config and clears `instagramAccountId`; a changed IG gets a NEW config (never reuses the old account's). `internalGetConfigForMetaAccount` drops the event (masked log) when two ACTIVE configs of the same account sit in different orgs.
- REST `/receive` on Meta drops `metadata.referral`/`metadata.standby` (only the signed webhook may open the 7-day window or flag standby) and passes `skipAiEnqueue` when the contact has no identity on that config.
- Health tick with every config of the connection `disabled`/`disabledByModuleAt`: writes `authState` only (no bell/e-mail/webhook, `authAlertedAt` stays empty so the next tick after re-enabling alerts).

## Module `metaMessaging` (`settings.modules`)
- Off by default. `assertModule(ctx, org, "metaMessaging")` guards `startMetaConnect`, OAuth finalization, reconnect; disconnect/delete never require it. It is NOT part of `assertAnyModule`/`anyEnabled` (that is the Central gate).
- Turning the module off sets Meta configs to `status:"disabled"` + `disabledByModuleAt`; turning it on re-enables only those, and only when the connection is `ok`.

## Inbox label (D11)
- The account label (Page name / `@handle`) is NEVER denormalized into conversations. Conversations keep `channel`, `channelConfigId`, `channelProvider` (`meta|bridge|instagram|messenger`); the UI joins with the small `getInboxChannelAccounts` query (F1). `ChannelOriginBadge` shows icon + channel.

## Parser (`convex/lib/metaMessagingParse.ts`, pure)
- Never throws: garbage → `{object:null, events:[]}`, unknown fields → `kind:"unknown"`. Events are sorted by `timestamp` inside a batch (Meta redelivers out of order). Messenger echoes come in `message_echoes` with `app_id`; Instagram echoes come inside `messages` with `is_echo` (and maybe no `app_id`, §13 item 5). `entry[].standby[]` → `standby:true` (another app controls the thread: AI must not answer).

## Meta callbacks and REST (F5)
- `deauthorize` / `data-deletion` are outside `/api/v1` (no `ROUTE_PERMISSIONS`); the `signed_request` is verified first (`lib/metaSignedRequest.ts`, constant time, `issued_at` ≤ 24 h) and an invalid one is 400. They find connections by `metaConnections.metaUserId` (set from `debug_token.user_id` in `finalizeConnection`; old rows via `opsMeta.internalMetaBackfillUserId`), revoke (`authSource:"deauthorize"`, token wiped, configs `disabled`, routing ids cleared) and NEVER delete conversations/contacts/leads. The `user_id` is only stored as a sha256 (`metaDeletionRequests`) or masked in audit.
- `GET /conversations/channels` is `internalListChannelsForRest`; the public `listSendableWhatsappChannels` (Nova conversa) stays WhatsApp-only. `/inbound/lead` refuses `instagram`/`messenger` (it would create an outbound with no config).
- `GET /conversations?channelConfigId=` / `?channel=` use the additive indexes `conversations.by_organization_and_channel_config` / `by_organization_and_channel` (`_creationTime` implicit, same cursor as the route); no JS post-filter, no scan cap. `metaUserId` comes from `GET /me?fields=id` (OAuth token, carried by `metaOAuthPending`), fallback `debug_token.user_id`, and the health tick fills it when missing; `data-deletion` clears it on the revoked connections, including those already revoked by an earlier deauthorize.
