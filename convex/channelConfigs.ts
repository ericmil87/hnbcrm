import { v } from "convex/values";
import {
  query,
  action,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { encryptSecret, decryptSecret, secretLast4 } from "./lib/secretCrypto";
import {
  buildBridgeConnectRequest,
  buildBridgeHmacConfigRequest,
  buildBridgeProvisionRequest,
  buildBridgeQrRequest,
  buildBridgeStatusRequest,
  mapBridgeSessionState,
  parseBridgeProvisionResponse,
  parseBridgeQrResponse,
  parseBridgeStatusResponse,
  type BridgeHttpRequest,
  type BridgeSessionState,
} from "./lib/bridgeSession";

const bridgeSessionStateValidator = v.union(
  v.literal("connected"),
  v.literal("connecting"),
  v.literal("qr"),
  v.literal("disconnected"),
  v.literal("banned")
);

// Fire one wuzapi REST request (built by the pure adapter) and parse the JSON.
async function bridgeFetchJson(
  req: BridgeHttpRequest
): Promise<{ httpOk: boolean; status: number; body: unknown }> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { httpOk: res.ok, status: res.status, body };
}

const GRAPH_API_BASE = "https://graph.facebook.com/v23.0";

const channelValidator = v.union(v.literal("whatsapp"));
const providerValidator = v.union(v.literal("meta"), v.literal("bridge"));
const statusValidator = v.union(v.literal("active"), v.literal("disabled"), v.literal("error"));

// Normalize the provider of a config. Legacy rows predate the `provider` field,
// so undefined always means the original Meta Cloud API transport.
export function configProvider(config: { provider?: "meta" | "bridge" | null }): "meta" | "bridge" {
  return config.provider === "bridge" ? "bridge" : "meta";
}

// Validate + normalize a bridge REST base URL (must be http/https). Returns trimmed value.
function normalizeBridgeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("bridgeBaseUrl inválido — informe uma URL http(s) completa");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("bridgeBaseUrl deve usar http ou https");
  }
  return trimmed;
}

// Masked shape returned to clients — encrypted fields never leave the server.
// Shape stays backward-compatible for Meta configs; bridge-only fields are null
// on Meta configs and Meta-only fields are null on bridge configs.
function maskConfig(config: Doc<"channelConfigs">) {
  return {
    _id: config._id,
    organizationId: config.organizationId,
    channel: config.channel,
    provider: configProvider(config),
    displayName: config.displayName,
    // Meta fields
    phoneNumberId: config.phoneNumberId ?? null,
    wabaId: config.wabaId ?? null,
    displayPhoneNumber: config.displayPhoneNumber ?? null,
    verifyToken: config.verifyToken ?? null,
    appSecretMasked: config.appSecretLast4 ? `…${config.appSecretLast4}` : null,
    accessTokenMasked: config.accessTokenLast4 ? `…${config.accessTokenLast4}` : null,
    hasAppSecret: config.appSecretEncrypted != null,
    hasToken: config.accessTokenEncrypted != null,
    // Bridge fields
    bridgeBaseUrl: config.bridgeBaseUrl ?? null,
    bridgeInstanceId: config.bridgeInstanceId ?? null,
    bridgeTokenMasked: config.bridgeTokenLast4 ? `…${config.bridgeTokenLast4}` : null,
    hasBridgeToken: config.bridgeTokenEncrypted != null,
    bridgeSessionState: config.bridgeSessionState ?? null,
    autoTranscribeAudio: config.autoTranscribeAudio ?? false,
    status: config.status,
    lastHealthCheckAt: config.lastHealthCheckAt ?? null,
    healthDetail: config.healthDetail ?? null,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

// List channel configs for an organization (masked secrets)
export const getChannelConfigs = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");

    const configs = await ctx.db
      .query("channelConfigs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    return configs.map(maskConfig);
  },
});

// Saúde do canal WhatsApp: métricas de entrega sobre as mensagens recentes da
// org (janela `since`, teto de 1000 — `sampled` avisa quando o teto cortou).
export const getChannelStats = query({
  args: {
    organizationId: v.id("organizations"),
    since: v.number(), // timestamp do início da janela (calculado no cliente)
  },
  returns: v.object({
    sent: v.number(),
    delivered: v.number(),
    read: v.number(),
    failed: v.number(),
    inbound: v.number(),
    lastInboundAt: v.union(v.number(), v.null()),
    lastOutboundAt: v.union(v.number(), v.null()),
    sampled: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");

    const recent = await ctx.db
      .query("messages")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .take(1000);

    // Só mensagens de conversas WhatsApp contam para a saúde do canal.
    const convIds = Array.from(new Set(recent.map((m) => m.conversationId)));
    const convDocs = await Promise.all(convIds.map((id) => ctx.db.get(id)));
    const whatsappConvIds = new Set(
      convDocs.filter((c) => c?.channel === "whatsapp").map((c) => c!._id)
    );

    let sent = 0;
    let delivered = 0;
    let read = 0;
    let failed = 0;
    let inbound = 0;
    let lastInboundAt: number | null = null;
    let lastOutboundAt: number | null = null;

    for (const m of recent) {
      if (!whatsappConvIds.has(m.conversationId) || m.isInternal) continue;
      if (m.direction === "outbound") {
        if (lastOutboundAt === null) lastOutboundAt = m.createdAt;
        if (m.createdAt < args.since) continue;
        sent++;
        if (m.deliveryStatus === "delivered") delivered++;
        else if (m.deliveryStatus === "read") {
          delivered++;
          read++;
        } else if (m.deliveryStatus === "failed") failed++;
      } else if (m.direction === "inbound") {
        if (lastInboundAt === null) lastInboundAt = m.createdAt;
        if (m.createdAt >= args.since) inbound++;
      }
    }

    return {
      sent,
      delivered,
      read,
      failed,
      inbound,
      lastInboundAt,
      lastOutboundAt,
      sampled: recent.length === 1000,
    };
  },
});

// Create a channel config — encrypts secrets, then persists via internal mutation.
// `provider` defaults to "meta" for backward compatibility. Meta configs require
// the 5 Cloud API fields; bridge configs require the 3 gateway fields. Mixing
// fields across providers is rejected.
export const createChannelConfig = action({
  args: {
    organizationId: v.id("organizations"),
    channel: channelValidator,
    provider: v.optional(providerValidator),
    displayName: v.string(),
    // Meta Cloud API fields
    phoneNumberId: v.optional(v.string()),
    wabaId: v.optional(v.string()),
    verifyToken: v.optional(v.string()),
    appSecret: v.optional(v.string()),
    accessToken: v.optional(v.string()),
    // Bridge (whatsmeow/wuzapi) fields
    bridgeBaseUrl: v.optional(v.string()),
    bridgeInstanceId: v.optional(v.string()),
    bridgeToken: v.optional(v.string()),
  },
  returns: v.id("channelConfigs"),
  handler: async (ctx, args): Promise<Id<"channelConfigs">> => {
    const provider = args.provider ?? "meta";

    if (provider === "meta") {
      const { phoneNumberId, wabaId, verifyToken, appSecret, accessToken } = args;
      if (!phoneNumberId || !wabaId || !verifyToken || !appSecret || !accessToken) {
        throw new Error(
          "Configuração Meta exige phoneNumberId, wabaId, verifyToken, appSecret e accessToken"
        );
      }
      if (args.bridgeBaseUrl || args.bridgeInstanceId || args.bridgeToken) {
        throw new Error("Campos de bridge não se aplicam a um canal Meta");
      }
      const [appSecretEncrypted, accessTokenEncrypted] = await Promise.all([
        encryptSecret(appSecret),
        encryptSecret(accessToken),
      ]);
      return await ctx.runMutation(internal.channelConfigs.internalInsertConfig, {
        organizationId: args.organizationId,
        channel: args.channel,
        provider: "meta",
        displayName: args.displayName,
        phoneNumberId: phoneNumberId.trim(),
        wabaId: wabaId.trim(),
        verifyToken: verifyToken.trim(),
        appSecretEncrypted,
        accessTokenEncrypted,
        appSecretLast4: secretLast4(appSecret),
        accessTokenLast4: secretLast4(accessToken),
      });
    }

    // provider === "bridge"
    const { bridgeBaseUrl, bridgeInstanceId, bridgeToken } = args;
    if (!bridgeBaseUrl || !bridgeInstanceId || !bridgeToken) {
      throw new Error("Configuração bridge exige bridgeBaseUrl, bridgeInstanceId e bridgeToken");
    }
    if (args.phoneNumberId || args.wabaId || args.verifyToken || args.appSecret || args.accessToken) {
      throw new Error("Campos Meta não se aplicam a um canal bridge");
    }
    const normalizedUrl = normalizeBridgeBaseUrl(bridgeBaseUrl);
    const instanceId = bridgeInstanceId.trim();
    if (!instanceId) throw new Error("bridgeInstanceId não pode ser vazio");
    const bridgeTokenEncrypted = await encryptSecret(bridgeToken);
    return await ctx.runMutation(internal.channelConfigs.internalInsertConfig, {
      organizationId: args.organizationId,
      channel: args.channel,
      provider: "bridge",
      displayName: args.displayName,
      bridgeBaseUrl: normalizedUrl,
      bridgeInstanceId: instanceId,
      bridgeTokenEncrypted,
      bridgeTokenLast4: secretLast4(bridgeToken),
    });
  },
});

// Update a channel config — re-encrypts any provided secrets. The provider of an
// existing config cannot change; internalPatchConfig rejects fields that don't
// belong to the config's provider.
export const updateChannelConfig = action({
  args: {
    configId: v.id("channelConfigs"),
    displayName: v.optional(v.string()),
    // Meta fields
    phoneNumberId: v.optional(v.string()),
    wabaId: v.optional(v.string()),
    verifyToken: v.optional(v.string()),
    appSecret: v.optional(v.string()),
    accessToken: v.optional(v.string()),
    // Bridge fields
    bridgeBaseUrl: v.optional(v.string()),
    bridgeInstanceId: v.optional(v.string()),
    bridgeToken: v.optional(v.string()),
    // Shared (both providers)
    autoTranscribeAudio: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const patch: Record<string, string | boolean> = {};
    if (args.displayName !== undefined) patch.displayName = args.displayName;
    if (args.phoneNumberId !== undefined) patch.phoneNumberId = args.phoneNumberId.trim();
    if (args.wabaId !== undefined) patch.wabaId = args.wabaId.trim();
    if (args.verifyToken !== undefined) patch.verifyToken = args.verifyToken.trim();
    if (args.appSecret !== undefined) {
      patch.appSecretEncrypted = await encryptSecret(args.appSecret);
      patch.appSecretLast4 = secretLast4(args.appSecret);
    }
    if (args.accessToken !== undefined) {
      patch.accessTokenEncrypted = await encryptSecret(args.accessToken);
      patch.accessTokenLast4 = secretLast4(args.accessToken);
    }
    if (args.bridgeBaseUrl !== undefined) patch.bridgeBaseUrl = normalizeBridgeBaseUrl(args.bridgeBaseUrl);
    if (args.bridgeInstanceId !== undefined) patch.bridgeInstanceId = args.bridgeInstanceId.trim();
    if (args.bridgeToken !== undefined) {
      patch.bridgeTokenEncrypted = await encryptSecret(args.bridgeToken);
      patch.bridgeTokenLast4 = secretLast4(args.bridgeToken);
    }
    if (args.autoTranscribeAudio !== undefined) patch.autoTranscribeAudio = args.autoTranscribeAudio;

    await ctx.runMutation(internal.channelConfigs.internalPatchConfig, {
      configId: args.configId,
      patch,
    });
    return null;
  },
});

// Enable/disable a channel config
export const setChannelConfigStatus = mutation({
  args: {
    configId: v.id("channelConfigs"),
    status: v.union(v.literal("active"), v.literal("disabled")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) throw new Error("Channel config not found");

    const userMember = await requirePermission(ctx, config.organizationId, "settings", "manage");

    const now = Date.now();
    await ctx.db.patch(args.configId, { status: args.status, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: config.organizationId,
      entityType: "channelConfig",
      entityId: args.configId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      changes: { before: { status: config.status }, after: { status: args.status } },
      metadata: { name: config.displayName, channel: config.channel },
      description: buildAuditDescription({ action: "update", entityType: "channelConfig", metadata: { name: config.displayName } }),
      severity: "medium",
      createdAt: now,
    });
    return null;
  },
});

// Delete a channel config
export const deleteChannelConfig = mutation({
  args: { configId: v.id("channelConfigs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) throw new Error("Channel config not found");

    const userMember = await requirePermission(ctx, config.organizationId, "settings", "manage");

    await ctx.db.delete(args.configId);

    await ctx.db.insert("auditLogs", {
      organizationId: config.organizationId,
      entityType: "channelConfig",
      entityId: args.configId,
      action: "delete",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: {
        name: config.displayName,
        channel: config.channel,
        provider: configProvider(config),
        ...(configProvider(config) === "meta"
          ? { phoneNumberId: config.phoneNumberId }
          : { bridgeInstanceId: config.bridgeInstanceId }),
      },
      description: buildAuditDescription({ action: "delete", entityType: "channelConfig", metadata: { name: config.displayName } }),
      severity: "high",
      createdAt: Date.now(),
    });
    return null;
  },
});

// Health check: Graph API lookup with the decrypted token ("Test connection").
// For a bridge config this instead probes the wuzapi session status and maps it
// to a pairing state, recording it the same way (internalRecordHealthCheck).
export const checkChannelHealth = action({
  args: { configId: v.id("channelConfigs") },
  returns: v.object({
    ok: v.boolean(),
    displayPhoneNumber: v.optional(v.string()),
    verifiedName: v.optional(v.string()),
    error: v.optional(v.string()),
    // Bridge-only: the pairing state so the UI can react immediately.
    bridgeSessionState: v.optional(bridgeSessionStateValidator),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    ok: boolean;
    displayPhoneNumber?: string;
    verifiedName?: string;
    error?: string;
    bridgeSessionState?: BridgeSessionState;
  }> => {
    // Permission-checked read (runs with the caller's auth context)
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfigForMember, {
      configId: args.configId,
    });

    // Bridge health check: probe GET /session/status on the gateway and map the
    // connected/loggedIn flags to a pairing state + PT-BR detail.
    if (configProvider(config) === "bridge") {
      if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) {
        return { ok: false, error: "Configuração bridge incompleta — reconfigure o canal" };
      }
      try {
        const token = await decryptSecret(config.bridgeTokenEncrypted);
        const probe = await bridgeFetchJson(
          buildBridgeStatusRequest({ baseUrl: config.bridgeBaseUrl, token })
        );
        const status = parseBridgeStatusResponse(probe.httpOk, probe.status, probe.body);
        if (!status.ok) {
          await ctx.runMutation(internal.channelConfigs.internalRecordHealthCheck, {
            configId: args.configId,
            ok: false,
            healthDetail: status.error,
            bridgeSessionState: "disconnected",
          });
          return { ok: false, error: status.error, bridgeSessionState: "disconnected" };
        }
        const mapped = mapBridgeSessionState({
          connected: status.connected,
          loggedIn: status.loggedIn,
          jid: status.jid,
        });
        const ok = mapped.state === "connected";
        await ctx.runMutation(internal.channelConfigs.internalRecordHealthCheck, {
          configId: args.configId,
          ok,
          displayPhoneNumber: mapped.phone ? `+${mapped.phone}` : undefined,
          healthDetail: mapped.healthDetail,
          bridgeSessionState: mapped.state,
        });
        return {
          ok,
          displayPhoneNumber: mapped.phone ? `+${mapped.phone}` : undefined,
          error: ok ? undefined : mapped.healthDetail,
          bridgeSessionState: mapped.state,
        };
      } catch (e) {
        const error = e instanceof Error ? e.message : "Falha ao consultar o gateway bridge";
        await ctx.runMutation(internal.channelConfigs.internalRecordHealthCheck, {
          configId: args.configId,
          ok: false,
          healthDetail: error,
          bridgeSessionState: "disconnected",
        });
        return { ok: false, error, bridgeSessionState: "disconnected" };
      }
    }
    if (!config.accessTokenEncrypted || !config.phoneNumberId) {
      return { ok: false, error: "Configuração Meta incompleta — reconfigure o canal" };
    }

    let result: { ok: boolean; displayPhoneNumber?: string; verifiedName?: string; error?: string };
    try {
      const accessToken = await decryptSecret(config.accessTokenEncrypted);
      const response = await fetch(
        `${GRAPH_API_BASE}/${config.phoneNumberId}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const body = await response.json();
      if (!response.ok) {
        result = { ok: false, error: body?.error?.message ?? `Graph API error (HTTP ${response.status})` };
      } else {
        result = { ok: true, displayPhoneNumber: body.display_phone_number, verifiedName: body.verified_name };
      }
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : "Health check failed" };
    }

    await ctx.runMutation(internal.channelConfigs.internalRecordHealthCheck, {
      configId: args.configId,
      ok: result.ok,
      displayPhoneNumber: result.displayPhoneNumber,
      healthDetail: result.ok
        ? `Connected: ${result.verifiedName ?? ""} ${result.displayPhoneNumber ?? ""}`.trim()
        : result.error ?? "Health check failed",
    });

    return result;
  },
});

// Bridge pairing: bring the session up (if needed) and fetch the QR to scan.
// Returns the QR data-URI OR a state ("connected" needs no QR). NEVER returns the
// instance token. Permission: settings/manage (via internalGetConfigForMember).
export const getBridgeQrCode = action({
  args: { configId: v.id("channelConfigs") },
  returns: v.object({
    state: bridgeSessionStateValidator,
    qrCode: v.optional(v.string()),
    displayPhoneNumber: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{
    state: BridgeSessionState;
    qrCode?: string;
    displayPhoneNumber?: string;
    error?: string;
  }> => {
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfigForMember, {
      configId: args.configId,
    });
    if (configProvider(config) !== "bridge") {
      throw new Error("QR só se aplica a canais do provider bridge");
    }
    if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) {
      return { state: "disconnected", error: "Configuração bridge incompleta — reconfigure o canal" };
    }

    const record = async (
      state: BridgeSessionState,
      ok: boolean,
      healthDetail: string,
      displayPhoneNumber?: string
    ) => {
      await ctx.runMutation(internal.channelConfigs.internalRecordHealthCheck, {
        configId: args.configId,
        ok,
        displayPhoneNumber,
        healthDetail,
        bridgeSessionState: state,
      });
    };

    try {
      const token = await decryptSecret(config.bridgeTokenEncrypted);
      const baseUrl = config.bridgeBaseUrl;

      // Already paired + online? Nothing to scan — reflect "connected".
      const probe = await bridgeFetchJson(buildBridgeStatusRequest({ baseUrl, token }));
      const status = parseBridgeStatusResponse(probe.httpOk, probe.status, probe.body);
      const probedJid = status.ok ? status.jid : undefined;
      if (status.ok && status.loggedIn && status.connected) {
        const mapped = mapBridgeSessionState({ connected: true, loggedIn: true, jid: status.jid });
        await record("connected", true, mapped.healthDetail, mapped.phone ? `+${mapped.phone}` : undefined);
        return { state: "connected", displayPhoneNumber: mapped.phone ? `+${mapped.phone}` : undefined };
      }

      // Not paired (or socket down): bring the session up so a QR is issued, then
      // fetch it. A connect failure is non-fatal — the QR endpoint may still work.
      await bridgeFetchJson(buildBridgeConnectRequest({ baseUrl, token })).catch(() => undefined);

      const qrProbe = await bridgeFetchJson(buildBridgeQrRequest({ baseUrl, token }));
      const qr = parseBridgeQrResponse(qrProbe.httpOk, qrProbe.status, qrProbe.body);
      if (!qr.ok) {
        await record("disconnected", false, qr.error);
        return { state: "disconnected", error: qr.error };
      }
      // The instance may have logged in between the two calls.
      if (qr.loggedIn && !qr.qrCode) {
        const mapped = mapBridgeSessionState({ connected: true, loggedIn: true, jid: probedJid });
        await record("connected", true, mapped.healthDetail, mapped.phone ? `+${mapped.phone}` : undefined);
        return { state: "connected", displayPhoneNumber: mapped.phone ? `+${mapped.phone}` : undefined };
      }
      const mapped = mapBridgeSessionState({ connected: false, loggedIn: false, hasQr: !!qr.qrCode });
      await record(mapped.state, false, mapped.healthDetail);
      return { state: mapped.state, qrCode: qr.qrCode, error: qr.qrCode ? undefined : mapped.healthDetail };
    } catch (e) {
      const error = e instanceof Error ? e.message : "Falha ao obter o QR do gateway";
      await record("disconnected", false, error);
      return { state: "disconnected", error };
    }
  },
});

// Assisted provisioning: create a wuzapi instance via POST /admin/users (admin
// token is EPHEMERAL — passed straight to the gateway, never persisted), then
// create the bridge channelConfig with the generated per-instance token encrypted.
// Permission: settings/manage (checked up-front, before hitting the gateway).
export const provisionBridgeChannel = action({
  args: {
    organizationId: v.id("organizations"),
    displayName: v.string(),
    bridgeBaseUrl: v.string(),
    adminToken: v.string(),
    webhookUrl: v.string(),
  },
  returns: v.id("channelConfigs"),
  handler: async (ctx, args): Promise<Id<"channelConfigs">> => {
    // Guard BEFORE calling the gateway admin API — don't let a non-admin provision.
    await ctx.runQuery(internal.channelConfigs.internalRequireSettingsManage, {
      organizationId: args.organizationId,
    });

    const baseUrl = normalizeBridgeBaseUrl(args.bridgeBaseUrl);
    const adminToken = args.adminToken.trim();
    if (!adminToken) throw new Error("Admin token é obrigatório para provisionar a instância");
    const webhook = args.webhookUrl.trim();
    if (!webhook) throw new Error("URL de webhook é obrigatória para provisionar a instância");

    // The per-instance token (secret) and the instance name (= bridgeInstanceId,
    // the ingress routing key). The name must be what the gateway echoes in the
    // webhook so ingress can route it. VALIDAR against the live gateway in U6.
    const instanceToken = crypto.randomUUID().replace(/-/g, "");
    const instanceName = `org_${args.organizationId}_${Date.now().toString(36)}`;

    // O wuzapi assina webhooks por instância com a hmac_key do usuário — que só
    // pode ser definida na CRIAÇÃO. Precisa ser o mesmo segredo que o ingress
    // verifica (WA_BRIDGE_HMAC_SECRET), senão todo webhook chega sem assinatura
    // e é rejeitado com 401.
    const hmacKey = process.env.WA_BRIDGE_HMAC_SECRET;
    if (!hmacKey || hmacKey.length < 32) {
      throw new Error(
        "WA_BRIDGE_HMAC_SECRET não configurado no Convex (mín. 32 caracteres) — configure antes de provisionar"
      );
    }

    const provisionRes = await bridgeFetchJson(
      buildBridgeProvisionRequest({
        baseUrl,
        adminToken,
        name: instanceName,
        token: instanceToken,
        webhook,
        hmacKey,
      })
    );
    const provision = parseBridgeProvisionResponse(
      provisionRes.httpOk,
      provisionRes.status,
      provisionRes.body
    );
    if (!provision.ok) {
      throw new Error(provision.error);
    }

    // Ativa a assinatura HMAC no cache vivo do gateway (bug do upstream: o
    // AddUser grava a chave no banco, mas o assinador lê do cache, que só
    // carregaria no restart). Sem isso, webhooks sairiam sem assinatura e o
    // ingress rejeitaria tudo com 401.
    const hmacRes = await bridgeFetchJson(
      buildBridgeHmacConfigRequest({ baseUrl, token: instanceToken, hmacKey })
    );
    if (!hmacRes.httpOk) {
      throw new Error(
        `Instância criada no gateway, mas falhou ao ativar a assinatura HMAC (HTTP ${hmacRes.status}). ` +
          "Remova a instância no gateway (DELETE /admin/users/{id}/full) e provisione novamente."
      );
    }

    // Reuse the existing bridge-create path: encrypt the instance token + persist.
    const bridgeTokenEncrypted = await encryptSecret(instanceToken);
    return await ctx.runMutation(internal.channelConfigs.internalInsertConfig, {
      organizationId: args.organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: args.displayName,
      bridgeBaseUrl: baseUrl,
      bridgeInstanceId: instanceName,
      bridgeTokenEncrypted,
      bridgeTokenLast4: secretLast4(instanceToken),
    });
  },
});

// ── Internal functions ──

// Internal: full config for actions (includes encrypted fields — never expose to clients)
export const internalGetConfig = internalQuery({
  args: { configId: v.id("channelConfigs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.configId);
  },
});

// Internal: config lookup with the caller's permission enforced (for user-triggered actions)
export const internalGetConfigForMember = internalQuery({
  args: { configId: v.id("channelConfigs") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) throw new Error("Channel config not found");
    await requirePermission(ctx, config.organizationId, "settings", "manage");
    return config;
  },
});

// Internal: enforce settings/manage for an org (used by actions that must guard
// BEFORE side effects, e.g. calling the gateway admin API during provisioning).
export const internalRequireSettingsManage = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "manage");
    return null;
  },
});

// Internal: webhook routing lookup by Meta phone_number_id
export const internalGetConfigByPhoneNumberId = internalQuery({
  args: { phoneNumberId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("channelConfigs")
      .withIndex("by_phone_number_id", (q) => q.eq("phoneNumberId", args.phoneNumberId))
      .first();
  },
});

// Internal: bridge ingress routing lookup by wuzapi instance id
export const internalGetConfigByBridgeInstanceId = internalQuery({
  args: { bridgeInstanceId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("channelConfigs")
      .withIndex("by_bridge_instance", (q) => q.eq("bridgeInstanceId", args.bridgeInstanceId))
      .first();
  },
});

// Internal: GET handshake lookup by verify token (active configs only)
export const internalGetActiveConfigByVerifyToken = internalQuery({
  args: { verifyToken: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("channelConfigs")
      .withIndex("by_verify_token", (q) => q.eq("verifyToken", args.verifyToken))
      .first();
    return config && config.status === "active" ? config : null;
  },
});

// Internal: resolve an org's default active config for a channel (single-config orgs)
export const internalGetDefaultActiveConfig = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    channel: channelValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const configs = await ctx.db
      .query("channelConfigs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    return configs.find((c) => c.channel === args.channel && c.status === "active") ?? null;
  },
});

// Internal: insert config (admin-only via caller's auth context; audit-logged without secret values)
export const internalInsertConfig = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    channel: channelValidator,
    provider: providerValidator,
    displayName: v.string(),
    // Meta fields (present when provider === "meta")
    phoneNumberId: v.optional(v.string()),
    wabaId: v.optional(v.string()),
    verifyToken: v.optional(v.string()),
    appSecretEncrypted: v.optional(v.string()),
    accessTokenEncrypted: v.optional(v.string()),
    appSecretLast4: v.optional(v.string()),
    accessTokenLast4: v.optional(v.string()),
    // Bridge fields (present when provider === "bridge")
    bridgeBaseUrl: v.optional(v.string()),
    bridgeInstanceId: v.optional(v.string()),
    bridgeTokenEncrypted: v.optional(v.string()),
    bridgeTokenLast4: v.optional(v.string()),
  },
  returns: v.id("channelConfigs"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "settings", "manage");

    if (args.provider === "meta") {
      // phoneNumberId routes webhooks and verifyToken resolves the handshake —
      // both must be unique across the whole deployment
      const existingPhone = await ctx.db
        .query("channelConfigs")
        .withIndex("by_phone_number_id", (q) => q.eq("phoneNumberId", args.phoneNumberId))
        .first();
      if (existingPhone) throw new Error("Este phone number ID já está conectado");
      const existingToken = await ctx.db
        .query("channelConfigs")
        .withIndex("by_verify_token", (q) => q.eq("verifyToken", args.verifyToken))
        .first();
      if (existingToken) throw new Error("Este verify token já está em uso — gere outro");
    } else {
      // bridgeInstanceId is the ingress routing key — unique across the deployment
      const existingInstance = await ctx.db
        .query("channelConfigs")
        .withIndex("by_bridge_instance", (q) => q.eq("bridgeInstanceId", args.bridgeInstanceId))
        .first();
      if (existingInstance) throw new Error("Esta instância do bridge já está conectada");
    }

    const now = Date.now();
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId: args.organizationId,
      channel: args.channel,
      provider: args.provider,
      displayName: args.displayName,
      phoneNumberId: args.phoneNumberId,
      wabaId: args.wabaId,
      verifyToken: args.verifyToken,
      appSecretEncrypted: args.appSecretEncrypted,
      accessTokenEncrypted: args.accessTokenEncrypted,
      appSecretLast4: args.appSecretLast4,
      accessTokenLast4: args.accessTokenLast4,
      bridgeBaseUrl: args.bridgeBaseUrl,
      bridgeInstanceId: args.bridgeInstanceId,
      bridgeTokenEncrypted: args.bridgeTokenEncrypted,
      bridgeTokenLast4: args.bridgeTokenLast4,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "channelConfig",
      entityId: configId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: {
        name: args.displayName,
        channel: args.channel,
        provider: args.provider,
        ...(args.provider === "meta"
          ? { phoneNumberId: args.phoneNumberId }
          : { bridgeInstanceId: args.bridgeInstanceId }),
      },
      description: buildAuditDescription({ action: "create", entityType: "channelConfig", metadata: { name: args.displayName } }),
      severity: "high",
      createdAt: now,
    });

    return configId;
  },
});

// Internal: patch config (admin-only via caller's auth context; audit logs field names, not values)
export const internalPatchConfig = internalMutation({
  args: {
    configId: v.id("channelConfigs"),
    patch: v.record(v.string(), v.union(v.string(), v.boolean())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) throw new Error("Channel config not found");

    const userMember = await requirePermission(ctx, config.organizationId, "settings", "manage");

    const provider = configProvider(config);
    const META_FIELDS = new Set([
      "phoneNumberId", "wabaId", "verifyToken",
      "appSecretEncrypted", "accessTokenEncrypted", "appSecretLast4", "accessTokenLast4",
    ]);
    const BRIDGE_FIELDS = new Set([
      "bridgeBaseUrl", "bridgeInstanceId", "bridgeTokenEncrypted", "bridgeTokenLast4",
    ]);
    // Shared fields apply to both providers, so they sit outside the
    // provider-exclusivity check below.
    const SHARED_FIELDS = new Set(["displayName", "autoTranscribeAudio"]);
    const allowedFields = new Set([...SHARED_FIELDS, ...META_FIELDS, ...BRIDGE_FIELDS]);
    for (const field of Object.keys(args.patch)) {
      if (!allowedFields.has(field)) throw new Error(`Field not updatable: ${field}`);
      // A config's provider is immutable — reject fields from the other provider
      if (provider === "meta" && BRIDGE_FIELDS.has(field)) {
        throw new Error("Campos de bridge não se aplicam a um canal Meta");
      }
      if (provider === "bridge" && META_FIELDS.has(field)) {
        throw new Error("Campos Meta não se aplicam a um canal bridge");
      }
    }

    const patchPhoneNumberId = typeof args.patch.phoneNumberId === "string" ? args.patch.phoneNumberId : undefined;
    if (patchPhoneNumberId && patchPhoneNumberId !== config.phoneNumberId) {
      const existing = await ctx.db
        .query("channelConfigs")
        .withIndex("by_phone_number_id", (q) => q.eq("phoneNumberId", patchPhoneNumberId))
        .first();
      if (existing) throw new Error("Este phone number ID já está conectado");
    }
    const patchVerifyToken = typeof args.patch.verifyToken === "string" ? args.patch.verifyToken : undefined;
    if (patchVerifyToken && patchVerifyToken !== config.verifyToken) {
      const existing = await ctx.db
        .query("channelConfigs")
        .withIndex("by_verify_token", (q) => q.eq("verifyToken", patchVerifyToken))
        .first();
      if (existing) throw new Error("Este verify token já está em uso — gere outro");
    }
    const patchBridgeInstanceId =
      typeof args.patch.bridgeInstanceId === "string" ? args.patch.bridgeInstanceId : undefined;
    if (patchBridgeInstanceId && patchBridgeInstanceId !== config.bridgeInstanceId) {
      const existing = await ctx.db
        .query("channelConfigs")
        .withIndex("by_bridge_instance", (q) => q.eq("bridgeInstanceId", patchBridgeInstanceId))
        .first();
      if (existing) throw new Error("Esta instância do bridge já está conectada");
    }

    const now = Date.now();
    await ctx.db.patch(args.configId, { ...args.patch, updatedAt: now });

    // Audit which fields changed — never the values (they may be secrets)
    const changedFields = Object.keys(args.patch)
      .filter((f) => !f.endsWith("Last4"))
      .map((f) => f.replace(/Encrypted$/, ""));
    await ctx.db.insert("auditLogs", {
      organizationId: config.organizationId,
      entityType: "channelConfig",
      entityId: args.configId,
      action: "update",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: { name: config.displayName, channel: config.channel, changedFields },
      description: buildAuditDescription({ action: "update", entityType: "channelConfig", metadata: { name: config.displayName } }),
      severity: "high",
      createdAt: now,
    });
    return null;
  },
});

// Internal: store health check outcome
export const internalRecordHealthCheck = internalMutation({
  args: {
    configId: v.id("channelConfigs"),
    ok: v.boolean(),
    displayPhoneNumber: v.optional(v.string()),
    healthDetail: v.string(),
    // Bridge-only: persist the whatsmeow pairing state for the card badge.
    bridgeSessionState: v.optional(
      v.union(
        v.literal("connected"),
        v.literal("connecting"),
        v.literal("qr"),
        v.literal("disconnected"),
        v.literal("banned")
      )
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) return null;

    const now = Date.now();
    await ctx.db.patch(args.configId, {
      // A failing check marks the config as errored; a passing one restores
      // active only if it wasn't deliberately disabled
      status: args.ok ? (config.status === "disabled" ? "disabled" : "active") : "error",
      displayPhoneNumber: args.displayPhoneNumber ?? config.displayPhoneNumber,
      healthDetail: args.healthDetail,
      ...(args.bridgeSessionState ? { bridgeSessionState: args.bridgeSessionState } : {}),
      lastHealthCheckAt: now,
      updatedAt: now,
    });
    return null;
  },
});

// Internal: decrypt a bridge config's credentials for server-side gateway calls.
// Decrypt only ever runs in an action (never a query/mutation) — U2/U3 use this
// to talk to the wuzapi REST API. Never expose the returned token to clients.
export const internalGetBridgeCredentials = internalAction({
  args: { configId: v.id("channelConfigs") },
  returns: v.object({
    baseUrl: v.string(),
    instanceId: v.string(),
    token: v.string(),
  }),
  handler: async (ctx, args): Promise<{ baseUrl: string; instanceId: string; token: string }> => {
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
      configId: args.configId,
    });
    if (!config) throw new Error("Channel config not found");
    if (configProvider(config) !== "bridge") {
      throw new Error("Config não é do provider bridge");
    }
    if (!config.bridgeBaseUrl || !config.bridgeInstanceId || !config.bridgeTokenEncrypted) {
      throw new Error("Config bridge incompleta — faltam bridgeBaseUrl, bridgeInstanceId ou token");
    }
    const token = await decryptSecret(config.bridgeTokenEncrypted);
    return { baseUrl: config.bridgeBaseUrl, instanceId: config.bridgeInstanceId, token };
  },
});

export { statusValidator as channelConfigStatusValidator };
