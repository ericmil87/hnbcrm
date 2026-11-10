import type { ReactNode } from "react";
import { Lock, Receipt } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { isBillingPanelVisible } from "@/lib/billingPanel";
import type { ChannelAndGroupUsage, Entitlements, UsageHistory, UsageSummary } from "./billingTypes";
import { CreditsCard, InvoiceEstimateCard, PlanSummaryCard, UsageHistoryCard, UsageMetersCard } from "./BillingCards";
import { OverageCardView, type OverageCardViewProps } from "./OverageCard";

export interface BillingPanelViewProps {
  canView: boolean;
  /** `undefined` = carregando; `null` = não é membro (sem painel). */
  entitlements: Entitlements | null | undefined;
  summary: UsageSummary | undefined;
  channelUsage: ChannelAndGroupUsage | undefined;
  history: UsageHistory | undefined;
  now: number;
  /** Link da fatura pendente/vencida mais recente (container). */
  openInvoiceUrl?: string | null;
  /** Botão de assinar/trocar plano (container). */
  planAction: ReactNode;
  /** Cartão de faturas (container). */
  invoices: ReactNode;
  overage: OverageCardViewProps;
  /** Extrato paginado (container). */
  statement: ReactNode;
}

function LoadingCards() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Carregando uso e fatura">
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <Skeleton className="mb-3 h-5 w-40" />
          <Skeleton className="mb-2 h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </Card>
      ))}
    </div>
  );
}

export function BillingPanelView(p: BillingPanelViewProps) {
  if (!p.canView) {
    return (
      <EmptyState
        icon={Lock}
        title="Você não tem acesso a esta página"
        description="Peça a um administrador para ver o plano e o uso."
      />
    );
  }
  if (p.entitlements === undefined) return <LoadingCards />;
  if (p.entitlements === null || !isBillingPanelVisible(p.entitlements.mode)) {
    return (
      <EmptyState
        icon={Receipt}
        title="Sua conta ainda não tem um plano"
        description="Quando houver um plano contratado, o uso do mês e a fatura aparecem aqui."
      />
    );
  }
  return (
    <div className="space-y-4">
      <PlanSummaryCard entitlements={p.entitlements} now={p.now} action={p.planAction} openInvoiceUrl={p.openInvoiceUrl} />
      {p.summary === undefined ? (
        <LoadingCards />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <UsageMetersCard summary={p.summary} channelUsage={p.channelUsage} now={p.now} />
            <InvoiceEstimateCard summary={p.summary} planLabel={p.entitlements.planLabel} mode={p.entitlements.mode} />
          </div>
          <OverageCardView {...p.overage} />
          {p.invoices}
          <CreditsCard summary={p.summary} now={p.now} />
          <UsageHistoryCard history={p.history} />
          {p.statement}
        </>
      )}
    </div>
  );
}
