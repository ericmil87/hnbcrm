/**
 * Transporte de um channelConfig (puro, sem ctx). Meta Messaging F0.2.
 *
 * `configProvider()` (channelConfigs.ts) só conhece WhatsApp e colapsa tudo que
 * não é bridge em "meta". Com Instagram e Messenger entrando como `channel`
 * próprios, quem decide TRANSPORTE de forma genérica (resolução de canal,
 * denormalização da lista, elegibilidade do atendente, pacing, health, routing
 * de inbound) usa `configTransport`, que olha o `channel` ANTES do `provider`.
 *
 * Fail-closed: channel desconhecido lança, nunca vira "meta" por omissão.
 */

export type ChannelTransport = "meta" | "bridge" | "instagram" | "messenger";

export const CHANNEL_TRANSPORTS: readonly ChannelTransport[] = [
  "meta",
  "bridge",
  "instagram",
  "messenger",
];

/**
 * whatsapp → provider === "bridge" ? "bridge" : "meta" (undefined/null/"meta" =
 * Cloud API, compat com linhas legadas); instagram → "instagram";
 * messenger → "messenger". Qualquer outro channel → lança.
 *
 * `channel: string` porque os literais "instagram"/"messenger" ainda não
 * existem no schema (F0.3 os adiciona).
 */
export function configTransport(config: {
  channel: string;
  provider?: "meta" | "bridge" | null;
}): ChannelTransport {
  switch (config.channel) {
    case "whatsapp":
      return config.provider === "bridge" ? "bridge" : "meta";
    case "instagram":
      return "instagram";
    case "messenger":
      return "messenger";
    default:
      throw new Error(
        `configTransport: channel desconhecido (channel=${JSON.stringify(config.channel)})`
      );
  }
}

export function isWhatsappTransport(t: ChannelTransport): t is "meta" | "bridge" {
  return t === "meta" || t === "bridge";
}

/**
 * Nome do canal para cópias ao cliente/equipe (F3). Transporte resolvido
 * vence; sem ele, o `channel` da conversa (config sumiu) ainda diz se é Meta.
 */
export function channelDisplayName(
  transport: ChannelTransport | null | undefined,
  channel?: string | null
): "WhatsApp" | "Instagram" | "Messenger" {
  const key = transport ?? channel;
  if (key === "instagram") return "Instagram";
  if (key === "messenger") return "Messenger";
  return "WhatsApp";
}
