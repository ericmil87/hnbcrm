import { useInlineCrud } from "@/hooks/useInlineCrud";
import { VOCAB } from "@/lib/vocab";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import { Select } from "@/components/ui/Select";


const EMPTY_FORM = { name: "", type: "website" as string };

export function LeadSourcesPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const { showForm, editingId, form, startCreate, startEdit, cancel, saved, patchForm, askDelete, cancelDelete, confirmDeleteId } =
    useInlineCrud(EMPTY_FORM);

  const sources = useQuery(api.leadSources.getLeadSources, {
    organizationId,
  });
  const createSource = useMutation(api.leadSources.createLeadSource);
  const updateSource = useMutation(api.leadSources.updateLeadSource);
  const deleteSource = useMutation(api.leadSources.deleteLeadSource);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await updateSource({
          leadSourceId: editingId as Id<"leadSources">,
          name: form.name,
          type: form.type as any,
        });
      } else {
        await createSource({
          organizationId,
          name: form.name,
          type: form.type as any,
        });
      }
      saved();
    } catch (error) {
      console.error("Failed to save lead source:", error);
    }
  };

  const handleEdit = (source: any) => {
    startEdit(source._id, { name: source.name, type: source.type });
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteSource({ leadSourceId: id as Id<"leadSources"> });
    } catch (error) {
      console.error("Failed to delete:", error);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-text-primary">{VOCAB.origin.leadSources}</h3>
        <Button
          onClick={() => startCreate()}
        >
          Adicionar origem
        </Button>
      </div>

      {!sources && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {sources && sources.length > 0 ? (
        <div className="space-y-2">
          {sources.map((source) => (
            <div key={source._id} className="flex items-center justify-between p-3 bg-surface-sunken rounded-lg">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-text-primary">{source.name}</span>
                <Badge variant="brand">{source.type}</Badge>
                <Badge variant={source.isActive ? "success" : "default"}>
                  {source.isActive ? "Ativa" : "Inativa"}
                </Badge>
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleEdit(source)} className="text-sm text-brand-500 hover:text-brand-400">Editar</button>
                <button onClick={() => askDelete(source._id)} className="text-sm text-semantic-error hover:text-semantic-error/80">Excluir</button>
              </div>
            </div>
          ))}
        </div>
      ) : sources ? (
        <p className="text-text-secondary">Nenhuma origem de lead configurada.</p>
      ) : null}

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={cancelDelete}
        onConfirm={() => {
          if (confirmDeleteId) handleDelete(confirmDeleteId);
        }}
        title="Excluir origem do lead"
        description="Tem certeza que deseja excluir esta origem do lead? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />

      <Modal
        open={showForm}
        onClose={() => cancel()}
        title={editingId ? "Editar origem do lead" : "Adicionar origem do lead"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Nome"
            type="text"
            value={form.name}
            onChange={(e) => patchForm({ name: e.target.value })}
            required
          />
          <div>
            <Select
            label="Tipo"
            value={form.type}
            onValueChange={(type) => patchForm({ type })}
            options={[
              { value: "website", label: "Site" },
              { value: "social", label: "Redes sociais" },
              { value: "email", label: "E-mail" },
              { value: "phone", label: "Telefone" },
              { value: "referral", label: "Indicação" },
              { value: "api", label: "API" },
              { value: "other", label: "Outra" },
            ]}
          />
          </div>
          <div className="flex gap-2 pt-4">
            <Button type="button" variant="secondary" onClick={() => cancel()} className="flex-1">Cancelar</Button>
            <Button type="submit" className="flex-1">Salvar</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

