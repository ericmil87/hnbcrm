import { useState } from "react";
import { Building2, ChevronDown } from "lucide-react";
import { Doc } from "../../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionCard, type CentralDashboard } from "./CentralKpi";
import { BarList } from "./charts";
import { SortableTable, type Column } from "./SortableTable";
import { formatBRL, formatInt, formatPct, formatRoas } from "./centralFormat";

type UnitRow = CentralDashboard["byUnit"][number] & { onboarding: boolean };

type RankMetric = "revenue" | "converted" | "conversion";

const RANK_OPTIONS: Array<{ id: RankMetric; label: string }> = [
  { id: "revenue", label: "Receita" },
  { id: "converted", label: "Reservas" },
  { id: "conversion", label: "Conversão" },
];

export function UnitsTab({
  data,
  units,
  showSpend,
}: {
  data: CentralDashboard;
  units: Doc<"units">[];
  showSpend: boolean;
}) {
  const [metric, setMetric] = useState<RankMetric>("revenue");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const statusById = new Map(units.map((u) => [u._id as string, u.status]));
  const rows: UnitRow[] = data.byUnit.map((r) => ({
    ...r,
    onboarding: r.unitId ? statusById.get(r.unitId) === "onboarding" : false,
  }));

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="Nenhuma unidade cadastrada"
        description="Cadastre os hotéis em Configurações → Central para ver o desempenho de cada um."
      />
    );
  }

  const conv = (r: UnitRow) => (r.leads > 0 ? r.converted / r.leads : null);
  const rankValue = (r: UnitRow) =>
    metric === "revenue" ? r.revenue : metric === "converted" ? r.converted : conv(r) ?? 0;
  const ranked = [...rows].sort((a, b) => rankValue(b) - rankValue(a));
  // Unidades em implantação ficam num grupo colapsado, na MESMA escala.
  const rankedMain = ranked.filter((r) => !r.onboarding);
  const rankedOnboarding = ranked.filter((r) => r.onboarding);
  const rankMax = Math.max(0, ...ranked.map(rankValue));
  const toBarItem = (r: UnitRow) => ({
    key: r.unitId ?? "none",
    label: r.name,
    value: rankValue(r),
    dotColor: r.color,
    barColor: r.color,
    muted: r.onboarding,
  });
  const rankFormat = metric === "revenue" ? formatBRL : metric === "converted" ? formatInt : formatPct;

  const columns: Column<UnitRow>[] = [
    {
      key: "name",
      header: "Unidade",
      sortValue: (r) => r.name,
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
          <span className="font-medium text-text-primary">{r.name}</span>
          {r.onboarding && (
            <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] font-medium text-text-muted">
              em implantação
            </span>
          )}
        </span>
      ),
    },
    { key: "leads", header: "Leads", align: "right", sortValue: (r) => r.leads, render: (r) => formatInt(r.leads) },
    {
      key: "converted",
      header: "Reservas",
      align: "right",
      sortValue: (r) => r.converted,
      render: (r) => <span className="font-semibold text-text-primary">{formatInt(r.converted)}</span>,
    },
    { key: "conversion", header: "Conversão", align: "right", sortValue: conv, render: (r) => formatPct(conv(r)) },
    {
      key: "revenue",
      header: "Receita",
      align: "right",
      sortValue: (r) => r.revenue,
      render: (r) => <span className="font-semibold text-text-primary">{formatBRL(r.revenue)}</span>,
    },
    {
      key: "ticket",
      header: "Ticket médio",
      align: "right",
      sortValue: (r) => (r.converted > 0 ? r.avgTicket : null),
      render: (r) => (r.converted > 0 ? formatBRL(r.avgTicket) : "—"),
    },
    ...(showSpend
      ? ([
          { key: "spend", header: "Gasto", align: "right", sortValue: (r) => r.spend, render: (r) => formatBRL(r.spend) },
          { key: "roas", header: "ROAS (mídia paga)", align: "right", sortValue: (r) => r.roas, render: (r) => formatRoas(r.roas) },
        ] as Column<UnitRow>[])
      : []),
  ];

  const t = data.totals;
  const unitSpend = rows.reduce((s, r) => s + r.spend, 0);

  return (
    <div className="space-y-4 md:space-y-6">
      <SectionCard
        title="Ranking dos hotéis"
        subtitle="Comparação no período selecionado"
        action={
          <div className="flex shrink-0 rounded-full bg-surface-sunken p-0.5" role="group" aria-label="Métrica do ranking">
            {RANK_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setMetric(o.id)}
                aria-pressed={metric === o.id}
                className={cn(
                  "min-h-[36px] rounded-full px-3 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  metric === o.id ? "bg-surface-overlay text-text-primary" : "text-text-muted hover:text-text-secondary"
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        }
      >
        <BarList
          items={rankedMain.map(toBarItem)}
          max={rankMax}
          formatValue={rankFormat}
          ariaLabel="Ranking dos hotéis"
          emptyText="Nenhuma unidade ativa com movimento no período."
        />
        {rankedOnboarding.length > 0 && (
          <div className="mt-4 border-t border-border-subtle pt-3">
            <button
              type="button"
              onClick={() => setShowOnboarding((v) => !v)}
              aria-expanded={showOnboarding}
              className="flex min-h-[44px] w-full items-center gap-2 rounded-lg text-left text-sm text-text-muted hover:text-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <ChevronDown
                size={16}
                className={cn("shrink-0 transition-transform", showOnboarding && "rotate-180")}
                aria-hidden="true"
              />
              <span>
                {rankedOnboarding.length}{" "}
                {rankedOnboarding.length === 1 ? "unidade em implantação" : "unidades em implantação"}
              </span>
            </button>
            {showOnboarding && (
              <div className="mt-2">
                <BarList
                  items={rankedOnboarding.map(toBarItem)}
                  max={rankMax}
                  formatValue={rankFormat}
                  ariaLabel="Unidades em implantação"
                  emptyText="Ainda sem movimento nas unidades em implantação."
                />
              </div>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Desempenho por hotel" subtitle="Toque no título da coluna para ordenar">
        <SortableTable
          caption="Desempenho por hotel"
          rows={rows}
          columns={columns}
          rowKey={(r) => r.unitId ?? "none"}
          initialSort={{ key: "revenue", dir: "desc" }}
          rowClassName={(r) => (r.onboarding ? "opacity-50" : undefined)}
          footer={
            <tr className="border-t border-border-strong text-text-primary font-semibold">
              <td className="sticky left-0 z-[1] bg-surface-raised px-3 py-2.5 pl-4 md:pl-3">Total</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatInt(t.leads)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatInt(t.converted)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatPct(t.leads > 0 ? t.converted / t.leads : null)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatBRL(t.revenue)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{t.converted > 0 ? formatBRL(t.avgTicket) : "—"}</td>
              {showSpend && (
                <>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatBRL(unitSpend)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatRoas(t.roas)}</td>
                </>
              )}
            </tr>
          }
        />
      </SectionCard>
    </div>
  );
}
