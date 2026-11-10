import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { mutationErrorMessage } from "@/lib/errors";
import type { SubscriptionInfo } from "@/lib/subscriptionManagement";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SubscriptionManagementView, type ManagementConfirm } from "./SubscriptionManagementView";

interface SubscriptionManagementProps {
  organizationId: Id<"organizations">;
  sub: SubscriptionInfo | null | undefined;
  mode: string;
  canManage: boolean;
  now: number;
  /** Valor da 1ª fatura paga (texto do reembolso). */
  refundAmountBrl: number | null;
}

/** Cancelar, reativar, desfazer troca agendada e pedir reembolso (actions do servidor). */
export function SubscriptionManagement({ organizationId, sub, mode, canManage, now, refundAmountBrl }: SubscriptionManagementProps) {
  const cancelSubscription = useAction(api.billing.cancelSubscription);
  const reactivateSubscription = useAction(api.billing.reactivateSubscription);
  const cancelScheduledChange = useAction(api.billing.cancelScheduledChange);
  const requestRefund = useAction(api.billing.requestRefund);
  const [confirm, setConfirm] = useState<ManagementConfirm>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>, done: string, fallback: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(done);
    } catch (e) {
      toast.error(mutationErrorMessage(e, fallback));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <SubscriptionManagementView
      sub={sub}
      mode={mode}
      canManage={canManage}
      now={now}
      refundAmountBrl={refundAmountBrl}
      busy={busy}
      confirm={confirm}
      onAsk={setConfirm}
      onCloseConfirm={() => setConfirm(null)}
      onConfirm={() => {
        if (confirm === "cancel") {
          void run(() => cancelSubscription({ organizationId }), "Cancelamento agendado", "Não foi possível cancelar a assinatura.");
        } else if (confirm === "refund") {
          void run(() => requestRefund({ organizationId }), "Reembolso solicitado", "Não foi possível pedir o reembolso.");
        }
      }}
      onReactivate={() =>
        void run(() => reactivateSubscription({ organizationId }), "Assinatura reativada", "Não foi possível reativar a assinatura.")
      }
      onUndoChange={() =>
        void run(() => cancelScheduledChange({ organizationId }), "Troca desfeita", "Não foi possível desfazer a troca.")
      }
    />
  );
}
