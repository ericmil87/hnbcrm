import React, { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

interface SettingsProps {
  organizationId: string;
}

type SettingsSection = "general" | "apikeys" | "fields" | "sources" | "webhooks";

export function Settings({ organizationId }: SettingsProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");

  const sections = [
    { id: "general", name: "General" },
    { id: "apikeys", name: "API Keys" },
    { id: "fields", name: "Custom Fields" },
    { id: "sources", name: "Lead Sources" },
    { id: "webhooks", name: "Webhooks" },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900">Settings</h2>

      {/* Section tabs */}
      <div className="flex gap-2 border-b pb-2">
        {sections.map((section) => (
          <button
            key={section.id}
            onClick={() => setActiveSection(section.id as SettingsSection)}
            className={`px-4 py-2 rounded-t-lg text-sm font-medium ${
              activeSection === section.id
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
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
function OrgProfileSection({ organizationId }: { organizationId: string }) {
  const orgs = useQuery(api.organizations.getUserOrganizations);
  const updateOrganization = useMutation(api.organizations.updateOrganization);
  const org = orgs?.find((o: any) => o?._id === organizationId);

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [currency, setCurrency] = useState("");
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (org) {
      setName(org.name || "");
      setTimezone(org.settings?.timezone || "UTC");
      setCurrency(org.settings?.currency || "USD");
    }
  }, [org]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateOrganization({
        organizationId: organizationId as Id<"organizations">,
        name,
        settings: {
          timezone,
          currency,
          aiConfig: org?.settings?.aiConfig,
        },
      });
    } catch (error) {
      console.error("Failed to update organization:", error);
    }
    setSaving(false);
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Organization Profile</h3>
      <div className="space-y-4 max-w-md">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Organization Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="UTC">UTC</option>
            <option value="America/New_York">Eastern Time</option>
            <option value="America/Chicago">Central Time</option>
            <option value="America/Denver">Mountain Time</option>
            <option value="America/Los_Angeles">Pacific Time</option>
            <option value="Europe/London">London</option>
            <option value="Europe/Berlin">Berlin</option>
            <option value="Asia/Tokyo">Tokyo</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="USD">USD ($)</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="CAD">CAD</option>
            <option value="AUD">AUD</option>
          </select>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
}

// --- API Keys Section ---
function ApiKeysSection({ organizationId }: { organizationId: string }) {
  const [showCreateApiKey, setShowCreateApiKey] = useState(false);
  const [newApiKeyName, setNewApiKeyName] = useState("");

  const apiKeys = useQuery(api.apiKeys.getApiKeys, {
    organizationId: organizationId as Id<"organizations">,
  });

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, {
    organizationId: organizationId as Id<"organizations">,
  });

  const createApiKey = useMutation(api.apiKeys.createApiKey);

  const handleCreateApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newApiKeyName.trim()) return;

    try {
      const aiAgent = teamMembers?.find(m => m.type === "ai");
      if (!aiAgent) {
        alert("No AI agent found. Please create an AI team member first.");
        return;
      }

      const result = await createApiKey({
        organizationId: organizationId as Id<"organizations">,
        teamMemberId: aiAgent._id,
        name: newApiKeyName,
      });

      alert(`API Key created: ${result.apiKey}\n\nPlease save this key securely. You won't be able to see it again.`);
      setNewApiKeyName("");
      setShowCreateApiKey(false);
    } catch (error) {
      console.error("Failed to create API key:", error);
      alert("Failed to create API key");
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">API Keys</h3>
        <button
          onClick={() => setShowCreateApiKey(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Create API Key
        </button>
      </div>

      {apiKeys && apiKeys.length > 0 ? (
        <div className="space-y-3">
          {apiKeys.map((key) => (
            <div key={key._id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <h4 className="font-medium text-gray-900">{key.name}</h4>
                <p className="text-sm text-gray-600">
                  Created {new Date(key.createdAt).toLocaleDateString()}
                  {key.lastUsed && ` - Last used ${new Date(key.lastUsed).toLocaleDateString()}`}
                </p>
              </div>
              <span className={`px-2 py-1 rounded-full text-xs ${
                key.isActive ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"
              }`}>
                {key.isActive ? "Active" : "Inactive"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-gray-600">No API keys created yet.</p>
      )}

      {showCreateApiKey && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">Create API Key</h3>
            <form onSubmit={handleCreateApiKey} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Key Name</label>
                <input
                  type="text"
                  value={newApiKeyName}
                  onChange={(e) => setNewApiKeyName(e.target.value)}
                  placeholder="e.g., Production API Key"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div className="flex gap-2 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateApiKey(false)}
                  className="flex-1 px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Create Key
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Custom Fields Section ---
function CustomFieldsSection({ organizationId }: { organizationId: string }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", key: "", type: "text" as string, options: "", isRequired: false });

  const fieldDefs = useQuery(api.fieldDefinitions.getFieldDefinitions, {
    organizationId: organizationId as Id<"organizations">,
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
          organizationId: organizationId as Id<"organizations">,
          name: form.name,
          key: form.key,
          type: form.type as any,
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
    if (!confirm("Delete this custom field definition?")) return;
    try {
      await deleteField({ fieldDefinitionId: id as Id<"fieldDefinitions"> });
    } catch (error) {
      console.error("Failed to delete:", error);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Custom Fields</h3>
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: "", key: "", type: "text", options: "", isRequired: false }); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Add Field
        </button>
      </div>

      {fieldDefs && fieldDefs.length > 0 ? (
        <div className="space-y-2">
          {fieldDefs.map((field) => (
            <div key={field._id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <span className="font-medium text-gray-900">{field.name}</span>
                <span className="ml-2 text-sm text-gray-500">({field.key})</span>
                <span className="ml-2 px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-800">{field.type}</span>
                {field.isRequired && <span className="ml-2 px-2 py-0.5 rounded text-xs bg-red-100 text-red-800">Required</span>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleEdit(field)} className="text-sm text-blue-600 hover:underline">Edit</button>
                <button onClick={() => handleDelete(field._id)} className="text-sm text-red-600 hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-gray-600">No custom fields defined yet.</p>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">{editingId ? "Edit" : "Add"} Custom Field</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" required />
              </div>
              {!editingId && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Key</label>
                  <input type="text" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="unique_key" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" required />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                  <option value="date">Date</option>
                  <option value="select">Select</option>
                  <option value="multiselect">Multi-select</option>
                </select>
              </div>
              {(form.type === "select" || form.type === "multiselect") && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Options (comma-separated)</label>
                  <input type="text" value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} placeholder="Option 1, Option 2, Option 3" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.isRequired} onChange={(e) => setForm({ ...form, isRequired: e.target.checked })} />
                <span className="text-sm text-gray-700">Required</span>
              </label>
              <div className="flex gap-2 pt-4">
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className="flex-1 px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Lead Sources Section ---
function LeadSourcesSection({ organizationId }: { organizationId: string }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", type: "website" as string });

  const sources = useQuery(api.leadSources.getLeadSources, {
    organizationId: organizationId as Id<"organizations">,
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
          organizationId: organizationId as Id<"organizations">,
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
    if (!confirm("Delete this lead source?")) return;
    try {
      await deleteSource({ leadSourceId: id as Id<"leadSources"> });
    } catch (error) {
      console.error("Failed to delete:", error);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Lead Sources</h3>
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: "", type: "website" }); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Add Source
        </button>
      </div>

      {sources && sources.length > 0 ? (
        <div className="space-y-2">
          {sources.map((source) => (
            <div key={source._id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900">{source.name}</span>
                <span className="px-2 py-0.5 rounded text-xs bg-purple-100 text-purple-800">{source.type}</span>
                <span className={`px-2 py-0.5 rounded text-xs ${source.isActive ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}`}>
                  {source.isActive ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => handleEdit(source)} className="text-sm text-blue-600 hover:underline">Edit</button>
                <button onClick={() => handleDelete(source._id)} className="text-sm text-red-600 hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-gray-600">No lead sources configured.</p>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">{editingId ? "Edit" : "Add"} Lead Source</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
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
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className="flex-1 px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Webhooks Section ---
function WebhooksSection({ organizationId }: { organizationId: string }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", url: "", events: "", secret: "" });

  const webhooks = useQuery(api.webhooks.getWebhooks, {
    organizationId: organizationId as Id<"organizations">,
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
          organizationId: organizationId as Id<"organizations">,
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
    if (!confirm("Delete this webhook?")) return;
    try {
      await deleteWebhook({ webhookId: id as Id<"webhooks"> });
    } catch (error) {
      console.error("Failed to delete:", error);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Webhooks</h3>
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: "", url: "", events: "", secret: "" }); }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Add Webhook
        </button>
      </div>

      {webhooks && webhooks.length > 0 ? (
        <div className="space-y-2">
          {webhooks.map((webhook) => (
            <div key={webhook._id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div>
                <span className="font-medium text-gray-900">{webhook.name}</span>
                <p className="text-sm text-gray-600">{webhook.url}</p>
                <div className="flex gap-1 mt-1">
                  {webhook.events.map((event, i) => (
                    <span key={i} className="px-2 py-0.5 rounded text-xs bg-gray-200 text-gray-700">{event}</span>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-1 rounded-full text-xs ${webhook.isActive ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}`}>
                  {webhook.isActive ? "Active" : "Inactive"}
                </span>
                <button onClick={() => handleEdit(webhook)} className="text-sm text-blue-600 hover:underline">Edit</button>
                <button onClick={() => handleDelete(webhook._id)} className="text-sm text-red-600 hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-gray-600">No webhooks configured.</p>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-4">{editingId ? "Edit" : "Add"} Webhook</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">URL</label>
                <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/webhook" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Events (comma-separated)</label>
                <input type="text" value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} placeholder="lead.created, lead.stage_changed, message.sent" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" required />
              </div>
              {!editingId && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Secret (auto-generated if empty)</label>
                  <input type="text" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="Auto-generated" className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
              <div className="flex gap-2 pt-4">
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className="flex-1 px-4 py-2 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
