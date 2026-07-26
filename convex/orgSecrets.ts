/**
 * Segredos por-org (BYO API key de LLM) — cifrados em repouso via
 * lib/secretCrypto (AES-256-GCM). O valor NUNCA chega a clientes: leitura
 * pública é sempre mascarada (last4); a descriptografia só acontece em actions
 * do runtime. internalGetOrgSecretEncrypted está na TOOL_DENYLIST.
 */
import { v } from "convex/values";
import { action, query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireAuth, requirePermission } from "./lib/auth";
import { encryptSecret, secretLast4 } from "./lib/secretCrypto";

// Cria um segredo (a criptografia exige action — Web Crypto + env key).
export const createOrgSecret = action({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    provider: v.optional(v.string()),
    value: v.string(),
  },
  returns: v.id("orgSecrets"),
  handler: async (ctx, args): Promise<Id<"orgSecrets">> => {
    // Guard ANTES de qualquer trabalho (mesmo padrão do provisionamento bridge).
    await ctx.runQuery(internal.channelConfigs.internalRequireSettingsManage, {
      organizationId: args.organizationId,
    });
    const value = args.value.trim();
    if (value.length < 8) throw new Error("Valor do segredo muito curto");
    const encryptedValue = await encryptSecret(value);
    return await ctx.runMutation(internal.orgSecrets.internalInsertSecret, {
      organizationId: args.organizationId,
      name: args.name.trim() || "Chave de API",
      provider: args.provider,
      encryptedValue,
      last4: secretLast4(value),
    });
  },
});

export const internalInsertSecret = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    provider: v.optional(v.string()),
    encryptedValue: v.string(),
    last4: v.string(),
  },
  returns: v.id("orgSecrets"),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const now = Date.now();
    const secretId = await ctx.db.insert("orgSecrets", {
      organizationId: args.organizationId,
      name: args.name,
      purpose: "llm-api-key",
      provider: args.provider,
      encryptedValue: args.encryptedValue,
      last4: args.last4,
      createdBy: member._id,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "orgSecret",
      entityId: secretId,
      action: "create",
      actorId: member._id,
      actorType: "human",
      metadata: { name: args.name, provider: args.provider }, // nunca o valor
      description: `Adicionou a chave de API '${args.name}'`,
      severity: "high",
      createdAt: now,
    });
    return secretId;
  },
});

// Listagem SEMPRE mascarada.
export const listOrgSecrets = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({
      _id: v.id("orgSecrets"),
      name: v.string(),
      provider: v.union(v.string(), v.null()),
      masked: v.string(),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const secrets = await ctx.db
      .query("orgSecrets")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    return secrets.map((s) => ({
      _id: s._id,
      name: s.name,
      provider: s.provider ?? null,
      masked: `…${s.last4}`,
      createdAt: s.createdAt,
    }));
  },
});

export const deleteOrgSecret = mutation({
  args: { secretId: v.id("orgSecrets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const secret = await ctx.db.get(args.secretId);
    if (!secret) return null;
    const member = await requirePermission(ctx, secret.organizationId, "settings", "manage");

    // Não deixa remover uma key em uso pelo BYO ativo.
    const org = await ctx.db.get(secret.organizationId);
    const byo = org?.settings.aiConfig?.providerConfig?.byo;
    if (byo?.apiKeyRef.id === args.secretId) {
      throw new Error("Esta chave está em uso pelo provider BYO — troque o modo antes de excluir");
    }

    await ctx.db.delete(args.secretId);
    await ctx.db.insert("auditLogs", {
      organizationId: secret.organizationId,
      entityType: "orgSecret",
      entityId: args.secretId,
      action: "delete",
      actorId: member._id,
      actorType: "human",
      metadata: { name: secret.name },
      description: `Removeu a chave de API '${secret.name}'`,
      severity: "high",
      createdAt: Date.now(),
    });
    return null;
  },
});

// SÓ para o runtime (actions do copiloto/atendente). NUNCA vira tool — está na
// TOOL_DENYLIST. Retorna o valor CIFRADO; o decrypt acontece na action chamadora.
export const internalGetOrgSecretEncrypted = internalQuery({
  args: { secretId: v.id("orgSecrets"), organizationId: v.id("organizations") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const secret = await ctx.db.get(args.secretId);
    if (!secret || secret.organizationId !== args.organizationId) return null;
    return secret.encryptedValue;
  },
});
