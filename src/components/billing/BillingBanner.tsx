import { Link } from "react-router";
import { AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BannerTone, BillingBanner as BillingBannerModel } from "@/lib/billingBanner";

const TONE: Record<BannerTone, string> = {
  error: "border-semantic-error/40 bg-semantic-error/5",
  warning: "border-semantic-warning/40 bg-semantic-warning/5",
  info: "border-semantic-info/40 bg-semantic-info/5",
};

interface BillingBannerProps {
  banner: BillingBannerModel;
  onDismiss?: () => void;
  className?: string;
}

/** Aviso de plano/uso: apresentacional. `role="status"`, não rouba o foco. */
export function BillingBanner({ banner, onDismiss, className }: BillingBannerProps) {
  const Icon = banner.tone === "info" ? Info : AlertTriangle;
  return (
    <div role="status" className={cn("flex items-start gap-3 rounded-card border p-3", TONE[banner.tone], className)}>
      <Icon size={18} className="mt-0.5 shrink-0 text-text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary">{banner.title}</p>
        <p className="text-sm text-text-secondary">{banner.body}</p>
        {banner.cta && (
          <Link
            to={banner.cta.to}
            className="mt-1 inline-flex min-h-9 items-center text-sm font-medium text-brand-400 hover:text-brand-300 coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {banner.cta.label}
          </Link>
        )}
      </div>
      {banner.dismissible && onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dispensar aviso"
          className="-m-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-surface-overlay coarse:h-11 coarse:w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
