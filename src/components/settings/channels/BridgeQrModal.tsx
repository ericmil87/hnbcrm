import { useCallback } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { defaultConnectMode, CONNECT_NARROW_QUERY } from "@/lib/channelConnect";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { PairingPanel, type ConnectedInfo } from "./PairingPanel";
import { useOrgDefaultCountry } from "./useOrgDefaultCountry";
import type { ChannelConfig } from "./types";

/**
 * Modal "Conectar número" de um número que já existe (botão "Mostrar QR code" do card).
 * Oferece código de conexão e QR code; ao conectar, grava o estado uma vez (o card atualiza
 * sozinho), avisa e fecha.
 */
export function BridgeQrModal({
  organizationId,
  config,
  onClose,
}: {
  organizationId: Id<"organizations">;
  config: ChannelConfig;
  onClose: () => void;
}) {
  const startPairing = useAction(api.channelConfigs.startBridgePairing);
  const pollPairing = useAction(api.channelConfigs.pollBridgePairing);
  const checkChannelHealth = useAction(api.channelConfigs.checkChannelHealth);
  const narrow = useMediaQuery(CONNECT_NARROW_QUERY);
  const defaultCountryCode = useOrgDefaultCountry(organizationId);

  const handleConnected = useCallback(
    (info: ConnectedInfo) => {
      // Grava o estado uma vez para a query reativa atualizar o card.
      void checkChannelHealth({ configId: config._id }).catch(() => undefined);
      const phone = info.displayPhoneNumber ? ` (${info.displayPhoneNumber})` : "";
      toast.success(info.fresh ? `Número conectado${phone}` : `Número já conectado${phone}`);
      if (info.displacedFrom.length > 0) {
        toast.warning(`Este número foi desconectado de: ${info.displacedFrom.join(", ")}`, { duration: 10000 });
      }
    },
    [checkChannelHealth, config._id]
  );

  return (
    <Modal open onClose={onClose} title="Conectar número">
      <div className="space-y-4">
        <PairingPanel
          configId={config._id}
          defaultMode={defaultConnectMode(narrow)}
          defaultCountryCode={defaultCountryCode}
          startPairing={startPairing}
          pollPairing={pollPairing}
          onConnected={handleConnected}
          onDone={onClose}
        />
        <Button variant="secondary" onClick={onClose} className="w-full">
          Fechar
        </Button>
      </div>
    </Modal>
  );
}
