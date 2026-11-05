import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import { Select } from "@/components/ui/Select";
import { Tabs, TabPanel } from "@/components/ui/Tabs";


export function CustomFieldsPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", key: "", type: "text" as string, options: "", isRequired: false });
  const [entityTab, setEntityTab] = useState<"lead" | "contact">("lead");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fieldDefs = useQuery(api.fieldDefinitions.getFieldDefinitions, {
    organizationId,
    entityType: entityTab,
  });
  const createField = useMutation(api.fieldDefinitions.createFieldDefinition);
  const updateField = useMutation(api.fieldDefinitions.updateFieldDefinition);
  const deleteField = useMutation(api.fieldDefinitions.deleteFieldDefinition);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const options = form.options ? form.options.split(",").map(s => s.trim()).filter(Boolean) : undefined;
      if (editingId) {
        await updateField({
          fieldDefinitionId: editingId as Id<"fieldDefinitions">,
          name: form.name,
          type: form.type as any,
          options,
          isRequired: form.isRequired,
        });
      } else {
        await createField({
          organizationId,
          name: form.name,
          key: form.key,
          type: form.type as any,
          entityType: entityTab,
          options,
          isRequired: form.isRequired,
          order: fieldDefs?.length || 0,
        });
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ name: "", key: "", type: "text", options: "", isRequired: false });
    } catch (error) {
      console.error("Failed to save field definition:", error);
    }
  };

  const handleEdit = (field: any) => {
    setEditingId(field._id);
    setForm({
      name: field.name,
      key: field.key,
      type: field.type,
      options: field.options?.join(", ") || "",
      isRequired: field.isRequired,
    });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteField({ fieldDefinitionId: id as Id<"fieldDefinitions"> });
    } catch (error) {
      console.error("Failed to delete:", error);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-text-primary">Campos personalizados</h3>
        <Button
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: "", key: "", type: "text", options: "", isRequired: false }); }}
        >
          Adicionar campo
        </Button>
      </div>

      <Tabs
        value={entityTab}
        onValueChange={(v) => setEntityTab(v as "lead" | "contact")}
        items={[
          { id: "lead", label: "Leads" },
          { id: "contact", label: "Contatos" },
        ]}
        ariaLabel="Tipo de entidade dos campos"
        variant="pills"
        idPrefix="custom-fields"
        className="mb-4"
      />

      <TabPanel id={entityTab} idPrefix="custom-fields">
      {!fieldDefs && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {fieldDefs && fieldDefs.length > 0 ? (
        <div className="space-y-2">
          {fieldDefs.map((field) => (
            <div key={field._id} className="flex items-center justify-between p-3 bg-surface-sunken rounded-lg">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-text-primary">{field.name}</span>
                <span className="text-sm text-text-muted">({field.key})</span>
                <Badge variant="info">{field.type}</Badge>
                {field.entityType && (
                  <Badge variant="brand">{field.entityType === "lead" ? "Lead" : "Contato"}</Badge>
                )}
                {field.isRequired && <Badge variant="error">Obrigatório</Badge>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleEdit(field)} className="text-sm text-brand-500 hover:text-brand-400">Editar</button>
                <button onClick={() => setConfirmDeleteId(field._id)} className="text-sm text-semantic-error hover:text-semantic-error/80">Excluir</button>
              </div>
            </div>
          ))}
        </div>
      ) : fieldDefs ? (
        <p className="text-text-secondary">Nenhum campo personalizado definido.</p>
      ) : null}
      </TabPanel>

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) handleDelete(confirmDeleteId);
        }}
        title="Excluir campo personalizado"
        description="Tem certeza que deseja excluir este campo personalizado? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />

      <Modal
        open={showForm}
        onClose={() => { setShowForm(false); setEditingId(null); }}
        title={editingId ? "Editar campo personalizado" : "Adicionar campo personalizado"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Nome"
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          {!editingId && (
            <Input
              label="Chave"
              type="text"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder="unique_key"
              required
            />
          )}
          <div>
            <Select
            label="Tipo"
            value={form.type}
            onValueChange={(type) => setForm({ ...form, type })}
            options={[
              { value: "text", label: "Texto" },
              { value: "number", label: "Número" },
              { value: "boolean", label: "Sim ou não" },
              { value: "date", label: "Data" },
              { value: "select", label: "Lista de opções" },
              { value: "multiselect", label: "Lista de várias opções" },
            ]}
          />
          </div>
          {(form.type === "select" || form.type === "multiselect") && (
            <Input
              label="Opções (separadas por vírgula)"
              type="text"
              value={form.options}
              onChange={(e) => setForm({ ...form, options: e.target.value })}
              placeholder="Opção 1, Opção 2, Opção 3"
            />
          )}
          <Checkbox
            checked={form.isRequired}
            onChange={(e) => setForm({ ...form, isRequired: e.target.checked })}
            label="Obrigatório"
          />
          <div className="flex gap-2 pt-4">
            <Button type="button" variant="secondary" onClick={() => { setShowForm(false); setEditingId(null); }} className="flex-1">Cancelar</Button>
            <Button type="submit" className="flex-1">Salvar</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

