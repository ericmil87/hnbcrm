import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface MiniFunnelColumn {
  id: string;
  title: string;
}

export interface MiniFunnelCard {
  id: string;
  title: string;
  subtitle?: string;
  columnId: string;
}

export interface MiniFunnelMovingCard {
  title: string;
  subtitle?: string;
  /** Coluna atual; trocar o valor faz o cartão deslizar até a nova coluna. */
  columnId: string;
}

export interface MiniFunnelProps {
  columns: readonly MiniFunnelColumn[];
  /** Cartões parados em cada coluna. */
  cards?: readonly MiniFunnelCard[];
  /** Cartão em destaque que desliza entre colunas (S2: o lead da Marina). */
  moving?: MiniFunnelMovingCard | null;
  /** Colunas e cartões entram em sequência (fade + subida). */
  enter?: boolean;
  /** Intervalo da entrada em sequência, em ms. Padrão: 120. */
  staggerMs?: number;
  /** Nome acessível. Padrão: "Funil". */
  label?: string;
  className?: string;
}

function delay(enter: boolean, ms: number): CSSProperties | undefined {
  return enter && ms > 0 ? { animationDelay: `${ms}ms` } : undefined;
}

function CardBody({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <span className="block truncate text-caption font-semibold text-text-primary">{title}</span>
      {subtitle && <span className="block truncate text-caption text-text-muted">{subtitle}</span>}
    </>
  );
}

/**
 * Funil em miniatura para cenas: colunas com cartões que entram em sequência
 * e um cartão em destaque que desliza de uma coluna para outra (só
 * `transform`, sem medir o DOM). Em movimento reduzido tudo aparece parado
 * na posição final.
 */
export function MiniFunnel({
  columns,
  cards = [],
  moving,
  enter = false,
  staggerMs = 120,
  label = "Funil",
  className,
}: MiniFunnelProps) {
  const template: CSSProperties = { gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(0, 1fr))` };
  const movingIndex = moving ? Math.max(0, columns.findIndex((c) => c.id === moving.columnId)) : 0;
  const movingColumn = moving ? columns[movingIndex] : undefined;

  return (
    <div role="group" aria-label={label} className={cn("relative", className)}>
      <div className="grid gap-2" style={template}>
        {columns.map((column, ci) => {
          const columnCards = cards.filter((c) => c.columnId === column.id);
          const count = columnCards.length + (moving && movingIndex === ci ? 1 : 0);
          return (
            <div
              key={column.id}
              className={cn("min-h-[9rem] min-w-0 rounded-card bg-surface-sunken p-2", enter && "motion-safe:animate-scene-in")}
              style={delay(enter, ci * staggerMs)}
            >
              <p className="mb-2 flex h-6 items-center justify-between gap-1 text-caption font-semibold text-text-secondary">
                <span className="truncate">{column.title}</span>
                <span className="tabular-nums text-text-muted">{count}</span>
              </p>
              {moving && <div aria-hidden="true" className="mb-2 h-14" />}
              <ul className="space-y-2">
                {columnCards.map((card, ki) => (
                  <li
                    key={card.id}
                    className={cn(
                      "rounded-field border border-border-subtle bg-surface-raised px-2 py-1.5 shadow-card",
                      enter && "motion-safe:animate-scene-in"
                    )}
                    style={delay(enter, (columns.length + ci + ki) * staggerMs)}
                  >
                    <CardBody title={card.title} subtitle={card.subtitle} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {moving && movingColumn && (
        <div className="pointer-events-none absolute inset-x-0 top-0 grid gap-2" style={template}>
          <div
            className="p-2 pt-10 motion-safe:transition-transform motion-safe:duration-700 motion-safe:ease-[cubic-bezier(0.2,0.8,0.2,1)]"
            style={{ transform: `translateX(calc(${movingIndex} * (100% + 0.5rem)))` }}
          >
            <div className="flex h-14 flex-col justify-center rounded-field border border-brand-500 bg-surface-raised px-2 shadow-elevated">
              <CardBody title={moving.title} subtitle={moving.subtitle} />
              <span className="sr-only">, na etapa {movingColumn.title}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
