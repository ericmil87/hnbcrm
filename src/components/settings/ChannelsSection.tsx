import { useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { PermissionGate } from "@/components/guards/PermissionGate";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import {
  MessageCircle,
  Plus,
  Copy,
  Check,
  RefreshCw,
  Power,
  Trash2,
  ChevronDown,
  Dices,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Derive the public webhook callback host from the Convex deployment URL
// (client-facing ".convex.cloud" deployment maps to the HTTP action host ".convex.site")
const WEBHOOK_CALLBACK_URL = `${((import.meta.env.VITE_CONVEX_URL as string) ?? "").replace(
  ".convex.cloud",
  ".convex.site"
)}/webhooks/whatsapp`;

type ChannelConfig = {
  _id: Id<"channelConfigs">;
  channel: "whatsapp";
  displayName: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string | null;
  verifyToken: string;
  appSecretMasked: string;
  accessTokenMasked: string;
  hasToken: boolean;
  status: "active" | "disabled" | "error";
  lastHealthCheckAt: number | null;
  healthDetail: string | null;
  createdAt: number;
  updatedAt: number;
};

type ChannelFormState = {
  displayName: string;
  phoneNumberId: string;
  wabaId: string;
  verifyToken: string;
  appSecret: string;
  accessToken: string;
};

const EMPTY_FORM: ChannelFormState = {
  displayName: "",
  phoneNumberId: "",
  wabaId: "",
  verifyToken: "",
  appSecret: "",
  accessToken: "",
};

function statusBadgeVariant(status: ChannelConfig["status"]) {
  if (status === "active") return "success" as const;
  if (status === "error") return "error" as const;
  return "default" as const;
}

function statusLabel(status: ChannelConfig["status"]) {
  if (status === "active") return "Ativo";
  if (status === "error") return "Erro";
  return "Desativado";
}

async function copyToClipboard(value: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(successMessage);
  } catch {
    toast.error("Não foi possível copiar. Copie manualmente.");
  }
}

export function ChannelsSection({ organizationId }: { organizationId: Id<"organizations"> }) {
  const { can } = usePermissions(organizationId);
  const canManage = can("settings", "manage");

  const [showForm, setShowForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ChannelConfig | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<Id<"channelConfigs"> | null>(null);
  const [testingId, setTestingId] = useState<Id<"channelConfigs"> | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const configs = useQuery(api.channelConfigs.getChannelConfigs, { organizationId }) as
    | ChannelConfig[]
    | undefined;

  const createChannelConfig = useAction(api.channelConfigs.createChannelConfig);
  const updateChannelConfig = useAction(api.channelConfigs.updateChannelConfig);
  const setChannelConfigStatus = useMutation(api.channelConfigs.setChannelConfigStatus);
  const deleteChannelConfig = useMutation(api.channelConfigs.deleteChannelConfig);
  const checkChannelHealth = useAction(api.channelConfigs.checkChannelHealth);

  const openCreateForm = () => {
    setEditingConfig(null);
    setShowForm(true);
  };

  const openEditForm = (config: ChannelConfig) => {
    setEditingConfig(config);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingConfig(null);
  };

  const handleToggleStatus = (config: ChannelConfig) => {
    const nextStatus = config.status === "active" ? "disabled" : "active";
    toast.promise(setChannelConfigStatus({ configId: config._id, status: nextStatus }), {
      loading: nextStatus === "active" ? "Ativando número..." : "Desativando número...",
      success: nextStatus === "active" ? "Número ativado" : "Número desativado",
      error: "Falha ao atualizar status do número",
    });
  };

  const handleDelete = (configId: Id<"channelConfigs">) => {
    toast.promise(deleteChannelConfig({ configId }), {
      loading: "Excluindo número...",
      success: "Número desconectado",
      error: "Falha ao excluir número",
    });
    setConfirmDeleteId(null);
  };

  const handleTestConnection = async (config: ChannelConfig) => {
    setTestingId(config._id);
    try {
      const result = await checkChannelHealth({ configId: config._id });
      if (result.ok) {
        toast.success(
          `Conectado: ${result.verifiedName ?? config.displayName} (${result.displayPhoneNumber ?? config.phoneNumberId})`
        );
      } else {
        toast.error(result.error ?? "Falha ao testar conexão");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao testar conexão");
    } finally {
      setTestingId(null);
    }
  };

  const handleCopy = async (field: string, value: string, message: string) => {
    await copyToClipboard(value, message);
    setCopiedField(field);
    setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 2000);
  };

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10">
              <MessageCircle size={20} className="text-brand-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Canais</h3>
              <p className="text-sm text-text-secondary">
                Conecte números de WhatsApp via WhatsApp Cloud API para receber e enviar mensagens.
              </p>
            </div>
          </div>
          <PermissionGate organizationId={organizationId} category="settings" level="manage">
            <Button onClick={openCreateForm} size="md">
              <Plus size={18} />
              Conectar número
            </Button>
          </PermissionGate>
        </div>

        {!canManage && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3.5 py-2.5 text-sm text-text-secondary">
            <ShieldAlert size={16} className="text-text-muted shrink-0" />
            Você tem acesso somente leitura a esta seção.
          </div>
        )}

        {configs === undefined && (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        )}

        {configs && configs.length === 0 && (
          <p className="text-text-secondary py-4">Nenhum número de WhatsApp conectado ainda.</p>
        )}

        {configs && configs.length > 0 && (
          <div className="space-y-3">
            {configs.map((config) => (
              <div key={config._id} className="rounded-lg border border-border bg-surface-sunken p-3.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-text-primary">{config.displayName}</span>
                      <Badge variant={statusBadgeVariant(config.status)}>{statusLabel(config.status)}</Badge>
                    </div>
                    <p className="text-sm text-text-secondary mt-0.5 tabular-nums">
                      {config.displayPhoneNumber ?? config.phoneNumberId}
                    </p>
                    {config.healthDetail && (
                      <p
                        className={cn(
                          "text-xs mt-1",
                          config.status === "error" ? "text-semantic-error" : "text-text-muted"
                        )}
                      >
                        {config.healthDetail}
                        {config.lastHealthCheckAt && (
                          <span className="text-text-muted">
                            {" "}
                            &middot; testado em{" "}
                            {new Date(config.lastHealthCheckAt).toLocaleString("pt-BR")}
                          </span>
                        )}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    <PermissionGate organizationId={organizationId} category="settings" level="manage">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleTestConnection(config)}
                        disabled={testingId === config._id}
                      >
                        {testingId === config._id ? (
                          <Spinner size="sm" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        Testar conexão
                      </Button>
                      <button
                        onClick={() => openEditForm(config)}
                        className="text-sm text-brand-500 hover:text-brand-400 px-2 py-1.5"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => handleToggleStatus(config)}
                        aria-label={config.status === "active" ? "Desativar número" : "Ativar número"}
                        className="flex items-center justify-center h-8 w-8 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
                      >
                        <Power size={16} />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(config._id)}
                        aria-label="Excluir número"
                        className="flex items-center justify-center h-8 w-8 rounded-full text-semantic-error hover:bg-semantic-error/10 transition-colors"
                      >
                        <Trash2 size={16} />
                      </button>
                    </PermissionGate>
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-1.5 rounded-lg bg-surface-base border border-border-subtle p-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-xs text-text-muted">
                    Verify token: <span className="font-mono text-text-secondary">{config.verifyToken}</span>
                  </span>
                  <button
                    onClick={() =>
                      handleCopy(`token-${config._id}`, config.verifyToken, "Verify token copiado")
                    }
                    className="inline-flex items-center gap-1.5 text-xs text-brand-500 hover:text-brand-400 self-start sm:self-auto"
                  >
                    {copiedField === `token-${config._id}` ? <Check size={13} /> : <Copy size={13} />}
                    Copiar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Webhook configuration block */}
      <Card variant="sunken">
        <h4 className="text-sm font-semibold text-text-primary mb-1">Configuração do webhook na Meta</h4>
        <p className="text-sm text-text-secondary mb-3">
          Use esta URL de callback ao configurar o webhook do seu app no Meta for Developers, assinando o
          campo <span className="font-mono text-text-secondary">messages</span>.
        </p>
        <div className="flex flex-col gap-1.5 rounded-lg bg-surface-base border border-border-subtle p-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm font-mono text-text-primary break-all">{WEBHOOK_CALLBACK_URL}</span>
          <Button
            variant="secondary"
            size="sm"
            className="self-start sm:self-auto shrink-0"
            onClick={() => handleCopy("webhook-url", WEBHOOK_CALLBACK_URL, "URL de callback copiada")}
          >
            {copiedField === "webhook-url" ? <Check size={14} /> : <Copy size={14} />}
            Copiar URL
          </Button>
        </div>
        <p className="text-xs text-text-muted mt-2">
          O verify token de cada número está listado no card correspondente acima — copie-o ao configurar
          o webhook.
        </p>
      </Card>

      {/* Inline setup guide */}
      <Card>
        <button
          onClick={() => setGuideOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left"
          aria-expanded={guideOpen}
        >
          <h4 className="text-sm font-semibold text-text-primary">Como conectar</h4>
          <ChevronDown
            size={18}
            className={cn("text-text-muted transition-transform", guideOpen && "rotate-180")}
          />
        </button>

        {guideOpen && (
          <div className="mt-3 space-y-3">
            <ol className="space-y-2 text-sm text-text-secondary list-decimal list-inside">
              <li>Crie um app na Meta for Developers do tipo Business.</li>
              <li>Adicione o produto WhatsApp e anote o Phone Number ID e o WABA ID.</li>
              <li>Crie um System User no Business Manager e gere um token de acesso permanente.</li>
              <li>Copie o App Secret nas configurações do app.</li>
              <li>
                Configure o webhook com a URL de callback e o verify token acima, assinando o campo{" "}
                <span className="font-mono">messages</span>.
              </li>
              <li>Teste a conexão pelo botão "Testar conexão" de cada número.</li>
            </ol>
            <p className="text-xs text-text-muted">
              Guia completo disponível em <span className="font-mono">docs/WHATSAPP-SETUP.md</span> no
              repositório.
            </p>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) handleDelete(confirmDeleteId);
        }}
        title="Desconectar número"
        description="Tem certeza que deseja desconectar este número de WhatsApp? Conversas em andamento pararão de receber mensagens e esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
      />

      {showForm && (
        <ChannelFormModal
          organizationId={organizationId}
          config={editingConfig}
          onClose={closeForm}
          createChannelConfig={createChannelConfig}
          updateChannelConfig={updateChannelConfig}
        />
      )}
    </div>
  );
}

type CreateChannelConfigFn = (args: {
  organizationId: Id<"organizations">;
  channel: "whatsapp";
  displayName: string;
  phoneNumberId: string;
  wabaId: string;
  verifyToken: string;
  appSecret: string;
  accessToken: string;
}) => Promise<Id<"channelConfigs">>;

type UpdateChannelConfigFn = (args: {
  configId: Id<"channelConfigs">;
  displayName?: string;
  phoneNumberId?: string;
  wabaId?: string;
  verifyToken?: string;
  appSecret?: string;
  accessToken?: string;
}) => Promise<null>;

// --- Create/edit form modal ---
function ChannelFormModal({
  organizationId,
  config,
  onClose,
  createChannelConfig,
  updateChannelConfig,
}: {
  organizationId: Id<"organizations">;
  config: ChannelConfig | null;
  onClose: () => void;
  createChannelConfig: CreateChannelConfigFn;
  updateChannelConfig: UpdateChannelConfigFn;
}) {
  const isEditing = !!config;

  const [form, setForm] = useState<ChannelFormState>(() =>
    config
      ? {
          displayName: config.displayName,
          phoneNumberId: config.phoneNumberId,
          wabaId: config.wabaId,
          verifyToken: config.verifyToken,
          appSecret: "",
          accessToken: "",
        }
      : { ...EMPTY_FORM, verifyToken: crypto.randomUUID() }
  );
  const [saving, setSaving] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

  const handleGenerateToken = () => {
    setForm((f) => ({ ...f, verifyToken: crypto.randomUUID() }));
  };

  const handleCopyToken = async () => {
    await copyToClipboard(form.verifyToken, "Verify token copiado");
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (isEditing && config) {
        await toast.promise(
          updateChannelConfig({
            configId: config._id,
            displayName: form.displayName,
            phoneNumberId: form.phoneNumberId,
            wabaId: form.wabaId,
            verifyToken: form.verifyToken,
            appSecret: form.appSecret ? form.appSecret : undefined,
            accessToken: form.accessToken ? form.accessToken : undefined,
          }),
          {
            loading: "Salvando alterações...",
            success: "Número atualizado com sucesso",
            error: (error) => (error instanceof Error ? error.message : "Falha ao atualizar número"),
          }
        );
      } else {
        await toast.promise(
          createChannelConfig({
            organizationId,
            channel: "whatsapp",
            displayName: form.displayName,
            phoneNumberId: form.phoneNumberId,
            wabaId: form.wabaId,
            verifyToken: form.verifyToken,
            appSecret: form.appSecret,
            accessToken: form.accessToken,
          }),
          {
            loading: "Conectando número...",
            success: "Número conectado com sucesso",
            error: (error) => (error instanceof Error ? error.message : "Falha ao conectar número"),
          }
        );
      }
      onClose();
    } catch {
      // toast.promise already surfaced the error
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={isEditing ? "Editar número" : "Conectar número"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Nome de exibição"
          type="text"
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          placeholder="ex: Atendimento Comercial"
          required
        />
        <Input
          label="Phone Number ID"
          type="text"
          value={form.phoneNumberId}
          onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })}
          placeholder="ex: 109876543212345"
          required
        />
        <Input
          label="WABA ID"
          type="text"
          value={form.wabaId}
          onChange={(e) => setForm({ ...form, wabaId: e.target.value })}
          placeholder="ex: 123456789012345"
          required
        />

        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Verify Token</label>
          <div className="flex gap-2">
            <Input
              type="text"
              value={form.verifyToken}
              onChange={(e) => setForm({ ...form, verifyToken: e.target.value })}
              className="font-mono"
              required
            />
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={handleGenerateToken}
              aria-label="Gerar novo verify token"
            >
              <Dices size={16} />
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={handleCopyToken}
              aria-label="Copiar verify token"
            >
              {tokenCopied ? <Check size={16} /> : <Copy size={16} />}
            </Button>
          </div>
          <p className="mt-1.5 text-[13px] text-text-muted">
            Use este valor ao configurar o webhook no Meta for Developers.
          </p>
        </div>

        <Input
          label="App Secret"
          type="password"
          value={form.appSecret}
          onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
          placeholder={isEditing ? `•••• (cole para substituir)` : "Cole o App Secret"}
          required={!isEditing}
        />
        <Input
          label="Access Token"
          type="password"
          value={form.accessToken}
          onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
          placeholder={isEditing ? `•••• (cole para substituir)` : "Cole o Access Token permanente"}
          required={!isEditing}
        />
        {isEditing && (
          <p className="text-[13px] text-text-muted -mt-2">
            Os segredos ficam sempre mascarados. Deixe em branco para manter os valores atuais ou cole
            novos valores para substituí-los.
          </p>
        )}

        <div className="flex gap-2 pt-4">
          <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
            Cancelar
          </Button>
          <Button type="submit" className="flex-1" disabled={saving}>
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
