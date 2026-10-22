/**
 * Meta Messaging (Instagram + Facebook Messenger, API oficial) — handlers finos.
 *
 * F0.3: webhook (GET handshake + POST), ingest de TEXTO/placeholder, OAuth do
 * Facebook Login for Business, conexão/desconexão. F1: envio
 * (`internalDispatchMessage`, agendado só pela porta via `lib/metaDispatch.ts`),
 * eco (D6), entregue/lida. Lógica pura em `lib/metaMessagingParse.ts`,
 * `lib/metaOAuth.ts`, `lib/metaGraph.ts`, `lib/metaIdentity.ts`, `lib/metaSend.ts`.
 *
 * Invariantes: org derivada SEMPRE do config (índice por Página/conta IG);
 * assinatura verificada antes do parse; desconhecido/desativado = 200 e
 * descarta; token de Página só cifrado em `metaConnections`; token de usuário
 * nunca persistido; nada de PSID/IGSID/mid/token/texto completos em log.
 */
import { v, ConvexError } from "convex/values";
import {
  httpAction,
  action,
  query,
  mutation,
  internalAction,
  internalMutation,
  internalQuery,
  ActionCtx,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission, requireAccountWithEmail, isMembershipRevoked } from "./lib/auth";
import { hasPermission, resolvePermissions, Role } from "./lib/permissions";
import { assertModule, isDemoOrg, modulesOf } from "./lib/orgModules";
import { encryptSecret, decryptSecret, secretLast4 } from "./lib/secretCrypto";
import { appUrl } from "./lib/appUrl";
import { ensureLeadForContact } from "./lib/inboundRouting";
import { getLeadRef } from "./lib/leadRef";
import { resolveConversationChannelConfig } from "./lib/channelResolve";
import { claimChannelSlot } from "./lib/whatsappDispatch";
import { findMetaConversationForUser } from "./lib/metaDispatch";
import {
  CLEARED_LAST_MESSAGE_PATCH,
  findLastPreviewMessage,
  lastMessageFieldsPatch,
} from "./lib/conversationListFields";
import {
  OUTSIDE_WINDOW_COPY,
  buildTextPayload,
  classifyMetaError,
  last4,
  metaConversationWindow,
  parseHnbMetadata,
  splitMetaText,
  viaAppFor,
} from "./lib/metaSend";
import {
  MetaAttachment,
  MetaEvent,
  MetaSurface,
  isTestPayload,
  parseMetaMessagingWebhook,
  verifyMetaSignature,
} from "./lib/metaMessagingParse";
import { graphBase, profileEndpoint, sendEndpoint } from "./lib/metaGraph";
import {
  MetaOAuthErrorCode,
  UsablePage,
  buildAuthorizeUrl,
  missingScopes,
  pickUsablePages,
  redirectUrlFor,
} from "./lib/metaOAuth";
import { fallbackMetaName, findOrCreateContactByMetaIdentity, maskExternalId } from "./lib/metaIdentity";

// ── Constantes e validators ──

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const RETURN_PATH = "/app/configuracoes?secao=channels";
const SUBSCRIBED_FIELDS = [
  "messages",
  "message_echoes",
  "message_deliveries",
  "message_reads",
  "messaging_postbacks",
  "message_reactions",
  "message_edits",
  "messaging_referrals",
  "standby",
] as const;

const surfaceValidator = v.union(v.literal("messenger"), v.literal("instagram"));
const attachmentValidator = v.object({
  type: v.union(
    v.literal("image"),
    v.literal("video"),
    v.literal("audio"),
    v.literal("file"),
    v.literal("story_mention"),
    v.literal("ig_post"),
    v.literal("ig_reel"),
    v.literal("like_heart"),
    v.literal("sticker"),
    v.literal("fallback"),
    v.literal("other")
  ),
  url: v.optional(v.string()),
  mediaId: v.optional(v.string()),
  title: v.optional(v.string()),
  stickerId: v.optional(v.number()),
});
const referralValidator = v.object({
  source: v.optional(v.string()),
  type: v.optional(v.string()),
  ref: v.optional(v.string()),
  adId: v.optional(v.string()),
});
const common = { surface: surfaceValidator, accountId: v.string() };

export const metaEventValidator = v.union(
  v.object({
    ...common,
    kind: v.literal("message"),
    userId: v.string(),
    mid: v.string(),
    timestamp: v.number(),
    text: v.optional(v.string()),
    attachments: v.array(attachmentValidator),
    replyToMid: v.optional(v.string()),
    storyReply: v.optional(v.object({ url: v.optional(v.string()), id: v.optional(v.string()) })),
    quickReplyPayload: v.optional(v.string()),
    referral: v.optional(referralValidator),
    standby: v.optional(v.boolean()),
  }),
  v.object({
    ...common,
    kind: v.literal("echo"),
    userId: v.string(),
    mid: v.string(),
    timestamp: v.number(),
    appId: v.optional(v.string()),
    metadata: v.optional(v.string()),
    text: v.optional(v.string()),
    attachments: v.array(attachmentValidator),
  }),
  v.object({
    ...common,
    kind: v.literal("delivery"),
    userId: v.string(),
    mids: v.array(v.string()),
    watermark: v.number(),
  }),
  v.object({
    ...common,
    kind: v.literal("read"),
    userId: v.string(),
    watermark: v.optional(v.number()),
    mid: v.optional(v.string()),
  }),
  v.object({
    ...common,
    kind: v.literal("reaction"),
    userId: v.string(),
    mid: v.string(),
    action: v.union(v.literal("react"), v.literal("unreact")),
    reaction: v.optional(v.string()),
    emoji: v.optional(v.string()),
  }),
  v.object({
    ...common,
    kind: v.literal("postback"),
    userId: v.string(),
    mid: v.optional(v.string()),
    title: v.string(),
    payload: v.string(),
    timestamp: v.number(),
  }),
  v.object({
    ...common,
    kind: v.literal("referral"),
    userId: v.string(),
    referral: referralValidator,
    timestamp: v.number(),
  }),
  v.object({ ...common, kind: v.literal("deleted"), userId: v.string(), mid: v.string() }),
  v.object({
    ...common,
    kind: v.literal("edited"),
    userId: v.optional(v.string()),
    mid: v.string(),
    text: v.optional(v.string()),
  }),
  v.object({
    ...common,
    kind: v.literal("unsupported"),
    userId: v.string(),
    mid: v.string(),
    timestamp: v.number(),
  }),
  v.object({ ...common, kind: v.literal("unknown"), field: v.optional(v.string()) })
);

// ── Helpers ──

/** Comparação em tempo constante (tokens de handshake/assinatura). */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

const PLACEHOLDER_BY_TYPE: Record<MetaAttachment["type"], string> = {
  image: "[imagem]",
  video: "[vídeo]",
  audio: "[áudio]",
  file: "[arquivo]",
  story_mention: "[menção em story]",
  ig_post: "[post]",
  ig_reel: "[reel]",
  like_heart: "[curtiu]",
  sticker: "[sticker]",
  fallback: "[anexo]",
  other: "[anexo]",
};

type GraphResult = { ok: boolean; status: number; body: Record<string, unknown> };

/** GET/POST na Graph API. Nunca loga URL, corpo ou token. Token vai em header. */
async function graphCall(
  url: string,
  opts?: { token?: string; method?: "GET" | "POST"; timeoutMs?: number }
): Promise<GraphResult> {
  const res = await fetch(url, {
    method: opts?.method ?? "GET",
    headers: opts?.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 8000),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { ok: res.ok, status: res.status, body };
}

// ── Webhook ──

// GET /webhooks/meta-messaging — handshake do App Dashboard (token de plataforma).
export const webhookVerify = httpAction(async (_ctx, request) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = process.env.META_MESSAGING_WEBHOOK_VERIFY_TOKEN;
  if (expected && mode === "subscribe" && token && challenge && safeEqual(token, expected)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
});

// POST /webhooks/meta-messaging — object "page" (Messenger) e "instagram".
export const webhookReceive = httpAction(async (ctx, request) => {
  const rawBody = await request.text();

  // Assinatura ANTES de qualquer parse/roteamento.
  const appSecret = process.env.META_MESSAGING_APP_SECRET;
  if (!appSecret) return new Response("Unauthorized", { status: 401 });
  const valid = await verifyMetaSignature(rawBody, request.headers.get("X-Hub-Signature-256"), appSecret);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  // Daqui em diante: 200 SEMPRE (a Meta desliga o webhook após ~1 h de falhas).
  try {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("OK", { status: 200 });
    }
    if (isTestPayload(body)) return new Response("OK", { status: 200 });

    const { events } = parseMetaMessagingWebhook(body);
    // Uma consulta por conta distinta no lote.
    const routing = new Map<string, Id<"channelConfigs"> | null>();
    for (const event of events) {
      const key = `${event.surface}:${event.accountId}`;
      if (!routing.has(key)) {
        const config: Doc<"channelConfigs"> | null = await ctx.runQuery(
          internal.metaMessaging.internalGetConfigForMetaAccount,
          { surface: event.surface, accountId: event.accountId }
        );
        let routed: Id<"channelConfigs"> | null = null;
        if (config && config.status === "active") {
          const moduleOn: boolean = await ctx.runQuery(internal.metaMessaging.internalMetaModuleEnabled, {
            organizationId: config.organizationId,
          });
          if (moduleOn) routed = config._id;
        }
        routing.set(key, routed);
      }
      const configId = routing.get(key);
      if (!configId) continue; // desconhecida/desativada/módulo off: descarta sem vazar tenant
      // Eco do IG sem app_id: adia 3 s para a corrida com o POST de envio (D6, F1).
      const delay = event.kind === "echo" && event.surface === "instagram" && !event.appId ? 3000 : 0;
      await ctx.scheduler.runAfter(delay, internal.metaMessaging.internalIngestEvent, { configId, event });
    }
  } catch (e) {
    console.error(`meta-messaging webhook: ${e instanceof Error ? e.name : "erro"}`);
  }
  return new Response("OK", { status: 200 });
});

export const internalGetConfigForMetaAccount = internalQuery({
  args: { surface: surfaceValidator, accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const rows =
      args.surface === "messenger"
        ? await ctx.db
            .query("channelConfigs")
            .withIndex("by_messenger_page_id", (q) => q.eq("messengerPageId", args.accountId))
            .take(10)
        : await ctx.db
            .query("channelConfigs")
            .withIndex("by_instagram_account_id", (q) => q.eq("instagramAccountId", args.accountId))
            .take(10);
    // Defesa: se sobrou config velho (desativado) com o mesmo id, o ATIVO vence.
    if (rows.length > 1) {
      console.warn(`meta-messaging: ${rows.length} configs para a conta ${maskExternalId(args.accountId)}`);
    }
    return rows.find((c) => c.status === "active") ?? rows[0] ?? null;
  },
});

export const internalMetaModuleEnabled = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.boolean(),
  handler: async (ctx, args) => modulesOf(await ctx.db.get(args.organizationId)).metaMessaging,
});

export const internalGetMetaConnection = internalQuery({
  args: { connectionId: v.id("metaConnections") },
  returns: v.any(), // ciphertext incluso: só para actions
  handler: async (ctx, args) => await ctx.db.get(args.connectionId),
});

// ── Ingest ──

/**
 * Contato + lead do remetente (dentro de uma transação). `null` = canal
 * inativo/módulo off (defesa em profundidade além do webhook).
 */
export const internalRouteMetaInbound = internalMutation({
  args: {
    configId: v.id("channelConfigs"),
    surface: surfaceValidator,
    userId: v.string(),
    profile: v.optional(v.object({ name: v.optional(v.string()), username: v.optional(v.string()) })),
  },
  returns: v.union(
    v.null(),
    v.object({
      organizationId: v.id("organizations"),
      leadId: v.id("leads"),
      contactId: v.id("contacts"),
      needsProfile: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config || config.status !== "active" || config.channel !== args.surface) return null;
    const org = await ctx.db.get(config.organizationId);
    if (!modulesOf(org).metaMessaging) return null;

    const { contactId, identityId, created } = await findOrCreateContactByMetaIdentity(ctx, {
      organizationId: config.organizationId,
      channelConfigId: config._id,
      kind: args.surface,
      externalId: args.userId,
      username: args.profile?.username,
      name: args.profile?.name,
    });
    const contact = await ctx.db.get(contactId);
    const title = contact?.firstName || fallbackMetaName(args.surface, args.userId);
    const leadId = await ensureLeadForContact(ctx, {
      organizationId: config.organizationId,
      contactId,
      title,
    });

    // Perfil que chegou depois: o título do lead criado com o rótulo provisório acompanha.
    if (!created && contact?.firstName && args.profile?.name) {
      const lead = await ctx.db.get(leadId);
      if (lead && lead.title === fallbackMetaName(args.surface, args.userId)) {
        await ctx.db.patch(leadId, { title: contact.firstName, updatedAt: Date.now() });
      }
    }

    const identity = await ctx.db.get(identityId);
    return {
      organizationId: config.organizationId,
      leadId,
      contactId,
      needsProfile: identity?.profileFetchedAt === undefined,
    };
  },
});

async function fetchMetaProfile(
  conn: Doc<"metaConnections"> | null,
  surface: "messenger" | "instagram",
  userId: string
): Promise<{ name?: string; username?: string }> {
  if (!conn || conn.authState === "revoked" || !conn.tokenEncrypted) return {};
  try {
    const token = await decryptSecret(conn.tokenEncrypted);
    const url = profileEndpoint(
      { authMethod: conn.authMethod, surface, pageId: conn.pageId, igAccountId: conn.igAccountId },
      userId,
      surface
    );
    const res = await graphCall(url, { token, timeoutMs: 4000 });
    if (!res.ok) return {};
    const b = res.body;
    const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
    if (surface === "instagram") return { name: s(b.name), username: s(b.username) };
    const name = [s(b.first_name), s(b.last_name)].filter(Boolean).join(" ");
    return { name: name || undefined };
  } catch {
    return {}; // segue sem nome (§13 item 9)
  }
}

export const internalIngestEvent = internalAction({
  args: { configId: v.id("channelConfigs"), event: metaEventValidator },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const event: MetaEvent = args.event;
    const config: Doc<"channelConfigs"> | null = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: args.configId,
    });
    if (!config || config.status !== "active" || config.channel !== event.surface) return null;

    if (event.kind === "echo") {
      await handleEcho(ctx, config, event, 0);
      return null;
    }
    if (event.kind === "delivery" || event.kind === "read") {
      await handleReceipt(ctx, config, event);
      return null;
    }
    if (event.kind !== "message" && event.kind !== "unsupported") {
      // F2 (reação, edição, apagada, postback) trata; aqui só registro curto.
      console.log(`meta-messaging: ${event.kind} (${event.surface}) ignorado nesta fase`);
      return null;
    }

    // Idempotência: a Meta reenvia.
    const existing = await ctx.runQuery(internal.conversations.internalGetMessageByExternalId, {
      organizationId: config.organizationId,
      externalId: event.mid,
    });
    if (existing) return null;

    let content: string;
    const metadata: Record<string, unknown> = {};
    if (event.kind === "unsupported") {
      content = "[mensagem não suportada]";
      metadata.metaType = "unsupported";
    } else {
      const text = event.text?.trim() ?? "";
      const first = event.attachments[0];
      if (!text && !first) {
        console.log(`meta-messaging: mensagem vazia (${event.surface}) ignorada`);
        return null;
      }
      content = text || PLACEHOLDER_BY_TYPE[first.type];
      metadata.metaType = text ? "text" : first.type;
      if (event.attachments.length > 0) {
        // F2 baixa a mídia (as URLs da Meta expiram). Nada é baixado nesta fase.
        metadata.mediaPending = true;
        metadata.metaAttachments = event.attachments.slice(0, 10);
      }
      if (event.replyToMid) metadata.replyToMid = event.replyToMid;
      if (event.referral) metadata.referral = event.referral;
      if (event.storyReply) metadata.storyReply = event.storyReply;
      if (event.quickReplyPayload) metadata.quickReplyPayload = event.quickReplyPayload;
      if (event.standby) metadata.standby = true;
    }

    const routed = await ctx.runMutation(internal.metaMessaging.internalRouteMetaInbound, {
      configId: args.configId,
      surface: event.surface,
      userId: event.userId,
    });
    if (!routed) return null;

    if (routed.needsProfile && config.metaConnectionId) {
      const conn: Doc<"metaConnections"> | null = await ctx.runQuery(
        internal.metaMessaging.internalGetMetaConnection,
        { connectionId: config.metaConnectionId }
      );
      const profile = await fetchMetaProfile(conn, event.surface, event.userId);
      if (profile.name || profile.username) {
        await ctx.runMutation(internal.metaMessaging.internalRouteMetaInbound, {
          configId: args.configId,
          surface: event.surface,
          userId: event.userId,
          profile,
        });
      }
    }

    await ctx.runMutation(internal.conversations.internalReceiveMessage, {
      organizationId: routed.organizationId,
      leadId: routed.leadId,
      channel: event.surface,
      channelConfigId: args.configId,
      content,
      contentType: "text",
      externalId: event.mid,
      metadata,
    });
    return null;
  },
});

// ── Envio (F1, D4) ──

const OUTBOUND_MEDIA_COPY = "Mídia por Instagram/Messenger chega na próxima versão.";
const CHANNEL_DISABLED_COPY = "Canal desativado. Reative em Configurações > Canais.";
const RECONNECT_COPY = "Este canal precisa ser reconectado. Reconecte em Configurações > Canais.";
const NO_RECIPIENT_COPY = "Não encontramos o destinatário desta conversa neste canal.";
const MAX_META_DISPATCH_RETRIES = 5; // backoff 4^n: 1 s, 4 s, 16 s, 64 s, 256 s
const ECHO_RACE_WINDOW_MS = 60 * 1000;
// Timeout do POST da Send API. A reavaliação do eco do IG em corrida espera
// MAIS que isso: quando ela roda, o POST já voltou (com mid) ou já desistiu.
const META_SEND_TIMEOUT_MS = 12000;
const ECHO_RECONCILE_DELAY_MS = 15000;
// Reavaliações do eco em corrida antes de decidir "device" (1ª + UMA a mais).
const ECHO_MAX_RECONCILES = 2;
const NO_MID_NOTE = "Enviada, mas a Meta não devolveu o id da mensagem.";

/**
 * Tudo que o dispatcher precisa numa leitura. O destino é a identidade do
 * contato PARA O CONFIG DA CONVERSA (o mesmo contato pode ter PSID e IGSID em
 * configs diferentes). Ciphertext do token incluso: só para a action.
 */
export const internalGetMetaDispatchContext = internalQuery({
  args: { messageId: v.id("messages") },
  returns: v.union(
    v.null(),
    v.object({
      // Documentos inteiros (convex 1.31 não tem `schema.doc`); o resto é tipado.
      message: v.any(),
      conversation: v.any(),
      config: v.any(),
      connection: v.any(),
      surface: surfaceValidator,
      recipientId: v.union(v.string(), v.null()),
      replyToMid: v.union(v.string(), v.null()),
      demoMode: v.boolean(),
      openedByAd: v.boolean(),
      hasAttachments: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation || conversation.organizationId !== message.organizationId) return null;
    if (conversation.channel !== "instagram" && conversation.channel !== "messenger") return null;

    const config = await resolveConversationChannelConfig(ctx, conversation);
    const connection = config?.metaConnectionId ? await ctx.db.get(config.metaConnectionId) : null;

    let recipientId: string | null = null;
    const lead = await getLeadRef(ctx.db, conversation.leadId);
    const contactId = lead?.contactId;
    if (config && contactId) {
      const identities = await ctx.db
        .query("contactChannelIdentities")
        .withIndex("by_contact", (q) => q.eq("contactId", contactId))
        .take(50);
      recipientId =
        identities.find(
          (i) => i.channelConfigId === config._id && i.organizationId === conversation.organizationId
        )?.externalId ?? null;
    }

    const quoted = message.metadata?.quoted as { externalId?: unknown } | undefined;
    const replyToMid = typeof quoted?.externalId === "string" ? quoted.externalId : null;

    return {
      message,
      conversation,
      surface: conversation.channel,
      config,
      connection: connection && connection.organizationId === conversation.organizationId ? connection : null,
      recipientId,
      replyToMid,
      demoMode: await isDemoOrg(ctx, message.organizationId),
      openedByAd: conversation.windowOpenedByAdAt !== undefined,
      hasAttachments: (message.attachments?.length ?? 0) > 0,
    };
  },
});

export const internalDispatchMessage = internalAction({
  args: { messageId: v.id("messages") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      await dispatchMetaMessage(ctx, args.messageId);
    } catch (e) {
      // Rede de segurança (mesmo motivo do WhatsApp): exceção fora dos caminhos
      // tratados não pode deixar a mensagem sem status para sempre.
      console.error(`meta-messaging dispatch lançou: ${e instanceof Error ? e.name : "erro"}`);
      await ctx.runMutation(internal.metaMessaging.internalMarkDispatchFailed, {
        messageId: args.messageId,
        detail: "Falha inesperada no envio. Tente de novo.",
        onlyIfUndispatched: true,
      });
    }
    return null;
  },
});

/** Texto sem conteúdo real: vazio ou só o placeholder de mídia ("[imagem]"). */
function isPlaceholderText(text: string): boolean {
  return text.length === 0 || /^\[[^\]\n]{1,40}\]$/.test(text);
}

async function postSend(
  url: string,
  token: string,
  payload: unknown
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(META_SEND_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: {} }; // rede/timeout → transient
  }
}

function midOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const mid = (body as { message_id?: unknown }).message_id;
  return typeof mid === "string" && mid ? mid : null;
}

async function dispatchMetaMessage(ctx: ActionCtx, messageId: Id<"messages">): Promise<void> {
  const context = await ctx.runQuery(internal.metaMessaging.internalGetMetaDispatchContext, { messageId });
  if (!context) return;
  const message = context.message as Doc<"messages">;
  const conversation = context.conversation as Doc<"conversations">;
  const surface = context.surface as MetaSurface;
  const config = context.config as Doc<"channelConfigs"> | null;
  const connection = context.connection as Doc<"metaConnections"> | null;
  const recipientId = context.recipientId as string | null;
  const replyToMid = context.replyToMid as string | null;

  if (message.externalId || message.deliveryStatus) return; // já despachada

  const fail = async (detail: string, errorCode?: number) => {
    await ctx.runMutation(internal.metaMessaging.internalMarkDispatchFailed, {
      messageId,
      detail,
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
  };

  // Demonstração: nunca sai para a rede (mesmo gancho agnóstico do WhatsApp).
  if (context.demoMode === true) {
    await ctx.runMutation(internal.whatsapp.internalMarkDemoDelivered, { messageId });
    return;
  }
  if (!config || config.status !== "active") return await fail(CHANNEL_DISABLED_COPY);
  if (!connection || connection.authState !== "ok" || !connection.tokenEncrypted) {
    return await fail(RECONNECT_COPY);
  }
  if (!metaConversationWindow(surface, conversation, Date.now()).open) {
    return await fail(OUTSIDE_WINDOW_COPY);
  }
  if (!recipientId) return await fail(NO_RECIPIENT_COPY);

  const text = (message.content ?? "").trim();
  if (context.hasAttachments && isPlaceholderText(text)) return await fail(OUTBOUND_MEDIA_COPY);
  const parts = splitMetaText(text, surface);
  if (parts.length === 0) return await fail("Mensagem vazia.");

  const started: boolean = await ctx.runMutation(internal.metaMessaging.internalStampMetaDispatchStarted, {
    messageId,
  });
  if (!started) return;

  const token = await decryptSecret(connection.tokenEncrypted);
  const url = sendEndpoint({
    authMethod: connection.authMethod,
    surface,
    pageId: connection.pageId,
    igAccountId: connection.igAccountId,
  });
  // Texto com anexo: sai só o texto nesta fase (mídia de saída é F2).
  const note = context.hasAttachments ? `${OUTBOUND_MEDIA_COPY} Só o texto foi enviado.` : undefined;

  const mids: string[] = [];
  let acceptedWithoutMid = false;
  for (const part of parts) {
    const payload = buildTextPayload(surface, recipientId, part, {
      messageId,
      ...(replyToMid && mids.length === 0 && !acceptedWithoutMid ? { replyToMid } : {}),
    });
    const res = await postSend(url, token, payload);
    if (res.ok) {
      const mid = midOf(res.body);
      if (!mid) {
        // A Meta aceitou mas não devolveu o id: reenviar duplicaria.
        acceptedWithoutMid = true;
        continue;
      }
      mids.push(mid);
      // Instagram: registra o mid JÁ (antes do próximo POST), para o eco sem
      // `app_id` desta parte ser reconhecido mesmo com as demais em voo.
      if (surface === "instagram") {
        await ctx.runMutation(internal.metaMessaging.internalRecordMetaSentMid, { messageId, mid });
      }
      continue;
    }

    const cls = classifyMetaError(res.status, res.body);
    if (cls.kind === "token_invalid") {
      await ctx.runMutation(internal.metaMessaging.internalMarkConnectionReauthRequired, {
        connectionId: connection._id,
        detail: `Erro ${cls.code ?? 190} no envio`,
      });
    }
    if (mids.length > 0 || acceptedWithoutMid) {
      // Parte do texto já saiu: reenviar duplicaria. Registra o que saiu + o motivo.
      const partial = `Só ${mids.length} de ${parts.length} partes foram enviadas. ${cls.userMessage}`;
      if (mids.length > 0) {
        await ctx.runMutation(internal.metaMessaging.internalMarkMetaDispatched, { messageId, mids, note: partial });
      } else {
        await ctx.runMutation(internal.metaMessaging.internalMarkMetaSentWithoutMid, { messageId, note: partial });
      }
      return;
    }
    if (cls.kind === "rate_limited" || cls.kind === "transient") {
      const rescheduled: { retryInMs: number } | null = await ctx.runMutation(
        internal.metaMessaging.internalRescheduleMetaDispatch,
        { messageId, ...(cls.code !== undefined ? { errorCode: cls.code } : {}) }
      );
      if (rescheduled) return;
      return await fail(`${cls.userMessage} (tentativas esgotadas)`, cls.code);
    }
    return await fail(cls.userMessage, cls.code);
  }

  const finalNote = [note, acceptedWithoutMid ? NO_MID_NOTE : undefined].filter(Boolean).join(" ") || undefined;
  if (mids.length === 0) {
    await ctx.runMutation(internal.metaMessaging.internalMarkMetaSentWithoutMid, {
      messageId,
      note: finalNote ?? NO_MID_NOTE,
    });
    return;
  }
  await ctx.runMutation(internal.metaMessaging.internalMarkMetaDispatched, {
    messageId,
    mids,
    ...(finalNote ? { note: finalNote } : {}),
  });
}

async function recordSentMid(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  messageId: Id<"messages">,
  mid: string
): Promise<void> {
  const exists = await ctx.db
    .query("metaSentMids")
    .withIndex("by_organization_and_mid", (q) => q.eq("organizationId", organizationId).eq("mid", mid))
    .first();
  if (!exists) {
    await ctx.db.insert("metaSentMids", { organizationId, mid, messageId, createdAt: Date.now() });
  }
}

/** Instagram: mid de UMA parte, gravado assim que o POST dela volta (D6 camada a). */
export const internalRecordMetaSentMid = internalMutation({
  args: { messageId: v.id("messages"), mid: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
    await recordSentMid(ctx, message.organizationId, args.messageId, args.mid);
    return null;
  },
});

/**
 * 2xx sem `message_id`: a Meta aceitou, então NÃO reenvia (duplicaria). Fica
 * `sent` sem `externalId`, com a nota visível no metadata.
 */
export const internalMarkMetaSentWithoutMid = internalMutation({
  args: { messageId: v.id("messages"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.externalId) return null;
    if (message.deliveryStatus && message.deliveryStatus !== "failed") return null;
    await ctx.db.patch(args.messageId, {
      deliveryStatus: "sent",
      metadata: { ...(message.metadata ?? {}), dispatchNote: args.note },
    });
    return null;
  },
});

/** Carimba o início do envio (camada b do eco do IG). false = já despachada. */
export const internalStampMetaDispatchStarted = internalMutation({
  args: { messageId: v.id("messages") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.externalId || message.deliveryStatus) return false;
    await ctx.db.patch(args.messageId, {
      metadata: { ...(message.metadata ?? {}), metaDispatchStartedAt: Date.now() },
    });
    return true;
  },
});

/**
 * Envio aceito pela Meta: `externalId` = primeiro mid, `metaMids` quando o texto
 * saiu em partes, e `metaSentMids` (só Instagram: o eco pode vir sem `app_id`).
 * Nunca rebaixa um recibo que já chegou (delivery antes da resposta do POST).
 */
export const internalMarkMetaDispatched = internalMutation({
  args: { messageId: v.id("messages"), mids: v.array(v.string()), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || args.mids.length === 0) return null;
    const conversation = await ctx.db.get(message.conversationId);
    const metadata: Record<string, unknown> = { ...(message.metadata ?? {}) };
    if (args.mids.length > 1) metadata.metaMids = args.mids;
    if (args.note) metadata.dispatchNote = args.note;
    const keepStatus = message.deliveryStatus === "delivered" || message.deliveryStatus === "read";
    await ctx.db.patch(args.messageId, {
      externalId: message.externalId ?? args.mids[0],
      deliveryStatus: keepStatus ? message.deliveryStatus : "sent",
      metadata,
    });
    if (conversation?.channel === "instagram") {
      for (const mid of args.mids) {
        await recordSentMid(ctx, message.organizationId, args.messageId, mid);
      }
    }
    // D6 camada 3 (rede de segurança): o eco do IG sem `app_id` venceu a corrida
    // e virou mensagem "pelo aparelho" com um mid NOSSO. Apaga a duplicata.
    if (conversation) await removeDeviceDuplicates(ctx, conversation, args.messageId, args.mids);
    return null;
  },
});

async function removeDeviceDuplicates(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  messageId: Id<"messages">,
  mids: string[]
): Promise<void> {
  let removed = 0;
  let removedLast = false;
  for (const mid of mids) {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", conversation.organizationId).eq("externalId", mid)
      )
      .take(5);
    for (const dup of rows) {
      if (dup._id === messageId || dup.conversationId !== conversation._id) continue;
      if (dup.direction !== "outbound" || dup.metadata?.via !== "device") continue;
      if (dup.attachments && dup.attachments.length > 0) continue; // F1 não grava mídia em device; nunca apaga blob aqui
      await ctx.db.delete(dup._id);
      removed++;
      if (conversation.lastMessageId === dup._id) removedLast = true;
    }
  }
  if (removed === 0) return;
  console.log(`meta-messaging: ${removed} duplicata(s) de eco removida(s)`);
  let previewPatch = {};
  if (removedLast) {
    const { message } = await findLastPreviewMessage(ctx, conversation._id);
    previewPatch = message ? lastMessageFieldsPatch(message._id, message) : CLEARED_LAST_MESSAGE_PATCH;
  }
  await ctx.db.patch(conversation._id, {
    messageCount: Math.max(0, conversation.messageCount - removed),
    ...previewPatch,
  });
}

/**
 * Falha de envio Meta, visível no inbox (`deliveryStatus:"failed"` +
 * `metadata.deliveryError`, o mesmo campo do WhatsApp que o `MessageBubble`
 * mostra). Sem os ganchos de campanha/follow-up/boas-vindas do WhatsApp
 * (nenhum deles roda em Instagram/Messenger nesta fase). Substitui o
 * `internalMarkDispatchUnsupported` da F0.
 */
export const internalMarkDispatchFailed = internalMutation({
  args: {
    messageId: v.id("messages"),
    detail: v.string(),
    errorCode: v.optional(v.number()),
    onlyIfUndispatched: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
    // Nunca rebaixa o que já saiu (o eco pode ter ligado o mid antes).
    if (message.externalId) return null;
    if (args.onlyIfUndispatched && message.deliveryStatus) return null;
    await ctx.db.patch(args.messageId, {
      deliveryStatus: "failed",
      metadata: {
        ...(message.metadata ?? {}),
        deliveryError: args.detail,
        ...(args.errorCode !== undefined ? { deliveryErrorCode: args.errorCode } : {}),
      },
    });
    if (message.leadId) {
      await ctx.db.insert("activities", {
        organizationId: message.organizationId,
        leadId: message.leadId,
        type: "note",
        actorType: "system",
        content: `Falha ao enviar mensagem: ${args.detail}`,
        metadata: { conversationId: message.conversationId, messageId: args.messageId },
        createdAt: Date.now(),
      });
    }
    return null;
  },
});

/**
 * Reagenda após 613/4 (limite) ou falha transitória: backoff 4^n, até
 * `MAX_META_DISPATCH_RETRIES`, com novo slot no cursor do canal (no limite da
 * conta o floor empurra a fila toda). null = teto (o chamador marca failed).
 */
export const internalRescheduleMetaDispatch = internalMutation({
  args: { messageId: v.id("messages"), errorCode: v.optional(v.number()) },
  returns: v.union(v.object({ retryInMs: v.number() }), v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.externalId || message.deliveryStatus) return { retryInMs: 0 };
    const attempts = ((message.metadata?.dispatchAttempts as number | undefined) ?? 0) + 1;
    if (attempts > MAX_META_DISPATCH_RETRIES) return null;
    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation) return null;

    const now = Date.now();
    const backoffMs = Math.pow(4, attempts - 1) * 1000;
    await ctx.db.patch(args.messageId, {
      metadata: { ...(message.metadata ?? {}), dispatchAttempts: attempts },
    });
    const config = await resolveConversationChannelConfig(ctx, conversation);
    let slot = now + backoffMs;
    if (config) {
      slot = await claimChannelSlot(ctx, {
        config,
        conversation,
        earliestAt: now + backoffMs,
        now,
        ...(args.errorCode === 613 || args.errorCode === 4 ? { floorMs: now + backoffMs } : {}),
      });
    }
    await ctx.scheduler.runAfter(slot - now, internal.metaMessaging.internalDispatchMessage, {
      messageId: args.messageId,
    });
    return { retryInMs: slot - now };
  },
});

/**
 * Erro 190: a credencial morreu. Estado da CONEXÃO (derruba Messenger e IG da
 * Página juntos); o `status` dos configs não muda. Notificação é F4.
 */
export const internalMarkConnectionReauthRequired = internalMutation({
  args: { connectionId: v.id("metaConnections"), detail: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conn = await ctx.db.get(args.connectionId);
    if (!conn || conn.authState !== "ok") return null;
    const now = Date.now();
    await ctx.db.patch(conn._id, { authState: "reauth_required", authDetail: args.detail, updatedAt: now });
    await ctx.db.insert("auditLogs", {
      organizationId: conn.organizationId,
      entityType: "metaConnection",
      entityId: conn._id,
      action: "update",
      actorType: "system",
      changes: { before: { authState: "ok" }, after: { authState: "reauth_required" } },
      metadata: { fields: ["authState", "authDetail"], detail: args.detail },
      description: `A Página "${conn.pageName ?? ""}" (Instagram/Messenger) precisa ser reconectada`,
      severity: "high",
      createdAt: now,
    });
    return null;
  },
});

// ── Eco, entregue, lida (F1, D6, §4) ──

/**
 * Eco de mensagem NOSSA: já gravada por `externalId` ou `metaSentMids` → "ours";
 * `metadata` "hnb:<id>" de uma outbound desta org → liga o mid (se ainda não
 * tem `externalId`) e "ours". Senão "unknown".
 */
export const internalLinkEchoToMessage = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    mid: v.string(),
    metadata: v.optional(v.string()),
  },
  returns: v.union(v.literal("ours"), v.literal("unknown")),
  handler: async (ctx, args) => {
    const byExternal = await ctx.db
      .query("messages")
      .withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", args.organizationId).eq("externalId", args.mid)
      )
      .first();
    if (byExternal) return "ours";
    const sent = await ctx.db
      .query("metaSentMids")
      .withIndex("by_organization_and_mid", (q) => q.eq("organizationId", args.organizationId).eq("mid", args.mid))
      .first();
    if (sent) return "ours";
    const rawId = parseHnbMetadata(args.metadata);
    const id = rawId ? ctx.db.normalizeId("messages", rawId) : null;
    if (!id) return "unknown";
    const message = await ctx.db.get(id);
    if (!message || message.organizationId !== args.organizationId || message.direction !== "outbound") {
      return "unknown";
    }
    if (!message.externalId) {
      // O eco chegou antes da resposta do POST: liga já (o reagendamento e a
      // falha passam a ver a mensagem como enviada; nada de reenvio duplicado).
      await ctx.db.patch(message._id, {
        externalId: args.mid,
        ...(message.deliveryStatus === undefined || message.deliveryStatus === "failed"
          ? { deliveryStatus: "sent" as const }
          : {}),
      });
    }
    return "ours";
  },
});

/** Camada (b): há envio NOSSO em voo nesta conversa (carimbado há ≤ 60 s, sem mid)? */
export const internalHasMetaSendInFlight = internalQuery({
  args: { configId: v.id("channelConfigs"), userId: v.string(), now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) return false;
    const conversation = await findMetaConversationForUser(ctx, config, args.userId);
    if (!conversation) return false;
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
      .order("desc")
      .take(20);
    return recent.some((m) => {
      const started = m.metadata?.metaDispatchStartedAt;
      return (
        m.direction === "outbound" &&
        !m.externalId &&
        typeof started === "number" &&
        args.now - started <= ECHO_RACE_WINDOW_MS
      );
    });
  },
});

/** Conversa do cliente no config (recibos por watermark). */
export const internalFindMetaConversation = internalQuery({
  args: { configId: v.id("channelConfigs"), userId: v.string() },
  returns: v.union(v.id("conversations"), v.null()),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) return null;
    return (await findMetaConversationForUser(ctx, config, args.userId))?._id ?? null;
  },
});

/** Mensagem pelo mid (externalId, ou parte registrada em `metaSentMids`). */
export const internalFindMessageByMid = internalQuery({
  args: { organizationId: v.id("organizations"), mid: v.string() },
  returns: v.union(v.null(), v.object({ conversationId: v.id("conversations"), createdAt: v.number() })),
  handler: async (ctx, args) => {
    let message = await ctx.db
      .query("messages")
      .withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", args.organizationId).eq("externalId", args.mid)
      )
      .first();
    if (!message) {
      const sent = await ctx.db
        .query("metaSentMids")
        .withIndex("by_organization_and_mid", (q) => q.eq("organizationId", args.organizationId).eq("mid", args.mid))
        .first();
      message = sent ? await ctx.db.get(sent.messageId) : null;
    }
    if (!message || message.organizationId !== args.organizationId) return null;
    return { conversationId: message.conversationId, createdAt: message.createdAt };
  },
});

type EchoEvent = Extract<MetaEvent, { kind: "echo" }>;

/**
 * D6. Nosso `app_id` → no-op (liga o mid pelo "hnb:"). `app_id` de outro app
 * (Page Inbox/Business Suite) ou ausente no Messenger → mensagem enviada fora
 * do CRM (`via:"device"` + `viaApp`). Instagram sem `app_id`: (a) mid já
 * registrado → nosso; (b) envio nosso em voo → reavalia em 15 s (até 2 vezes);
 * (c) device. Se o eco ainda vencer, `internalMarkMetaDispatched` apaga a
 * duplicata (camada 3).
 */
async function handleEcho(
  ctx: ActionCtx,
  config: Doc<"channelConfigs">,
  event: EchoEvent,
  attempt: number // 0 = webhook; 1..ECHO_MAX_RECONCILES = reavaliações
): Promise<void> {
  const reconciled = attempt > 0;
  const ourAppId = process.env.META_MESSAGING_APP_ID;
  const isOurApp = !!event.appId && !!ourAppId && event.appId === ourAppId;
  if (!reconciled) {
    // Validação viva do §13 item 5: nunca o texto nem ids completos.
    console.log("meta echo", {
      surface: event.surface,
      hasAppId: !!event.appId,
      isOurApp,
      hasMetadata: !!event.metadata,
      midLast4: last4(event.mid),
    });
  }

  const link: "ours" | "unknown" = await ctx.runMutation(internal.metaMessaging.internalLinkEchoToMessage, {
    organizationId: config.organizationId,
    mid: event.mid,
    ...(event.metadata ? { metadata: event.metadata } : {}),
  });
  if (isOurApp || link === "ours") return;

  if (event.surface === "instagram" && !event.appId && attempt < ECHO_MAX_RECONCILES) {
    const inFlight: boolean = await ctx.runQuery(internal.metaMessaging.internalHasMetaSendInFlight, {
      configId: config._id,
      userId: event.userId,
      now: Date.now(),
    });
    if (inFlight) {
      await ctx.scheduler.runAfter(ECHO_RECONCILE_DELAY_MS, internal.metaMessaging.internalReconcileEcho, {
        configId: config._id,
        event,
        attempt: attempt + 1,
      });
      return;
    }
  }

  // Enviada por alguém fora do CRM (Business Suite, app do celular, outro app).
  const text = event.text?.trim() ?? "";
  const first = event.attachments[0];
  if (!text && !first) return;
  const routed = await ctx.runMutation(internal.metaMessaging.internalRouteMetaInbound, {
    configId: config._id,
    surface: event.surface,
    userId: event.userId,
  });
  if (!routed) return;
  await ctx.runMutation(internal.conversations.internalReceiveDeviceMessage, {
    organizationId: routed.organizationId,
    leadId: routed.leadId,
    channel: event.surface,
    channelConfigId: config._id,
    content: text || PLACEHOLDER_BY_TYPE[first.type],
    contentType: "text",
    externalId: event.mid,
    sentAt: event.timestamp,
    metadata: {
      viaApp: viaAppFor(event.appId),
      metaType: text ? "text" : first.type,
      ...(event.attachments.length > 0
        ? { mediaPending: true, metaAttachments: event.attachments.slice(0, 10) }
        : {}),
    },
  });
}

/** Segunda passada do eco do IG em corrida (camada b): reavalia (a) e decide. */
export const internalReconcileEcho = internalAction({
  args: { configId: v.id("channelConfigs"), event: metaEventValidator, attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (args.event.kind !== "echo") return null;
    const config: Doc<"channelConfigs"> | null = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: args.configId,
    });
    if (!config || config.status !== "active" || config.channel !== args.event.surface) return null;
    await handleEcho(ctx, config, args.event, Math.max(1, Math.min(args.attempt ?? 1, ECHO_MAX_RECONCILES)));
    return null;
  },
});

/** delivery (Messenger: mids + watermark) e read (Messenger: watermark; IG: mid). */
async function handleReceipt(
  ctx: ActionCtx,
  config: Doc<"channelConfigs">,
  event: Extract<MetaEvent, { kind: "delivery" | "read" }>
): Promise<void> {
  const markUpTo = async (
    conversationId: Id<"conversations">,
    watermark: number,
    status: "delivered" | "read"
  ) => {
    await ctx.runMutation(internal.conversations.internalMarkDeliveredUpToWatermark, {
      conversationId,
      watermark,
      status,
    });
  };
  const conversationOfUser = async (): Promise<Id<"conversations"> | null> =>
    await ctx.runQuery(internal.metaMessaging.internalFindMetaConversation, {
      configId: config._id,
      userId: event.userId,
    });

  if (event.kind === "delivery") {
    for (const mid of event.mids.slice(0, 50)) {
      await ctx.runMutation(internal.conversations.internalUpdateDeliveryStatus, {
        organizationId: config.organizationId,
        externalId: mid,
        status: "delivered",
      });
    }
    const conversationId = await conversationOfUser();
    if (conversationId) await markUpTo(conversationId, event.watermark, "delivered");
    return;
  }
  if (event.mid) {
    const target: { conversationId: Id<"conversations">; createdAt: number } | null = await ctx.runQuery(
      internal.metaMessaging.internalFindMessageByMid,
      { organizationId: config.organizationId, mid: event.mid }
    );
    if (target) await markUpTo(target.conversationId, target.createdAt, "read");
    return;
  }
  if (event.watermark !== undefined) {
    const conversationId = await conversationOfUser();
    if (conversationId) await markUpTo(conversationId, event.watermark, "read");
  }
}

// ── OAuth: autorização e state ──

/** Guardas das portas de conexão: permissão, conta com e-mail, módulo ligado. */
export const internalAuthorizeMetaConnect = internalQuery({
  args: { organizationId: v.id("organizations"), connectionId: v.optional(v.id("metaConnections")) },
  returns: v.object({ memberId: v.id("teamMembers") }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    await requireAccountWithEmail(ctx);
    await assertModule(ctx, args.organizationId, "metaMessaging");
    if (args.connectionId) {
      const conn = await ctx.db.get(args.connectionId);
      if (!conn || conn.organizationId !== args.organizationId) {
        throw new ConvexError("Conexão não encontrada.");
      }
    }
    return { memberId: member._id };
  },
});

export const internalCreateOAuthState = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    nonceHash: v.string(),
    connectionId: v.optional(v.id("metaConnections")),
  },
  returns: v.id("oauthStates"),
  handler: async (ctx, args) => {
    const now = Date.now();
    // Limpeza oportunista (sem cron na F0): states e seleções vencidos.
    const staleStates = await ctx.db
      .query("oauthStates")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const s of staleStates) await ctx.db.delete(s._id);
    const stalePending = await ctx.db
      .query("metaOAuthPending")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const p of stalePending) await ctx.db.delete(p._id);

    return await ctx.db.insert("oauthStates", {
      organizationId: args.organizationId,
      memberId: args.memberId,
      provider: "meta",
      nonceHash: args.nonceHash,
      ...(args.connectionId ? { connectionId: args.connectionId } : {}),
      returnPath: RETURN_PATH,
      expiresAt: now + OAUTH_STATE_TTL_MS,
      createdAt: now,
    });
  },
});

/** Single-use: existe, não usado, não expirado; marca `usedAt` na MESMA transação. */
export const internalConsumeOAuthState = internalMutation({
  args: { nonceHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      stateId: v.id("oauthStates"),
      organizationId: v.id("organizations"),
      memberId: v.id("teamMembers"),
      connectionId: v.optional(v.id("metaConnections")),
    })
  ),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("oauthStates")
      .withIndex("by_nonce_hash", (q) => q.eq("nonceHash", args.nonceHash))
      .first();
    const now = Date.now();
    if (!state || state.provider !== "meta" || state.usedAt !== undefined || state.expiresAt <= now) {
      return null;
    }
    await ctx.db.patch(state._id, { usedAt: now });
    return {
      stateId: state._id,
      organizationId: state.organizationId,
      memberId: state.memberId,
      ...(state.connectionId ? { connectionId: state.connectionId } : {}),
    };
  },
});

/** Rechecagem do callback: o membro segue ativo, com settings:manage, e o módulo está on. */
export const internalRecheckOAuthMember = internalQuery({
  args: { organizationId: v.id("organizations"), memberId: v.id("teamMembers") },
  returns: v.union(v.literal("ok"), v.literal("sem_papel"), v.literal("modulo_off")),
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.memberId);
    if (!member || member.organizationId !== args.organizationId || isMembershipRevoked(member)) {
      return "sem_papel" as const;
    }
    const permissions = resolvePermissions(member.role as Role, member.permissions ?? undefined);
    if (!hasPermission(permissions, "settings", "manage")) return "sem_papel" as const;
    if (!modulesOf(await ctx.db.get(args.organizationId)).metaMessaging) return "modulo_off" as const;
    return "ok" as const;
  },
});

export const startMetaConnect = action({
  args: { organizationId: v.id("organizations"), connectionId: v.optional(v.id("metaConnections")) },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const { memberId }: { memberId: Id<"teamMembers"> } = await ctx.runQuery(
      internal.metaMessaging.internalAuthorizeMetaConnect,
      { organizationId: args.organizationId, connectionId: args.connectionId }
    );
    const appId = process.env.META_MESSAGING_APP_ID;
    const configId = process.env.META_MESSAGING_LOGIN_CONFIG_ID;
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!appId || !configId || !siteUrl) {
      throw new ConvexError("Instagram/Messenger não está configurado neste ambiente.");
    }
    const nonce = randomNonce();
    await ctx.runMutation(internal.metaMessaging.internalCreateOAuthState, {
      organizationId: args.organizationId,
      memberId,
      nonceHash: await sha256Hex(nonce),
      connectionId: args.connectionId,
    });
    return {
      url: buildAuthorizeUrl({
        appId,
        redirectUri: `${siteUrl.replace(/\/+$/, "")}/oauth/meta/callback`,
        configId,
        state: nonce,
      }),
    };
  },
});

// ── OAuth: callback ──

type FinalizeResult =
  | { ok: true; configIds: Id<"channelConfigs">[] }
  | { ok: false; code: MetaOAuthErrorCode; configIds?: Id<"channelConfigs">[] };

/** Por Página: debug_token → subscribed_apps → conexão cifrada → configs. */
async function finalizeConnection(
  ctx: {
    runQuery: (...a: any[]) => Promise<any>;
    runMutation: (...a: any[]) => Promise<any>;
  },
  args: {
    organizationId: Id<"organizations">;
    memberId: Id<"teamMembers">;
    connectionId?: Id<"metaConnections">;
    page: UsablePage;
    messenger: boolean;
    instagram: boolean;
    scopes: string[];
  }
): Promise<FinalizeResult> {
  const { page } = args;
  const igAccountId = args.instagram ? page.igAccountId : undefined;

  // Exclusividade ANTES de tocar na Meta (não reinscrever Página de outra org).
  const blocked: MetaOAuthErrorCode | null = await ctx.runQuery(internal.metaMessaging.internalCheckMetaAccountFree, {
    organizationId: args.organizationId,
    connectionId: args.connectionId,
    pageId: page.pageId,
    igAccountId,
  });
  if (blocked) return { ok: false, code: blocked };

  const base = graphBase("facebook_login");
  const appId = process.env.META_MESSAGING_APP_ID;
  const appSecret = process.env.META_MESSAGING_APP_SECRET;

  let scopes = args.scopes;
  let dataAccessExpiresAt: number | undefined;
  if (appId && appSecret) {
    try {
      const url = `${base}/debug_token?input_token=${encodeURIComponent(page.pageToken)}&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`;
      const dbg = await graphCall(url, { timeoutMs: 6000 });
      const data = dbg.ok && dbg.body.data && typeof dbg.body.data === "object" ? (dbg.body.data as Record<string, unknown>) : null;
      if (data) {
        if (Array.isArray(data.scopes)) scopes = data.scopes.filter((s): s is string => typeof s === "string");
        const exp = data.data_access_expires_at;
        if (typeof exp === "number" && exp > 0) dataAccessExpiresAt = exp * 1000;
      }
    } catch {
      // debug_token é informativo: falha não bloqueia a conexão
    }
  }

  let subscribedAt: number | undefined;
  try {
    const sub = await graphCall(
      `${base}/${encodeURIComponent(page.pageId)}/subscribed_apps?subscribed_fields=${SUBSCRIBED_FIELDS.join(",")}`,
      { token: page.pageToken, method: "POST" }
    );
    if (sub.ok && sub.body.success === true) subscribedAt = Date.now();
  } catch {
    // grava a conexão sem `subscribedAt`; a UI oferece "Concluir conexão" (F4)
  }

  const upsert: { ok: true; connectionId: Id<"metaConnections"> } | { ok: false; code: MetaOAuthErrorCode } =
    await ctx.runMutation(internal.metaMessaging.internalUpsertMetaConnection, {
      organizationId: args.organizationId,
      memberId: args.memberId,
      connectionId: args.connectionId,
      pageId: page.pageId,
      pageName: page.pageName,
      igAccountId,
      igUsername: igAccountId ? page.igUsername : undefined,
      tokenEncrypted: await encryptSecret(page.pageToken),
      tokenLast4: secretLast4(page.pageToken),
      scopes,
      dataAccessExpiresAt,
      subscribedAt,
      subscribedFields: subscribedAt ? [...SUBSCRIBED_FIELDS] : undefined,
    });
  if (!upsert.ok) return { ok: false, code: upsert.code };

  const configIds: Id<"channelConfigs">[] = await ctx.runMutation(
    internal.metaMessaging.internalUpsertMetaChannelConfigs,
    {
      organizationId: args.organizationId,
      memberId: args.memberId,
      connectionId: upsert.connectionId,
      messenger: args.messenger,
      instagram: args.instagram && !!igAccountId,
    }
  );
  return { ok: true, configIds };
}

export const oauthCallback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const to = (r: Parameters<typeof redirectUrlFor>[1]) => redirect(redirectUrlFor(appUrl(), r));

  if (url.searchParams.get("error")) return to("cancelado");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) return to("expirado");

  const consumed = await ctx.runMutation(internal.metaMessaging.internalConsumeOAuthState, {
    nonceHash: await sha256Hex(state),
  });
  if (!consumed) return to("expirado");

  const recheck = await ctx.runQuery(internal.metaMessaging.internalRecheckOAuthMember, {
    organizationId: consumed.organizationId,
    memberId: consumed.memberId,
  });
  if (recheck !== "ok") return to(recheck);

  const appId = process.env.META_MESSAGING_APP_ID;
  const appSecret = process.env.META_MESSAGING_APP_SECRET;
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (!appId || !appSecret || !siteUrl) return to("falha_meta");
  const redirectUri = `${siteUrl.replace(/\/+$/, "")}/oauth/meta/callback`;
  const base = graphBase("facebook_login");

  try {
    // 3. code → token de usuário curto
    const short = await graphCall(
      `${base}/oauth/access_token?${new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, client_secret: appSecret, code })}`
    );
    const shortToken = short.ok ? short.body.access_token : undefined;
    if (typeof shortToken !== "string") return to("falha_meta");

    // 4. → token de usuário longo (necessário para o token de Página não expirar)
    const long = await graphCall(
      `${base}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken })}`
    );
    const userToken = long.ok ? long.body.access_token : undefined;
    if (typeof userToken !== "string") return to("falha_meta");

    // 5. permissões: as 8 ou nenhuma
    const perms = await graphCall(`${base}/me/permissions`, { token: userToken });
    if (!perms.ok || !Array.isArray(perms.body.data)) return to("falha_meta");
    const granted = (perms.body.data as Array<Record<string, unknown>>)
      .filter((p) => p && p.status === "granted" && typeof p.permission === "string")
      .map((p) => p.permission as string);
    if (missingScopes(granted).length > 0) return to("sem_permissao");

    // 6. Páginas (o token de usuário morre aqui, nunca é persistido)
    const accountsRes = await graphCall(
      `${base}/me/accounts?${new URLSearchParams({
        fields: "id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}",
        limit: "100",
      })}`,
      { token: userToken }
    );
    if (!accountsRes.ok) return to("falha_meta");
    let pages = pickUsablePages(accountsRes.body.data);
    if (consumed.connectionId) {
      // Reconectar: a Página devolvida tem de ser a mesma da conexão.
      const conn: Doc<"metaConnections"> | null = await ctx.runQuery(internal.metaMessaging.internalGetMetaConnection, {
        connectionId: consumed.connectionId,
      });
      pages = pages.filter((p) => p.pageId === conn?.pageId);
    }
    if (pages.length === 0) return to("sem_pagina");
    const usable = pages.filter((p) => p.tasksOk);
    if (usable.length === 0) return to("sem_papel");

    const scopes = granted;
    if (pages.length === 1) {
      const result = await finalizeConnection(ctx, {
        organizationId: consumed.organizationId,
        memberId: consumed.memberId,
        connectionId: consumed.connectionId,
        page: pages[0],
        messenger: true,
        instagram: true,
        scopes,
      });
      return to(result.ok ? "ok" : result.code);
    }

    // 7. N Páginas: tokens cifrados em metaOAuthPending, a UI escolhe
    const pendingId: Id<"metaOAuthPending"> = await ctx.runMutation(internal.metaMessaging.internalCreatePending, {
      organizationId: consumed.organizationId,
      memberId: consumed.memberId,
      stateId: consumed.stateId,
      scopes,
      pages: await Promise.all(
        pages.map(async (p) => ({
          pageId: p.pageId,
          pageName: p.pageName,
          tokenEncrypted: await encryptSecret(p.pageToken),
          ...(p.igAccountId ? { igAccountId: p.igAccountId } : {}),
          ...(p.igUsername ? { igUsername: p.igUsername } : {}),
          tasksOk: p.tasksOk,
        }))
      ),
    });
    return to({ selecionar: true, pendenteId: pendingId });
  } catch (e) {
    console.error(`meta oauth callback: ${e instanceof Error ? e.name : "erro"}`);
    return to("falha_meta");
  }
});

// ── Seleção de Páginas ──

export const internalCreatePending = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    stateId: v.id("oauthStates"),
    scopes: v.array(v.string()),
    pages: v.array(
      v.object({
        pageId: v.string(),
        pageName: v.string(),
        tokenEncrypted: v.string(),
        igAccountId: v.optional(v.string()),
        igUsername: v.optional(v.string()),
        tasksOk: v.boolean(),
      })
    ),
  },
  returns: v.id("metaOAuthPending"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("metaOAuthPending", {
      organizationId: args.organizationId,
      memberId: args.memberId,
      stateId: args.stateId,
      pages: args.pages,
      scopes: args.scopes,
      expiresAt: now + PENDING_TTL_MS,
      createdAt: now,
    });
  },
});

/** Sem tokens, só da org dona e dentro do TTL. */
export const getPendingSelection = query({
  args: { organizationId: v.id("organizations"), pendingId: v.id("metaOAuthPending") },
  returns: v.union(
    v.null(),
    v.object({
      pages: v.array(
        v.object({
          pageId: v.string(),
          pageName: v.string(),
          igAccountId: v.optional(v.string()),
          igUsername: v.optional(v.string()),
          tasksOk: v.boolean(),
        })
      ),
      expiresAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const pending = await ctx.db.get(args.pendingId);
    if (!pending || pending.organizationId !== args.organizationId) return null;
    if (pending.memberId !== member._id) throw new ConvexError("Esta seleção pertence a outro usuário.");
    return {
      // Sem `Date.now()` em query: o cliente decide pelo `expiresAt`; a finalização revalida.
      pages: pending.pages.map((p) => ({
        pageId: p.pageId,
        pageName: p.pageName,
        ...(p.igAccountId ? { igAccountId: p.igAccountId } : {}),
        ...(p.igUsername ? { igUsername: p.igUsername } : {}),
        tasksOk: p.tasksOk,
      })),
      expiresAt: pending.expiresAt,
    };
  },
});

export const internalGetPending = internalQuery({
  args: { pendingId: v.id("metaOAuthPending") },
  returns: v.any(), // com tokens cifrados: só para actions
  handler: async (ctx, args) => await ctx.db.get(args.pendingId),
});

export const internalDeletePending = internalMutation({
  args: { pendingId: v.id("metaOAuthPending") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.pendingId)) await ctx.db.delete(args.pendingId);
    return null;
  },
});

const finalizeReturn = v.union(
  v.object({ ok: v.literal(true), configIds: v.array(v.id("channelConfigs")) }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("cancelado"),
      v.literal("expirado"),
      v.literal("conta_em_uso"),
      v.literal("sem_permissao"),
      v.literal("sem_pagina"),
      v.literal("sem_papel"),
      v.literal("modulo_off"),
      v.literal("falha_meta")
    ),
    // O que já foi conectado antes da falha (falha no meio do lote).
    configIds: v.optional(v.array(v.id("channelConfigs"))),
  })
);

export const finalizeMetaSelection = action({
  args: {
    organizationId: v.id("organizations"),
    pendingId: v.id("metaOAuthPending"),
    picks: v.array(v.object({ pageId: v.string(), messenger: v.boolean(), instagram: v.boolean() })),
  },
  returns: finalizeReturn,
  handler: async (ctx, args): Promise<FinalizeResult> => {
    const { memberId }: { memberId: Id<"teamMembers"> } = await ctx.runQuery(
      internal.metaMessaging.internalAuthorizeMetaConnect,
      { organizationId: args.organizationId }
    );
    const pending: Doc<"metaOAuthPending"> | null = await ctx.runQuery(internal.metaMessaging.internalGetPending, {
      pendingId: args.pendingId,
    });
    if (!pending || pending.organizationId !== args.organizationId || pending.expiresAt <= Date.now()) {
      return { ok: false, code: "expirado" };
    }
    if (pending.memberId !== memberId) return { ok: false, code: "sem_papel" };

    // 1) Valida TODAS as escolhas antes de conectar a primeira (nada pela metade).
    const chosen = args.picks
      .filter((p) => p.messenger || p.instagram)
      .map((pick) => ({ pick, page: pending.pages.find((p) => p.pageId === pick.pageId) }))
      .filter((c): c is { pick: (typeof args.picks)[number]; page: Doc<"metaOAuthPending">["pages"][number] } => !!c.page);
    for (const { pick, page } of chosen) {
      if (!page.tasksOk) return { ok: false, code: "sem_papel" };
      const blocked: MetaOAuthErrorCode | null = await ctx.runQuery(internal.metaMessaging.internalCheckMetaAccountFree, {
        organizationId: args.organizationId,
        pageId: page.pageId,
        igAccountId: pick.instagram ? page.igAccountId : undefined,
      });
      if (blocked) return { ok: false, code: blocked };
    }

    // 2) Conecta. Falha no meio (ex.: corrida com outra org): devolve o que já conectou e
    // apaga a pendência (os tokens cifrados não ficam órfãos).
    const configIds: Id<"channelConfigs">[] = [];
    const failMidway = async (code: MetaOAuthErrorCode): Promise<FinalizeResult> => {
      await ctx.runMutation(internal.metaMessaging.internalDeletePending, { pendingId: args.pendingId });
      return { ok: false, code, configIds };
    };
    for (const { pick, page } of chosen) {
      let token: string;
      try {
        token = await decryptSecret(page.tokenEncrypted);
      } catch {
        return await failMidway("falha_meta");
      }
      const result = await finalizeConnection(ctx, {
        organizationId: args.organizationId,
        memberId,
        page: {
          pageId: page.pageId,
          pageName: page.pageName,
          pageToken: token,
          tasksOk: page.tasksOk,
          igAccountId: page.igAccountId,
          igUsername: page.igUsername,
        },
        messenger: pick.messenger,
        instagram: pick.instagram,
        scopes: pending.scopes,
      });
      if (!result.ok) return await failMidway(result.code);
      configIds.push(...result.configIds);
    }
    await ctx.runMutation(internal.metaMessaging.internalDeletePending, { pendingId: args.pendingId });
    return { ok: true, configIds };
  },
});

// ── Conexão: exclusividade e upserts ──

/** `conta_em_uso` se a Página/conta IG já pertence a OUTRA org (sem dizer qual). */
async function findExclusivityConflict(
  ctx: { db: any },
  organizationId: Id<"organizations">,
  pageId: string,
  igAccountId: string | undefined
): Promise<boolean> {
  const byPage: Doc<"metaConnections">[] = await ctx.db
    .query("metaConnections")
    .withIndex("by_page_id", (q: any) => q.eq("pageId", pageId))
    .take(10);
  if (byPage.some((c) => c.organizationId !== organizationId && c.authState !== "revoked")) return true;
  if (igAccountId) {
    const byIg: Doc<"metaConnections">[] = await ctx.db
      .query("metaConnections")
      .withIndex("by_ig_account_id", (q: any) => q.eq("igAccountId", igAccountId))
      .take(10);
    if (byIg.some((c) => c.organizationId !== organizationId && c.authState !== "revoked")) return true;
  }
  return false;
}

export const internalCheckMetaAccountFree = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    connectionId: v.optional(v.id("metaConnections")),
    pageId: v.string(),
    igAccountId: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.literal("conta_em_uso"), v.literal("sem_pagina")),
  handler: async (ctx, args) => {
    if (args.connectionId) {
      const conn = await ctx.db.get(args.connectionId);
      if (!conn || conn.organizationId !== args.organizationId || conn.pageId !== args.pageId) {
        return "sem_pagina" as const; // reconectar exige a mesma Página
      }
    }
    return (await findExclusivityConflict(ctx, args.organizationId, args.pageId, args.igAccountId))
      ? ("conta_em_uso" as const)
      : null;
  },
});

export const internalUpsertMetaConnection = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    connectionId: v.optional(v.id("metaConnections")),
    pageId: v.string(),
    pageName: v.string(),
    igAccountId: v.optional(v.string()),
    igUsername: v.optional(v.string()),
    tokenEncrypted: v.string(),
    tokenLast4: v.string(),
    scopes: v.array(v.string()),
    dataAccessExpiresAt: v.optional(v.number()),
    subscribedAt: v.optional(v.number()),
    subscribedFields: v.optional(v.array(v.string())),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), connectionId: v.id("metaConnections") }),
    v.object({ ok: v.literal(false), code: v.union(v.literal("conta_em_uso"), v.literal("sem_pagina")) })
  ),
  handler: async (ctx, args) => {
    await assertModule(ctx, args.organizationId, "metaMessaging");
    if (await findExclusivityConflict(ctx, args.organizationId, args.pageId, args.igAccountId)) {
      return { ok: false as const, code: "conta_em_uso" as const };
    }

    let existing: Doc<"metaConnections"> | null = null;
    if (args.connectionId) {
      existing = await ctx.db.get(args.connectionId);
      if (!existing || existing.organizationId !== args.organizationId || existing.pageId !== args.pageId) {
        return { ok: false as const, code: "sem_pagina" as const };
      }
    } else {
      const sameOrg = await ctx.db
        .query("metaConnections")
        .withIndex("by_page_id", (q) => q.eq("pageId", args.pageId))
        .take(10);
      existing = sameOrg.find((c) => c.organizationId === args.organizationId) ?? null;
    }

    const now = Date.now();
    const fields = {
      authMethod: "facebook_login" as const,
      tokenKind: "page" as const,
      tokenEncrypted: args.tokenEncrypted,
      tokenLast4: args.tokenLast4,
      pageId: args.pageId,
      pageName: args.pageName,
      igAccountId: args.igAccountId,
      igUsername: args.igUsername,
      scopes: args.scopes,
      dataAccessExpiresAt: args.dataAccessExpiresAt,
      authState: "ok" as const,
      authDetail: undefined,
      authAlertedAt: undefined,
      connectedByMemberId: args.memberId,
      updatedAt: now,
      ...(args.subscribedAt !== undefined
        ? { subscribedAt: args.subscribedAt, subscribedFields: args.subscribedFields }
        : {}),
    };
    let connectionId: Id<"metaConnections">;
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      connectionId = existing._id;
    } else {
      connectionId = await ctx.db.insert("metaConnections", { ...fields, organizationId: args.organizationId, createdAt: now });
    }

    // Audit: NOMES de campos, nunca valores (token, ids de cliente).
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "metaConnection",
      entityId: connectionId,
      action: existing ? "update" : "create",
      actorId: args.memberId,
      actorType: "human",
      metadata: {
        fields: ["tokenEncrypted", "tokenLast4", "scopes", "authState", "pageId", ...(args.igAccountId ? ["igAccountId"] : [])],
        tokenLast4: args.tokenLast4,
        subscribed: args.subscribedAt !== undefined,
        reconnect: existing !== null,
      },
      description: `${existing ? "Reconectou" : "Conectou"} a Página "${args.pageName}" (Instagram/Messenger)`,
      severity: "high",
      createdAt: now,
    });
    return { ok: true as const, connectionId };
  },
});

export const internalUpsertMetaChannelConfigs = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    connectionId: v.id("metaConnections"),
    messenger: v.boolean(),
    instagram: v.boolean(),
  },
  returns: v.array(v.id("channelConfigs")),
  handler: async (ctx, args) => {
    await assertModule(ctx, args.organizationId, "metaMessaging");
    const conn = await ctx.db.get(args.connectionId);
    if (!conn || conn.organizationId !== args.organizationId) throw new ConvexError("Conexão não encontrada.");

    const now = Date.now();
    const ids: Id<"channelConfigs">[] = [];

    const upsert = async (channel: "messenger" | "instagram") => {
      const accountId = channel === "messenger" ? conn.pageId : conn.igAccountId;
      if (!accountId) return;
      const found =
        channel === "messenger"
          ? await ctx.db
              .query("channelConfigs")
              .withIndex("by_messenger_page_id", (q) => q.eq("messengerPageId", accountId))
              .take(10)
          : await ctx.db
              .query("channelConfigs")
              .withIndex("by_instagram_account_id", (q) => q.eq("instagramAccountId", accountId))
              .take(10);
      let existing = found.find((c) => c.organizationId === args.organizationId);
      if (!existing) {
        // Config desconectado antes (ids de roteamento liberados): reaproveita pela conexão.
        const byConn = await ctx.db
          .query("channelConfigs")
          .withIndex("by_meta_connection", (q) => q.eq("metaConnectionId", conn._id))
          .take(20);
        existing = byConn.find((c) => c.organizationId === args.organizationId && c.channel === channel);
      }
      const handle = channel === "instagram" && conn.igUsername ? `@${conn.igUsername}` : undefined;
      const label = channel === "messenger" ? conn.pageName : handle ?? conn.pageName;
      const display = label ?? (channel === "messenger" ? "Messenger" : "Instagram");
      let configId: Id<"channelConfigs">;
      if (existing) {
        await ctx.db.patch(existing._id, {
          status: "active",
          disabledByModuleAt: undefined,
          ...(channel === "messenger" ? { messengerPageId: accountId } : { instagramAccountId: accountId }),
          metaConnectionId: conn._id,
          displayName: display,
          metaAccountLabel: label,
          metaAccountHandle: handle,
          updatedAt: now,
        });
        configId = existing._id;
      } else {
        configId = await ctx.db.insert("channelConfigs", {
          organizationId: args.organizationId,
          channel,
          displayName: display,
          status: "active",
          metaConnectionId: conn._id,
          ...(channel === "messenger" ? { messengerPageId: accountId } : { instagramAccountId: accountId }),
          metaAccountLabel: label,
          ...(handle ? { metaAccountHandle: handle } : {}),
          createdAt: now,
          updatedAt: now,
        });
      }
      ids.push(configId);
      await ctx.db.insert("auditLogs", {
        organizationId: args.organizationId,
        entityType: "channelConfig",
        entityId: configId,
        action: existing ? "update" : "create",
        actorId: args.memberId,
        actorType: "human",
        metadata: { name: display, channel, fields: ["status", "metaConnectionId", "displayName"] },
        description: `${existing ? "Reativou" : "Criou"} o canal ${channel === "messenger" ? "Messenger" : "Instagram"} "${display}"`,
        severity: "high",
        createdAt: now,
      });
    };

    if (args.messenger) await upsert("messenger");
    if (args.instagram) await upsert("instagram");
    return ids;
  },
});

// ── Desconectar ──

/** Não exige o módulo: limpeza sempre possível. O token é apagado, os canais ficam `disabled`. */
export const disconnectMetaConnection = mutation({
  args: { organizationId: v.id("organizations"), connectionId: v.id("metaConnections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const conn = await ctx.db.get(args.connectionId);
    if (!conn || conn.organizationId !== args.organizationId) throw new ConvexError("Conexão não encontrada.");

    const now = Date.now();
    await ctx.db.patch(conn._id, {
      authState: "revoked",
      tokenEncrypted: "",
      tokenLast4: "",
      authDetail: "Desconectado manualmente",
      updatedAt: now,
    });
    const configs = await ctx.db
      .query("channelConfigs")
      .withIndex("by_meta_connection", (q) => q.eq("metaConnectionId", conn._id))
      .take(20);
    const disabled: string[] = [];
    for (const c of configs) {
      if (c.organizationId !== args.organizationId) continue;
      // Libera os ids de roteamento: a Página/conta IG pode ser conectada por outra org e o
      // índice deve devolver só o config novo. O rótulo e o @ continuam para exibição.
      await ctx.db.patch(c._id, {
        status: "disabled",
        messengerPageId: undefined,
        instagramAccountId: undefined,
        updatedAt: now,
      });
      disabled.push(c._id);
    }
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "metaConnection",
      entityId: conn._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      changes: { before: { authState: conn.authState }, after: { authState: "revoked" } },
      metadata: { fields: ["authState", "tokenEncrypted", "tokenLast4"], configIds: disabled },
      description: `Desconectou a Página "${conn.pageName ?? ""}" (Instagram/Messenger)`,
      severity: "high",
      createdAt: now,
    });
    return null;
  },
});
