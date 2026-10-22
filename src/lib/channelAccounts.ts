import { Facebook, Instagram, MessageCircle, type LucideIcon } from "lucide-react";

const LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  telegram: "Telegram",
  email: "E-mail",
  webchat: "Chat do site",
  internal: "Interno",
};

/** Ícone lucide do canal (sem emoji). `transport` fica reservado para variações futuras. */
export function channelIcon(channel: string, _transport?: string | null): LucideIcon {
  if (channel === "instagram") return Instagram;
  if (channel === "messenger") return Facebook;
  return MessageCircle;
}

/** Rótulo curto do canal; canal desconhecido volta como veio. */
export function channelLabel(channel: string): string {
  return LABELS[channel] ?? channel;
}

/** Variante de cor do Badge por canal (WhatsApp mantém o verde de sempre). */
export function channelBadgeVariant(channel: string): "success" | "info" | "brand" | "default" {
  switch (channel) {
    case "whatsapp":
      return "success";
    case "telegram":
      return "info";
    case "email":
    case "instagram":
    case "messenger":
      return "brand";
    default:
      return "default";
  }
}

// F1: `accountBadgeLabel(account)` e `shouldShowAccount(accounts, channel)` entram na F1.
// O rótulo da conta vem de getInboxChannelAccounts e nunca é denormalizado na conversa (D11).
