import { useState } from "react";
import { CheckCircle2, Download, Smartphone } from "lucide-react";
import { toast } from "sonner";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { SectionCard } from "@/components/ui/SectionCard";
import { InstallIosSteps } from "@/components/pwa/InstallIosSteps";
import { useInstallState } from "@/hooks/useInstallState";
import { PushActivationCard } from "@/components/notifications/PushActivationCard";
import { promptInstall } from "@/lib/pwa/installStore";
import { installHelpKind } from "@/lib/pwa/platform";

const HELP = {
  "android-menu": "No Chrome, abra o menu ⋮ e toque em Instalar app (ou Adicionar à tela inicial).",
  "mac-safari": "No Safari, use Arquivo › Adicionar ao Dock.",
  "desktop-menu": "No Chrome ou no Edge, use o ícone de instalar na barra de endereço ou o menu ⋮ › Instalar HNBCRM.",
} as const;

/** Settings › Conta › Este aparelho: fixed entry point to install the app (never depends on the invite). */
export function ThisDevicePanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const { installed, canPrompt, platform } = useInstallState();
  const kind = installHelpKind({ platform, userAgent: navigator.userAgent, canPrompt, installed });
  const [busy, setBusy] = useState(false);

  const install = async () => {
    setBusy(true);
    try {
      const outcome = await promptInstall();
      if (outcome === "accepted") toast.success("App instalado");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Este aparelho"
        description="Instale o HNBCRM para abrir direto da tela inicial."
        icon={<Smartphone size={20} aria-hidden="true" />}
      >
        {kind === "installed" ? (
          <p className="flex items-center gap-2 text-sm text-text-primary">
            <CheckCircle2 size={18} className="text-semantic-success" aria-hidden="true" />
            App instalado
          </p>
        ) : kind === "prompt" ? (
          <Button size="lg" loading={busy} onClick={install}>
            <Download size={18} aria-hidden="true" />
            Instalar app
          </Button>
        ) : kind === "ios-safari" || kind === "ios-other" ? (
          <div className="space-y-3">
            {kind === "ios-other" && (
              <p className="text-sm text-text-secondary">
                No iPhone, outros navegadores também adicionam pelo Compartilhar (iOS 16.4 ou mais novo). Se não aparecer, abra no Safari.
              </p>
            )}
            <InstallIosSteps />
            <p className="text-caption text-text-muted">Se já instalou, abra pelo ícone na tela de início.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-text-secondary">{HELP[kind]}</p>
            <p className="text-caption text-text-muted">Se já instalou, abra pelo ícone na tela de início.</p>
          </div>
        )}
      </SectionCard>
      <PushActivationCard organizationId={organizationId} hideInstall />
    </div>
  );
}
