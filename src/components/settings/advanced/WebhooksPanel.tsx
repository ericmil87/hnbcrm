import { useInlineCrud } from "@/hooks/useInlineCrud";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";


const EMPTY_FORM = { name: "", url: "", events: "", secret: "" };

export function WebhooksPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const { showForm, editingId, form, startCreate, startEdit, cancel, saved, patchForm, askDelete, cancelDelete, confirmDeleteId } =
    useInlineCrud(EMPTY_FORM);

  const webhooks = useQuery(api.webhooks.getWebhooks, {
    organizationId,
  });
  const createWebhook = useMutation(api.webhooks.createWebhook);
  const updateWebhook = useMutation(api.webhooks.updateWebhook);
  const deleteWebhook = useMutation(api.webhooks.deleteWebhook);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const events = form.events.split(",").map(s => s.trim()).filter(Boolean);
      if (editingId) {
        await updateWebhook({
          webhookId: editingId as Id<"webhooks">,
          name: form.name,
          url: form.url,
          events,
        });
      } else {
        await createWebhook({
          organizationId,
          name: form.name,
          url: form.url,
          events,
          secret: form.secret || `whsec_${Math.random().toString(36).substring(2, 15)}`,
        });
      }
      saved();
    } catch (error) {
      console.error("Failed to save webhook:", error);
    }
  };

  const handleEdit = (webhook: any) => {
    startEdit(webhook._id, { name: webhook.name, url: webhook.url, events: webhook.events.join(", "), secret: "" });
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteWebhook({ webhookId: id as Id<"webhooks"> });
    } catch (error) {
      console.error("Failed to delete:", error);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-text-primary">Webhooks</h3>
        <Button
          onClick={() => startCreate()}
        >
          Adicionar Webhook
        </Button>
      </div>

      {!webhooks && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {webhooks && webhooks.length > 0 ? (
        <div className="space-y-2">
          {webhooks.map((webhook) => (
            <div key={webhook._id} className="p-3 bg-surface-sunken rounded-lg">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-text-primary">{webhook.name}</span>
                  <p className="text-sm text-text-secondary truncate">{webhook.url}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                  <Badge variant={webhook.isActive ? "success" : "default"}>
                    {webhook.isActive ? "Ativo" : "Inativo"}
                  </Badge>
                  <button onClick={() => handleEdit(webhook)} className="text-sm text-brand-500 hover:text-brand-400">Editar</button>
                  <button onClick={() => askDelete(webhook._id)} className="text-sm text-semantic-error hover:text-semantic-error/80">Excluir</button>
                </div>
              </div>
              <div className="flex gap-1 flex-wrap">
                {webhook.events.map((event, i) => (
                  <Badge key={i} variant="default">{event}</Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : webhooks ? (
        <p className="text-text-secondary">Nenhum webhook configurado.</p>
      ) : null}

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={cancelDelete}
        onConfirm={() => {
          if (confirmDeleteId) handleDelete(confirmDeleteId);
        }}
        title="Excluir Webhook"
        description="Tem certeza que deseja excluir este webhook? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />

      <Modal
        open={showForm}
        onClose={() => cancel()}
        title={editingId ? "Editar Webhook" : "Adicionar Webhook"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Nome"
            type="text"
            value={form.name}
            onChange={(e) => patchForm({ name: e.target.value })}
            required
          />
          <Input
            label="URL"
            type="url"
            value={form.url}
            onChange={(e) => patchForm({ url: e.target.value })}
            placeholder="https://exemplo.com/webhook"
            required
          />
          <Input
            label="Eventos (separados por vírgula)"
            type="text"
            value={form.events}
            onChange={(e) => patchForm({ events: e.target.value })}
            placeholder="lead.created, lead.stage_changed, message.sent"
            required
          />
          {!editingId && (
            <Input
              label="Segredo (gerado automaticamente se vazio)"
              type="text"
              value={form.secret}
              onChange={(e) => patchForm({ secret: e.target.value })}
              placeholder="Auto-gerado"
            />
          )}
          <div className="flex gap-2 pt-4">
            <Button type="button" variant="secondary" onClick={() => cancel()} className="flex-1">Cancelar</Button>
            <Button type="submit" className="flex-1">Salvar</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}
