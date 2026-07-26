/**
 * Resolução ÚNICA do channelConfig de uma conversa WhatsApp (v4.1 DIFF 2/3).
 *
 * Usada pelo atendente (enqueue/claim/commit) e pelo dispatch para que o
 * provider derivado NUNCA divirja entre os pontos — a elegibilidade do commit
 * transacional precisa enxergar exatamente o mesmo canal que o enqueue viu.
 *
 * Fallback determinístico: conversa sem channelConfigId prefere um config META
 * ativo (default conservador — janela de 24h exigida, sem ack de bridge);
 * um config bridge só é usado no fallback se for o único ativo.
 */
import { QueryCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";
import { configProvider } from "../channelConfigs";

export async function resolveConversationChannelConfig(
  ctx: QueryCtx,
  conversation: Doc<"conversations">
): Promise<Doc<"channelConfigs"> | null> {
  if (conversation.channel !== "whatsapp") return null;

  if (conversation.channelConfigId) {
    const config = await ctx.db.get(conversation.channelConfigId);
    if (config) return config;
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

/** Provider da conversa a partir do config resolvido (null = não resolvível). */
export function providerOf(
  config: Doc<"channelConfigs"> | null
): "meta" | "bridge" | null {
  return config ? configProvider(config) : null;
}
