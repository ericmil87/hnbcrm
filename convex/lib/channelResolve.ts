/**
 * Resolução ÚNICA do channelConfig de uma conversa (v4.1 DIFF 2/3).
 *
 * Usada pelo atendente (enqueue/claim/commit) e pelo dispatch para que o
 * transporte derivado NUNCA divirja entre os pontos — a elegibilidade do commit
 * transacional precisa enxergar exatamente o mesmo canal que o enqueue viu.
 *
 * WhatsApp — fallback determinístico: conversa sem channelConfigId prefere um
 * config META ativo (default conservador — janela de 24h exigida, sem ack de
 * bridge); um config bridge só é usado no fallback se for o único ativo.
 *
 * Qualquer outro canal (Meta Messaging F0.2) é ESTRITO: só o
 * `conversation.channelConfigId` (existente e da mesma org), nunca o fallback de
 * WhatsApp — senão uma conversa do Instagram sairia por um número de WhatsApp.
 */
import { QueryCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";
import { configProvider } from "../channelConfigs";
import { ChannelTransport, configTransport } from "./channelTransport";

export async function resolveConversationChannelConfig(
  ctx: QueryCtx,
  conversation: Doc<"conversations">
): Promise<Doc<"channelConfigs"> | null> {
  if (conversation.channel !== "whatsapp") {
    if (!conversation.channelConfigId) return null;
    const config = await ctx.db.get(conversation.channelConfigId);
    if (!config || config.organizationId !== conversation.organizationId) return null;
    return config;
  }

  if (conversation.channelConfigId) {
    const config = await ctx.db.get(conversation.channelConfigId);
    // Conversa WhatsApp só resolve config WhatsApp (o resto da cadeia chama o
    // `configProvider` WA-only). Hoje todo config é WhatsApp: sem efeito.
    if (config && config.channel === "whatsapp") return config;
  }

  const configs = await ctx.db
    .query("channelConfigs")
    .withIndex("by_organization", (q) =>
      q.eq("organizationId", conversation.organizationId)
    )
    .collect();
  const active = configs.filter((c) => c.channel === "whatsapp" && c.status === "active");
  return active.find((c) => configProvider(c) === "meta") ?? active[0] ?? null;
}

/** Transporte da conversa a partir do config resolvido (null = não resolvível). */
export function transportOf(
  config: Doc<"channelConfigs"> | null
): ChannelTransport | null {
  return config ? configTransport(config) : null;
}
