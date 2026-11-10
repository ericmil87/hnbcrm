import { useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { formatCpfCnpj, validateCheckoutForm, EMPTY_CHECKOUT_FORM } from "@/lib/checkoutForm";
import { mutationErrorMessage } from "@/lib/errors";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { BillingDetailsCardView, type BillingDetailsForm } from "./BillingDetailsCardView";

/**
 * Dados de cobrança da org (`getCheckoutPrefill`, só `settings:manage`: quem não pode recebe `null`
 * e o cartão nem aparece). Edição pelo `updateBillingDetails`.
 */
export function BillingDetailsCard({ organizationId }: { organizationId: Id<"organizations"> }) {
  const details = useQuery(api.billing.getCheckoutPrefill, { organizationId });
  const updateBillingDetails = useAction(api.billing.updateBillingDetails);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<BillingDetailsForm>({ billingName: "", document: "", billingEmail: "" });
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = useMemo(() => validateCheckoutForm({ ...EMPTY_CHECKOUT_FORM, ...form }), [form]);

  if (!details) return null;

  const open = () => {
    setForm({
      billingName: details.billingName ?? "",
      document: details.document ? formatCpfCnpj(details.document) : "",
      billingEmail: details.billingEmail ?? "",
    });
    setShowErrors(false);
    setServerError(null);
    setEditing(true);
  };

  const save = async () => {
    setShowErrors(true);
    setServerError(null);
    if (errors.billingName || errors.document || errors.billingEmail) return;
    setSaving(true);
    try {
      await updateBillingDetails({
        organizationId,
        billingName: form.billingName.trim(),
        document: form.document,
        billingEmail: form.billingEmail.trim(),
      });
      toast.success("Dados de cobrança atualizados");
      setEditing(false);
    } catch (e) {
      setServerError(mutationErrorMessage(e, "Não foi possível atualizar os dados de cobrança."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <BillingDetailsCardView
      details={details}
      canManage
      editing={editing}
      form={form}
      errors={errors}
      showErrors={showErrors}
      saving={saving}
      serverError={serverError}
      onEdit={open}
      onClose={() => setEditing(false)}
      onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
      onSave={() => void save()}
    />
  );
}
