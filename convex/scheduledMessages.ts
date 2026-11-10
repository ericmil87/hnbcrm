import { v } from "convex/values";
import { query, mutation, internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { scheduleOutboundDispatch } from "./lib/outboundDispatch";
import { getLeadRef } from "./lib/leadRef";
import { assertGroupConversationSendable, resolveGroupMentions } from "./lib/groupGuard";
import { firstResponsePatch } from "./lib/conversationTiming";
import { lastMessagePatchForId } from "./lib/conversationListFields";
import { scheduleWebhookEvent } from "./lib/webhookDispatch";
import { outboundTranslationInsertFields } from "./lib/translationOps";
import { withMessageSearch } from "./lib/messageSearch";
import { assertOutboundAllowed, outboundBlockedFor } from "./lib/readOnly";

/** Em modo leitura a agendada é reavaliada a cada 6 h (pending, nunca failed). */
export const READ_ONLY_RECHECK_MS = 6 * 60 * 60 * 1000;
/** Depois de 30 dias retida em modo leitura, a agendada expira. */
export const READ_ONLY_HOLD_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** Retida e vencida há mais de 24 h ao voltar o plano: não sai, expira. */
export const READ_ONLY_STALE_MS = 24 * 60 * 60 * 1000;
const EXPIRED_IN_READ_ONLY = "Expirou durante o modo leitura";

async function expireScheduled(ctx: MutationCtx, row: Doc<"scheduledMessages">, now: number): Promise<void> {
  await ctx.db.patch(row._id, { status: "canceled", error: EXPIRED_IN_READ_ONLY, scheduledFunctionId: undefined });
  // Só audit (sem notificação): o aviso ao autor exigiria um tipo novo de sino + preferências.
  await ctx.db.insert("auditLogs", {
    organizationId: row.organizationId,
    entityType: "scheduledMessage",
    entityId: row._id,
    action: "update",
    actorId: row.createdBy,
    actorType: "system",
    changes: { before: { status: "pending" }, after: { status: "canceled" } },
    metadata: { reason: "read_only_expired", scheduledAt: row.scheduledAt },
    description: `Mensagem agendada cancelada: ${EXPIRED_IN_READ_ONLY.toLowerCase()}`,
    severity: "medium",
    createdAt: now,
  });
}

const scheduledTranslationValidator = v.object({
  authoredText: v.string(),
  sourceLang: v.string(),
  targetLang: v.string(),
  edited: v.optional(v.boolean()),
});

// Mensagens agendadas: o composer agenda um texto para uma conversa; a entrega
// roda via ctx.scheduler.runAt e reaproveita o mesmo caminho de dispatch do
// sendMessage (pacing, canal WhatsApp, webhooks).

export const schedule = mutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
    scheduledAt: v.number(),
    // Sala de GRUPO: JIDs mencionados (mesma semântica do `sendMessage`).
    // Validados contra os participantes na hora da ENTREGA — quem saiu da sala
    // entre o agendamento e o envio não é notificado.
    mentions: v.optional(v.array(v.string())),
    // Tradução automática (F3): mesmos args do `sendMessage`. Com `translation`
    // o `content` já é o traduzido (prévia do composer) e a entrega sai `done`.
    language: v.optional(v.string()),
    translation: v.optional(scheduledTranslationValidator),
  },
  returns: v.id("scheduledMessages"),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversa não encontrada");
    const userMember = await requirePermission(
      ctx,
      conversation.organizationId,
      "inbox",
      "reply"
    );
    // Modo leitura (B7): não cria envio novo (o que já estava agendado fica pending).
    await assertOutboundAllowed(ctx, conversation.organizationId);
    // Sala de grupo: mesmas guardas do envio imediato. Agendar para uma sala
    // que já não é acompanhada seria publicar nela dias depois, sem ninguém
    // olhando (review de correção nº 2).
    await assertGroupConversationSendable(ctx, conversation);

    const content = args.content.trim();
    if (!content) throw new Error("Mensagem vazia");
    const now = Date.now();
    if (args.scheduledAt < now + 30_000) {
      throw new Error("Escolha um horário pelo menos 1 minuto no futuro");
    }

    const mentions =
      conversation.kind === "group" && args.mentions && args.mentions.length > 0
        ? args.mentions.filter((j) => typeof j === "string" && j.length > 0).slice(0, 1024)
        : undefined;

    // Grupo nunca traduz; fora dele, valida já (idioma fora do catálogo = erro
    // agora, não na entrega).
    const translationArgs =
      conversation.kind === "group"
        ? {}
        : {
            ...(args.language !== undefined ? { language: args.language } : {}),
            ...(args.translation
              ? { translation: { ...args.translation, authoredText: args.translation.authoredText.trim() } }
              : {}),
          };
    if (translationArgs.language !== undefined || translationArgs.translation) {
      outboundTranslationInsertFields(translationArgs, now);
    }

    const scheduledMessageId = await ctx.db.insert("scheduledMessages", {
      organizationId: conversation.organizationId,
      conversationId: args.conversationId,
      content,
      scheduledAt: args.scheduledAt,
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
      ...translationArgs,
      status: "pending",
      createdBy: userMember._id,
      createdAt: now,
    });

    const fnId = await ctx.scheduler.runAt(
      args.scheduledAt,
      internal.scheduledMessages.deliver,
      { scheduledMessageId }
    );
    await ctx.db.patch(scheduledMessageId, { scheduledFunctionId: fnId as string });

    return scheduledMessageId;
  },
});

export const listPending = query({
  args: { conversationId: v.id("conversations") },
  returns: v.array(
    v.object({
      _id: v.id("scheduledMessages"),
      content: v.string(),
      scheduledAt: v.number(),
      createdAt: v.number(), // início da janela — base da barra de progresso na UI
      // F3: agendada já traduzida — o que a equipe escreveu e o idioma de saída.
      authoredText: v.optional(v.string()),
      targetLang: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return [];
    await requirePermission(ctx, conversation.organizationId, "inbox", "view_own");

    const rows = await ctx.db
      .query("scheduledMessages")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending")
      )
      .collect();
    rows.sort((a, b) => a.scheduledAt - b.scheduledAt);
    return rows.map((r) => ({
      _id: r._id,
      content: r.content,
      scheduledAt: r.scheduledAt,
      createdAt: r.createdAt,
      ...(r.translation
        ? { authoredText: r.translation.authoredText, targetLang: r.translation.targetLang }
        : {}),
    }));
  },
});

export const cancel = mutation({
  args: { scheduledMessageId: v.id("scheduledMessages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledMessageId);
    if (!row) return null;
    await requirePermission(ctx, row.organizationId, "inbox", "reply");
    if (row.status !== "pending") return null;

    if (row.scheduledFunctionId) {
      await ctx.scheduler.cancel(row.scheduledFunctionId as Id<"_scheduled_functions">);
    }
    await ctx.db.patch(args.scheduledMessageId, { status: "canceled" });
    return null;
  },
});

// Entrega no horário: espelha o núcleo do sendMessage (insert + side effects +
// dispatch), sem auth de usuário — o autor é o membro que agendou.
export const deliver = internalMutation({
  args: { scheduledMessageId: v.id("scheduledMessages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.scheduledMessageId);
    if (!row || row.status !== "pending") return null;

    // Modo leitura (B7): a agendada NÃO vira `failed` nem sai. Fica `pending` e é
    // reagendada para depois; quando o plano voltar, a próxima tentativa entrega (já vencida,
    // sai na hora). Mensagem de cliente nunca é descartada por mudança de plano.
    const nowTs = Date.now();
    if (outboundBlockedFor(await ctx.db.get(row.organizationId), nowTs)) {
      const heldSince = row.heldSince ?? nowTs;
      // Teto: 30 dias retida em modo leitura e a agendada expira (o loop de 6 h para).
      if (nowTs - heldSince > READ_ONLY_HOLD_MAX_MS) {
        await expireScheduled(ctx, row, nowTs);
        return null;
      }
      const fnId = await ctx.scheduler.runAfter(READ_ONLY_RECHECK_MS, internal.scheduledMessages.deliver, {
        scheduledMessageId: args.scheduledMessageId,
      });
      await ctx.db.patch(args.scheduledMessageId, { scheduledFunctionId: fnId as string, heldSince });
      return null;
    }
    // Voltou o plano: o que ficou retido e venceu há mais de 24 h NÃO sai (a conversa já
    // seguiu sem ele). Mensagem fora do contexto é pior que mensagem perdida, e vira audit.
    if (row.heldSince !== undefined && nowTs - row.scheduledAt > READ_ONLY_STALE_MS) {
      await expireScheduled(ctx, row, nowTs);
      return null;
    }

    const conversation = await ctx.db.get(row.conversationId);
    const member = await ctx.db.get(row.createdBy);
    if (!conversation || !member) {
      await ctx.db.patch(args.scheduledMessageId, {
        status: "failed",
        error: "Conversa ou autor não existe mais",
      });
      return null;
    }

    // Entre o agendamento e a entrega o operador pode ter parado de acompanhar
    // a sala, ou o número pode ter saído dela. Re-checar aqui é o que impede a
    // mensagem de cair num grupo de terceiros horas depois da decisão contrária.
    try {
      await assertGroupConversationSendable(ctx, conversation);
    } catch (e) {
      await ctx.db.patch(args.scheduledMessageId, {
        status: "failed",
        error: e instanceof Error ? e.message : "Grupo indisponível",
      });
      return null;
    }

    const now = Date.now();
    const actorType = member.type === "ai" ? ("ai" as const) : ("human" as const);
    // Menção revalidada AGORA: quem saiu da sala entre o agendamento e a
    // entrega não entra no `MentionedJID`.
    const mentions = await resolveGroupMentions(ctx, conversation, row.mentions);

    // Tradução (F3): traduzida ao agendar = nasce `done` (sem desvio). Se a
    // equipe desligou a tradução da conversa no meio tempo, sai o que ela
    // escreveu, sem tradução. Sem nada disso, o desvio da porta decide (F1).
    const translationOff = row.translation !== undefined && conversation.translation?.mode === "off";
    const content = translationOff ? row.translation!.authoredText : row.content;
    let translationFields: { metadata?: Record<string, unknown>; translatedText?: string } = {};
    try {
      translationFields = translationOff
        ? outboundTranslationInsertFields({ language: "off" }, now)
        : row.translation || row.language !== undefined
          ? outboundTranslationInsertFields(
              {
                ...(row.translation ? { translation: row.translation } : {}),
                ...(row.language !== undefined ? { language: row.language } : {}),
              },
              now
            )
          : {};
    } catch {
      translationFields = {};
    }

    const messageId = await ctx.db.insert("messages", withMessageSearch({
      organizationId: conversation.organizationId,
      conversationId: row.conversationId,
      leadId: conversation.leadId,
      direction: "outbound",
      senderId: member._id,
      senderType: actorType,
      content,
      contentType: "text",
      isInternal: false,
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
      metadata: { scheduled: true, ...(translationFields.metadata ?? {}) },
      ...(translationFields.translatedText !== undefined ? { translatedText: translationFields.translatedText } : {}),
      createdAt: now,
    }));

    await ctx.db.patch(row.conversationId, {
      lastMessageAt: now,
      messageCount: conversation.messageCount + 1,
      updatedAt: now,
      ...firstResponsePatch(conversation, actorType, now),
      ...(await lastMessagePatchForId(ctx, conversation, messageId)),
    });

    const lead = await getLeadRef(ctx.db, conversation.leadId);
    if (lead) {
      await ctx.db.patch(lead._id, {
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
      actorId: member._id,
      actorType,
      metadata: { conversationId: row.conversationId, leadId: conversation.leadId, scheduled: true },
      description: buildAuditDescription({
        action: "create",
        entityType: "message",
        metadata: { conversationId: row.conversationId, leadId: conversation.leadId },
      }),
      severity: "low",
      createdAt: now,
    });

    // Conversa de grupo não tem lead — a timeline do lead simplesmente não
    // recebe nada (o audit acima cobre o rastro).
    if (conversation.leadId) {
      await ctx.db.insert("activities", {
        organizationId: conversation.organizationId,
        leadId: conversation.leadId,
        type: "message_sent",
        actorId: member._id,
        actorType,
        content: `Mensagem agendada enviada via ${conversation.channel}`,
        metadata: { conversationId: row.conversationId, scheduled: true },
        createdAt: now,
      });
    }

    // Sala de grupo tem evento próprio — `message.sent` segue exclusivo do 1 a 1.
    await scheduleWebhookEvent(ctx, {
      organizationId: conversation.organizationId,
      event: conversation.kind === "group" ? "group.message.sent" : "message.sent",
      payload: {
        messageId,
        conversationId: row.conversationId,
        leadId: conversation.leadId,
        ...(conversation.kind === "group" ? { kind: "group" } : {}),
        channel: conversation.channel,
        senderType: actorType,
        senderId: member._id,
      },
    });

    await scheduleOutboundDispatch(ctx, conversation, messageId);

    await ctx.db.patch(args.scheduledMessageId, { status: "sent", sentMessageId: messageId });
    return null;
  },
});
