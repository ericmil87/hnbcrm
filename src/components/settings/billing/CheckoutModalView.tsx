import { safeHttpsUrl } from "@/lib/checkoutForm";
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
  type SummaryLine,
} from "@/lib/checkoutForm";
import { formatMoney } from "@/lib/format";
import { LEGAL_ENTITY } from "@/lib/legalEntity";
import { cn } from "@/lib/utils";
import { GROUPS_ADDON_BRL, PLANS, type PlanKey } from "../../../../convex/lib/plans";
import {
  changeKindLabel,
  changeNotice,
  planChangeKind,
  type ChangeKind,
  type SubscriptionCycle,
} from "@/lib/subscriptionManagement";

export const SALES_EMAIL = LEGAL_ENTITY.email;
export const PAYMENT_NOTE = `Pagamento por Pix, boleto ou cartão na página segura do Asaas. A nota fiscal sai em nome da ${LEGAL_ENTITY.name} após a confirmação.`;

const brl = (v: number) => formatMoney(v, "BRL", { fractionDigits: v % 1 === 0 ? 0 : 2 });

const CYCLE_OPTIONS = [
  { value: "monthly", label: "Mensal" },
  { value: "yearly", label: "Anual (2 meses grátis)" },
];

/** Modo troca de plano (assinatura ativa): sem dados de cobrança, com upgrade/downgrade por plano. */
export interface ChangePlanContext {
  currentPlan: PlanKey;
  currentCycle: SubscriptionCycle;
  /** Início do downgrade (próxima renovação), se o servidor informar. */
  effectiveAt: number | null;
  /** Upgrade/downgrade decidido pelo servidor (`previewCheckout` modo troca); vence a regra local. */
  selectedKind?: ChangeKind | null;
}

export interface CheckoutModalViewProps {
  change?: ChangePlanContext;
  open: boolean;
  onClose: () => void;
  form: CheckoutForm;
  onChange: (patch: Partial<CheckoutForm>) => void;
  errors: CheckoutErrors;
  /** Mostra os erros dos campos (depois da primeira tentativa de enviar). */
  showErrors: boolean;
  summary: CheckoutSummary | null;
  /** O valor veio do servidor (`previewCheckout`); `false` = estimativa local de exibição. */
  /** Linhas mensais do resumo (servidor). */
  summaryLines: SummaryLine[];
  /** Recusa da prévia (ex.: plano ativo): mostrada como aviso e trava o envio. */
  refusal: string | null;
  summaryFromServer: boolean;
  /** Consultando o servidor (o formulário mudou): mostra "Calculando…". */
  summaryLoading: boolean;
  submitting: boolean;
  serverError: string | null;
  /** Aviso (não é erro): ex.: pagamento recebido e em processamento. */
  notice: string | null;
  /** Fatura criada: nota sobre o preço (ex.: preço especial da conta). */
  priceNote: string | null;
  /** Depois de criada: link da 1ª fatura (a aba pode ter sido bloqueada). */
  invoiceUrl: string | null;
  created: boolean;
  onSubmit: () => void;
}

export function CheckoutModalView(p: CheckoutModalViewProps) {
  const err = (k: keyof CheckoutErrors) => (p.showErrors ? p.errors[k] : undefined);
  const change = p.change;
  const kindFor = (plan: PlanKey): ChangeKind | null =>
    change ? planChangeKind({ plan: change.currentPlan, cycle: change.currentCycle }, { plan, cycle: p.form.cycle }) : null;
  const selectedKind = change ? (change.selectedKind ?? kindFor(p.form.plan)) : null;
  const notice = change && selectedKind ? changeNotice(selectedKind, { chargeBrl: p.summary?.chargeBrl ?? null, effectiveAt: change.effectiveAt }) : null;
  const title = p.created ? "Fatura criada" : change ? "Trocar plano" : "Assinar plano";
  return (
    <Modal open={p.open} onClose={p.onClose} title={title}>
      {p.created ? (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {change
              ? "A fatura da troca foi criada. Pague pela página do Asaas; o plano muda assim que o pagamento for confirmado."
              : "A primeira fatura foi criada. Pague pela página do Asaas; o plano é liberado assim que o pagamento for confirmado."}
          </p>
          {safeHttpsUrl(p.invoiceUrl) ? (
            <a
              href={safeHttpsUrl(p.invoiceUrl) ?? undefined}
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
          {p.priceNote && <p className="text-sm text-text-secondary">{p.priceNote}</p>}
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
              const kind = kindFor(k);
              const isCurrent = kind === "same";
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
                      disabled={isCurrent}
                      onChange={() => p.onChange({ plan: k as CheckoutPlan })}
                      className="h-4 w-4 accent-brand-600"
                    />
                    <span className="text-sm font-medium text-text-primary">{PLANS[k].label}</span>
                    {kind && <span className="text-caption text-text-muted">{changeKindLabel(kind)}</span>}
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

          {notice && (
            <p role="status" className="rounded-card border border-border bg-surface-sunken p-3 text-sm text-text-primary">
              {notice}
            </p>
          )}

          {!change && (
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
          )}

          {p.summary && (
            <div className="rounded-card border border-border bg-surface-sunken p-3 text-sm" aria-live="polite">
              <p className="flex items-center justify-between gap-3 text-text-primary tabular-nums">
                <span>{p.form.cycle === "yearly" ? "Cobrança anual" : "Cobrança mensal"}</span>
                <strong>{brl(p.summary.chargeBrl)}</strong>
              </p>
              {p.summaryLines.length > 0 && (
                <ul className="mb-1 mt-1 space-y-0.5 text-caption text-text-muted tabular-nums">
                  {p.summaryLines.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-3">
                      <span>{l.label}</span>
                      <span>{brl(l.amountBrl)}/mês</span>
                    </li>
                  ))}
                </ul>
              )}
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
              <p className="mt-1 text-caption text-text-muted" aria-busy={p.summaryLoading}>
                {p.summaryLoading
                  ? "Calculando…"
                  : p.summaryFromServer
                    ? "Valor calculado pelo servidor."
                    : "Estimativa: o valor final é confirmado ao criar a fatura."}
              </p>
            </div>
          )}

          {p.refusal && (
            <p role="status" className="rounded-card border border-semantic-warning/40 bg-semantic-warning/5 p-3 text-sm text-text-primary">
              {p.refusal}
            </p>
          )}
          {p.notice && (
            <p role="status" className="rounded-card border border-semantic-warning/40 bg-semantic-warning/5 p-3 text-sm text-text-primary">
              {p.notice}
            </p>
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
            <Button type="submit" className="flex-1" loading={p.submitting} disabled={p.refusal !== null || p.summaryLoading || selectedKind === "same"}>
              {change ? (selectedKind === "upgrade" ? "Confirmar e ir para o pagamento" : "Confirmar troca") : "Ir para o pagamento"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
