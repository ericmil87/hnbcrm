import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import {
  CHECKOUT_PLANS,
  formatCpfCnpj,
  type CheckoutCycle,
  type CheckoutErrors,
  type CheckoutForm,
  type CheckoutPlan,
  type CheckoutSummary,
} from "@/lib/checkoutForm";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { GROUPS_ADDON_BRL, PLANS } from "../../../../convex/lib/plans";

export const SALES_EMAIL = "contato@hnbcrm.com";
export const PAYMENT_NOTE =
  "Pagamento por Pix, boleto ou cartão na página segura do Asaas. A nota fiscal sai em nome da INOVAWAY LTDA após a confirmação.";

const brl = (v: number) => formatMoney(v, "BRL", { fractionDigits: v % 1 === 0 ? 0 : 2 });

const CYCLE_OPTIONS = [
  { value: "monthly", label: "Mensal" },
  { value: "yearly", label: "Anual (2 meses grátis)" },
];

export interface CheckoutModalViewProps {
  open: boolean;
  onClose: () => void;
  form: CheckoutForm;
  onChange: (patch: Partial<CheckoutForm>) => void;
  errors: CheckoutErrors;
  /** Mostra os erros dos campos (depois da primeira tentativa de enviar). */
  showErrors: boolean;
  summary: CheckoutSummary | null;
  submitting: boolean;
  serverError: string | null;
  /** Depois de criada: link da 1ª fatura (a aba pode ter sido bloqueada). */
  invoiceUrl: string | null;
  created: boolean;
  onSubmit: () => void;
}

export function CheckoutModalView(p: CheckoutModalViewProps) {
  const err = (k: keyof CheckoutErrors) => (p.showErrors ? p.errors[k] : undefined);
  return (
    <Modal open={p.open} onClose={p.onClose} title={p.created ? "Fatura criada" : "Assinar plano"}>
      {p.created ? (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            A primeira fatura foi criada. Pague pela página do Asaas; o plano é liberado assim que o pagamento for confirmado.
          </p>
          {p.invoiceUrl ? (
            <a
              href={p.invoiceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-brand-600 px-5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Abrir fatura
              <ExternalLink size={16} aria-hidden="true" />
            </a>
          ) : (
            <p className="text-sm text-text-secondary">O link da fatura vai aparecer em "Faturas" daqui a pouco.</p>
          )}
          <p className="text-caption text-text-muted">{PAYMENT_NOTE}</p>
          <Button variant="secondary" onClick={p.onClose}>
            Fechar
          </Button>
        </div>
      ) : (
        <form
          className="space-y-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            p.onSubmit();
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-text-secondary">Plano</legend>
            {CHECKOUT_PLANS.map((k) => {
              const selected = p.form.plan === k;
              return (
                <label
                  key={k}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-card border p-3",
                    selected ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface-raised hover:bg-surface-overlay",
                  )}
                >
                  <span className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="checkout-plan"
                      value={k}
                      checked={selected}
                      onChange={() => p.onChange({ plan: k as CheckoutPlan })}
                      className="h-4 w-4 accent-brand-600"
                    />
                    <span className="text-sm font-medium text-text-primary">{PLANS[k].label}</span>
                  </span>
                  <span className="text-sm tabular-nums text-text-secondary">{brl(PLANS[k].monthlyBrl)}/mês</span>
                </label>
              );
            })}
            <p className="text-caption text-text-muted">
              Plano Empresa é por contrato:{" "}
              <a href={`mailto:${SALES_EMAIL}`} className="text-brand-400 underline underline-offset-2">
                fale com a gente
              </a>{" "}
              ({SALES_EMAIL}).
            </p>
          </fieldset>

          <div>
            <p className="mb-1 text-sm font-medium text-text-secondary">Ciclo</p>
            <SegmentedControl
              ariaLabel="Ciclo de cobrança"
              value={p.form.cycle}
              onValueChange={(v) => p.onChange({ cycle: v === "yearly" ? "yearly" : ("monthly" as CheckoutCycle) })}
              options={CYCLE_OPTIONS}
            />
          </div>

          {p.form.plan === "essencial" && (
            <Switch
              label={`Add-on Grupos (+ ${brl(GROUPS_ADDON_BRL)}/mês)`}
              description={`Até ${PLANS.essencial.groupsAddonMax} grupos com IA e publicações agendadas.`}
              checked={p.form.groupsAddon}
              onCheckedChange={(groupsAddon) => p.onChange({ groupsAddon })}
            />
          )}

          <div className="space-y-3">
            <Input
              id="checkout-name"
              label="Nome ou razão social"
              autoComplete="organization"
              value={p.form.billingName}
              error={err("billingName")}
              onChange={(e) => p.onChange({ billingName: e.target.value })}
            />
            <Input
              id="checkout-document"
              label="CPF ou CNPJ"
              inputMode="numeric"
              autoComplete="off"
              className="tabular-nums"
              value={p.form.document}
              error={err("document")}
              onChange={(e) => p.onChange({ document: formatCpfCnpj(e.target.value) })}
            />
            <Input
              id="checkout-email"
              label="E-mail financeiro"
              type="email"
              autoComplete="email"
              value={p.form.billingEmail}
              error={err("billingEmail")}
              onChange={(e) => p.onChange({ billingEmail: e.target.value })}
            />
          </div>

          {p.summary && (
            <div className="rounded-card border border-border bg-surface-sunken p-3 text-sm" aria-live="polite">
              <p className="flex items-center justify-between gap-3 text-text-primary tabular-nums">
                <span>{p.form.cycle === "yearly" ? "Cobrança anual" : "Cobrança mensal"}</span>
                <strong>{brl(p.summary.chargeBrl)}</strong>
              </p>
              {p.summary.yearly && (
                <p className="text-caption text-text-muted tabular-nums">
                  Você paga {p.summary.yearly.paidMonths} meses e usa 12 ({p.summary.yearly.freeMonths} grátis). Equivale a{" "}
                  {brl(p.summary.monthlyBrl)}/mês.
                </p>
              )}
              {p.summary.lockApplied && (
                <p className="text-caption text-text-muted tabular-nums">
                  Preço combinado aplicado (tabela: {brl(p.summary.listMonthlyBrl)}/mês).
                </p>
              )}
              <p className="mt-1 text-caption text-text-muted">Estimativa: o valor final é confirmado ao criar a fatura.</p>
            </div>
          )}

          {p.serverError && (
            <p role="alert" className="text-sm text-semantic-error">
              {p.serverError}
            </p>
          )}

          <p className="text-caption text-text-muted">{PAYMENT_NOTE}</p>
          <div className="flex gap-3">
            <Button type="button" variant="secondary" className="flex-1" onClick={p.onClose}>
              Cancelar
            </Button>
            <Button type="submit" className="flex-1" loading={p.submitting}>
              Ir para o pagamento
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
