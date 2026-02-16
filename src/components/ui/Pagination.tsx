import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({
  page,
  pageSize,
  total,
  hasMore,
  onPageChange,
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 0;
  const hasNext = hasMore || page < totalPages - 1;

  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);

  return (
    <nav
      role="navigation"
      aria-label="Paginação"
      className={cn(
        "flex flex-col sm:flex-row items-center justify-between gap-2 py-3 px-4",
        className
      )}
    >
      <span className="text-xs text-text-muted order-2 sm:order-1">
        Exibindo {start}–{end} de {total} registros
      </span>

      <div className="flex items-center gap-2 order-1 sm:order-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasPrev}
          onClick={() => onPageChange(page - 1)}
          aria-label="Página anterior"
        >
          <ChevronLeft size={16} />
          <span className="hidden sm:inline ml-1">Anterior</span>
        </Button>

        <span className="text-sm text-text-secondary font-medium tabular-nums min-w-[3rem] text-center">
          {page + 1} / {totalPages}
        </span>

        <Button
          variant="secondary"
          size="sm"
          disabled={!hasNext}
          onClick={() => onPageChange(page + 1)}
          aria-label="Próxima página"
        >
          <span className="hidden sm:inline mr-1">Próximo</span>
          <ChevronRight size={16} />
        </Button>
      </div>
    </nav>
  );
}
