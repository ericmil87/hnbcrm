import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { Instagram } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { useOrgModules } from "@/hooks/useOrgModules";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { mutationErrorMessage } from "@/lib/errors";
import { MetaMessagingCard } from "@/components/settings/MetaMessagingCard";
import { MetaChannelCards, type MetaChannelConfig } from "@/components/settings/MetaChannelCards";

export function InstagramPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const { can } = usePermissions(organizationId);
  const canManage = can("settings", "manage");
  const { modules } = useOrgModules(organizationId);
  const metaEnabled = modules.metaMessaging;

  const allConfigs = useQuery(api.channelConfigs.getChannelConfigs, { organizationId }) as
    | { channel: string }[]
    | undefined;
  const allMetaConfigs = (allConfigs ?? []).filter(
    (c): c is MetaChannelConfig => c.channel === "instagram" || c.channel === "messenger"
  );
  const metaConfigs = metaEnabled ? allMetaConfigs : [];

  // Não abre formulário: pede a URL do login da Meta e redireciona (a volta cai em Números conectados).
  const startMetaConnect = useAction(api.metaMessaging.startMetaConnect);
  const [connecting, setConnecting] = useState(false);
  const handleConnect = async () => {
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
    <div className="space-y-6">
      {canManage && (
        <MetaMessagingCard
          organizationId={organizationId}
          enabled={metaEnabled}
          hasActiveMetaChannels={allMetaConfigs.some((c) => c.status === "active")}
        />
      )}

      {metaEnabled && canManage && (
        <Card variant="sunken" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-text-secondary">
            Conexão oficial pela Meta, sem senha: você entra com o Facebook e escolhe a Página e a conta do
            Instagram.
          </p>
          <Button className="shrink-0" onClick={() => void handleConnect()} disabled={connecting}>
            {connecting ? <Spinner size="sm" /> : <Instagram size={16} />}
            Conectar Instagram ou Messenger
          </Button>
        </Card>
      )}

      {metaConfigs.length > 0 && (
        <Card>
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10">
              <Instagram size={20} className="text-brand-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Instagram e Messenger</h3>
              <p className="text-sm text-text-secondary">Contas conectadas pela conexão oficial da Meta.</p>
            </div>
          </div>
          <MetaChannelCards organizationId={organizationId} configs={metaConfigs} />
        </Card>
      )}
    </div>
  );
}
