import { useState } from "react";
import { useOutletContext } from "react-router";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ApiKeyRevealModal } from "@/components/ui/ApiKeyRevealModal";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";

type SettingsSection = "general" | "apikeys" | "fields" | "sources" | "webhooks";

export function Settings() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");

  const sections = [
    { id: "general", name: "Geral" },
    { id: "apikeys", name: "Chaves API" },
    { id: "fields", name: "Campos Personalizados" },
    { id: "sources", name: "Fontes de Leads" },
    { id: "webhooks", name: "Webhooks" },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-text-primary">Configurações</h2>

      {/* Section tabs */}
      <div className="flex gap-2 flex-wrap">
        {sections.map((section) => (
          <button
            key={section.id}
            onClick={() => setActiveSection(section.id as SettingsSection)}
            className={cn(
              "px-4 py-2 rounded-full text-sm font-medium transition-colors",
              activeSection === section.id
                ? "bg-brand-600 text-white"
                : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
            )}
          >
            {section.name}
          </button>
        ))}
      </div>

      {activeSection === "general" && <OrgProfileSection organizationId={organizationId} />}
      {activeSection === "apikeys" && <ApiKeysSection organizationId={organizationId} />}
      {activeSection === "fields" && <CustomFieldsSection organizationId={organizationId} />}
      {activeSection === "sources" && <LeadSourcesSection organizationId={organizationId} />}
      {activeSection === "webhooks" && <WebhooksSection organizationId={organizationId} />}
    </div>
  );
}

// --- General / Org Profile Section ---
function OrgProfileSection({ organizationId }: { organizationId: Id<"organizations"> }) {
  const orgs = useQuery(api.organizations.getUserOrganizations);
  const updateOrganization = useMutation(api.organizations.updateOrganization);
  const org = orgs?.find((o) => o?._id === organizationId);

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [currency, setCurrency] = useState("");
  const [saving, setSaving] = useState(false);

  useState(() => {
    if (org) {
      setName(org.name || "");
      setTimezone(org.settings?.timezone || "UTC");
      setCurrency(org.settings?.currency || "USD");
    }
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateOrganization({
        organizationId,
        name,
        settings: {
          timezone,
          currency,
          aiConfig: org?.settings?.aiConfig,
        },
      });
      toast.success("Organização atualizada com sucesso");
    } catch (error) {
      toast.error("Falha ao atualizar organização");
    }
    setSaving(false);
  };

  return (
    <Card>
      <h3 className="text-lg font-semibold text-text-primary mb-4">Perfil da Organização</h3>
      <div className="space-y-4 max-w-md">
        <Input
          label="Nome da Organização"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Fuso Horário
          </label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          >
            <option value="UTC">UTC</option>
            <option value="America/New_York">Eastern Time</option>
            <option value="America/Chicago">Central Time</option>
            <option value="America/Denver">Mountain Time</option>
            <option value="America/Los_Angeles">Pacific Time</option>
            <option value="America/Sao_Paulo">São Paulo</option>
            <option value="Europe/London">London</option>
            <option value="Europe/Berlin">Berlin</option>
            <option value="Asia/Tokyo">Tokyo</option>
          </select>
        </div>

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Moeda
          </label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
          >
            <option value="USD">USD ($)</option>
            <option value="BRL">BRL (R$)</option>
            <option value="EUR">EUR (€)</option>
            <option value="GBP">GBP (£)</option>
            <option value="CAD">CAD</option>
            <option value="AUD">AUD</option>
          </select>
        </div>

        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Salvando..." : "Salvar"}
        </Button>
      </div>
    </Card>
  );
}

// --- API Keys Section ---
function ApiKeysSection({ organizationId }: { organizationId: Id<"organizations"> }) {
  const [showCreateApiKey, setShowCreateApiKey] = useState(false);
  const [newApiKeyName, setNewApiKeyName] = useState("");
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);

  const apiKeys = useQuery(api.apiKeys.getApiKeys, {
    organizationId,
  });

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, {
    organizationId,
  });

  const createApiKey = useAction(api.nodeActions.createApiKey);

  const handleCreateApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newApiKeyName.trim()) return;

    try {
      const aiAgent = teamMembers?.find(m => m.type === "ai");
      if (!aiAgent) {
        toast.error("Nenhum agente IA encontrado. Crie um membro IA primeiro.");
        return;
      }

      const result = await createApiKey({
        organizationId,
        teamMemberId: aiAgent._id,
        name: newApiKeyName,
      });

      setRevealedApiKey(result.apiKey);
      setNewApiKeyName("");
      setShowCreateApiKey(false);
    } catch (error) {
      toast.error("Falha ao criar chave API");
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-text-primary">Chaves API</h3>
        <Button onClick={() => setShowCreateApiKey(true)}>
          Criar Chave
        </Button>
      </div>

      {!apiKeys && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {apiKeys && apiKeys.length > 0 ? (
        <div className="space-y-3">
          {apiKeys.map((key) => (
            <div key={key._id} className="flex items-center justify-between p-3 bg-surface-sunken rounded-lg">
              <div>
                <h4 className="font-medium text-text-primary">{key.name}</h4>
                <p className="text-sm text-text-secondary">
                  Criada em {new Date(key.createdAt).toLocaleDateString("pt-BR")}
                  {key.lastUsed && ` • Último uso ${new Date(key.lastUsed).toLocaleDateString("pt-BR")}`}
                </p>
              </div>
              <Badge variant={key.isActive ? "success" : "default"}>
                {key.isActive ? "Ativa" : "Inativa"}
              </Badge>
            </div>
          ))}
        </div>
      ) : apiKeys ? (
        <p className="text-text-secondary">Nenhuma chave API criada.</p>
      ) : null}

      <Modal
        open={showCreateApiKey}
        onClose={() => setShowCreateApiKey(false)}
        title="Criar Chave API"
      >
        <form onSubmit={handleCreateApiKey} className="space-y-4">
          <Input
            label="Nome da Chave"
            type="text"
            value={newApiKeyName}
            onChange={(e) => setNewApiKeyName(e.target.value)}
            placeholder="ex: Chave de Produção"
            required
          />
          <div className="flex gap-2 pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setShowCreateApiKey(false)}
              className="flex-1"
            >
              Cancelar
            </Button>
            <Button type="submit" className="flex-1">
              Criar Chave
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

// --- Custom Fields Section ---
function CustomFieldsSection({ organizationId }: { organizationId: Id<"organizations"> }) {
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
        <h3 className="text-lg font-semibold text-text-primary">Campos Personalizados</h3>
        <Button
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: "", key: "", type: "text", options: "", isRequired: false }); }}
        >
          Adicionar Campo
        </Button>
      </div>

      {/* Entity type toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setEntityTab("lead")}
          className={cn(
            "px-4 py-2 rounded-full text-sm font-medium transition-colors",
            entityTab === "lead"
              ? "bg-brand-600 text-white"
              : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
          )}
        >
          Leads
        </button>
        <button
          onClick={() => setEntityTab("contact")}
          className={cn(
            "px-4 py-2 rounded-full text-sm font-medium transition-colors",
            entityTab === "contact"
              ? "bg-brand-600 text-white"
              : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
          )}
        >
          Contatos
        </button>
      </div>

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

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) handleDelete(confirmDeleteId);
        }}
        title="Excluir Campo Personalizado"
        description="Tem certeza que deseja excluir este campo personalizado? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />

      <Modal
        open={showForm}
        onClose={() => { setShowForm(false); setEditingId(null); }}
        title={editingId ? "Editar Campo Personalizado" : "Adicionar Campo Personalizado"}
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
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Tipo</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-base md:text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20">
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="date">Date</option>
              <option value="select">Select</option>
              <option value="multiselect">Multi-select</option>
            </select>
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
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.isRequired} onChange={(e) => setForm({ ...form, isRequired: e.target.checked })} className="rounded border-border-strong bg-surface-raised text-brand-600 focus:ring-brand-500" />
            <span className="text-sm text-text-secondary">Obrigatório</span>
          </label>
          <div className="flex gap-2 pt-4">
            <Button type="button" variant="secondary" onClick={() => { setShowForm(false); setEditingId(null); }} className="flex-1">Cancelar</Button>
            <Button type="submit" className="flex-1">Salvar</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

// --- Lead Sources Section ---
function LeadSourcesSection({ organizationId }: { organizationId: Id<"organizations"> }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", type: "website" as string });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
      setShowForm(false);
      setEditingId(null);
      setForm({ name: "", type: "website" });
    } catch (error) {
      console.error("Failed to save lead source:", error);
    }
  };

  const handleEdit = (source: any) => {
    setEditingId(source._id);
    setForm({ name: source.name, type: source.type });
    setShowForm(true);
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
        <h3 className="text-lg font-semibold text-text-primary">Fontes de Leads</h3>
        <Button
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: "", type: "website" }); }}
        >
          Adicionar Fonte
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
                <button onClick={() => setConfirmDeleteId(source._id)} className="text-sm text-semantic-error hover:text-semantic-error/80">Excluir</button>
              </div>
            </div>
          ))}
        </div>
      ) : sources ? (
        <p className="text-text-secondary">Nenhuma fonte de leads configurada.</p>
      ) : null}

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) handleDelete(confirmDeleteId);
        }}
        title="Excluir Fonte de Leads"
        description="Tem certeza que deseja excluir esta fonte de leads? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />

      <Modal
        open={showForm}
        onClose={() => { setShowForm(false); setEditingId(null); }}
        title={editingId ? "Editar Fonte de Leads" : "Adicionar Fonte de Leads"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Nome"
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Tipo</label>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-base md:text-sm focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20">
              <option value="website">Website</option>
              <option value="social">Social</option>
              <option value="email">Email</option>
              <option value="phone">Phone</option>
              <option value="referral">Referral</option>
              <option value="api">API</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="flex gap-2 pt-4">
            <Button type="button" variant="secondary" onClick={() => { setShowForm(false); setEditingId(null); }} className="flex-1">Cancelar</Button>
            <Button type="submit" className="flex-1">Salvar</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

// --- Webhooks Section ---
function WebhooksSection({ organizationId }: { organizationId: Id<"organizations"> }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", url: "", events: "", secret: "" });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
      setShowForm(false);
      setEditingId(null);
      setForm({ name: "", url: "", events: "", secret: "" });
    } catch (error) {
      console.error("Failed to save webhook:", error);
    }
  };

  const handleEdit = (webhook: any) => {
    setEditingId(webhook._id);
    setForm({ name: webhook.name, url: webhook.url, events: webhook.events.join(", "), secret: "" });
    setShowForm(true);
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
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: "", url: "", events: "", secret: "" }); }}
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
                  <button onClick={() => setConfirmDeleteId(webhook._id)} className="text-sm text-semantic-error hover:text-semantic-error/80">Excluir</button>
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
        onClose={() => setConfirmDeleteId(null)}
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
        onClose={() => { setShowForm(false); setEditingId(null); }}
        title={editingId ? "Editar Webhook" : "Adicionar Webhook"}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Nome"
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <Input
            label="URL"
            type="url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://exemplo.com/webhook"
            required
          />
          <Input
            label="Eventos (separados por vírgula)"
            type="text"
            value={form.events}
            onChange={(e) => setForm({ ...form, events: e.target.value })}
            placeholder="lead.created, lead.stage_changed, message.sent"
            required
          />
          {!editingId && (
            <Input
              label="Segredo (gerado automaticamente se vazio)"
              type="text"
              value={form.secret}
              onChange={(e) => setForm({ ...form, secret: e.target.value })}
              placeholder="Auto-gerado"
            />
          )}
          <div className="flex gap-2 pt-4">
            <Button type="button" variant="secondary" onClick={() => { setShowForm(false); setEditingId(null); }} className="flex-1">Cancelar</Button>
            <Button type="submit" className="flex-1">Salvar</Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}
