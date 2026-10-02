import { Megaphone, Wallet, TrendingUp, UserPlus, Info } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { KpiCard, SectionCard, type CentralDashboard } from "./CentralKpi";
import { BarList, SpendRevenueBars } from "./charts";
import { SortableTable, type Column } from "./SortableTable";
import { campaignLabel, formatBRL, formatInt, formatPct, formatRoas } from "./centralFormat";

type SourceRow = CentralDashboard["bySource"][number] & { id: string; label: string };

export function MarketingTab({ data, showSpend }: { data: CentralDashboard; showSpend: boolean }) {
  const t = data.totals;
  const rows: SourceRow[] = data.bySource.map((r) => ({
    ...r,
    id: `${r.source}:${r.campaignKey ?? ""}`,
    label: campaignLabel(r.source, r.campaignName),
  }));

  // Melhor e pior ROAS só entre campanhas com investimento (e só se houver 2+).
  const withRoas = rows.filter((r) => r.spend > 0 && r.roas !== null);
  let bestId: string | null = null;
  let worstId: string | null = null;
  if (withRoas.length >= 2) {
    const sorted = [...withRoas].sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0));
    bestId = sorted[0].id;
    worstId = sorted[sorted.length - 1].id;
  }
  const best = rows.find((r) => r.id === bestId);
  const worst = rows.find((r) => r.id === worstId);

  const conv = (r: SourceRow) => (r.leads > 0 ? r.converted / r.leads : null);

  const columns: Column<SourceRow>[] = [
    {
      key: "label",
      header: "Origem / campanha",
      sortValue: (r) => r.label,
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="max-w-[260px] truncate font-medium text-text-primary" title={r.label}>
            {r.label}
          </span>
          {r.id === bestId && <Badge variant="success">Melhor ROAS</Badge>}
          {r.id === worstId && <Badge variant="error">Pior ROAS</Badge>}
        </span>
      ),
    },
    ...(showSpend
      ? ([{ key: "spend", header: "Gasto", align: "right", sortValue: (r) => r.spend, render: (r) => formatBRL(r.spend) }] as Column<SourceRow>[])
      : []),
    { key: "leads", header: "Leads", align: "right", sortValue: (r) => r.leads, render: (r) => formatInt(r.leads) },
    { key: "converted", header: "Reservas", align: "right", sortValue: (r) => r.converted, render: (r) => formatInt(r.converted) },
    { key: "conversion", header: "Conversão", align: "right", sortValue: conv, render: (r) => formatPct(conv(r)) },
    {
      key: "revenue",
      header: "Receita",
      align: "right",
      sortValue: (r) => r.revenue,
      render: (r) => <span className="font-semibold text-text-primary">{formatBRL(r.revenue)}</span>,
    },
    ...(showSpend
      ? ([
          { key: "cac", header: "CAC", align: "right", sortValue: (r) => r.cac, render: (r) => formatBRL(r.cac) },
          {
            key: "roas",
            header: "ROAS",
            align: "right",
            sortValue: (r) => r.roas,
            render: (r) => <span className="font-semibold text-text-primary">{formatRoas(r.roas)}</span>,
          },
        ] as Column<SourceRow>[])
      : []),
  ];

  const spendItems = rows
    .filter((r) => r.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 8)
    .map((r) => ({
      key: r.id,
      label: r.label,
      spend: r.spend,
      revenue: r.revenue,
      hint: r.roas !== null ? `ROAS ${formatRoas(r.roas)}` : undefined,
    }));

  return (
    <div className="space-y-4 md:space-y-6">
      {showSpend ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard icon={Wallet} label="Investimento" value={formatBRL(t.spend)} hint="em mídia no período" />
          <KpiCard icon={TrendingUp} label="Receita" value={formatBRL(t.revenue)} hint="das reservas fechadas" emphasis />
          <KpiCard
            icon={Megaphone}
            label="ROAS (mídia paga)"
            value={formatRoas(t.roas)}
            hint={`${formatBRL(t.paidRevenue)} de receita de campanhas pagas ÷ investimento`}
            emphasis
          />
          <KpiCard
            icon={UserPlus}
            label="CAC (mídia paga)"
            value={formatBRL(t.cac)}
            hint={`investimento ÷ ${formatInt(t.paidConverted)} ${t.paidConverted === 1 ? "reserva" : "reservas"} de mídia paga`}
          />
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-card border border-border bg-surface-raised p-4 text-sm text-text-secondary">
          <Info size={18} className="mt-0.5 shrink-0 text-semantic-info" aria-hidden="true" />
          <p>
            Para ver gasto, CAC e ROAS, ligue o módulo <strong className="text-text-primary">Origem e investimento</strong>{" "}
            em Configurações → Central e registre o investimento em mídia.
          </p>
        </div>
      )}

      {best && worst && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-card border border-semantic-success/30 bg-semantic-success/5 p-4">
            <p className="text-xs font-medium text-semantic-success">Melhor retorno</p>
            <p className="mt-1 truncate font-semibold text-text-primary" title={best.label}>{best.label}</p>
            <p className="mt-0.5 text-sm text-text-secondary tabular-nums">
              {formatRoas(best.roas)} · {formatBRL(best.spend)} viraram {formatBRL(best.revenue)}
            </p>
          </div>
          <div className="rounded-card border border-semantic-error/30 bg-semantic-error/5 p-4">
            <p className="text-xs font-medium text-semantic-error">Pior retorno</p>
            <p className="mt-1 truncate font-semibold text-text-primary" title={worst.label}>{worst.label}</p>
            <p className="mt-0.5 text-sm text-text-secondary tabular-nums">
              {formatRoas(worst.roas)} · {formatBRL(worst.spend)} viraram {formatBRL(worst.revenue)}
            </p>
          </div>
        </div>
      )}

      <SectionCard title="Por origem e campanha" subtitle="De onde vieram os leads e quanto cada campanha trouxe">
        {rows.length === 0 ? (
          <p className="py-4 text-sm text-text-muted">Nenhum lead nem investimento no período.</p>
        ) : (
          <SortableTable
            caption="Desempenho por origem e campanha"
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            initialSort={{ key: showSpend ? "roas" : "revenue", dir: "desc" }}
          />
        )}
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
        {showSpend && (
          <SectionCard title="Gasto × receita" subtitle="Campanhas com investimento no período">
            <SpendRevenueBars items={spendItems} formatValue={formatBRL} />
          </SectionCard>
        )}
        <SectionCard
          title="Motivos de perda"
          subtitle={t.lost > 0 ? `${formatInt(t.lost)} leads não convertidos no período` : "Por que o lead não reservou"}
        >
          <BarList
            items={data.lostReasons.map((r) => ({
              key: r.reason,
              label: r.reason,
              value: r.count,
              hint: t.lost > 0 ? formatPct(r.count / t.lost) : undefined,
              barColor: "var(--text-muted)",
            }))}
            formatValue={formatInt}
            ariaLabel="Motivos de perda"
            emptyText="Nenhuma perda registrada no período."
          />
        </SectionCard>
      </div>
    </div>
  );
}
