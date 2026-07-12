import { v } from "convex/values";
import { query, action, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { encryptSecret, decryptSecret, secretLast4 } from "./lib/secretCrypto";

const GRAPH_API_BASE = "https://graph.facebook.com/v23.0";

const channelValidator = v.union(v.literal("whatsapp"));
const statusValidator = v.union(v.literal("active"), v.literal("disabled"), v.literal("error"));

// Masked shape returned to clients — encrypted fields never leave the server
function maskConfig(config: {
  _id: string;
  _creationTime: number;
  organizationId: string;
  channel: string;
  displayName: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber?: string;
  verifyToken: string;
  appSecretLast4: string;
  accessTokenLast4: string;
  status: string;
  lastHealthCheckAt?: number;
  healthDetail?: string;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    _id: config._id,
    organizationId: config.organizationId,
    channel: config.channel,
    displayName: config.displayName,
    phoneNumberId: config.phoneNumberId,
    wabaId: config.wabaId,
    displayPhoneNumber: config.displayPhoneNumber ?? null,
    verifyToken: config.verifyToken,
    appSecretMasked: `…${config.appSecretLast4}`,
    accessTokenMasked: `…${config.accessTokenLast4}`,
    hasAppSecret: true,
    hasToken: true,
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

// Create a channel config — encrypts secrets, then persists via internal mutation
export const createChannelConfig = action({
  args: {
    organizationId: v.id("organizations"),
    channel: channelValidator,
    displayName: v.string(),
    phoneNumberId: v.string(),
    wabaId: v.string(),
    verifyToken: v.string(),
    appSecret: v.string(),
    accessToken: v.string(),
  },
  returns: v.id("channelConfigs"),
  handler: async (ctx, args): Promise<Id<"channelConfigs">> => {
    const [appSecretEncrypted, accessTokenEncrypted] = await Promise.all([
      encryptSecret(args.appSecret),
      encryptSecret(args.accessToken),
    ]);

    return await ctx.runMutation(internal.channelConfigs.internalInsertConfig, {
      organizationId: args.organizationId,
      channel: args.channel,
      displayName: args.displayName,
      phoneNumberId: args.phoneNumberId.trim(),
      wabaId: args.wabaId.trim(),
      verifyToken: args.verifyToken.trim(),
      appSecretEncrypted,
      accessTokenEncrypted,
      appSecretLast4: secretLast4(args.appSecret),
      accessTokenLast4: secretLast4(args.accessToken),
    });
  },
});

// Update a channel config — re-encrypts any provided secrets
export const updateChannelConfig = action({
  args: {
    configId: v.id("channelConfigs"),
    displayName: v.optional(v.string()),
    phoneNumberId: v.optional(v.string()),
    wabaId: v.optional(v.string()),
    verifyToken: v.optional(v.string()),
    appSecret: v.optional(v.string()),
    accessToken: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const patch: Record<string, string> = {};
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
      metadata: { name: config.displayName, channel: config.channel, phoneNumberId: config.phoneNumberId },
      description: buildAuditDescription({ action: "delete", entityType: "channelConfig", metadata: { name: config.displayName } }),
      severity: "high",
      createdAt: Date.now(),
    });
    return null;
  },
});

// Health check: Graph API lookup with the decrypted token ("Test connection")
export const checkChannelHealth = action({
  args: { configId: v.id("channelConfigs") },
  returns: v.object({
    ok: v.boolean(),
    displayPhoneNumber: v.optional(v.string()),
    verifiedName: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ ok: boolean; displayPhoneNumber?: string; verifiedName?: string; error?: string }> => {
    // Permission-checked read (runs with the caller's auth context)
    const config = await ctx.runQuery(internal.channelConfigs.internalGetConfigForMember, {
      configId: args.configId,
    });

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
    displayName: v.string(),
    phoneNumberId: v.string(),
    wabaId: v.string(),
    verifyToken: v.string(),
    appSecretEncrypted: v.string(),
    accessTokenEncrypted: v.string(),
    appSecretLast4: v.string(),
    accessTokenLast4: v.string(),
  },
  returns: v.id("channelConfigs"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "settings", "manage");

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

    const now = Date.now();
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId: args.organizationId,
      channel: args.channel,
      displayName: args.displayName,
      phoneNumberId: args.phoneNumberId,
      wabaId: args.wabaId,
      verifyToken: args.verifyToken,
      appSecretEncrypted: args.appSecretEncrypted,
      accessTokenEncrypted: args.accessTokenEncrypted,
      appSecretLast4: args.appSecretLast4,
      accessTokenLast4: args.accessTokenLast4,
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
      metadata: { name: args.displayName, channel: args.channel, phoneNumberId: args.phoneNumberId },
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
    patch: v.record(v.string(), v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config) throw new Error("Channel config not found");

    const userMember = await requirePermission(ctx, config.organizationId, "settings", "manage");

    const allowedFields = new Set([
      "displayName", "phoneNumberId", "wabaId", "verifyToken",
      "appSecretEncrypted", "accessTokenEncrypted", "appSecretLast4", "accessTokenLast4",
    ]);
    for (const field of Object.keys(args.patch)) {
      if (!allowedFields.has(field)) throw new Error(`Field not updatable: ${field}`);
    }

    if (args.patch.phoneNumberId && args.patch.phoneNumberId !== config.phoneNumberId) {
      const existing = await ctx.db
        .query("channelConfigs")
        .withIndex("by_phone_number_id", (q) => q.eq("phoneNumberId", args.patch.phoneNumberId))
        .first();
      if (existing) throw new Error("Este phone number ID já está conectado");
    }
    if (args.patch.verifyToken && args.patch.verifyToken !== config.verifyToken) {
      const existing = await ctx.db
        .query("channelConfigs")
        .withIndex("by_verify_token", (q) => q.eq("verifyToken", args.patch.verifyToken))
        .first();
      if (existing) throw new Error("Este verify token já está em uso — gere outro");
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
      lastHealthCheckAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export { statusValidator as channelConfigStatusValidator };
