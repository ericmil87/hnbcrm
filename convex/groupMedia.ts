/**
 * Mídia de grupo NÃO baixada pela política (v0.62) — o lado de banco do
 * download sob demanda e da expiração.
 *
 * A action pública mora em `groupChats.downloadDeferredMedia`; aqui ficam as
 * mutations que ela usa (trava, conclusão, liberação) e o cron diário que
 * expira o que passou dos 14 dias. A linha de `deferredGroupMedia` é a TRAVA:
 * dois cliques simultâneos disputam o `claimedUntil` numa mutation (OCC), e só
 * um deles chega a baixar — nunca dois arquivos para a mesma mensagem.
 */
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";

/**
 * Quanto tempo um clique segura a trava. O fetch do sob demanda tem timeout
 * MENOR que isto (`DEFERRED_FETCH_TIMEOUT_MS`), então a trava não vence com o
 * download ainda em voo.
 */
export const DEFERRED_CLAIM_MS = 2 * 60 * 1000;
/** Teto do fetch do sob demanda — sobra folga para gravar o blob e anexar. */
export const DEFERRED_FETCH_TIMEOUT_MS = 75 * 1000;
/** Linhas vencidas processadas por execução do cron. */
const EXPIRE_BATCH = 100;

export const DEFERRED_UNAVAILABLE_REASON =
  "Esta mídia não está mais disponível no WhatsApp";
export const DEFERRED_TOO_BIG_REASON = "A mídia é grande demais para baixar (limite de 25 MB)";

/**
 * Estado FINAL da mídia deferida: depois disto não há botão. `expired` = a CDN
 * não tem mais o blob; `tooBig` = passa do teto de 25 MB; `rejected` = tipo de
 * arquivo fora da allowlist (o motivo vai no campo).
 */
type DeferredFinal = { expired: true } | { tooBig: true } | { rejected: string };

async function markDeferredFinal(
  ctx: MutationCtx,
  message: Doc<"messages"> | null,
  final: DeferredFinal
) {
  if (!message) return;
  const deferred = message.metadata?.mediaDeferred;
  if (!deferred || typeof deferred !== "object") return;
  await ctx.db.patch(message._id, {
    metadata: { ...message.metadata, mediaDeferred: { ...deferred, ...final } },
  });
}

/** Marca `mediaDeferred.expired` na mensagem (o front esconde o botão). */
async function markDeferredExpired(ctx: MutationCtx, message: Doc<"messages"> | null) {
  const deferred = message?.metadata?.mediaDeferred as { expired?: boolean } | undefined;
  if (!deferred || deferred.expired) return;
  await markDeferredFinal(ctx, message, { expired: true });
}

const claimResult = v.union(
  v.object({ state: v.literal("done") }),
  v.object({ state: v.literal("unavailable"), reason: v.string() }),
  v.object({ state: v.literal("busy") }),
  v.object({
    state: v.literal("claimed"),
    rowId: v.id("deferredGroupMedia"),
    // O `claimedUntil` gravado por ESTE clique. Liberar e concluir só agem se
    // ele ainda casar — um clique cuja trava venceu não mexe na de outro.
    claimToken: v.number(),
    channelConfigId: v.id("channelConfigs"),
    descriptorEncrypted: v.string(),
    kind: v.string(),
    mimeType: v.optional(v.string()),
    filename: v.optional(v.string()),
    externalId: v.string(),
  })
);

/**
 * Reserva o download de UMA mensagem. Confere tudo que depende do banco: a
 * mensagem é da org pedida, a conversa é de GRUPO, ainda há mídia pendente e
 * ela não venceu. A permissão já foi checada pela action.
 */
export const internalClaimDeferredMedia = internalMutation({
  args: { organizationId: v.id("organizations"), messageId: v.id("messages") },
  returns: claimResult,
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    // Mensagem de OUTRA org responde igual a inexistente — não confirma id.
    if (!message || message.organizationId !== args.organizationId) {
      return { state: "unavailable" as const, reason: "Mensagem não encontrada" };
    }
    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation || conversation.kind !== "group") {
      return {
        state: "unavailable" as const,
        reason: "Baixar sob demanda só existe para mídia de grupo",
      };
    }
    const deferred = message.metadata?.mediaDeferred as
      | { expired?: boolean; tooBig?: boolean; rejected?: string }
      | undefined;
    if (!deferred) {
      // Idempotência: o segundo clique depois do download é sucesso.
      return (message.attachments?.length ?? 0) > 0
        ? { state: "done" as const }
        : { state: "unavailable" as const, reason: "Esta mensagem não tem mídia para baixar" };
    }
    if (deferred.tooBig === true) {
      return { state: "unavailable" as const, reason: DEFERRED_TOO_BIG_REASON };
    }
    if (typeof deferred.rejected === "string") {
      return {
        state: "unavailable" as const,
        reason: `Tipo de arquivo não aceito: ${deferred.rejected}`,
      };
    }

    const row = await ctx.db
      .query("deferredGroupMedia")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .first();
    const now = Date.now();
    if (!row || row.expiresAt <= now || deferred.expired === true) {
      await markDeferredExpired(ctx, message);
      if (row) await ctx.db.delete(row._id);
      return { state: "unavailable" as const, reason: DEFERRED_UNAVAILABLE_REASON };
    }
    if (row.claimedUntil !== undefined && row.claimedUntil > now) {
      return { state: "busy" as const };
    }
    // Carimbo estritamente novo: dois claims no mesmo milissegundo (depois de
    // uma trava vencida) não podem ganhar o mesmo token.
    const claimToken = Math.max(now + DEFERRED_CLAIM_MS, (row.claimedUntil ?? 0) + 1);
    await ctx.db.patch(row._id, { claimedUntil: claimToken });
    return {
      state: "claimed" as const,
      rowId: row._id,
      claimToken,
      channelConfigId: row.channelConfigId,
      descriptorEncrypted: row.descriptorEncrypted,
      kind: row.kind,
      ...(row.mimeType ? { mimeType: row.mimeType } : {}),
      ...(row.filename ? { filename: row.filename } : {}),
      externalId: message.externalId ?? String(message._id),
    };
  },
});

/**
 * Solta a trava depois de uma falha — só se ela ainda for DESTE clique. Com
 * `final`, a mídia não é mais baixável (blob sumiu da CDN, grande demais, tipo
 * recusado): a linha sai e a mensagem ganha o estado final.
 */
export const internalReleaseDeferredClaim = internalMutation({
  args: {
    rowId: v.id("deferredGroupMedia"),
    claimToken: v.number(),
    final: v.optional(
      v.union(
        v.object({ kind: v.literal("expired") }),
        v.object({ kind: v.literal("tooBig") }),
        v.object({ kind: v.literal("rejected"), reason: v.string() })
      )
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row || row.claimedUntil !== args.claimToken) return null;
    if (args.final) {
      const message = await ctx.db.get(row.messageId);
      const final: DeferredFinal =
        args.final.kind === "expired"
          ? { expired: true }
          : args.final.kind === "tooBig"
            ? { tooBig: true }
            : { rejected: args.final.reason };
      await markDeferredFinal(ctx, message, final);
      await ctx.db.delete(row._id);
      return null;
    }
    await ctx.db.patch(row._id, { claimedUntil: undefined });
    return null;
  },
});

/**
 * Anexa o arquivo baixado sob demanda e segue EXATAMENTE o fluxo do ingest:
 * `mediaDeferred` sai, o anexo entra, e transcrição/visão são agendadas para
 * mensagem de membro (os gates de cada uma continuam decididos lá dentro).
 *
 * Só anexa quem AINDA segura a trava. Os outros casos descartam o arquivo
 * recém-baixado (sem arquivo nem quota em dobro, sem enriquecimento 2x):
 *  - `duplicate` — outro clique já anexou (a mensagem não tem mais
 *    `mediaDeferred`): para quem pediu, é sucesso;
 *  - `stale`     — a trava passou para outro clique ou a linha venceu;
 *  - `gone`      — a mensagem foi excluída no meio.
 */
export const internalCompleteDeferredMedia = internalMutation({
  args: {
    rowId: v.id("deferredGroupMedia"),
    claimToken: v.number(),
    messageId: v.id("messages"),
    fileId: v.id("files"),
  },
  returns: v.union(
    v.literal("attached"),
    v.literal("duplicate"),
    v.literal("stale"),
    v.literal("gone")
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    const message = await ctx.db.get(args.messageId);
    const file = await ctx.db.get(args.fileId);

    const discard = async () => {
      if (!file) return;
      await deleteBlobIfUnreferenced(ctx, file);
      await ctx.db.delete(file._id);
    };

    if (!message) {
      await discard();
      if (row) await ctx.db.delete(row._id);
      return "gone" as const;
    }
    if (!message.metadata?.mediaDeferred) {
      await discard();
      return "duplicate" as const;
    }
    if (!row || row.claimedUntil !== args.claimToken) {
      await discard();
      return "stale" as const;
    }

    await ctx.db.delete(row._id);
    const metadata = { ...(message.metadata ?? {}) };
    delete metadata.mediaDeferred;
    await ctx.db.patch(message._id, {
      attachments: [...(message.attachments ?? []), args.fileId],
      metadata,
    });
    if (file) await ctx.db.patch(file._id, { messageId: message._id });

    // Mesmo gatilho de `internalReceiveGroupMessage`: só o que veio de membro.
    // A mensagem que saiu do nosso celular não é enriquecida (regra da v0.56).
    if (message.direction === "inbound") {
      await scheduleEnrichment(ctx, message._id, message.contentType);
    }
    return "attached" as const;
  },
});

async function scheduleEnrichment(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  contentType: Doc<"messages">["contentType"]
) {
  if (contentType === "audio") {
    await ctx.scheduler.runAfter(0, internal.transcription.autoTranscribe, { messageId });
  }
  if (contentType === "image") {
    await ctx.scheduler.runAfter(0, internal.vision.autoDescribe, { messageId });
  }
}

/**
 * Cron diário: apaga o descriptor cifrado vencido e marca a mensagem como
 * `mediaDeferred.expired`. Lote pequeno, auto-reagendado enquanto houver.
 */
export const internalExpireDeferredMedia = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("deferredGroupMedia")
      .withIndex("by_expires_at", (q) => q.lte("expiresAt", now))
      .take(EXPIRE_BATCH);
    for (const row of rows) {
      await markDeferredExpired(ctx, await ctx.db.get(row.messageId));
      await ctx.db.delete(row._id);
    }
    if (rows.length === EXPIRE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.groupMedia.internalExpireDeferredMedia, {});
    }
    return rows.length;
  },
});
