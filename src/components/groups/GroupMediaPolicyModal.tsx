import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { GroupMediaModeSelector } from "@/components/groups/GroupMediaModeSelector";
import { usePermissions } from "@/hooks/usePermissions";
import type { GroupChatDoc } from "@/components/inbox/types";
import {
  GROUP_MEDIA_KINDS,
  GROUP_MEDIA_KIND_LABELS,
  GROUP_MEDIA_MODE_LABELS,
  GROUP_MEDIA_MODE_SHORT,
  normalizeGroupMedia,
  normalizeGroupMediaOverrides,
  type GroupMediaOverride,
  type GroupMediaOverrides,
} from "@/lib/groupMedia";
import { mutationErrorMessage } from "@/lib/errors";

/**
 * Mídia de UMA sala (v0.62): por tipo, herdar o padrão do número ou fixar.
 *
 * O rótulo de "herdar" mostra o modo que o número aplica HOJE — sem isso a
 * pessoa não sabe o que está herdando e fixa tudo "por garantia".
 */
export function GroupMediaPolicyModal({
  open,
  group,
  onClose,
}: {
  open: boolean;
  group: GroupChatDoc;
  onClose: () => void;
}) {
  const organizationId = group.organizationId as Id<"organizations">;
  const { can } = usePermissions(organizationId);
  const canManage = can("settings", "manage");
  const setGroupMediaPolicy = useMutation(api.groupChats.setGroupMediaPolicy);
  const channels = useQuery(
    api.groupChats.listChannelGroupSettings,
    open ? { organizationId } : "skip"
  );
  const numberDefault = normalizeGroupMedia(
    channels?.find((c) => c.channelConfigId === group.channelConfigId)?.groupMedia
  );

  const [policy, setPolicy] = useState<GroupMediaOverrides>(() =>
    normalizeGroupMediaOverrides(group.mediaPolicy)
  );
  const [saving, setSaving] = useState(false);

  // Mesma regra do modal de IA: recarrega só ao trocar de grupo — o objeto da
  // query reativa muda a cada resposta e apagaria a escolha em andamento.
  useEffect(() => {
    if (!open) return;
    setPolicy(normalizeGroupMediaOverrides(group.mediaPolicy));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group._id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await setGroupMediaPolicy({
        organizationId,
        groupChatId: group._id as Id<"groupChats">,
        policy,
      });
      toast.success(`Mídia de '${group.subject}' salva`);
      onClose();
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao salvar a mídia do grupo"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Mídia — ${group.subject}`}>
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-text-secondary">
          Por padrão cada sala segue o que foi escolhido no número. Fixe um tipo
          aqui só se esta sala for diferente — um grupo de compra e venda cheio de
          fotos, por exemplo.
        </p>

        {channels === undefined ? (
          <div className="flex justify-center py-6">
            <Spinner size="md" />
          </div>
        ) : (
          <div className="space-y-3">
            {GROUP_MEDIA_KINDS.map((kind) => (
              <GroupMediaModeSelector<GroupMediaOverride>
                key={kind}
                name={`group-media-override-${group._id}-${kind}`}
                legend={GROUP_MEDIA_KIND_LABELS[kind]}
                value={policy[kind]}
                disabled={!canManage || saving}
                options={[
                  {
                    id: "inherit",
                    label: `Padrão do número (${GROUP_MEDIA_MODE_SHORT[numberDefault[kind]]})`,
                  },
                  { id: "all", label: GROUP_MEDIA_MODE_LABELS.all },
                  { id: "mentions", label: GROUP_MEDIA_MODE_LABELS.mentions },
                  { id: "off", label: GROUP_MEDIA_MODE_LABELS.off },
                ]}
                onChange={(value) => setPolicy((prev) => ({ ...prev, [kind]: value }))}
              />
            ))}
          </div>
        )}

        <p className="text-xs leading-relaxed text-text-muted">
          "Com a gente" = mencionam o número, respondem a uma mensagem nossa, usam
          uma palavra-chave da IA ou fomos nós que mandamos. O que não for baixado
          pode ser baixado na conversa por até 14 dias. Figurinhas nunca são
          baixadas automaticamente.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {canManage ? "Cancelar" : "Fechar"}
          </Button>
          {canManage && (
            <Button onClick={() => void handleSave()} disabled={saving || channels === undefined}>
              {saving ? <Spinner size="sm" /> : null}
              Salvar
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
