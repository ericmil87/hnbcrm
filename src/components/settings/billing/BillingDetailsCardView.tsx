import { IdCard } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SectionCard } from "@/components/ui/SectionCard";
import { formatCpfCnpj, type CheckoutErrors } from "@/lib/checkoutForm";
import { maskDocument } from "@/lib/subscriptionManagement";

export interface BillingDetails {
  billingName: string | null;
  billingEmail: string | null;
  document: string | null;
}

export interface BillingDetailsForm {
  billingName: string;
  document: string;
  billingEmail: string;
}

export interface BillingDetailsCardViewProps {
  details: BillingDetails;
  canManage: boolean;
  editing: boolean;
  form: BillingDetailsForm;
  errors: CheckoutErrors;
  showErrors: boolean;
  saving: boolean;
  serverError: string | null;
  onEdit: () => void;
  onClose: () => void;
  onChange: (patch: Partial<BillingDetailsForm>) => void;
  onSave: () => void;
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="text-sm tabular-nums text-text-primary">{value ?? "Não informado"}</dd>
    </div>
  );
}

/** Dados de cobrança (nome, e-mail e documento mascarado) com edição em modal. */
export function BillingDetailsCardView(p: BillingDetailsCardViewProps) {
  const err = (k: keyof CheckoutErrors) => (p.showErrors ? p.errors[k] : undefined);
  return (
    <SectionCard
      title="Dados de cobrança"
      description="Usados na fatura e na nota fiscal"
      icon={<IdCard size={18} />}
      actions={
        p.canManage ? (
          <Button variant="secondary" size="sm" onClick={p.onEdit}>
            Editar
          </Button>
        ) : undefined
      }
    >
      <dl className="space-y-2">
        <Row label="Nome ou razão social" value={p.details.billingName} />
        <Row label="E-mail financeiro" value={p.details.billingEmail} />
        <Row label="CPF ou CNPJ" value={maskDocument(p.details.document)} />
      </dl>

      <Modal open={p.editing} onClose={p.onClose} title="Editar dados de cobrança">
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            p.onSave();
          }}
        >
          <Input
            id="details-name"
            label="Nome ou razão social"
            autoComplete="organization"
            value={p.form.billingName}
            error={err("billingName")}
            onChange={(e) => p.onChange({ billingName: e.target.value })}
          />
          <Input
            id="details-document"
            label="CPF ou CNPJ"
            inputMode="numeric"
            autoComplete="off"
            className="tabular-nums"
            value={p.form.document}
            error={err("document")}
            onChange={(e) => p.onChange({ document: formatCpfCnpj(e.target.value) })}
          />
          <Input
            id="details-email"
            label="E-mail financeiro"
            type="email"
            autoComplete="email"
            value={p.form.billingEmail}
            error={err("billingEmail")}
            onChange={(e) => p.onChange({ billingEmail: e.target.value })}
          />
          {p.serverError && (
            <p role="alert" className="text-sm text-semantic-error">
              {p.serverError}
            </p>
          )}
          <div className="flex gap-3">
            <Button type="button" variant="secondary" className="flex-1" onClick={p.onClose}>
              Cancelar
            </Button>
            <Button type="submit" className="flex-1" loading={p.saving}>
              Salvar
            </Button>
          </div>
        </form>
      </Modal>
    </SectionCard>
  );
}
