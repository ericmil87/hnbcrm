import { useState } from "react";
import { cn } from "@/lib/utils";
import { channelIcon } from "@/lib/channelAccounts";

interface ChannelAvatarProps {
  channel: string;
  transport?: string | null;
  avatarUrl: string;
  /** Lado do avatar em px (20 na lista, 28 no cabeçalho). */
  size: number;
  className?: string;
}

/** Avatar da conta Meta com o ícone do canal sobreposto no canto. Imagem quebrada volta ao ícone do canal. */
export function ChannelAvatar({ channel, transport, avatarUrl, size, className }: ChannelAvatarProps) {
  const [failed, setFailed] = useState(false);
  const Icon = channelIcon(channel, transport);
  if (failed) return <Icon size={Math.round(size * 0.6)} aria-hidden="true" className="shrink-0" />;
  const badge = Math.max(10, Math.round(size * 0.5));
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <img
        src={avatarUrl}
        alt=""
        onError={() => setFailed(true)}
        className="h-full w-full rounded-full object-cover"
      />
      <span
        className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-surface-base text-brand-500 ring-1 ring-border"
        style={{ width: badge, height: badge }}
      >
        <Icon size={Math.round(badge * 0.7)} aria-hidden="true" />
      </span>
    </span>
  );
}
