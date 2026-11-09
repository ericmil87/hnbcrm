import { AlertTriangle, CalendarClock, Gauge, Receipt, Ticket, WalletCards } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SectionCard } from "@/components/ui/SectionCard";
import {
  attendanceProjection,
  buildMeters,
  creditExpiresSoon,
  creditSourceLabel,
  invoiceLines,
  priceLockText,
  statusInfo,
  trialDaysLeft,
  trialText,
  type StatusTone,
} from "@/lib/billingPanel";
import { formatCount, formatDate, formatMonthValue, formatMoney } from "@/lib/format";
import { CYCLE_CLOSE_TEXT, daysLeftInMonthUtc } from "@/lib/usageProjection";
import { cn } from "@/lib/utils";
import type { ChannelAndGroupUsage, Entitlements, UsageHistory, UsageSummary } from "./billingTypes";
import { UsageMeter } from "./UsageMeter";

const TONE_BADGE: Record<StatusTone, "default" | "success" | "info" | "warning" | "error"> = {
  default: "default",
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
};

interface PlanSummaryCardProps {
  entitlements: Entitlements;
  now: number;
  changePlanHref: string;
}

export function PlanSummaryCard({ entitlements, now, changePlanHref }: PlanSummaryCardProps) {
  const info = statusInfo(entitlements.mode);
  const days = entitlements.mode === "trial" ? trialDaysLeft(entitlements.trialEndsAt, now) : null;
  const lock = priceLockText(entitlements.pricing?.priceLock, now);
  const list = entitlements.pricing?.listMonthlyBrl ?? null;
  return (
    <SectionCard title="Plano atual" icon={<WalletCards size={18} />}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xl font-bold text-text-primary">{entitlements.planLabel ?? "Sem plano"}</p>
          <Badge variant={TONE_BADGE[info.tone]}>{info.label}</Badge>
        </div>
        {list !== null && (
          <p className="text-sm tabular-nums text-text-secondary">Tabela: {formatMoney(list)} por mês</p>
        )}
        {lock && <p className="text-sm text-text-secondary tabular-nums">{lock}</p>}
        {days !== null && (
          <p className="flex items-center gap-2 text-sm text-text-primary tabular-nums">
            <CalendarClock size={16} className="text-semantic-info" aria-hidden="true" />
            {trialText(days)}
            {entitlements.trialEndsAt !== undefined && (
              <span className="text-text-muted">Termina em {formatDate(entitlements.trialEndsAt)}.</span>
            )}
          </p>
        )}
        {info.notice && (
          <div
            role="status"
            className={cn(
              "flex gap-2 rounded-card border p-3 text-sm",
              info.tone === "error"
                ? "border-semantic-error/40 bg-semantic-error/5"
                : "border-semantic-warning/40 bg-semantic-warning/5",
            )}
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <p className="text-text-primary">{info.notice}</p>
          </div>
        )}
        <a href={changePlanHref}>
          <Button variant="secondary" className="w-full sm:w-auto">
            Falar com a gente
          </Button>
        </a>
        <p className="text-caption text-text-muted">Para trocar de plano, é só falar com a gente.</p>
      </div>
    </SectionCard>
  );
}

interface UsageMetersCardProps {
  summary: UsageSummary;
  channelUsage: ChannelAndGroupUsage | undefined;
  now: number;
}

export function UsageMetersCard({ summary, channelUsage, now }: UsageMetersCardProps) {
  const meters = buildMeters(summary, channelUsage);
  const att = summary.attendances;
  const proj = attendanceProjection(att.total, att.limit, summary.month, now);
  return (
    <SectionCard
      title="Uso do mês"
      description={`${formatMonthValue(summary.month) ?? summary.month} · ${daysLeftInMonthUtc(now)} dias para fechar`}
      icon={<Gauge size={18} />}
    >
      <div className="space-y-6">
        {meters.map((m) => (
          <UsageMeter
            key={m.id}
            meter={m}
            approximate={
              (m.id === "channels" && channelUsage?.channels.truncated) ||
              (m.id === "aiGroups" && channelUsage?.aiGroups.truncated) ||
              false
            }
          >
            {m.id === "attendances" && (
              <ul className="space-y-0.5 text-caption tabular-nums text-text-muted">
                {att.credit > 0 && <li>{formatCount(att.credit)} cobertos por crédito</li>}
                {att.overage > 0 && (
                  <li>
                    {formatCount(att.overage)} de excedente ({formatMoney(att.overageBrlCents / 100)})
                  </li>
                )}
                {att.suggestOnly > 0 && (
                  <li>{formatCount(att.suggestOnly)} só sugeridos (a IA não respondeu sozinha)</li>
                )}
                {proj && (
                  <li className={cn(proj.exceeds && "text-semantic-warning")}>
                    Estimativa de fechamento: cerca de {formatCount(proj.projected)}
                    {proj.exceeds ? ", acima da franquia" : ""}
                  </li>
                )}
              </ul>
            )}
          </UsageMeter>
        ))}
        {!channelUsage && <p className="text-caption text-text-muted">Carregando canais e grupos…</p>}
        <p className="text-caption text-text-muted">
          O mês é contado em UTC. {CYCLE_CLOSE_TEXT}
        </p>
      </div>
    </SectionCard>
  );
}

interface InvoiceEstimateCardProps {
  summary: UsageSummary;
  planLabel: string | null;
  mode: Entitlements["mode"];
}

export function InvoiceEstimateCard({ summary, planLabel, mode }: InvoiceEstimateCardProps) {
  const est = summary.estimate;
  return (
    <SectionCard title="Estimativa da fatura" description="Mensalidade mais o excedente do mês até agora" icon={<Receipt size={18} />}>
      {est === null ? (
        <p className="text-sm text-text-secondary">
          {mode === "trial"
            ? "Durante o teste grátis não há fatura."
            : "Sem estimativa: a conta não tem um plano contratado."}
        </p>
      ) : (
        <div className="space-y-2">
          <ul className="space-y-1.5">
            {invoiceLines(est, planLabel).map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 text-sm text-text-primary">
                <span>{l.label}</span>
                <span className="tabular-nums">{formatMoney(l.amountBrl)}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-2 text-base font-semibold text-text-primary">
            <span>Total estimado</span>
            <span className="tabular-nums">{formatMoney(est.totalBrl)}</span>
          </div>
          <p className="text-caption text-text-muted">
            Estimativa: o valor final sai na fatura do fechamento. Impostos e terceiros (Meta, chave de IA própria) não entram.
          </p>
        </div>
      )}
    </SectionCard>
  );
}

export function CreditsCard({ summary, now }: { summary: UsageSummary; now: number }) {
  return (
    <SectionCard title="Créditos" description="Atendimentos pré-pagos ou de cortesia" icon={<Ticket size={18} />}>
      {summary.credits.length === 0 ? (
        <p className="text-sm text-text-secondary">Você não tem créditos ativos.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-text-primary tabular-nums">
            Saldo: <strong>{formatCount(summary.packBalance)}</strong> atendimentos
          </p>
          <ul className="divide-y divide-border">
            {summary.credits.map((c, i) => (
              <li key={`${c.source}:${c.expiresAt}:${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-text-primary">{creditSourceLabel(c.source)}</span>
                <span className="tabular-nums text-text-secondary">
                  {formatCount(c.remaining)} de {formatCount(c.granted)} · vence em {formatDate(c.expiresAt)}
                </span>
                {creditExpiresSoon(c.expiresAt, now) && <Badge variant="warning">Vence em breve</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

export function UsageHistoryCard({ history }: { history: UsageHistory | undefined }) {
  return (
    <SectionCard title="Histórico" description="Últimos 6 meses" icon={<CalendarClock size={18} />}>
      {history === undefined ? (
        <p className="text-sm text-text-muted">Carregando…</p>
      ) : history.length === 0 ? (
        <p className="text-sm text-text-secondary">O histórico aparece depois do primeiro mês completo.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Uso dos últimos meses</caption>
          <thead>
            <tr className="text-caption text-text-muted">
              <th scope="col" className="py-1 pr-2 font-medium">Mês</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Atendimentos</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Envios</th>
              <th scope="col" className="py-1 text-right font-medium">Excedente</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.month} className="border-t border-border tabular-nums text-text-primary">
                <th scope="row" className="py-2 pr-2 font-normal">{formatMonthValue(h.month) ?? h.month}</th>
                <td className="py-2 pr-2 text-right">{formatCount(h.attendances)}</td>
                <td className="py-2 pr-2 text-right">{formatCount(h.campaignSends)}</td>
                <td className="py-2 text-right">{formatMoney(h.overageBrlCents / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}
