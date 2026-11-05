import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { Gauge, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { formatMoney, parseDecimal } from "@/lib/format";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { SELECT_CLS } from "./aiTypes";

// ── Uso e custo (medidor amigável) + teto de gastos em R$ (v0.69) ──

export const USAGE_KIND_LABELS: Record<string, string> = {
  attendant: "Atendente",
  copilot: "Copiloto",
  vision: "Leitura de imagens",
  group_reply: "IA em grupos",
  group_post: "Publicações por IA",
  group_summary: "Resumos de grupo",
  group_radar: "Radar de oportunidades",
  simulator: "Simulador",
};

export const SPEND_MODE_OPTIONS = [
  { value: "warn", label: "Avisar (a IA continua funcionando)" },
  { value: "block", label: "Bloquear (atendente só sugere respostas e chama a equipe; demais recursos suspensos)" },
  { value: "off", label: "Desligado (sem avisos)" },
] as const;

export type SpendMode = (typeof SPEND_MODE_OPTIONS)[number]["value"];

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "menos de US$ 0,01";
  return formatMoney(value, "USD");
}

export function UsageCard({ organizationId }: { organizationId: Id<"organizations"> }) {
  // Mês corrente (UTC, mesma régua do backend) calculado UMA vez — nunca
  // Date.now() direto em args de query.
  const [month] = useState(() => new Date().toISOString().slice(0, 7));
  const usage = useQuery(api.aiSettings.getAiUsage, { organizationId, month });
  const setBudget = useMutation(api.aiSettings.setMonthlyBudget);
  const setSpendCap = useMutation(api.aiSettings.setSpendCap);
  const [budgetInput, setBudgetInput] = useState("");
  const [capDraft, setCapDraft] = useState<{
    mode: SpendMode;
    monthlyBrl: string;
    usdBrlRate: string;
    warnPct: string;
  } | null>(null);
  const [savingCap, setSavingCap] = useState(false);

  if (!usage) return null;
  const cap = usage.spendCap;
  const draft = capDraft ?? {
    mode: cap.mode,
    monthlyBrl: cap.monthlyBrl !== null ? String(cap.monthlyBrl) : "",
    usdBrlRate: String(cap.usdBrlRate),
    warnPct: String(cap.warnPct),
  };
  const conversationPct =
    usage.budget && usage.budget > 0
      ? Math.min(100, Math.round((usage.conversationsThisMonth / usage.budget) * 100))
      : null;
  const spendPct = usage.pct !== null ? Math.round(usage.pct) : null;
  const kinds = Object.entries(usage.byKind)
    .filter(([, k]) => k.runs > 0 || k.costUsdMicros > 0)
    .sort((a, b) => b[1].costUsdMicros - a[1].costUsdMicros);

  const saveCap = async () => {
    setSavingCap(true);
    try {
      await setSpendCap({
        organizationId,
        mode: draft.mode,
        monthlyBrl: parseDecimal(draft.monthlyBrl),
        usdBrlRate: parseDecimal(draft.usdBrlRate),
        warnPct: parseDecimal(draft.warnPct),
      });
      setCapDraft(null);
      toast.success("Teto de gastos atualizado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível salvar o teto.");
    } finally {
      setSavingCap(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
          <Gauge size={20} className="text-brand-500" />
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-text-primary">Uso do mês</h3>
          {usage.byo && (
            <p className="text-xs text-text-muted">
              Chave própria (BYO): o custo é do cliente — cobrado na conta do provider da sua
              empresa. O medidor conta igual, para o teto valer.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {usage.blocked && (
          <div className="flex gap-2 rounded-card border border-semantic-error/40 bg-semantic-error/10 p-3 text-sm text-text-primary">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-semantic-error" />
            <span>
              Teto de gastos do mês atingido. O atendente está deixando as respostas como resposta sugerida
              (chamando a equipe) e copiloto, leitura de imagens, IA em grupos,
              publicações e resumos estão suspensos até o próximo mês — ou até você aumentar o
              teto.
            </span>
          </div>
        )}
        {!usage.blocked && usage.level === "reached" && (
          <div className="flex gap-2 rounded-card border border-semantic-warning/40 bg-semantic-warning/10 p-3 text-sm text-text-primary">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-semantic-warning" />
            <span>Teto de gastos do mês atingido. Modo avisar: a IA continua funcionando.</span>
          </div>
        )}

        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 mb-1.5">
            <span className="text-sm text-text-secondary">
              Gasto aproximado:{" "}
              <strong className="text-text-primary">{formatMoney(usage.costBrl)}</strong>
              {cap.active && cap.monthlyBrl !== null ? ` de ${formatMoney(cap.monthlyBrl)}` : ""}{" "}
              <span className="text-text-muted">({formatUsd(usage.costUsdEstimate)})</span>
            </span>
            {spendPct !== null && <span className="text-xs text-text-muted">{spendPct}%</span>}
          </div>
          {spendPct !== null && (
            <div className="h-2 rounded-full bg-surface-sunken overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  spendPct >= 100
                    ? "bg-semantic-error"
                    : spendPct >= cap.warnPct
                      ? "bg-semantic-warning"
                      : "bg-brand-500"
                )}
                style={{ width: `${Math.min(100, spendPct)}%` }}
              />
            </div>
          )}
          <p
            className="mt-1.5 text-xs text-text-muted"
            title={`${usage.promptTokens.toLocaleString("pt-BR")} tokens de entrada (${usage.cachedPromptTokens.toLocaleString("pt-BR")} em cache) · ${usage.completionTokens.toLocaleString("pt-BR")} de saída · valor exato: US$ ${usage.costUsdEstimate.toFixed(6)}`}
          >
            {usage.runsThisMonth} execuções de IA no mês · valores aproximados (custo estimado em
            dólar × cotação de R$ {cap.usdBrlRate.toLocaleString("pt-BR")})
            {usage.estimatedRuns > 0
              ? ` · ${usage.estimatedRuns} com modelo sem preço conhecido (contadas pelo preço mais alto)`
              : ""}
          </p>
          {kinds.length > 0 && (
            <ul className="mt-2 grid gap-1 text-xs text-text-secondary sm:grid-cols-2">
              {kinds.map(([kind, k]) => (
                <li key={kind} className="flex justify-between gap-2">
                  <span>{USAGE_KIND_LABELS[kind] ?? kind}</span>
                  <span className="text-text-muted">
                    {k.runs} · {formatMoney((k.costUsdMicros / 1_000_000) * cap.usdBrlRate)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-card border border-border p-3 space-y-3">
          <p className="text-sm font-medium text-text-primary">Teto de gastos do mês</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Teto mensal (R$)"
              type="number"
              min={0}
              value={draft.monthlyBrl}
              onChange={(e) => setCapDraft({ ...draft, monthlyBrl: e.target.value })}
              placeholder="Sem teto"
            />
            <label className="block">
              <span className="block text-sm font-medium text-text-secondary mb-1.5">
                Ao atingir o teto
              </span>
              <select
                value={draft.mode}
                onChange={(e) => setCapDraft({ ...draft, mode: e.target.value as SpendMode })}
                className={SELECT_CLS}
              >
                {SPEND_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label="Cotação do dólar (R$)"
              type="number"
              step="0.01"
              min={1}
              max={20}
              value={draft.usdBrlRate}
              onChange={(e) => setCapDraft({ ...draft, usdBrlRate: e.target.value })}
            />
            <Input
              label="Avisar ao chegar em (%)"
              type="number"
              min={50}
              max={95}
              value={draft.warnPct}
              onChange={(e) => setCapDraft({ ...draft, warnPct: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => void saveCap()} disabled={savingCap}>
              Salvar teto
            </Button>
            {capDraft && (
              <button
                type="button"
                className="text-xs text-text-muted hover:text-text-primary"
                onClick={() => setCapDraft(null)}
              >
                Descartar alterações
              </button>
            )}
          </div>
          <p className="text-xs text-text-muted">
            Os administradores recebem um aviso (sino e e-mail) ao chegar no percentual escolhido e
            outro ao atingir o teto — uma vez por mês cada. Em "Bloquear", ao atingir o teto o
            atendente passa a deixar respostas sugeridas para a equipe (abrindo um pedido de ajuda) e os demais
            recursos de IA ficam suspensos até virar o mês.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-sm text-text-secondary">
              {usage.conversationsThisMonth}
              {usage.budget ? ` de ~${usage.budget}` : ""} conversas atendidas pela IA
            </span>
            {conversationPct !== null && (
              <span className="text-xs text-text-muted">{conversationPct}%</span>
            )}
          </div>
          {conversationPct !== null && (
            <div className="h-2 rounded-full bg-surface-sunken overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  conversationPct >= 90
                    ? "bg-semantic-error"
                    : conversationPct >= 70
                      ? "bg-semantic-warning"
                      : "bg-brand-500"
                )}
                style={{ width: `${conversationPct}%` }}
              />
            </div>
          )}
          <div className="flex items-end gap-2 pt-1">
            <div className="w-44">
              <Input
                label="Limite mensal de conversas"
                type="number"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                placeholder={usage.budget ? String(usage.budget) : "Sem limite"}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() =>
                toast.promise(
                  setBudget({
                    organizationId,
                    budget: budgetInput ? Number(budgetInput) : null,
                  }),
                  { loading: "Salvando…", success: "Limite atualizado", error: "Não foi possível salvar." }
                )
              }
            >
              Salvar
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Ao atingir o limite, a IA não atende conversas novas até o próximo mês (as já iniciadas
            continuam) e abre um pedido de ajuda para a equipe responder.
          </p>
        </div>
      </div>
    </Card>
  );
}
