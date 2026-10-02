import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatDayMonth, formatFullDate } from "./centralFormat";

/**
 * Gráficos leves do Painel da Central — SVG/HTML próprio, sem dependência.
 * Regras: eixo de quantidade sempre a partir de zero, poucas cores (a série
 * que importa em laranja, a de contexto em cinza), rótulo direto no fim da
 * linha em vez de legenda solta, e tooltip no hover/toque.
 */

export const CHART_COLORS = {
  primary: "#FF6B00", // brand-500 — a métrica de resultado
  context: "var(--text-muted)", // série de contexto
  spend: "var(--text-muted)",
  grid: "var(--border-default)",
  axis: "var(--text-muted)",
};

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(Math.floor(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Topo "redondo" do eixo e 3 marcas intermediárias. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

interface TimeSeriesChartProps {
  data: Array<{ date: string } & Record<string, number | string>>;
  series: SeriesDef[];
  kind?: "line" | "column";
  height?: number;
  formatValue: (n: number) => string;
  formatAxis?: (n: number) => string;
  ariaLabel: string;
}

export function TimeSeriesChart({
  data,
  series,
  kind = "line",
  height = 220,
  formatValue,
  formatAxis,
  ariaLabel,
}: TimeSeriesChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const values = (i: number, key: string) => Number(data[i]?.[key] ?? 0);
  const maxValue = useMemo(() => {
    let max = 0;
    for (const row of data) for (const s of series) max = Math.max(max, Number(row[s.key] ?? 0));
    return max;
  }, [data, series]);
  const ticks = niceTicks(maxValue);
  const top = ticks[ticks.length - 1] || 1;

  const axisFmt = formatAxis ?? formatValue;
  const padLeft = Math.max(28, Math.max(...ticks.map((t) => axisFmt(t).length)) * 6.5 + 8);
  const endLabels = kind === "line";
  const padRight = endLabels ? 76 : 8;
  const padTop = 10;
  const padBottom = 24;
  const innerW = Math.max(0, width - padLeft - padRight);
  const innerH = height - padTop - padBottom;
  const n = data.length;

  const step = n > 0 ? innerW / n : 0;
  const xCenter = (i: number) =>
    kind === "column" ? padLeft + step * i + step / 2 : padLeft + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v: number) => padTop + innerH - (v / top) * innerH;

  // Rótulos do eixo X: ~6 datas, sempre incluindo a primeira e a última.
  const xLabelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 64))));
  const xLabels = data
    .map((d, i) => ({ i, date: d.date }))
    .filter(({ i }) => i % xLabelEvery === 0 || i === n - 1)
    .filter(({ i }, idx, arr) => i === n - 1 || idx === arr.length - 1 || n - 1 - i >= xLabelEvery * 0.6);

  // Rótulos no fim da linha sem se sobrepor.
  const endLabelPos = useMemo(() => {
    if (!endLabels || n === 0) return [];
    const items = series
      .map((s) => ({ s, y: y(values(n - 1, s.key)) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) {
      if (items[i].y - items[i - 1].y < 14) items[i].y = items[i - 1].y + 14;
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, series, width, top, endLabels]);

  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - padLeft;
    const i =
      kind === "column"
        ? Math.floor(x / Math.max(step, 1))
        : Math.round(n <= 1 ? 0 : (x / Math.max(innerW, 1)) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };

  const hoverRow = hover !== null ? data[hover] : null;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          className="block touch-pan-y"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={padLeft}
                x2={padLeft + innerW}
                y1={y(t)}
                y2={y(t)}
                style={{ stroke: CHART_COLORS.grid }}
                strokeWidth={1}
                strokeDasharray={t === 0 ? undefined : "2 4"}
              />
              <text
                x={padLeft - 8}
                y={y(t)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={11}
                style={{ fill: CHART_COLORS.axis }}
                className="tabular-nums"
              >
                {axisFmt(t)}
              </text>
            </g>
          ))}

          {xLabels.map(({ i, date }) => (
            <text
              key={date}
              x={xCenter(i)}
              y={height - 6}
              textAnchor={i === 0 && kind === "line" ? "start" : i === n - 1 && kind === "line" ? "end" : "middle"}
              fontSize={11}
              style={{ fill: CHART_COLORS.axis }}
              className="tabular-nums"
            >
              {formatDayMonth(date)}
            </text>
          ))}

          {kind === "column" &&
            series.map((s, si) => {
              const barW = Math.max(1, (step * 0.72) / series.length);
              return data.map((_, i) => {
                const v = values(i, s.key);
                if (v <= 0) return null;
                const x = padLeft + step * i + step * 0.14 + barW * si;
                return (
                  <rect
                    key={`${s.key}-${i}`}
                    x={x}
                    y={y(v)}
                    width={barW}
                    height={Math.max(1, y(0) - y(v))}
                    rx={Math.min(2, barW / 2)}
                    style={{ fill: s.color }}
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                );
              });
            })}

          {kind === "line" &&
            series.map((s) => {
              const d = data
                .map((_, i) => `${i === 0 ? "M" : "L"}${xCenter(i).toFixed(1)},${y(values(i, s.key)).toFixed(1)}`)
                .join(" ");
              return (
                <path
                  key={s.key}
                  d={d}
                  fill="none"
                  style={{ stroke: s.color }}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              );
            })}

          {endLabelPos.map(({ s, y: ly }) => (
            <text
              key={s.key}
              x={padLeft + innerW + 8}
              y={ly}
              dominantBaseline="middle"
              fontSize={12}
              fontWeight={600}
              style={{ fill: s.color }}
            >
              {s.label}
            </text>
          ))}

          {hover !== null && (
            <g pointerEvents="none">
              <line
                x1={xCenter(hover)}
                x2={xCenter(hover)}
                y1={padTop}
                y2={padTop + innerH}
                style={{ stroke: CHART_COLORS.axis }}
                strokeWidth={1}
                opacity={0.5}
              />
              {kind === "line" &&
                series.map((s) => (
                  <circle
                    key={s.key}
                    cx={xCenter(hover)}
                    cy={y(values(hover, s.key))}
                    r={4}
                    style={{ fill: s.color, stroke: "var(--surface-raised)" }}
                    strokeWidth={2}
                  />
                ))}
            </g>
          )}
        </svg>
      )}

      {hoverRow && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-surface-overlay px-3 py-2 text-xs shadow-elevated"
          style={{
            left: Math.min(Math.max(xCenter(hover) - 70, 0), Math.max(0, width - 150)),
          }}
        >
          <p className="font-medium text-text-primary tabular-nums">{formatFullDate(hoverRow.date)}</p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center gap-2 text-text-secondary">
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: s.color }} />
              {s.label}
              <span className="ml-auto pl-3 font-semibold text-text-primary tabular-nums">
                {formatValue(Number(hoverRow[s.key] ?? 0))}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export interface BarItem {
  key: string;
  label: string;
  value: number;
  /** Cor de identidade (unidade, estágio) — vira um ponto ao lado do rótulo. */
  dotColor?: string;
  /** Cor da barra; padrão laranja da marca. */
  barColor?: string;
  hint?: string;
  muted?: boolean;
}

/** Barras horizontais com rótulo e valor diretos — ranking, funil, motivos. */
export function BarList({
  items,
  formatValue,
  emptyText = "Sem dados no período.",
  ariaLabel,
  max: maxOverride,
}: {
  items: BarItem[];
  formatValue: (n: number) => string;
  emptyText?: string;
  ariaLabel: string;
  /** Escala compartilhada com outra lista (ex.: grupo colapsado). */
  max?: number;
}) {
  const max = maxOverride ?? Math.max(0, ...items.map((i) => i.value));
  if (items.length === 0 || max === 0) {
    return <p className="text-sm text-text-muted py-4">{emptyText}</p>;
  }
  return (
    <ul className="space-y-2.5" aria-label={ariaLabel}>
      {items.map((item) => (
        <li key={item.key} className={cn(item.muted && "opacity-50")}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2 text-text-secondary">
              {item.dotColor && (
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: item.dotColor }} />
              )}
              <span className="truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-xs text-text-muted">{item.hint}</span>}
            </span>
            <span className="shrink-0 font-semibold text-text-primary tabular-nums">{formatValue(item.value)}</span>
          </div>
          <div className="mt-1 h-2 w-full rounded-full bg-surface-sunken">
            <div
              className="h-2 rounded-full"
              style={{
                width: `${Math.max(item.value > 0 ? 1.5 : 0, (item.value / max) * 100)}%`,
                background: item.barColor ?? CHART_COLORS.primary,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Gasto × receita por campanha: duas barras por linha, mesma escala. */
export function SpendRevenueBars({
  items,
  formatValue,
}: {
  items: Array<{ key: string; label: string; spend: number; revenue: number; hint?: string }>;
  formatValue: (n: number) => string;
}) {
  const max = Math.max(0, ...items.flatMap((i) => [i.spend, i.revenue]));
  if (items.length === 0 || max === 0) {
    return <p className="text-sm text-text-muted py-4">Sem investimento nem receita atribuída no período.</p>;
  }
  const w = (v: number) => `${Math.max(v > 0 ? 1.5 : 0, (v / max) * 100)}%`;
  return (
    <div>
      <div className="mb-3 flex gap-4 text-xs text-text-secondary">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: CHART_COLORS.spend }} /> Gasto
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: CHART_COLORS.primary }} /> Receita
        </span>
      </div>
      <ul className="space-y-3.5" aria-label="Gasto e receita por campanha">
        {items.map((item) => (
          <li key={item.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-text-secondary">{item.label}</span>
              {item.hint && <span className="shrink-0 text-xs font-semibold text-text-primary tabular-nums">{item.hint}</span>}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-2 flex-1 rounded-full bg-surface-sunken">
                <div className="h-2 rounded-full" style={{ width: w(item.spend), background: CHART_COLORS.spend }} />
              </div>
              <span className="w-24 shrink-0 text-right text-xs text-text-muted tabular-nums">{formatValue(item.spend)}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="h-2 flex-1 rounded-full bg-surface-sunken">
                <div className="h-2 rounded-full" style={{ width: w(item.revenue), background: CHART_COLORS.primary }} />
              </div>
              <span className="w-24 shrink-0 text-right text-xs text-text-primary tabular-nums">{formatValue(item.revenue)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
