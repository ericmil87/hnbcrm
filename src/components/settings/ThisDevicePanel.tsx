import { useState } from "react";
import { CheckCircle2, Download, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { SectionCard } from "@/components/ui/SectionCard";
import { InstallIosSteps } from "@/components/pwa/InstallIosSteps";
import { useInstallState } from "@/hooks/useInstallState";
import { promptInstall } from "@/lib/pwa/installStore";

/** Settings › Conta › Este aparelho: fixed entry point to install the app (never depends on the invite). */
export function ThisDevicePanel() {
  const { installed, canPrompt, iosManual, platform } = useInstallState();
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
    <SectionCard
      title="Este aparelho"
      description="Instale o HNBCRM para abrir direto da tela inicial."
      icon={<Smartphone size={20} aria-hidden="true" />}
    >
      {installed ? (
        <p className="flex items-center gap-2 text-sm text-text-primary">
          <CheckCircle2 size={18} className="text-semantic-success" aria-hidden="true" />
          App instalado
        </p>
      ) : canPrompt ? (
        <Button size="lg" loading={busy} onClick={install}>
          <Download size={18} aria-hidden="true" />
          Instalar app
        </Button>
      ) : iosManual || platform === "ios" ? (
        <div className="space-y-3">
          {!iosManual && <p className="text-sm text-text-secondary">Abra esta página no Safari para instalar.</p>}
          <InstallIosSteps />
        </div>
      ) : (
        <p className="text-sm text-text-secondary">
          Este navegador não oferece a instalação agora. No Chrome ou no Edge, procure o ícone de instalar na barra de endereço.
        </p>
      )}
    </SectionCard>
  );
}
