/**
 * Anexo de um item da biblioteca — UM arquivo, que é o que o bridge envia por
 * chamada (o servidor recusa mais de um). Upload pelo caminho padrão de
 * `files`: URL assinada → POST no storage → `saveFile`.
 */
import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { mutationErrorMessage } from "@/lib/errors";
import { formatFileSize } from "@/components/inbox/types";

const ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "audio/mpeg",
  "audio/ogg",
  "video/mp4",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
].join(",");

const MAX_BYTES = 16 * 1024 * 1024;

export interface FileMeta {
  name: string;
  mimeType: string;
  size: number;
  url: string | null;
}

/** Metadados do anexo já salvo (nome/mime/url) para rótulo e prévia. */
export function useFileMeta(fileId: Id<"files"> | undefined): FileMeta | undefined {
  const file = useQuery(api.files.getFile, fileId ? { fileId } : "skip");
  if (!fileId || !file) return undefined;
  return { name: file.name, mimeType: file.mimeType, size: file.size, url: file.url };
}

interface AttachmentFieldProps {
  organizationId: Id<"organizations">;
  fileId?: Id<"files">;
  onChange: (fileId: Id<"files"> | undefined) => void;
  disabled?: boolean;
}

export function AttachmentField({ organizationId, fileId, onChange, disabled }: AttachmentFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);
  const meta = useFileMeta(fileId);

  const handleFile = async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error(`O arquivo passa de ${formatFileSize(MAX_BYTES)}`);
      return;
    }
    setUploading(true);
    try {
      const uploadUrl = await generateUploadUrl({ organizationId });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error(`Falha ao enviar ${file.name}`);
      const { storageId } = await response.json();
      const savedId = await saveFile({
        organizationId,
        storageId,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        fileType: "message_attachment",
      });
      onChange(savedId);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível anexar o arquivo"));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  if (fileId) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5">
        <Paperclip size={13} className="shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
          {meta?.name ?? "anexo"}
          {meta ? ` · ${formatFileSize(meta.size)}` : ""}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(undefined)}
          aria-label="Remover anexo"
          className="text-text-muted transition-colors hover:text-semantic-error disabled:opacity-50"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <button
        type="button"
        disabled={disabled || uploading}
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-1.5 rounded-full border border-border-strong px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400 disabled:opacity-50"
      >
        {uploading ? <Loader2 size={12} className="animate-spin" /> : <Paperclip size={12} />}
        {uploading ? "Enviando…" : "Anexar arquivo"}
      </button>
    </>
  );
}
