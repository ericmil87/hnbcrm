import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { formatDate } from "@/lib/format";
import type { SubscriptionCycle } from "@/lib/subscriptionManagement";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { Button, buttonClassName } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import {
  EMPTY_CHECKOUT_FORM,
  applyPrefill,
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
import type { PlanKey } from "../../../../convex/lib/plans";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { CheckoutModalView } from "./CheckoutModalView";

interface PlanCheckoutProps {
  organizationId: Id<"organizations">;
  mode: string;
  hasSubscription: boolean;
  planLabel: string | null;
  /** Plano e ciclo atuais (modo troca). */
  planId: PlanKey | null;
  currentCycle: SubscriptionCycle | null;
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
export function PlanCheckout({ organizationId, mode, hasSubscription, planLabel, planId, currentCycle, priceLock, canManage, now }: PlanCheckoutProps) {
  const startCheckout = useAction(api.billing.startCheckout);
  const changePlan = useAction(api.billing.changePlan);
  // Com assinatura ativa (ou em atraso) a troca é pelo painel; o Empresa é por contrato.
  const changeMode = hasSubscription && (mode === "active" || mode === "past_due") && planId !== null && planId !== "empresa";
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CheckoutForm>(EMPTY_CHECKOUT_FORM);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [invoiceUrl, setInvoiceUrl] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [priceNote, setPriceNote] = useState<string | null>(null);

  // Dados de cobrança de um checkout anterior (só com o modal aberto e quem pode assinar).
  const prefill = useQuery(api.billing.getCheckoutPrefill, open && canManage && !changeMode ? { organizationId } : "skip");
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!open) {
      prefilledRef.current = false;
      return;
    }
    // Uma vez por abertura, e só nos campos ainda vazios (o usuário pode já ter começado a digitar).
    if (prefill !== undefined && !prefilledRef.current) {
      prefilledRef.current = true;
      setForm((f) => applyPrefill(f, prefill));
    }
  }, [open, prefill]);

  const errors = useMemo(() => validateCheckoutForm(form), [form]);
  // Valor do servidor (previewCheckout): só depende de plano/ciclo/add-on, não do que se digita.
  // O cálculo local fica como estimativa de exibição enquanto carrega.
  const previewArgs = useMemo(
    () => ({
      plan: form.plan,
      cycle: form.cycle,
      groupsAddon: form.plan === "essencial" && form.groupsAddon,
      ...(changeMode ? { mode: "change" as const } : {}),
    }),
    [form.plan, form.cycle, form.groupsAddon, changeMode],
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
  // Troca de plano: upgrade/downgrade e data decididos pelo servidor (mesma regra do `changePlan`).
  const serverKind = preview && "changeKind" in preview ? (preview.changeKind ?? null) : null;
  const serverEffectiveAt = preview && "effectiveAt" in preview ? (preview.effectiveAt ?? null) : null;
  const summary = useMemo(
    () => checkoutSummary({ plan: form.plan, cycle: form.cycle, groupsAddon: form.groupsAddon, priceLock, now }),
    [form.plan, form.cycle, form.groupsAddon, priceLock, now],
  );

  if (!canStartCheckout(mode) && !changeMode) {
    // Sem assinatura self-service (venda manual) ou Empresa: trocar de plano é com a gente.
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
    if (changeMode) {
      setSubmitting(true);
      try {
        const out = await changePlan({
          organizationId,
          plan: form.plan,
          cycle: form.cycle,
          groupsAddon: form.plan === "essencial" && form.groupsAddon ? true : undefined,
        });
        if (out.kind === "downgrade") {
          toast.success(out.effectiveAt != null ? `Troca agendada para ${formatDate(out.effectiveAt)}` : "Troca agendada");
          close();
        } else {
          setInvoiceUrl(out.invoiceUrl);
          setCreated(true);
          if (out.invoiceUrl) window.open(out.invoiceUrl, "_blank", "noopener,noreferrer");
        }
      } catch (e) {
        setServerError(mutationErrorMessage(e, "Não foi possível trocar de plano. Tente de novo."));
      } finally {
        setSubmitting(false);
      }
      return;
    }
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
        <Button
          variant={changeMode ? "secondary" : "primary"}
          className="w-full sm:w-auto"
          disabled={!canManage}
          onClick={() => {
            // Troca: começa no plano atual (o servidor diz o que é upgrade/downgrade ao escolher outro).
            if (changeMode) {
              setForm((f) => ({
                ...f,
                plan: planId === "essencial" || planId === "profissional" || planId === "escala" ? planId : f.plan,
                cycle: currentCycle === "yearly" ? "yearly" : "monthly",
              }));
            }
            setOpen(true);
          }}
        >
          {changeMode ? "Trocar plano" : checkoutButtonLabel(hasSubscription)}
        </Button>
        {!canManage && <p className="text-caption text-text-muted">Peça a um administrador para assinar.</p>}
      </div>
      <CheckoutModalView
        open={open}
        change={
          changeMode && planId
            ? {
                currentPlan: planId,
                currentCycle: currentCycle ?? "monthly",
                effectiveAt: fromServer ? serverEffectiveAt : null,
                selectedKind: fromServer ? serverKind : null,
              }
            : undefined
        }
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
