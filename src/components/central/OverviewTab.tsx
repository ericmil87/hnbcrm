import {
  MessagesSquare,
  Target,
  BedDouble,
  Percent,
  Wallet,
  Receipt,
  Timer,
  Bot,
  ArrowRightLeft,
  Inbox,
} from "lucide-react";
import { KpiCard, SectionCard, type CentralDashboard } from "./CentralKpi";
import { BarList, CHART_COLORS, TimeSeriesChart } from "./charts";
import {
  contactKindLabel,
  formatBRL,
  formatBRLCompact,
  formatDuration,
  formatInt,
  formatPct,
} from "./centralFormat";

export function OverviewTab({ data }: { data: CentralDashboard }) {
  const t = data.totals;
  const conversion = t.leads > 0 ? t.converted / t.leads : null;
  const nonLead = data.contactKinds.filter((k) => k.kind !== "lead").reduce((s, k) => s + k.count, 0);

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard icon={MessagesSquare} label="Conversas" value={formatInt(t.conversations)} hint="iniciadas no período" />
        <KpiCard icon={Target} label="Leads" value={formatInt(t.leads)} hint="contatos com intenção de reserva" />
        <KpiCard
          icon={BedDouble}
          label="Reservas"
          value={formatInt(t.converted)}
          hint={t.lost > 0 ? `${formatInt(t.lost)} não convertidos` : "fechadas no período"}
          emphasis
        />
        <KpiCard icon={Percent} label="Conversão" value={formatPct(conversion)} hint="reservas ÷ leads" emphasis />
        <KpiCard icon={Wallet} label="Receita" value={formatBRL(t.revenue)} hint="das reservas fechadas" emphasis />
        <KpiCard icon={Receipt} label="Ticket médio" value={t.converted > 0 ? formatBRL(t.avgTicket) : "—"} hint="por reserva" />
        <KpiCard icon={Timer} label="1ª resposta" value={formatDuration(t.avgFirstResponseSec)} hint="tempo médio" />
        <KpiCard icon={Bot} label="Resolvido pela IA" value={formatPct(t.aiResolvedRate)} hint="sem precisar de humano" />
        <KpiCard
          icon={ArrowRightLeft}
          label="Repasses"
          value={formatInt(t.handoffs)}
          hint={`${formatInt(t.transfers)} transferências de setor`}
        />
        <KpiCard icon={Inbox} label="Abertas agora" value={formatInt(t.openNow)} hint="conversas em andamento" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
        <SectionCard title="Leads × reservas por dia" subtitle="Quantos contatos novos viraram reserva, dia a dia">
          <TimeSeriesChart
            data={data.daily}
            series={[
              { key: "leads", label: "Leads", color: CHART_COLORS.context },
              { key: "converted", label: "Reservas", color: CHART_COLORS.primary },
            ]}
            formatValue={formatInt}
            ariaLabel={`Leads e reservas por dia: ${formatInt(t.leads)} leads e ${formatInt(t.converted)} reservas no período`}
          />
        </SectionCard>
        <SectionCard title="Receita por dia" subtitle="Valor das reservas fechadas em cada dia">
          <TimeSeriesChart
            data={data.daily}
            kind="column"
            series={[{ key: "revenue", label: "Receita", color: CHART_COLORS.primary }]}
            formatValue={formatBRL}
            formatAxis={formatBRLCompact}
            ariaLabel={`Receita por dia: total de ${formatBRL(t.revenue)} no período`}
          />
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
        <SectionCard title="Funil por estágio" subtitle="Leads do período, pelo estágio em que estão agora">
          <BarList
            items={data.funnel.map((s) => ({
              key: s.stageId,
              label: s.name,
              value: s.count,
              dotColor: s.color,
            }))}
            formatValue={formatInt}
            ariaLabel="Leads por estágio do funil"
            emptyText="Nenhum lead novo no período."
          />
        </SectionCard>
        <SectionCard
          title="Tipo de contato"
          subtitle={
            t.conversations > 0
              ? `${formatInt(nonLead)} de ${formatInt(t.conversations)} conversas (${formatPct(nonLead / t.conversations)}) não eram lead`
              : "Quem está chamando no WhatsApp"
          }
        >
          <BarList
            items={data.contactKinds.map((k) => ({
              key: k.kind,
              label: contactKindLabel(k.kind),
              value: k.count,
              hint: t.conversations > 0 ? formatPct(k.count / t.conversations) : undefined,
              barColor: k.kind === "lead" ? CHART_COLORS.primary : CHART_COLORS.context,
            }))}
            formatValue={formatInt}
            ariaLabel="Conversas por tipo de contato"
            emptyText="Nenhuma conversa no período."
          />
        </SectionCard>
      </div>
    </div>
  );
}
