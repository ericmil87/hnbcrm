import { Download, FileText, Image, Music, File, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface AttachmentFile {
  _id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string | null;
}

interface AttachmentPreviewProps {
  files: AttachmentFile[];
  onRemove?: (fileId: string) => void;
  compact?: boolean;
  className?: string;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return Image;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) return FileText;
  return File;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function AttachmentPreview({
  files,
  onRemove,
  compact = false,
  className,
}: AttachmentPreviewProps) {
  if (!files || files.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-1.5 mt-1.5", className)}>
      {files.map((file) => {
        const Icon = getFileIcon(file.mimeType);

        if (isImage(file.mimeType) && file.url && !compact) {
          return (
            <div key={file._id} className="relative group">
              <a
                href={file.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <img
                  src={file.url}
                  alt={file.name}
                  className="max-w-[240px] max-h-[180px] rounded-md object-cover border border-border/50"
                  loading="lazy"
                />
              </a>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-caption text-text-muted truncate max-w-[180px]">
                  {file.name}
                </span>
                <span className="text-caption text-text-muted">
                  ({formatSize(file.size)})
                </span>
                {file.url && (
                  <a
                    href={file.url}
                    download={file.name}
                    className="p-0.5 text-text-muted hover:text-brand-500 transition-colors"
                    aria-label={`Baixar ${file.name}`}
                  >
                    <Download size={10} />
                  </a>
                )}
              </div>
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(file._id)}
                  className="absolute top-1 right-1 p-0.5 rounded-full text-text-muted hover:text-semantic-error transition-colors opacity-0 group-hover:opacity-100"
                  aria-label={`Remover ${file.name}`}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        }

        return (
          <div
            key={file._id}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md max-w-[280px] group"
          >
            <Icon size={14} className="shrink-0 text-text-muted" />
            <div className="flex-1 min-w-0">
              <span className="text-xs text-text-secondary truncate block">
                {file.name}
              </span>
              <span className="text-caption text-text-muted">
                {formatSize(file.size)}
              </span>
            </div>
            {file.url && (
              <a
                href={file.url}
                download={file.name}
                className="shrink-0 p-1 text-text-muted hover:text-brand-500 transition-colors"
                aria-label={`Baixar ${file.name}`}
              >
                <Download size={12} />
              </a>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(file._id)}
                className="shrink-0 p-0.5 text-text-muted hover:text-semantic-error transition-colors opacity-0 group-hover:opacity-100"
                aria-label={`Remover ${file.name}`}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
