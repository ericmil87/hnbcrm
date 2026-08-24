import React, { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Paperclip, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "application/json",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
].join(",");

const MAX_FILES = 5;

export interface UploadedFile {
  fileId: Id<"files">;
  name: string;
  mimeType: string;
  size: number;
}

interface FileUploadButtonProps {
  organizationId: Id<"organizations">;
  onFilesUploaded: (files: UploadedFile[]) => void;
  onFilesRemoved?: (fileId: Id<"files">) => void;
  uploadedFiles: UploadedFile[];
  disabled?: boolean;
  className?: string;
}

export function FileUploadButton({
  organizationId,
  onFilesUploaded,
  onFilesRemoved,
  uploadedFiles,
  disabled,
  className,
}: FileUploadButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);

  const handleClick = () => {
    if (disabled || uploading) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    const filesToUpload = Array.from(selectedFiles);

    // Validate count
    if (uploadedFiles.length + filesToUpload.length > MAX_FILES) {
      toast.error(`Máximo de ${MAX_FILES} arquivos por mensagem`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setUploading(true);
    setProgress(0);

    const newFiles: UploadedFile[] = [];
    let completed = 0;

    try {
      for (const file of filesToUpload) {
        // Get upload URL
        const uploadUrl = await generateUploadUrl({ organizationId });

        // Upload file to Convex storage
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });

        if (!response.ok) {
          throw new Error(`Falha ao enviar ${file.name}`);
        }

        const { storageId } = await response.json();

        // Save file metadata
        const fileId = await saveFile({
          organizationId,
          storageId,
          name: file.name,
          mimeType: file.type,
          size: file.size,
          fileType: "message_attachment",
        });

        newFiles.push({
          fileId,
          name: file.name,
          mimeType: file.type,
          size: file.size,
        });

        completed++;
        setProgress(Math.round((completed / filesToUpload.length) * 100));
      }

      onFilesUploaded(newFiles);
    } catch (error: any) {
      toast.error(error.message || "Falha ao enviar arquivo");
    } finally {
      setUploading(false);
      setProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
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
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Staged files */}
      {uploadedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
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
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || uploading || uploadedFiles.length >= MAX_FILES}
        className={cn(
          "p-2 rounded-full text-text-muted hover:text-brand-500 hover:bg-brand-500/10 transition-colors",
          "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-text-muted disabled:hover:bg-transparent"
        )}
        title={
          uploading
            ? `Enviando... ${progress}%`
            : uploadedFiles.length >= MAX_FILES
            ? `Máximo de ${MAX_FILES} arquivos`
            : "Anexar arquivo"
        }
        aria-label="Anexar arquivo"
      >
        {uploading ? (
          <Loader2 size={18} className="animate-spin" />
        ) : (
          <Paperclip size={18} />
        )}
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  );
}
