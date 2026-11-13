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
  - "convex/lib/whatsappCheck.ts"
  - "convex/lib/messageRetry.ts"
  - "convex/messageRetry.ts"
  - "convex/opsBridgeNumbers.ts"
  - "convex/inboundLeadWelcome.ts"
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
- `Connect()` rewrites the instance's event subscription: every connect and the provisioning MUST send the shared `BRIDGE_WEBHOOK_EVENTS` list (`convex/lib/bridgeSession.ts`: `Message`, `ReadReceipt`, `LoggedOut`, `TemporaryBan`, `ClientOutdated`, `GroupInfo`, `JoinedGroup` — no `ChatPresence`, no `Connected`). A channel paired before a list change must reconnect to re-subscribe.
- Logout = `POST /session/logout` with the instance token (unlinks the device); `/session/disconnect` only drops the socket. `deleteChannelConfig` and `claimBridgePhone` schedule the logout.
- Global presence: upstream wuzapi sends `PresenceAvailable` on every `Connected`, and WhatsApp mutes the PHONE while a linked device is `available`. `channelConfigs.bridgePhoneNotifications` (absent/true = phone keeps ringing → we POST `/user/presence` `{"type":"unavailable"}`; false = legacy `available`) is applied by `channelHealth.internalBridgeApplyPresence` (≈2 s after pairing, on "Testar conexão", on toggle) and re-asserted by every health tick for connected channels (`applyBridgePresence`, best effort).
  - Typing is bracketed available→composing→send→unavailable when the setting is on (`lib/bridgePresence.ts`; AI/scheduled sends in `dispatchViaBridge`, operator typing in `internalBridgeSendPresence` composing/paused). Every bridge send (human too) closes with `unavailable` in a `finally` — the re-assert after an operator `composing`; `available` is sent only on the typing path. Off = no global presence calls.
  - Pairing schedules the re-assert at 2 s AND 30 s (wuzapi re-sends `available` on `PushNameSetting`/app-state sync). The tick stops at 420 s and resumes the same page with `skip`.
- `TemporaryBan.Expire` arrives in ns. `Disconnected`/`Connected` are ignored on purpose (socket flaps); the 15-min cron `internalChannelHealthTick` alerts only after ≥ 10 min down on a second observation.

## Parsing inbound (`convex/lib/bridgeParse.ts`, pure)
- `Info.IsFromMe` is BOTH our echo and a human typing on the phone app: route to `conversations.internalReceiveDeviceMessage` (`metadata.via:"device"`, no unread, never wakes the AI; audio IS transcribed via `scheduleAudioTranscription` except history import, `metadata.importedFromHistory`); the echo dies on `externalId` idempotency. Phone from `Chat`, `PushName` discarded (it is ours).
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
- Web pairing has ONE port: `channelConfigs.startBridgePairing`/`pollBridgePairing` (code mode shares the 3/h ceiling with Telegram via `lib/pairingQuota.ts` + `telegramReconnects`); never call `pairphone` elsewhere. The bridge webhook URL is built server-side (`bridgeWebhookUrl(CONVEX_SITE_URL)`), never by the client.

## Falha de envio, número errado e "sem WhatsApp" (nov/2026)
- `no LID found for <jid> from server` = "não registrado" OU "registrado na outra grafia" (9º dígito BR): o texto não distingue e repetir a mesma grafia falha sempre. Só `checkBridgeNumber` responde, e ELE valida o resultado: um telefone fora de `phoneLookupCandidates(perguntado)` vira `ok:false` (todos os chamadores ficam "não verificado", nunca com número estranho).
- `lib/bridgeSendError.ts` (puro) classifica TODO erro de envio do bridge: `recipient_not_found` | `transient` (SÓ o provadamente ANTES do envio: `failed to get user info … LID cache`, `failed to get LID for PN`, conexão recusada/DNS) | `rate_limited` (429) | `session` (401/403 ou texto de sessão fora de 5xx) | `ambiguous` (pode já ter sido entregue: `network:true`, qualquer 2xx sem id, timeout/EOF/reset/"disconnected before message send", 5xx mesmo com texto de sessão, exceção inesperada: NUNCA reenvia sozinho) | `permanent` (padrão). Classe em `metadata.deliveryErrorKind`; `metadata.deliveryPreSend` marca recusa local ou HTTP 4xx (`isPreSendHttpRejection`).
- Reenvio manual: `needsDeliveredAck` usa LISTA POSITIVA (`recipient_not_found`/`transient`/`rate_limited`, `deliveryPreSend`, ou `deliveryErrorCode` da Meta); o resto, inclusive mensagem SEM classe (legado, 5xx/rede da Meta), exige `maybeDeliveredAck` (auditado).
- Decisão única `whatsapp.internalDecideBridgeFailure`: `recipient_not_found` 1:1 → self-heal UMA vez por mensagem (`selfHealAt` gravado na mesma mutation) e só com vaga no orçamento do CONTATO; contato já marcado = falha direta, sem consulta. Resposta do gateway: outra grafia (`isSpellingOfSameNumber`) e sem opt-out em nenhuma grafia → `applyCanonicalNumberToContact` + reagenda a MESMA mensagem; não existe → `not_on_whatsapp` + falha; "o gateway diz que ESTE número existe mas o envio deu no LID", telefone fora das grafias ou checagem fora do ar → inconclusivo (`numberCheck` `inconclusive`/`unavailable`: falha, sem marcador, sem reescrita). `transient`: 3 envios (30 s, 2 min); `rate_limited`: 1 retry em 15 min, pelo `rescheduleWhatsappDispatch` (mesmo pacing). Falha definitiva só então (e o repasse de boas-vindas só então).
- Orçamento de consultas por CONTATO (não por número): `reserveWhatsappLookup` (`contacts.whatsappLookup`; 10 min entre consultas, 3 por dia UTC; fora dele só Nova conversa SEM contato e campanha; Nova conversa COM contato usa `startFlow`) é a porta ÚNICA do self-heal, da pré-checagem das boas-vindas e do "Tentar novamente" (OCC no doc do contato serializa mensagens diferentes). `setWhatsappCheck` sempre regrava `checkedAt` (última consulta).
- `contacts.whatsappCheck {phone,status,checkedAt}` (porta `lib/whatsappCheck.ts`): é invalidado por COMPARAÇÃO (`not_on_whatsapp` vale para as duas grafias BR; `verified` é exato; `markerSurvivesNumberChange` na edição); mensagem recebida limpa; `contacts.whatsappFails` conta respostas REAIS `no LID` seguidas (exato nos dígitos; o gate local não conta) sem marcador e, a partir de 2, para os automáticos (`isAutomatedSendBlocked`; o self-heal ainda consulta); zera em correção/edição/inbound/envio aceito ("existe" para o mesmo número é inconclusivo: `verified` não grava nem zera com contador > 0); marcador e contador valem só no BRIDGE (`conversationIsBridge`); só marca o número realmente checado (`contactNumberWasChecked`). Gate ÚNICO dos envios automáticos no `dispatchMessage` (IA, follow-up, agendada, boas-vindas, campanha): marcado = falha visível sem rede. Envio humano (inbox, encaminhar, REST `notOnWhatsappAck`) recusa com `NOT_ON_WHATSAPP:` sem aceite; com aceite grava `metadata.notOnWhatsappAck {by,at,via}` + audit `high`. Aceite só de PESSOA: membro `ai` (chave de API de IA, Copiloto) é recusado no servidor (`notOnWhatsappAck` e `maybeDeliveredAck`); Telegram/Copiloto mostram texto humano.
- `messageRetry.retryFailedMessage` (teto 3; mensagem de campanha recusada: `campaignRecipients.by_message`/`metadata.campaign`; opt-out normalizado nas duas grafias; 3 consultas por mensagem + orçamento do contato). Boas-vindas do site: `internalRunInboundLeadWelcome` (resposta HTTP síncrona, consulta limitada a 4 s) e no bridge nunca reescreve `whatsappNumber` com 13 dígitos. Ops: `opsBridgeNumbers.internalRepairNoLidNumbers` (dry run só lista; `lookup:true` consulta; não reenvia). `internalRedispatchStuckOutbound` respeita `bridgeRetry`/`selfHealAt` só dentro de uma janela de graça.

## Fixtures
- `convex/__fixtures__/bridgeGroupMessage.json`, `bridgeGroupList.json` are REAL captures; `bridgeGroupInfoEvent.json`, `bridgeJoinedGroup.json`, `bridgeSessionEvents.json`, `bridgeMessageTypes.json` are SYNTHETIC (built from whatsmeow structs) — re-validate against a live gateway before trusting field names.
- Segurança do número corrigido: o telefone devolvido pelo gateway só vale se for grafia do número perguntado (`isSpellingOfSameNumber`, `phoneLookupCandidates`); o self-heal checa opt-out em todas as grafias antes de reenviar; "gateway diz que existe mas o envio deu `no LID`" é inconclusivo (falha, sem marcador). "Tentar novamente" reserva a consulta numa mutation (`numberChecks` ≤ 3, 10 min entre consultas, `retryAfter`); marcador recente recusa sem consultar.
- Data-URI enviado ao gateway leva só o tipo base (`toDataUri` corta os parâmetros): `data:audio/ogg; codecs=opus;base64,` é recusado pelo wuzapi ("could not decode base64 encoded data", espaço depois do `;`). O codec da nota de voz vai no campo `MimeType` do corpo (`planBridgeAudioSend` → `voiceFields`). Nunca monte data-URI à mão.
- Todo ogg de nota de voz passa por `repairOggOpusTimeline` e `readOggOpus` (`convex/lib/oggOpus.ts`) antes de ir ao gateway: o conversor devolve granule inválido para gravação do navegador (o WhatsApp mostra e não toca) e, sem `Seconds`, a bolha sai sem duração. "Entregue" não prova que toca; um ogg que o ffmpeg toca pode ser recusado pelo WhatsApp. Fixture de áudio em base64 dispara o `secretScan`: monte bytes sintéticos com `convex/lib/oggOpus.testkit.ts`.
