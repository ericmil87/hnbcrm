import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { Cloud, Radio, Instagram, Facebook } from "lucide-react";
import { mutationErrorMessage } from "@/lib/errors";
import type { ChannelConfig, Provider, CreateChannelConfigFn, UpdateChannelConfigFn, ProvisionBridgeFn } from "./types";
import { MetaForm } from "./MetaForm";
import { QrCodeConnectForm } from "./QrCodeConnectForm";

// --- Create/edit form modal (provider-aware) ---
export function ChannelFormModal({
  organizationId,
  metaEnabled,
  config,
  onClose,
  createChannelConfig,
  updateChannelConfig,
  provisionBridgeChannel,
}: {
  organizationId: Id<"organizations">;
  metaEnabled: boolean;
  config: ChannelConfig | null;
  onClose: () => void;
  createChannelConfig: CreateChannelConfigFn;
  updateChannelConfig: UpdateChannelConfigFn;
  provisionBridgeChannel: ProvisionBridgeFn;
}) {
  const isEditing = !!config;
  // On create, pick the provider first. On edit, the provider is locked.
  const [provider, setProvider] = useState<Provider | null>(config ? config.provider : null);

  const title = isEditing
    ? "Editar número"
    : provider === null
      ? "Conectar número"
      : provider === "meta"
        ? "Conectar WhatsApp oficial (Meta)"
        : "Conectar WhatsApp por QR code";

  return (
    <Modal open onClose={onClose} title={title}>
      {provider === null ? (
        <ProviderChooser
          onPick={setProvider}
          organizationId={organizationId}
          metaEnabled={metaEnabled && !isEditing}
        />
      ) : provider === "meta" ? (
        <MetaForm
          organizationId={organizationId}
          config={config}
          onClose={onClose}
          createChannelConfig={createChannelConfig}
          updateChannelConfig={updateChannelConfig}
          onBack={isEditing ? undefined : () => setProvider(null)}
        />
      ) : (
        <QrCodeConnectForm
          organizationId={organizationId}
          config={config}
          onClose={onClose}
          createChannelConfig={createChannelConfig}
          updateChannelConfig={updateChannelConfig}
          provisionBridgeChannel={provisionBridgeChannel}
          onBack={isEditing ? undefined : () => setProvider(null)}
        />
      )}
    </Modal>
  );
}

function ProviderChooser({
  onPick,
  organizationId,
  metaEnabled,
}: {
  onPick: (p: Provider) => void;
  organizationId: Id<"organizations">;
  metaEnabled: boolean;
}) {
  const startMetaConnect = useAction(api.metaMessaging.startMetaConnect);
  const [connecting, setConnecting] = useState(false);

  // Não abre formulário: pede a URL do login da Meta e redireciona.
  const handleConnectMeta = async () => {
    setConnecting(true);
    try {
      const { url } = await startMetaConnect({ organizationId });
      window.location.assign(url);
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível iniciar a conexão com a Meta"));
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">Escolha como este número será conectado.</p>
      <button
        onClick={() => onPick("meta")}
        className="w-full text-left rounded-lg border border-border bg-surface-sunken p-4 hover:border-brand-500 transition-colors"
      >
        <div className="flex items-center gap-2 mb-1">
          <Cloud size={18} className="text-brand-500" />
          <span className="font-medium text-text-primary">WhatsApp oficial (Meta)</span>
        </div>
        <p className="text-sm text-text-secondary">
          Recomendado. Aprovado pela Meta, com janela de 24h e templates. Requer app no Meta for
          Developers.
        </p>
      </button>
      <button
        onClick={() => onPick("bridge")}
        className="w-full text-left rounded-lg border border-border bg-surface-sunken p-4 hover:border-semantic-warning transition-colors"
      >
        <div className="flex items-center gap-2 mb-1">
          <Radio size={18} className="text-semantic-warning" />
          <span className="font-medium text-text-primary">WhatsApp por QR code</span>
        </div>
        <p className="text-sm text-text-secondary">
          Ponte rápida via protocolo não sancionado pela Meta. Sem janela de 24h nem templates.{" "}
          <span className="text-semantic-warning">Risco de banimento — use por sua conta e risco.</span>
        </p>
      </button>
      {metaEnabled && (
        <button
          onClick={() => void handleConnectMeta()}
          disabled={connecting}
          className="w-full text-left rounded-lg border border-border bg-surface-sunken p-4 hover:border-brand-500 transition-colors disabled:opacity-60 disabled:cursor-wait"
        >
          <div className="flex items-center gap-2 mb-1">
            <Instagram size={18} className="text-brand-500" />
            <Facebook size={18} className="text-brand-500" />
            <span className="font-medium text-text-primary">Instagram / Facebook Messenger (oficial)</span>
            {connecting && <Spinner size="sm" />}
          </div>
          <p className="text-sm text-text-secondary">
            Conexão oficial pela Meta, sem senha. Você entra com o Facebook e escolhe a Página e a conta do
            Instagram.
          </p>
        </button>
      )}
    </div>
  );
}
