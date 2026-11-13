import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Cloud, Radio } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { asksAiAckOnQrConnect } from "@/lib/bridgeAiAck";
import { CONNECT_NARROW_QUERY, defaultConnectMode, type ConnectMode } from "@/lib/channelConnect";
import { VOCAB } from "@/lib/vocab";
import { MetaForm } from "./MetaForm";
import { PairingPanel, type ConnectedInfo } from "./PairingPanel";
import { QrCodeConnectForm, type QrConnectDefaults } from "./QrCodeConnectForm";
import type { ChannelConnectActions } from "./types";
import { useChannelConnectActions, useQrConnectDefaults } from "./useConnectActions";
import { useOrgDefaultCountry } from "./useOrgDefaultCountry";

export interface ChannelConnectCardProps {
  organizationId: Id<"organizations">;
  /** Número que já existe e só precisa ser conectado: vai direto ao passo de conexão. */
  configId?: Id<"channelConfigs">;
  /** Aba inicial da conexão. Sem isso: código no celular, QR code no computador. */
  defaultMode?: ConnectMode;
  variant?: "panel" | "wizard";
  /** O número ficou pronto (WhatsApp oficial salvo ou número conectado). */
  onConnected: (channelId: Id<"channelConfigs">) => void;
  /** Cancelar na primeira tela. */
  onClose?: () => void;
}

export interface ChannelConnectCardViewProps extends ChannelConnectCardProps {
  /** Tela estreita ou de toque: o código de conexão vira o padrão. */
  narrow: boolean;
  defaults: QrConnectDefaults | undefined;
  defaultCountryCode?: string;
  actions: ChannelConnectActions;
  /**
   * IA da org ligada e sem o aceite da IA no QR code: o aceite de banimento do QR code também
   * libera a IA (uma confirmação só). Ausente = só o aceite de banimento, como antes.
   */
  aiAck?: { grant: () => Promise<unknown> };
}

type Step = "choose" | "meta" | "qr-setup" | "pair";

/** Apresentacional: não usa Convex (as chamadas chegam por `actions`). */
export function ChannelConnectCardView({
  organizationId,
  configId,
  defaultMode,
  variant = "panel",
  onConnected,
  onClose,
  narrow,
  defaults,
  defaultCountryCode,
  actions,
  aiAck,
}: ChannelConnectCardViewProps) {
  const [step, setStep] = useState<Step>(configId ? "pair" : "choose");
  const [pairId, setPairId] = useState<Id<"channelConfigs"> | undefined>(configId);
  const mode = defaultMode ?? defaultConnectMode(narrow);

  const content = (() => {
    if (step === "pair" && pairId) {
      return (
        <PairingPanel
          configId={pairId}
          defaultMode={mode}
          defaultCountryCode={defaultCountryCode}
          startPairing={actions.startPairing}
          pollPairing={actions.pollPairing}
          onConnected={(info: ConnectedInfo) => {
            actions.markConnected?.(pairId);
            const phone = info.displayPhoneNumber ? ` (${info.displayPhoneNumber})` : "";
            toast.success(info.fresh ? `Número conectado${phone}` : `Número já conectado${phone}`);
            if (info.displacedFrom.length > 0) {
              toast.warning(`Este número foi desconectado de: ${info.displacedFrom.join(", ")}`, {
                duration: 10000,
              });
            }
          }}
          onDone={() => onConnected(pairId)}
        />
      );
    }
    if (step === "meta") {
      return (
        <MetaForm
          organizationId={organizationId}
          config={null}
          onClose={() => onClose?.()}
          createChannelConfig={actions.createChannelConfig}
          updateChannelConfig={actions.updateChannelConfig}
          onBack={() => setStep("choose")}
          onCreated={(id) => onConnected(id)}
        />
      );
    }
    if (step === "qr-setup") {
      return (
        <QrCodeConnectForm
          organizationId={organizationId}
          config={null}
          defaults={defaults}
          onClose={() => onClose?.()}
          createChannelConfig={actions.createChannelConfig}
          updateChannelConfig={actions.updateChannelConfig}
          createManagedChannel={actions.createManagedChannel}
          aiAck={aiAck}
          onCreated={(id) => {
            setPairId(id);
            setStep("pair");
          }}
          onBack={() => setStep("choose")}
        />
      );
    }
    return <ProviderChooser onPickOfficial={() => setStep("meta")} onPickQr={() => setStep("qr-setup")} />;
  })();

  if (variant === "wizard") {
    return (
      <Card variant="sunken" className="space-y-4">
        <h3 className="text-base font-semibold text-text-primary">{VOCAB.connectNumber}</h3>
        {content}
      </Card>
    );
  }
  return <div className="space-y-4">{content}</div>;
}

function ProviderChooser({ onPickOfficial, onPickQr }: { onPickOfficial: () => void; onPickQr: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">Escolha como este número será conectado.</p>
      <button
        type="button"
        onClick={onPickOfficial}
        className="min-h-11 w-full rounded-lg border border-border bg-surface-sunken p-4 text-left transition-colors hover:border-brand-500"
      >
        <div className="mb-1 flex items-center gap-2">
          <Cloud size={18} className="text-brand-500" />
          <span className="font-medium text-text-primary">{VOCAB.whatsappOfficial}</span>
        </div>
        <p className="text-sm text-text-secondary">
          Recomendado. Aprovado pela Meta, com janela de 24h e templates. Requer um app no Meta for Developers.
        </p>
      </button>
      <button
        type="button"
        onClick={onPickQr}
        className="min-h-11 w-full rounded-lg border border-border bg-surface-sunken p-4 text-left transition-colors hover:border-semantic-warning"
      >
        <div className="mb-1 flex items-center gap-2">
          <Radio size={18} className="text-semantic-warning" />
          <span className="font-medium text-text-primary">{VOCAB.whatsappQr}</span>
        </div>
        <p className="text-sm text-text-secondary">
          Conexão rápida pelo celular, com código de conexão ou QR code. Sem janela de 24h nem templates.{" "}
          <span className="text-semantic-warning">Risco de banimento: use por sua conta e risco.</span>
        </p>
      </button>
    </div>
  );
}

/**
 * Conexão de número do WhatsApp: oficial (Meta) ou por QR code, com aviso de risco e aceite, e depois
 * "Conectar com código" ou QR code. Reutilizável pelas Configurações e pela configuração inicial.
 */
export function ChannelConnectCard(props: ChannelConnectCardProps) {
  const { organizationId, configId } = props;
  const actions = useChannelConnectActions();
  const narrow = useMediaQuery(CONNECT_NARROW_QUERY);
  const defaultCountryCode = useOrgDefaultCountry(organizationId);
  const defaults = useQrConnectDefaults(organizationId, !!configId);
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  const setBridgeAiAck = useMutation(api.aiSettings.setBridgeAiAck);
  // Aceite da IA no QR code junto com o de banimento (mesmo clique): só com a IA ligada e sem o
  // aceite. Grava pela porta de sempre (`setBridgeAiAck`, audit `high`); nunca sem o clique.
  const aiAck =
    aiStatus && asksAiAckOnQrConnect(aiStatus)
      ? { grant: () => setBridgeAiAck({ organizationId, accept: true, riskAck: true }) }
      : undefined;

  return (
    <ChannelConnectCardView
      {...props}
      narrow={narrow}
      defaults={configId ? { managedAvailable: false } : defaults}
      defaultCountryCode={defaultCountryCode}
      actions={actions}
      aiAck={aiAck}
    />
  );
}
