/**
 * Estado da leitura de PDF recebido (queries/mutations; a action Node fica em
 * `pdfRead.ts`). Contrato em `messages.metadata.docRead` (ver `lib/pdfRead.ts`)
 * + texto no espelho pesquisável `messages.imageDescription`.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { withMessageSearchPatch } from "./lib/messageSearch";
import { attendantActive, visionEnabledForOrg } from "./lib/mediaEnrichment";
import {
  DocReadMeta,
  docReadOf,
  isPdfCandidate,
  isDocReadStale,
  PDF_READ_PENDING_RETRY_AFTER_MS,
  PDF_READ_STALE_CODE,
  pdfLabelName,
} from "./lib/pdfRead";

const docReadResultValidator = v.object({
  messageId: v.id("messages"),
  organizationId: v.id("organizations"),
  storageId: v.string(),
  size: v.number(),
  fileName: v.string(),
  /** O passe de visão está ligado (ramo do PDF escaneado). */
  visionOn: v.boolean(),
});

/** Leitura elegível? `null` = skip limpo (gate de produto, tipo, apagada). */
export const internalGetPdfForRead = internalQuery({
  args: { messageId: v.id("messages") },
  returns: v.union(docReadResultValidator, v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.contentType !== "file" || message.isInternal) return null;
    if (message.metadata?.deletedByCustomer === true || message.metadata?.revoked === true) return null;
    const fileId = message.attachments?.[0];
    if (!fileId) return null;
    const file = await ctx.db.get(fileId);
    if (!file || file.organizationId !== message.organizationId) return null;
    if (!isPdfCandidate(file.mimeType, file.name)) return null;
    const org = await ctx.db.get(message.organizationId);
    if (!attendantActive(org)) return null;
    return {
      messageId: message._id,
      organizationId: message.organizationId,
      storageId: file.storageId,
      size: file.size,
      fileName: pdfLabelName(file.name),
      visionOn: visionEnabledForOrg(org),
    };
  },
});

/**
 * Claim transacional (idempotência, uma leitura por arquivo): o porto de
 * agendamento grava `pending` SEM `claimedAt`; quem ganha o claim carimba
 * `claimedAt`. Resultado final (`done|scanned|failed|skipped`) nunca é refeito
 * sem `force` (reprocesso por ops).
 */
export const internalClaimPdfRead = internalMutation({
  args: { messageId: v.id("messages"), force: v.optional(v.boolean()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.metadata?.deletedByCustomer === true) return false;
    const existing = docReadOf(message.metadata);
    const now = Date.now();
    if (existing && !args.force) {
      if (existing.status !== "pending") return false;
      if (isDocReadStale(existing, now)) {
        // A action anterior morreu: não reabre (o atendente já seguiu sem o texto).
        await ctx.db.patch(args.messageId, {
          metadata: { ...(message.metadata ?? {}), docRead: { ...existing, status: "failed", at: now, error: PDF_READ_STALE_CODE } },
        });
        return false;
      }
      if (existing.claimedAt !== undefined && now - existing.claimedAt < PDF_READ_PENDING_RETRY_AFTER_MS) return false;
    }
    const metadata = { ...(message.metadata ?? {}) };
    const docRead: DocReadMeta = {
      status: "pending",
      at: existing?.at ?? now,
      claimedAt: now,
      kind: "pdf",
      ...(existing?.fileName ? { fileName: existing.fileName } : {}),
    };
    metadata.docRead = docRead;
    if (args.force) {
      // Reprocesso: o `vision` em cache de um PDF escaneado curto-circuitaria a nova leitura.
      delete metadata.vision;
      await ctx.db.patch(args.messageId, withMessageSearchPatch(message, { metadata, imageDescription: undefined }));
    } else {
      await ctx.db.patch(args.messageId, { metadata });
    }
    return true;
  },
});

export const internalSetPdfReadResult = internalMutation({
  args: {
    messageId: v.id("messages"),
    status: v.union(v.literal("done"), v.literal("scanned"), v.literal("failed"), v.literal("skipped")),
    text: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    pages: v.optional(v.number()),
    pagesRead: v.optional(v.number()),
    viaVision: v.optional(v.boolean()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    // Apagada pelo cliente: resultado tardio não devolve o conteúdo que ele apagou.
    if (!message || message.metadata?.deletedByCustomer === true) return null;
    const prev = docReadOf(message.metadata);
    const docRead: DocReadMeta = {
      status: args.status,
      at: Date.now(),
      kind: "pdf",
      ...(prev?.fileName ? { fileName: prev.fileName } : {}),
      ...(args.text !== undefined ? { chars: args.text.length } : {}),
      ...(args.truncated !== undefined ? { truncated: args.truncated } : {}),
      ...(args.pages !== undefined ? { pages: args.pages } : {}),
      ...(args.pagesRead !== undefined ? { pagesRead: args.pagesRead } : {}),
      ...(args.viaVision !== undefined ? { viaVision: args.viaVision } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    };
    const metadata = { ...(message.metadata ?? {}), docRead };
    await ctx.db.patch(
      args.messageId,
      args.status === "done" && args.text
        ? withMessageSearchPatch(message, { metadata, imageDescription: args.text })
        : { metadata }
    );
    return null;
  },
});

/**
 * Ops: reprocessa UMA mensagem (`messageId`) ou os PDFs recebidos nas últimas
 * `hours` horas de uma org (`organizationId`; teto `limit` ≤ 20, varre as
 * `scanLimit` ≤ 1000 mensagens mais novas da org). `dryRun` padrão true: só
 * conta e mostra o plano, com ids encurtados; nada de nome de arquivo nem texto.
 * Execução real: reabre o claim com `force` (limpa texto e visão em cache) e
 * agenda a action. Sem auditoria por linha (ops).
 */
export const internalReprocessPdfs = internalMutation({
  args: {
    messageId: v.optional(v.id("messages")),
    organizationId: v.optional(v.id("organizations")),
    hours: v.optional(v.number()),
    limit: v.optional(v.number()),
    scanLimit: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    eligible: v.number(),
    scheduled: v.number(),
    items: v.array(
      v.object({ id: v.string(), direction: v.string(), status: v.string(), eligible: v.boolean() })
    ),
    note: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    if ((args.messageId === undefined) === (args.organizationId === undefined)) {
      return { dryRun, scanned: 0, eligible: 0, scheduled: 0, items: [], note: "Informe messageId OU organizationId." };
    }
    const limit = Math.min(20, Math.max(1, Math.floor(Number.isFinite(args.limit) ? args.limit! : 5)));
    const scanLimit = Math.min(1000, Math.max(1, Math.floor(Number.isFinite(args.scanLimit) ? args.scanLimit! : 400)));
    const hours = Math.min(24 * 14, Math.max(1, Number.isFinite(args.hours) ? args.hours! : 24));
    const cutoff = Date.now() - hours * 3_600_000;

    const ids: Id<"messages">[] = [];
    let scanned = 0;
    if (args.messageId) {
      ids.push(args.messageId);
      scanned = 1;
    } else {
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId!))
        .order("desc")
        .take(scanLimit);
      for (const m of recent) {
        scanned++;
        if (m._creationTime < cutoff) break;
        if (m.contentType === "file" && m.direction === "inbound") ids.push(m._id);
        if (ids.length >= limit) break;
      }
    }

    const items: Array<{ id: string; direction: string; status: string; eligible: boolean }> = [];
    let eligible = 0;
    let scheduled = 0;
    for (const id of ids.slice(0, limit)) {
      const m = await ctx.db.get(id);
      if (!m || m.contentType !== "file") continue;
      const fileId = m.attachments?.[0];
      const file = fileId ? await ctx.db.get(fileId) : null;
      const org = await ctx.db.get(m.organizationId);
      const ok =
        !!file &&
        file.organizationId === m.organizationId &&
        isPdfCandidate(file.mimeType, file.name) &&
        attendantActive(org) &&
        m.metadata?.deletedByCustomer !== true;
      items.push({
        id: `…${String(id).slice(-6)}`,
        direction: m.direction,
        status: docReadOf(m.metadata)?.status ?? "none",
        eligible: ok,
      });
      if (!ok) continue;
      eligible++;
      if (dryRun) continue;
      await ctx.scheduler.runAfter(0, internal.pdfRead.internalReadPdf, { messageId: id, force: true });
      scheduled++;
    }
    return { dryRun, scanned, eligible, scheduled, items };
  },
});
