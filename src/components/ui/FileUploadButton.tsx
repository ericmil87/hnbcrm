import { Tooltip } from "./Tooltip";
import React, { useRef } from "react";
import { Id } from "../../../convex/_generated/dataModel";
import { Paperclip, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { acceptedUploadMimes, UPLOAD_RULES_HINT } from "@/lib/channelCapabilities";
import { ACCEPTED_ATTACHMENT_TYPES, MAX_ATTACHMENTS as MAX_FILES } from "@/lib/composerFiles";
import { useAttachmentUpload, type AttachmentUploader, type UploadedFile } from "@/hooks/useAttachmentUpload";

export type { UploadedFile };

const ACCEPTED_TYPES = ACCEPTED_ATTACHMENT_TYPES.join(",");

interface FileUploadButtonProps {
  organizationId: Id<"organizations">;
  onFilesUploaded: (files: UploadedFile[]) => void;
  onFilesRemoved?: (fileId: Id<"files">) => void;
  uploadedFiles: UploadedFile[];
  disabled?: boolean;
  /** Tooltip explicando por que o botão está desligado (sobrepõe "Anexar arquivo"). */
  disabledHint?: string;
  /** Canal/transporte da conversa: filtra o seletor e valida tipo/tamanho antes de subir. */
  channel?: string | null;
  transport?: string | null;
  className?: string;
  /**
   * "composer": botão redondo de 44 px (estilo WhatsApp) e os anexos viram uma
   * bandeja flutuando acima da linha do composer, sem empurrar o campo.
   */
  variant?: "default" | "composer";
  /** Upload compartilhado com colar/arrastar (o composer cria um e passa aqui). */
  uploader?: AttachmentUploader;
}

export function FileUploadButton({
  organizationId,
  onFilesUploaded,
  onFilesRemoved,
  uploadedFiles,
  disabled,
  disabledHint,
  channel,
  transport,
  className,
  variant = "default",
  uploader,
}: FileUploadButtonProps) {
  const composer = variant === "composer";
  const fileInputRef = useRef<HTMLInputElement>(null);
  const own = useAttachmentUpload({ organizationId, uploadedFiles, onFilesUploaded, channel, transport });
  const { uploading, progress, uploadFiles } = uploader ?? own;

  const handleClick = () => {
    if (disabled || uploading) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;
    await uploadFiles(Array.from(selectedFiles));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRemoveFile = (fileId: Id<"files">) => {
    onFilesRemoved?.(fileId);
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className={cn(composer ? "relative shrink-0" : "flex flex-col gap-2", className)}>
      {/* Staged files */}
      {uploadedFiles.length > 0 && (
        <div
          className={cn(
            "flex flex-wrap gap-1.5",
            composer &&
              "absolute bottom-full left-0 z-10 mb-2 w-max max-w-[calc(100vw-1rem)] rounded-card border border-border bg-surface-overlay p-1.5 shadow-elevated"
          )}
        >
          {uploadedFiles.map((file) => (
            <div
              key={file.fileId}
              className="flex items-center gap-1.5 px-2 py-1 bg-surface-sunken border border-border rounded-lg text-xs max-w-[200px]"
            >
              <span className="truncate text-text-secondary">{file.name}</span>
              <span className="text-text-muted shrink-0">{formatSize(file.size)}</span>
              <button
                type="button"
                onClick={() => handleRemoveFile(file.fileId)}
                className="shrink-0 p-0.5 rounded hover:bg-surface-raised text-text-muted hover:text-semantic-error transition-colors"
                aria-label={`Remover ${file.name}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload button */}
      <Tooltip content={disabled && disabledHint
            ? disabledHint
            : uploading
            ? `Enviando... ${progress}%`
            : uploadedFiles.length >= MAX_FILES
            ? `Máximo de ${MAX_FILES} arquivos`
            : (channel && UPLOAD_RULES_HINT[channel]) || "Anexar arquivo"}>
        <button
          type="button"
          onClick={handleClick}
          disabled={disabled || uploading || uploadedFiles.length >= MAX_FILES}
          className={cn(
            composer ? "flex h-11 w-11 items-center justify-center" : "p-2",
            "rounded-full text-text-muted hover:text-brand-500 hover:bg-brand-500/10 transition-colors",
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-text-muted disabled:hover:bg-transparent"
          )}
          aria-label="Anexar arquivo"
        >
          {uploading ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Paperclip size={18} />
          )}
        </button>
      </Tooltip>

      <input
        ref={fileInputRef}
        type="file"
        accept={acceptedUploadMimes(channel, transport)?.join(",") ?? ACCEPTED_TYPES}
        multiple
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  );
}
