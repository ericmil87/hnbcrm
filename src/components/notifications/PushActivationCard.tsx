import { useState } from "react";
import { Bell, BellOff, BellRing, CheckCircle2, Smartphone } from "lucide-react";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { SectionCard } from "@/components/ui/SectionCard";
import { InstallIosSheet } from "@/components/pwa/InstallIosSteps";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { readPlatform, type InstallPlatform } from "@/lib/pwa/platform";
import { blockedHelp, type PushStatus } from "@/lib/push/subscription";

interface PushActivationCardViewProps {
  status: PushStatus;
  platform: InstallPlatform;
  userAgent?: string;
  busy?: boolean;
  error?: string | null;
  onEnable: () => void;
  onDisable: () => void;
  onShowInstall: () => void;
}

/** Cartão "Receber avisos neste aparelho" (apresentacional). */
export function PushActivationCardView({
  status,
  platform,
  userAgent = "",
  busy = false,
  error = null,
  onEnable,
  onDisable,
  onShowInstall,
}: PushActivationCardViewProps) {
  if (status === "loading") return null;
  return (
    <SectionCard
      title="Receber avisos neste aparelho"
      description="Pedidos de ajuda e mensagens para você chegam como notificação, mesmo com o app fechado."
      icon={<BellRing size={20} aria-hidden="true" />}
    >
      {status === "default" && (
        <div className="space-y-2">
          <Button size="lg" loading={busy} onClick={onEnable} className="w-full sm:w-auto">
            <Bell size={18} aria-hidden="true" />
            Ativar avisos
          </Button>
          <p className="text-caption text-text-muted">O navegador vai pedir a sua permissão. Você pode desligar quando quiser.</p>
        </div>
      )}
      {status === "subscribed" && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2 text-sm text-text-primary" role="status">
            <CheckCircle2 size={18} className="shrink-0 text-semantic-success" aria-hidden="true" />
            Avisos ligados neste aparelho
          </p>
          <Button variant="secondary" size="md" loading={busy} onClick={onDisable}>
            Desligar
          </Button>
        </div>
      )}
      {status === "denied" && (
        <div className="space-y-2" role="status">
          <p className="flex items-center gap-2 text-sm text-text-primary">
            <BellOff size={18} className="shrink-0 text-semantic-warning" aria-hidden="true" />
            Os avisos estão bloqueados neste aparelho
          </p>
          <p className="text-sm text-text-secondary">{blockedHelp(platform, userAgent)}</p>
        </div>
      )}
      {status === "needs-install" && (
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">No iPhone, os avisos só funcionam com o app na Tela de Início.</p>
          <Button size="lg" onClick={onShowInstall} className="w-full sm:w-auto">
            <Smartphone size={18} aria-hidden="true" />
            Instale o app para receber avisos
          </Button>
        </div>
      )}
      {status === "unsupported" && (
        <p className="text-sm text-text-secondary" role="status">
          Este navegador não recebe avisos com o app fechado. Você continua vendo tudo no sino de notificações.
        </p>
      )}
      {status === "error" && (
        <div className="space-y-2">
          <p className="text-sm text-semantic-error" role="alert">
            {error ?? "Não foi possível ligar os avisos."}
          </p>
          <Button variant="secondary" size="md" loading={busy} onClick={onEnable}>
            Tentar de novo
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

/** Container: some quando o deployment não tem push (chave VAPID nula). */
export function PushActivationCard({
  organizationId,
  hideInstall = false,
}: {
  organizationId: Id<"organizations">;
  /** Em "Este aparelho" os passos de instalação já estão na própria tela. */
  hideInstall?: boolean;
}) {
  const push = usePushSubscription(organizationId);
  const [installOpen, setInstallOpen] = useState(false);
  if (push.hidden || (hideInstall && push.status === "needs-install")) return null;
  return (
    <>
      <PushActivationCardView
        status={push.status}
        platform={readPlatform()}
        userAgent={navigator.userAgent}
        busy={push.busy}
        error={push.error}
        onEnable={() => void push.enable()}
        onDisable={() => void push.disable()}
        onShowInstall={() => setInstallOpen(true)}
      />
      <InstallIosSheet open={installOpen} onClose={() => setInstallOpen(false)} />
    </>
  );
}
