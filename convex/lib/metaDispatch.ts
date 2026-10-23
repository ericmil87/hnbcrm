/**
 * Agendamento do envio Instagram/Messenger (Meta Messaging F1, D4). Espelho de
 * `scheduleWhatsappDispatch`, chamado SÓ pela porta `scheduleOutboundDispatch`.
 *
 * - Config pelo resolver estrito (`resolveConversationChannelConfig`): uma
 *   conversa Meta nunca sai por um número de WhatsApp.
 * - Janela server-side AQUI e de novo no dispatcher: fechada = `failed` com
 *   cópia clara, sem rede (vale para humano, IA e mensagem agendada).
 * - Pacing só por canal (`claimChannelSlot`, intervalo por transporte em
 *   `lib/whatsappDispatch.ts`); a Meta não tem limite por par como o 131056.
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { resolveConversationChannelConfig } from "./channelResolve";
import { claimChannelSlot } from "./whatsappDispatch";
import { isHeavyMime, metaConversationWindow, OUTSIDE_WINDOW_COPY } from "./metaSend";

export const NO_META_CHANNEL_COPY =
  "Esta conversa não tem um canal do Instagram/Messenger conectado. Verifique em Configurações > Canais.";

/** Áudio/vídeo contam como envio "pesado": a Meta limita a ~10/s (texto ~100/s). */
export const HEAVY_MEDIA_EXTRA_GAP_MS = 1000;

async function hasHeavyAttachment(ctx: MutationCtx, messageId: Id<"messages">): Promise<boolean> {
  const message = await ctx.db.get(messageId);
  for (const fileId of (message?.attachments ?? []).slice(0, 10)) {
    const file = await ctx.db.get(fileId);
    if (file && isHeavyMime(file.mimeType)) return true;
  }
  return false;
}

export async function scheduleMetaMessagingDispatch(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  messageId: Id<"messages">
): Promise<void> {
  const now = Date.now();
  const surface = conversation.channel === "instagram" ? "instagram" : "messenger";
  const config = await resolveConversationChannelConfig(ctx, conversation);
  if (!config) {
    await ctx.scheduler.runAfter(0, internal.metaMessaging.internalMarkDispatchFailed, {
      messageId,
      detail: NO_META_CHANNEL_COPY,
    });
    return;
  }
  if (!metaConversationWindow(surface, conversation, now).open) {
    await ctx.scheduler.runAfter(0, internal.metaMessaging.internalMarkDispatchFailed, {
      messageId,
      detail: OUTSIDE_WINDOW_COPY,
    });
    return;
  }
  const slot = await claimChannelSlot(ctx, {
    config,
    conversation,
    earliestAt: now,
    now,
    countSend: true,
    ...((await hasHeavyAttachment(ctx, messageId)) ? { extraAdvanceMs: HEAVY_MEDIA_EXTRA_GAP_MS } : {}),
  });
  await ctx.scheduler.runAfter(slot - now, internal.metaMessaging.internalDispatchMessage, { messageId });
}

/**
 * Conversa 1:1 do cliente `userId` (PSID/IGSID) no config: identidade →
 * contato → leads do contato → conversa do canal com esse `channelConfigId`.
 * Mais recente vence. Leituras limitadas.
 */
export async function findMetaConversationForUser(
  ctx: { db: QueryCtx["db"] },
  config: Doc<"channelConfigs">,
  userId: string
): Promise<Doc<"conversations"> | null> {
  if (config.channel !== "instagram" && config.channel !== "messenger") return null;
  const channel = config.channel;
  const identity = await ctx.db
    .query("contactChannelIdentities")
    .withIndex("by_channel_config_and_external_id", (q) =>
      q.eq("channelConfigId", config._id).eq("externalId", userId)
    )
    .first();
  if (!identity || identity.organizationId !== config.organizationId) return null;
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_contact", (q) => q.eq("contactId", identity.contactId))
    .order("desc")
    .take(20);
  let best: Doc<"conversations"> | null = null;
  for (const lead of leads) {
    if (lead.organizationId !== config.organizationId) continue;
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_lead_and_channel", (q) => q.eq("leadId", lead._id).eq("channel", channel))
      .take(10);
    for (const c of convs) {
      if (c.channelConfigId !== config._id) continue;
      if (!best || (c.lastMessageAt ?? c.createdAt) > (best.lastMessageAt ?? best.createdAt)) best = c;
    }
  }
  return best;
}
