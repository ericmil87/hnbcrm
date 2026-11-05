import { useInlineCrud } from "@/hooks/useInlineCrud";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ApiKeyRevealModal } from "@/components/ui/ApiKeyRevealModal";
import { Spinner } from "@/components/ui/Spinner";
import { Select } from "@/components/ui/Select";


const EMPTY_FORM = { name: "", agentId: "", expiresAt: "" };

export function ApiKeysPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const {
    showForm: showCreateApiKey,
    form: { name: newApiKeyName, agentId: selectedAgentId, expiresAt },
    confirmDeleteId: confirmRevokeId,
    startCreate,
    cancel,
    saved,
    patchForm,
    askDelete,
    cancelDelete,
  } = useInlineCrud(EMPTY_FORM);
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);

  const apiKeys = useQuery(api.apiKeys.listApiKeysWithMembers, {
    organizationId,
  });

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, {
    organizationId,
  });

  const createApiKey = useAction(api.nodeActions.createApiKey);
  const revokeApiKey = useMutation(api.apiKeys.revokeApiKey);

  // Chave API para membro removido nasceria morta (a autenticação recusa).
  const aiAgents = teamMembers?.filter(m => m.type === "ai" && !m.removed) ?? [];

  const handleCreateApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newApiKeyName.trim()) return;

    const agentId = selectedAgentId || aiAgents[0]?._id;
    if (!agentId) {
      toast.error("Nenhum agente de IA encontrado. Crie um membro IA primeiro.");
      return;
    }

    try {
      const result = await createApiKey({
        organizationId,
        teamMemberId: agentId as Id<"teamMembers">,
        name: newApiKeyName,
        expiresAt: expiresAt ? new Date(expiresAt).getTime() : undefined,
      });

      setRevealedApiKey(result.apiKey);
      saved();
    } catch (error) {
      toast.error("Não foi possível criar a chave de integração.");
    }
  };

  const handleRevoke = async (apiKeyId: string) => {
    try {
      await revokeApiKey({
        apiKeyId: apiKeyId as Id<"apiKeys">,
        organizationId,
      });
      toast.success("Chave revogada");
      cancelDelete();
    } catch (error) {
      toast.error("Não foi possível revogar chave.");
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-text-primary">Chaves de integração</h3>
        <Button onClick={() => startCreate()}>
          Criar chave
        </Button>
      </div>

      {!apiKeys && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {apiKeys && apiKeys.length > 0 ? (
        <div className="space-y-3">
          {apiKeys.map((key: any) => (
            <div key={key._id} className="flex items-center justify-between p-3 bg-surface-sunken rounded-lg gap-3">
              <div className="min-w-0 flex-1">
                <h4 className="font-medium text-text-primary">{key.name}</h4>
                <p className="text-sm text-text-secondary">
                  {key.teamMemberName && <span className="text-text-muted">{key.teamMemberName} &bull; </span>}
                  Criada em {new Date(key.createdAt).toLocaleDateString("pt-BR")}
                  {key.lastUsed && ` \u2022 Último uso ${new Date(key.lastUsed).toLocaleDateString("pt-BR")}`}
                  {key.expiresAt && ` \u2022 Expira ${new Date(key.expiresAt).toLocaleDateString("pt-BR")}`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={key.isActive ? "success" : "default"}>
                  {key.isActive ? "Ativa" : "Revogada"}
                </Badge>
                {key.isActive && (
                  <button
                    onClick={() => askDelete(key._id)}
                    className="text-sm text-semantic-error hover:text-semantic-error/80"
                  >
                    Revogar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : apiKeys ? (
        <p className="text-text-secondary">Nenhuma chave de integração criada.</p>
      ) : null}

      <ConfirmDialog
        open={!!confirmRevokeId}
        onClose={() => cancelDelete()}
        onConfirm={() => {
          if (confirmRevokeId) handleRevoke(confirmRevokeId);
        }}
        title="Revogar chave de integração"
        description="Tem certeza que deseja revogar esta chave? Todas as integrações que a utilizam pararão de funcionar imediatamente."
        confirmLabel="Revogar"
        variant="danger"
      />

      <Modal
        open={showCreateApiKey}
        onClose={() => cancel()}
        title="Criar chave de integração"
      >
        <form onSubmit={handleCreateApiKey} className="space-y-4">
          <Input
            label="Nome da chave"
            type="text"
            value={newApiKeyName}
            onChange={(e) => patchForm({ name: e.target.value })}
            placeholder="ex: Chave de Produção"
            required
          />
          {aiAgents.length > 1 && (
            <div>
              <Select
                label="Agente de IA"
                value={selectedAgentId}
                onValueChange={(agentId) => patchForm({ agentId })}
                options={aiAgents.map((agent) => ({ value: agent._id, label: agent.name }))}
              />
            </div>
          )}
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Expiração (opcional)
            </label>
            <input
              type="date"
              value={expiresAt}
              onChange={(e) => patchForm({ expiresAt: e.target.value })}
              min={new Date().toISOString().split("T")[0]}
              className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              style={{ fontSize: "16px" }}
            />
          </div>
          {aiAgents.length === 0 && (
            <p className="text-sm text-semantic-warning">
              Nenhum agente de IA encontrado. Crie um membro IA na página de Equipe primeiro.
            </p>
          )}
          <div className="flex gap-2 pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => cancel()}
              className="flex-1"
            >
              Cancelar
            </Button>
            <Button type="submit" className="flex-1" disabled={aiAgents.length === 0}>
              Criar chave
            </Button>
          </div>
        </form>
      </Modal>

      {revealedApiKey && (
        <ApiKeyRevealModal
          open={!!revealedApiKey}
          onClose={() => setRevealedApiKey(null)}
          apiKey={revealedApiKey}
        />
      )}
    </Card>
  );
}

