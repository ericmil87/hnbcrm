/**
 * Reprocessamento das mensagens do bridge gravadas como "[mensagem não
 * suportada]" (`metadata.bridgeType: "unknown"` + `metadata.raw`) antes do
 * parser de 07/10/2026 reconhecer álbum, enquete, localização, contato,
 * evento, convite, chamada, respostas interativas, wrappers e ruído de
 * protocolo.
 *
 * Para cada `unknown` com `raw`, reexecuta `classifyBridgeMessage` (o MESMO
 * classificador do webhook) e:
 *  - ruído (distribuição de chave do Signal, protocolo, voto cifrado…) → com
 *    `deleteContentless` (default) APAGA a linha e desconta do `unreadCount` da
 *    conversa quando era inbound ainda não lida (nunca abaixo de 0);
 *  - apagar-para-todos / edição → aplica na mensagem alvo da MESMA conversa e
 *    do MESMO autor, e apaga a bolha;
 *  - conteúdo → `patch` de `content`/`contentType`/`bridgeType`/`bridgeExtra`
 *    com o `raw` limitado (mídia que nunca foi baixada vira o mesmo estado de
 *    "mídia indisponível" do ingest: `mediaPending` + `mediaSkipped`).
 *
 * `dryRun` (default TRUE) devolve as contagens de UMA página e não escreve; o
 * real se reagenda pelo cursor até o fim. Op única — varre `messages` por org
 * (índice `by_organization`) ou a tabela inteira, filtrando em memória.
 *
 *   npx convex run opsBridgeReparse:internalReparseUnknownBridgeMessages '{"dryRun":true}'
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { boundRawForStorage, classifyBridgeMessage } from "./lib/bridgeParse";
import { sanitizeBridgeMediaMeta, stripMediaKeyMaterial } from "./lib/bridgeMedia";
import { EDIT_PREVIOUS_CONTENT_MAX } from "./lib/bridgeMessageMutations";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const SAMPLE_CAP = 10;

const resultValidator = v.object({
  dryRun: v.boolean(),
  scanned: v.number(),
  unknownFound: v.number(),
  ignoredDeleted: v.number(),
  ignoredKept: v.number(),
  revokeApplied: v.number(),
  editApplied: v.number(),
  reparsed: v.record(v.string(), v.number()),
  stillUnknown: v.record(v.string(), v.number()),
  unreadDecremented: v.number(),
  samples: v.object({
    deleted: v.array(v.id("messages")),
    reparsed: v.array(v.id("messages")),
    stillUnknown: v.array(v.id("messages")),
  }),
  isDone: v.boolean(),
  continueCursor: v.string(),
  scheduledNext: v.boolean(),
});

function bump(rec: Record<string, number>, key: string) {
  const k = key.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60) || "empty";
  rec[k] = (rec[k] ?? 0) + 1;
}

function pushSample(list: Id<"messages">[], id: Id<"messages">) {
  if (list.length < SAMPLE_CAP) list.push(id);
}

/** Inbound ainda não lido pelo time (mesma regra de `markConversationRead`). */
function wasUnread(message: Doc<"messages">, conversation: Doc<"conversations"> | null): boolean {
  if (!conversation || (conversation.unreadCount ?? 0) <= 0) return false;
  if (message.direction !== "inbound" || message.metadata?.readAt) return false;
  const lastReadAt = (conversation as { lastReadAt?: number }).lastReadAt;
  return lastReadAt === undefined || message.createdAt > lastReadAt;
}

function sameAuthor(a: Doc<"messages">, b: Doc<"messages">): boolean {
  if (a.direction !== b.direction) return false;
  if (a.direction !== "inbound") return true;
  if (a.senderLid || b.senderLid) return !!a.senderLid && a.senderLid === b.senderLid;
  if (a.senderPhone || b.senderPhone) return !!a.senderPhone && a.senderPhone === b.senderPhone;
  return true; // 1 a 1: a conversa já é do contato
}

export const internalReparseUnknownBridgeMessages = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    deleteContentless: v.optional(v.boolean()),
  },
  returns: resultValidator,
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const deleteContentless = args.deleteContentless !== false;
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(args.pageSize ?? DEFAULT_PAGE_SIZE)));
    const paginationOpts = { cursor: args.cursor ?? null, numItems: pageSize };
    const page = args.organizationId
      ? await ctx.db
          .query("messages")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId!))
          .paginate(paginationOpts)
      : await ctx.db.query("messages").paginate(paginationOpts);

    const out = {
      dryRun,
      scanned: page.page.length,
      unknownFound: 0,
      ignoredDeleted: 0,
      ignoredKept: 0,
      revokeApplied: 0,
      editApplied: 0,
      reparsed: {} as Record<string, number>,
      stillUnknown: {} as Record<string, number>,
      unreadDecremented: 0,
      samples: {
        deleted: [] as Id<"messages">[],
        reparsed: [] as Id<"messages">[],
        stillUnknown: [] as Id<"messages">[],
      },
    };

    const conversations = new Map<string, Doc<"conversations"> | null>();
    const unreadDelta = new Map<Id<"conversations">, number>();
    const getConversation = async (id: Id<"conversations">) => {
      if (!conversations.has(id)) conversations.set(id, await ctx.db.get(id));
      return conversations.get(id)!;
    };

    const deleteBubble = async (message: Doc<"messages">) => {
      if ((message.attachments ?? []).length > 0) return false; // nunca some com anexo
      const conversation = await getConversation(message.conversationId);
      if (wasUnread(message, conversation)) {
        unreadDelta.set(message.conversationId, (unreadDelta.get(message.conversationId) ?? 0) + 1);
        out.unreadDecremented++;
      }
      if (!dryRun) await ctx.db.delete(message._id);
      out.ignoredDeleted++;
      pushSample(out.samples.deleted, message._id);
      return true;
    };

    for (const message of page.page) {
      const metadata = (message.metadata ?? {}) as Record<string, any>;
      if (metadata.bridgeType !== "unknown") continue;
      const raw = metadata.raw;
      if (!raw || typeof raw !== "object" || raw._truncated === true && Array.isArray(raw.keys)) continue;
      out.unknownFound++;

      const classified = classifyBridgeMessage(raw);

      if (classified.kind === "noise") {
        if (deleteContentless) await deleteBubble(message);
        else out.ignoredKept++;
        continue;
      }

      if (classified.kind === "revoke" || classified.kind === "edit") {
        const target = await ctx.db
          .query("messages")
          .withIndex("by_organization_and_external_id", (q) =>
            q.eq("organizationId", message.organizationId).eq("externalId", classified.targetExternalId)
          )
          .first();
        if (target && target.conversationId === message.conversationId && sameAuthor(target, message)) {
          if (classified.kind === "revoke") {
            if (!dryRun && target.metadata?.revoked !== true) {
              await ctx.db.patch(target._id, {
                metadata: { ...(target.metadata ?? {}), revoked: true, revokedAt: message.createdAt },
              });
            }
            out.revokeApplied++;
          } else {
            const prior = target.metadata?.previousContent;
            if (!dryRun && target.content !== classified.newContent.content) {
              await ctx.db.patch(target._id, {
                content: classified.newContent.content,
                metadata: {
                  ...(target.metadata ?? {}),
                  edited: true,
                  editedAt: message.createdAt,
                  previousContent:
                    typeof prior === "string" ? prior : target.content.slice(0, EDIT_PREVIOUS_CONTENT_MAX),
                },
              });
            }
            out.editApplied++;
          }
        }
        if (deleteContentless) await deleteBubble(message);
        else out.ignoredKept++;
        continue;
      }

      const extracted = classified.extracted;
      const bridgeType = String(extracted.metadataExtra.bridgeType ?? "unknown");
      if (bridgeType === "unknown") {
        const extra = extracted.metadataExtra.bridgeExtra as { type?: string } | undefined;
        bump(out.stillUnknown, extra?.type ?? "empty");
        pushSample(out.samples.stillUnknown, message._id);
      } else {
        bump(out.reparsed, bridgeType);
        pushSample(out.samples.reparsed, message._id);
      }
      if (dryRun) continue;

      const { raw: _oldRaw, ...rest } = metadata;
      const nextMeta: Record<string, unknown> = {
        ...rest,
        ...extracted.metadataExtra,
        raw: stripMediaKeyMaterial(boundRawForStorage(raw)),
      };
      if (extracted.media) {
        // A mídia nunca foi baixada (o ingest antigo não a reconheceu): mesmo
        // estado de "mídia indisponível" do ingest, sem descriptor no banco.
        nextMeta.bridgeMedia = sanitizeBridgeMediaMeta(extracted.media);
        nextMeta.mediaPending = true;
        nextMeta.mediaSkipped = "Mídia não baixada (mensagem reprocessada)";
      }
      await ctx.db.patch(message._id, {
        content: extracted.content,
        contentType: extracted.contentType,
        metadata: stripMediaKeyMaterial(nextMeta) as Record<string, unknown>,
      });
    }

    if (!dryRun) {
      for (const [conversationId, delta] of unreadDelta) {
        const conversation = await getConversation(conversationId);
        if (!conversation) continue;
        await ctx.db.patch(conversationId, {
          unreadCount: Math.max(0, (conversation.unreadCount ?? 0) - delta),
        });
      }
    }

    let scheduledNext = false;
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.opsBridgeReparse.internalReparseUnknownBridgeMessages, {
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        dryRun: false,
        cursor: page.continueCursor,
        pageSize,
        deleteContentless,
      });
      scheduledNext = true;
    }
    if (!dryRun) {
      console.log(
        JSON.stringify({
          op: "reparseUnknownBridgeMessages",
          scanned: out.scanned,
          unknownFound: out.unknownFound,
          ignoredDeleted: out.ignoredDeleted,
          revokeApplied: out.revokeApplied,
          editApplied: out.editApplied,
          reparsed: out.reparsed,
          stillUnknown: out.stillUnknown,
          isDone: page.isDone,
        })
      );
    }

    return { ...out, isDone: page.isDone, continueCursor: page.continueCursor, scheduledNext };
  },
});
