/**
 * WhatsApp "bridge" (unofficial, wuzapi/whatsmeow) webhook ingress (multi-tenant).
 *
 * Mirrors the Meta ingress (convex/whatsapp.ts) but routes by wuzapi instance id
 * and verifies a deployment-wide HMAC secret. One endpoint serves every tenant.
 * Inbound messages are scheduled (media is downloaded + decrypted via wuzapi and
 * stored as a file attachment — Wave U4); receipts run inline as plain mutations.
 * The Meta path is untouched.
 *
 * Wave U2 scope: inbound text/media routing + delivery receipts. Wave U4 adds the
 * inbound media pipeline (download → validate size → store → files → attachment),
 * mirroring the Meta pipeline in convex/whatsapp.ts.
 */
import { v } from "convex/values";
import { action, httpAction, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { configProvider } from "./channelConfigs";
import { decryptSecret } from "./lib/secretCrypto";
import {
  extractBridgeInstanceId,
  parseBridgeEvent,
  verifyBridgeSignature,
} from "./lib/bridgeParse";
import {
  BridgeMediaKind,
  base64ToBytes,
  buildBridgeDownloadRequest,
  descriptorFileLength,
  parseBridgeDownloadResponse,
  sanitizeBridgeMediaMeta,
  stripMediaKeyMaterial,
} from "./lib/bridgeMedia";
import {
  BRIDGE_HISTORY_MAX_CHATS,
  buildGetHistoryRequest,
  buildRequestHistorySyncRequest,
  buildSetHistoryRequest,
  normalizeHistoryDays,
  normalizeHistoryLimit,
  parseBridgeHistoryResponse,
  phoneToChatJid,
  selectHistoryRows,
} from "./lib/bridgeHistory";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // mirror the Meta path — skip larger, keep a note

// whatsmeow media kinds we know how to download; anything else is treated as a document.
const KNOWN_MEDIA_KINDS: readonly BridgeMediaKind[] = ["image", "sticker", "audio", "video", "document"];
function normalizeMediaKind(kind: string): BridgeMediaKind {
  return (KNOWN_MEDIA_KINDS as readonly string[]).includes(kind) ? (kind as BridgeMediaKind) : "document";
}

const parsedBridgeMessageValidator = v.object({
  externalId: v.string(),
  from: v.string(),
  fromMe: v.boolean(),
  profileName: v.optional(v.string()),
  timestamp: v.number(),
  contentType: v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio")),
  content: v.string(),
  media: v.optional(
    v.object({
      kind: v.string(),
      mimeType: v.optional(v.string()),
      filename: v.optional(v.string()),
      descriptor: v.optional(v.record(v.string(), v.any())),
    })
  ),
  metadata: v.optional(v.record(v.string(), v.any())),
});

// POST /webhooks/bridge — wuzapi message + receipt deliveries
export const webhookReceive = httpAction(async (ctx, request) => {
  const rawBody = await request.text();

  // Parse WITHOUT trusting the payload — only to extract the routing key
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const instanceId = extractBridgeInstanceId(payload);
  if (!instanceId) {
    console.warn("Bridge webhook without instance id — dropped");
    return new Response("OK", { status: 200 });
  }

  const config = await ctx.runQuery(internal.channelConfigs.internalGetConfigByBridgeInstanceId, {
    bridgeInstanceId: instanceId,
  });
  // Unknown instance, wrong provider, or inactive → 200 + drop: don't make the
  // gateway retry, don't leak tenant existence.
  if (!config || configProvider(config) !== "bridge" || config.status !== "active") {
    console.warn(`Bridge webhook for unknown/inactive instance ${instanceId} — dropped`);
    return new Response("OK", { status: 200 });
  }

  // HMAC verification with the deployment-wide bridge secret. If the env var is
  // absent, drop (200) rather than accept unverified — never trust silently.
  const secret = process.env.WA_BRIDGE_HMAC_SECRET;
  if (!secret) {
    console.warn("WA_BRIDGE_HMAC_SECRET not configured — bridge webhook dropped");
    return new Response("OK", { status: 200 });
  }
  // VALIDAR: exact header name wuzapi uses (research points to `x-hmac-signature`).
  const signatureValid = await verifyBridgeSignature(
    rawBody,
    request.headers.get("X-Hmac-Signature"),
    secret
  );
  if (!signatureValid) {
    console.warn(`Bridge webhook signature invalid for instance ${instanceId} — rejected`);
    return new Response("Invalid signature", { status: 401 });
  }

  const parsed = parseBridgeEvent(payload);
  if (parsed.kind === "message") {
    // Schedule per message — routing + persistence (and media download in U4)
    await ctx.scheduler.runAfter(0, internal.bridge.internalIngestBridgeMessage, {
      configId: config._id,
      message: parsed.message,
    });
  } else if (parsed.kind === "receipt") {
    // Receipts are cheap — update inline, scoped to this config's org
    for (const externalId of parsed.receipt.externalIds) {
      await ctx.runMutation(internal.conversations.internalUpdateDeliveryStatus, {
        organizationId: config.organizationId,
        externalId,
        status: parsed.receipt.status,
      });
    }
  } else if (parsed.kind === "reaction") {
    // Contact reacted to a message — patch the target's metadata.reactions inline.
    // Unknown target is a no-op (returns null); never a message of its own.
    await ctx.runMutation(internal.conversations.internalApplyReaction, {
      organizationId: config.organizationId,
      targetExternalId: parsed.reaction.targetExternalId,
      emoji: parsed.reaction.emoji,
      sender: "contact",
      senderName: parsed.reaction.senderName,
      at: parsed.reaction.timestamp,
    });
  } else if (parsed.kind === "chat_presence") {
    // Contato digitando/parou — patch barato na conversa, some via TTL no cliente.
    await ctx.runMutation(internal.conversations.internalSetContactPresence, {
      organizationId: config.organizationId,
      phone: parsed.presence.phone,
      state: parsed.presence.state,
    });
  }
  // parsed.kind === "ignored" (group, reação nossa, presence, unrecognized) → no-op

  return new Response("OK", { status: 200 });
});

// Internal: ingest one inbound bridge message (media pipeline + routing + persistence).
// Media is downloaded + decrypted through wuzapi and stored as a file attachment;
// a media failure never drops the text/placeholder message.
export const internalIngestBridgeMessage = internalAction({
  args: {
    configId: v.id("channelConfigs"),
    message: parsedBridgeMessageValidator,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: args.configId,
    });
    if (!config || config.status !== "active") return null;

    // Early idempotency: gateways may redeliver on retry
    const existing = await ctx.runQuery(internal.conversations.internalGetMessageByExternalId, {
      organizationId: config.organizationId,
      externalId: args.message.externalId,
    });
    if (existing) return null;

    // Reuse the shared contact/lead routing (find-or-create by phone + AI auto-assign).
    // Vale para os dois sentidos: uma conversa iniciada pelo aparelho com um
    // número novo também precisa de contato e lead para aparecer no inbox.
    const { leadId } = await ctx.runMutation(internal.whatsapp.internalRouteInbound, {
      configId: args.configId,
      waId: args.message.from,
      profileName: args.message.profileName,
    });

    const metadata: Record<string, unknown> = { ...(args.message.metadata ?? {}) };
    let attachments: Id<"files">[] | undefined;

    // Resolve an inbound reply's quoted message (by whatsmeow id) to our local
    // message id, so the UI can link the reply to the original. If the quoted
    // message predates the integration (not stored), we keep the raw quote only.
    const quoted = metadata.quoted as { externalId?: string } | undefined;
    if (quoted?.externalId) {
      const target = await ctx.runQuery(internal.conversations.internalGetMessageByExternalId, {
        organizationId: config.organizationId,
        externalId: quoted.externalId,
      });
      if (target?._id) metadata.quotedMessageId = target._id;
    }

    // Media pipeline: ask wuzapi to download + decrypt, then store as a file.
    // Any failure keeps the placeholder message with a note (mediaPending stays
    // true) — a media hiccup must never drop the inbound message itself.
    if (args.message.media) {
      const media = args.message.media;
      // Só a parte diagnosticável fica na mensagem. O descriptor cru — com o
      // `MediaKey` do whatsmeow — vive apenas nesta action, o tempo do download.
      metadata.bridgeMedia = sanitizeBridgeMediaMeta(media);
      try {
        if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) {
          throw new Error("Configuração bridge incompleta — mídia não baixada");
        }
        const descriptor = (media.descriptor ?? {}) as Record<string, any>;
        const declaredLen = descriptorFileLength(descriptor);
        if (declaredLen !== undefined && declaredLen > MAX_MEDIA_BYTES) {
          // Skip the download entirely when the descriptor already says it's too big.
          metadata.mediaSkipped = `mídia muito grande (${declaredLen} bytes)`;
          metadata.mediaPending = true;
        } else {
          const token = await decryptSecret(config.bridgeTokenEncrypted);
          const request = buildBridgeDownloadRequest({
            baseUrl: config.bridgeBaseUrl,
            token,
            kind: normalizeMediaKind(media.kind),
            descriptor,
          });
          const res = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: request.body,
          });
          const body = await res.json().catch(() => ({}));
          const parsed = parseBridgeDownloadResponse(res.ok, res.status, body);
          if (!parsed.ok) {
            metadata.mediaError = parsed.error;
            metadata.mediaPending = true;
          } else {
            const bytes = base64ToBytes(parsed.base64);
            if (bytes.byteLength > MAX_MEDIA_BYTES) {
              metadata.mediaSkipped = `mídia muito grande (${bytes.byteLength} bytes)`;
              metadata.mediaPending = true;
            } else {
              const mimeType = media.mimeType ?? parsed.mimeType ?? "application/octet-stream";
              const storageId = await ctx.storage.store(new Blob([bytes], { type: mimeType }));
              const saved = await ctx.runMutation(internal.whatsapp.internalSaveInboundAttachment, {
                organizationId: config.organizationId,
                storageId,
                name: media.filename ?? `whatsapp-${args.message.externalId}`,
                mimeType,
                size: bytes.byteLength,
              });
              if (saved.ok) {
                attachments = [saved.fileId];
                // Success — the reference stays for provenance, but it's no longer pending.
              } else {
                // Mimetype fora da allowlist ou quota da org estourada: a
                // mensagem do contato segue inteira, só sem o anexo (mesmo
                // tratamento da mídia grande demais logo acima).
                metadata.mediaSkipped = saved.reason;
                metadata.mediaPending = true;
              }
            }
          }
        }
      } catch (e) {
        metadata.mediaError = e instanceof Error ? e.message : "media pipeline failed";
        metadata.mediaPending = true;
      }
    }

    // Última barreira antes do banco: nenhum campo de chave passa, nem pelo
    // `metadata.raw` que o parser guarda para tipo de mensagem desconhecido.
    const safeMetadata = stripMediaKeyMaterial(metadata) as Record<string, unknown>;

    if (args.message.fromMe) {
      // Saiu do nosso número sem passar pelo CRM (app do celular). O eco do que
      // o próprio CRM enviou também cai aqui e morre na idempotência.
      await ctx.runMutation(internal.conversations.internalReceiveDeviceMessage, {
        organizationId: config.organizationId,
        leadId,
        channelConfigId: args.configId,
        content: args.message.content,
        contentType: args.message.contentType,
        attachments,
        externalId: args.message.externalId,
        sentAt: args.message.timestamp,
        metadata: safeMetadata,
      });
      return null;
    }

    await ctx.runMutation(internal.conversations.internalReceiveMessage, {
      organizationId: config.organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: args.configId,
      content: args.message.content,
      contentType: args.message.contentType,
      attachments,
      externalId: args.message.externalId,
      metadata: safeMetadata,
    });

    return null;
  },
});

/**
 * Backfill idempotente: tira o material de chave (`MediaKey`, `FileEncSHA256` e
 * afins) das mensagens que já foram gravadas com o descriptor inteiro do
 * whatsmeow em `metadata.bridgeMedia` — ou com o evento cru em `metadata.raw`.
 * Molde: `internal.transcription.internalBackfillTranscriptText`.
 *
 * Roda com: `npx convex run bridge:internalBackfillBridgeMediaKeys '{}'`
 * (devolve quantas mensagens foram reescritas; rodar de novo devolve 0).
 */
export const internalBackfillBridgeMediaKeys = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").collect();
    let patched = 0;
    for (const message of messages) {
      const metadata = message.metadata;
      if (!metadata) continue;

      const cleaned = stripMediaKeyMaterial(metadata) as Record<string, unknown>;
      const rawMedia = metadata.bridgeMedia;
      if (rawMedia && typeof rawMedia === "object" && !Array.isArray(rawMedia)) {
        cleaned.bridgeMedia = sanitizeBridgeMediaMeta(rawMedia as Record<string, any>);
      }

      if (JSON.stringify(cleaned) === JSON.stringify(metadata)) continue;
      await ctx.db.patch(message._id, { metadata: cleaned });
      patched++;
    }
    return patched;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Histórico do aparelho — recuperação das mensagens que o webhook não trouxe
// ─────────────────────────────────────────────────────────────────────────────
//
// O webhook é a fonte primária e continua sendo. Isto aqui é a rede embaixo
// dele: o gateway wuzapi mantém um store próprio por instância, e cada linha
// traz o evento whatsmeow ORIGINAL — o mesmo que `parseBridgeEvent` já sabe ler.
// Então a importação reusa o parser e o ingest inteiros, em vez de abrir uma
// segunda rota de interpretação para as mesmas mensagens.
//
// São duas fases porque o pedido de sync ao WhatsApp é ASSÍNCRONO: a fase 1
// liga o store e pede; a fase 2 (agendada) lê e importa.

/** Janela entre pedir o HistorySync e ler o store. O sync chega pelo socket. */
const HISTORY_SYNC_SETTLE_MS = 25_000;

/** Contexto que as duas fases precisam, numa consulta só. */
export const internalGetHistorySyncContext = internalQuery({
  args: { configId: v.id("channelConfigs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) return null;

    // Conversas mais recentes DESTA org, do mais novo para o mais antigo. O
    // filtro por canal é aplicado depois: conversa antiga pode ter
    // `channelConfigId` de uma config já removida (re-provisionamento), e
    // ignorá-la deixaria justamente as conversas antigas sem recuperação.
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_organization_and_last_message", (q) =>
        q.eq("organizationId", config.organizationId)
      )
      .order("desc")
      .take(BRIDGE_HISTORY_MAX_CHATS * 3);

    const chats: { leadId: Id<"leads">; phone: string }[] = [];
    const seen = new Set<string>();
    for (const conversation of conversations) {
      if (conversation.channel !== "whatsapp") continue;
      if (conversation.archivedAt) continue;
      if (chats.length >= BRIDGE_HISTORY_MAX_CHATS) break;

      const lead = await ctx.db.get(conversation.leadId);
      if (!lead || lead.organizationId !== config.organizationId) continue;
      const contact = lead.contactId ? await ctx.db.get(lead.contactId) : null;
      const phone = contact?.whatsappNumber ?? contact?.phone;
      if (!phone) continue;

      const digits = phone.replace(/\D/g, "");
      if (seen.has(digits)) continue;
      seen.add(digits);
      chats.push({ leadId: lead._id, phone: digits });
    }

    return {
      organizationId: config.organizationId,
      provider: configProvider(config),
      status: config.status,
      baseUrl: config.bridgeBaseUrl ?? null,
      tokenEncrypted: config.bridgeTokenEncrypted ?? null,
      enabled: config.bridgeHistoryEnabled === true,
      limit: normalizeHistoryLimit(config.bridgeHistoryLimit),
      days: normalizeHistoryDays(config.bridgeHistoryDays),
      chats,
    };
  },
});

/** Carimba o resultado da última sincronização (a UI lê daqui). */
export const internalRecordHistorySync = internalMutation({
  args: {
    configId: v.id("channelConfigs"),
    result: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) return null;
    await ctx.db.patch(args.configId, {
      bridgeHistoryLastSyncAt: Date.now(),
      bridgeHistoryLastResult: args.result.slice(0, 300),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Liga/desliga e ajusta o histórico do aparelho DESTE número.
 *
 * Caminho ÚNICO para esses três campos, de propósito: além de gravar no CRM,
 * precisa ecoar o teto no gateway (`POST /session/history`), senão o operador
 * liga o interruptor, nada passa a ser guardado, e só descobre na primeira
 * sincronização vazia. Desligar manda `history: 0` — para de guardar lá também,
 * em vez de deixar o store crescendo num gateway que ninguém mais lê.
 *
 * O eco no gateway é BEST-EFFORT: se ele estiver fora do ar a preferência fica
 * gravada mesmo assim (e a próxima sincronização reenvia o teto), porque perder
 * a escolha do usuário por causa de um gateway momentaneamente mudo é pior.
 */
/**
 * Grava SÓ os três campos do histórico. Mutation própria (em vez de
 * `internalPatchConfig`) porque aquela exige `settings:manage` do usuário
 * logado, e o caminho de ops — `npx convex run` — não tem usuário. A permissão
 * fica no wrapper público abaixo, que é o único que um cliente alcança.
 */
export const internalPatchBridgeHistory = internalMutation({
  args: {
    configId: v.id("channelConfigs"),
    enabled: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    days: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) throw new Error("Canal não encontrado");
    if (configProvider(config) !== "bridge") {
      throw new Error("Histórico do aparelho só existe no canal bridge");
    }
    await ctx.db.patch(args.configId, {
      ...(args.enabled !== undefined ? { bridgeHistoryEnabled: args.enabled } : {}),
      ...(args.limit !== undefined ? { bridgeHistoryLimit: normalizeHistoryLimit(args.limit) } : {}),
      ...(args.days !== undefined ? { bridgeHistoryDays: normalizeHistoryDays(args.days) } : {}),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Implementação ÚNICA de "ajustar o histórico deste número": grava no CRM e ecoa
 * o teto no gateway. Sem gate de permissão — quem chama é o wrapper público (que
 * confere antes) ou a operação, via
 * `npx convex run bridge:internalApplyBridgeHistoryConfig '{"configId":"…","enabled":true}'`.
 */
export const internalApplyBridgeHistoryConfig = internalAction({
  args: {
    configId: v.id("channelConfigs"),
    enabled: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    days: v.optional(v.number()),
  },
  returns: v.object({ gatewayApplied: v.boolean(), detail: v.string() }),
  handler: async (ctx, args): Promise<{ gatewayApplied: boolean; detail: string }> => {
    await ctx.runMutation(internal.bridge.internalPatchBridgeHistory, {
      configId: args.configId,
      enabled: args.enabled,
      limit: args.limit,
      days: args.days,
    });

    // Relê DEPOIS de gravar: assim o eco no gateway usa o valor que de fato
    // ficou salvo (já normalizado), e não o que veio no argumento.
    const config = await ctx.runQuery(internal.bridge.internalGetHistorySyncContext, {
      configId: args.configId,
    });
    if (!config) throw new Error("Canal não encontrado");

    if (!config.baseUrl || !config.tokenEncrypted) {
      return { gatewayApplied: false, detail: "Preferência salva (gateway não configurado)" };
    }

    const token = await decryptSecret(config.tokenEncrypted);
    const req = buildSetHistoryRequest({
      baseUrl: config.baseUrl,
      token,
      // Desligar manda 0: para de guardar lá também, em vez de deixar o store
      // crescendo num gateway que ninguém mais lê.
      history: config.enabled ? config.limit : 0,
    });
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
    }).catch(() => null);

    if (!res || !res.ok) {
      return {
        gatewayApplied: false,
        detail: "Preferência salva, mas o gateway não confirmou — tente sincronizar depois",
      };
    }
    return {
      gatewayApplied: true,
      detail: config.enabled
        ? `Guardando até ${config.limit} mensagens por conversa (janela de ${config.days} dias)`
        : "Histórico desligado no gateway",
    };
  },
});

/**
 * Liga/desliga e ajusta o histórico do aparelho DESTE número (superfície do app).
 *
 * Caminho ÚNICO para esses três campos, de propósito: além de gravar no CRM,
 * precisa ecoar o teto no gateway, senão o operador liga o interruptor, nada
 * passa a ser guardado, e só descobre na primeira sincronização vazia.
 *
 * O eco no gateway é BEST-EFFORT: se ele estiver fora do ar a preferência fica
 * gravada mesmo assim (e a próxima sincronização reenvia o teto), porque perder
 * a escolha do usuário por causa de um gateway momentaneamente mudo é pior.
 */
export const setBridgeHistoryConfig = action({
  args: {
    configId: v.id("channelConfigs"),
    enabled: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    days: v.optional(v.number()),
  },
  returns: v.object({ gatewayApplied: v.boolean(), detail: v.string() }),
  handler: async (ctx, args): Promise<{ gatewayApplied: boolean; detail: string }> => {
    const config = await ctx.runQuery(internal.bridge.internalGetHistorySyncContext, {
      configId: args.configId,
    });
    if (!config) throw new Error("Canal não encontrado");
    // Permissão ANTES de qualquer escrita ou chamada ao gateway.
    await ctx.runQuery(internal.channelConfigs.internalRequireSettingsManage, {
      organizationId: config.organizationId,
    });
    if (config.provider !== "bridge") {
      throw new Error("Histórico do aparelho só existe no canal bridge");
    }

    return await ctx.runAction(internal.bridge.internalApplyBridgeHistoryConfig, {
      configId: args.configId,
      enabled: args.enabled,
      limit: args.limit,
      days: args.days,
    });
  },
});

/**
 * Fase 1 (disparada pelo botão em Configurações → Canais): liga o store do
 * gateway no teto configurado e pede um HistorySync por conversa. Agenda a
 * fase 2 para daqui a `HISTORY_SYNC_SETTLE_MS`.
 *
 * Gate: `settings:manage` — mesma permissão que edita o canal. E o toggle da
 * org precisa estar ligado: sem ele o CRM não toca nesses endpoints.
 */
export const syncBridgeHistory = action({
  args: { configId: v.id("channelConfigs") },
  returns: v.object({ requested: v.number(), detail: v.string() }),
  handler: async (ctx, args): Promise<{ requested: number; detail: string }> => {
    const config = await ctx.runQuery(internal.bridge.internalGetHistorySyncContext, {
      configId: args.configId,
    });
    if (!config) throw new Error("Canal não encontrado");
    await ctx.runQuery(internal.channelConfigs.internalRequireSettingsManage, {
      organizationId: config.organizationId,
    });
    if (config.provider !== "bridge") {
      throw new Error("Histórico do aparelho só existe no canal bridge");
    }
    if (!config.enabled) {
      throw new Error("Ative o histórico do aparelho neste número antes de sincronizar");
    }
    if (!config.baseUrl || !config.tokenEncrypted) {
      throw new Error("Configuração bridge incompleta — gateway ou token ausente");
    }

    const token = await decryptSecret(config.tokenEncrypted);

    // 1) Liga/ajusta o store. Sem isto o `GET /chat/history` responde 501.
    const setRes = await fetch(
      buildSetHistoryRequest({ baseUrl: config.baseUrl, token, history: config.limit }).url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", token },
        body: JSON.stringify({ history: config.limit }),
      }
    ).catch(() => null);
    if (!setRes || !setRes.ok) {
      const detail = `Gateway recusou ligar o histórico (HTTP ${setRes?.status ?? "sem resposta"})`;
      await ctx.runMutation(internal.bridge.internalRecordHistorySync, {
        configId: args.configId,
        result: detail,
      });
      throw new Error(detail);
    }

    // 2) Pede um HistorySync por conversa. Falha individual não derruba a rodada:
    //    o store pode já ter a conversa de sincronizações anteriores.
    let requested = 0;
    for (const chat of config.chats) {
      const chatJid = phoneToChatJid(chat.phone);
      if (!chatJid) continue;
      const req = buildRequestHistorySyncRequest({
        baseUrl: config.baseUrl,
        token,
        chatJid,
        count: config.limit,
      });
      const res = await fetch(req.url, { method: "GET", headers: req.headers }).catch(() => null);
      if (res?.ok) requested++;
    }

    await ctx.runMutation(internal.bridge.internalRecordHistorySync, {
      configId: args.configId,
      result: `Sincronização pedida para ${requested} conversa(s) — importando…`,
    });

    // 3) O HistorySync chega pelo socket alguns segundos depois; a leitura vai
    //    para uma execução separada em vez de dormir dentro desta action.
    await ctx.scheduler.runAfter(HISTORY_SYNC_SETTLE_MS, internal.bridge.internalImportBridgeHistory, {
      configId: args.configId,
    });

    return {
      requested,
      detail: `Pedido enviado para ${requested} conversa(s). A importação roda em ~${Math.round(HISTORY_SYNC_SETTLE_MS / 1000)}s.`,
    };
  },
});

/**
 * Fase 2: lê o store do gateway conversa a conversa e reinjeta no ingest o que
 * ainda não existe no CRM.
 *
 * Cada linha volta a passar por `parseBridgeEvent` e pelo mesmo ingest do
 * webhook — incluindo a idempotência por `externalId`, que é o que torna
 * re-sincronizar seguro: rodar duas vezes não duplica nada.
 *
 * ESCOPO DELIBERADO: só importa mensagem NOSSA (`fromMe`). Ver o filtro abaixo.
 */
export const internalImportBridgeHistory = internalAction({
  args: { configId: v.id("channelConfigs") },
  returns: v.object({ imported: v.number(), scanned: v.number(), detail: v.string() }),
  handler: async (ctx, args): Promise<{ imported: number; scanned: number; detail: string }> => {
    const config = await ctx.runQuery(internal.bridge.internalGetHistorySyncContext, {
      configId: args.configId,
    });
    if (!config || config.provider !== "bridge" || !config.enabled) {
      return { imported: 0, scanned: 0, detail: "Histórico desligado — nada a importar" };
    }
    if (config.status !== "active" || !config.baseUrl || !config.tokenEncrypted) {
      return { imported: 0, scanned: 0, detail: "Canal inativo ou incompleto" };
    }

    const token = await decryptSecret(config.tokenEncrypted);
    const now = Date.now();
    let imported = 0;
    let scanned = 0;
    let lastError: string | null = null;

    for (const chat of config.chats) {
      const chatJid = phoneToChatJid(chat.phone);
      if (!chatJid) continue;

      const req = buildGetHistoryRequest({
        baseUrl: config.baseUrl,
        token,
        chatJid,
        limit: config.limit,
      });
      const res = await fetch(req.url, { method: "GET", headers: req.headers }).catch(() => null);
      if (!res) {
        lastError = "Gateway inacessível";
        continue;
      }
      const body = await res.json().catch(() => ({}));
      const parsed = parseBridgeHistoryResponse(res.ok, res.status, body);
      if (!parsed.ok) {
        // `disabled` aqui significa que o store caiu para 0 no gateway (restart,
        // reprovisionamento). Vale registrar e parar: as demais conversas vão
        // responder o mesmo 501, e martelar o gateway não conserta.
        lastError = parsed.error;
        if (parsed.disabled) break;
        continue;
      }

      const rows = selectHistoryRows(parsed.rows, {
        now,
        days: config.days,
        limit: config.limit,
      });
      scanned += rows.length;

      for (const row of rows) {
        // Mais barato perguntar antes do que montar o ingest inteiro: a grande
        // maioria das linhas já veio pelo webhook.
        const existing = await ctx.runQuery(internal.conversations.internalGetMessageByExternalId, {
          organizationId: config.organizationId,
          externalId: row.messageId,
        });
        if (existing) continue;

        // MESMO parser do webhook — o `data_json` é o evento whatsmeow original.
        const event = parseBridgeEvent({ type: "Message", event: row.event });
        if (event.kind !== "message") continue;

        // SÓ mensagens que saíram do nosso número.
        //
        // É a lacuna real: a recebida chega pelo webhook e sempre chegou, a
        // enviada pelo app do celular é que sumia. E importar uma RECEBIDA
        // antiga é perigoso de um jeito que não dá para desfazer — ela entra
        // por `internalReceiveMessage`, que enfileira o atendente IA; numa org
        // em autopilot o resultado é a IA respondendo no WhatsApp a uma
        // pergunta de cinco dias atrás, para um cliente de verdade. Esse caminho
        // precisa de carimbo próprio e supressão de gatilhos antes de existir.
        if (!event.message.fromMe) continue;
        // O store do gateway é por instância, mas o JID do chat é a verdade sobre
        // com quem é a conversa. Se o parser resolveu outro telefone, algo está
        // fora do lugar (grupo, LID) e é melhor pular do que criar lead errado.
        if (event.message.from !== chat.phone) continue;

        await ctx.runAction(internal.bridge.internalIngestBridgeMessage, {
          configId: args.configId,
          message: event.message,
        });
        imported++;
      }
    }

    const detail =
      lastError && imported === 0
        ? `Falhou: ${lastError}`
        : `${imported} mensagem(ns) recuperada(s) de ${scanned} analisada(s)${lastError ? ` (último aviso: ${lastError})` : ""}`;
    await ctx.runMutation(internal.bridge.internalRecordHistorySync, {
      configId: args.configId,
      result: detail,
    });

    return { imported, scanned, detail };
  },
});
