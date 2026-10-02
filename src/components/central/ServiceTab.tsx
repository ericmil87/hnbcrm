import { Timer, Bot, ArrowRightLeft, Inbox, Shuffle } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { KpiCard, SectionCard, type CentralDashboard } from "./CentralKpi";
import { CHART_COLORS } from "./charts";
import { SortableTable, type Column } from "./SortableTable";
import { formatDuration, formatInt, formatPct } from "./centralFormat";

type DeptRow = CentralDashboard["byDepartment"][number];
type ResponderRow = CentralDashboard["byResponder"][number];

export function ServiceTab({ data, showDepartments }: { data: CentralDashboard; showDepartments: boolean }) {
  const t = data.totals;

  const deptColumns: Column<DeptRow>[] = [
    {
      key: "name",
      header: "Setor",
      sortValue: (r) => r.name,
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
          <span className="font-medium text-text-primary">{r.name}</span>
        </span>
      ),
    },
    { key: "conversations", header: "Conversas", align: "right", sortValue: (r) => r.conversations, render: (r) => formatInt(r.conversations) },
    {
      key: "open",
      header: "Abertas agora",
      align: "right",
      sortValue: (r) => r.open,
      render: (r) => <span className="font-semibold text-text-primary">{r.open >= 500 ? "500+" : formatInt(r.open)}</span>,
    },
    { key: "transfersIn", header: "Transferências recebidas", align: "right", sortValue: (r) => r.transfersIn, render: (r) => formatInt(r.transfersIn) },
    {
      key: "firstResponse",
      header: "1ª resposta",
      align: "right",
      sortValue: (r) => r.avgFirstResponseSec,
      render: (r) => formatDuration(r.avgFirstResponseSec),
    },
  ];

  const conv = (r: ResponderRow) => (r.conversations > 0 ? r.converted / r.conversations : null);
  const responderColumns: Column<ResponderRow>[] = [
    {
      key: "name",
      header: "Responsável",
      sortValue: (r) => r.name,
      render: (r) => (
        <span className="flex items-center gap-2">
          <Avatar name={r.name} type={r.type} size="sm" />
          <span className="font-medium text-text-primary">{r.name}</span>
          <Badge variant={r.type === "ai" ? "warning" : "info"}>{r.type === "ai" ? "IA" : "Humano"}</Badge>
        </span>
      ),
    },
    { key: "conversations", header: "Conversas", align: "right", sortValue: (r) => r.conversations, render: (r) => formatInt(r.conversations) },
    {
      key: "converted",
      header: "Reservas",
      align: "right",
      sortValue: (r) => r.converted,
      render: (r) => <span className="font-semibold text-text-primary">{formatInt(r.converted)}</span>,
    },
    { key: "conversion", header: "Conversão", align: "right", sortValue: conv, render: (r) => formatPct(conv(r)) },
  ];

  const aiConversations = data.byResponder.filter((r) => r.type === "ai").reduce((s, r) => s + r.conversations, 0);
  const humanConversations = data.byResponder.filter((r) => r.type === "human").reduce((s, r) => s + r.conversations, 0);
  const aiConverted = data.byResponder.filter((r) => r.type === "ai").reduce((s, r) => s + r.converted, 0);
  const humanConverted = data.byResponder.filter((r) => r.type === "human").reduce((s, r) => s + r.converted, 0);
  const totalResp = aiConversations + humanConversations;

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard icon={Timer} label="1ª resposta" value={formatDuration(t.avgFirstResponseSec)} hint="tempo médio" emphasis />
        <KpiCard icon={Bot} label="Resolvido pela IA" value={formatPct(t.aiResolvedRate)} hint="sem precisar de humano" emphasis />
        <KpiCard icon={ArrowRightLeft} label="Repasses" value={formatInt(t.handoffs)} hint="IA pediu ajuda humana" />
        <KpiCard icon={Shuffle} label="Transferências" value={formatInt(t.transfers)} hint="entre setores" />
        <KpiCard icon={Inbox} label="Abertas agora" value={formatInt(t.openNow)} hint="conversas em andamento" />
      </div>

      <SectionCard
        title="IA × humano"
        subtitle={
          totalResp > 0
            ? `A IA ficou com ${formatPct(aiConversations / totalResp)} das conversas do período`
            : "Quem ficou com cada conversa"
        }
      >
        {totalResp > 0 ? (
          <div className="space-y-3">
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
              <div style={{ width: `${(aiConversations / totalResp) * 100}%`, background: CHART_COLORS.primary }} />
              <div style={{ width: `${(humanConversations / totalResp) * 100}%`, background: CHART_COLORS.context }} />
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="flex items-center gap-1.5 text-text-secondary">
                  <span className="h-2 w-2 rounded-full" style={{ background: CHART_COLORS.primary }} /> IA
                </p>
                <p className="font-semibold text-text-primary tabular-nums">
                  {formatInt(aiConversations)} conversas · {formatInt(aiConverted)} reservas
                </p>
              </div>
              <div>
                <p className="flex items-center gap-1.5 text-text-secondary">
                  <span className="h-2 w-2 rounded-full" style={{ background: CHART_COLORS.context }} /> Humanos
                </p>
                <p className="font-semibold text-text-primary tabular-nums">
                  {formatInt(humanConversations)} conversas · {formatInt(humanConverted)} reservas
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="py-4 text-sm text-text-muted">Nenhuma conversa no período.</p>
        )}
      </SectionCard>

      {showDepartments && (
        <SectionCard title="Por setor" subtitle="Volume, fila atual e velocidade de cada setor">
          {data.byDepartment.length === 0 ? (
            <p className="py-4 text-sm text-text-muted">Nenhum setor cadastrado. Crie os setores em Configurações → Central.</p>
          ) : (
            <SortableTable
              caption="Atendimento por setor"
              rows={data.byDepartment}
              columns={deptColumns}
              rowKey={(r) => r.departmentId}
              initialSort={{ key: "conversations", dir: "desc" }}
            />
          )}
        </SectionCard>
      )}

      <SectionCard title="Por responsável" subtitle="Conversas e reservas de cada pessoa ou agente de IA">
        {data.byResponder.length === 0 ? (
          <p className="py-4 text-sm text-text-muted">Nenhuma conversa no período.</p>
        ) : (
          <SortableTable
            caption="Atendimento por responsável"
            rows={data.byResponder}
            columns={responderColumns}
            rowKey={(r) => r.memberId ?? `none-${r.type}`}
            initialSort={{ key: "conversations", dir: "desc" }}
          />
        )}
      </SectionCard>
    </div>
  );
}
