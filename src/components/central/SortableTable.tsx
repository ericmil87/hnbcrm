import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: string;
  /** Valor usado na ordenação; null sempre vai para o fim. */
  sortValue?: (row: T) => number | string | null;
  render: (row: T) => React.ReactNode;
  align?: "left" | "right";
  className?: string;
}

interface SortableTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  initialSort?: { key: string; dir: "asc" | "desc" };
  rowClassName?: (row: T) => string | undefined;
  footer?: React.ReactNode;
  caption: string;
}

/** Tabela ordenável; no celular rola na horizontal com a 1ª coluna fixa. */
export function SortableTable<T>({
  rows,
  columns,
  rowKey,
  initialSort,
  rowClassName,
  footer,
  caption,
}: SortableTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const cmp = typeof va === "string" ? va.localeCompare(String(vb), "pt-BR") : va - (vb as number);
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, columns, sort]);

  const toggle = (key: string) => {
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }
    );
  };

  return (
    <div className="overflow-x-auto -mx-4 md:mx-0">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            {columns.map((col, idx) => {
              const active = sort?.key === col.key;
              const Arrow = active && sort?.dir === "asc" ? ArrowUp : ArrowDown;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cn(
                    "px-3 py-2 font-medium text-text-muted text-xs whitespace-nowrap",
                    col.align === "right" ? "text-right" : "text-left",
                    idx === 0 && "sticky left-0 z-[1] bg-surface-raised pl-4 md:pl-3"
                  )}
                >
                  {col.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggle(col.key)}
                      className={cn(
                        "inline-flex min-h-[32px] items-center gap-1 rounded hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                        active && "text-text-primary",
                        col.align === "right" && "flex-row-reverse"
                      )}
                    >
                      {col.header}
                      <Arrow size={12} className={cn(!active && "opacity-0")} aria-hidden="true" />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} className={cn("border-b border-border-subtle last:border-0", rowClassName?.(row))}>
              {columns.map((col, idx) => (
                <td
                  key={col.key}
                  className={cn(
                    "px-3 py-2.5 whitespace-nowrap",
                    col.align === "right" ? "text-right tabular-nums" : "text-left",
                    idx === 0 && "sticky left-0 z-[1] bg-surface-raised pl-4 md:pl-3",
                    col.className
                  )}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}
