import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requirePermission } from "./lib/auth";
import { batchGet } from "./lib/batchGet";
import { buildAuditDescription } from "./lib/auditDescription";
import { parseCursor, buildCursorFromCreationTime, paginateResults } from "./lib/cursor";
import { scheduleWhatsappDispatch } from "./lib/whatsappDispatch";
import { applyOutboundMessageSideEffects } from "./lib/outboundSideEffects";
import { configProvider } from "./channelConfigs";
import { parseTestCommand, phoneAllowedForReset } from "./testReset";

type ConversationChannel = "whatsapp" | "telegram" | "email" | "webchat" | "internal";

// 24h Meta customer-service window. Clients compare against the clock — queries
// must stay Date.now()-free for reactivity, so we expose the expiry timestamp.
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function serviceWindowExpiresAt(conversation: { lastInboundAt?: number }): number | null {
  return conversation.lastInboundAt ? conversation.lastInboundAt + SERVICE_WINDOW_MS : null;
}

// The 24h window + templates are exclusive to the official Cloud API. The bridge
// (unofficial wuzapi) has no such window, so bridge conversations are ALWAYS free
// to message: `serviceWindowApplies` is false and no expiry is exposed. A meta
// config, or a conversation with no channelConfigId, keeps the original behavior.
// (The U5 UI reads `serviceWindowApplies` to hide the window/template controls.)
function serviceWindowFields(
  conversation: { lastInboundAt?: number },
  config: { provider?: "meta" | "bridge" | null } | null | undefined
): { serviceWindowExpiresAt: number | null; serviceWindowApplies: boolean } {
  const applies = !config || configProvider(config) !== "bridge";
  return {
    serviceWindowExpiresAt: applies ? serviceWindowExpiresAt(conversation) : null,
    serviceWindowApplies: applies,
  };
}

// Truncated preview of a message body, stored on a reply's metadata.quoted so the
// UI can render the quoted snippet without loading the original message.
function previewOf(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 140 ? `${trimmed.slice(0, 139)}…` : trimmed;
}

const LIST_PREVIEW_MAX = 80;

// Fallback label when a media message carries no caption of its own — mirrors the
// bracketed placeholders the ingress uses (see MEDIA_PLACEHOLDERS in whatsapp.ts).
function mediaPlaceholder(
  contentType: "text" | "image" | "file" | "audio",
  bridgeType: string | undefined
): string {
  if (bridgeType === "sticker") return "[figurinha]";
  if (bridgeType === "video") return "[vídeo]";
  switch (contentType) {
    case "image":
      return "[imagem]";
    case "audio":
      return "[mensagem de voz]";
    case "file":
      return "[arquivo]";
    default:
      return "";
  }
}

// The list-row summary of a conversation's most recent message: a short preview
// plus the few fields the inbox list needs to render an icon/state without
// loading the message. Internal notes are INCLUDED but prefixed with "Nota: ".
type LastMessageFields = {
  lastMessagePreview: string | null;
  lastMessageContentType: "text" | "image" | "file" | "audio" | null;
  lastMessageDirection: "inbound" | "outbound" | "internal" | null;
  lastMessageBridgeType: string | null;
};

function lastMessageFields(message: Doc<"messages"> | null): LastMessageFields {
  if (!message) {
    return {
      lastMessagePreview: null,
      lastMessageContentType: null,
      lastMessageDirection: null,
      lastMessageBridgeType: null,
    };
  }
  const bridgeType =
    typeof message.metadata?.bridgeType === "string"
      ? (message.metadata.bridgeType as string)
      : null;

  const raw = (message.content ?? "").trim();
  let body = raw.length > 0 ? raw : mediaPlaceholder(message.contentType, bridgeType ?? undefined);
  if (body.length > LIST_PREVIEW_MAX) {
    body = `${body.slice(0, LIST_PREVIEW_MAX - 1)}…`;
  }
  const preview = message.isInternal ? `Nota: ${body}` : body;

  return {
    lastMessagePreview: preview,
    lastMessageContentType: message.contentType,
    lastMessageDirection: message.direction,
    lastMessageBridgeType: bridgeType,
  };
}

// Fetch the newest message of each conversation (one indexed `.first()` per
// conversation) and index the preview fields by conversation id.
async function lastMessageFieldsByConversation(
  ctx: { db: MutationCtx["db"] | QueryCtx["db"] },
  conversationIds: Id<"conversations">[]
): Promise<Map<string, LastMessageFields>> {
  const messages = await Promise.all(
    conversationIds.map((id) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", id))
        .order("desc")
        .first()
    )
  );
  const map = new Map<string, LastMessageFields>();
  conversationIds.forEach((id, i) => {
    map.set(id, lastMessageFields(messages[i]));
  });
  return map;
}

// Guard that every attachment belongs to `organizationId`. REST callers pass file
// ids directly, so this prevents attaching another org's file. No-op when empty.
async function assertAttachmentsInOrg(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  attachments: Id<"files">[] | undefined
): Promise<void> {
  if (!attachments || attachments.length === 0) return;
  for (const fileId of attachments) {
    const file = await ctx.db.get(fileId);
    if (!file || file.organizationId !== organizationId) {
      throw new Error("Anexo inválido para esta organização");
    }
  }
}

// Build the metadata bag for an outbound reply from `replyToMessageId`. Carries
// `quoted.externalId` (the provider id used as the wuzapi StanzaId / Meta
// context.message_id) and `quotedMessageId` (our local id, for the UI link).
// Returns undefined when the target is missing or in another conversation — a bad
// reply reference is silently dropped rather than failing the send.
async function resolveReplyMeta(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  replyToMessageId: Id<"messages"> | undefined
): Promise<Record<string, unknown> | undefined> {
  if (!replyToMessageId) return undefined;
  const target = await ctx.db.get(replyToMessageId);
  if (!target || target.conversationId !== conversation._id) return undefined;
  const preview = previewOf(target.content);
  return {
    quotedMessageId: target._id,
    quoted: {
      messageId: target._id,
      ...(target.externalId ? { externalId: target.externalId } : {}),
      fromMe: target.direction === "outbound",
      ...(preview ? { preview } : {}),
    },
  };
}

// Resolve the WhatsApp config + destination phone for a conversation, mirroring
// the dispatch context resolution (per-conversation config, falling back to the
// org's default active whatsapp config). Used by mark-read / typing / reaction.
async function resolveWhatsappTarget(
  ctx: MutationCtx,
  conversation: Doc<"conversations">
): Promise<{ config: Doc<"channelConfigs"> | null; toPhone: string | null }> {
  let config = conversation.channelConfigId
    ? await ctx.db.get(conversation.channelConfigId)
    : null;
  if (!config) {
    const configs = await ctx.db
      .query("channelConfigs")
      .withIndex("by_organization", (q) => q.eq("organizationId", conversation.organizationId))
      .collect();
    config = configs.find((c) => c.channel === "whatsapp" && c.status === "active") ?? null;
  }
  const lead = await ctx.db.get(conversation.leadId);
  const contact = lead?.contactId ? await ctx.db.get(lead.contactId) : null;
  const toPhone = contact?.whatsappNumber ?? contact?.phone ?? null;
  return { config, toPhone };
}

// Get-or-create a conversation for a lead/channel pair (shared by
// createConversation, internalCreateConversation and internalReceiveMessage)
async function getOrCreateConversation(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; leadId: Id<"leads">; channel: ConversationChannel }
): Promise<Id<"conversations">> {
  const existing = await ctx.db
    .query("conversations")
    .withIndex("by_lead_and_channel", (q) =>
      q.eq("leadId", args.leadId).eq("channel", args.channel)
    )
    .first();

  if (existing) {
    return existing._id;
  }

  const now = Date.now();

  return await ctx.db.insert("conversations", {
    organizationId: args.organizationId,
    leadId: args.leadId,
    channel: args.channel,
    status: "active",
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

// Get conversations for organization
export const getConversations = query({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.optional(v.id("leads")),
    channel: v.optional(v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    )),
    assignedTo: v.optional(v.id("teamMembers")),
    limit: v.optional(v.number()),
    // Lista do inbox: false/ausente = só ativas; true = só arquivadas.
    // Ignorado quando leadId é passado (painel do lead mostra tudo).
    archived: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    let conversations;
    if (args.leadId && args.channel) {
      conversations = await ctx.db.query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.leadId!).eq("channel", args.channel!))
        .take(args.limit ?? 200);
    } else if (args.leadId) {
      conversations = await ctx.db.query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.leadId!))
        .take(args.limit ?? 200);
    } else {
      // Ordena pelo índice de última mensagem (desc) — o take(200) pega as
      // conversas com atividade mais recente, não as mais antigas por criação.
      conversations = await ctx.db.query("conversations")
        .withIndex("by_organization_and_last_message", (q) => q.eq("organizationId", args.organizationId))
        .order("desc")
        .take(args.limit ?? 200);
    }

    // Only filter by channel if we used the org-level index and channel was specified
    if (!args.leadId && args.channel) {
      conversations = conversations.filter(c => c.channel === args.channel);
    }

    if (!args.leadId) {
      conversations = conversations.filter(c =>
        args.archived ? !!c.archivedAt : !c.archivedAt
      );
    }

    // Batch fetch related data
    const leadMap = await batchGet(ctx.db, conversations.map(c => c.leadId));
    const leads = Array.from(leadMap.values());
    const [contactMap, assigneeMap, configMap, lastMessageMap] = await Promise.all([
      batchGet(ctx.db, leads.map((l: any) => l?.contactId)),
      batchGet(ctx.db, leads.map((l: any) => l?.assignedTo)),
      batchGet(ctx.db, conversations.map(c => c.channelConfigId)),
      lastMessageFieldsByConversation(ctx, conversations.map(c => c._id)),
    ]);

    const conversationsWithData = conversations.map(conversation => {
      const lead = leadMap.get(conversation.leadId) ?? null;
      const contact = lead?.contactId ? contactMap.get(lead.contactId) ?? null : null;
      const assignee = lead?.assignedTo ? assigneeMap.get(lead.assignedTo) ?? null : null;
      const config = conversation.channelConfigId ? configMap.get(conversation.channelConfigId) ?? null : null;
      if (args.assignedTo && lead?.assignedTo !== args.assignedTo) return null;
      return {
        ...conversation,
        lead,
        contact,
        assignee,
        ...serviceWindowFields(conversation, config),
        ...(lastMessageMap.get(conversation._id) ?? lastMessageFields(null)),
      };
    }).filter(Boolean);

    // Não lidas primeiro; dentro de cada grupo, última mensagem primeiro.
    conversationsWithData.sort((a: any, b: any) => {
      const aUnread = (a.unreadCount ?? 0) > 0 ? 1 : 0;
      const bUnread = (b.unreadCount ?? 0) > 0 ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
      return (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt);
    });

    return conversationsWithData;
  },
});

/**
 * Total de mensagens não lidas nas conversas ativas (badge da sidebar).
 * Mesmo gate de visibilidade do item de navegação (inbox:view_own).
 */
export const getInboxUnreadCount = query({
  args: { organizationId: v.id("organizations") },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "inbox", "view_own");
    const unreadConversations = await ctx.db
      .query("conversations")
      .withIndex("by_organization_and_unread", (q) =>
        q.eq("organizationId", args.organizationId).gt("unreadCount", 0)
      )
      .collect();
    return unreadConversations
      .filter((c) => !c.archivedAt)
      .reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
  },
});

/**
 * Uma conversa pelo id, no MESMO formato de um item de `getConversations`.
 *
 * Existe para o deep-link `/app/entrada?conversation=<id>` alcançar conversas
 * fora do take(200) da lista e conversas arquivadas. Retorna null se não existe;
 * quem não é da org leva o erro do requireAuth (isolamento multi-tenant).
 */
export const getConversationById = query({
  args: { conversationId: v.id("conversations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;

    await requireAuth(ctx, conversation.organizationId);

    const lead = await ctx.db.get(conversation.leadId);
    const [contact, assignee, config, lastMessage] = await Promise.all([
      lead?.contactId ? ctx.db.get(lead.contactId) : null,
      lead?.assignedTo ? ctx.db.get(lead.assignedTo) : null,
      conversation.channelConfigId ? ctx.db.get(conversation.channelConfigId) : null,
      ctx.db
        .query("messages")
        .withIndex("by_conversation_and_created", (q) =>
          q.eq("conversationId", conversation._id)
        )
        .order("desc")
        .first(),
    ]);

    return {
      ...conversation,
      lead,
      contact,
      assignee,
      ...serviceWindowFields(conversation, config),
      ...lastMessageFields(lastMessage),
    };
  },
});

// Get messages for conversation
export const getMessages = query({
  args: { conversationId: v.id("conversations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return [];

    await requireAuth(ctx, conversation.organizationId);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", args.conversationId))
      .take(500);

    // Batch fetch sender info
    const senderMap = await batchGet(ctx.db, messages.map(m => m.senderId));

    // Batch fetch attachment files
    const allAttachmentIds = messages.flatMap(m => m.attachments ?? []);
    const attachmentFileMap = await batchGet(ctx.db, allAttachmentIds);

    // Generate URLs for attachment files
    const attachmentUrlMap = new Map<string, string | null>();
    await Promise.all(
      Array.from(attachmentFileMap.entries()).map(async ([id, file]) => {
        const url = await ctx.storage.getUrl(file.storageId);
        attachmentUrlMap.set(id, url);
      })
    );

    const messagesWithSenders = messages.map(message => {
      const attachmentFiles = (message.attachments ?? []).map(fileId => {
        const file = attachmentFileMap.get(fileId);
        if (!file) return null;
        return {
          _id: file._id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          url: attachmentUrlMap.get(fileId) ?? null,
        };
      }).filter(Boolean);

      return {
        ...message,
        sender: message.senderId ? senderMap.get(message.senderId) ?? null : null,
        attachmentFiles,
      };
    });

    return messagesWithSenders;
  },
});

// Full-text search across the org's messages (busca do inbox). O recorte por
// data é aplicado em código — search index não suporta range em createdAt.
export const searchMessages = query({
  args: {
    organizationId: v.id("organizations"),
    searchQuery: v.string(),
    conversationId: v.optional(v.id("conversations")),
    dateFrom: v.optional(v.number()),
    dateTo: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("messages"),
      conversationId: v.id("conversations"),
      content: v.string(),
      contentType: v.union(
        v.literal("text"),
        v.literal("image"),
        v.literal("file"),
        v.literal("audio")
      ),
      direction: v.union(v.literal("inbound"), v.literal("outbound"), v.literal("internal")),
      isInternal: v.boolean(),
      createdAt: v.number(),
      channel: v.string(),
      contactName: v.string(),
      // Texto de onde o termo foi encontrado (conteúdo ou transcrição de voz).
      snippetText: v.string(),
      matchedTranscript: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    const term = args.searchQuery.trim();
    if (term.length < 2) return [];

    // Busca mais que o limite exibido para o filtro de data ainda ter material.
    // Dois índices: texto da mensagem e transcrição de nota de voz.
    const [contentHits, transcriptHits] = await Promise.all([
      ctx.db
        .query("messages")
        .withSearchIndex("search_content", (q) => {
          const scoped = q.search("content", term).eq("organizationId", args.organizationId);
          return args.conversationId ? scoped.eq("conversationId", args.conversationId) : scoped;
        })
        .take(150),
      ctx.db
        .query("messages")
        .withSearchIndex("search_transcript", (q) => {
          const scoped = q
            .search("transcriptText", term)
            .eq("organizationId", args.organizationId);
          return args.conversationId ? scoped.eq("conversationId", args.conversationId) : scoped;
        })
        .take(150),
    ]);

    const transcriptIds = new Set(transcriptHits.map((m) => m._id));
    const seen = new Set<string>();
    let results = [...contentHits, ...transcriptHits].filter((m) => {
      if (seen.has(m._id)) return false;
      seen.add(m._id);
      return true;
    });
    // Relevância não é comparável entre índices — ordena por data (padrão de chat).
    results.sort((a, b) => b.createdAt - a.createdAt);

    if (args.dateFrom !== undefined) {
      results = results.filter((m) => m.createdAt >= args.dateFrom!);
    }
    if (args.dateTo !== undefined) {
      results = results.filter((m) => m.createdAt <= args.dateTo!);
    }
    const top = results.slice(0, 50);

    const convMap = await batchGet(ctx.db, top.map((m) => m.conversationId));
    const conversationsFound = Array.from(convMap.values());
    const leadMap = await batchGet(ctx.db, conversationsFound.map((c: any) => c?.leadId));
    const leadsFound = Array.from(leadMap.values());
    const contactMap = await batchGet(ctx.db, leadsFound.map((l: any) => l?.contactId));

    return top.map((m) => {
      const conv = convMap.get(m.conversationId);
      const lead = conv?.leadId ? leadMap.get(conv.leadId) : null;
      const contact = lead?.contactId ? contactMap.get(lead.contactId) : null;
      const contactName = contact
        ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim()
        : "";
      const termLower = term.toLowerCase();
      const contentMatches = m.content.toLowerCase().includes(termLower);
      const matchedTranscript =
        transcriptIds.has(m._id) && !contentMatches && !!m.transcriptText;
      return {
        _id: m._id,
        conversationId: m.conversationId,
        content: m.content,
        contentType: m.contentType,
        direction: m.direction,
        isInternal: m.isInternal,
        createdAt: m.createdAt,
        channel: conv?.channel ?? "internal",
        contactName: contactName || lead?.name || "Contato",
        snippetText: matchedTranscript ? m.transcriptText! : m.content,
        matchedTranscript,
      };
    });
  },
});

// ── Arquivar conversa + etiquetas ──

export const setConversationArchived = mutation({
  args: { conversationId: v.id("conversations"), archived: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversa não encontrada");
    await requirePermission(ctx, conversation.organizationId, "inbox", "reply");
    await ctx.db.patch(args.conversationId, {
      archivedAt: args.archived ? Date.now() : undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const bulkSetConversationsArchived = mutation({
  args: {
    organizationId: v.id("organizations"),
    conversationIds: v.array(v.id("conversations")),
    archived: v.boolean(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "inbox", "reply");
    const now = Date.now();
    let changed = 0;
    for (const conversationId of args.conversationIds) {
      const conversation = await ctx.db.get(conversationId);
      if (!conversation || conversation.organizationId !== args.organizationId) continue;
      await ctx.db.patch(conversationId, {
        archivedAt: args.archived ? now : undefined,
        updatedAt: now,
      });
      changed++;
    }
    return changed;
  },
});

export const bulkApplyConversationLabel = mutation({
  args: {
    organizationId: v.id("organizations"),
    conversationIds: v.array(v.id("conversations")),
    labelId: v.id("conversationLabels"),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "inbox", "reply");
    const label = await ctx.db.get(args.labelId);
    if (!label || label.organizationId !== args.organizationId) {
      throw new Error("Etiqueta não encontrada");
    }
    const now = Date.now();
    let changed = 0;
    for (const conversationId of args.conversationIds) {
      const conversation = await ctx.db.get(conversationId);
      if (!conversation || conversation.organizationId !== args.organizationId) continue;
      const current = conversation.labelIds ?? [];
      if (current.includes(args.labelId)) continue;
      await ctx.db.patch(conversationId, { labelIds: [...current, args.labelId], updatedAt: now });
      changed++;
    }
    return changed;
  },
});

export const listLabels = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({
      _id: v.id("conversationLabels"),
      name: v.string(),
      color: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    const labels = await ctx.db
      .query("conversationLabels")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    labels.sort((a, b) => a.name.localeCompare(b.name));
    return labels.map((l) => ({ _id: l._id, name: l.name, color: l.color }));
  },
});

export const createLabel = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    color: v.string(),
  },
  returns: v.id("conversationLabels"),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "inbox", "reply");
    const name = args.name.trim();
    if (!name || name.length > 30) throw new Error("Nome da etiqueta obrigatório (até 30 caracteres)");
    if (!/^#[0-9a-fA-F]{6}$/.test(args.color)) throw new Error("Cor inválida");
    const existing = await ctx.db
      .query("conversationLabels")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    if (existing.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Etiqueta "${name}" já existe`);
    }
    return await ctx.db.insert("conversationLabels", {
      organizationId: args.organizationId,
      name,
      color: args.color,
      createdAt: Date.now(),
    });
  },
});

export const deleteLabel = mutation({
  args: { labelId: v.id("conversationLabels") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const label = await ctx.db.get(args.labelId);
    if (!label) return null;
    await requirePermission(ctx, label.organizationId, "inbox", "reply");
    await ctx.db.delete(args.labelId);
    // Referências penduradas em conversations.labelIds são filtradas na leitura.
    return null;
  },
});

export const toggleConversationLabel = mutation({
  args: {
    conversationId: v.id("conversations"),
    labelId: v.id("conversationLabels"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversa não encontrada");
    await requirePermission(ctx, conversation.organizationId, "inbox", "reply");
    const label = await ctx.db.get(args.labelId);
    if (!label || label.organizationId !== conversation.organizationId) {
      throw new Error("Etiqueta não encontrada");
    }
    const current = conversation.labelIds ?? [];
    const next = current.includes(args.labelId)
      ? current.filter((id) => id !== args.labelId)
      : [...current, args.labelId];
    await ctx.db.patch(args.conversationId, { labelIds: next, updatedAt: Date.now() });
    return null;
  },
});

// Presença do contato (ChatPresence do bridge): telefone → contato → lead →
// conversa whatsapp. Contato desconhecido é no-op — presença nunca cria nada.
export const internalSetContactPresence = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    phone: v.string(),
    state: v.union(v.literal("composing"), v.literal("paused")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const contact = await ctx.db
      .query("contacts")
      .withIndex("by_organization_and_phone", (q) =>
        q.eq("organizationId", args.organizationId).eq("phone", args.phone)
      )
      .first();
    if (!contact) return null;

    const lead = await ctx.db
      .query("leads")
      .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
      .first();
    if (!lead || lead.organizationId !== args.organizationId) return null;

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_lead_and_channel", (q) =>
        q.eq("leadId", lead._id).eq("channel", "whatsapp")
      )
      .first();
    if (!conversation) return null;

    await ctx.db.patch(conversation._id, {
      contactPresence: { state: args.state, at: Date.now() },
    });
    return null;
  },
});

// Send message
export const sendMessage = mutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    contentType: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))),
    isInternal: v.optional(v.boolean()),
    attachments: v.optional(v.array(v.id("files"))),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
    replyToMessageId: v.optional(v.id("messages")),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const userMember = await requireAuth(ctx, conversation.organizationId);
    await assertAttachmentsInOrg(ctx, conversation.organizationId, args.attachments);
    const replyMeta = await resolveReplyMeta(ctx, conversation, args.replyToMessageId);

    const now = Date.now();

    const messageId = await ctx.db.insert("messages", {
      organizationId: conversation.organizationId,
      conversationId: args.conversationId,
      leadId: conversation.leadId,
      direction: args.isInternal ? "internal" : "outbound",
      senderId: userMember._id,
      senderType: userMember.type === "ai" ? "ai" : "human",
      content: args.content,
      contentType: args.contentType || "text",
      attachments: args.attachments,
      isInternal: args.isInternal || false,
      mentionedUserIds: args.isInternal ? args.mentionedUserIds : undefined,
      ...(replyMeta ? { metadata: replyMeta } : {}),
      createdAt: now,
    });

    // Link attachment files back to this message
    if (args.attachments && args.attachments.length > 0) {
      await Promise.all(
        args.attachments.map((fileId) =>
          ctx.db.patch(fileId, { messageId })
        )
      );
    }

    // Update conversation
    await ctx.db.patch(args.conversationId, {
      lastMessageAt: now,
      messageCount: conversation.messageCount + 1,
      updatedAt: now,
    });

    // Update lead activity
    const lead = await ctx.db.get(conversation.leadId);
    if (lead) {
      await ctx.db.patch(conversation.leadId, {
        lastActivityAt: now,
        updatedAt: now,
        conversationStatus: "active",
      });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: conversation.organizationId,
      entityType: "message",
      entityId: messageId,
      action: "create",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      metadata: {
        conversationId: args.conversationId,
        leadId: conversation.leadId,
        isInternal: args.isInternal,
      },
      description: buildAuditDescription({ action: "create", entityType: "message", metadata: { conversationId: args.conversationId, leadId: conversation.leadId, isInternal: args.isInternal } }),
      severity: "low",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: conversation.leadId,
      type: "message_sent",
      actorId: userMember._id,
      actorType: userMember.type === "ai" ? "ai" : "human",
      content: args.isInternal ? "Internal note added" : `Message sent via ${conversation.channel}`,
      metadata: { conversationId: args.conversationId, isInternal: args.isInternal },
      createdAt: now,
    });

    // Trigger webhooks
    if (!args.isInternal) {
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: conversation.organizationId,
        event: "message.sent",
        payload: {
          messageId,
          conversationId: args.conversationId,
          leadId: conversation.leadId,
          channel: conversation.channel,
          senderType: userMember.type === "ai" ? "ai" : "human",
          senderId: userMember._id,
        },
      });
    }

    // Real channel dispatch (paced per conversation)
    if (!args.isInternal && conversation.channel === "whatsapp") {
      await scheduleWhatsappDispatch(ctx, conversation, messageId);
    }

    return messageId;
  },
});

// Forward an existing message into another conversation as a fresh outbound
// message. Copies content/contentType/attachments and stamps metadata.forwarded.
// Attachment file rows are DUPLICATED (files.messageId is 1:1 — re-pointing the
// originals would orphan them from the source message); the copies share the same
// storageId, so no bytes are re-uploaded. Requires inbox "reply"; the target
// conversation must belong to the same organization as the source message.
export const forwardMessage = mutation({
  args: {
    messageId: v.id("messages"),
    targetConversationId: v.id("conversations"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.messageId);
    if (!source) throw new Error("Message not found");

    const target = await ctx.db.get(args.targetConversationId);
    if (!target) throw new Error("Conversation not found");

    const member = await requirePermission(ctx, source.organizationId, "inbox", "reply");
    if (target.organizationId !== source.organizationId) {
      throw new Error("Conversa de destino pertence a outra organização");
    }

    const now = Date.now();

    // Duplicate the attachment file rows so the forwarded copy owns its own
    // files.messageId links while sharing the underlying storageId.
    let attachments: Id<"files">[] | undefined;
    if (source.attachments && source.attachments.length > 0) {
      const sourceFileMap = await batchGet(ctx.db, source.attachments);
      const copies: Id<"files">[] = [];
      for (const fileId of source.attachments) {
        const file = sourceFileMap.get(fileId);
        if (!file) continue;
        const copyId = await ctx.db.insert("files", {
          organizationId: target.organizationId,
          storageId: file.storageId,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          fileType: "message_attachment",
          createdAt: now,
        });
        copies.push(copyId);
      }
      attachments = copies.length > 0 ? copies : undefined;
    }

    const messageId = await ctx.db.insert("messages", {
      organizationId: target.organizationId,
      conversationId: target._id,
      leadId: target.leadId,
      direction: "outbound",
      senderId: member._id,
      senderType: member.type === "ai" ? "ai" : "human",
      content: source.content,
      contentType: source.contentType,
      attachments,
      isInternal: false,
      metadata: { forwarded: true, forwardedFromMessageId: source._id },
      createdAt: now,
    });

    // Link the duplicated files back to the new message.
    if (attachments && attachments.length > 0) {
      await Promise.all(attachments.map((fileId) => ctx.db.patch(fileId, { messageId })));
    }

    await applyOutboundMessageSideEffects(ctx, { conversation: target, member, messageId, now });

    return null;
  },
});

// Create conversation
export const createConversation = mutation({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    channel: v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    ),
  },
  returns: v.id("conversations"),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);

    return await getOrCreateConversation(ctx, args);
  },
});

// ── Internal functions (for httpAction context, no auth session) ──

// Internal: Get conversations for organization
export const internalGetConversations = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.optional(v.id("leads")),
    channel: v.optional(v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    )),
    assignedTo: v.optional(v.id("teamMembers")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 200, 500);
    const cursor = parseCursor(args.cursor);
    const overRead = limit + 1 + (cursor ? limit * 3 : 0);

    let rawConversations;
    if (args.leadId && args.channel) {
      rawConversations = await ctx.db.query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.leadId!).eq("channel", args.channel!))
        .order("desc")
        .take(overRead);
    } else if (args.leadId) {
      rawConversations = await ctx.db.query("conversations")
        .withIndex("by_lead_and_channel", (q) => q.eq("leadId", args.leadId!))
        .order("desc")
        .take(overRead);
    } else {
      rawConversations = await ctx.db.query("conversations")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .order("desc")
        .take(overRead);
    }

    // JS filters
    const jsFilters: ((c: any) => boolean)[] = [];
    if (!args.leadId && args.channel) {
      jsFilters.push(c => c.channel === args.channel);
    }
    if (cursor) {
      jsFilters.push(
        (c) =>
          c._creationTime < cursor.ts ||
          (c._creationTime === cursor.ts && c._id < cursor.id)
      );
    }

    let filtered = rawConversations;
    for (const fn of jsFilters) {
      filtered = filtered.filter(fn);
    }

    const { items: conversations, nextCursor, hasMore } = paginateResults(
      filtered, limit, buildCursorFromCreationTime
    );

    // Batch fetch related data
    const leadMap = await batchGet(ctx.db, conversations.map(c => c.leadId));
    const leads = Array.from(leadMap.values());
    const [contactMap, assigneeMap, configMap, lastMessageMap] = await Promise.all([
      batchGet(ctx.db, leads.map((l: any) => l?.contactId)),
      batchGet(ctx.db, leads.map((l: any) => l?.assignedTo)),
      batchGet(ctx.db, conversations.map(c => c.channelConfigId)),
      lastMessageFieldsByConversation(ctx, conversations.map(c => c._id)),
    ]);

    const conversationsWithData = conversations.map(conversation => {
      const lead = leadMap.get(conversation.leadId) ?? null;
      const contact = lead?.contactId ? contactMap.get(lead.contactId) ?? null : null;
      const assignee = lead?.assignedTo ? assigneeMap.get(lead.assignedTo) ?? null : null;
      const config = conversation.channelConfigId ? configMap.get(conversation.channelConfigId) ?? null : null;
      if (args.assignedTo && lead?.assignedTo !== args.assignedTo) return null;
      return {
        ...conversation,
        lead,
        contact,
        assignee,
        ...serviceWindowFields(conversation, config),
        ...(lastMessageMap.get(conversation._id) ?? lastMessageFields(null)),
      };
    }).filter(Boolean);

    return { conversations: conversationsWithData, nextCursor, hasMore };
  },
});

// Internal: Get messages for conversation. Guarda de org: conversa de outra
// org responde vazia (o chamador REST/runtime informa a org autenticada).
export const internalGetMessages = internalQuery({
  args: { conversationId: v.id("conversations"), organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.organizationId !== args.organizationId) return [];

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", args.conversationId))
      .take(500);

    // Batch fetch sender info
    const senderMap = await batchGet(ctx.db, messages.map(m => m.senderId));

    // Batch fetch attachment files
    const allAttachmentIds = messages.flatMap(m => m.attachments ?? []);
    const attachmentFileMap = await batchGet(ctx.db, allAttachmentIds);

    // Generate URLs for attachment files
    const attachmentUrlMap = new Map<string, string | null>();
    await Promise.all(
      Array.from(attachmentFileMap.entries()).map(async ([id, file]) => {
        const url = await ctx.storage.getUrl(file.storageId);
        attachmentUrlMap.set(id, url);
      })
    );

    const messagesWithSenders = messages.map(message => {
      const attachmentFiles = (message.attachments ?? []).map(fileId => {
        const file = attachmentFileMap.get(fileId);
        if (!file) return null;
        return {
          _id: file._id,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          url: attachmentUrlMap.get(fileId) ?? null,
        };
      }).filter(Boolean);

      return {
        ...message,
        sender: message.senderId ? senderMap.get(message.senderId) ?? null : null,
        attachmentFiles,
      };
    });

    return messagesWithSenders;
  },
});

// Internal: Send message
export const internalSendMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    contentType: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))),
    isInternal: v.optional(v.boolean()),
    attachments: v.optional(v.array(v.id("files"))),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
    replyToMessageId: v.optional(v.id("messages")),
    teamMemberId: v.id("teamMembers"),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    // Guarda de org: o ator tem de pertencer à org da conversa (isolação de tenant)
    if (teamMember.organizationId !== conversation.organizationId) {
      throw new Error("Membro não pertence à organização da conversa");
    }

    await assertAttachmentsInOrg(ctx, conversation.organizationId, args.attachments);
    const replyMeta = await resolveReplyMeta(ctx, conversation, args.replyToMessageId);

    const now = Date.now();

    const messageId = await ctx.db.insert("messages", {
      organizationId: conversation.organizationId,
      conversationId: args.conversationId,
      leadId: conversation.leadId,
      direction: args.isInternal ? "internal" : "outbound",
      senderId: teamMember._id,
      senderType: teamMember.type === "ai" ? "ai" : "human",
      content: args.content,
      contentType: args.contentType || "text",
      attachments: args.attachments,
      isInternal: args.isInternal || false,
      mentionedUserIds: args.isInternal ? args.mentionedUserIds : undefined,
      ...(replyMeta ? { metadata: replyMeta } : {}),
      createdAt: now,
    });

    // Link attachment files back to this message
    if (args.attachments && args.attachments.length > 0) {
      await Promise.all(
        args.attachments.map((fileId) =>
          ctx.db.patch(fileId, { messageId })
        )
      );
    }

    // Update conversation
    await ctx.db.patch(args.conversationId, {
      lastMessageAt: now,
      messageCount: conversation.messageCount + 1,
      updatedAt: now,
    });

    // Update lead activity
    const lead = await ctx.db.get(conversation.leadId);
    if (lead) {
      await ctx.db.patch(conversation.leadId, {
        lastActivityAt: now,
        updatedAt: now,
        conversationStatus: "active",
      });
    }

    // Log audit entry
    await ctx.db.insert("auditLogs", {
      organizationId: conversation.organizationId,
      entityType: "message",
      entityId: messageId,
      action: "create",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: {
        conversationId: args.conversationId,
        leadId: conversation.leadId,
        isInternal: args.isInternal,
      },
      description: buildAuditDescription({ action: "create", entityType: "message", metadata: { conversationId: args.conversationId, leadId: conversation.leadId, isInternal: args.isInternal } }),
      severity: "low",
      createdAt: now,
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: conversation.leadId,
      type: "message_sent",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      content: args.isInternal ? "Internal note added" : `Message sent via ${conversation.channel}`,
      metadata: { conversationId: args.conversationId, isInternal: args.isInternal },
      createdAt: now,
    });

    // Trigger webhooks
    if (!args.isInternal) {
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: conversation.organizationId,
        event: "message.sent",
        payload: {
          messageId,
          conversationId: args.conversationId,
          leadId: conversation.leadId,
          channel: conversation.channel,
          senderType: teamMember.type === "ai" ? "ai" : "human",
          senderId: teamMember._id,
        },
      });
    }

    // Real channel dispatch (paced per conversation)
    if (!args.isInternal && conversation.channel === "whatsapp") {
      await scheduleWhatsappDispatch(ctx, conversation, messageId);
    }

    return messageId;
  },
});

// Internal: Create conversation
export const internalCreateConversation = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    channel: v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    ),
  },
  returns: v.id("conversations"),
  handler: async (ctx, args) => {
    return await getOrCreateConversation(ctx, args);
  },
});

// Internal: Receive an inbound message from a contact (webhook ingress / external bridges).
// Idempotent on externalId: replaying the same provider message id is a no-op.
export const internalReceiveMessage = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    channel: v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    ),
    channelConfigId: v.optional(v.id("channelConfigs")),
    content: v.string(),
    contentType: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))),
    attachments: v.optional(v.array(v.id("files"))),
    externalId: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.union(v.id("messages"), v.null()),
  handler: async (ctx, args) => {
    // Idempotency: providers redeliver webhooks; the same externalId must not duplicate
    if (args.externalId) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_organization_and_external_id", (q) =>
          q.eq("organizationId", args.organizationId).eq("externalId", args.externalId)
        )
        .first();
      if (existing) return existing._id;
    }

    const lead = await ctx.db.get(args.leadId);
    if (!lead) throw new Error("Lead not found");
    if (lead.organizationId !== args.organizationId) throw new Error("Lead not in organization");

    // Comandos de teste ("/resetme", "/resetlist", "/resetother"): hard delete e
    // consulta dos leads da org de teste. Triplo gate em testReset.ts — sem a env
    // WA_TEST_RESET_PHONES (default) nada é interceptado; o telefone do remetente
    // precisa estar na allowlist. A mensagem de comando NÃO é persistida.
    const testCommand = parseTestCommand(args.content);
    if (testCommand) {
      const contact = lead.contactId ? await ctx.db.get(lead.contactId) : null;
      const phone = contact?.whatsappNumber ?? contact?.phone;
      if (phoneAllowedForReset(phone)) {
        if (testCommand.kind === "resetme") {
          await ctx.scheduler.runAfter(0, internal.testReset.internalHardResetByPhone, {
            organizationId: args.organizationId,
            phone: phone!,
          });
        } else {
          // A resposta volta pelo mesmo canal: garante a conversa aqui (o
          // comando não persiste, então ela pode ainda não existir).
          const conversationId = await getOrCreateConversation(ctx, {
            organizationId: args.organizationId,
            leadId: args.leadId,
            channel: args.channel,
          });
          await ctx.scheduler.runAfter(0, internal.testReset.internalRunTestCommand, {
            organizationId: args.organizationId,
            conversationId,
            senderPhone: phone!,
            command: testCommand.kind,
            arg: testCommand.kind === "resetother" ? testCommand.arg : "",
          });
        }
        return null;
      }
    }

    const conversationId = await getOrCreateConversation(ctx, {
      organizationId: args.organizationId,
      leadId: args.leadId,
      channel: args.channel,
    });
    const conversation = (await ctx.db.get(conversationId))!;

    const now = Date.now();

    const messageId = await ctx.db.insert("messages", {
      organizationId: args.organizationId,
      conversationId,
      leadId: args.leadId,
      direction: "inbound",
      senderType: "contact",
      content: args.content,
      contentType: args.contentType || "text",
      attachments: args.attachments,
      externalId: args.externalId,
      metadata: args.metadata,
      isInternal: false,
      createdAt: now,
    });

    // Link attachment files back to this message
    if (args.attachments && args.attachments.length > 0) {
      await Promise.all(
        args.attachments.map((fileId) => ctx.db.patch(fileId, { messageId }))
      );
    }

    // Update conversation (reopen if closed — an inbound message revives it);
    // stamp which connected number it belongs to so egress uses the right credentials
    await ctx.db.patch(conversationId, {
      status: "active",
      lastMessageAt: now,
      lastInboundAt: now, // (re)opens the 24h customer-service window
      messageCount: conversation.messageCount + 1,
      unreadCount: (conversation.unreadCount ?? 0) + 1, // zerado por markConversationRead
      updatedAt: now,
      ...(args.channelConfigId && conversation.channelConfigId !== args.channelConfigId
        ? { channelConfigId: args.channelConfigId }
        : {}),
    });

    // Update lead activity
    await ctx.db.patch(args.leadId, {
      lastActivityAt: now,
      updatedAt: now,
      conversationStatus: "active",
    });

    // Log activity
    await ctx.db.insert("activities", {
      organizationId: args.organizationId,
      leadId: args.leadId,
      type: "message_received",
      actorType: "system",
      content: `Message received via ${args.channel}`,
      metadata: { conversationId, externalId: args.externalId },
      createdAt: now,
    });

    // Trigger webhooks
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "message.received",
      payload: {
        messageId,
        conversationId,
        leadId: args.leadId,
        channel: args.channel,
        senderType: "contact",
        contactId: lead.contactId,
        externalId: args.externalId,
      },
    });

    // Voice notes: transcription is a no-op unless the channel config opts in
    if ((args.contentType === "audio") && args.attachments && args.attachments.length > 0) {
      await ctx.scheduler.runAfter(0, internal.transcription.autoTranscribe, { messageId });
    }

    // Atendente IA: ENFILEIRA (aiReplyQueue) — nunca inferência direta daqui.
    // O enqueue re-checa elegibilidade (org opt-in, agente, pausa, opt-out…)
    // e é um no-op barato quando a IA está desligada.
    await ctx.scheduler.runAfter(0, internal.attendant.internalEnqueueFromInbound, {
      messageId,
    });

    return messageId;
  },
});

// Internal: send a WhatsApp template message (re-engagement outside the 24h window)
export const internalSendTemplate = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    teamMemberId: v.id("teamMembers"),
    templateName: v.string(),
    languageCode: v.string(),
    components: v.optional(v.array(v.any())),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    const teamMember = await ctx.db.get(args.teamMemberId);
    if (!teamMember) throw new Error("Team member not found");

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    // Guarda de org: o ator tem de pertencer à org da conversa (isolação de tenant)
    if (teamMember.organizationId !== conversation.organizationId) {
      throw new Error("Membro não pertence à organização da conversa");
    }
    if (conversation.channel !== "whatsapp") {
      throw new Error("Template messages are only supported on the whatsapp channel");
    }

    // Templates are exclusive to the official WhatsApp Cloud API. Reject them for a
    // bridge config before scheduling any dispatch — never call a template on the
    // gateway. Resolve the provider the same way dispatch does: the conversation's
    // config, falling back to the org's default active whatsapp config.
    let config = conversation.channelConfigId
      ? await ctx.db.get(conversation.channelConfigId)
      : null;
    if (!config) {
      const configs = await ctx.db
        .query("channelConfigs")
        .withIndex("by_organization", (q) => q.eq("organizationId", conversation.organizationId))
        .collect();
      config = configs.find((c) => c.channel === "whatsapp" && c.status === "active") ?? null;
    }
    if (config && configProvider(config) === "bridge") {
      throw new Error(
        "Templates são exclusivos da WhatsApp Cloud API oficial e não estão disponíveis no canal bridge"
      );
    }

    const now = Date.now();

    // Best-effort rendered body — the real text lives in Meta's template definition
    const messageId = await ctx.db.insert("messages", {
      organizationId: conversation.organizationId,
      conversationId: args.conversationId,
      leadId: conversation.leadId,
      direction: "outbound",
      senderId: teamMember._id,
      senderType: teamMember.type === "ai" ? "ai" : "human",
      content: `[template] ${args.templateName}`,
      contentType: "text",
      isInternal: false,
      metadata: {
        template: {
          name: args.templateName,
          languageCode: args.languageCode,
          ...(args.components ? { components: args.components } : {}),
        },
      },
      createdAt: now,
    });

    await ctx.db.patch(args.conversationId, {
      lastMessageAt: now,
      messageCount: conversation.messageCount + 1,
      updatedAt: now,
    });

    const lead = await ctx.db.get(conversation.leadId);
    if (lead) {
      await ctx.db.patch(conversation.leadId, {
        lastActivityAt: now,
        updatedAt: now,
        conversationStatus: "active",
      });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: conversation.organizationId,
      entityType: "message",
      entityId: messageId,
      action: "create",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      metadata: {
        conversationId: args.conversationId,
        leadId: conversation.leadId,
        templateName: args.templateName,
      },
      description: buildAuditDescription({ action: "create", entityType: "message", metadata: { conversationId: args.conversationId, leadId: conversation.leadId } }),
      severity: "low",
      createdAt: now,
    });

    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: conversation.leadId,
      type: "message_sent",
      actorId: teamMember._id,
      actorType: teamMember.type === "ai" ? "ai" : "human",
      content: `Template "${args.templateName}" enviado via whatsapp`,
      metadata: { conversationId: args.conversationId, templateName: args.templateName },
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: conversation.organizationId,
      event: "message.sent",
      payload: {
        messageId,
        conversationId: args.conversationId,
        leadId: conversation.leadId,
        channel: conversation.channel,
        senderType: teamMember.type === "ai" ? "ai" : "human",
        senderId: teamMember._id,
      },
    });

    await scheduleWhatsappDispatch(ctx, conversation, messageId);

    return messageId;
  },
});

// Internal: lookup a message by provider id (early idempotency check for ingest actions)
export const internalGetMessageByExternalId = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    externalId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", args.organizationId).eq("externalId", args.externalId)
      )
      .first();
  },
});

// Internal: Update delivery status of an outbound message by provider id (e.g. WhatsApp wamid)
export const internalUpdateDeliveryStatus = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    externalId: v.string(),
    status: v.union(
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("failed")
    ),
    errorDetail: v.optional(v.string()),
  },
  returns: v.union(v.id("messages"), v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db
      .query("messages")
      .withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", args.organizationId).eq("externalId", args.externalId)
      )
      .first();

    if (!message) {
      console.warn(`Delivery status for unknown externalId: ${args.externalId}`);
      return null;
    }

    await ctx.db.patch(message._id, {
      deliveryStatus: args.status,
      ...(args.errorDetail
        ? { metadata: { ...(message.metadata ?? {}), deliveryError: args.errorDetail } }
        : {}),
    });

    return message._id;
  },
});

// A single reaction stored on a message's metadata.reactions array. One entry per
// distinct `sender` — the CONTACT is "contact"; a team member is their teamMemberId.
export interface StoredReaction {
  emoji: string;
  sender: string;
  senderName?: string;
  at: number;
}

// Upsert-or-remove one reaction on a message identified by its provider id. Shared
// by the inbound bridge path (contact reactions) and the outbound reaction path
// (team member reactions), so it is provider-agnostic. An empty `emoji` REMOVES the
// sender's reaction; a non-empty one replaces any prior reaction from that sender.
// Never bumps conversation counters — a reaction is not a message.
export const internalApplyReaction = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    targetExternalId: v.string(),
    emoji: v.string(),
    sender: v.string(),
    senderName: v.optional(v.string()),
    at: v.number(),
  },
  returns: v.union(v.id("messages"), v.null()),
  handler: async (ctx, args) => {
    const message = await ctx.db
      .query("messages")
      .withIndex("by_organization_and_external_id", (q) =>
        q.eq("organizationId", args.organizationId).eq("externalId", args.targetExternalId)
      )
      .first();

    if (!message) {
      // Target not found (e.g. reaction to a pre-integration message) — drop it.
      console.warn(`Reaction for unknown externalId: ${args.targetExternalId}`);
      return null;
    }

    const prior = (message.metadata?.reactions as StoredReaction[] | undefined) ?? [];
    const withoutSender = Array.isArray(prior)
      ? prior.filter((r) => r && r.sender !== args.sender)
      : [];
    const next =
      args.emoji.length > 0
        ? [
            ...withoutSender,
            {
              emoji: args.emoji,
              sender: args.sender,
              ...(args.senderName ? { senderName: args.senderName } : {}),
              at: args.at,
            },
          ]
        : withoutSender;

    await ctx.db.patch(message._id, {
      metadata: { ...(message.metadata ?? {}), reactions: next },
    });
    return message._id;
  },
});

// ── Reactions / read receipts / typing (public, permission-gated) ──

// React to a message as the current team member. `emoji: ""` removes the member's
// reaction. Patches metadata.reactions locally (optimistic) and, on a WhatsApp
// conversation, schedules a best-effort provider push (wuzapi /chat/react or the
// Meta reaction message). Requires inbox "reply".
export const reactToMessage = mutation({
  args: {
    messageId: v.id("messages"),
    emoji: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");
    const conversation = await ctx.db.get(message.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const member = await requirePermission(ctx, conversation.organizationId, "inbox", "reply");

    const now = Date.now();
    const prior = (message.metadata?.reactions as StoredReaction[] | undefined) ?? [];
    const withoutSender = Array.isArray(prior)
      ? prior.filter((r) => r && r.sender !== member._id)
      : [];
    const next =
      args.emoji.length > 0
        ? [...withoutSender, { emoji: args.emoji, sender: member._id, senderName: member.name, at: now }]
        : withoutSender;
    await ctx.db.patch(message._id, {
      metadata: { ...(message.metadata ?? {}), reactions: next },
    });

    // Provider push only for the whatsapp channel; other channels stay local-only.
    if (conversation.channel === "whatsapp") {
      await ctx.scheduler.runAfter(0, internal.whatsapp.internalDispatchReaction, {
        messageId: message._id,
        emoji: args.emoji,
      });
    }
    return null;
  },
});

// Mark the recent inbound messages of a conversation as read. Stamps
// metadata.readAt locally and, for a BRIDGE whatsapp conversation, sends the read
// receipts to the gateway (Meta already best-effort marks read on dispatch, so we
// don't duplicate it there). Requires inbox "view_all".
export const markConversationRead = mutation({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    await requirePermission(ctx, conversation.organizationId, "inbox", "view_all");

    const now = Date.now();

    // Zera o contador de não lidas da equipe (badge da sidebar + destaque na
    // lista) — independe dos recibos de leitura do provedor logo abaixo.
    if ((conversation.unreadCount ?? 0) > 0) {
      await ctx.db.patch(args.conversationId, { unreadCount: 0, lastReadAt: now });
    }

    // Cap the batch: the newest 20 inbound messages that carry a provider id and
    // aren't marked read yet. (Older history is left as-is.)
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(20);
    const unread = recent.filter(
      (m) => m.direction === "inbound" && !!m.externalId && !m.metadata?.readAt
    );
    if (unread.length === 0) return null;
    for (const m of unread) {
      await ctx.db.patch(m._id, { metadata: { ...(m.metadata ?? {}), readAt: now } });
    }

    if (conversation.channel === "whatsapp") {
      const { config, toPhone } = await resolveWhatsappTarget(ctx, conversation);
      if (config && configProvider(config) === "bridge" && toPhone) {
        await ctx.scheduler.runAfter(0, internal.whatsapp.internalBridgeMarkRead, {
          configId: config._id,
          chatPhone: toPhone,
          externalIds: unread.map((m) => m.externalId!),
        });
      }
    }
    return null;
  },
});

// ── Controle explícito da IA por conversa (flag durável — nada de heurística
// de "escanear mensagens recentes"; a elegibilidade do atendente lê isto) ──

// Pausa/retoma o atendente IA nesta conversa. Pausa = indefinida até reativar.
export const setAiPaused = mutation({
  args: {
    conversationId: v.id("conversations"),
    paused: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversa não encontrada");
    const member = await requirePermission(ctx, conversation.organizationId, "inbox", "reply");

    const now = Date.now();
    await ctx.db.patch(args.conversationId, {
      aiPausedUntil: args.paused ? Number.MAX_SAFE_INTEGER : undefined,
      updatedAt: now,
    });

    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: conversation.leadId,
      type: "note",
      actorId: member._id,
      actorType: "human",
      content: args.paused ? "IA pausada nesta conversa" : "IA reativada nesta conversa",
      metadata: { conversationId: args.conversationId },
      createdAt: now,
    });
    return null;
  },
});

// "Assumir conversa": pausa a IA E atribui o lead ao humano numa só transação.
// O commit transacional do atendente (internalCommitAiReply) relê estes campos —
// uma run de IA em voo aborta o envio ao ver a pausa/atribuição.
export const assumeConversation = mutation({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversa não encontrada");
    const member = await requirePermission(ctx, conversation.organizationId, "inbox", "reply");

    const now = Date.now();
    await ctx.db.patch(args.conversationId, {
      aiPausedUntil: Number.MAX_SAFE_INTEGER,
      updatedAt: now,
    });

    const lead = await ctx.db.get(conversation.leadId);
    if (lead && lead.assignedTo !== member._id) {
      await ctx.db.patch(conversation.leadId, {
        assignedTo: member._id,
        lastActivityAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("auditLogs", {
        organizationId: conversation.organizationId,
        entityType: "lead",
        entityId: conversation.leadId,
        action: "assign",
        actorId: member._id,
        actorType: "human",
        changes: {
          before: { assignedTo: lead.assignedTo },
          after: { assignedTo: member._id },
        },
        metadata: { title: lead.title, assumedConversation: true },
        description: `Assumiu a conversa e o lead '${lead.title}'`,
        severity: "medium",
        createdAt: now,
      });
    }

    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: conversation.leadId,
      type: "assignment",
      actorId: member._id,
      actorType: "human",
      content: `${member.name} assumiu a conversa (IA pausada)`,
      metadata: { conversationId: args.conversationId },
      createdAt: now,
    });
    return null;
  },
});

// Send a typing indicator ("composing") / stopped ("paused") to the contact.
// Best-effort and stateless — bridge whatsapp only (Meta Cloud API has no typing
// presence in this integration); silently no-ops otherwise. Requires inbox "reply".
export const sendTypingState = mutation({
  args: {
    conversationId: v.id("conversations"),
    state: v.union(v.literal("composing"), v.literal("paused")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    await requirePermission(ctx, conversation.organizationId, "inbox", "reply");

    if (conversation.channel !== "whatsapp") return null;
    const { config, toPhone } = await resolveWhatsappTarget(ctx, conversation);
    if (config && configProvider(config) === "bridge" && toPhone) {
      await ctx.scheduler.runAfter(0, internal.whatsapp.internalBridgeSendPresence, {
        configId: config._id,
        toPhone,
        state: args.state,
      });
    }
    return null;
  },
});
