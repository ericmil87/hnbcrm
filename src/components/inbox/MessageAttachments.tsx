import { useState } from "react";
import { Download, FileText, File as FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { attachmentBox, type AttachmentBox } from "@/lib/attachmentBox";
import { AudioPlayer } from "./AudioPlayer";
import { ImageLightbox } from "./ImageLightbox";
import {
  InboxAttachmentFile,
  formatFileSize,
  isAudioMime,
  isImageMime,
  isVideoMime,
} from "./types";

interface MessageAttachmentsProps {
  files: InboxAttachmentFile[];
  variant: "inbound" | "outbound";
  /** Renders images at sticker scale, transparent, no lightbox. */
  sticker?: boolean;
  /** Marks audio attachments as voice notes (mic glyph). */
  voiceNote?: boolean;
}

/**
 * Imagem com dimensões conhecidas: a caixa final já vale antes de carregar
 * (atributos + `aspect-ratio`), então a bolha não cresce e a leitura não pula.
 * `max-w-full` + altura automática mantêm a proporção se a bolha for mais
 * estreita. Sem dimensões (anexo antigo) devolve `null` e vale o CSS de sempre.
 */
function reservedBox(box: AttachmentBox | null) {
  if (!box) return null;
  return {
    width: box.width,
    height: box.height,
    style: { width: box.width, aspectRatio: `${box.width} / ${box.height}` },
  };
}

function DocumentIcon({ mimeType }: { mimeType: string }) {
  const isDoc =
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    mimeType.includes("word") ||
    mimeType.includes("document");
  const Icon = isDoc ? FileText : FileIcon;
  return <Icon size={18} className="shrink-0" />;
}

export function MessageAttachments({
  files,
  variant,
  sticker = false,
  voiceNote = false,
}: MessageAttachmentsProps) {
  const [lightbox, setLightbox] = useState<InboxAttachmentFile | null>(null);
  const outbound = variant === "outbound";

  if (!files || files.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {files.map((file) => {
        if (!file.url) {
          return (
            <div
              key={file._id}
              className={cn(
                "text-xs italic",
                outbound ? "text-bubble-out-fg/75" : "text-text-muted"
              )}
            >
              Anexo indisponível
            </div>
          );
        }

        // Sticker — small, transparent, no lightbox.
        if (sticker && isImageMime(file.mimeType)) {
          const reserved = reservedBox(attachmentBox(file.width, file.height, "sticker"));
          return (
            <img
              key={file._id}
              src={file.url}
              alt="Figurinha"
              loading="lazy"
              {...(reserved ?? {})}
              className={
                reserved
                  ? "max-w-full h-auto object-contain"
                  : "max-w-[128px] max-h-[128px] object-contain"
              }
            />
          );
        }

        // Image — thumbnail that opens a lightbox.
        if (isImageMime(file.mimeType)) {
          const reserved = reservedBox(attachmentBox(file.width, file.height, "image"));
          return (
            <button
              key={file._id}
              type="button"
              onClick={() => setLightbox(file)}
              className="block rounded-lg overflow-hidden focus:outline-none focus:ring-2 focus:ring-brand-500"
              aria-label={`Abrir imagem ${file.name}`}
            >
              <img
                src={file.url}
                alt={file.name}
                loading="lazy"
                {...(reserved ?? {})}
                className={
                  reserved
                    ? "max-w-full h-auto object-cover rounded-lg"
                    : "max-w-[240px] max-h-[240px] object-cover rounded-lg"
                }
              />
            </button>
          );
        }

        // Audio — custom player.
        if (isAudioMime(file.mimeType)) {
          return (
            <AudioPlayer
              key={file._id}
              src={file.url}
              variant={variant}
              isVoiceNote={voiceNote}
            />
          );
        }

        // Video — native controls.
        if (isVideoMime(file.mimeType)) {
          return (
            <video
              key={file._id}
              src={file.url}
              controls
              preload="metadata"
              className="max-w-full max-h-[320px] rounded-lg"
            />
          );
        }

        // Document — download chip.
        return (
          <a
            key={file._id}
            href={file.url}
            download={file.name}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg max-w-[280px] transition-colors",
              outbound
                ? "bg-bubble-out-fg/15 text-bubble-out-fg hover:bg-bubble-out-fg/25"
                : "text-text-secondary hover:bg-surface-sunken"
            )}
          >
            <DocumentIcon mimeType={file.mimeType} />
            <div className="flex-1 min-w-0">
              <span className="block text-xs font-medium truncate">{file.name}</span>
              <span className={cn("text-caption", outbound ? "text-bubble-out-fg/75" : "text-text-muted")}>
                {formatFileSize(file.size)}
              </span>
            </div>
            <Download size={16} className="shrink-0" />
          </a>
        );
      })}

      {lightbox?.url && (
        <ImageLightbox
          open
          onClose={() => setLightbox(null)}
          src={lightbox.url}
          alt={lightbox.name}
          downloadName={lightbox.name}
        />
      )}
    </div>
  );
}
