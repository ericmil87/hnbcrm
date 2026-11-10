import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  canCancelSubscription,
  canReactivateSubscription,
  canRequestRefund,
  cancelConfirmText,
  cancelScheduledText,
  nextChargeText,
  refundConfirmText,
  scheduledChangeText,
  type SubscriptionInfo,
} from "@/lib/subscriptionManagement";

export type ManagementConfirm = "cancel" | "refund" | null;

export interface SubscriptionManagementViewProps {
  sub: SubscriptionInfo | null | undefined;
  mode: string;
  canManage: boolean;
  now: number;
  /** Valor da 1ª cobrança, para o texto do reembolso (a fatura paga mais recente). */
  refundAmountBrl: number | null;
  /** Ação em andamento (desabilita os botões). */
  busy: boolean;
  confirm: ManagementConfirm;
  onAsk: (c: Exclude<ManagementConfirm, null>) => void;
  onCloseConfirm: () => void;
  onConfirm: () => void;
  onReactivate: () => void;
  onUndoChange: () => void;
}

const linkButton =
  "inline-flex min-h-9 items-center text-sm text-text-muted underline underline-offset-2 hover:text-text-primary coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50";

/** Próxima cobrança, cancelamento/mudança agendados e ações da assinatura (cartão "Plano atual"). */
export function SubscriptionManagementView(p: SubscriptionManagementViewProps) {
  const next = nextChargeText(p.sub);
  const cancelText = cancelScheduledText(p.sub);
  const changeText = scheduledChangeText(p.sub);
  const canCancel = canCancelSubscription({ mode: p.mode, sub: p.sub, canManage: p.canManage });
  const canReactivate = canReactivateSubscription({ sub: p.sub, canManage: p.canManage, now: p.now });
  const canRefund = canRequestRefund({ sub: p.sub, canManage: p.canManage, now: p.now });
  if (!next && !cancelText && !changeText && !canCancel && !canRefund) return null;

  return (
    <div className="space-y-2">
      {next && <p className="text-sm tabular-nums text-text-primary">{next}</p>}

      {cancelText && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm text-text-primary">{cancelText}</p>
          {canReactivate && (
            <Button variant="secondary" size="sm" loading={p.busy} onClick={p.onReactivate}>
              Reativar
            </Button>
          )}
        </div>
      )}

      {changeText && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-sm text-text-primary">{changeText}</p>
          {p.canManage && (
            <Button variant="secondary" size="sm" loading={p.busy} onClick={p.onUndoChange}>
              Desfazer
            </Button>
          )}
        </div>
      )}

      {(canCancel || canRefund) && (
        <div className="flex flex-wrap gap-x-4">
          {canRefund && (
            <button type="button" className={linkButton} disabled={p.busy} onClick={() => p.onAsk("refund")}>
              Pedir reembolso
            </button>
          )}
          {canCancel && (
            <button type="button" className={linkButton} disabled={p.busy} onClick={() => p.onAsk("cancel")}>
              Cancelar assinatura
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={p.confirm === "cancel"}
        onClose={p.onCloseConfirm}
        onConfirm={p.onConfirm}
        variant="danger"
        title="Cancelar a assinatura?"
        description={cancelConfirmText(p.sub?.cancelAt, p.sub?.currentPeriodEnd)}
        confirmLabel="Cancelar assinatura"
        cancelLabel="Manter assinatura"
      />
      <ConfirmDialog
        open={p.confirm === "refund"}
        onClose={p.onCloseConfirm}
        onConfirm={p.onConfirm}
        variant="danger"
        title="Pedir reembolso?"
        description={refundConfirmText(p.refundAmountBrl)}
        confirmLabel="Pedir reembolso"
        cancelLabel="Voltar"
      />
    </div>
  );
}
