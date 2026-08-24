import { useId, useRef, useState } from "react";
import { AlertTriangle, FileSpreadsheet, UploadCloud, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatFileSize } from "../../../convex/lib/fileValidation";

interface FileDropZoneProps {
  /** Arquivo escolhido (componente controlado). */
  file: File | null;
  onFileChange: (file: File | null) => void;
  /** Extensões aceitas, no formato do atributo `accept`. */
  accept?: string;
  /** Limite do backend — acima disso mostramos aviso e sinalizamos o erro. */
  maxSizeBytes?: number;
  disabled?: boolean;
  /** Texto auxiliar abaixo da chamada principal. */
  hint?: string;
  className?: string;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** ".csv,.txt" → [".csv", ".txt"] */
function parseExtensions(accept: string): string[] {
  return accept
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.startsWith("."));
}

function hasAcceptedExtension(name: string, accept: string): boolean {
  const extensions = parseExtensions(accept);
  if (extensions.length === 0) return true;
  const lower = name.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

/**
 * Área de upload com arrastar-e-soltar + clique, acessível (input file real
 * escondido, associado a um `<label>`) e mobile-first.
 */
export function FileDropZone({
  file,
  onFileChange,
  accept = ".csv",
  maxSizeBytes = DEFAULT_MAX_BYTES,
  disabled = false,
  hint,
  className,
}: FileDropZoneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const extensions = parseExtensions(accept);
  const extensionLabel = extensions.join(", ") || "qualquer arquivo";
  const oversize = file !== null && file.size > maxSizeBytes;

  const selectFile = (next: File | null) => {
    if (!next) {
      setError(null);
      onFileChange(null);
      return;
    }
    if (!hasAcceptedExtension(next.name, accept)) {
      setError(`Formato não aceito. Envie um arquivo ${extensionLabel}.`);
      onFileChange(null);
      return;
    }
    setError(null);
    onFileChange(next);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) return;
    selectFile(event.dataTransfer.files?.[0] ?? null);
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const handleRemove = () => {
    if (inputRef.current) inputRef.current.value = "";
    selectFile(null);
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div
        onDragEnter={handleDragEnter}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={accept}
          disabled={disabled}
          className="peer sr-only"
          onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
        />
        <label
          htmlFor={inputId}
          className={cn(
            "flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-2 rounded-card border border-dashed px-4 py-6 text-center transition-colors",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-base",
            dragging
              ? "border-brand-500 bg-brand-500/10"
              : "border-border-strong bg-surface-sunken hover:border-brand-500/60 hover:bg-surface-overlay",
            disabled && "cursor-not-allowed opacity-60 hover:border-border-strong hover:bg-surface-sunken"
          )}
        >
          <UploadCloud size={28} className={cn(dragging ? "text-brand-500" : "text-text-muted")} />
          <span className="text-sm text-text-secondary">
            Arraste o arquivo aqui ou{" "}
            <span className="font-medium text-brand-500">clique para escolher</span>
          </span>
          <span className="text-xs text-text-muted">
            {hint ?? `Somente ${extensionLabel} · até ${formatFileSize(maxSizeBytes)}`}
          </span>
        </label>
      </div>

      {file && (
        <div
          className={cn(
            "flex items-center gap-3 rounded-lg border px-3 py-2.5",
            oversize
              ? "border-semantic-error/40 bg-semantic-error/5"
              : "border-border bg-surface-sunken"
          )}
        >
          <FileSpreadsheet
            size={18}
            className={cn("shrink-0", oversize ? "text-semantic-error" : "text-brand-500")}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text-primary" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs text-text-muted tabular-nums">{formatFileSize(file.size)}</p>
          </div>
          <button
            type="button"
            onClick={handleRemove}
            disabled={disabled}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-overlay hover:text-semantic-error focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base disabled:opacity-50"
            aria-label={`Remover ${file.name}`}
          >
            <X size={18} />
          </button>
        </div>
      )}

      {oversize && (
        <p className="flex items-start gap-2 text-xs text-semantic-error">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          Arquivo acima do limite de {formatFileSize(maxSizeBytes)}. Divida a planilha e envie em partes.
        </p>
      )}

      {error && (
        <p className="flex items-start gap-2 text-xs text-semantic-error" role="alert">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
