---
paths:
  - "convex/whatsapp.ts"
  - "convex/bridge.ts"
  - "convex/channelConfigs.ts"
  - "convex/channelHealth.ts"
  - "convex/startConversation.ts"
  - "convex/groupChats.ts"
  - "convex/groupMedia*.ts"
  - "convex/lib/bridge*.ts"
  - "convex/lib/group*.ts"
  - "convex/lib/whatsappDispatch.ts"
  - "convex/lib/channel*.ts"
  - "convex/lib/campaignPacing.ts"
  - "convex/__fixtures__/**"
---

# WhatsApp channel: Meta Cloud API + bridge (wuzapi/whatsmeow)

Measured gotchas of the gateways. Full history and reasoning: `docs/architecture/whatsapp-bridge.md`, `docs/architecture/groups.md`, `docs/architecture/inbox.md` (Nova conversa), `docs/architecture/campaigns.md`.

## Two transports, one channel
- `channelConfigs.provider` is `"meta"` (official Graph API, 24 h window, templates) or `"bridge"` (self-hosted wuzapi, QR pairing, no window, no templates, ban risk, per-org opt-in acks: `aiConfig.bridgeAiAck`, `bridgeGroupsAck`, campaign `bridgeRiskAck`). Outbound dispatch branches by provider in `convex/whatsapp.ts`; config resolution via `convex/lib/channelResolve.ts`.
- Meta refuses groups and free text outside the 24 h window (template required). A brand-new conversation is always outside the window.
- Ingress: Meta `GET/POST /webhooks/whatsapp`; bridge `POST /webhooks/bridge` verified by HMAC-SHA256 (`WA_BRIDGE_HMAC_SECRET`). Bridge webhook drops events of channels with `status !== "active"`, so session-loss handling must NOT change `channelConfigs.status` — it writes `bridgeSessionState` (`isSessionLostState` gates sends).
- Both transports save attachments through `internalSaveInboundAttachment` (MIME allowlist + quota; refusal never throws — returns `{ok:false, reason}` and the message keeps its text).

## wuzapi facts (measured against the real gateway — do not "fix" them)
- `GET /session/status` returns `jid: ""` even when logged in. The phone comes from `GET /admin/users` (managed gateway only) → `phoneFromAdminUsers`; self-hosted stays empty.
- `GET /user/lid/{phone}` is the ONLY endpoint that returns a PHONE JID (`…@s.whatsapp.net`) and only for the registered spelling; the wrong 9th-digit spelling gets 404 "LID not found". `POST /user/check` answers one user with an `@lid` JID for any spelling — it does not discriminate. `/user/info` answers HTTP 500 with `success:true`.
- `…@lid` is NOT a phone. Only `isPhoneJid` (`@s.whatsapp.net`/`@c.us`) may become `whatsappNumber`; never store LID digits as a phone (it created contacts like `+1614…`).
- History: field is `data_json` (snake_case), the row `timestamp` is the WRITE time — real time is `data_json.Info.Timestamp`; a conversation without history returns `{"code":200,"data":null}` (not an error). Only `fromMe` is imported (inbound re-injection would wake the AI attendant).
- Groups: `/group/list` returns `{"Groups": null}` when empty and `ParticipantCount` 0 — count `Participants.length` from `/group/info`; non-existent JID → HTTP 500 with `success:true`; participants come `@lid` with the phone in `PhoneNumber`; `/user/info` by LID returns no phone.
- `Connect()` rewrites the instance's event subscription: every connect and the provisioning MUST send the shared `BRIDGE_WEBHOOK_EVENTS` list (includes `ReadReceipt`, `ChatPresence`, `GroupInfo`, `JoinedGroup`, `LoggedOut`, `TemporaryBan`, `ClientOutdated`). A channel paired before a list change must reconnect to re-subscribe.
- Logout = `POST /session/logout` with the instance token (unlinks the device); `/session/disconnect` only drops the socket. `deleteChannelConfig` and `claimBridgePhone` schedule the logout.
- `TemporaryBan.Expire` arrives in ns. `Disconnected`/`Connected` are ignored on purpose (socket flaps); the 15-min cron `internalChannelHealthTick` alerts only after ≥ 10 min down on a second observation.

## Parsing inbound (`convex/lib/bridgeParse.ts`, pure)
- `Info.IsFromMe` is BOTH our echo and a human typing on the phone app: route to `conversations.internalReceiveDeviceMessage` (`metadata.via:"device"`, no unread/AI/transcription); the echo dies on `externalId` idempotency. Phone from `Chat`, `PushName` discarded (it is ours).
- Drop `…@newsletter` and `…@broadcast` (incl. `status@broadcast`) in message, receipt and presence — channels must never become leads.
- `unwrapBridgeMessage` unwraps ephemeral/viewOnce/documentWithCaption/deviceSent/edited (≤ 4 levels). `NOISE_KEYS` (sender key distribution, protocol messages other than REVOKE/MESSAGE_EDIT, poll updates, enc reactions, pins…) → `kind:"ignored"` BEFORE persisting. New types carry `metadata.bridgeType` + `metadata.bridgeExtra` (contract `BridgeMessageType`/`BridgeExtraByType`); `inviteCode` and vCards are never stored.
- Revoke/edit: target id comes from the SENDER's payload — only the author (group admin may revoke) may apply; revoke keeps content (`metadata.revoked`), edit keeps the first original (`metadata.previousContent`); neither touches unread/`lastMessageAt`/AI.
- Media: persist only `sanitizeBridgeMediaMeta` (kind/mime/filename/length); `stripMediaKeyMaterial` runs over the whole metadata before DB. `MediaKey` material never reaches `messages` — group deferred media keeps it encrypted in `deferredGroupMedia` (excluded from backups).
- Group media default `mentions` (`convex/lib/groupMediaPolicy.ts`): download only when the message is "with us" (`shouldTriggerGroupAgent`); stickers never; deferred items are not failures (`metadata.mediaDeferred`).

## Number exclusivity, phones, receipts
- One phone = one account deployment-wide: `channelConfigs.bridgePhone` + index `by_bridge_phone`; `claimBridgePhone` runs inside `internalRecordHealthCheck` (same transaction) when a channel becomes `connected` and displaces other channels (audit `high`, pauses their campaigns, schedules logout).
- 9th digit: `phoneLookupCandidates` yields both 12/13-digit BR spellings; `startConversation` passes `phoneIsCanonical:true` with the gateway-confirmed JID and the server must NOT re-normalize it. Dispatch reads `whatsappNumber ?? phone`.
- Receipts: outbound starts `sent`; delivered/read come from `ReadReceipt` (group reads feed `messages.readBy`, cap 50, never downgrade). Delivery hooks (`internalMarkDispatched`/`internalMarkDispatchFailed`) fan out to campaigns, follow-ups and inbound-lead welcome.

## Sending (`convex/lib/whatsappDispatch.ts`, `convex/lib/bridgeSend.ts`)
- Two-level pacing cursor: per conversation (6.5 s) + per number (`channelPacing`; Meta 1–3 s, bridge 4–15 s with jitter); humanized typing on bridge for AI/scheduled sends. Retry backoff 4^X for Meta 131056/130429/80007; 131048 freezes the channel 30 min; 131026/131047/130403 → failed; 131050 → opt-out.
- Voice notes are transcoded to ogg/opus via the Whisper service `/convert`. Quotes in groups need `Participant` = member JID; mentions in `MentionedJID` filtered against participants (`resolveGroupMentions`).
- Campaign caps live in `convex/lib/campaignPacing.ts` (safe table by number age; hard cap bridge 200/day, 40/h, ≥ 15 s; Meta 80 % of tier); daily/hourly counters in `channelPacing.campaign*` with enforcement.

## Fixtures
- `convex/__fixtures__/bridgeGroupMessage.json`, `bridgeGroupList.json` are REAL captures; `bridgeGroupInfoEvent.json`, `bridgeJoinedGroup.json`, `bridgeSessionEvents.json`, `bridgeMessageTypes.json` are SYNTHETIC (built from whatsmeow structs) — re-validate against a live gateway before trusting field names.
