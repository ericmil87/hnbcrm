import { useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Button, buttonClassName } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import {
  EMPTY_CHECKOUT_FORM,
  canStartCheckout,
  isPaymentProcessingMessage,
  summaryFromPreview,
  priceSourceNote,
  checkoutButtonLabel,
  checkoutSummary,
  toCheckoutArgs,
  validateCheckoutForm,
  type CheckoutForm,
} from "@/lib/checkoutForm";
import { changePlanMailto } from "@/lib/billingPanel";
import type { PriceLock } from "../../../../convex/lib/billingMath";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { CheckoutModalView } from "./CheckoutModalView";

interface PlanCheckoutProps {
  organizationId: Id<"organizations">;
  mode: string;
  hasSubscription: boolean;
  planLabel: string | null;
  priceLock: PriceLock | null;
  canManage: boolean;
  /** Relógio arredondado do painel (só decide se o preço combinado venceu). */
  now: number;
}

/**
 * Botão "Assinar plano"/"Trocar plano" do painel e o checkout (Asaas) em modal.
 *
 * Org `legacy` NÃO tem self-checkout, de propósito: o painel nem aparece para ela (o Eric
 * migra cada uma para um plano à mão), então este componente só existe com plano gravado.
 */
export function PlanCheckout({ organizationId, mode, hasSubscription, planLabel, priceLock, canManage, now }: PlanCheckoutProps) {
  const startCheckout = useAction(api.billing.startCheckout);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CheckoutForm>(EMPTY_CHECKOUT_FORM);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [invoiceUrl, setInvoiceUrl] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [priceNote, setPriceNote] = useState<string | null>(null);

  const errors = useMemo(() => validateCheckoutForm(form), [form]);
  // Valor do servidor (previewCheckout): só depende de plano/ciclo/add-on, não do que se digita.
  // O cálculo local fica como estimativa de exibição enquanto carrega.
  const previewArgs = useMemo(
    () => ({ plan: form.plan, cycle: form.cycle, groupsAddon: form.plan === "essencial" && form.groupsAddon }),
    [form.plan, form.cycle, form.groupsAddon],
  );
  const settledArgs = useDebouncedValue(previewArgs, 250);
  const preview = useQuery(
    api.billing.previewCheckout,
    open && organizationId ? { organizationId, ...settledArgs, now } : "skip",
  );
  const previewLoading = open && (settledArgs !== previewArgs || preview === undefined);
  const fromServer = preview !== undefined && settledArgs === previewArgs;
  const server = useMemo(
    () => (preview !== undefined ? summaryFromPreview(preview) : { summary: null, lines: [], refusal: null }),
    [preview],
  );
  const summary = useMemo(
    () => checkoutSummary({ plan: form.plan, cycle: form.cycle, groupsAddon: form.groupsAddon, priceLock, now }),
    [form.plan, form.cycle, form.groupsAddon, priceLock, now],
  );

  if (!canStartCheckout(mode)) {
    // Ativo ou em atraso: trocar de plano é com a gente (o servidor recusa o checkout).
    // Link com estilo de botão (sem <Button> dentro de <a>).
    return (
      <a href={changePlanMailto(null, planLabel)} className={cn(buttonClassName("secondary", "md"), "w-full sm:w-auto")}>
        Trocar plano
      </a>
    );
  }

  const submit = async () => {
    setShowErrors(true);
    setServerError(null);
    setNotice(null);
    if (Object.keys(errors).length > 0) return;
    setSubmitting(true);
    try {
      const out = await startCheckout({ organizationId, ...toCheckoutArgs(form) });
      setInvoiceUrl(out.invoiceUrl);
      setPriceNote(priceSourceNote(out.priceSource));
      setCreated(true);
      // Depois do await o navegador pode bloquear a aba: o link "Abrir fatura" fica no modal.
      if (out.invoiceUrl) window.open(out.invoiceUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      const message = mutationErrorMessage(e, "Não foi possível criar a fatura. Tente de novo.");
      // Pagamento já recebido e em processamento: aviso, não erro.
      if (isPaymentProcessingMessage(message)) setNotice(message);
      else setServerError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    // Fatura criada: o form (documento e e-mail) não fica guardado para a próxima abertura.
    if (created) setForm(EMPTY_CHECKOUT_FORM);
    setOpen(false);
    setCreated(false);
    setInvoiceUrl(null);
    setServerError(null);
    setNotice(null);
    setPriceNote(null);
    setShowErrors(false);
  };

  return (
    <>
      <div className="space-y-1">
        <Button variant="primary" className="w-full sm:w-auto" disabled={!canManage} onClick={() => setOpen(true)}>
          {checkoutButtonLabel(hasSubscription)}
        </Button>
        {!canManage && <p className="text-caption text-text-muted">Peça a um administrador para assinar.</p>}
      </div>
      <CheckoutModalView
        open={open}
        onClose={close}
        form={form}
        onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        errors={errors}
        showErrors={showErrors}
        summary={fromServer ? server.summary : summary}
        summaryLines={server.lines}
        refusal={server.refusal}
        summaryFromServer={fromServer}
        summaryLoading={previewLoading}
        submitting={submitting}
        serverError={serverError}
        notice={notice}
        priceNote={priceNote}
        invoiceUrl={invoiceUrl}
        created={created}
        onSubmit={() => void submit()}
      />
    </>
  );
}
