import { useState } from "react";
import { useOutletContext, useParams, useNavigate, Link } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import {
  ArrowLeft,
  BarChart3,
  TrendingUp,
  Shield,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DailySubmission {
  date: string;
  count: number;
}

interface UtmSource {
  source: string;
  count: number;
}

interface FormAnalytics {
  total: number;
  processed: number;
  spam: number;
  error: number;
  last7Days: number;
  last30Days: number;
  spamRate: number;
  dailySubmissions: DailySubmission[];
  utmSources: UtmSource[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString("pt-BR");
}

function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

function formatShortDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year.slice(2)}`;
}

// ── Sparkline SVG ─────────────────────────────────────────────────────────────

interface SparklineProps {
  data: DailySubmission[];
}

function Sparkline({ data }: SparklineProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[120px] text-text-muted text-sm">
        Sem dados para exibir
      </div>
    );
  }

  const WIDTH = 600;
  const HEIGHT = 120;
  const PADDING_X = 0;
  const PADDING_TOP = 12;
  const PADDING_BOTTOM = 20;

  const plotHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
  const plotWidth = WIDTH - PADDING_X * 2;

  const counts = data.map((d) => d.count);
  const maxCount = Math.max(...counts, 1);
  const minCount = 0;

  function xAt(index: number): number {
    if (data.length === 1) return plotWidth / 2;
    return PADDING_X + (index / (data.length - 1)) * plotWidth;
  }

  function yAt(count: number): number {
    const ratio = (count - minCount) / (maxCount - minCount);
    return PADDING_TOP + plotHeight - ratio * plotHeight;
  }

  const points = data.map((d, i) => `${xAt(i)},${yAt(d.count)}`).join(" ");

  const areaPoints = [
    `${xAt(0)},${HEIGHT - PADDING_BOTTOM}`,
    ...data.map((d, i) => `${xAt(i)},${yAt(d.count)}`),
    `${xAt(data.length - 1)},${HEIGHT - PADDING_BOTTOM}`,
  ].join(" ");

  const firstDate = formatShortDate(data[0].date);
  const lastDate = formatShortDate(data[data.length - 1].date);

  return (
    <div className="w-full overflow-hidden">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: 120 }}
        aria-label="Grafico de submissoes diarias nos ultimos 30 dias"
        role="img"
      >
        <defs>
          <linearGradient id="sparkline-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#EA580C" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#EA580C" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Area fill */}
        <polygon
          points={areaPoints}
          fill="url(#sparkline-fill)"
        />

        {/* Line */}
        <polyline
          points={points}
          fill="none"
          stroke="#EA580C"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Dots */}
        {data.map((d, i) => (
          <circle
            key={d.date}
            cx={xAt(i)}
            cy={yAt(d.count)}
            r={data.length > 15 ? 2 : 3}
            fill="#EA580C"
            stroke="#18181B"
            strokeWidth="1.5"
          />
        ))}
      </svg>

      {/* X-axis labels */}
      <div className="flex justify-between mt-1 px-0">
        <span className="text-xs text-text-muted tabular-nums">{firstDate}</span>
        <span className="text-xs text-text-muted tabular-nums">{lastDate}</span>
      </div>
    </div>
  );
}

// ── Summary Card ──────────────────────────────────────────────────────────────

interface SummaryCardProps {
  label: string;
  value: string;
  valueClassName?: string;
  sub?: string;
}

function SummaryCard({ label, value, valueClassName, sub }: SummaryCardProps) {
  return (
    <div className="bg-surface-raised border border-border rounded-card p-4 md:p-5 flex flex-col gap-1">
      <p className="text-xs font-medium text-text-muted uppercase tracking-wide leading-none">
        {label}
      </p>
      <p
        className={cn(
          "text-2xl font-bold tabular-nums leading-tight mt-1",
          valueClassName ?? "text-text-primary"
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="text-xs text-text-muted leading-none">{sub}</p>
      )}
    </div>
  );
}

// ── Status Breakdown Card ─────────────────────────────────────────────────────

interface StatusBreakdownCardProps {
  icon: React.ReactNode;
  label: string;
  count: number;
  total: number;
  badgeVariant: "success" | "error" | "warning" | "default";
  badgeLabel: string;
}

function StatusBreakdownCard({
  icon,
  label,
  count,
  total,
  badgeVariant,
  badgeLabel,
}: StatusBreakdownCardProps) {
  const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";

  return (
    <div className="bg-surface-raised border border-border rounded-card p-4 flex items-center gap-4">
      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-surface-overlay shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="text-xs text-text-muted tabular-nums mt-0.5">
          {formatNumber(count)} ({pct}%)
        </p>
      </div>
      <Badge variant={badgeVariant}>{badgeLabel}</Badge>
    </div>
  );
}

// ── UTM Source Table ──────────────────────────────────────────────────────────

interface UtmSourceTableProps {
  sources: UtmSource[];
  total: number;
}

function UtmSourceTable({ sources, total }: UtmSourceTableProps) {
  if (sources.length === 0) return null;

  const maxCount = Math.max(...sources.map((s) => s.count), 1);

  return (
    <section
      className="bg-surface-raised border border-border rounded-card overflow-hidden"
      aria-label="Origens de trafego (UTM)"
    >
      <div className="px-4 py-3 md:px-5 md:py-4 border-b border-border">
        <h2 className="text-sm font-semibold text-text-primary">
          Origens de Trafego (UTM)
        </h2>
        <p className="text-xs text-text-muted mt-0.5">
          Canais que geraram submissoes com parametros UTM
        </p>
      </div>

      <div className="divide-y divide-border-subtle">
        {sources.map((s) => {
          const pct = total > 0 ? (s.count / total) * 100 : 0;
          const barWidth = (s.count / maxCount) * 100;

          return (
            <div key={s.source} className="px-4 py-3 md:px-5 flex items-center gap-4">
              {/* Source name */}
              <div className="w-28 md:w-36 shrink-0">
                <p className="text-sm font-medium text-text-primary truncate capitalize">
                  {s.source}
                </p>
              </div>

              {/* Bar */}
              <div className="flex-1 min-w-0">
                <div className="h-2 rounded-full bg-surface-overlay overflow-hidden">
                  <div
                    className="h-full rounded-full bg-brand-600 transition-all duration-500"
                    style={{ width: `${barWidth}%` }}
                    role="presentation"
                  />
                </div>
              </div>

              {/* Count + percent */}
              <div className="w-24 shrink-0 text-right">
                <span className="text-sm font-semibold text-text-primary tabular-nums">
                  {formatNumber(s.count)}
                </span>
                <span className="text-xs text-text-muted ml-1 tabular-nums">
                  ({formatPercent(pct)})
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Loading Skeleton ──────────────────────────────────────────────────────────

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="bg-surface-raised border border-border rounded-card p-4 md:p-5 h-24"
          />
        ))}
      </div>

      {/* Chart */}
      <div className="bg-surface-raised border border-border rounded-card p-4 md:p-5 h-48" />

      {/* Status breakdown */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="bg-surface-raised border border-border rounded-card p-4 h-16"
          />
        ))}
      </div>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────

function EmptyAnalytics({ formId }: { formId: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-raised border border-border flex items-center justify-center mb-4">
        <BarChart3 size={28} className="text-text-muted" />
      </div>
      <h2 className="text-base font-semibold text-text-primary mb-1">
        Sem dados de analitica ainda
      </h2>
      <p className="text-sm text-text-secondary max-w-xs mb-6">
        As metricas aparecerão aqui quando o formulario receber suas primeiras submissoes.
      </p>
      <Link
        to={`/app/formularios/${formId}/submissoes`}
        className={cn(
          "inline-flex items-center gap-2 rounded-full px-4 h-10 text-sm font-medium",
          "bg-surface-raised border border-border text-text-secondary",
          "hover:border-border-strong hover:text-text-primary transition-colors duration-150",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
        )}
      >
        <ExternalLink size={16} />
        Ver submissoes
      </Link>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function FormAnalyticsPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();

  // Stable timestamp — must not use Date.now() directly in useQuery args
  const [now] = useState(() => Date.now());

  const typedFormId = formId as Id<"forms"> | undefined;

  const form = useQuery(
    api.forms.getForm,
    typedFormId ? { formId: typedFormId } : "skip"
  );

  const analytics = useQuery(
    api.formSubmissions.getFormAnalytics,
    typedFormId
      ? { formId: typedFormId, organizationId, now }
      : "skip"
  );

  // ── Guard: missing param ─────────────────────────────────────────────────────
  if (!typedFormId) {
    return (
      <main className="min-h-screen bg-surface-base flex items-center justify-center">
        <p className="text-text-muted text-sm">Formulario nao encontrado.</p>
      </main>
    );
  }

  const isLoading = analytics === undefined || form === undefined;
  const hasData = analytics !== null && analytics !== undefined && analytics.total > 0;

  const spamRateHigh =
    analytics && typeof analytics.spamRate === "number" && analytics.spamRate > 5;

  return (
    <main className="min-h-screen bg-surface-base">
      <div className="max-w-5xl mx-auto px-4 py-6 md:px-6 md:py-8">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className="flex items-start gap-3 mb-6 md:mb-8">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/app/formularios/${typedFormId}`)}
            aria-label="Voltar para o formulario"
            className="shrink-0 mt-0.5"
          >
            <ArrowLeft size={18} />
            <span className="hidden sm:inline">Voltar</span>
          </Button>

          <div className="flex-1 min-w-0">
            {form === undefined ? (
              <div className="h-6 w-40 bg-surface-raised rounded animate-pulse" />
            ) : (
              <h1 className="text-lg font-bold text-text-primary md:text-xl leading-tight truncate">
                {form?.name ?? "Formulario"}
              </h1>
            )}
            <p className="text-sm text-text-muted mt-0.5">Analitica</p>
          </div>

          <Link
            to={`/app/formularios/${typedFormId}/submissoes`}
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-3 h-9 text-sm font-medium shrink-0",
              "bg-surface-raised border border-border text-text-secondary",
              "hover:border-border-strong hover:text-text-primary transition-colors duration-150",
              "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
            )}
          >
            <ExternalLink size={15} />
            <span className="hidden sm:inline">Ver submissoes</span>
            <span className="sm:hidden">Submissoes</span>
          </Link>
        </header>

        {/* ── Loading ─────────────────────────────────────────────────────── */}
        {isLoading && <AnalyticsSkeleton />}

        {/* ── Empty ───────────────────────────────────────────────────────── */}
        {!isLoading && !hasData && (
          <EmptyAnalytics formId={typedFormId} />
        )}

        {/* ── Analytics content ───────────────────────────────────────────── */}
        {!isLoading && hasData && (
          <div className="space-y-6 animate-fade-in-up">

            {/* Summary cards — 2-col mobile, 4-col desktop */}
            <section
              aria-label="Resumo de submissoes"
              className="grid grid-cols-2 gap-3 lg:grid-cols-4"
            >
              <SummaryCard
                label="Total de submissoes"
                value={formatNumber(analytics.total)}
                valueClassName="text-brand-400"
              />
              <SummaryCard
                label="Ultimos 7 dias"
                value={formatNumber(analytics.last7Days)}
              />
              <SummaryCard
                label="Ultimos 30 dias"
                value={formatNumber(analytics.last30Days)}
              />
              <SummaryCard
                label="Taxa de spam"
                value={formatPercent(analytics.spamRate)}
                valueClassName={
                  spamRateHigh ? "text-semantic-error" : "text-semantic-success"
                }
                sub={
                  spamRateHigh
                    ? "Acima de 5% — considere reforcar a protecao"
                    : "Dentro do limite normal"
                }
              />
            </section>

            {/* Sparkline chart */}
            {analytics.dailySubmissions.length > 0 && (
              <section
                className="bg-surface-raised border border-border rounded-card p-4 md:p-5"
                aria-label="Grafico de submissoes diarias"
              >
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                      <TrendingUp size={16} className="text-brand-400" />
                      Submissoes por Dia
                    </h2>
                    <p className="text-xs text-text-muted mt-0.5">
                      Ultimos 30 dias
                    </p>
                  </div>
                  <span className="text-xs text-text-muted tabular-nums">
                    {formatNumber(analytics.last30Days)} submissoes
                  </span>
                </div>

                <Sparkline data={analytics.dailySubmissions} />
              </section>
            )}

            {/* Status breakdown */}
            <section aria-label="Detalhamento por status">
              <h2 className="text-sm font-semibold text-text-secondary mb-3 uppercase tracking-wide">
                Detalhamento por Status
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <StatusBreakdownCard
                  icon={<BarChart3 size={18} className="text-semantic-success" />}
                  label="Processadas"
                  count={analytics.processed}
                  total={analytics.total}
                  badgeVariant="success"
                  badgeLabel="Processada"
                />
                <StatusBreakdownCard
                  icon={<Shield size={18} className="text-semantic-warning" />}
                  label="Spam"
                  count={analytics.spam}
                  total={analytics.total}
                  badgeVariant="warning"
                  badgeLabel="Spam"
                />
                <StatusBreakdownCard
                  icon={<AlertTriangle size={18} className="text-semantic-error" />}
                  label="Erros"
                  count={analytics.error}
                  total={analytics.total}
                  badgeVariant="error"
                  badgeLabel="Erro"
                />
              </div>
            </section>

            {/* UTM Sources */}
            {analytics.utmSources.length > 0 && (
              <UtmSourceTable
                sources={analytics.utmSources}
                total={analytics.total}
              />
            )}

          </div>
        )}
      </div>
    </main>
  );
}
