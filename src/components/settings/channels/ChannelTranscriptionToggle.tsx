import { useAction } from "convex/react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { usePermissions } from "@/hooks/usePermissions";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

const TITLE = "Transcrever áudios automaticamente";

/** Apresentação do toggle: sem permissão vira um selo "Ativado/Desativado". */
export function TranscriptionToggleView({
  checked,
  onToggle,
  canManage,
  description = "Transcreve os áudios recebidos dos contatos e os enviados pela equipe. A transcrição fica no histórico e o Atendente IA a lê.",
  busy,
}: {
  checked: boolean;
  onToggle: () => void;
  canManage: boolean;
  /** `null` esconde a descrição. */
  description?: string | null;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-base p-2.5">
      <div className="min-w-0">
        <span className="text-sm text-text-primary">{TITLE}</span>
        {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
      </div>
      {canManage ? (
        <Switch checked={checked} onCheckedChange={onToggle} label={TITLE} hideLabel disabled={busy} />
      ) : (
        <Badge variant={checked ? "success" : "default"}>{checked ? "Ativado" : "Desativado"}</Badge>
      )}
    </div>
  );
}

/**
 * Transcrição automática de áudio de UM canal (campo `autoTranscribeAudio` de
 * `channelConfigs`, via `updateChannelConfig`). Usado em Recursos da IA e no
 * cartão do número.
 */
export function ChannelTranscriptionToggle({
  organizationId,
  configId,
  checked,
  description,
}: {
  organizationId: Id<"organizations">;
  configId: Id<"channelConfigs">;
  checked: boolean;
  description?: string | null;
}) {
  const updateChannelConfig = useAction(api.channelConfigs.updateChannelConfig);
  const { can } = usePermissions(organizationId);
  const onToggle = () => {
    const next = !checked;
    toast.promise(updateChannelConfig({ configId, autoTranscribeAudio: next }), {
      loading: "Atualizando…",
      success: next ? "Transcrição automática ativada" : "Transcrição automática desativada",
      error: "Não foi possível atualizar transcrição automática.",
    });
  };
  return (
    <TranscriptionToggleView
      checked={checked}
      onToggle={onToggle}
      canManage={can("settings", "manage")}
      description={description}
    />
  );
}
