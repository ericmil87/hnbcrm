import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { PermissionGate } from "@/components/guards/PermissionGate";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
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
  AlertTriangle,
  QrCode,
  Cloud,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ChannelHealthPanel } from "@/components/settings/ChannelHealthPanel";

// Derive the public webhook callback host from the Convex deployment URL
// (client-facing ".convex.cloud" deployment maps to the HTTP action host ".convex.site")
const CONVEX_SITE = ((import.meta.env.VITE_CONVEX_URL as string) ?? "").replace(
  ".convex.cloud",
  ".convex.site"
);
const WEBHOOK_CALLBACK_URL = `${CONVEX_SITE}/webhooks/whatsapp`;
const BRIDGE_WEBHOOK_URL = `${CONVEX_SITE}/webhooks/bridge`;

type Provider = "meta" | "bridge";
type BridgeSessionState = "connected" | "connecting" | "qr" | "disconnected" | "banned";

// Masked shape returned by getChannelConfigs — Meta fields are null on bridge
// configs and bridge fields are null on Meta configs (defensive rendering below).
type ChannelConfig = {
  _id: Id<"channelConfigs">;
  channel: "whatsapp";
  provider: Provider;
  displayName: string;
  // Meta
  phoneNumberId: string | null;
  wabaId: string | null;
  displayPhoneNumber: string | null;
  verifyToken: string | null;
  appSecretMasked: string | null;
  accessTokenMasked: string | null;
  hasToken: boolean;
  // Bridge
  bridgeBaseUrl: string | null;
  bridgeInstanceId: string | null;
  bridgeTokenMasked: string | null;
  hasBridgeToken: boolean;
  bridgeSessionState: BridgeSessionState | null;
  autoTranscribeAudio: boolean;
  autoDescribeImages: boolean;
  status: "active" | "disabled" | "error";
  lastHealthCheckAt: number | null;
  healthDetail: string | null;
  createdAt: number;
  updatedAt: number;
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

// Fine-grained pairing badge for bridge configs (from the last health/QR check).
function bridgeStateBadge(state: BridgeSessionState): {
  variant: "success" | "warning" | "info" | "error";
  label: string;
} {
  switch (state) {
    case "connected":
      return { variant: "success", label: "Conectado" };
    case "connecting":
      return { variant: "warning", label: "Reconectando" };
    case "qr":
      return { variant: "info", label: "Aguardando QR" };
    case "banned":
      return { variant: "error", label: "Banido" };
    case "disconnected":
    default:
      return { variant: "error", label: "Deslogado" };
  }
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
  const [qrConfig, setQrConfig] = useState<ChannelConfig | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const configs = useQuery(api.channelConfigs.getChannelConfigs, { organizationId }) as
    | ChannelConfig[]
    | undefined;

  const createChannelConfig = useAction(api.channelConfigs.createChannelConfig);
  const updateChannelConfig = useAction(api.channelConfigs.updateChannelConfig);
  const provisionBridgeChannel = useAction(api.channelConfigs.provisionBridgeChannel);
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

  const handleToggleAutoTranscribe = (config: ChannelConfig) => {
    const next = !config.autoTranscribeAudio;
    toast.promise(updateChannelConfig({ configId: config._id, autoTranscribeAudio: next }), {
      loading: "Atualizando...",
      success: next ? "Transcrição automática ativada" : "Transcrição automática desativada",
      error: "Falha ao atualizar transcrição automática",
    });
  };

  const handleToggleAutoDescribe = (config: ChannelConfig) => {
    const next = !config.autoDescribeImages;
    toast.promise(updateChannelConfig({ configId: config._id, autoDescribeImages: next }), {
      loading: "Atualizando...",
      success: next ? "Leitura de imagens ativada" : "Leitura de imagens desativada",
      error: "Falha ao atualizar leitura de imagens",
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
          config.provider === "bridge"
            ? `Conectado${result.displayPhoneNumber ? ` (${result.displayPhoneNumber})` : ""}`
            : `Conectado: ${result.verifiedName ?? config.displayName} (${result.displayPhoneNumber ?? config.phoneNumberId})`
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
                Conecte números de WhatsApp — via Cloud API oficial (Meta) ou por um gateway não oficial.
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
              <ChannelCard
                key={config._id}
                organizationId={organizationId}
                config={config}
                testing={testingId === config._id}
                copiedField={copiedField}
                onTest={() => handleTestConnection(config)}
                onEdit={() => openEditForm(config)}
                onToggle={() => handleToggleStatus(config)}
                onToggleAutoTranscribe={() => handleToggleAutoTranscribe(config)}
                onToggleAutoDescribe={() => handleToggleAutoDescribe(config)}
                onDelete={() => setConfirmDeleteId(config._id)}
                onShowQr={() => setQrConfig(config)}
                onCopy={handleCopy}
              />
            ))}
          </div>
        )}

        {configs && configs.length > 0 && <ChannelHealthPanel organizationId={organizationId} />}
      </Card>

      {/* Meta webhook configuration block */}
      <Card variant="sunken">
        <h4 className="text-sm font-semibold text-text-primary mb-1">Configuração do webhook na Meta</h4>
        <p className="text-sm text-text-secondary mb-3">
          Para números via Cloud API (oficial), use esta URL de callback ao configurar o webhook do seu
          app no Meta for Developers, assinando o campo{" "}
          <span className="font-mono text-text-secondary">messages</span>.
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
          O verify token de cada número da Cloud API está listado no card correspondente acima.
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
          provisionBridgeChannel={provisionBridgeChannel}
        />
      )}

      {qrConfig && (
        <BridgeQrModal config={qrConfig} onClose={() => setQrConfig(null)} />
      )}
    </div>
  );
}

// --- One channel card (provider-aware) ---
function ChannelCard({
  organizationId,
  config,
  testing,
  copiedField,
  onTest,
  onEdit,
  onToggle,
  onToggleAutoTranscribe,
  onToggleAutoDescribe,
  onDelete,
  onShowQr,
  onCopy,
}: {
  organizationId: Id<"organizations">;
  config: ChannelConfig;
  testing: boolean;
  copiedField: string | null;
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onToggleAutoTranscribe: () => void;
  onToggleAutoDescribe: () => void;
  onDelete: () => void;
  onShowQr: () => void;
  onCopy: (field: string, value: string, message: string) => void;
}) {
  const isBridge = config.provider === "bridge";
  // Subtitle: prefer a human phone number; fall back to the provider's routing id.
  const subtitle = config.displayPhoneNumber ?? (isBridge ? config.bridgeInstanceId : config.phoneNumberId);

  // For bridge, show the fine-grained pairing badge (unless deliberately disabled).
  const showBridgeStateBadge = isBridge && config.status !== "disabled" && config.bridgeSessionState;
  const stateBadge = showBridgeStateBadge ? bridgeStateBadge(config.bridgeSessionState!) : null;

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-3.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-text-primary">{config.displayName}</span>
            {stateBadge ? (
              <Badge variant={stateBadge.variant}>{stateBadge.label}</Badge>
            ) : (
              <Badge variant={statusBadgeVariant(config.status)}>{statusLabel(config.status)}</Badge>
            )}
            <Badge variant={isBridge ? "warning" : "brand"}>
              {isBridge ? (
                <span className="inline-flex items-center gap-1">
                  <Radio size={11} /> Gateway não oficial
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Cloud size={11} /> Cloud API
                </span>
              )}
            </Badge>
          </div>
          {subtitle && (
            <p className="text-sm text-text-secondary mt-0.5 tabular-nums break-all">{subtitle}</p>
          )}
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
                  &middot; testado em {new Date(config.lastHealthCheckAt).toLocaleString("pt-BR")}
                </span>
              )}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <PermissionGate organizationId={organizationId} category="settings" level="manage">
            {isBridge && (
              <Button variant="secondary" size="sm" onClick={onShowQr}>
                <QrCode size={14} />
                Mostrar QR
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={onTest} disabled={testing}>
              {testing ? <Spinner size="sm" /> : <RefreshCw size={14} />}
              Testar conexão
            </Button>
            <button
              onClick={onEdit}
              className="text-sm text-brand-500 hover:text-brand-400 px-2 py-1.5"
            >
              Editar
            </button>
            <button
              onClick={onToggle}
              aria-label={config.status === "active" ? "Desativar número" : "Ativar número"}
              className="flex items-center justify-center h-8 w-8 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
            >
              <Power size={16} />
            </button>
            <button
              onClick={onDelete}
              aria-label="Excluir número"
              className="flex items-center justify-center h-8 w-8 rounded-full text-semantic-error hover:bg-semantic-error/10 transition-colors"
            >
              <Trash2 size={16} />
            </button>
          </PermissionGate>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-surface-base border border-border-subtle p-2.5">
        <div className="min-w-0">
          <span className="text-sm text-text-primary">Transcrever áudios automaticamente</span>
          <p className="text-xs text-text-muted mt-0.5">Usa Whisper local no seu servidor</p>
        </div>
        <PermissionGate
          organizationId={organizationId}
          category="settings"
          level="manage"
          fallback={
            <Badge variant={config.autoTranscribeAudio ? "success" : "default"}>
              {config.autoTranscribeAudio ? "Ativado" : "Desativado"}
            </Badge>
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={config.autoTranscribeAudio}
            aria-label="Transcrever áudios automaticamente"
            onClick={onToggleAutoTranscribe}
            className={cn(
              "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              config.autoTranscribeAudio ? "bg-brand-500" : "bg-surface-overlay border border-border-strong"
            )}
          >
            <span
              className={cn(
                "pointer-events-none h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                config.autoTranscribeAudio ? "translate-x-5" : "translate-x-1"
              )}
            />
          </button>
        </PermissionGate>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-surface-base border border-border-subtle p-2.5">
        <div className="min-w-0">
          <span className="text-sm text-text-primary">Ler imagens automaticamente</span>
          <p className="text-xs text-text-muted mt-0.5">
            Só funciona com “Ler imagens recebidas” ligado em Configurações → IA
          </p>
        </div>
        <PermissionGate
          organizationId={organizationId}
          category="settings"
          level="manage"
          fallback={
            <Badge variant={config.autoDescribeImages ? "success" : "default"}>
              {config.autoDescribeImages ? "Ativado" : "Desativado"}
            </Badge>
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={config.autoDescribeImages}
            aria-label="Ler imagens automaticamente"
            onClick={onToggleAutoDescribe}
            className={cn(
              "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              config.autoDescribeImages ? "bg-brand-500" : "bg-surface-overlay border border-border-strong"
            )}
          >
            <span
              className={cn(
                "pointer-events-none h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                config.autoDescribeImages ? "translate-x-5" : "translate-x-1"
              )}
            />
          </button>
        </PermissionGate>
      </div>

      {/* Meta: verify token footer. Bridge: gateway instance info (no secrets). */}
      {!isBridge && config.verifyToken && (
        <div className="mt-3 flex flex-col gap-1.5 rounded-lg bg-surface-base border border-border-subtle p-2.5 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-text-muted">
            Verify token: <span className="font-mono text-text-secondary">{config.verifyToken}</span>
          </span>
          <button
            onClick={() => onCopy(`token-${config._id}`, config.verifyToken!, "Verify token copiado")}
            className="inline-flex items-center gap-1.5 text-xs text-brand-500 hover:text-brand-400 self-start sm:self-auto"
          >
            {copiedField === `token-${config._id}` ? <Check size={13} /> : <Copy size={13} />}
            Copiar
          </button>
        </div>
      )}
      {isBridge && (config.bridgeBaseUrl || config.bridgeInstanceId) && (
        <div className="mt-3 rounded-lg bg-surface-base border border-border-subtle p-2.5 text-xs text-text-muted space-y-0.5 break-all">
          {config.bridgeBaseUrl && (
            <div>
              Gateway: <span className="font-mono text-text-secondary">{config.bridgeBaseUrl}</span>
            </div>
          )}
          {config.bridgeInstanceId && (
            <div>
              Instância: <span className="font-mono text-text-secondary">{config.bridgeInstanceId}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Bridge QR modal (pairing) ---
// Auto-detects pairing: polls the gateway every ~4s while open. When the session
// flips to "connected" it persists the state once (via checkChannelHealth, so the
// card updates reactively), shows a success state, and auto-closes. The poll also
// renews the QR automatically as the gateway rotates it. The manual "Atualizar QR"
// button remains as a fallback.
const QR_POLL_INTERVAL_MS = 4000;
const QR_SUCCESS_CLOSE_MS = 1500;

type QrResult = {
  state: BridgeSessionState;
  qrCode?: string;
  displayPhoneNumber?: string;
  error?: string;
};

function BridgeQrModal({ config, onClose }: { config: ChannelConfig; onClose: () => void }) {
  const getBridgeQrCode = useAction(api.channelConfigs.getBridgeQrCode);
  const checkChannelHealth = useAction(api.channelConfigs.checkChannelHealth);

  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<QrResult | null>(null);
  // Transient warning shown while a poll tick fails but we keep retrying — never
  // tears down an already-rendered QR.
  const [pollError, setPollError] = useState<string | null>(null);
  // True once we've entered the success/close sequence. Distinguishes a fresh pair
  // ("Conectado!") from a number that was already connected when the modal opened.
  const [pairedNow, setPairedNow] = useState(false);

  // Refs survive re-renders without re-arming the effect below.
  const inFlightRef = useRef(false); // a getBridgeQrCode call is outstanding — skip the tick
  const doneRef = useRef(false); // pairing detected — stop polling, fire success once
  const hadQrRef = useRef(false); // a QR was displayed at some point (⇒ this is a fresh pair)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest onClose without re-arming the polling effect.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Success sequence — runs exactly once. Persists the pairing so the card badge
  // flips reactively, toasts, then auto-closes the modal.
  const finishConnected = useCallback(
    (displayPhoneNumber?: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      setPairedNow(hadQrRef.current);
      // One-shot persist so getChannelConfigs (a reactive query) updates the card.
      void checkChannelHealth({ configId: config._id }).catch(() => undefined);
      toast.success(
        hadQrRef.current
          ? `Número pareado com sucesso${displayPhoneNumber ? ` (${displayPhoneNumber})` : ""}`
          : `Número já conectado${displayPhoneNumber ? ` (${displayPhoneNumber})` : ""}`
      );
      closeTimerRef.current = setTimeout(() => onCloseRef.current(), QR_SUCCESS_CLOSE_MS);
    },
    [checkChannelHealth, config._id]
  );

  // One poll tick — guarded so ticks never stack and stop once paired.
  const poll = useCallback(async () => {
    if (inFlightRef.current || doneRef.current) return;
    inFlightRef.current = true;
    try {
      const r = await getBridgeQrCode({ configId: config._id });
      if (doneRef.current) return;
      if (r.qrCode) hadQrRef.current = true;
      setResult(r);
      setPollError(null);
      if (r.state === "connected") finishConnected(r.displayPhoneNumber);
    } catch (e) {
      if (doneRef.current) return;
      // Keep the modal (and any existing QR) alive; surface a discreet warning.
      setPollError(e instanceof Error ? e.message : "Falha ao consultar o gateway — tentando de novo...");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [getBridgeQrCode, config._id, finishConnected]);

  // Arm polling once on mount; tear it down on close/unmount.
  useEffect(() => {
    void poll();
    intervalRef.current = setInterval(() => void poll(), QR_POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, [poll]);

  const isConnected = result?.state === "connected";

  return (
    <Modal open onClose={onClose} title="Parear número via QR">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          No celular do número dedicado, abra o WhatsApp e vá em{" "}
          <span className="text-text-primary">Aparelhos conectados → Conectar um aparelho</span> e escaneie
          o código abaixo.
        </p>

        <div className="flex min-h-[280px] items-center justify-center rounded-lg border border-border bg-surface-base p-4">
          {isConnected ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-semantic-success/10">
                <Check size={24} className="text-semantic-success" />
              </div>
              <p className="text-sm font-medium text-text-primary">
                {pairedNow ? "Conectado!" : "Número já conectado"}
              </p>
              {result?.displayPhoneNumber && (
                <p className="text-xs text-text-muted tabular-nums">{result.displayPhoneNumber}</p>
              )}
            </div>
          ) : loading && !result ? (
            <div className="flex flex-col items-center gap-3 text-text-muted">
              <Spinner />
              <span className="text-sm">Consultando o gateway...</span>
            </div>
          ) : result?.qrCode ? (
            <div className="flex flex-col items-center gap-3">
              {/* wuzapi returns a base64 PNG data-URI — safe to render directly */}
              <img
                src={result.qrCode}
                alt="QR code para parear o WhatsApp"
                className="h-56 w-56 rounded-lg bg-white p-2"
              />
              <p className="text-xs text-text-muted flex items-center gap-1.5">
                <RefreshCw size={12} className="animate-spin" />
                Aguardando leitura — o QR se renova sozinho.
              </p>
              {pollError && <p className="text-xs text-semantic-warning max-w-xs text-center">{pollError}</p>}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-semantic-error/10">
                <AlertTriangle size={24} className="text-semantic-error" />
              </div>
              <p className="text-sm font-medium text-text-primary">
                {result?.state === "banned" ? "Número banido" : "Não foi possível obter o QR"}
              </p>
              {(result?.error || pollError) && (
                <p className="text-xs text-semantic-error max-w-xs">{result?.error ?? pollError}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Fechar
          </Button>
          <Button
            onClick={() => void poll()}
            disabled={loading || isConnected || inFlightRef.current}
            className="flex-1"
          >
            <RefreshCw size={16} />
            Atualizar QR
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type CreateChannelConfigFn = (args: {
  organizationId: Id<"organizations">;
  channel: "whatsapp";
  provider?: Provider;
  displayName: string;
  phoneNumberId?: string;
  wabaId?: string;
  verifyToken?: string;
  appSecret?: string;
  accessToken?: string;
  bridgeBaseUrl?: string;
  bridgeInstanceId?: string;
  bridgeToken?: string;
}) => Promise<Id<"channelConfigs">>;

type UpdateChannelConfigFn = (args: {
  configId: Id<"channelConfigs">;
  displayName?: string;
  phoneNumberId?: string;
  wabaId?: string;
  verifyToken?: string;
  appSecret?: string;
  accessToken?: string;
  bridgeBaseUrl?: string;
  bridgeInstanceId?: string;
  bridgeToken?: string;
  autoTranscribeAudio?: boolean;
  autoDescribeImages?: boolean;
}) => Promise<null>;

type ProvisionBridgeFn = (args: {
  organizationId: Id<"organizations">;
  displayName: string;
  bridgeBaseUrl?: string;
  adminToken?: string;
  webhookUrl: string;
  useManagedGateway?: boolean;
}) => Promise<Id<"channelConfigs">>;

// --- Create/edit form modal (provider-aware) ---
function ChannelFormModal({
  organizationId,
  config,
  onClose,
  createChannelConfig,
  updateChannelConfig,
  provisionBridgeChannel,
}: {
  organizationId: Id<"organizations">;
  config: ChannelConfig | null;
  onClose: () => void;
  createChannelConfig: CreateChannelConfigFn;
  updateChannelConfig: UpdateChannelConfigFn;
  provisionBridgeChannel: ProvisionBridgeFn;
}) {
  const isEditing = !!config;
  // On create, pick the provider first. On edit, the provider is locked.
  const [provider, setProvider] = useState<Provider | null>(config ? config.provider : null);

  const title = isEditing
    ? "Editar número"
    : provider === null
      ? "Conectar número"
      : provider === "meta"
        ? "Conectar via Cloud API"
        : "Conectar via gateway não oficial";

  return (
    <Modal open onClose={onClose} title={title}>
      {provider === null ? (
        <ProviderChooser onPick={setProvider} />
      ) : provider === "meta" ? (
        <MetaForm
          organizationId={organizationId}
          config={config}
          onClose={onClose}
          createChannelConfig={createChannelConfig}
          updateChannelConfig={updateChannelConfig}
          onBack={isEditing ? undefined : () => setProvider(null)}
        />
      ) : (
        <BridgeForm
          organizationId={organizationId}
          config={config}
          onClose={onClose}
          createChannelConfig={createChannelConfig}
          updateChannelConfig={updateChannelConfig}
          provisionBridgeChannel={provisionBridgeChannel}
          onBack={isEditing ? undefined : () => setProvider(null)}
        />
      )}
    </Modal>
  );
}

function ProviderChooser({ onPick }: { onPick: (p: Provider) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">Escolha como este número será conectado.</p>
      <button
        onClick={() => onPick("meta")}
        className="w-full text-left rounded-lg border border-border bg-surface-sunken p-4 hover:border-brand-500 transition-colors"
      >
        <div className="flex items-center gap-2 mb-1">
          <Cloud size={18} className="text-brand-500" />
          <span className="font-medium text-text-primary">WhatsApp Cloud API (oficial/Meta)</span>
        </div>
        <p className="text-sm text-text-secondary">
          Recomendado. Aprovado pela Meta, com janela de 24h e templates. Requer app no Meta for
          Developers.
        </p>
      </button>
      <button
        onClick={() => onPick("bridge")}
        className="w-full text-left rounded-lg border border-border bg-surface-sunken p-4 hover:border-semantic-warning transition-colors"
      >
        <div className="flex items-center gap-2 mb-1">
          <Radio size={18} className="text-semantic-warning" />
          <span className="font-medium text-text-primary">WhatsApp via gateway (não oficial)</span>
        </div>
        <p className="text-sm text-text-secondary">
          Ponte rápida via protocolo não sancionado pela Meta. Sem janela de 24h nem templates.{" "}
          <span className="text-semantic-warning">Risco de banimento — use por sua conta e risco.</span>
        </p>
      </button>
    </div>
  );
}

// --- Meta (Cloud API) form — unchanged behavior from the original ---
function MetaForm({
  organizationId,
  config,
  onClose,
  createChannelConfig,
  updateChannelConfig,
  onBack,
}: {
  organizationId: Id<"organizations">;
  config: ChannelConfig | null;
  onClose: () => void;
  createChannelConfig: CreateChannelConfigFn;
  updateChannelConfig: UpdateChannelConfigFn;
  onBack?: () => void;
}) {
  const isEditing = !!config;
  const [form, setForm] = useState(() =>
    config
      ? {
          displayName: config.displayName,
          phoneNumberId: config.phoneNumberId ?? "",
          wabaId: config.wabaId ?? "",
          verifyToken: config.verifyToken ?? "",
          appSecret: "",
          accessToken: "",
        }
      : {
          displayName: "",
          phoneNumberId: "",
          wabaId: "",
          verifyToken: crypto.randomUUID(),
          appSecret: "",
          accessToken: "",
        }
  );
  const [saving, setSaving] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

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
            provider: "meta",
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
            onClick={() => setForm((f) => ({ ...f, verifyToken: crypto.randomUUID() }))}
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
          Os segredos ficam sempre mascarados. Deixe em branco para manter os valores atuais ou cole novos
          valores para substituí-los.
        </p>
      )}

      <div className="flex gap-2 pt-4">
        <Button
          type="button"
          variant="secondary"
          onClick={onBack ?? onClose}
          className="flex-1"
        >
          {onBack ? "Voltar" : "Cancelar"}
        </Button>
        <Button type="submit" className="flex-1" disabled={saving}>
          {saving ? "Salvando..." : "Salvar"}
        </Button>
      </div>
    </form>
  );
}

// --- Bridge (unofficial gateway) form — manual config OR assisted provisioning ---
function BridgeForm({
  organizationId,
  config,
  onClose,
  createChannelConfig,
  updateChannelConfig,
  provisionBridgeChannel,
  onBack,
}: {
  organizationId: Id<"organizations">;
  config: ChannelConfig | null;
  onClose: () => void;
  createChannelConfig: CreateChannelConfigFn;
  updateChannelConfig: UpdateChannelConfigFn;
  provisionBridgeChannel: ProvisionBridgeFn;
  onBack?: () => void;
}) {
  const isEditing = !!config;
  // Managed defaults: when the platform hosts a wuzapi gateway, beginners can
  // provision with zero server config — advanced users still switch to their own.
  const bridgeDefaults = useQuery(
    api.channelConfigs.getBridgeProvisionDefaults,
    isEditing ? "skip" : { organizationId }
  );
  const managedAvailable = bridgeDefaults?.managedAvailable ?? false;
  // "manual" = paste an existing instance's credentials; "assisted" = provision a
  // new instance via the gateway admin token. Editing is always manual. Defaults
  // follow managed availability until the user picks explicitly.
  const [modeOverride, setModeOverride] = useState<"manual" | "assisted" | null>(null);
  const mode = modeOverride ?? (managedAvailable ? "assisted" : "manual");
  const [gatewayOverride, setGatewayOverride] = useState<"managed" | "custom" | null>(null);
  const gatewayChoice = gatewayOverride ?? (managedAvailable ? "managed" : "custom");
  const [form, setForm] = useState(() => ({
    displayName: config?.displayName ?? "WhatsApp",
    bridgeBaseUrl: config?.bridgeBaseUrl ?? "",
    bridgeInstanceId: config?.bridgeInstanceId ?? "",
    bridgeToken: "",
    adminToken: "",
  }));
  // The opt-in risk acceptance is mandatory before creating a bridge channel.
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [saving, setSaving] = useState(false);

  const needsRiskAck = !isEditing; // editing an existing bridge doesn't re-accept

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (needsRiskAck && !riskAccepted) {
      toast.error("É preciso aceitar os termos de risco para conectar um canal não oficial.");
      return;
    }
    setSaving(true);
    try {
      if (isEditing && config) {
        await toast.promise(
          updateChannelConfig({
            configId: config._id,
            displayName: form.displayName,
            bridgeBaseUrl: form.bridgeBaseUrl,
            bridgeInstanceId: form.bridgeInstanceId,
            bridgeToken: form.bridgeToken ? form.bridgeToken : undefined,
          }),
          {
            loading: "Salvando alterações...",
            success: "Canal atualizado com sucesso",
            error: (error) => (error instanceof Error ? error.message : "Falha ao atualizar canal"),
          }
        );
      } else if (mode === "assisted") {
        await toast.promise(
          provisionBridgeChannel({
            organizationId,
            displayName: form.displayName,
            webhookUrl: BRIDGE_WEBHOOK_URL,
            ...(gatewayChoice === "managed"
              ? { useManagedGateway: true }
              : { bridgeBaseUrl: form.bridgeBaseUrl, adminToken: form.adminToken }),
          }),
          {
            loading: "Provisionando instância no gateway...",
            success: "Instância provisionada — mostre o QR para parear",
            error: (error) => (error instanceof Error ? error.message : "Falha ao provisionar instância"),
          }
        );
      } else {
        await toast.promise(
          createChannelConfig({
            organizationId,
            channel: "whatsapp",
            provider: "bridge",
            displayName: form.displayName,
            bridgeBaseUrl: form.bridgeBaseUrl,
            bridgeInstanceId: form.bridgeInstanceId,
            bridgeToken: form.bridgeToken,
          }),
          {
            loading: "Conectando canal...",
            success: "Canal conectado — mostre o QR para parear",
            error: (error) => (error instanceof Error ? error.message : "Falha ao conectar canal"),
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

  // Avoid flicker: the default mode/gateway depend on managed availability.
  if (!isEditing && bridgeDefaults === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Opt-in risk warning (plan §8) — only on create */}
      {needsRiskAck && (
        <div className="rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3.5 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-semantic-warning shrink-0" />
            <span className="text-sm font-semibold text-text-primary">
              Canal não oficial — por sua conta e risco
            </span>
          </div>
          <ul className="text-xs text-text-secondary space-y-1 list-disc list-inside">
            <li>Usa um protocolo não sancionado pela Meta e viola os Termos de Uso do WhatsApp.</li>
            <li>O número pode ser banido permanentemente, sem aviso e sem recurso.</li>
            <li>Use um número dedicado e descartável — nunca o principal do seu negócio.</li>
            <li>Não dispare mensagens para desconhecidos (é o gatilho nº 1 de banimento).</li>
            <li>O HNBCRM não se responsabiliza por banimento ou perda de acesso.</li>
          </ul>
          <p className="text-xs text-text-secondary">
            Consulte os{" "}
            <a
              href="/termos"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-500 hover:text-brand-400 underline"
            >
              Termos de Uso
            </a>{" "}
            para os detalhes sobre o canal WhatsApp não oficial.
          </p>
          <Checkbox
            containerClassName="pt-1"
            checked={riskAccepted}
            onChange={(e) => setRiskAccepted(e.target.checked)}
            label={
            <span className="text-xs text-text-primary">
              Entendo e assumo o risco de usar um canal WhatsApp não oficial.
            </span>
            }
          />
        </div>
      )}

      {/* Manual vs assisted toggle — only on create */}
      {!isEditing && (
        <div className="flex gap-1 rounded-lg bg-surface-sunken p-1">
          <button
            type="button"
            onClick={() => setModeOverride("manual")}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              mode === "manual"
                ? "bg-surface-raised text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            Instância existente
          </button>
          <button
            type="button"
            onClick={() => setModeOverride("assisted")}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              mode === "assisted"
                ? "bg-surface-raised text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            Provisionar nova
          </button>
        </div>
      )}

      <Input
        label="Nome de exibição"
        type="text"
        value={form.displayName}
        onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        placeholder="ex: WhatsApp Vendas (não oficial)"
        required
      />
      {(isEditing || mode === "manual" || gatewayChoice === "custom") && (
        <Input
          label="URL do gateway"
          type="text"
          value={form.bridgeBaseUrl}
          onChange={(e) => setForm({ ...form, bridgeBaseUrl: e.target.value })}
          placeholder="ex: https://wa-gw.seudominio.com.br"
          required
        />
      )}

      {isEditing || mode === "manual" ? (
        <>
          <Input
            label="ID da instância"
            type="text"
            value={form.bridgeInstanceId}
            onChange={(e) => setForm({ ...form, bridgeInstanceId: e.target.value })}
            placeholder="ex: org_minhaempresa"
            required={!isEditing}
            disabled={isEditing}
          />
          <Input
            label="Token da instância"
            type="password"
            value={form.bridgeToken}
            onChange={(e) => setForm({ ...form, bridgeToken: e.target.value })}
            placeholder={isEditing ? "•••• (cole para substituir)" : "Token da instância no gateway"}
            required={!isEditing}
          />
          {isEditing && (
            <p className="text-[13px] text-text-muted -mt-2">
              O ID da instância não pode ser alterado. Deixe o token em branco para manter o atual.
            </p>
          )}
        </>
      ) : gatewayChoice === "managed" ? (
        <div className="rounded-lg border border-border bg-surface-sunken p-3.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-text-primary">
              Servidor HNBCRM (recomendado)
            </span>
            <button
              type="button"
              onClick={() => setGatewayOverride("custom")}
              className="text-xs text-brand-500 hover:text-brand-400 whitespace-nowrap"
            >
              Usar meu próprio servidor
            </button>
          </div>
          <p className="text-xs text-text-secondary">
            A instância será criada automaticamente no servidor gerenciado do HNBCRM{" "}
            {bridgeDefaults?.managedGatewayUrl && (
              <span className="font-mono break-all">({bridgeDefaults.managedGatewayUrl})</span>
            )}{" "}
            — sem URL nem token para configurar. Depois é só escanear o QR para parear o número.
          </p>
        </div>
      ) : (
        <>
          <Input
            label="Admin token do gateway"
            type="password"
            value={form.adminToken}
            onChange={(e) => setForm({ ...form, adminToken: e.target.value })}
            placeholder="Token de administração do wuzapi"
            required
          />
          <p className="text-[13px] text-text-muted -mt-2">
            Usado só uma vez para criar a instância — não é armazenado. A instância será criada com um
            webhook apontando para{" "}
            <span className="font-mono break-all text-text-secondary">{BRIDGE_WEBHOOK_URL}</span>.
          </p>
          {managedAvailable && (
            <button
              type="button"
              onClick={() => setGatewayOverride("managed")}
              className="text-xs text-brand-500 hover:text-brand-400"
            >
              ← Voltar ao servidor HNBCRM (recomendado)
            </button>
          )}
        </>
      )}

      <div className="flex gap-2 pt-4">
        <Button type="button" variant="secondary" onClick={onBack ?? onClose} className="flex-1">
          {onBack ? "Voltar" : "Cancelar"}
        </Button>
        <Button
          type="submit"
          className="flex-1"
          disabled={saving || (needsRiskAck && !riskAccepted)}
        >
          {saving ? "Salvando..." : mode === "assisted" && !isEditing ? "Provisionar" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}
