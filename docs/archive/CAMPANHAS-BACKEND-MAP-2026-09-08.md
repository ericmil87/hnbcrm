# Mapeamento do backend — WhatsApp / dispatch / gate / import

Repositório: `/home/eric/projects/ClawCRM/clawcrm-repo` (branch `main`, HEAD `32e7523`).
Objetivo: base factual para desenhar CAMPANHAS DE ENVIO EM MASSA de WhatsApp.
Este documento **mapeia**, não propõe soluções.

---

## Achado central

**Não existe nada de campanha/broadcast no repositório.**

Grep por `campaign|broadcast|disparo|bulkSend|em massa|sequence` em `convex/` e `src/` retorna apenas:

- `utmCampaign` — parâmetro UTM de formulários (`convex/schema.ts:1202`, `:1235`, `convex/formSubmissions.ts:147`, `convex/formPartials.ts:20`, `convex/router.ts:2037`).
- A palavra "broadcast" em **comentários** sobre notificação de handoff sem destinatário (`convex/handoffs.ts:238`, `convex/handoffNotify.test.ts:155`).
- `"Email Campaign"` como *lead source* de seed (`convex/organizations.ts:127`, `convex/seed.ts:155`).
- `src/pages/TermsPage.tsx:90` — os Termos de Uso do próprio produto **proíbem** "Enviar comunicações não solicitadas em massa, mensagens fraudulentas ou conteúdo ilícito".

Nenhuma tabela, função, rota, tool ou tela.

---

## 1. Outbound WhatsApp hoje

### 1.1 Ponto de entrada público

`convex/conversations.ts:754` — `sendMessage` (mutation)

```ts
export const sendMessage = mutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    contentType: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))),
    isInternal: v.optional(v.boolean()),
    attachments: v.optional(v.array(v.id("files"))),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
    replyToMessageId: v.optional(v.id("messages")),
  },
  returns: v.id("messages"),
  ...
```

Auth: `const userMember = await requireAuth(ctx, conversation.organizationId);` — **não** usa `requirePermission("inbox","reply")`. Qualquer membro da org pode enviar.

Sequência do handler:
1. `assertAttachmentsInOrg(ctx, org, attachments)` (`conversations.ts:134`) — valida que cada `fileId` é da org.
2. `resolveReplyMeta(ctx, conversation, replyToMessageId)` (`conversations.ts:153`) — monta `metadata.quoted = {messageId, externalId?, fromMe, preview?}` e `metadata.quotedMessageId`. Referência inválida é silenciosamente descartada.
3. `ctx.db.insert("messages", {...})` com `direction: isInternal ? "internal" : "outbound"`, `senderType: userMember.type === "ai" ? "ai" : "human"`.
4. `ctx.db.patch(fileId, { messageId })` para cada anexo.
5. Patch da conversa (`lastMessageAt`, `messageCount+1`, `updatedAt`).
6. Patch do lead (`lastActivityAt`, `updatedAt`, `conversationStatus: "active"`).
7. `auditLogs` (severity `low`) + `activities` (`type: "message_sent"`).
8. Webhook `message.sent` via `ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, ...)` — só se `!isInternal`.
9. `if (!args.isInternal && conversation.channel === "whatsapp") await scheduleWhatsappDispatch(ctx, conversation, messageId);`

### 1.2 Gêmeos do mesmo corpo

- `convex/conversations.ts:1124` — `internalSendMessage` — args idênticos + `teamMemberId: v.id("teamMembers")`. Guarda de tenant explícita: `if (teamMember.organizationId !== conversation.organizationId) throw new Error("Membro não pertence à organização da conversa")`. Corpo duplicado linha a linha.
- `convex/lib/outboundSideEffects.ts:18` — `applyOutboundMessageSideEffects(ctx, {conversation, member, messageId, now, activityContent?})`. Núcleo compartilhado por `forwardMessage` (`conversations.ts:885`) e pelo commit transacional do atendente IA. Vive em `lib/` para evitar ciclo de módulos (`attendant.ts` precisa disto e `conversations.ts` agenda `internal.attendant.*`). Faz: patch conversa → patch lead → auditLog → activity → webhook `message.sent` → `scheduleWhatsappDispatch`.
- `convex/scheduledMessages.ts:105` — `deliver` reimplementa o corpo inline (não usa o helper).

### 1.3 Resolução de channelConfig

`convex/lib/channelResolve.ts` (42 linhas, arquivo inteiro):

```ts
export async function resolveConversationChannelConfig(
  ctx: QueryCtx, conversation: Doc<"conversations">
): Promise<Doc<"channelConfigs"> | null> {
  if (conversation.channel !== "whatsapp") return null;
  if (conversation.channelConfigId) {
    const config = await ctx.db.get(conversation.channelConfigId);
    if (config) return config;
  }
  const configs = await ctx.db.query("channelConfigs")
    .withIndex("by_organization", (q) => q.eq("organizationId", conversation.organizationId))
    .collect();
  const active = configs.filter((c) => c.channel === "whatsapp" && c.status === "active");
  return active.find((c) => configProvider(c) === "meta") ?? active[0] ?? null;
}

export function providerOf(config: Doc<"channelConfigs"> | null): "meta" | "bridge" | null {
  return config ? configProvider(config) : null;
}
```

Fallback determinístico: prefere **meta** (conservador — janela 24h exigida, sem ack de bridge); bridge só se for o único ativo.

`convex/channelConfigs.ts:58` — `configProvider(config)` normaliza `provider === undefined → "meta"` (compat com linhas legadas).

**Duplicatas da mesma lógica** (não usam o helper):
- `convex/conversations.ts:176` — `resolveWhatsappTarget(ctx, conversation)` → `{config, toPhone}`. Usado por mark-read / typing / reaction.
- `convex/conversations.ts:1468` — inline dentro de `internalSendTemplate`.

### 1.4 Pacing em dois níveis

`convex/lib/whatsappDispatch.ts` — 164 linhas, o arquivo inteiro é pacing.

Constantes (`:34-49`):

| Constante | Valor | Nível |
|---|---|---|
| `PAIR_RATE_INTERVAL_MS` | 6500 | por conversa (Meta impõe ~1 msg/6s por par, erro 131056) |
| `META_CHANNEL_GAP_MS` / `_JITTER_MS` | 1000 / 2000 | por número |
| `BRIDGE_REACTIVE_GAP_MS` / `_JITTER_MS` | 4000 / 6000 | por número, conversa com inbound <24h |
| `BRIDGE_COLD_GAP_MS` / `_JITTER_MS` | 8000 / 7000 | por número, envio frio (faixa 8–15s) |
| `REACTIVE_WINDOW_MS` | 24h | limite reativo/frio |
| `TYPING_BASE_MS` / `_PER_CHAR_MS` / `_MAX_MS` | 1500 / 55 / 8000 | humanização bridge |

Comentário de cabeçalho registra que os números do bridge **não são limites oficiais** — são estimativas de engenharia calibráveis (a comunidade diverge de 1-5s a 15-45s), com o benchmark Letalk citado como referência para a faixa fria. O gap Meta também não é exigência (80 mps comportaria) — é prudência de *quality rating* contra picos idênticos a blast de spam.

```ts
export function computeTypingDelayMs(message: {
  senderType: "contact" | "human" | "ai";
  contentType: "text" | "image" | "file" | "audio";
  content: string;
  metadata?: Record<string, unknown>;
}): number {
  const humanized = message.senderType === "ai" || message.metadata?.scheduled === true;
  if (!humanized) return 0;                       // envio manual nunca ganha atraso artificial
  if (message.contentType !== "text") return TYPING_BASE_MS;
  return Math.min(TYPING_BASE_MS + message.content.length * TYPING_PER_CHAR_MS, TYPING_MAX_MS);
}
```

```ts
export async function claimChannelSlot(
  ctx: MutationCtx,
  args: {
    config: Doc<"channelConfigs">;
    conversation: Doc<"conversations">;
    earliestAt: number;
    now: number;
    extraAdvanceMs?: number;
    floorMs?: number;
    countSend?: boolean;
  }
): Promise<number>
```
(`whatsappDispatch.ts:84`) — lê/escreve o doc `channelPacing` da config; claims concorrentes leem+escrevem o mesmo doc, e o OCC do Convex serializa (mesmo padrão de `aiPacing`). `floorMs` empurra o cursor para >= o valor **antes** do claim (usado quando 130429/80007 atrasam a fila inteira do canal). `dailyCount = {day: ISO-UTC, sent}` é incrementado quando `countSend` — **métrica-only, sem enforcement**, o comentário diz que existe "p/ calibrar um futuro warm-up/cap de canal bridge com dados reais".

```ts
export async function scheduleWhatsappDispatch(
  ctx: MutationCtx, conversation: Doc<"conversations">, messageId: Id<"messages">
): Promise<void>
```
(`whatsappDispatch.ts:133`) — resolve config; se bridge, calcula `typingDelayMs`; `earliestAt = max(now, conversation.nextDispatchAt ?? 0)`; `slot = claimChannelSlot(...)` (ou `earliestAt` se não há config resolvível); `patch(conversation, {nextDispatchAt: slot + PAIR_RATE_INTERVAL_MS})`; `scheduler.runAfter(slot - now, internal.whatsapp.internalDispatchMessage, {messageId, typingDelayMs?})`.

Fórmula efetiva: `slot = max(now, cursorDaConversa, cursorDoCanal)`. Canal ocioso → cursor no passado → envio imediato; o pacing só morde em rajada.

O typing delay é somado ao **avanço do cursor** no claim, não só aguardado na action — senão dois envios consecutivos chegariam mais próximos que o intervalo prometido.

### 1.5 Egress

`convex/whatsapp.ts:574` — `internalDispatchMessage({messageId: v.id("messages"), typingDelayMs: v.optional(v.number())})` (internalAction, `returns: v.null()`).

Contexto: `convex/whatsapp.ts:286` — `internalGetDispatchContext({messageId})` (internalQuery, `returns: v.any()`) devolve:
```ts
{ message, conversation, config, toPhone, latestInboundExternalId, attachmentFiles }
```
`toPhone = contact?.whatsappNumber ?? contact?.phone ?? null` (o contato vem de `lead.contactId`). `latestInboundExternalId` sai de um `.take(50)` das mensagens da conversa, procurando o último inbound com `externalId`.

Fluxo do handler:
1. `if (!context) return null;`
2. Idempotência: `if (message.externalId || message.deliveryStatus) return null;`
3. `if (!config || config.status !== "active")` → mark-failed "Nenhum número de WhatsApp ativo conectado…"
4. `if (configProvider(config) === "bridge") { await dispatchViaBridge(...); return null; }`
5. Meta: exige `config.accessTokenEncrypted && config.phoneNumberId`, depois `toPhone`.

`GRAPH_API_BASE = "https://graph.facebook.com/v23.0"` (`whatsapp.ts:48`), `MAX_MEDIA_BYTES = 25 * 1024 * 1024` (`:49`).

Payload Meta por prioridade **template > anexo > texto** (`whatsapp.ts:632`):

```ts
const payload: Record<string, unknown> = { messaging_product: "whatsapp", to: toPhone };
const template = message.metadata?.template as
  | { name: string; languageCode: string; components?: unknown[] } | undefined;
if (template) {
  payload.type = "template";
  payload.template = { name: template.name, language: { code: template.languageCode },
                       ...(template.components ? { components: template.components } : {}) };
} else if (attachmentFiles.length > 0) {
  const file = attachmentFiles[0];
  const link = await ctx.storage.getUrl(file.storageId);   // URL pública do Convex Storage
  const kind = file.mimeType.startsWith("image/") ? "image"
             : file.mimeType.startsWith("audio/") ? "audio" : "document";
  payload.type = kind;
  payload[kind] = { link,
    ...(kind === "document" ? { filename: file.name } : {}),
    ...(kind !== "audio" && message.content ? { caption: message.content } : {}) };
} else {
  payload.type = "text";
  payload.text = { body: message.content };
}
```

Não há ramo `video` no caminho Meta — vídeo cai em `document`. Quote via `payload.context = { message_id: quotedExternalId }`, só quando **não** é template.

`POST ${GRAPH_API_BASE}/${config.phoneNumberId}/messages` com `Authorization: Bearer ${await decryptSecret(config.accessTokenEncrypted)}`. Sucesso → `wamid = body?.messages?.[0]?.id` → `internalMarkDispatched`. Em seguida, best-effort, marca o último inbound como lido (`{messaging_product, status:"read", message_id}`).

### 1.6 Bridge (wuzapi)

`convex/whatsapp.ts:383` — `dispatchViaBridge(ctx, {messageId, message, config, toPhone, attachmentFiles, typingDelayMs?})`.

Ordem das guardas:
1. `if (message.metadata?.template)` → mark-failed "Templates são exclusivos da WhatsApp Cloud API oficial — não disponível no canal bridge" (backstop defensivo; `internalSendTemplate` já recusa antes).
2. `if (!toPhone)` → mark-failed.
3. `if (!config.bridgeBaseUrl || !config.bridgeInstanceId || !config.bridgeTokenEncrypted)` → mark-failed.
4. `const token = await decryptSecret(config.bridgeTokenEncrypted);`
5. Se `typingDelayMs > 0`: `POST /chat/presence` com `State: "composing"` (best-effort, try/catch vazio) e `await new Promise(r => setTimeout(r, typingDelayMs))`.
6. Quote: `BridgeQuote = { stanzaId, participant? }` — `participant` só quando se cita a mensagem **do contato**.
7. Mídia (`attachmentFiles.length > 0 || contentType !== "text"`): pega `attachmentFiles[0]`; recusa >25MB; `ctx.storage.get(storageId)` → `Uint8Array`; se `contentType === "audio"` e mime não é ogg, tenta `convertVoiceNoteToOggOpus`; monta data-URI base64 e envia. **Um anexo por mensagem** — extras viram nota em `dispatchNotes` (`"${n} anexo(s) adicional(is) não enviado(s)"`).
8. `parseBridgeSendResponse(response.ok, response.status, body)` → `internalMarkDispatched({messageId, wamid: result.externalId, note?})` ou `internalMarkDispatchFailed`.

`convex/whatsapp.ts:351` — `convertVoiceNoteToOggOpus(bytes, mimeType)`: `POST ${WHISPER_SERVICE_URL}/convert?target=ogg-opus` com `Authorization: Bearer ${WHISPER_SERVICE_TOKEN}`. Best-effort, nunca lança; retorna `null` se serviço não configurado ou falha, e aí manda o original com nota.

`convex/whatsapp.ts:331` — `MEDIA_PLACEHOLDERS` (`"[imagem]"`, `"[figurinha]"`, `"[mensagem de voz]"`, `"[áudio]"`, `"[vídeo]"`, `"[documento]"`, `"[mensagem não suportada]"`) e `captionFor(content)` (`:340`): nunca ecoa um placeholder como caption de saída.

Builders — `convex/lib/bridgeSend.ts` (317 linhas). Header de auth é `token` **minúsculo** (token por-instância, não o admin token); corpo PascalCase. Todos confirmados contra o gateway real no piloto de 2026-07-19 (marcações `VALIDAR:` ainda abertas para os endpoints de mídia).

| Kind | Path | Campo do payload | Extras |
|---|---|---|---|
| text | `/chat/send/text` | `Body` | `ContextInfo` p/ quote |
| image | `/chat/send/image` | `Image` (data-URI) | `Caption` |
| audio | `/chat/send/audio` | `Audio` (data-URI) | **sem** Caption (PTT) |
| document | `/chat/send/document` | `Document` (data-URI) | `Caption`, `FileName` |
| video | `/chat/send/video` | `Video` (data-URI) | `Caption` |

```ts
export function buildBridgeTextSendRequest(params: {
  baseUrl: string; token: string; toPhone: string; body: string; quote?: BridgeQuote;
}): BridgeSendRequest

export function buildBridgeMediaSendRequest(params: {
  baseUrl: string; token: string; toPhone: string;
  kind: BridgeMediaSendKind;      // "image" | "audio" | "document" | "video"
  dataUri: string; caption?: string; filename?: string; quote?: BridgeQuote;
}): BridgeSendRequest

export function bridgeSendKindForMime(mimeType: string): BridgeMediaSendKind   // :173
export function parseBridgeSendResponse(ok, status, body): BridgeSendResult    // :258
export function parseBridgeAckResponse(...): BridgeAckResult                   // :306
```

Outros builders no mesmo arquivo: `buildBridgeReactRequest` (`/chat/react`, `{Phone, Body, Id}`, `:91`), `buildBridgeMarkReadRequest` (`/chat/markread`, `{Id:[...], ChatPhone, SenderPhone}`, `:119`), `buildBridgePresenceRequest` (`/chat/presence`, `{Phone, State, Media}`, `:148`).

`convex/lib/bridgeMedia.ts` — download inbound (`/chat/downloadimage|downloadaudio|downloadvideo|downloaddocument`, `:32-36`), mais `toDataUri` (`:293`), `base64ToBytes` (`:275`), `bytesToBase64` (`:283`), `sanitizeBridgeMediaMeta` (`:141`), `stripMediaKeyMaterial` (`:112`), `MEDIA_KEY_DENY_PATTERNS` (`:82`).

`convex/lib/bridgeSession.ts` — sessão: `/session/status` (`:72`), `/session/connect` (`:107`), `/session/qr` (`:124`), `/session/hmac/config` (`:87`), provisionamento (`:137`). `phoneFromJid(jid)` (`:56`).

**`/user/check` (verificar se um número tem WhatsApp) NÃO é usado em lugar nenhum.**

### 1.7 Marcação de resultado, retry e congelamento

`convex/whatsapp.ts:774` — `internalMarkDispatched({messageId, wamid, note?})`: patch `{externalId: wamid, deliveryStatus: "sent"}` (+ `metadata.dispatchNote` quando há nota).

`convex/whatsapp.ts:800` — `internalMarkDispatchFailed({messageId, errorCode?, detail})`: patch `deliveryStatus: "failed"` + `metadata.deliveryError` / `metadata.deliveryErrorCode`, e insere uma activity `type: "note"`, `actorType: "system"` com `"Falha ao enviar mensagem no WhatsApp: ${detail}"`.

`convex/whatsapp.ts:835` — `MAX_DISPATCH_RETRIES = 3` (backoff oficial 4^X: 1s, 4s, 16s), `QUALITY_FREEZE_MS = 30 * 60 * 1000`.

`convex/whatsapp.ts:842` — `internalRescheduleDispatch({messageId, errorCode, typingDelayMs?})`, `returns: v.union(v.object({retryInMs: v.number()}), v.null())`. Trata **131056** (pair rate), **130429** (throughput do número), **80007** (WABA rate limit).
- Mensagem já em estado terminal → devolve `{retryInMs: 0}` **sem** re-agendar (retornar `null` faria o chamador sobrescrever um "sent" com "failed").
- `attempts = (metadata.dispatchAttempts ?? 0) + 1`; `if (attempts > MAX_DISPATCH_RETRIES) return null` (aí o chamador marca failed).
- **Nunca toca `deliveryStatus`** — a guarda de idempotência do dispatch mataria o retry.
- Reivindica novo slot via `claimChannelSlot`; para 130429/80007 passa `floorMs: now + backoffMs`, empurrando **a fila inteira do canal** (é throttling do número/conta, não da mensagem).

`convex/whatsapp.ts:895` — `internalFreezeChannelPacing({messageId, freezeMs})` para **131048** (número restringido por qualidade — mensagens bloqueadas/denunciadas como spam): **nunca re-tenta** (insistir agrava o quality rating), congela `channelPacing.nextDispatchAt = now + freezeMs`, e insere activity de alerta. Dedupe: `recentlyFrozen = (row?.nextDispatchAt ?? 0) > until - 5*60*1000` evita repetir o alerta para cada mensagem da mesma rajada.

Mensagens de erro finais (`whatsapp.ts:747-756`):

| Código | Mensagem |
|---|---|
| 131026 | "Fora da janela de 24h — é necessário enviar um template aprovado (erro 131026)" |
| 131056 | "Limite de envio para este destinatário — tentativas esgotadas" |
| 130429 | "Limite de vazão do número atingido — tentativas esgotadas" |
| 80007 | "Limite de envio da conta WhatsApp atingido — tentativas esgotadas" |
| 131048 | "A Meta restringiu envios deste número por qualidade … Fila do canal pausada por 30 minutos" |

### 1.8 Recibos, reações e presença

- `convex/whatsapp.ts:952` — `internalDispatchReaction` (bridge `/chat/react`; Meta = mensagem tipo "reaction").
- `convex/whatsapp.ts:1001` — `internalBridgeMarkRead`.
- `convex/whatsapp.ts:1032` — `internalBridgeSendPresence`.
- Meta: read receipt inline logo após o envio bem-sucedido, dentro de try/catch ("read receipts are cosmetic — never fail the dispatch over them").

Superfície pública correspondente em `conversations.ts`: `reactToMessage` (`:1692`), `markConversationRead` (`:1734`), `sendTypingState` (`:1876`).

### 1.9 Templates da Meta — existem, mas mínimos

`convex/conversations.ts:1441`:

```ts
export const internalSendTemplate = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    teamMemberId: v.id("teamMembers"),
    templateName: v.string(),
    languageCode: v.string(),
    components: v.optional(v.array(v.any())),
  },
  returns: v.id("messages"),
  ...
```

- Guarda de tenant do ator; exige `conversation.channel === "whatsapp"`.
- Resolve o provider **inline** (duplicando `resolveConversationChannelConfig`) e recusa bridge: `"Templates são exclusivos da WhatsApp Cloud API oficial e não estão disponíveis no canal bridge"`.
- Grava a message com `content: "[template] ${args.templateName}"`, `contentType: "text"` e `metadata.template = {name, languageCode, components?}`. Comentário: "Best-effort rendered body — the real text lives in Meta's template definition".
- Side effects completos (patch conversa/lead, auditLog com `metadata.templateName`, activity `Template "X" enviado via whatsapp`, webhook `message.sent`) e `scheduleWhatsappDispatch`.

**O que NÃO existe:**
- Listagem de templates da Meta (`GET /{wabaId}/message_templates`) — nenhuma chamada no repo.
- Criação, edição ou submissão de template para aprovação.
- Sync/armazenamento local de status de aprovação (`APPROVED`/`REJECTED`/`PENDING`).
- Tipagem dos `components` — é `v.array(v.any())`, sem validação de variáveis/parâmetros.
- Função pública no app e UI. A única exposição é REST:
  - `convex/router.ts:880` — `POST /api/v1/conversations/send-template`, exige `{conversationId, templateName, languageCode}` e chama `internal.conversations.internalSendTemplate`.
  - `convex/router.ts:164` — permissão `{ category: "inbox", level: "reply" }`.

---

## 2. Criar conversa / contato para número novo

### 2.1 Caminho inbound (o único que cria do zero hoje)

`convex/whatsapp.ts:157` — `internalIngestMessage({configId, message})` (internalAction):
1. `internal.channelConfigs.internalGetConfig` → se `status === "disabled"` sai.
2. Idempotência precoce: `internal.conversations.internalGetMessageByExternalId` (a Meta reentrega webhooks por até 7 dias).
3. Pipeline de mídia: `GET {GRAPH_API_BASE}/{media.id}` → `lookup.url` (expira ~5min) → download → `ctx.storage.store(blob)` → `internalSaveInboundAttachment`. Erros viram `metadata.mediaError` / `metadata.mediaSkipped`, nunca derrubam a mensagem.
4. `internal.whatsapp.internalRouteInbound({configId, waId: message.from, profileName})`.
5. `internal.conversations.internalReceiveMessage({organizationId, leadId, channel:"whatsapp", channelConfigId, content, contentType, attachments, externalId, metadata})`.

`convex/whatsapp.ts:248` — `internalRouteInbound`, `returns: v.object({contactId: v.id("contacts"), leadId: v.id("leads")})`:
```ts
const contactId = await findOrCreateContactByPhone(ctx, {
  organizationId: config.organizationId, phone: args.waId, firstName: args.profileName });
const org = await ctx.db.get(config.organizationId);
const attendant = await findAttendantForChannel(ctx, org, config);
const pipeline = attendant?.agentProfile?.pipelineConfig;
const leadId = await ensureLeadForContact(ctx, {
  organizationId: config.organizationId, contactId,
  preferredBoardId: pipeline?.boardId, preferredStageId: pipeline?.initialStageId });
```

### 2.2 Helpers de roteamento — `convex/lib/inboundRouting.ts` (231 linhas)

```ts
export async function findOrCreateContactByPhone(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; phone: string; firstName?: string; lastName?: string }
): Promise<Id<"contacts">>
```
Índice `by_organization_and_phone`. Se existe e não tinha `firstName`, faz backfill (com `buildSearchText`). Se cria, grava **`phone` e `whatsappNumber` com o mesmo valor**, `tags: []`.

```ts
export async function ensureLeadForContact(
  ctx: MutationCtx,
  args: { organizationId; contactId; title?; preferredBoardId?; preferredStageId? }
): Promise<Id<"leads">>
```
- Lead existente: `query("leads").withIndex("by_contact").order("desc").take(50)` e filtra pela org. Se achou, devolve.
- Board: `boards` da org filtrando `archivedAt === undefined`; `defaultBoard = boards.find(isDefault) ?? boards[0]`; sem board → `throw new Error("No boards configured")`.
- `preferredBoardId`/`preferredStageId` inválidos **nunca quebram o ingest**: caem no default e registram `pipelineFallback` como activity explicativa.
- Auto-assign: se `org.settings.aiConfig.autoAssign`, procura membro `type: "ai"`, `status: "active"`, `agentProfile.kind === "attendant"` (o copiloto é deliberadamente excluído — atribuir a ele travaria a condição 6 de elegibilidade).
- Título: `[firstName, lastName].filter(Boolean).join(" ") || phone || email || "Unknown contact"`.
- Insere lead com `value: 0`, `currency: org.settings.currency || "USD"`, `priority: "medium"`, `temperature: "cold"`, `tags: []`, `customFields: {}`, `conversationStatus: "new"`.
- Grava activity `type: "created"` + auditLog (`severity: "medium"`, `metadata.source: "inbound_message"`).

```ts
export async function findAttendantForChannel(
  ctx: MutationCtx, org: Doc<"organizations"> | null, config: Doc<"channelConfigs">
): Promise<Doc<"teamMembers"> | null>
```
Gates: `orgAiActive(org)`, `aiConfig.attendantEnabled !== false`, `config.status === "active"`, e bridge só com `aiConfig.bridgeAiAck !== undefined`. Depois filtra membros IA ativos com `agentProfile.kind === "attendant"` e `channelConfigIds` compatível.

### 2.3 Get-or-create de conversa

`convex/conversations.ts:198`:
```ts
async function getOrCreateConversation(ctx, {organizationId, leadId, channel}): Promise<Id<"conversations">> {
  const existing = await ctx.db.query("conversations")
    .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.leadId).eq("channel", args.channel))
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert("conversations", {
    organizationId, leadId, channel, status: "active", messageCount: 0, createdAt: now, updatedAt: now });
}
```
**Uma conversa por (lead, canal).** Note que a conversa criada aqui não tem `channelConfigId` — ele só é gravado por `internalReceiveMessage` quando chega inbound.

### 2.4 `internalReceiveMessage` — `convex/conversations.ts:1270`

```ts
args: { organizationId, leadId, channel, channelConfigId?, content,
        contentType?, attachments?, externalId?, metadata? }
returns: v.union(v.id("messages"), v.null())
```
1. Idempotência por `by_organization_and_external_id`.
2. Comandos de teste (`/resetme`, `/resetlist`, `/resetother`) — triplo gate em `convex/testReset.ts`, allowlist por env `WA_TEST_RESET_PHONES`; a mensagem de comando **não** é persistida.
3. `getOrCreateConversation` + insert da message (`direction: "inbound"`, `senderType: "contact"`).
4. Patch da conversa: `status: "active"`, `lastMessageAt`, **`lastInboundAt: now`** (abre a janela de 24h), `messageCount+1`, `unreadCount + 1`, e grava `channelConfigId` se mudou.
5. Patch do lead, activity `message_received`, webhook `message.received`.
6. `if (contentType === "audio" && attachments) scheduler.runAfter(0, internal.transcription.autoTranscribe, {messageId})`.
7. `if (contentType === "image" && attachments) scheduler.runAfter(0, internal.vision.autoDescribe, {messageId})`.
8. `scheduler.runAfter(0, internal.attendant.internalEnqueueFromInbound, {messageId})` — sempre; o enqueue re-checa elegibilidade e é no-op barato com IA desligada.

### 2.5 Caminho outbound para número novo: NÃO EXISTE

`convex/conversations.ts:955`:
```ts
export const createConversation = mutation({
  args: { organizationId: v.id("organizations"), leadId: v.id("leads"),
          channel: v.union(v.literal("whatsapp"), v.literal("telegram"),
                           v.literal("email"), v.literal("webchat"), v.literal("internal")) },
  returns: v.id("conversations"),
  handler: async (ctx, args) => { await requireAuth(ctx, args.organizationId);
                                  return await getOrCreateConversation(ctx, args); },
});
```
Exige `leadId` já existente. Único chamador no frontend: `src/components/LeadDetailPanel.tsx:587`, e com `channel: "internal"` hardcoded.

Não existe `startConversation`, nem botão "nova conversa" no Inbox, nem qualquer caminho que crie contato+lead+conversa a partir de um número digitado. Para campanha a números novos seria preciso encadear os três helpers manualmente — todos vivem em `lib/` e são chamáveis de qualquer `MutationCtx`.

`convex/conversations.ts:1250` — `internalCreateConversation` é a versão sem auth, mesmos args.

### 2.6 Normalização de telefone: praticamente inexistente

Único helper no repositório — `convex/lib/importMapping.ts:76`:
```ts
export function normalizePhone(raw: string): string {
  return String(raw ?? "").replace(/\D+/g, "");
}
```
Usado só uma vez, em `importMapping.ts:694` (find-or-create de contato no import).

O formato de facto é **dígitos E.164 sem `+`**, herdado do `from` do ingress. Documentado em comentário: `convex/lib/bridgeSend.ts:55` ("`toPhone` is E.164 digits WITHOUT a leading '+'"), `convex/lib/bridgeParse.ts:26` e `:51`.

Não há: validação de país, inserção/remoção do 9º dígito brasileiro, canonicalização, nem biblioteca de telefone. Um número digitado `(11) 91234-5678` viraria `11912345678` e **não** casaria com o `5511912345678` que o WhatsApp usa.

### 2.7 Verificação "número tem WhatsApp?": NÃO EXISTE

Grep por `/user/check|onWhatsApp|checkUser` não retorna nada. Endpoints wuzapi efetivamente usados: `/session/{status,connect,qr,hmac/config}`, `/chat/send/{text,image,audio,document,video}`, `/chat/{react,markread,presence}`, `/chat/download{image,audio,video,document}`.

---

## 3. Schema

Todos os blocos em `convex/schema.ts` (1630 linhas).

### 3.1 `conversations` (`:556`)

```ts
conversations: defineTable({
  organizationId: v.id("organizations"),
  leadId: v.id("leads"),
  channel: v.union(v.literal("whatsapp"), v.literal("telegram"), v.literal("email"),
                   v.literal("webchat"), v.literal("internal")),
  channelConfigId: v.optional(v.id("channelConfigs")),
  status: v.union(v.literal("active"), v.literal("closed")),
  lastMessageAt: v.optional(v.number()),
  lastInboundAt: v.optional(v.number()),      // drives the 24h customer-service window
  nextDispatchAt: v.optional(v.number()),     // pacing cursor (~1 msg/6s per recipient)
  contactPresence: v.optional(v.object({
    state: v.union(v.literal("composing"), v.literal("paused")), at: v.number() })),
  archivedAt: v.optional(v.number()),
  labelIds: v.optional(v.array(v.id("conversationLabels"))),
  unreadCount: v.optional(v.number()),
  lastReadAt: v.optional(v.number()),
  aiTurnLock: v.optional(v.object({ runId: v.string(), leaseUntil: v.number() })),
  aiPausedUntil: v.optional(v.number()),      // MAX_SAFE_INTEGER = pausa indefinida
  aiTeamNotes: v.optional(v.array(v.object({
    text: v.string(), byMemberId: v.optional(v.id("teamMembers")), at: v.number() }))),
  messageCount: v.number(),
  createdAt: v.number(), updatedAt: v.number(),
})
  .index("by_organization", ["organizationId"])
  .index("by_lead", ["leadId"])
  .index("by_lead_and_channel", ["leadId", "channel"])
  .index("by_organization_and_status", ["organizationId", "status"])
  .index("by_organization_and_last_message", ["organizationId", "lastMessageAt"])
  .index("by_organization_and_unread", ["organizationId", "unreadCount"]),
```

### 3.2 `messages` (`:617`)

```ts
messages: defineTable({
  organizationId: v.id("organizations"),
  conversationId: v.id("conversations"),
  leadId: v.id("leads"),
  direction: v.union(v.literal("inbound"), v.literal("outbound"), v.literal("internal")),
  senderId: v.optional(v.id("teamMembers")),
  senderType: v.union(v.literal("contact"), v.literal("human"), v.literal("ai")),
  content: v.string(),
  contentType: v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio")),
  attachments: v.optional(v.array(v.id("files"))),
  deliveryStatus: v.optional(v.union(v.literal("sent"), v.literal("delivered"),
                                     v.literal("read"), v.literal("failed"))),
  isInternal: v.boolean(),
  mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
  externalId: v.optional(v.string()),          // wamid / stanzaId
  metadata: v.optional(v.record(v.string(), v.any())),
  transcriptText: v.optional(v.string()),      // cópia rasa p/ search index
  imageDescription: v.optional(v.string()),    // idem, passe de visão
  createdAt: v.number(),
})
  .index("by_conversation", ["conversationId"])
  .index("by_lead", ["leadId"])
  .index("by_organization", ["organizationId"])
  .index("by_conversation_and_created", ["conversationId", "createdAt"])
  .index("by_organization_and_external_id", ["organizationId", "externalId"])
  .searchIndex("search_content",    { searchField: "content",          filterFields: ["organizationId","conversationId"] })
  .searchIndex("search_transcript", { searchField: "transcriptText",   filterFields: ["organizationId","conversationId"] })
  .searchIndex("search_image",      { searchField: "imageDescription", filterFields: ["organizationId","conversationId"] }),
```

`metadata` é record aberto — é onde vivem `template`, `quoted`, `quotedMessageId`, `scheduled`, `forwarded`, `aiDraft`, `dispatchAttempts`, `dispatchNote`, `deliveryError`, `deliveryErrorCode`, `mediaError`, `mediaSkipped`, `vision`, `transcription`, `reactions`.

### 3.3 `contacts` (`:359`)

Campos relevantes: `firstName?`, `lastName?`, `email?`, `phone?`, `company?`, `whatsappNumber?`, `telegramUsername?`, `tags: v.array(v.string())`, `searchText?`, blocos de identidade/social/localização/profissional/comportamental, `customFields?: v.record(v.string(), v.any())`, `enrichmentMeta?`, `enrichmentExtra?`, **`aiOptOut: v.optional(v.boolean())`** (LGPD art. 18 — 9ª condição de elegibilidade do atendente).

Índices: `by_organization`, `by_email`, `by_phone`, `by_organization_and_email`, `by_organization_and_phone`, `by_organization_and_company`, `by_organization_and_city`; search `search_contacts` sobre `searchText`.

**Não há índice por tag.**

### 3.4 `leads` (`:438`)

```ts
leads: defineTable({
  organizationId, title, contactId?, boardId, stageId, assignedTo?,
  value: v.number(), currency: v.string(),
  priority: "low"|"medium"|"high"|"urgent",
  temperature: "cold"|"warm"|"hot",
  sourceId?: v.id("leadSources"),
  tags: v.array(v.string()),
  customFields: v.record(v.string(), v.any()),
  qualification?: { budget?, authority?, need?, timeline?, score? },   // BANT
  conversationStatus: "new"|"active"|"waiting"|"closed",
  handoffState?: { status, fromMemberId, toMemberId?, reason, summary?,
                   suggestedActions?, requestedAt, completedAt? },
  closedAt?, closedReason?, closedType?: "won"|"lost",
  archivedAt?: v.number(),           // soft-delete
  lastActivityAt: v.number(), createdAt, updatedAt,
})
  .index("by_organization", ["organizationId"])
  .index("by_organization_and_board", ["organizationId","boardId"])
  .index("by_board", ["boardId"]).index("by_stage", ["stageId"])
  .index("by_assigned_to", ["assignedTo"]).index("by_contact", ["contactId"])
  .index("by_organization_and_stage", ["organizationId","stageId"])
  .index("by_organization_and_assigned", ["organizationId","assignedTo"])
  .index("by_organization_and_archived", ["organizationId","archivedAt"])
  .index("by_handoff_status", ["handoffState.status"])
  .index("by_last_activity", ["lastActivityAt"]),
```

### 3.5 `channelConfigs` (`:497`)

```ts
channelConfigs: defineTable({
  organizationId: v.id("organizations"),
  channel: v.union(v.literal("whatsapp")),          // union-ready
  provider: v.optional(v.union(v.literal("meta"), v.literal("bridge"))),  // undefined → "meta"
  displayName: v.string(),
  // Meta Cloud API
  phoneNumberId?, wabaId?, displayPhoneNumber?, verifyToken?,
  appSecretEncrypted?, accessTokenEncrypted?, appSecretLast4?, accessTokenLast4?,
  // Bridge (wuzapi/whatsmeow)
  bridgeBaseUrl?, bridgeInstanceId?, bridgeTokenEncrypted?, bridgeTokenLast4?,
  bridgeSessionState?: "connected"|"connecting"|"qr"|"disconnected"|"banned",
  status: v.union(v.literal("active"), v.literal("disabled"), v.literal("error")),
  lastHealthCheckAt?, healthDetail?,
  autoTranscribeAudio: v.optional(v.boolean()),
  autoDescribeImages: v.optional(v.boolean()),      // LEGADO v0.51→v0.52, nada lê nem escreve
  createdAt, updatedAt,
})
  .index("by_organization", ["organizationId"])
  .index("by_phone_number_id", ["phoneNumberId"])
  .index("by_verify_token", ["verifyToken"])
  .index("by_bridge_instance", ["bridgeInstanceId"]),
```

### 3.6 `channelPacing` (`:1438`) e `aiPacing` (`:1429`)

```ts
channelPacing: defineTable({
  organizationId: v.id("organizations"),
  channelConfigId: v.id("channelConfigs"),
  nextDispatchAt: v.number(),
  dailyCount: v.optional(v.object({ day: v.string(), sent: v.number() })),  // métrica-only
}).index("by_channel_config", ["channelConfigId"]),

aiPacing: defineTable({
  organizationId: v.id("organizations"), nextInferenceAt: v.number(),
}).index("by_organization", ["organizationId"]),
```

Comentário do schema explica por que é doc próprio: "um cursor quente no doc do config re-executaria as queries da UI de Canais a cada envio e ampliaria o conflito OCC de todo sendMessage".

### 3.7 `scheduledMessages` (`:672`)

```ts
scheduledMessages: defineTable({
  organizationId: v.id("organizations"),
  conversationId: v.id("conversations"),
  content: v.string(),
  scheduledAt: v.number(),
  status: v.union(v.literal("pending"), v.literal("sent"),
                  v.literal("canceled"), v.literal("failed")),
  createdBy: v.id("teamMembers"),
  scheduledFunctionId: v.optional(v.string()),   // id do runAt, para cancelar
  sentMessageId: v.optional(v.id("messages")),
  error: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_conversation_and_status", ["conversationId", "status"])
  .index("by_organization", ["organizationId"]),
```
**Só texto** — sem anexos, sem template, sem destinatário fora de uma conversa.

### 3.8 `conversationLabels` (`:664`) e `quickReplies` (`:693`)

```ts
conversationLabels: defineTable({ organizationId, name: v.string(), color: v.string(), createdAt })
  .index("by_organization", ["organizationId"]),

quickReplies: defineTable({ organizationId, shortcut: v.string(), content: v.string(),
                            createdBy: v.id("teamMembers"), createdAt, updatedAt })
```

### 3.9 `aiReplyQueue` (`:1385`) — o padrão de fila mais próximo de um worker

```ts
aiReplyQueue: defineTable({
  organizationId, conversationId, triggerMessageId, agentMemberId,
  status: v.union(v.literal("pending"), v.literal("processing"), v.literal("done"),
                  v.literal("skipped"), v.literal("failed")),
  attempts: v.number(),
  nextAttemptAt: v.number(),                  // slot de pacing/backoff (debounce incluído)
  mediaWaitUntil: v.optional(v.number()),
  transcriptWaitUntil: v.optional(v.number()), // LEGADO
  fallbackSentAt: v.optional(v.number()),
  origin: v.optional(v.union(v.literal("coach"), v.literal("return_to_ai"))),
  instruction: v.optional(v.string()),
  instructedBy: v.optional(v.id("teamMembers")),
  sourceDraftId: v.optional(v.id("messages")),
  error: v.optional(v.string()),
  createdAt, updatedAt,
})
  .index("by_conversation_and_status", ["conversationId", "status"])
  .index("by_organization_and_status", ["organizationId", "status"])
  .index("by_status_and_next_attempt", ["status", "nextAttemptAt"]),
```

### 3.10 `importJobs` (`:1579`) / `importJobBatches` (`:1614`)

```ts
importJobs: defineTable({
  organizationId, requestedBy: v.id("teamMembers"),
  status: v.union(v.literal("mapping"), v.literal("previewing"), v.literal("preview_ready"),
    v.literal("running"), v.literal("completed"), v.literal("completed_with_errors"),
    v.literal("failed"), v.literal("rolled_back"), v.literal("canceled")),
  entity: v.union(v.literal("contacts"), v.literal("leads")),
  fileId: v.id("files"),                            // fileType: "import_file"
  fileName: v.string(),
  detectedHeaders: v.optional(v.array(v.string())),
  suggestedMapping: v.optional(v.record(v.string(), v.string())),
  mapping: v.optional(v.record(v.string(), v.string())),  // header → campo | "cf:<key>" | "__ignore__"
  duplicateStrategy: v.union(v.literal("skip"), v.literal("update"), v.literal("create")),
  matchFields: v.optional(v.array(v.string())),     // default contatos: ["email","phone"]
  dryRun: v.optional(v.object({
    totalRows, validRows, errorRows, newRows, updateRows, skipRows,
    sampleErrors: v.array(v.object({ row, field?, message })),   // cap 50
    preview: v.array(v.record(v.string(), v.any())),             // 10 primeiras
  })),
  progress: v.object({ processed, total, created, updated, skipped, failed }),
  error?, createdAt, startedAt?, finishedAt?,
})
  .index("by_organization", ["organizationId"])
  .index("by_organization_and_status", ["organizationId", "status"]),

importJobBatches: defineTable({
  organizationId, jobId: v.id("importJobs"), batchIndex: v.number(),
  createdIds: v.array(v.string()),
  updated: v.array(v.object({ id: v.string(), before: v.record(v.string(), v.any()) })),
  errors: v.array(v.object({ row: v.number(), message: v.string() })),
  createdAt,
}).index("by_job", ["jobId"]).index("by_organization", ["organizationId"]),
```

### 3.11 `files` (`:1303`)

```ts
files: defineTable({
  organizationId, storageId: v.string(), name, mimeType, size: v.number(),
  fileType: v.union(v.literal("message_attachment"), v.literal("contact_photo"),
    v.literal("member_avatar"), v.literal("lead_document"),
    v.literal("import_file"), v.literal("other")),
  messageId?, contactId?, leadId?, teamMemberId?,     // no máximo um setado
  uploadedBy: v.optional(v.id("teamMembers")),        // ausente em mídia inbound
  metadata?, createdAt,
})
  .index("by_organization", ["organizationId"])
  .index("by_organization_and_type", ["organizationId", "fileType"])
  .index("by_message", ["messageId"])
  // + by_storage_id (usado por lib/fileRefs.ts)
```

### 3.12 `activities` (`:735`)

`type` é union fechado: `note | call | email_sent | stage_change | assignment | handoff | qualification_update | created | message_sent | message_received | task_created | task_completed | event_created | event_completed`. `actorType: "human"|"ai"|"system"`. Índices: `by_lead`, `by_organization`, `by_lead_and_created`, `by_organization_and_created`. **`leadId` é obrigatório** — não há activity sem lead.

### 3.13 `auditLogs` (`:759`)

`entityType: v.string()` (livre), `entityId: v.string()`, `action: create|update|delete|move|assign|handoff`, `changes?: {before?, after?}`, `metadata?`, `description?`, `severity: low|medium|high|critical`, `ipAddress?`, `userAgent?`. Dez índices, incluindo `by_organization_and_entity_type_and_created`, `by_organization_and_action_and_created`, `by_organization_and_severity_and_created`.

### 3.14 `notifications` (`:942`)

```ts
type: v.union(v.literal("task_assigned"), v.literal("task_comment_mention"),
  v.literal("task_due_soon"), v.literal("task_overdue"),
  v.literal("handoff_requested"), v.literal("handoff_resolved"),
  v.literal("ai_draft_pending")),
```
Mais `memberId`, `title`, `body?`, ponteiros `taskId?`/`handoffId?`/`conversationId?`, `actorId?`, `readAt?`. Índices `by_member_and_created`, `by_member_and_read`, `by_organization`.

### 3.15 `savedViews` (`:1014`)

```ts
savedViews: defineTable({
  organizationId, createdBy: v.id("teamMembers"), name: v.string(),
  entityType: v.union(v.literal("leads"), v.literal("contacts"), v.literal("tasks")),
  isShared: v.boolean(),
  filters: savedViewFiltersValidator,
  sortBy?, sortOrder?, columns?: v.array(v.string()), createdAt, updatedAt,
}).index("by_organization", ["organizationId"])
  .index("by_organization_and_entity", ["organizationId", "entityType"]),
```

`savedViewFiltersValidator` (`schema.ts:9`): `boardId?`, `stageIds?: Id<"stages">[]`, `assignedTo?`, `priority?`, `temperature?`, `tags?: string[]`, `hasContact?`, `company?`, `minValue?`, `maxValue?`, `channel?`, mais os campos de tarefa (`statuses`, `priorities`, `taskType`, `activityType`, `projectId`, `labelIds`, `assigneeIds`, `dueFilter`).

### 3.16 `organizations.settings.aiConfig` (`schema.ts:138`)

```ts
const aiConfigValidator = v.object({
  enabled: v.boolean(),                       // DEFAULT FALSE
  autoAssign: v.boolean(),
  handoffThreshold: v.number(),
  lgpdAck: v.optional(v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers") })),
  copilotEnabled: v.optional(v.boolean()),    // undefined = ligado
  attendantEnabled: v.optional(v.boolean()),  // undefined = ligado
  bridgeAiAck: v.optional(v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers") })),
  visionEnabled: v.optional(v.boolean()),     // undefined = DESLIGADO (deliberado)
  providerConfig: v.optional(providerConfigValidator),
  monthlyConversationBudget: v.optional(v.number()),
});
```

`agentProfileValidator` (`schema.ts:~173`) em `teamMembers.agentProfile`: `kind: "copilot"|"attendant"`, `mode: "suggest"|"autopilot"`, `systemPrompt?`, `knowledge?`, `language?`, `channelConfigIds?`, `boardIds?`, `schedule?: {timezone, startHour, endHour, days?}`, `handoffKeywords?`, `maxRepliesPerConversation?`, `maxRepliesPerHour?`, `messageDebounceSeconds?`, `maxToolCallsPerRun?`, `model?`, `temperature?`, `disclosure?`, `pipelineConfig?: {boardId?, initialStageId?, advanceRules?, qualifiedStageId?, qualifyThreshold?, allowMoveStages?, captureFields?}`.

---

## 4. Scheduled messages

`convex/scheduledMessages.ts` — 205 linhas, o arquivo inteiro.

| Função | Tipo | Gate | Args |
|---|---|---|---|
| `schedule` | mutation | `inbox:reply` | `{conversationId, content, scheduledAt}` → `Id<"scheduledMessages">` |
| `listPending` | query | `inbox:view_own` | `{conversationId}` → `[{_id, content, scheduledAt, createdAt}]` |
| `cancel` | mutation | `inbox:reply` | `{scheduledMessageId}` |
| `deliver` | internalMutation | — | `{scheduledMessageId}` |

**`schedule`** (`:13`): valida conversa, `content.trim()` não vazio, `scheduledAt >= now + 30_000` ("Escolha um horário pelo menos 1 minuto no futuro"). Insere a row com `status: "pending"`, depois:
```ts
const fnId = await ctx.scheduler.runAt(args.scheduledAt, internal.scheduledMessages.deliver,
                                       { scheduledMessageId });
await ctx.db.patch(scheduledMessageId, { scheduledFunctionId: fnId as string });
```

**`cancel`** (`:87`): re-checa `status === "pending"`, chama `ctx.scheduler.cancel(row.scheduledFunctionId as Id<"_scheduled_functions">)` e patcha `status: "canceled"`.

**`deliver`** (`:105`): re-checa `status === "pending"` (idempotência). Se conversa ou autor sumiram → `status: "failed"` com erro. Senão insere a message com **`metadata: { scheduled: true }`** — é essa flag que ativa a humanização de typing no bridge (`computeTypingDelayMs`). Replica os side effects inteiros (patch conversa, patch lead, auditLog `severity: "low"` com `metadata.scheduled: true`, activity `"Mensagem agendada enviada via ${channel}"`, webhook `message.sent`) e chama `scheduleWhatsappDispatch`. Fecha com `patch({status: "sent", sentMessageId})`.

**Reaproveitamento como worker de campanha.** O *padrão* serve — row durável + `runAt` + id cancelável + re-check no delivery + status terminal. A *implementação* não:
- Um `_scheduled_functions` por mensagem: 5 mil destinatários = 5 mil scheduled functions.
- Só texto (`contentType` fixo em `"text"`, sem `attachments`, sem template).
- Presa a uma `conversationId` existente.
- Sem retry (falha é terminal), sem lote, sem progresso agregado, sem noção de campanha-pai.
- Sem interação com `channelPacing` além do que `scheduleWhatsappDispatch` já faz.

---

## 5. Gate do autopilot do Atendente IA

### 5.1 Onde está o gate

`convex/aiSettings.ts:636` — `updateAgentProfile({agentMemberId: v.id("teamMembers"), patch: agentProfilePatchValidator})`, `returns: v.null()`.

Auth: `const member = await requirePermission(ctx, agent.organizationId, "settings", "manage");`

```ts
// Personalização do perfil. Trocar para AUTOPILOT tem gate de métricas: só após
// >=10 sugestões revisadas com >=60% de aceitação (enforçado AQUI, no servidor).
if (args.patch.mode === "autopilot" && agent.agentProfile.mode !== "autopilot") {
  const metrics = await computeAcceptanceMetrics(ctx, agent.organizationId, agent._id);
  const enough = metrics.reviewed >= 10 && metrics.acceptanceRate >= 0.6;
  if (!enough) {
    throw new Error(
      `Autopilot exige pelo menos 10 sugestões revisadas com 60% de aceitação ` +
      `(hoje: ${metrics.reviewed} revisadas, ${Math.round(metrics.acceptanceRate * 100)}% aceitas)`
    );
  }
}
```

Campo no schema: `teamMembers.agentProfile.mode: v.union(v.literal("suggest"), v.literal("autopilot"))` — "Todo atendente começa em `suggest` (gera rascunho, não auto-envia)".

Validações adicionais no mesmo handler: tetos de resposta inteiros >= 0 (0 = sem limite), `messageDebounceSeconds` entre 1 e 120, e integridade do `pipelineConfig` (board da org, estágio inicial pertencente ao board).

### 5.2 Cálculo das métricas

`convex/aiSettings.ts:~755` — `computeAcceptanceMetrics(ctx, organizationId, agentMemberId?)`:
```ts
const runs = await ctx.db.query("agentRuns")
  .withIndex("by_organization_and_kind_and_started", (q) =>
    q.eq("organizationId", organizationId).eq("kind", "attendant"))
  .order("desc").take(300);
const relevant = agentMemberId ? runs.filter((r) => r.memberId === agentMemberId) : runs;

for (const run of relevant) {
  if (!run.resultMessageId) continue;
  if (run.humanInitiated) { coached++; continue; }   // coaching, não autonomia
  const message = await ctx.db.get(run.resultMessageId);
  const draft = message?.metadata?.aiDraft as { status?: string } | undefined;
  if (!draft) continue;
  if (draft.status === "pending") pending++;
  else if (draft.status === "sent") sent++;
  else if (draft.status === "sent_edited") sentEdited++;
  else if (draft.status === "discarded") discarded++;
  else if (draft.status === "revised") revised++;    // FORA de reviewed, de propósito
}
const reviewed = sent + sentEdited + discarded;
return { pending, sent, sentEdited, discarded, revised, coached, reviewed,
         acceptanceRate: reviewed > 0 ? (sent + sentEdited) / reviewed : 0 };
```

Duas exclusões deliberadas, documentadas em comentário:
- `run.humanInitiated` (requestAiDraft / returnToAi) → `coached`, "medem o COACHING, não a autonomia da IA".
- `draft.status === "revised"` → "instruir a IA não é rejeição — contar como descarte derrubaria a taxa e travaria o gate".

### 5.3 Query pública

`convex/aiSettings.ts:808`:
```ts
export const getAttendantMetrics = query({
  args: { organizationId: v.id("organizations"), agentMemberId: v.optional(v.id("teamMembers")) },
  returns: v.object({ pending: v.number(), sent: v.number(), sentEdited: v.number(),
    discarded: v.number(), revised: v.number(), coached: v.number(),
    reviewed: v.number(), acceptanceRate: v.number(), autopilotUnlocked: v.boolean() }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const metrics = await computeAcceptanceMetrics(ctx, args.organizationId, args.agentMemberId);
    return { ...metrics, autopilotUnlocked: metrics.reviewed >= 10 && metrics.acceptanceRate >= 0.6 };
  },
});
```
O limiar aparece **duplicado**: em `updateAgentProfile` e aqui.

### 5.4 UI

`src/components/settings/AiSection.tsx:1358-1390` — bloco "Métricas de aceitação + gate do autopilot". Enquanto travado mostra os números; quando `metrics.autopilotUnlocked` renderiza `<Button onClick={() => void handleModeToggle()}>Ativar autopilot</Button>`. `handleModeToggle` (`:1220-1235`):
```ts
const isAutopilot = profile.mode === "autopilot";
await updateAgentProfile({ agentMemberId, patch: { mode: isAutopilot ? "suggest" : "autopilot" } });
```
Aviso adicional quando `isAutopilot || autopilotUnlocked`: sugere definir horário de atendimento (`:1384-1390`).

### 5.5 Aceites de risco existentes — os dois modelos a copiar

**`lgpdAck`** — `aiConfig.lgpdAck?: {acceptedAt: number, acceptedBy: Id<"teamMembers">}`.

Mutation `setAiEnabled` (`aiSettings.ts:258`):
```ts
args: { organizationId, enabled: v.boolean(), lgpdAck: v.optional(v.boolean()) }
// Na PRIMEIRA ativação exige lgpdAck:true — registra quem aceitou e quando.
// Desligar nunca apaga o ack (histórico).
let lgpdAck = current.lgpdAck;
if (args.enabled && !lgpdAck) {
  if (args.lgpdAck !== true) throw new Error(...);
  lgpdAck = { acceptedAt: now, acceptedBy: member._id };
}
```
Runtime: `convex/lib/agentSecurity.ts:117`
```ts
export function orgAiActive(org: Doc<"organizations"> | null): boolean {
  const aiConfig = org?.settings.aiConfig;
  return !!aiConfig && aiConfig.enabled === true && aiConfig.lgpdAck !== undefined;
}
```
"Orgs legadas com enabled:true sem lgpdAck continuam DESLIGADAS."

UI: `AiSection.tsx:199` `needsLgpdAck = !status.lgpdAckDone`; `:843` `await setAiEnabled({organizationId, enabled: true, lgpdAck: true})`.

**`bridgeAiAck`** — o modelo mais completo. `convex/aiSettings.ts:197`:
```ts
export const setBridgeAiAck = mutation({
  args: { organizationId: v.id("organizations"), accept: v.boolean(),
          riskAck: v.optional(v.boolean()) },   // obrigatório true ao aceitar
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org?.settings.aiConfig) throw new Error("Ative a IA primeiro");
    const current = org.settings.aiConfig;
    if (args.accept) {
      if (args.riskAck !== true) throw new Error(
        "Para ativar a IA em canais não-oficiais, confirme que aceita o risco de banimento permanente do número");
      if (current.bridgeAiAck !== undefined) return null;      // idempotente
      await ctx.db.patch(args.organizationId, { settings: { ...org.settings,
        aiConfig: { ...current, bridgeAiAck: { acceptedAt: now, acceptedBy: member._id } } }, updatedAt: now });
    } else {
      if (current.bridgeAiAck === undefined) return null;
      const { bridgeAiAck: _removed, ...rest } = current;      // revogar REMOVE o objeto
      await ctx.db.patch(args.organizationId, { settings: { ...org.settings, aiConfig: rest }, updatedAt: now });
    }
    await ctx.db.insert("auditLogs", { ..., changes: {
        before: { bridgeAiAck: current.bridgeAiAck !== undefined },
        after:  { bridgeAiAck: args.accept } },
      metadata: { aiConfig: true, bridgeRisk: true },
      description: args.accept
        ? "Aceitou o risco de banimento e liberou o atendente IA em canais bridge (não-oficiais)"
        : "Revogou o aceite de risco — atendente IA bloqueado em canais bridge",
      severity: "high", createdAt: now });
    return null;
  },
});
```

Ponto de desenho importante: o ack é **condição de elegibilidade re-checada no commit transacional**, não só gate de enqueue — "revogação vale IMEDIATAMENTE até para runs em voo" (TOCTOU).

UI: `src/components/settings/AiSection.tsx:700-790`. `Switch` → se já aceito abre `showRevokeConfirm`, senão `showRiskModal` com banner `AlertTriangle` vermelho ("Aceito e reconheço que a API não-oficial viola os Termos do WhatsApp e pode causar banimento permanente do número, inclusive com uso de IA") + `<Checkbox label="Li e aceito o risco acima" />`; só com `riskChecked` o botão aceita, chamando `setBridgeAiAck({organizationId, accept: true, riskAck: true})`.

Status exposto por `getAiStatus` (`aiSettings.ts:30`): `lgpdAckDone: v.boolean()` (`:34`), `active: v.boolean()` (`:35`, = `enabled && lgpdAckDone`), `bridgeAiAckDone: v.boolean()` (`:43`).

### 5.6 As 10 condições de elegibilidade do atendente

`convex/attendant.ts:147` — `evaluateEligibility(input): {ok:true} | {ok:false, reason:string}`, pura e testável:

| # | Condição | `reason` |
|---|---|---|
| 1 | `orgAiActive(org)` | `ia_desativada` |
| 2 | `aiConfig.attendantEnabled !== false` | `atendente_desativado` |
| 3 | agente ativo, `type:"ai"`, `agentProfile.kind === "attendant"` | `sem_atendente` |
| 4 | `conversation.aiPausedUntil <= now` | `ia_pausada` |
| 5 | `lead.handoffState.status === "completed"` ou ausente | `handoff_pendente` |
| 6 | `lead.assignedTo` ausente ou === agente | `lead_de_humano` |
| 7 | `contact.aiOptOut !== true` | `opt_out` |
| 8 | `isWithinSchedule(profile.schedule, now)` | `fora_do_horario` |
| 9 | tetos (`maxRepliesPerConversation` default 20, `maxRepliesPerHour` default 10; 0 = sem limite) | `teto_conversa` / `teto_hora` |
| 10 | bridge exige `bridgeAiAck` vigente | `bridge_sem_aceite` |

Quando falha, `internalEnqueueFromInbound` (`attendant.ts:~435`) grava um item `status: "skipped"` com `error: reason` — "o skip deixa RASTRO … em vez do silêncio que parece bug".

---

## 6. Import

### 6.1 Fluxo

Upload padrão de `files` com `fileType: "import_file"` → `createImportJob` → `internalDetectHeaders` → `updateMapping` → `runPreview` → `internalRunDryRun` → `confirmImport` → `internalRunImport` → (opcional) `rollbackImport` → `internalRunRollback`.

### 6.2 Superfície pública — `convex/imports.ts`

Todas com `requirePermission(ctx, args.organizationId, "settings", "manage")`:

| Linha | Função | Args |
|---|---|---|
| `:494` | `createImportJob` | `{organizationId, entity: "contacts"\|"leads", fileId: Id<"files">, fileName, duplicateStrategy: "skip"\|"update"\|"create"}` → `Id<"importJobs">` |
| `:509` | `updateMapping` | `{organizationId, jobId, mapping: v.record(v.string(), v.string())}` |
| `:522` | `runPreview` | `{organizationId, jobId}` |
| `:531` | `confirmImport` | `{organizationId, jobId}` |
| `:540` | `rollbackImport` | `{organizationId, jobId}` |
| `:549` | `cancelImport` | `{organizationId, jobId}` — só em `mapping` ou `preview_ready` |
| `:572` | `getImportJobs` | query |
| `:585` | `getImportJob` | query |
| `:602` | `getFailedRowsCsv` | **action** (precisa ler storage) |

Internals notáveis: `internalCheckDuplicates` (`:773`), `internalListBatchIds` (`:809`), `internalPatchDetection` (`:823`), `internalPatchDryRun` (`:843`), `internalClaimImport` (`:855`), `internalFailJob` (`:866`), `internalFinishImport` (`:899`), `internalProcessBatch` (`:942`), `internalRollbackBatch` (`:1253`), `internalFinishRollback` (`:1322`).

### 6.3 Actions — `convex/importRun.ts` (310 linhas)

| Linha | Action | Guarda de idempotência |
|---|---|---|
| `:88` | `internalDetectHeaders({jobId})` | só roda em `status === "mapping"` |
| `:120` | `internalRunDryRun({jobId})` | só em `previewing` |
| `:224` | `internalRunImport({jobId})` | `internalClaimImport` (exatamente-uma-vez) |
| `:277` | `internalRunRollback({jobId})` | só em `completed` / `completed_with_errors` |

`RUN_DEADLINE_MS = 8 * 60 * 1000` (margem dentro do orçamento de 10min da action). Estourar → `"A importação excedeu o tempo limite de execução — divida o arquivo em partes menores."`

`DUP_CHECK_CHUNK = 100` — chaves por chamada da checagem de duplicatas do dry-run.

`readCsv(ctx, context)` (`:120` aprox.): `ctx.storage.get(storageId)` → `parseCsv(await blob.text())`; valida headers não vazios, `invalidHeader(header)` para cada um, linhas > 0, e `parsed.rows.length <= MAX_IMPORT_ROWS`.

Loop de execução (`:239`):
```ts
for (let start = 0; start < parsed.rows.length; start += IMPORT_BATCH_SIZE) {
  if (Date.now() > deadline) throw new Error(...);
  const rows = parsed.rows.slice(start, start + IMPORT_BATCH_SIZE).map((data, offset) => ({
    row: start + offset + 1,
    cells: parsed.headers.map((header) => data[header] ?? ""),
  }));
  const result = await ctx.runMutation(internal.imports.internalProcessBatch, {
    jobId, batchIndex: Math.floor(start / IMPORT_BATCH_SIZE), headers: parsed.headers, rows });
  if (!result.shouldContinue) return null;   // job cancelado/alterado no meio
}
await ctx.runMutation(internal.imports.internalFinishImport, { jobId });
```

### 6.4 Caps

| Constante | Valor |
|---|---|
| `MAX_IMPORT_ROWS` | 10 000 |
| `IMPORT_BATCH_SIZE` | 50 |
| `DRY_RUN_MAX_SAMPLE_ERRORS` | 50 |
| `DRY_RUN_MAX_PREVIEW_ROWS` | 10 |

Import inline via REST ≤ 5 MB, ou via `fileId`.

### 6.5 XLSX: NÃO SUPORTADO

`convex/lib/csv.ts` (273 linhas) é a referência única: parse RFC 4180, auto-detect de delimitador `,`/`;` (`detectDelimiter`, `:46`), BOM tolerado na leitura e sempre emitido na escrita (`CSV_BOM`, `:41`), `parseCsv` (`:177`), `formatCsvValue` (`:202`), `serializeCsv(headers, rows, {escapeFormulas?})` (`:252`).

XLSX aparece **só** na allowlist de mime de upload de documento (`convex/lib/fileValidation.ts:26`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, 20MB) — não há parser, e o import nunca aceita esse mime.

### 6.6 Mapeamento — `convex/lib/importMapping.ts` (845 linhas)

```ts
export type ImportEntity = "contacts" | "leads";
export const IGNORE_FIELD = "__ignore__";
export const CUSTOM_FIELD_PREFIX = "cf:";
export type ImportMapping = Record<string, string>;
```

Coerções puras: `normalizeLabel` (`:64`), `normalizePhone` (`:76`), `parseNumberValue` (`:83`), `parseBooleanValue` (`:122`), `parseDateValue` (`:130`), `unescapeFormulaPrefix` (`:182`), `splitList` (`:187`).

`listImportTargets` (`:514`), `filterFieldDefs` (`:521`), `suggestMapping(headers, entity, fieldDefs)` (`:579`), `coerceAndValidateRow(...)` (`:760`).

Aliases PT-BR/EN embutidos; custom fields `cf:<key>` validados contra `fieldDefinitions`.

### 6.7 Pegadinha das chaves

`convex/lib/importKeys.ts` (compartilhado entre backend, frontend e REST):
```ts
export function encodeHeaderKey(header: string): string   // = encodeURIComponent
export function invalidHeader(header: string): string | null
export function mappingForHeaders(headers, mapping): ...  // caminho de volta
```
Os records `mapping` e `suggestedMapping` são indexados pela chave **codificada** porque o Convex rejeita acento em nome de campo.

### 6.8 Rollback

`importJobBatches` guarda `createdIds: string[]` e `updated: [{id, before}]` (só os campos alterados; `null` = campo não existia antes). `internalRollbackBatch` deleta os criados e reverte os atualizados. Reaplicável.

### 6.9 Exceção deliberada ao checklist de side effects

Import e rollback **não** gravam activity/audit/webhook por linha (contato/lead) — só por transição de job. Justificativa registrada: 10 mil linhas seriam 10 mil schedulers. A trilha por registro fica em `importJobBatches`.

Webhooks emitidos: `import.completed`, `import.failed`, `import.rolled_back`.

### 6.10 UI

`src/components/settings/ImportWizard.tsx` — 5 passos, retoma pelo status do job. `FileDropZone.tsx` para upload. Ambos dentro de `src/components/settings/DataSection.tsx` (aba "Dados", deep-link `/app/configuracoes?secao=data`), tudo atrás de `settings:manage`.

### 6.11 Reaproveitamento para destinatários de campanha

O wizard resolve upload, detecção de headers, mapeamento com aliases, dry-run com preview e erros de amostra, execução em lotes e rollback. Mas está preso a duas entidades: `entity: v.union(v.literal("contacts"), v.literal("leads"))` no schema e no validator, e `internalProcessBatch` (`imports.ts:942`) faz switch explícito sobre elas, com `getLeadContext()` carregando boards/stages/sources/members sob demanda por lote.

---

## 7. Segmentação e filtros existentes

**O que existe é raso.**

### 7.1 `leads.getLeads` — `convex/leads.ts:21`

```ts
args: { organizationId: v.id("organizations"),
        boardId: v.optional(v.id("boards")),
        stageId: v.optional(v.id("stages")),
        assignedTo: v.optional(v.id("teamMembers")),
        limit: v.optional(v.number()),
        archivedOnly: v.optional(v.boolean()) }
returns: v.any()
```
Auth: `requireAuth` (qualquer membro da org). Escolhe **um** índice, nesta precedência: `stageId` → `by_organization_and_stage`; senão `assignedTo` → `by_organization_and_assigned`; senão `boardId` → `by_organization_and_board`; senão `by_organization`. Depois `.take(args.limit ?? 200)` e filtra `archivedAt` **em memória**. Enriquece com `contact`, `stage`, `assignee` via `batchGet`.

Sem filtro por tag, valor, temperatura, prioridade, data ou custom field no servidor. Sem paginação por cursor.

### 7.2 `contacts.getContacts` — `convex/contacts.ts:72`

```ts
args: { organizationId: v.id("organizations") }
```
Só isso. Busca é `contacts.searchContacts` (`:104`) via search index sobre `searchText`. `getContactWithLeads` (`:122`) devolve todos os leads do contato (incluindo arquivados) enriquecidos.

### 7.3 `savedViews` — `convex/savedViews.ts` (154 linhas)

Persiste filtros ricos (`savedViewFiltersValidator`, seção 3.15) mas o **backend não os aplica**. A filtragem acontece no cliente, sobre o resultado de `getLeads`. `entityType` é `"leads" | "contacts" | "tasks"`.

### 7.4 Etiquetas, tags e custom fields

- `conversationLabels` — org-scoped, atribuídas via `conversations.labelIds` (array, **sem índice**). Funções em `conversations.ts`: `listLabels` (`:630`), `createLabel` (`:650`), `deleteLabel` (`:678`), `toggleConversationLabel` (`:691`), `bulkApplyConversationLabel` (`:603`).
- `contacts.tags` e `leads.tags` — arrays de string, **sem índice**.
- Custom fields — `fieldDefinitions` (entity `lead`/`contact`) + `customFields: Record<string, any>` nas duas tabelas. Nenhum índice.

### 7.5 Bulk actions existentes (padrão de teto)

`convex/leads.ts`: `bulkMoveLeads` (`:1425`), `bulkAssignLeads` (`:1519`), `bulkAddTags` (`:1591`), `bulkRemoveTags` (`:1649`), `bulkArchiveLeads` (`:1708`), `bulkDeleteLeads` (`:372`, teto 100). `conversations.ts`: `bulkSetConversationsArchived` (`:579`), `bulkApplyConversationLabel` (`:603`).

---

## 8. RBAC — todos os pontos a tocar para uma categoria nova

`convex/lib/permissions.ts` (161 linhas) é a fonte única, importada tanto pelo backend quanto pelo frontend (`src/hooks/usePermissions.ts` importa de `../../convex/lib/permissions`).

Estado atual: 9 categorias (`leads`, `contacts`, `inbox`, `tasks`, `reports`, `team`, `settings`, `auditLogs`, `apiKeys`), 4 roles (`admin`, `manager`, `agent`, `ai`).

Hierarquias (`:43`):
```ts
const LEVEL_HIERARCHIES: Record<PermissionCategory, string[]> = {
  leads:     ["none","view_own","view_all","edit_own","edit_all","full"],
  contacts:  ["none","view","edit","full"],
  inbox:     ["none","view_own","view_all","reply","full"],
  tasks:     ["none","view_own","view_all","edit_own","edit_all","full"],
  reports:   ["none","view","full"],
  team:      ["none","view","manage"],
  settings:  ["none","view","manage"],
  auditLogs: ["none","view"],
  apiKeys:   ["none","view","manage"],
};
```

Enforcement:
```ts
// convex/lib/auth.ts:29
export async function requirePermission(ctx, organizationId, category: PermissionCategory,
                                        requiredLevel: string) {
  const member = await requireAuth(ctx, organizationId);
  const permissions = resolvePermissions(member.role as Role, member.permissions);
  if (!hasPermission(permissions, category, requiredLevel)) throw new Error("Permissão insuficiente");
  return member;
}
```
Para IA: `assertAgentCan(ctx, agentMemberId, category, level, entity?)` em `convex/lib/agentSecurity.ts:65` — mesma lógica sem sessão de auth, mais checagem de org da entidade.

### Checklist para adicionar `campaigns`

1. `convex/lib/permissions.ts:7` — union `PermissionCategory`.
2. `convex/lib/permissions.ts` — `export type CampaignsLevel = "none" | ... ;`
3. `convex/lib/permissions.ts:29` — interface `Permissions`.
4. `convex/lib/permissions.ts:43` — `LEVEL_HIERARCHIES` (array do menor ao maior nível).
5. `convex/lib/permissions.ts:57` — `DEFAULT_PERMISSIONS` nos **4** roles.
6. `convex/lib/permissions.ts:130` — `CATEGORY_LABELS` (rótulo PT-BR).
7. `convex/lib/permissions.ts:143` — `LEVEL_LABELS` se introduzir nível novo.
8. `convex/router.ts:141` — `ROUTE_PERMISSIONS`: uma entrada `"MÉTODO /caminho"` (caminho **registrado** em `http.route`, com `:id`, não o concreto) por rota nova, **e** chamar `requireRoutePermission(apiKeyRecord, "MÉTODO", "/caminho")` logo depois de `authenticateApiKey` em cada handler.
9. `convex/routerPermissions.test.ts` — o teste **lê o fonte de `router.ts`** (`parseRegisteredRoutes`, `:38`) e quebra se qualquer rota `/api/v1/*` não-OPTIONS estiver fora do mapa ou sem o gate. Também tem um literal `NO_PERMISSIONS: Permissions` (`:63`) que precisa da chave nova.
10. `src/components/team/PermissionsEditor.tsx:100` — itera `CATEGORY_LABELS`, então pega a categoria nova automaticamente.
11. `src/hooks/usePermissions.ts` e `src/components/guards/PermissionGate.tsx` — genéricos sobre `PermissionCategory`, não precisam de mudança.

### Enforcement REST

`convex/router.ts:107-140` — comentário normativo: o nível da rota **espelha** a função equivalente do app. Quando a função pública usa `requirePermission(cat, nível)`, a rota exige o mesmo par; quando usa só `requireAuth`, a rota exige o **menor** nível de leitura da categoria; rotas sem equivalente público (ingestão/enriquecimento) usam o nível de escrita.

```ts
export type RoutePermission = { [C in PermissionCategory]: { category: C; level: Permissions[C] } }[PermissionCategory];
export type RouteAccess = RoutePermission | "authenticated";
export const PERMISSION_DENIED_MESSAGE = "Permissão insuficiente";
export const ROUTE_PERMISSIONS: Record<string, RouteAccess> = { ... };   // :141

export function requireRoutePermission(auth: { permissions: Permissions },
                                       method: string, path: string): Response | null {   // :263
  const required = ROUTE_PERMISSIONS[routeKey(method, path)];
  if (required === "authenticated") return null;
  if (required && hasPermission(auth.permissions, required.category, required.level)) return null;
  return errorResponse(PERMISSION_DENIED_MESSAGE, 403);
}
```
Fail-closed: rota sem entrada no mapa → `required === undefined` → 403.

Rate limit por API key: 300 req/min (fixed window em `apiKeys.updateLastUsed`, 429).

---

## 9. Side effects padrão

### 9.1 Exemplo canônico

`convex/lib/outboundSideEffects.ts:18` (89 linhas, arquivo inteiro):

```ts
export async function applyOutboundMessageSideEffects(
  ctx: MutationCtx,
  args: { conversation: Doc<"conversations">; member: Doc<"teamMembers">;
          messageId: Id<"messages">; now: number; activityContent?: string }
): Promise<void> {
  const actorType = member.type === "ai" ? "ai" : "human";

  await ctx.db.patch(conversation._id, { lastMessageAt: now,
    messageCount: conversation.messageCount + 1, updatedAt: now });

  const lead = await ctx.db.get(conversation.leadId);
  if (lead) await ctx.db.patch(conversation.leadId, { lastActivityAt: now, updatedAt: now,
                                                      conversationStatus: "active" });

  await ctx.db.insert("auditLogs", { organizationId: conversation.organizationId,
    entityType: "message", entityId: messageId, action: "create",
    actorId: member._id, actorType,
    metadata: { conversationId: conversation._id, leadId: conversation.leadId },
    description: buildAuditDescription({ action: "create", entityType: "message",
      metadata: { conversationId: conversation._id, leadId: conversation.leadId } }),
    severity: "low", createdAt: now });

  await ctx.db.insert("activities", { organizationId: conversation.organizationId,
    leadId: conversation.leadId, type: "message_sent", actorId: member._id, actorType,
    content: args.activityContent ?? `Message forwarded via ${conversation.channel}`,
    metadata: { conversationId: conversation._id }, createdAt: now });

  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: conversation.organizationId, event: "message.sent",
    payload: { messageId, conversationId: conversation._id, leadId: conversation.leadId,
               channel: conversation.channel, senderType: actorType, senderId: member._id } });

  if (conversation.channel === "whatsapp") await scheduleWhatsappDispatch(ctx, conversation, messageId);
}
```

`buildAuditDescription({action, entityType, metadata})` vem de `convex/lib/auditDescription.ts` e gera a descrição PT-BR.

Outros exemplos completos: `leads.createLead` (`convex/leads.ts:105`), `leads.moveLeadToStage` (`:504`), `handoffs.createHandoffCore` (`convex/handoffs.ts`).

### 9.2 Webhooks — não há registry

`webhooks.events` é `v.array(v.string())` livre no schema (`:1291`). Não existe `WEBHOOK_EVENTS` nem constante equivalente — o grep não retorna nada.

`convex/webhookTrigger.ts:4` — `getMatchingWebhooks({organizationId, event})`:
```ts
return webhooks.filter((w) => w.isActive && w.events.some((e) => e === args.event || e === "*"));
```

`convex/nodeActions.ts:223` — `triggerWebhooks({organizationId, event: v.string(), payload: v.any()})`:
```ts
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 2000, 5000];
const body = JSON.stringify({ event: args.event, timestamp: Date.now(), data: args.payload });
const signature = `sha256=${hmacSha256(body, webhook.secret)}`;
// non-2xx conta como falha (não só throw)
```

Criação: `convex/webhooks.ts:33` `createWebhook({organizationId, name, url, events: v.array(v.string()), secret})` — auth ad-hoc, exige `userMember.role === "admin"` (não usa `requirePermission`).

A lista de eventos vive **duplicada em dois lugares de documentação**, ambos a atualizar ao criar evento novo:
- `convex/llmsTxt.ts:1438-1472` — tabela markdown de 28 eventos.
- `src/pages/DevelopersPage.tsx:1085-1115` — array de strings renderizado como chips.

O campo de eventos na UI de criação (`src/components/Settings.tsx:886`) é texto livre, placeholder `"lead.created, lead.stage_changed, message.sent"`.

Eventos documentados hoje: `lead.created`, `lead.updated`, `lead.deleted`, `lead.stage_changed`, `lead.assigned`, `contact.created`, `contact.updated`, `conversation.created`, `message.sent`, `message.received`, `handoff.requested`, `handoff.accepted`, `handoff.rejected`, `handoff.canceled`, `conversation.returned_to_ai`, `task.moved`, `task.due_soon`, `task_project.{created,updated,archived,deleted}`, `task_label.{created,updated,deleted}`, `export.{completed,failed}`, `import.{completed,failed,rolled_back}`.

### 9.3 Notificações in-app — `convex/lib/notify.ts` (95 linhas)

```ts
export type NotificationType = "task_assigned" | "task_comment_mention" | "task_due_soon"
  | "task_overdue" | "handoff_requested" | "handoff_resolved" | "ai_draft_pending";

const PREFERENCE_FLAG: Record<NotificationType, string> = {
  task_assigned: "taskAssigned", task_comment_mention: "taskCommentMention",
  task_due_soon: "taskDueSoon", task_overdue: "taskOverdue",
  handoff_requested: "handoffRequested", handoff_resolved: "handoffResolved",
  ai_draft_pending: "aiDraftPending",
};

export async function filterMembersOfOrg(ctx, organizationId, memberIds): Promise<Id<"teamMembers">[]>

export async function createNotification(ctx: MutationCtx, args: {
  organizationId; memberId; type: NotificationType; title: string; body?: string;
  taskId?; handoffId?; conversationId?; actorId?;
}): Promise<void>
```

Regras embutidas em `createNotification` (todas silenciosas, retornam sem erro):
- `if (args.actorId === args.memberId) return;` — nunca notifica o próprio ator.
- `if (!member || member.type !== "human") return;` — membros IA não têm feed.
- `if (member.organizationId !== args.organizationId) return;` — isolamento multi-tenant.
- Opt-out: sem linha em `notificationPreferences`, ou flag ausente → habilitado; `flag === false` → pula.

`filterMembersOfOrg` deve ser chamado **sempre** antes de notificar ids vindos do cliente — sem ele um usuário da Org A endereça um membro da Org B e vaza conteúdo por e-mail (que não passa pelo gate de `createNotification`).

Adicionar um tipo novo exige tocar: o union `NotificationType` (`notify.ts:4`), `PREFERENCE_FLAG` (`:16`), o union em `schema.ts:945`, e a tabela `notificationPreferences` (`schema.ts:1047`).

---

## 10. AI tools

### 10.1 Registry — `convex/lib/agentTools.ts` (499 linhas)

Registry **estático**. Cabeçalho é normativo: "Nada de resolução dinâmica por nome: os executores fazem switch explícito sobre estes nomes e injetam os IDs de escopo — o modelo NUNCA fornece esses IDs".

```ts
export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;          // JSON Schema visível ao modelo
  permission: { category: PermissionCategory; level: string };
  audience: "copilot" | "attendant" | "both";
  effect: "read" | "write" | "destructive";
  resultFields: string[];                       // whitelist de saída
}

export const INJECTED_PARAM_NAMES = ["organizationId", "teamMemberId", "agentMemberId",
                                     "conversationId", "leadId", "contactId"] as const;   // :31

function schema(properties, required) { return { type: "object", properties, required,
                                                 additionalProperties: false }; }
```

Arrays: `ATTENDANT_TOOLS` (`:48`), `COPILOT_READ_TOOLS`, `COPILOT_WRITE_TOOLS` (`:290`), unidos em `ALL_AGENT_TOOLS` (`:464`).

Exemplo de spec (`:49`):
```ts
{
  name: "replyToCustomer",
  description: "Envia (ou, em modo sugestão, rascunha) a resposta ao cliente desta conversa. Use uma única vez por turno, ao final.",
  parameters: schema({ text: { type: "string", description: "Texto da resposta em português (curto e direto)" } }, ["text"]),
  permission: { category: "inbox", level: "reply" },
  audience: "attendant",
  effect: "write",
  resultFields: ["status", "messageId", "mode"],
}
```

Helpers (`:470-499`):
```ts
export function toChatTools(specs: AgentToolSpec[]): {type:"function"; function:{name,description,parameters}}[]
export function projectToolResult(spec: AgentToolSpec, result: Record<string, unknown>): Record<string, unknown>
export function toolSpecByName(name: string): AgentToolSpec | undefined
```
`projectToolResult` é **obrigatório** em todo executor antes de devolver ao modelo.

Tools do atendente: escopadas ao atendimento em curso, "zero tools de listagem org-wide, zero destrutivas, zero settings/equipe/canais" — `replyToCustomer`, `moveThisLead`, `scheduleFollowUp`, `requestHandoff`, `updateThisLeadInfo`, etc.

### 10.2 Execução — `convex/copilot.ts` (1336 linhas)

Leitura (`:329`):
```ts
async function runReadTool(ctx: ReadCtx, name, toolArgs, organizationId) {
  switch (name) {
    case "getPipelineOverview": return await getPipelineOverview(ctx, organizationId, toolArgs);
    case "listLeads":           return await listLeadsTool(ctx, organizationId, toolArgs);
    case "getLeadDetail":       return await getLeadDetailTool(...);
    case "searchContacts":      return await searchContactsTool(...);
    case "getDashboardStats":   return await getDashboardStatsTool(ctx, organizationId);
    case "listTeamMembers":     return await listTeamMembersTool(ctx, organizationId);
    case "listBoardsAndStages": return await listBoardsAndStagesTool(ctx, organizationId);
    case "listQuickReplies":    return await listQuickRepliesTool(ctx, organizationId);
    case "listTasks":           return await listTasksTool(ctx, organizationId, toolArgs);
    default: return { error: `Tool não implementada: ${name}` };
  }
}
```
Wrapper (`:295-318`): `assertAgentCan(ctx, memberId, spec.permission.category, spec.permission.level)` → checa org → `JSON.parse(argsJson)` → `runReadTool` → `projectToolResult(spec, raw)`.

Escrita (`:767`): switch sobre `createLead`, `updateLead`, `moveLead`, `assignLead`, `createContact`, `createTask`, `createBoard`, `createFieldDefinition`, `createQuickReply`, `deleteLead`. Cada caso re-valida ids vindos do modelo (`getLeadInOrg` em `:759`, "id vem do modelo — camada 1 de novo aqui"). Auditoria com `metadata.via: "copilot"` e descrição sufixada `" (via Copiloto)"`.

Destrutivas → `pendingActions` (two-phase). `deleteLead` (`:1210`) só grava a proposta; a execução real é a mutation de confirmação (`:1288`).

Transporte: `convex/copilotHttp.ts`, rota SSE `/api/copilot/stream`. `buildSystemPrompt` está lá (ganhou seção FORMATO na v0.54).

### 10.3 `TOOL_DENYLIST` — `convex/lib/agentSecurity.ts:28`

```ts
export const TOOL_DENYLIST: readonly string[] = [
  "internalGetConfig",
  "internalGetBridgeCredentials",
  "decryptSecret",
  "internalGetDispatchContext",              // retorna o doc channelConfig cru
  "internalGetConfigByPhoneNumberId",
  "internalGetConfigByBridgeInstanceId",
  "internalGetActiveConfigByVerifyToken",
  "internalGetDefaultActiveConfig",
  "internalGetOrgSecretEncrypted",
];
export const SECRET_FIELD_PATTERN = /(Encrypted|token|secret|apiKey|verifyToken)/i;
```

As 4 camadas de defesa (cabeçalho do arquivo): (1) `assertAgentCan` — RBAC + org; (2) `assertRecordScope` (`:96`) — o atendente só opera sobre o lead/conversa/contato do gatilho; (3) denylist + regex validados em build; (4) envelope de dado não-confiável (`convex/lib/promptEnvelope.ts`).

Teste de build `convex/agentToolSecurity.test.ts` quebra se: um nome da denylist aparecer no registry, uma tool não declarar `resultFields`, um `resultField` casar `SECRET_FIELD_PATTERN`, ou `parameters` contiver um `INJECTED_PARAM_NAMES`.

### 10.4 MCP — servidor externo, não está neste repositório

O servidor é o pacote npm `hnbcrm-mcp` (`npx hnbcrm-mcp`), 46 tools, com env `HNBCRM_API_URL` + `HNBCRM_API_KEY`. Documentado em `convex/llmsTxt.ts:1166-1174` e `.claude/skills/hnbcrm/SKILL.md`. Ele consome a REST `/api/v1/*`.

Consequência: uma tool MCP nova = rota REST nova aqui **mais** release do pacote lá fora. Precedente registrado explicitamente em `SKILL.md:66`: as features P1 de tarefas (projetos, kanban, labels, multi-assignee) **não** foram expostas a MCP nem REST — "Project/label/multi-assignee management is app-UI only for now". O mesmo vale para o loop de coaching do atendente (só app UI).

---

## 11. Files e mídia

### 11.1 Upload — `convex/files.ts` (470 linhas)

```ts
export const generateUploadUrl = mutation({          // :24
  args: { organizationId: v.id("organizations") },
  returns: v.string(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "leads", "edit_own");
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveFile = mutation({                   // :43
  args: { organizationId, storageId: v.string(), name: v.string(), mimeType: v.string(),
          size: v.number(), fileType: v.union(...6 literais...),
          messageId?, contactId?, leadId?, teamMemberId?, metadata? },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "leads", "edit_own");
    validateFileUpload({ mimeType, size, name });
    await checkUploadQuota(ctx, { organizationId, fileSize: size });
    const fileId = await ctx.db.insert("files", { ..., uploadedBy: userMember._id, createdAt: Date.now() });
    await ctx.db.insert("auditLogs", { entityType: "file", action: "create",
      changes: { after: { name, size, fileType } },
      description: `Arquivo enviado: ${args.name}`, severity: "low", ... });
    return fileId;
  },
});
```

Outras: `getFileUrl` (`:129`), `deleteFile` (`:154`), `getLeadDocuments` (`:202`), `getFile` (`:269`), e as internals `internalGenerateUploadUrl` (`:325`), `internalSaveFile` (`:336`), `internalGetFileUrl` (`:412`), `internalDeleteFile` (`:429`).

### 11.2 Allowlist de mime — `convex/lib/fileValidation.ts`

```ts
export const ALLOWED_MIME_TYPES = {                                          // :7
  images:    { "image/jpeg","image/png","image/gif","image/webp" },          // 10MB
  documents: { "application/pdf","application/msword",".docx",".xls",".xlsx" }, // 20MB
  text:      { "text/plain","text/csv","application/json" },                 // 10MB
  audio:     { "audio/mpeg", ... },                                          // 10MB
};
export function validateMimeType(mimeType): boolean                          // :71
export function getMaxFileSize(mimeType): number | null                      // :79
export function getFileCategory(mimeType): "image"|"document"|"text"|"audio"|"other"  // :100
export const INBOUND_EXTRA_MIME_TYPES: readonly string[]                     // :117 — vídeo, codecs de celular, zip, slides
export function validateInboundMimeType(mimeType): boolean                   // :137
export function checkInboundMediaMimeType(mimeType): InboundMediaCheck       // :152 — DEVOLVE, não lança
export function validateFileUpload(args): void                               // :160 — LANÇA
```

A assimetria é deliberada: no upload humano a rejeição lança; na mídia inbound ela devolve `{ok:false, reason}` porque derrubar a mensagem do contato perderia o texto no inbox. `internalSaveInboundAttachment` (`convex/whatsapp.ts:1071`) aplica `checkInboundMediaMimeType` + `checkInboundMediaQuota`, marca `metadata.mediaSkipped` e apaga o blob já armazenado na hora.

### 11.3 Quotas — `convex/lib/fileQuotas.ts`

```ts
export const FILE_QUOTAS = {                          // :11
  free: { totalStorage: 1GB,  maxFileSize: 10MB, uploadsPerDay: 100 },
  pro:  { totalStorage: 10GB, maxFileSize: 20MB, uploadsPerDay: 1000 },
} as const;

function getOrganizationTier(_organizationId): "free" | "pro" { return "free"; }   // stub, TODO billing

async function readOrgUsage(ctx, organizationId) {     // :36
  const orgFiles = await ctx.db.query("files")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .collect();                                        // varredura COMPLETA da tabela
  ...
}
export async function checkUploadQuota(ctx, args)        // :57
export async function checkInboundMediaQuota(ctx, args)  // :103
export async function getStorageStats(ctx, ...)          // :134
```
Todas as orgs são `free` hoje. `readOrgUsage` faz `.collect()` da tabela `files` inteira da org **por upload** — não escala para volume de campanha.

### 11.4 Fluxo de anexo no inbox

Cliente: `generateUploadUrl` → `POST` no URL retornado → extrai `storageId` → `saveFile` → passa `attachments: [fileId]` para `sendMessage`, que faz `ctx.db.patch(fileId, {messageId})`.

- `src/components/Inbox.tsx:567-574` — `const attachments = stagedFiles.map(f => f.fileId)`; `contentType: attachments.length ? deriveContentType(stagedFiles) : "text"`.
- `src/components/inbox/VoiceRecorder.tsx:171-180` — grava, chama `generateUploadUrl` e `saveFile`.
- `src/components/LeadDetailPanel.tsx:600-605` — deriva `contentType` do mime do primeiro arquivo.

### 11.5 Blob compartilhado

`forwardMessage` (`conversations.ts:885`) **duplica a linha** de `files` com o mesmo `storageId` (porque `files.messageId` é 1:1 — re-apontar o original orfanaria a mensagem de origem). `convex/lib/fileRefs.ts` — `deleteBlobIfUnreferenced` condiciona **só** o `ctx.storage.delete` a não haver outra linha com aquele `storageId` (índice `by_storage_id`); na dúvida o blob fica. Usado por `files.deleteFile`, `files.internalDeleteFile` e a cascata de exclusão de lead.

Relevante para campanha: uma imagem enviada a N destinatários poderia compartilhar um blob, mas hoje exigiria N linhas de `files` (e N contagens na quota).

---

## 12. Padrão de teste

Runner: vitest + `convex-test`. `npm run test`. Arquivos `*.test.ts` em `convex/` (e desde a v0.54, `src/**/*.test.ts`).

### 12.1 Boilerplate — `convex/whatsappDispatch.test.ts:1-30`

```ts
/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { computeTypingDelayMs } from "./lib/whatsappDispatch";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));

beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function setup() { return convexTest(schema, modules); }
```

### 12.2 Seed de org + canal + conversa — `:32-100`

```ts
const APP_SECRET = "fake-app-secret-abcd";
const ACCESS_TOKEN = "EAAFakeAccessToken9876";
const PHONE_NUMBER_ID = "111000111000111";

async function seedFullPipeline(t: TestConvex<typeof schema>, opts: { withConfig?: boolean } = {}) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Test Org", slug: "test-org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now });
    const adminUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", { organizationId, userId: adminUserId, name: "Admin",
      role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now });
    const aiMemberId = await ctx.db.insert("teamMembers", { organizationId, name: "AI Agent",
      role: "ai", type: "ai", status: "active", createdAt: now, updatedAt: now });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Default",
      color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", { organizationId, boardId, name: "New",
      color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Maria",
      phone: "15550000001", whatsappNumber: "15550000001", tags: [], createdAt: now, updatedAt: now });
    const leadId = await ctx.db.insert("leads", { organizationId, title: "Maria", contactId,
      boardId, stageId, value: 0, currency: "BRL", priority: "medium", temperature: "cold",
      tags: [], customFields: {}, conversationStatus: "active",
      lastActivityAt: now, createdAt: now, updatedAt: now });
    return { organizationId, adminUserId, aiMemberId, boardId, stageId, contactId, leadId };
  });

  // O channelConfig é criado pela ACTION REAL, com identidade — exercita a criptografia.
  let configId: Id<"channelConfigs"> | undefined;
  if (opts.withConfig !== false) {
    const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
    configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
      organizationId: seeded.organizationId, channel: "whatsapp", displayName: "Main number",
      phoneNumberId: PHONE_NUMBER_ID, wabaId: "222000222000222",
      verifyToken: "test-verify-token", appSecret: APP_SECRET, accessToken: ACCESS_TOKEN });
  }

  const conversationId = await t.run(async (ctx) => ctx.db.insert("conversations", {
    organizationId: seeded.organizationId, leadId: seeded.leadId, channel: "whatsapp",
    ...(configId ? { channelConfigId: configId } : {}),
    status: "active", messageCount: 0, createdAt: Date.now(), updatedAt: Date.now() }));

  return { ...seeded, configId, conversationId };
}
```

### 12.3 Inspecionar o scheduler

```ts
async function getScheduledDispatches(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    return scheduled.filter((s) => s.name.includes("internalDispatchMessage"));
  });
}
```
Asserção de pacing (`:153-172`):
```ts
const dispatches = (await getScheduledDispatches(t)).sort((a,b) => a.scheduledTime - b.scheduledTime);
expect(dispatches[1].scheduledTime - dispatches[0].scheduledTime).toBeGreaterThanOrEqual(6000);
```

### 12.4 Mock de fetch

Meta (`:107`):
```ts
function graphOkMock(wamid = "wamid.SENT01") {
  return vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: wamid }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }));
}
const fetchMock = graphOkMock();
vi.stubGlobal("fetch", fetchMock);
```

Bridge (`convex/bridgeDispatch.test.ts:187`): `bridgeOkMock(id = "3EB0BRIDGE01")`, com asserções sobre a chamada:
```ts
expect(fetchMock).toHaveBeenCalledTimes(1);      // sem read-receipt no bridge
const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
// verifica path /chat/send/text, header `token`, corpo PascalCase
```
Falha de rede: `vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }))`.

### 12.5 Drenar jobs agendados

Padrão de `convex/leadDelete.test.ts` (registrado no CLAUDE.md): `vi.useFakeTimers()` + `t.finishAllScheduledFunctions(vi.runAllTimers)`. **Não** intercalar `finishInProgressScheduledFunctions` com `t.run`.

### 12.6 Testes-guarda que leem o fonte

Três testes lêem arquivos-fonte e quebram o build:
- `convex/routerPermissions.test.ts` — toda rota `/api/v1/*` precisa de entrada em `ROUTE_PERMISSIONS` **e** do gate no handler.
- `convex/agentToolSecurity.test.ts` — denylist + `resultFields` + `SECRET_FIELD_PATTERN` + params injetados.
- `convex/secretScan.test.ts` — quebra se um token real-parecido for commitado.
- `convex/exportSecurity.test.ts` — quebra se um segredo vazar no backup JSON.

### 12.7 Crons registrados — `convex/crons.ts` (17 linhas, 5 jobs)

```ts
crons.interval("process overdue reminders", { minutes: 5 }, internal.tasks.processOverdueReminders);
crons.interval("process recurring tasks", { hours: 1 }, internal.tasks.processRecurringTasks);
crons.daily("send daily digest", { hourUTC: 11, minuteUTC: 0 }, internal.email.sendDailyDigest);
crons.interval("mark abandoned form partials", { minutes: 10 }, internal.formPartials.internalMarkAbandoned);
crons.interval("cleanup expired exports", { hours: 1 }, internal.exports.internalCleanupExpired, {});
```

---

## Apêndice — lacunas que o desenho de campanha vai encontrar

1. **Zero infraestrutura de campanha.** Nenhuma tabela, worker, rota ou tela. O conceito de destinatário não existe fora de `(contact → lead → conversation)`.
2. **Templates da Meta são um esqueleto.** Só envio cru de `{name, languageCode, components: any[]}`. Sem listagem, sem status de aprovação, sem storage local, sem validação de variáveis, sem UI.
3. **Sem normalização E.164.** O único helper strippa não-dígitos. Sem código de país, sem 9º dígito brasileiro, sem validação.
4. **Sem verificação de existência do número no WhatsApp.** O `/user/check` do wuzapi não é usado.
5. **Sem caminho outbound que crie conversa para número desconhecido.** `createConversation` exige `leadId`; o único chamador usa `channel: "internal"`.
6. **Pacing existe e é bom, mas sem cap.** `channelPacing.dailyCount` é métrica sem enforcement. Não há warm-up de número novo nem teto diário.
7. **`savedViews` guarda filtros que o servidor não aplica.** `getLeads` filtra por um índice só; tags, valor, temperatura e custom fields não são filtráveis no servidor.
8. **Quota de arquivos faz `.collect()` da tabela inteira** a cada upload.
9. **`activities.leadId` é obrigatório** — não existe activity org-level, o que complica registrar eventos de campanha que não pertencem a um lead único.
10. **Webhooks não têm registry.** Evento novo exige editar duas listas de documentação manualmente.
11. **`scheduledMessages` é 1 scheduled function por mensagem**, só texto, sem retry.
12. **Os Termos de Uso do produto proíbem envio em massa não solicitado** (`src/pages/TermsPage.tsx:90`) — a cláusula precisará ser revista junto com a de `lgpdAck`.
