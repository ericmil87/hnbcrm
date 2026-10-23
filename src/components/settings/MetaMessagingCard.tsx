import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Instagram, ShieldAlert } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/settings/CentralSection";
import { mutationErrorMessage } from "@/lib/errors";
import { MODULE_OFF_CONFIRMATION, STANDARD_ACCESS_NOTICE } from "@/lib/metaConnect";

interface MetaMessagingCardProps {
  organizationId: Id<"organizations">;
  enabled: boolean;
  /** Há canais Instagram/Messenger ativos (desligar pede confirmação). */
  hasActiveMetaChannels: boolean;
}

/** Toggle do módulo "Mais canais" (D12). Só renderizado para quem tem settings:manage. */
export function MetaMessagingCard({ organizationId, enabled, hasActiveMetaChannels }: MetaMessagingCardProps) {
  const setOrgModules = useMutation(api.orgModules.setOrgModules);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const apply = async (next: boolean) => {
    setBusy(true);
    try {
      await setOrgModules({ organizationId, modules: { metaMessaging: next } });
      toast.success(next ? "Instagram e Messenger ligados" : "Instagram e Messenger desligados");
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível alterar o módulo"));
    } finally {
      setBusy(false);
    }
  };

  const onToggle = () => {
    if (enabled && hasActiveMetaChannels) setConfirmOff(true);
    else void apply(!enabled);
  };

  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-500">
          <Instagram size={18} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-text-primary">Mais canais: Instagram e Facebook Messenger</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Receba e responda mensagens do Instagram e do Messenger na Caixa de Entrada, pela conexão oficial da
            Meta. Desligado, nada muda no seu CRM.
          </p>
        </div>
        <div className="pt-1.5">
          <Switch
            checked={enabled}
            onChange={onToggle}
            label="Instagram e Facebook Messenger"
            disabled={busy}
          />
        </div>
      </div>

      {enabled && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-semantic-warning/30 bg-semantic-warning/10 px-3.5 py-2.5 text-xs text-text-secondary">
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
          <span>{STANDARD_ACCESS_NOTICE}</span>
        </div>
      )}

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => void apply(false)}
        title="Desligar Instagram e Messenger"
        description={`Os canais conectados serão desativados. ${MODULE_OFF_CONFIRMATION}`}
        confirmLabel="Desligar"
        variant="danger"
      />
    </Card>
  );
}
