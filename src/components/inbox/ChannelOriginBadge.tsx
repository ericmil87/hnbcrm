import { ChannelAvatar } from "@/components/inbox/ChannelAvatar";
import { Badge } from "@/components/ui/Badge";
import {
  accountBadgeLabel,
  channelBadgeVariant,
  channelIcon,
  channelLabel,
  type InboxChannelAccount,
} from "@/lib/channelAccounts";

interface ChannelOriginBadgeProps {
  channel: string;
  transport?: string | null;
  /** Conta de origem; só aparece quando `showAccount` (2+ contas ou 2+ canais). */
  account?: InboxChannelAccount | null;
  showAccount?: boolean;
  className?: string;
}

/**
 * Ícone + rótulo curto do canal de origem. Com `showAccount`, soma o rótulo da
 * conta ("@casalumiar"). WhatsApp mantém a variante verde de antes.
 */
export function ChannelOriginBadge({
  channel,
  transport,
  account,
  showAccount = false,
  className,
}: ChannelOriginBadgeProps) {
  const Icon = channelIcon(channel, transport);
  const accountLabel = showAccount && account ? accountBadgeLabel(account) : "";
  // O rótulo do WhatsApp já começa com o nome do canal; evita "WhatsApp WhatsApp ····1234".
  const duplicate = accountLabel.toLowerCase().startsWith(channelLabel(channel).toLowerCase());
  return (
    <Badge variant={channelBadgeVariant(channel)} className={className}>
      <span className="inline-flex items-center gap-1 min-w-0">
        {showAccount && account?.avatarUrl ? (
          <ChannelAvatar channel={channel} transport={transport} avatarUrl={account.avatarUrl} size={20} />
        ) : (
          <Icon size={11} aria-hidden="true" className="shrink-0" />
        )}
        {accountLabel && duplicate ? (
          <span className="truncate max-w-[9rem]">{accountLabel}</span>
        ) : (
          <>
            {channelLabel(channel)}
            {accountLabel && <span className="truncate max-w-[8rem] opacity-80">· {accountLabel}</span>}
          </>
        )}
      </span>
    </Badge>
  );
}
