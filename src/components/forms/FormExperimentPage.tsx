import { useState } from "react";
import { useOutletContext, useNavigate, useParams } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  Trophy,
  Users,
  Clock,
  FlaskConical,
  TrendingUp,
  Info,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface VariantStats {
  conversionRate: number;
  credibleIntervalLow: number;
  credibleIntervalHigh: number;
  probabilityOfWinning: number;
}

interface Variant {
  _id: Id<"formExperimentVariants">;
  name: string;
  variantKey: string;
  trafficWeight: number;
  views: number;
  conversions: number;
  isControl: boolean;
  formId: Id<"forms">;
  stats?: VariantStats;
}

interface Experiment {
  _id: Id<"formExperiments">;
  name: string;
  status: "draft" | "running" | "paused" | "concluded";
  hypothesis?: string;
  startedAt?: number;
  concludedAt?: number;
  winnerVariantId?: string;
  variants: Variant[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPct(value: number): string {
  return (value * 100).toFixed(1) + "%";
}

function formatNumber(value: number): string {
  return value.toLocaleString("pt-BR");
}

function getDurationDays(startedAt?: number): number {
  if (!startedAt) return 0;
  return Math.floor((Date.now() - startedAt) / (1000 * 60 * 60 * 24));
}

function getStatusBadgeVariant(
  status: Experiment["status"]
): "warning" | "success" | "default" | "info" {
  switch (status) {
    case "draft":
      return "warning";
    case "running":
      return "success";
    case "paused":
      return "default";
    case "concluded":
      return "info";
  }
}

function getStatusLabel(status: Experiment["status"]): string {
  switch (status) {
    case "draft":
      return "Rascunho";
    case "running":
      return "Em execucao";
    case "paused":
      return "Pausado";
    case "concluded":
      return "Concluido";
  }
}

// ── Summary Card ──────────────────────────────────────────────────────────────

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subtext?: string;
}

function SummaryCard({ icon, label, value, subtext }: SummaryCardProps) {
  return (
    <div className="bg-surface-raised border border-border rounded-card p-4 md:p-5 flex items-start gap-3">
      <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-brand-500/10 flex items-center justify-center">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">
          {label}
        </p>
        <p className="text-xl md:text-2xl font-bold text-text-primary tabular-nums leading-tight">
          {value}
        </p>
        {subtext && (
          <p className="text-xs text-text-muted mt-0.5">{subtext}</p>
        )}
      </div>
    </div>
  );
}

// ── Probability Bar ───────────────────────────────────────────────────────────

interface ProbabilityBarProps {
  variants: Variant[];
}

function ProbabilityBar({ variants }: ProbabilityBarProps) {
  const total = variants.reduce(
    (sum, v) => sum + (v.stats?.probabilityOfWinning ?? 0),
    0
  );

  if (total === 0) {
    return (
      <div className="h-4 rounded-full bg-surface-overlay overflow-hidden">
        <div className="h-full w-full bg-surface-overlay" />
      </div>
    );
  }

  // Find the winner variant index (highest probability)
  let winnerIdx = 0;
  let maxProb = -1;
  variants.forEach((v, i) => {
    const prob = v.stats?.probabilityOfWinning ?? 0;
    if (prob > maxProb) {
      maxProb = prob;
      winnerIdx = i;
    }
  });

  return (
    <div className="flex h-4 rounded-full overflow-hidden gap-px">
      {variants.map((variant, idx) => {
        const prob = variant.stats?.probabilityOfWinning ?? 0;
        const widthPct = total > 0 ? (prob / total) * 100 : 100 / variants.length;
        const isWinner = idx === winnerIdx;
        return (
          <div
            key={variant._id}
            title={`${variant.name}: ${formatPct(prob)}`}
            className={cn(
              "h-full transition-all duration-500",
              isWinner ? "bg-brand-600" : "bg-surface-overlay"
            )}
            style={{ width: `${widthPct}%` }}
          />
        );
      })}
    </div>
  );
}

// ── Traffic Split Controls ────────────────────────────────────────────────────

interface TrafficSplitControlsProps {
  variants: Variant[];
  experimentId: Id<"formExperiments">;
}

function TrafficSplitControls({
  variants,
  experimentId,
}: TrafficSplitControlsProps) {
  const updateTrafficSplit = useMutation(api.formExperiments.updateTrafficSplit);

  // Local state: track variant weights as an array aligned to variants order.
  // We use basis points (0-10000) internally.
  const [weights, setWeights] = useState<number[]>(() =>
    variants.map((v) => v.trafficWeight)
  );
  const [isSaving, setIsSaving] = useState(false);

  const totalWeight = weights.reduce((s, w) => s + w, 0);

  // When the first slider changes, mirror the remainder to the second slider
  // (only works cleanly for 2 variants; generalises with clamping for N)
  function handleChange(idx: number, rawValue: number) {
    if (variants.length === 2) {
      const clamped = Math.max(0, Math.min(10000, rawValue));
      const other = 10000 - clamped;
      const next = [...weights];
      next[idx] = clamped;
      next[idx === 0 ? 1 : 0] = other;
      setWeights(next);
    } else {
      const next = [...weights];
      next[idx] = Math.max(0, Math.min(10000, rawValue));
      setWeights(next);
    }
  }

  async function handleSave() {
    if (totalWeight !== 10000) {
      toast.error("Os pesos de trafego devem somar 100%.");
      return;
    }
    setIsSaving(true);
    try {
      await updateTrafficSplit({
        experimentId,
        splits: variants.map((v, i) => ({
          variantId: v._id,
          weight: weights[i],
        })),
      });
      toast.success("Divisao de trafego atualizada.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erro desconhecido";
      toast.error(`Falha ao atualizar: ${message}`);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="bg-surface-raised border border-border rounded-card p-4 md:p-6">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp size={18} className="text-brand-400" />
        <h3 className="text-sm font-semibold text-text-primary">
          Divisao de Trafego
        </h3>
      </div>

      <div className="space-y-5">
        {variants.map((variant, idx) => {
          const pct = ((weights[idx] / 10000) * 100).toFixed(0);
          return (
            <div key={variant._id}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium text-text-secondary">
                  {variant.name}
                  {variant.isControl && (
                    <span className="ml-1.5 text-xs text-text-muted">
                      (controle)
                    </span>
                  )}
                </span>
                <span className="text-sm font-semibold text-brand-400 tabular-nums w-12 text-right">
                  {pct}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={10000}
                step={100}
                value={weights[idx]}
                onChange={(e) => handleChange(idx, Number(e.target.value))}
                className="w-full h-2 rounded-full appearance-none bg-surface-overlay cursor-pointer accent-brand-600"
                aria-label={`Peso de trafego para ${variant.name}`}
              />
            </div>
          );
        })}

        {totalWeight !== 10000 && (
          <p className="flex items-center gap-1.5 text-xs text-semantic-warning">
            <Info size={13} />
            O total deve ser 100%. Atual:{" "}
            {((totalWeight / 10000) * 100).toFixed(0)}%
          </p>
        )}
      </div>

      <div className="mt-5 flex justify-end">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={isSaving || totalWeight !== 10000}
        >
          {isSaving ? "Salvando..." : "Salvar Divisao"}
        </Button>
      </div>
    </div>
  );
}

// ── Winner Declaration Dialog ─────────────────────────────────────────────────

interface WinnerDialogProps {
  open: boolean;
  onClose: () => void;
  variants: Variant[];
  onConfirm: (variantKey: string) => void;
}

function WinnerDialog({
  open,
  onClose,
  variants,
  onConfirm,
}: WinnerDialogProps) {
  const [selectedKey, setSelectedKey] = useState<string>(
    () => variants.find((v) => v.isControl)?.variantKey ?? variants[0]?.variantKey ?? ""
  );

  return (
    <Modal open={open} onClose={onClose} title="Declarar Vencedor">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary leading-relaxed">
          Selecione a variante vencedora. O experimento sera encerrado e os
          dados serao preservados.
        </p>

        <div className="space-y-2">
          {variants.map((variant) => {
            const cr = variant.stats?.conversionRate ?? 0;
            const isSelected = selectedKey === variant.variantKey;
            return (
              <button
                key={variant._id}
                type="button"
                onClick={() => setSelectedKey(variant.variantKey)}
                className={cn(
                  "w-full text-left flex items-center justify-between rounded-lg px-4 py-3 border transition-colors duration-150",
                  isSelected
                    ? "border-brand-500 bg-brand-500/10"
                    : "border-border bg-surface-overlay hover:border-border-strong"
                )}
                aria-pressed={isSelected}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {isSelected && (
                    <Trophy size={16} className="text-brand-400 flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {variant.name}
                    </p>
                    {variant.isControl && (
                      <p className="text-xs text-text-muted">Controle</p>
                    )}
                  </div>
                </div>
                <span className="text-sm font-semibold text-brand-400 tabular-nums ml-3 flex-shrink-0">
                  {formatPct(cr)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onConfirm(selectedKey);
              onClose();
            }}
            disabled={!selectedKey}
            className="flex-1"
          >
            Confirmar Vencedor
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function FormExperimentPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { formId, experimentId } = useParams<{
    formId: string;
    experimentId: string;
  }>();
  const navigate = useNavigate();

  const [showPauseConfirm, setShowPauseConfirm] = useState(false);
  const [showWinnerDialog, setShowWinnerDialog] = useState(false);

  const experiment = useQuery(
    api.formExperiments.getExperiment,
    experimentId
      ? { experimentId: experimentId as Id<"formExperiments"> }
      : "skip"
  ) as Experiment | null | undefined;

  const startExperiment = useMutation(api.formExperiments.startExperiment);
  const pauseExperiment = useMutation(api.formExperiments.pauseExperiment);
  const resumeExperiment = useMutation(api.formExperiments.resumeExperiment);
  const concludeExperiment = useMutation(api.formExperiments.concludeExperiment);

  // Ensure organizationId is used (required by context) — suppress unused warning
  void organizationId;

  // ── Action handlers ──────────────────────────────────────────────────────

  async function handleStart() {
    if (!experimentId) return;
    try {
      await startExperiment({
        experimentId: experimentId as Id<"formExperiments">,
      });
      toast.success("Experimento iniciado com sucesso.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erro desconhecido";
      toast.error(`Falha ao iniciar: ${message}`);
    }
  }

  async function handlePause() {
    if (!experimentId) return;
    try {
      await pauseExperiment({
        experimentId: experimentId as Id<"formExperiments">,
      });
      toast.success("Experimento pausado.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erro desconhecido";
      toast.error(`Falha ao pausar: ${message}`);
    }
  }

  async function handleResume() {
    if (!experimentId) return;
    try {
      await resumeExperiment({
        experimentId: experimentId as Id<"formExperiments">,
      });
      toast.success("Experimento retomado.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erro desconhecido";
      toast.error(`Falha ao retomar: ${message}`);
    }
  }

  async function handleDeclareWinner(winnerVariantKey: string) {
    if (!experimentId) return;
    try {
      await concludeExperiment({
        experimentId: experimentId as Id<"formExperiments">,
        winnerVariantKey,
      });
      toast.success("Vencedor declarado. Experimento encerrado.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erro desconhecido";
      toast.error(`Falha ao encerrar: ${message}`);
    }
  }

  // ── Loading / not found states ───────────────────────────────────────────

  if (experiment === undefined) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Spinner size="lg" />
      </div>
    );
  }

  if (experiment === null) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 md:px-6 md:py-8">
        <button
          type="button"
          onClick={() =>
            navigate(`/app/formularios/${formId ?? ""}`)
          }
          className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors mb-6 min-h-[44px]"
          aria-label="Voltar para o construtor de formulario"
        >
          <ArrowLeft size={18} />
          Voltar
        </button>
        <div className="text-center py-16">
          <FlaskConical size={40} className="text-text-muted mx-auto mb-4" />
          <p className="text-text-secondary text-base">
            Experimento nao encontrado.
          </p>
        </div>
      </div>
    );
  }

  // ── Derived values ───────────────────────────────────────────────────────

  const variants = experiment.variants ?? [];
  const status = experiment.status;
  const totalViews = variants.reduce((sum, v) => sum + v.views, 0);
  const durationDays = getDurationDays(experiment.startedAt);
  const canEditSplit = status === "draft" || status === "paused";
  const canDeclareWinner =
    status === "draft" || status === "paused" || status === "running";

  // Best variant by probability of winning (for table row highlight)
  const bestVariantKey = variants.reduce<string | null>((best, v) => {
    if (!best) return v.variantKey;
    const bestVariant = variants.find((vv) => vv.variantKey === best);
    const bestProb = bestVariant?.stats?.probabilityOfWinning ?? 0;
    const thisProb = v.stats?.probabilityOfWinning ?? 0;
    return thisProb > bestProb ? v.variantKey : best;
  }, null);

  return (
    <main className="min-h-screen bg-surface-base">
      <div className="max-w-5xl mx-auto px-4 py-6 md:px-6 md:py-8 space-y-6">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className="space-y-3">
          <button
            type="button"
            onClick={() =>
              navigate(`/app/formularios/${formId ?? ""}`)
            }
            className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors min-h-[44px]"
            aria-label="Voltar para o construtor de formulario"
          >
            <ArrowLeft size={18} />
            Voltar ao formulario
          </button>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            {/* Left: title + badge + hypothesis */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h1 className="text-xl md:text-2xl font-bold text-text-primary leading-tight">
                  {experiment.name}
                </h1>
                <Badge variant={getStatusBadgeVariant(status)}>
                  {getStatusLabel(status)}
                </Badge>
              </div>
              {experiment.hypothesis && (
                <p className="text-sm text-text-secondary leading-relaxed max-w-2xl">
                  {experiment.hypothesis}
                </p>
              )}
            </div>

            {/* Right: action buttons */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {status === "draft" && (
                <Button size="sm" variant="primary" onClick={handleStart}>
                  <Play size={16} />
                  Iniciar
                </Button>
              )}
              {status === "running" && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setShowPauseConfirm(true)}
                >
                  <Pause size={16} />
                  Pausar
                </Button>
              )}
              {status === "paused" && (
                <Button size="sm" variant="primary" onClick={handleResume}>
                  <RotateCcw size={16} />
                  Retomar
                </Button>
              )}
              {canDeclareWinner && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowWinnerDialog(true)}
                >
                  <Trophy size={16} />
                  Declarar Vencedor
                </Button>
              )}
            </div>
          </div>
        </header>

        {/* ── Summary Cards ────────────────────────────────────────────────── */}
        <section
          aria-label="Resumo do experimento"
          className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4"
        >
          <SummaryCard
            icon={<Users size={20} className="text-brand-400" />}
            label="Total de Visitantes"
            value={formatNumber(totalViews)}
            subtext="em todas as variantes"
          />
          <SummaryCard
            icon={<Clock size={20} className="text-brand-400" />}
            label="Duracao"
            value={
              experiment.startedAt
                ? durationDays === 0
                  ? "Menos de 1 dia"
                  : `${durationDays} dia${durationDays !== 1 ? "s" : ""}`
                : "—"
            }
            subtext={
              experiment.startedAt
                ? `Iniciado em ${new Date(experiment.startedAt).toLocaleDateString("pt-BR")}`
                : "Ainda nao iniciado"
            }
          />
          <SummaryCard
            icon={<FlaskConical size={20} className="text-brand-400" />}
            label="Status"
            value={getStatusLabel(status)}
            subtext={
              experiment.concludedAt
                ? `Encerrado em ${new Date(experiment.concludedAt).toLocaleDateString("pt-BR")}`
                : undefined
            }
          />
        </section>

        {/* ── Variant Comparison Table ─────────────────────────────────────── */}
        <section aria-label="Comparacao de variantes">
          <div className="bg-surface-raised border border-border rounded-card overflow-hidden">
            <div className="px-4 py-3 md:px-6 md:py-4 border-b border-border flex items-center gap-2">
              <TrendingUp size={18} className="text-brand-400" />
              <h2 className="text-sm font-semibold text-text-primary">
                Comparacao de Variantes
              </h2>
            </div>

            {/* Mobile: stacked cards */}
            <div className="md:hidden divide-y divide-border">
              {variants.map((variant) => {
                const cr = variant.stats?.conversionRate ?? 0;
                const prob = variant.stats?.probabilityOfWinning ?? 0;
                const isLeading = variant.variantKey === bestVariantKey;
                return (
                  <div
                    key={variant._id}
                    className={cn(
                      "px-4 py-4 space-y-2",
                      isLeading && status === "running"
                        ? "bg-brand-500/5"
                        : ""
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-text-primary">
                          {variant.name}
                        </p>
                        {variant.isControl && (
                          <span className="text-xs text-text-muted">
                            controle
                          </span>
                        )}
                      </div>
                      {isLeading && status === "running" && (
                        <Trophy size={16} className="text-brand-400" />
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-[11px] text-text-muted uppercase tracking-wide">
                          Visitantes
                        </p>
                        <p className="text-sm font-semibold text-text-primary tabular-nums">
                          {formatNumber(variant.views)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-text-muted uppercase tracking-wide">
                          Conversoes
                        </p>
                        <p className="text-sm font-semibold text-text-primary tabular-nums">
                          {formatNumber(variant.conversions)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-text-muted uppercase tracking-wide">
                          Taxa
                        </p>
                        <p
                          className={cn(
                            "text-sm font-semibold tabular-nums",
                            isLeading && status === "running"
                              ? "text-semantic-success"
                              : "text-text-primary"
                          )}
                        >
                          {formatPct(cr)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-text-muted text-xs">
                        Prob. de vencer
                      </span>
                      <span
                        className={cn(
                          "font-semibold tabular-nums",
                          isLeading && status === "running"
                            ? "text-brand-400"
                            : "text-text-secondary"
                        )}
                      >
                        {formatPct(prob)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop: table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm" aria-label="Tabela de variantes">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-6 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">
                      Variante
                    </th>
                    <th className="text-right px-6 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">
                      Visitantes
                    </th>
                    <th className="text-right px-6 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">
                      Conversoes
                    </th>
                    <th className="text-right px-6 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">
                      Taxa
                    </th>
                    <th className="text-right px-6 py-3 text-xs font-medium text-text-muted uppercase tracking-wide">
                      Prob. de vencer
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {variants.map((variant) => {
                    const cr = variant.stats?.conversionRate ?? 0;
                    const prob = variant.stats?.probabilityOfWinning ?? 0;
                    const isLeading = variant.variantKey === bestVariantKey;
                    return (
                      <tr
                        key={variant._id}
                        className={cn(
                          "transition-colors",
                          isLeading && status === "running"
                            ? "bg-brand-500/5"
                            : "hover:bg-surface-overlay/50"
                        )}
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            {isLeading && status === "running" && (
                              <Trophy
                                size={15}
                                className="text-brand-400 flex-shrink-0"
                              />
                            )}
                            <div>
                              <p className="font-medium text-text-primary">
                                {variant.name}
                              </p>
                              {variant.isControl && (
                                <p className="text-xs text-text-muted">
                                  controle
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right tabular-nums text-text-secondary">
                          {formatNumber(variant.views)}
                        </td>
                        <td className="px-6 py-4 text-right tabular-nums text-text-secondary">
                          {formatNumber(variant.conversions)}
                        </td>
                        <td
                          className={cn(
                            "px-6 py-4 text-right tabular-nums font-semibold",
                            isLeading && status === "running"
                              ? "text-semantic-success"
                              : "text-text-primary"
                          )}
                        >
                          {formatPct(cr)}
                        </td>
                        <td
                          className={cn(
                            "px-6 py-4 text-right tabular-nums font-semibold",
                            isLeading && status === "running"
                              ? "text-brand-400"
                              : "text-text-secondary"
                          )}
                        >
                          {formatPct(prob)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── Probability Bar ──────────────────────────────────────────────── */}
        {variants.length > 0 && (
          <section
            aria-label="Distribuicao de probabilidade"
            className="bg-surface-raised border border-border rounded-card p-4 md:p-6"
          >
            <h3 className="text-sm font-semibold text-text-primary mb-3">
              Distribuicao de Probabilidade de Vitoria
            </h3>
            <ProbabilityBar variants={variants} />
            <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3">
              {variants.map((variant, idx) => {
                const isLeading = variant.variantKey === bestVariantKey;
                return (
                  <div key={variant._id} className="flex items-center gap-1.5">
                    <div
                      className={cn(
                        "w-2.5 h-2.5 rounded-sm flex-shrink-0",
                        idx === 0 && isLeading
                          ? "bg-brand-600"
                          : isLeading
                          ? "bg-brand-600"
                          : "bg-surface-overlay border border-border-strong"
                      )}
                    />
                    <span className="text-xs text-text-secondary">
                      {variant.name}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Traffic Split Controls (draft / paused) ──────────────────────── */}
        {canEditSplit && variants.length > 0 && (
          <section aria-label="Controles de divisao de trafego">
            <TrafficSplitControls
              variants={variants}
              experimentId={experiment._id}
            />
          </section>
        )}

        {/* ── Concluded info bar ───────────────────────────────────────────── */}
        {status === "concluded" && experiment.winnerVariantId && (
          <div className="flex items-center gap-3 bg-semantic-success/10 border border-semantic-success/20 rounded-card px-4 py-3">
            <Trophy size={18} className="text-semantic-success flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-semantic-success">
                Experimento encerrado
              </p>
              {(() => {
                const winner = variants.find(
                  (v) => v.variantKey === experiment.winnerVariantId
                );
                return winner ? (
                  <p className="text-xs text-text-secondary mt-0.5">
                    Variante vencedora:{" "}
                    <span className="font-medium text-text-primary">
                      {winner.name}
                    </span>{" "}
                    &mdash; taxa de conversao:{" "}
                    <span className="font-semibold tabular-nums">
                      {formatPct(winner.stats?.conversionRate ?? 0)}
                    </span>
                  </p>
                ) : null;
              })()}
            </div>
          </div>
        )}
      </div>

      {/* ── Pause Confirm Dialog ─────────────────────────────────────────── */}
      <ConfirmDialog
        open={showPauseConfirm}
        onClose={() => setShowPauseConfirm(false)}
        onConfirm={handlePause}
        title="Pausar Experimento"
        description="O trafego sera interrompido e nenhum dado novo sera coletado enquanto o experimento estiver pausado. Voce pode retomar a qualquer momento."
        confirmLabel="Pausar"
        cancelLabel="Cancelar"
        variant="default"
      />

      {/* ── Winner Declaration Dialog ──────────────────────────────────────── */}
      {showWinnerDialog && variants.length > 0 && (
        <WinnerDialog
          open={showWinnerDialog}
          onClose={() => setShowWinnerDialog(false)}
          variants={variants}
          onConfirm={handleDeclareWinner}
        />
      )}
    </main>
  );
}
