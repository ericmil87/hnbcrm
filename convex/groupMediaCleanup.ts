/**
 * Limpeza da mídia de GRUPO que já está no File Storage (v0.62).
 *
 * A política de download evita o problema daqui para a frente; isto aqui é
 * para o que a v0.57 já baixou antes dela existir (grupos de compra e venda
 * que encheram o storage da org). Op interna, sem UI:
 *
 *   npx convex run groupMediaCleanup:internalPurgeGroupMedia '{"organizationId":"…"}'
 *
 * `dryRun` é TRUE por padrão e só REPORTA (uma página por chamada — passe o
 * `nextCursor` devolvido para continuar a contagem). Com `dryRun:false` apaga
 * em lotes pequenos e se re-agenda até o fim. Rodar para valer é decisão do
 * Eric, nunca de um agente.
 *
 * O que é apagado: o blob (pelo guarda de blob compartilhado de
 * `lib/fileRefs.ts` — encaminhamento divide o mesmo `storageId`), a linha de
 * `files` e o id em `messages.attachments`. A mensagem fica, com
 * `metadata.mediaPurged = { at, kind }` para o inbox dizer "mídia removida
 * para liberar espaço". Transcrição e descrição de imagem continuam.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { deleteBlobIfUnreferenced, isStorageShared } from "./lib/fileRefs";
import { groupMediaKindOf, isGroupMessageDirectedToUs } from "./lib/groupMediaPolicy";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Arquivos por execução: pequeno no modo real (cada um = 3 escritas + blob). */
const PURGE_PAGE_REAL = 50;
const PURGE_PAGE_DRY_RUN = 200;

const purgeKindValidator = v.union(
  v.literal("image"),
  v.literal("audio"),
  v.literal("video"),
  v.literal("document"),
  v.literal("sticker")
);

export const internalPurgeGroupMedia = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    olderThanDays: v.optional(v.number()),
    kinds: v.optional(v.array(purgeKindValidator)),
    // Não apaga mídia de mensagem "com a gente" (menção, resposta a nós,
    // palavra-chave da IA, ou enviada pelo nosso número).
    keepDirected: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    scanned: v.number(),
    matched: v.number(),
    // Bytes que de fato SAEM do storage: blob com cópia encaminhada fica
    // (`lib/fileRefs.ts`) e conta em `sharedKept`, não em `bytes`.
    bytes: v.number(),
    sharedKept: v.number(),
    deleted: v.number(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const keepDirected = args.keepDirected !== false;
    const olderThanDays = Math.max(0, args.olderThanDays ?? 7);
    const now = Date.now();
    const cutoff = now - olderThanDays * DAY_MS;
    const kinds = args.kinds && args.kinds.length > 0 ? new Set<string>(args.kinds) : null;

    const numItems = dryRun ? PURGE_PAGE_DRY_RUN : PURGE_PAGE_REAL;
    const cursor = args.cursor ?? null;
    const page = args.organizationId
      ? await ctx.db
          .query("files")
          .withIndex("by_organization_and_type", (q) =>
            q.eq("organizationId", args.organizationId!).eq("fileType", "message_attachment")
          )
          .paginate({ numItems, cursor })
      : await ctx.db.query("files").paginate({ numItems, cursor });

    // Caches do lote: muitas mídias caem na mesma conversa/grupo/número.
    const conversations = new Map<string, Doc<"conversations"> | null>();
    const groups = new Map<string, Doc<"groupChats"> | null>();
    const configs = new Map<string, Doc<"channelConfigs"> | null>();
    const cached = async <T extends "conversations" | "groupChats" | "channelConfigs">(
      cache: Map<string, Doc<T> | null>,
      id: Id<T> | undefined
    ): Promise<Doc<T> | null> => {
      if (!id) return null;
      if (!cache.has(id)) cache.set(id, (await ctx.db.get(id)) as Doc<T> | null);
      return cache.get(id) ?? null;
    };

    let scanned = 0;
    let matched = 0;
    let bytes = 0;
    let sharedKept = 0;
    let deleted = 0;

    for (const file of page.page) {
      if (file.fileType !== "message_attachment" || !file.messageId) continue;
      scanned++;
      if (file.createdAt >= cutoff) continue;

      const message = await ctx.db.get(file.messageId);
      if (!message) continue;
      const conversation = await cached(conversations, message.conversationId);
      if (!conversation || conversation.kind !== "group") continue;

      const bridgeKind = (message.metadata?.bridgeMedia as { kind?: string } | undefined)?.kind;
      const kind = groupMediaKindOf(bridgeKind, message.contentType) ?? "document";
      if (kinds && !kinds.has(kind)) continue;

      if (keepDirected) {
        const group = await cached(groups, conversation.groupChatId);
        const config = await cached(configs, conversation.channelConfigId);
        const directed = isGroupMessageDirectedToUs({
          fromMe: message.direction !== "inbound",
          content: message.content,
          mentions: message.mentions,
          quotedParticipantJid: message.quotedParticipantJid,
          ourLid: config?.bridgeLid,
          ourPhone: config?.bridgePhone,
          aiMode: group?.ai?.mode,
          aiKeywords: group?.ai?.keywords,
        });
        if (directed) continue;
      }

      matched++;
      if (dryRun) {
        if (await isStorageShared(ctx, file)) sharedKept++;
        else bytes += file.size;
        continue;
      }

      if (await deleteBlobIfUnreferenced(ctx, file)) bytes += file.size;
      else sharedKept++;
      await ctx.db.delete(file._id);
      // Relê: outra mídia da MESMA mensagem pode ter sido tirada neste lote.
      const fresh = await ctx.db.get(message._id);
      if (fresh) {
        await ctx.db.patch(fresh._id, {
          attachments: (fresh.attachments ?? []).filter((id) => id !== file._id),
          metadata: { ...(fresh.metadata ?? {}), mediaPurged: { at: now, kind } },
        });
      }
      deleted++;
    }

    const nextCursor = page.isDone ? null : page.continueCursor;
    console.log(
      `[groupMediaCleanup] ${dryRun ? "dryRun" : "real"} scanned=${scanned} matched=${matched} bytes=${bytes} sharedKept=${sharedKept} deleted=${deleted} next=${nextCursor ? "sim" : "fim"}`
    );
    if (!dryRun && nextCursor) {
      await ctx.scheduler.runAfter(0, internal.groupMediaCleanup.internalPurgeGroupMedia, {
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        olderThanDays,
        ...(args.kinds ? { kinds: args.kinds } : {}),
        keepDirected,
        dryRun: false,
        cursor: nextCursor,
      });
    }
    return { scanned, matched, bytes, sharedKept, deleted, nextCursor };
  },
});
