import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SectionCard } from "@/components/ui/SectionCard";
import { Spinner } from "@/components/ui/Spinner";
import { attendanceBillingLabel, type AttendanceBilling } from "@/lib/billingPanel";
import { formatDateTime, formatMonthValue, formatMoney } from "@/lib/format";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export interface StatementRow {
  id: string;
  contactLabel: string;
  billing: AttendanceBilling;
  firstAt: number;
  unitPriceBrlCents: number | null;
}

interface AttendancesStatementViewProps {
  month: string;
  rows: StatementRow[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  onLoadMore: () => void;
}

const BILLING_VARIANT: Record<AttendanceBilling, "default" | "success" | "info" | "warning"> = {
  included: "success",
  credit: "info",
  overage: "warning",
  suggest_only: "default",
  legacy: "default",
};

export function AttendancesStatementView({ month, rows, status, onLoadMore }: AttendancesStatementViewProps) {
  if (status === "LoadingFirstPage") {
    return (
      <div className="flex justify-center py-6" aria-busy="true">
        <Spinner size="md" />
      </div>
    );
  }
  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary">Nenhum atendimento IA em {formatMonthValue(month) ?? month}.</p>;
  }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto"><table className="min-w-[28rem] w-full text-left text-sm">
        <caption className="sr-only">Atendimentos IA do mês</caption>
        <thead>
          <tr className="text-caption text-text-muted">
            <th scope="col" className="py-1 pr-2 font-medium">Contato</th>
            <th scope="col" className="py-1 pr-2 font-medium">Primeiro contato</th>
            <th scope="col" className="py-1 pr-2 font-medium">Cobrança</th>
            <th scope="col" className="py-1 text-right font-medium">Valor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border text-text-primary">
              <th scope="row" className="py-2 pr-2 font-normal">{r.contactLabel}</th>
              <td className="py-2 pr-2 tabular-nums">{formatDateTime(r.firstAt)}</td>
              <td className="py-2 pr-2">
                <Badge variant={BILLING_VARIANT[r.billing]}>{attendanceBillingLabel(r.billing)}</Badge>
              </td>
              <td className="py-2 text-right tabular-nums">
                {r.unitPriceBrlCents === null ? "—" : formatMoney(r.unitPriceBrlCents / 100)}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {status !== "Exhausted" && (
        <Button variant="secondary" loading={status === "LoadingMore"} onClick={onLoadMore}>
          Carregar mais
        </Button>
      )}
    </div>
  );
}

function StatementList({ organizationId, month }: { organizationId: Id<"organizations">; month: string }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.billing.listAttendances,
    { organizationId, month },
    { initialNumItems: 20 },
  );
  return <AttendancesStatementView month={month} rows={results} status={status} onLoadMore={() => loadMore(20)} />;
}

/** Só assina a lista depois do toque: o extrato pode ser longo. */
export function AttendancesStatement({ organizationId, month }: { organizationId: Id<"organizations">; month: string }) {
  const [open, setOpen] = useState(false);
  return (
    <SectionCard title="Extrato do mês" description="Cada contato que a IA atendeu e como foi cobrado" icon={<ListChecks size={18} />}>
      {open ? (
        <StatementList organizationId={organizationId} month={month} />
      ) : (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Ver extrato
        </Button>
      )}
    </SectionCard>
  );
}
