/**
 * Meta Messaging (Instagram + Facebook Messenger, API oficial) — handlers finos.
 *
 * F0.3: webhook (GET handshake + POST), ingest de TEXTO/placeholder, OAuth do
 * Facebook Login for Business, conexão/desconexão. Lógica pura em
 * `lib/metaMessagingParse.ts`, `lib/metaOAuth.ts`, `lib/metaGraph.ts`,
 * `lib/metaIdentity.ts`. Envio (dispatcher) é a F1.
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
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission, requireAccountWithEmail, isMembershipRevoked } from "./lib/auth";
import { hasPermission, resolvePermissions, Role } from "./lib/permissions";
import { assertModule, modulesOf } from "./lib/orgModules";
import { encryptSecret, decryptSecret, secretLast4 } from "./lib/secretCrypto";
import { appUrl } from "./lib/appUrl";
import { ensureLeadForContact } from "./lib/inboundRouting";
import { applyFollowUpDeliveryUpdate } from "./lib/followUpOps";
import { applyInboundWelcomeDeliveryFailure } from "./lib/inboundLeadWelcomeHooks";
import {
  MetaAttachment,
  MetaEvent,
  isTestPayload,
  parseMetaMessagingWebhook,
  verifyMetaSignature,
} from "./lib/metaMessagingParse";
import { graphBase, profileEndpoint } from "./lib/metaGraph";
import {
  MetaOAuthErrorCode,
  UsablePage,
  buildAuthorizeUrl,
  missingScopes,
  pickUsablePages,
  redirectUrlFor,
} from "./lib/metaOAuth";
import { fallbackMetaName, findOrCreateContactByMetaIdentity } from "./lib/metaIdentity";

// ── Constantes e validators ──

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const RETURN_PATH = "/configuracoes?secao=canais";
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
    if (args.surface === "messenger") {
      return await ctx.db
        .query("channelConfigs")
        .withIndex("by_messenger_page_id", (q) => q.eq("messengerPageId", args.accountId))
        .first();
    }
    return await ctx.db
      .query("channelConfigs")
      .withIndex("by_instagram_account_id", (q) => q.eq("instagramAccountId", args.accountId))
      .first();
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

    if (event.kind !== "message" && event.kind !== "unsupported") {
      // F1 (eco, entregue/lida) e F2 (reação, edição, apagada) tratam; aqui só registro curto.
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

/**
 * Fail-closed do envio Instagram/Messenger até a F1: a mensagem vira `failed`
 * com texto claro, sem rede. (`whatsapp.internalMarkDispatchFailed` grava
 * "no WhatsApp" na atividade e mexe em campanhas, então não serve aqui.)
 */
export const internalMarkDispatchUnsupported = internalMutation({
  args: { messageId: v.id("messages"), detail: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return null;
    if (message.externalId || message.deliveryStatus) return null; // nunca rebaixa o que já saiu
    await ctx.db.patch(args.messageId, {
      deliveryStatus: "failed",
      metadata: { ...(message.metadata ?? {}), deliveryError: args.detail },
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
    await applyFollowUpDeliveryUpdate(ctx, { messageId: args.messageId, ok: false, detail: args.detail });
    await applyInboundWelcomeDeliveryFailure(ctx, { messageId: args.messageId, detail: args.detail });
    return null;
  },
});

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

type FinalizeResult = { ok: true; configIds: Id<"channelConfigs">[] } | { ok: false; code: MetaOAuthErrorCode };

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
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    const pending = await ctx.db.get(args.pendingId);
    if (!pending || pending.organizationId !== args.organizationId) return null;
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

    const configIds: Id<"channelConfigs">[] = [];
    for (const pick of args.picks) {
      if (!pick.messenger && !pick.instagram) continue;
      const page = pending.pages.find((p) => p.pageId === pick.pageId);
      if (!page) continue;
      if (!page.tasksOk) return { ok: false, code: "sem_papel" };
      let token: string;
      try {
        token = await decryptSecret(page.tokenEncrypted);
      } catch {
        return { ok: false, code: "falha_meta" };
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
      if (!result.ok) return result;
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
      const existing = found.find((c) => c.organizationId === args.organizationId);
      const handle = channel === "instagram" && conn.igUsername ? `@${conn.igUsername}` : undefined;
      const label = channel === "messenger" ? conn.pageName : handle ?? conn.pageName;
      const display = label ?? (channel === "messenger" ? "Messenger" : "Instagram");
      let configId: Id<"channelConfigs">;
      if (existing) {
        await ctx.db.patch(existing._id, {
          status: "active",
          disabledByModuleAt: undefined,
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
      await ctx.db.patch(c._id, { status: "disabled", updatedAt: now });
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
