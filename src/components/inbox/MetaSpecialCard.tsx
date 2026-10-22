import { ExternalLink, Heart, ImageOff, Link2, Clapperboard, Image as ImageIcon, Smile, History, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MetaCardIcon, MetaCardInfo } from "@/lib/metaSpecialMessage";

const ICONS: Record<MetaCardIcon, LucideIcon> = {
  story: History,
  post: ImageIcon,
  reel: Clapperboard,
  heart: Heart,
  sticker: Smile,
  link: Link2,
};

interface MetaSpecialCardProps {
  info: MetaCardInfo;
  variant: "inbound" | "outbound";
  /** Há anexo (imagem/vídeo) renderizado junto: o story expirado só aparece sem ele. */
  hasMedia: boolean;
}

export function MetaSpecialCard({ info, variant, hasMedia }: MetaSpecialCardProps) {
  const outbound = variant === "outbound";
  const Icon = ICONS[info.icon];
  const secondary = outbound ? "text-white/85" : "text-text-secondary";
  const muted = outbound ? "text-white/75" : "text-text-muted";

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-2 rounded-lg p-2.5", outbound ? "bg-white/10" : "bg-surface-sunken/60")}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            outbound ? "bg-white/15 text-white" : "bg-brand-500/15 text-brand-400"
          )}
        >
          <Icon size={16} aria-hidden fill={info.icon === "heart" ? "currentColor" : "none"} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium">{info.title}</p>
          {info.subtitle && <p className={cn("break-words text-xs", secondary)}>{info.subtitle}</p>}
          {info.expiredFallback && !hasMedia && (
            <p className={cn("text-xs italic", muted)}>{info.expiredFallback}</p>
          )}
        </div>
      </div>
      {info.action && (
        <a
          href={info.action.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-xs font-semibold transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
            outbound ? "bg-white/20 text-white hover:bg-white/30" : "bg-brand-600 text-white hover:bg-brand-700"
          )}
        >
          <ExternalLink size={14} aria-hidden />
          {info.action.label}
        </a>
      )}
    </div>
  );
}

export function StoryReplyStrip({ href, variant }: { href: string | null; variant: "inbound" | "outbound" }) {
  const outbound = variant === "outbound";
  return (
    <div
      className={cn(
        "flex min-h-8 items-center justify-between gap-2 rounded-md border-l-2 px-2 py-1 text-xs",
        outbound ? "border-white/60 bg-white/10 text-white/90" : "border-brand-500 bg-surface-sunken/60 text-text-secondary"
      )}
    >
      <span className="flex items-center gap-1.5">
        <History size={12} aria-hidden /> Respondeu ao seu story
      </span>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center font-semibold underline-offset-2 hover:underline md:min-h-8"
        >
          Abrir
        </a>
      )}
    </div>
  );
}

export function MediaUnavailablePlaceholder({ label, detail, variant }: { label: string; detail?: string | null; variant: "inbound" | "outbound" }) {
  return (
    <div
      title={detail ?? undefined}
      className={cn(
        "flex items-center gap-1.5 text-xs italic",
        variant === "outbound" ? "text-white/80" : "text-text-muted"
      )}
    >
      <ImageOff size={14} className="shrink-0" aria-hidden />
      {label}
    </div>
  );
}
