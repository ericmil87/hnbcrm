import { Badge } from "@/components/ui/Badge";
import { channelBadgeVariant, channelIcon, channelLabel } from "@/lib/channelAccounts";

interface ChannelOriginBadgeProps {
  channel: string;
  transport?: string | null;
  className?: string;
}

/**
 * Ícone + rótulo curto do canal de origem. WhatsApp mantém a variante verde de
 * antes. Rótulo de conta entra na F1 (D11).
 */
export function ChannelOriginBadge({ channel, transport, className }: ChannelOriginBadgeProps) {
  const Icon = channelIcon(channel, transport);
  return (
    <Badge variant={channelBadgeVariant(channel)} className={className}>
      <span className="inline-flex items-center gap-1">
        <Icon size={11} aria-hidden="true" />
        {channelLabel(channel)}
      </span>
    </Badge>
  );
}
