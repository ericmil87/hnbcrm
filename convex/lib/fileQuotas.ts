/**
 * File Quota Management
 *
 * Defines storage limits by organization tier and validates upload quotas.
 */

import { QueryCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { formatFileSize, InboundMediaCheck } from "./fileValidation";

export const FILE_QUOTAS = {
  free: {
    totalStorage: 1 * 1024 * 1024 * 1024, // 1GB
    maxFileSize: 10 * 1024 * 1024, // 10MB
    uploadsPerDay: 100,
  },
  pro: {
    totalStorage: 10 * 1024 * 1024 * 1024, // 10GB
    maxFileSize: 20 * 1024 * 1024, // 20MB
    uploadsPerDay: 1000,
  },
} as const;

/**
 * Get organization tier (for now, all orgs are "free")
 * TODO: Add tier field to organizations table when billing is implemented
 */
function getOrganizationTier(_organizationId: Id<"organizations">): "free" | "pro" {
  return "free";
}

/**
 * Uso atual da org (uma única varredura de `files`), compartilhado por todas as
 * checagens de quota e pelas estatísticas.
 */
async function readOrgUsage(
  ctx: QueryCtx,
  organizationId: Id<"organizations">
): Promise<{ totalUsed: number; filesCount: number; uploadsLast24h: number }> {
  const orgFiles = await ctx.db
    .query("files")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .collect();

  const totalUsed = orgFiles.reduce((sum, file) => sum + file.size, 0);
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const uploadsLast24h = orgFiles.filter((file) => file.createdAt > oneDayAgo).length;

  return { totalUsed, filesCount: orgFiles.length, uploadsLast24h };
}

/**
 * Check if organization can upload a file (validates quota limits)
 *
 * Throws error if quota exceeded
 */
export async function checkUploadQuota(
  ctx: QueryCtx,
  args: {
    organizationId: Id<"organizations">;
    fileSize: number;
  }
): Promise<void> {
  const tier = getOrganizationTier(args.organizationId);
  const quota = FILE_QUOTAS[tier];

  // Check individual file size
  if (args.fileSize > quota.maxFileSize) {
    throw new Error(
      `Arquivo muito grande (${formatFileSize(args.fileSize)}). Máximo permitido para o plano ${tier}: ${formatFileSize(quota.maxFileSize)}`
    );
  }

  const usage = await readOrgUsage(ctx, args.organizationId);

  // Check if adding this file would exceed total storage quota
  if (usage.totalUsed + args.fileSize > quota.totalStorage) {
    throw new Error(
      `Cota de armazenamento excedida. Usando ${formatFileSize(usage.totalUsed)} de ${formatFileSize(quota.totalStorage)}. Este arquivo (${formatFileSize(args.fileSize)}) excederia o limite.`
    );
  }

  // Check daily upload limit (last 24 hours)
  if (usage.uploadsLast24h >= quota.uploadsPerDay) {
    throw new Error(
      `Limite diário de uploads atingido (${quota.uploadsPerDay} uploads nas últimas 24 horas). Plano: ${tier}.`
    );
  }
}

/**
 * Quota da mídia RECEBIDA (WhatsApp) — mesma quota da org, dois ajustes:
 *
 *  1. NÃO lança: quem manda o anexo é o contato, e a mensagem dele nunca pode
 *     cair por causa da quota (o ingest grava a mensagem sem o anexo e explica
 *     no `metadata.mediaSkipped`).
 *  2. NÃO aplica o teto POR ARQUIVO do plano: quem limita o tamanho da mídia
 *     inbound é o `MAX_MEDIA_BYTES` (25 MB) do pipeline de ingest; aplicar aqui
 *     os 10 MB do plano free rebaixaria aquele cap sem ninguém pedir.
 *
 * O anexo continua CONTANDO na quota — o total e o teto diário valem.
 */
export async function checkInboundMediaQuota(
  ctx: QueryCtx,
  args: {
    organizationId: Id<"organizations">;
    fileSize: number;
  }
): Promise<InboundMediaCheck> {
  const tier = getOrganizationTier(args.organizationId);
  const quota = FILE_QUOTAS[tier];
  const usage = await readOrgUsage(ctx, args.organizationId);

  if (usage.totalUsed + args.fileSize > quota.totalStorage) {
    return {
      ok: false,
      reason: `cota de armazenamento excedida (${formatFileSize(usage.totalUsed)} de ${formatFileSize(quota.totalStorage)})`,
    };
  }

  if (usage.uploadsLast24h >= quota.uploadsPerDay) {
    return {
      ok: false,
      reason: `limite diário de uploads atingido (${quota.uploadsPerDay} nas últimas 24 horas)`,
    };
  }

  return { ok: true };
}

/**
 * Get organization storage stats
 */
export async function getStorageStats(
  ctx: QueryCtx,
  organizationId: Id<"organizations">
): Promise<{
  tier: "free" | "pro";
  totalUsed: number;
  totalQuota: number;
  filesCount: number;
  uploadsLast24h: number;
  dailyQuota: number;
}> {
  const tier = getOrganizationTier(organizationId);
  const quota = FILE_QUOTAS[tier];
  const usage = await readOrgUsage(ctx, organizationId);

  return {
    tier,
    totalUsed: usage.totalUsed,
    totalQuota: quota.totalStorage,
    filesCount: usage.filesCount,
    uploadsLast24h: usage.uploadsLast24h,
    dailyQuota: quota.uploadsPerDay,
  };
}
