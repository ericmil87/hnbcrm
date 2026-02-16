import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Copy, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { JsonHighlighter } from "./JsonHighlighter";
import { Spinner } from "@/components/ui/Spinner";

interface ResponseViewerProps {
  response: { status: number; data: unknown; time: number } | null;
  hasMore?: boolean;
  currentPage?: number;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onGoBack?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function ResponseViewer({
  response,
  hasMore = false,
  currentPage = 0,
  isLoadingMore = false,
  onLoadMore,
  onGoBack,
}: ResponseViewerProps) {
  const [copied, setCopied] = useState(false);

  if (!response) {
    return (
      <div className="h-full flex items-center justify-center bg-surface-raised">
        <p className="text-text-muted text-sm">Envie uma requisição para ver a resposta</p>
      </div>
    );
  }

  const getStatusVariant = (status: number) => {
    if (status >= 200 && status < 300) return "success";
    if (status >= 400 && status < 500) return "warning";
    if (status >= 500) return "error";
    return "default";
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(response.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const jsonString = JSON.stringify(response.data, null, 2) ?? "";
  const lineCount = jsonString.split("\n").length;
  const byteSize = new Blob([jsonString]).size;

  const showPagination = hasMore || currentPage > 0;

  return (
    <div className="h-full flex flex-col bg-surface-raised">
      <div className="px-3 py-2 border-b border-border flex items-center gap-3">
        <Badge variant={getStatusVariant(response.status)}>
          {response.status > 0 ? `${response.status}` : "Erro"}
        </Badge>
        <span className="text-xs text-text-muted tabular-nums">{response.time}ms</span>
        <Badge variant="default" className="text-[10px] px-1.5 py-0">
          {lineCount} linhas
        </Badge>
        <span className="text-[10px] text-text-muted tabular-nums">{formatBytes(byteSize)}</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={handleCopy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copiado!" : "Copiar"}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        <JsonHighlighter data={response.data} />
      </div>

      {showPagination && (
        <div className="px-3 py-2 border-t border-border flex items-center justify-between bg-surface-raised">
          <Button
            variant="ghost"
            size="sm"
            onClick={onGoBack}
            disabled={currentPage <= 0 || isLoadingMore}
          >
            <ChevronLeft size={14} />
            Anterior
          </Button>

          <Badge variant="default" className="text-xs px-2 py-0.5">
            Página {currentPage + 1}
          </Badge>

          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadMore}
            disabled={!hasMore || isLoadingMore}
          >
            {isLoadingMore ? (
              <>
                <Spinner size="sm" />
                Carregando...
              </>
            ) : (
              <>
                Próxima
                <ChevronRight size={14} />
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
