/**
 * File Quota Management
 *
 * Defines storage limits by organization tier and validates upload quotas.
 */

import { MutationCtx, QueryCtx } from "../_generated/server";
import { readStorageUsage, readStorageUsageForWrite } from "./storageUsage";
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

/** Uploads (linhas de `files`) nas últimas 24 h — lê no máximo `cap` docs. */
async function countUploadsLast24h(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  cap: number
): Promise<number> {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = await ctx.db
    .query("files")
    .withIndex("by_organization_and_created", (q) =>
      q.eq("organizationId", organizationId).gt("createdAt", oneDayAgo)
    )
    .take(cap);
  return recent.length;
}

/**
 * Uso atual da org: total pelo contador agregado (`lib/storageUsage.ts` — 1 doc,
 * lazy init em mutation) + uploads das últimas 24 h por range de índice, com
 * leitura limitada ao teto diário (perf Convex I/O, onda 2 — antes era um
 * `.collect()` de todos os `files` da org a cada upload/mídia recebida).
 */
async function readOrgUsage(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  opts: { persist: boolean; dailyCap: number }
): Promise<{ totalUsed: number; filesCount: number; uploadsLast24h: number }> {
  const usage = opts.persist
    ? await readStorageUsageForWrite(ctx as MutationCtx, organizationId)
    : await readStorageUsage(ctx, organizationId);
  const uploadsLast24h = await countUploadsLast24h(ctx, organizationId, opts.dailyCap);
  return { totalUsed: usage.bytes, filesCount: usage.count, uploadsLast24h };
}

/**
 * Check if organization can upload a file (validates quota limits)
 *
 * Throws error if quota exceeded
 */
export async function checkUploadQuota(
  ctx: MutationCtx,
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

  const usage = await readOrgUsage(ctx, args.organizationId, {
    persist: true,
    dailyCap: quota.uploadsPerDay,
  });

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
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    fileSize: number;
  }
): Promise<InboundMediaCheck> {
  const tier = getOrganizationTier(args.organizationId);
  const quota = FILE_QUOTAS[tier];
  const usage = await readOrgUsage(ctx, args.organizationId, {
    persist: true,
    dailyCap: quota.uploadsPerDay,
  });

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
  const usage = await readOrgUsage(ctx, organizationId, {
    persist: false,
    dailyCap: quota.uploadsPerDay,
  });

  return {
    tier,
    totalUsed: usage.totalUsed,
    totalQuota: quota.totalStorage,
    filesCount: usage.filesCount,
    uploadsLast24h: usage.uploadsLast24h,
    dailyQuota: quota.uploadsPerDay,
  };
}
