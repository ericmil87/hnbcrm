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

// O rótulo da conta vem de getInboxChannelAccounts e nunca é denormalizado na conversa (D11).

export type InboxChannelAccount = {
  _id: string;
  channel: "whatsapp" | "instagram" | "messenger";
  transport: "meta" | "bridge" | "instagram" | "messenger";
  label: string;
  handle: string | null;
  avatarUrl: string | null;
  status: "active" | "disabled" | "error";
  authState: "ok" | "reauth_required" | "revoked" | null;
};

type AccountLike = Pick<InboxChannelAccount, "channel" | "label" | "handle">;

/** Rótulo curto da conta: "@casalumiar", "Casa Lumiar", "WhatsApp ····5729" ou o displayName. */
export function accountBadgeLabel(account: AccountLike | null | undefined): string {
  if (!account) return "";
  if (account.handle) {
    const h = account.handle.trim();
    if (account.channel === "instagram") return h.startsWith("@") ? h : `@${h}`;
    // WhatsApp: o nome dado ao canal vence os 4 últimos dígitos (fallback).
    if (account.channel === "whatsapp" && !account.label?.trim()) {
      const digits = h.replace(/\D/g, "");
      if (digits.length >= 4) return `WhatsApp ····${digits.slice(-4)}`;
    }
  }
  return account.label;
}

/**
 * Rótulo completo para o cabeçalho da conversa: nome + @handle no Instagram
 * ("Casa Lumiar (@casalumiar)"); nos demais, igual ao rótulo curto.
 */
export function accountFullLabel(account: AccountLike | null | undefined): string {
  if (!account) return "";
  if (account.channel === "instagram" && account.handle) {
    const short = accountBadgeLabel(account);
    return account.label && account.label !== short ? `${account.label} (${short})` : short;
  }
  return accountBadgeLabel(account);
}

/** Mostra a conta quando o canal tem 2+ contas OU a org tem 2+ canais. */
export function shouldShowAccount(
  accounts: ReadonlyArray<Pick<InboxChannelAccount, "channel">>,
  channel: string
): boolean {
  const channels = new Set(accounts.map((a) => a.channel));
  const inChannel = accounts.filter((a) => a.channel === channel).length;
  return inChannel >= 2 || channels.size >= 2;
}

/** "via Instagram" / "via Messenger" / "via WhatsApp". */
export function viaLabel(channel: string): string {
  return `via ${channelLabel(channel)}`;
}

/** Chave do localStorage dos chips Canal/Conta (mesmo padrão do filtro Diretas/Grupos). */
export const INBOX_FILTER_STORAGE_KEY = "hnbcrm.inbox.channelFilter";

export interface InboxFilterState {
  channel: string | null;
  configId: string | null;
}

/** Chip "Canal": 2+ canais na org. */
export function showChannelChip(
  accounts: ReadonlyArray<Pick<InboxChannelAccount, "channel">>
): boolean {
  return new Set(accounts.map((a) => a.channel)).size >= 2;
}

/** Contas oferecidas no chip "Conta"; vazio = chip escondido (precisa de 2+). */
export function accountChipOptions<T extends Pick<InboxChannelAccount, "channel">>(
  accounts: ReadonlyArray<T>,
  channel: string | null
): T[] {
  const list = channel ? accounts.filter((a) => a.channel === channel) : [...accounts];
  return list.length >= 2 ? list : [];
}

/** Sanitiza o filtro salvo contra as contas atuais (conta/canal removidos somem). */
export function sanitizeInboxFilter(
  accounts: ReadonlyArray<Pick<InboxChannelAccount, "_id" | "channel">>,
  f: InboxFilterState
): InboxFilterState {
  const channel = f.channel && accounts.some((a) => a.channel === f.channel) ? f.channel : null;
  const acc = f.configId ? accounts.find((a) => a._id === f.configId) : undefined;
  const configId = acc && (!channel || acc.channel === channel) ? acc._id : null;
  return { channel, configId };
}

export function parseStoredInboxFilter(raw: string | null): InboxFilterState {
  if (!raw) return { channel: null, configId: null };
  try {
    const v = JSON.parse(raw) as Partial<InboxFilterState>;
    return {
      channel: typeof v.channel === "string" ? v.channel : null,
      configId: typeof v.configId === "string" ? v.configId : null,
    };
  } catch {
    return { channel: null, configId: null };
  }
}
