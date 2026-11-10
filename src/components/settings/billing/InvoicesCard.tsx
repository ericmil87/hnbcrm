import { safeHttpsUrl } from "@/lib/checkoutForm";
import { useQuery } from "convex/react";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { SectionCard } from "@/components/ui/SectionCard";
import { invoiceStatusLabel, invoiceStatusTone, type InvoiceStatus } from "@/lib/checkoutForm";
import { formatDate, formatMoney } from "@/lib/format";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

export interface InvoiceRow {
  id: string;
  description: string;
  amountCents: number;
  dueDate: number;
  status: InvoiceStatus;
  invoiceUrl: string | null;
  nfseNumber: string | null;
  nfseUrl: string | null;
}

const linkClass =
  "inline-flex min-h-9 items-center text-sm font-medium text-brand-400 hover:text-brand-300 coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";

export function InvoicesCardView({ invoices }: { invoices: InvoiceRow[] | undefined }) {
  return (
    <SectionCard title="Faturas" description="As últimas cobranças da assinatura" icon={<FileText size={18} />}>
      {invoices === undefined ? (
        <p className="text-sm text-text-muted" aria-busy="true">
          Carregando…
        </p>
      ) : invoices.length === 0 ? (
        <p className="text-sm text-text-secondary">Nenhuma fatura ainda.</p>
      ) : (
        <ul className="divide-y divide-border">
          {invoices.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-text-primary">{inv.description}</p>
                <p className="text-caption tabular-nums text-text-muted">Vencimento {formatDate(inv.dueDate)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium tabular-nums text-text-primary">{formatMoney(inv.amountCents / 100)}</span>
                <Badge variant={invoiceStatusTone(inv.status)}>{invoiceStatusLabel(inv.status)}</Badge>
                {safeHttpsUrl(inv.invoiceUrl) && (
                  <a href={safeHttpsUrl(inv.invoiceUrl) ?? undefined} target="_blank" rel="noopener noreferrer" className={linkClass}>
                    Ver fatura
                  </a>
                )}
                {safeHttpsUrl(inv.nfseUrl) && (
                  <a href={safeHttpsUrl(inv.nfseUrl) ?? undefined} target="_blank" rel="noopener noreferrer" className={linkClass}>
                    Nota fiscal{inv.nfseNumber ? ` ${inv.nfseNumber}` : ""}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/** Só o painel assina: faturas da org (settings:view). */
export function InvoicesCard({ organizationId }: { organizationId: Id<"organizations"> }) {
  const invoices = useQuery(api.billing.listInvoices, { organizationId });
  return <InvoicesCardView invoices={invoices} />;
}
