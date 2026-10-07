import { useState } from "react";
import {
  Ban,
  BarChart3,
  Calendar,
  Check,
  Copy,
  ExternalLink,
  HelpCircle,
  Images,
  Link2,
  MapPin,
  MousePointerClick,
  Phone,
  UserRound,
  Video,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SpecialIcon, SpecialMessageInfo } from "@/lib/bridgeSpecialMessage";

const ICONS: Record<SpecialIcon, LucideIcon> = {
  images: Images,
  chart: BarChart3,
  "map-pin": MapPin,
  user: UserRound,
  calendar: Calendar,
  link: Link2,
  phone: Phone,
  video: Video,
  "mouse-pointer": MousePointerClick,
  help: HelpCircle,
  ban: Ban,
};

export function SpecialIconView({ name, size = 16, className }: { name: SpecialIcon; size?: number; className?: string }) {
  const Icon = ICONS[name];
  return <Icon size={size} className={className} aria-hidden />;
}

interface SpecialMessageCardProps {
  info: SpecialMessageInfo;
  variant: "inbound" | "outbound";
}

function CopyButton({ value, outbound }: { value: string; outbound: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard indisponível: sem feedback */
        }
      }}
      className={cn(
        "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        outbound ? "text-white/80 hover:bg-white/15" : "text-text-muted hover:bg-surface-overlay hover:text-text-primary"
      )}
      aria-label={copied ? "Telefone copiado" : `Copiar telefone ${value}`}
      title={copied ? "Copiado" : "Copiar"}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}

export function SpecialMessageCard({ info, variant }: SpecialMessageCardProps) {
  const outbound = variant === "outbound";
  const muted = outbound ? "text-white/75" : "text-text-muted";
  const secondary = outbound ? "text-white/85" : "text-text-secondary";
  const unknown = info.kind === "unknown";

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg p-2.5",
        outbound ? "bg-white/10" : "bg-surface-sunken/60"
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            outbound ? "bg-white/15 text-white" : "bg-brand-500/15 text-brand-400"
          )}
        >
          <SpecialIconView name={info.icon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          {info.kind === "poll" && (
            <span className={cn("block text-[10px] font-semibold uppercase tracking-wide", muted)}>Enquete</span>
          )}
          <p className={cn("break-words text-sm font-medium", unknown && muted)}>{info.title}</p>
          {info.lines.map((line, i) => (
            <p key={i} className={cn("break-words text-xs", secondary)}>
              {line}
            </p>
          ))}
        </div>
      </div>

      {info.options && info.options.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Opções da enquete">
          {info.options.map((opt, i) => (
            <li
              key={i}
              className={cn(
                "flex items-start gap-2 break-words rounded-md border px-2.5 py-1.5 text-xs",
                outbound ? "border-white/25" : "border-border"
              )}
            >
              <span
                className={cn("mt-0.5 h-3 w-3 shrink-0 rounded-full border", outbound ? "border-white/60" : "border-border-strong")}
                aria-hidden
              />
              <span className="min-w-0">{opt}</span>
            </li>
          ))}
        </ul>
      )}

      {info.phones && info.phones.length > 0 && (
        <ul className="flex flex-col">
          {info.phones.map((p) => (
            <li key={p.raw} className="flex items-center justify-between gap-2">
              <span className="min-w-0 break-all text-xs tabular-nums">{p.display}</span>
              <CopyButton value={p.raw} outbound={outbound} />
            </li>
          ))}
        </ul>
      )}

      {info.actions?.map((a) => (
        <a
          key={a.href}
          href={a.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-xs font-semibold transition-colors",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
            outbound ? "bg-white/20 text-white hover:bg-white/30" : "bg-brand-600 text-white hover:bg-brand-700"
          )}
        >
          <ExternalLink size={14} aria-hidden />
          {a.label}
        </a>
      ))}

      {info.note && info.kind !== "poll" && (
        <p className={cn("break-words text-[11px]", muted, unknown && "italic")}>{info.note}</p>
      )}
    </div>
  );
}
