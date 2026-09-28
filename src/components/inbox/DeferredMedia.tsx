import { Ban, Download, File, Film, Image as ImageIcon, Mic, Smile, Trash2, Clock } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/Spinner";
import { DEFERRED_KIND_LABELS, type DeferredMediaKind, type MessageMediaState } from "@/lib/groupMedia";
import { formatFileSize } from "./types";

const KIND_ICONS: Record<DeferredMediaKind, LucideIcon> = {
  image: ImageIcon,
  audio: Mic,
  video: Film,
  document: File,
  sticker: Smile,
};

/**
 * Placeholder de mídia que a política de grupo NÃO baixou (v0.62), ou que
 * venceu/foi apagada. Neutro de propósito — não é erro, foi escolha — e por
 * isso não reusa o "Mídia indisponível" de `hasMediaProblem`.
 */
export function DeferredMedia({
  media,
  variant,
  downloading = false,
  onDownload,
}: {
  media: Exclude<MessageMediaState, { state: "none" }>;
  variant: "inbound" | "outbound";
  downloading?: boolean;
  /** Ausente = sem permissão para baixar (`inbox:reply`) ou fora do inbox. */
  onDownload?: () => void;
}) {
  const outbound = variant === "outbound";
  const Icon = KIND_ICONS[media.kind];
  const label = DEFERRED_KIND_LABELS[media.kind];

  if (media.state === "unavailable") {
    const why =
      media.reason === "too_big"
        ? `Arquivo grande demais para baixar${
            media.fileLength ? ` (${formatFileSize(media.fileLength)})` : ""
          }`
        : "Tipo de arquivo não aceito";
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-xs italic",
          outbound ? "text-white/80" : "text-text-muted"
        )}
        title={media.reason === "rejected" ? media.detail : undefined}
      >
        <Ban size={14} className="shrink-0" aria-hidden />
        <span>
          {label}
          {media.filename ? ` (${media.filename})` : ""}: {why}
        </span>
      </div>
    );
  }

  if (media.state === "purged" || media.state === "expired") {
    const StateIcon = media.state === "purged" ? Trash2 : Clock;
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-xs italic",
          outbound ? "text-white/80" : "text-text-muted"
        )}
      >
        <StateIcon size={14} className="shrink-0" aria-hidden />
        <span>
          {label}
          {media.state === "expired" && media.filename ? ` (${media.filename})` : ""}:{" "}
          {media.state === "purged"
            ? "mídia removida para liberar espaço"
            : "mídia não está mais disponível no WhatsApp"}
        </span>
      </div>
    );
  }

  const details = [media.filename, media.fileLength ? formatFileSize(media.fileLength) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg border p-2",
        outbound ? "border-white/20 bg-black/10" : "border-border bg-surface-sunken"
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
          outbound ? "bg-white/15 text-white" : "bg-surface-overlay text-text-secondary"
        )}
        aria-hidden
      >
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs font-medium", outbound ? "text-white" : "text-text-primary")}>
          {label} não baixado{media.kind === "image" || media.kind === "sticker" ? "a" : ""}
        </p>
        {details && (
          <p
            className={cn(
              "truncate text-[11px] tabular-nums",
              outbound ? "text-white/75" : "text-text-muted"
            )}
            title={details}
          >
            {details}
          </p>
        )}
      </div>
      {onDownload && (
        <button
          type="button"
          onClick={onDownload}
          disabled={downloading}
          aria-label={`Baixar ${label.toLowerCase()}`}
          className={cn(
            "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors md:min-h-8",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-wait disabled:opacity-60",
            outbound
              ? "bg-white/20 text-white hover:bg-white/30"
              : "bg-brand-600 text-white hover:bg-brand-700"
          )}
        >
          {downloading ? <Spinner size="sm" /> : <Download size={14} aria-hidden />}
          Baixar
        </button>
      )}
    </div>
  );
}
