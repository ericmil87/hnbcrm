import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Link2Off, ShieldAlert, Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PermissionGate } from "@/components/guards/PermissionGate";
import { channelIcon, channelLabel } from "@/lib/channelAccounts";
import { mutationErrorMessage } from "@/lib/errors";
import {
  DEFAULT_APP_HINT,
  STANDARD_ACCESS_NOTICE,
  groupMetaConfigs,
  metaConnectionState,
  type MetaAuthState,
} from "@/lib/metaConnect";

/** Campos de getChannelConfigs usados pelos canais Instagram / Messenger. */
export interface MetaChannelConfig {
  _id: Id<"channelConfigs">;
  channel: "instagram" | "messenger";
  displayName: string;
  status: "active" | "disabled" | "error";
  metaConnectionId: Id<"metaConnections"> | null;
  metaAccountLabel: string | null;
  metaAccountHandle: string | null;
  metaAuthState: MetaAuthState | null;
  metaSubscribed: boolean | null;
  metaConnectedBy: { memberId: string; name: string } | null;
  disabledByModuleAt: number | null;
}

type Pending =
  | { kind: "disconnect"; connectionId: Id<"metaConnections"> }
  | { kind: "delete"; configId: Id<"channelConfigs"> }
  | null;

interface MetaChannelCardsProps {
  organizationId: Id<"organizations">;
  configs: MetaChannelConfig[];
}

/** Canais Instagram / Messenger, agrupados por Página. */
export function MetaChannelCards({ organizationId, configs }: MetaChannelCardsProps) {
  const disconnect = useMutation(api.metaMessaging.disconnectMetaConnection);
  const deleteConfig = useMutation(api.channelConfigs.deleteChannelConfig);
  const [pending, setPending] = useState<Pending>(null);

  const groups = groupMetaConfigs(configs);

  const runPending = () => {
    if (!pending) return;
    if (pending.kind === "disconnect") {
      toast.promise(disconnect({ organizationId, connectionId: pending.connectionId }), {
        loading: "Desconectando...",
        success: "Página desconectada",
        error: (e) => mutationErrorMessage(e, "Não foi possível desconectar"),
      });
    } else {
      toast.promise(deleteConfig({ configId: pending.configId }), {
        loading: "Excluindo canal...",
        success: "Canal excluído",
        error: (e) => mutationErrorMessage(e, "Não foi possível excluir o canal"),
      });
    }
  };

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.key} className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{group.title}</h4>
          {group.configs.map((config) => (
            <MetaChannelCard
              key={config._id}
              organizationId={organizationId}
              config={config}
              onDisconnect={() =>
                config.metaConnectionId &&
                setPending({ kind: "disconnect", connectionId: config.metaConnectionId })
              }
              onDelete={() => setPending({ kind: "delete", configId: config._id })}
            />
          ))}
        </div>
      ))}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={runPending}
        title={pending?.kind === "disconnect" ? "Desconectar Página" : "Excluir canal"}
        description={
          pending?.kind === "disconnect"
            ? "A Página será desconectada do HNBCRM e os canais Messenger e Instagram dela deixam de receber e enviar mensagens. Você pode conectar de novo depois."
            : "Tem certeza que deseja excluir este canal? As mensagens deixam de chegar ao HNBCRM e esta ação não pode ser desfeita."
        }
        confirmLabel={pending?.kind === "disconnect" ? "Desconectar" : "Excluir"}
        variant="danger"
      />
    </div>
  );
}

function MetaChannelCard({
  organizationId,
  config,
  onDisconnect,
  onDelete,
}: {
  organizationId: Id<"organizations">;
  config: MetaChannelConfig;
  onDisconnect: () => void;
  onDelete: () => void;
}) {
  const Icon = channelIcon(config.channel, config.channel);
  const state = metaConnectionState(config);
  const name = config.metaAccountLabel ?? config.displayName;
  const handle = config.metaAccountHandle ? `@${config.metaAccountHandle.replace(/^@/, "")}` : null;

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-3.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-500">
            <Icon size={18} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-text-primary">{channelLabel(config.channel)}</span>
              <Badge variant={state.variant}>{state.label}</Badge>
            </div>
            <p className="mt-0.5 text-sm text-text-secondary break-all">
              {name}
              {handle && handle !== name ? ` · ${handle}` : ""}
            </p>
            {config.metaConnectedBy && (
              <p className="mt-0.5 text-xs text-text-muted">Conectado por {config.metaConnectedBy.name}</p>
            )}
          </div>
        </div>

        <PermissionGate organizationId={organizationId} category="settings" level="manage">
          <div className="flex items-center gap-1.5 flex-wrap">
            {config.metaConnectionId && (
              <Button variant="secondary" size="sm" onClick={onDisconnect} className="min-h-[44px] md:min-h-0">
                <Link2Off size={14} />
                Desconectar
              </Button>
            )}
            <Button variant="danger" size="sm" onClick={onDelete} className="min-h-[44px] md:min-h-0">
              <Trash2 size={14} />
              Excluir
            </Button>
          </div>
        </PermissionGate>
      </div>

      <div className="mt-3 space-y-1.5 rounded-lg border border-border-subtle bg-surface-base p-2.5 text-xs text-text-muted">
        <p className="flex items-start gap-2">
          <ShieldAlert size={13} className="mt-0.5 shrink-0 text-semantic-warning" aria-hidden="true" />
          <span>{STANDARD_ACCESS_NOTICE}</span>
        </p>
        <p>{DEFAULT_APP_HINT}</p>
      </div>
    </div>
  );
}
