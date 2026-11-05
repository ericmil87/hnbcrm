import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { useSearchParams } from "react-router";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { useOrgModules } from "@/hooks/useOrgModules";
import { PermissionGate } from "@/components/guards/PermissionGate";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import { MessageCircle, Plus, Copy, Check, ChevronDown, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { FINALIZE_FAILED_TEXT, FINALIZE_WRONG_ORG_HINT, RECONNECT_FLAG_KEY, finalizeMetaAction, metaReturnMessage, safeSession } from "@/lib/metaConnect";
import { InstagramPanel } from "./InstagramPanel";
import { MetaPageSelectionModal } from "@/components/settings/MetaPageSelectionModal";
import { ChannelHealthPanel } from "@/components/settings/ChannelHealthPanel";
import type { ChannelConfig } from "./types";
import { copyToClipboard } from "./copyToClipboard";
import { ChannelFormModal } from "./ChannelConnectCard";
import { ChannelCard } from "./ChannelCard";
import { BridgeQrModal } from "./BridgeQrModal";

// Derive the public webhook callback host from the Convex deployment URL
// (client-facing ".convex.cloud" deployment maps to the HTTP action host ".convex.site")
const CONVEX_SITE = ((import.meta.env.VITE_CONVEX_URL as string) ?? "").replace(
  ".convex.cloud",
  ".convex.site"
);
const WEBHOOK_CALLBACK_URL = `${CONVEX_SITE}/webhooks/whatsapp`;

export function ChannelsPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const { can } = usePermissions(organizationId);
  const canManage = can("settings", "manage");

  const [showForm, setShowForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ChannelConfig | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<Id<"channelConfigs"> | null>(null);
  const [testingId, setTestingId] = useState<Id<"channelConfigs"> | null>(null);
  const [qrConfig, setQrConfig] = useState<ChannelConfig | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const { modules } = useOrgModules(organizationId);
  const metaEnabled = modules.metaMessaging;

  const allConfigs = useQuery(api.channelConfigs.getChannelConfigs, { organizationId }) as
    | (ChannelConfig | { channel: "instagram" | "messenger" })[]
    | undefined;
  // WhatsApp (Cloud API / gateway) segue no fluxo de sempre; Instagram/Messenger ficam em InstagramPanel.
  const configs = allConfigs?.filter((c): c is ChannelConfig => c.channel === "whatsapp");

  // Volta do OAuth da Meta: /app/configuracoes?secao=channels&meta=<code>[&pendente=<id>].
  const [searchParams, setSearchParams] = useSearchParams();
  const metaCode = searchParams.get("meta");
  const pendingId = searchParams.get("pendente");
  useEffect(() => {
    if (!metaCode || metaCode === "selecionar") return;
    const reconnecting = metaCode === "ok" && safeSession.get(RECONNECT_FLAG_KEY) === "1";
    safeSession.remove(RECONNECT_FLAG_KEY);
    const message = metaReturnMessage(metaCode, reconnecting);
    if (message) {
      // `id` evita toast duplicado no StrictMode.
      const opts = { id: `meta-${metaCode}` };
      if (message.kind === "success") toast.success(message.text, opts);
      else if (message.kind === "info") toast.info(message.text, opts);
      else toast.error(message.text, opts);
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("meta");
        next.delete("pendente");
        return next;
      },
      { replace: true }
    );
  }, [metaCode, setSearchParams]);

  // Novo fluxo: a Meta volta com ?meta=finalizar&state=<nonce>; o usuário autenticado finaliza.
  const finalizeMetaOAuth = useAction(api.metaMessaging.finalizeMetaOAuth);
  const startMetaConnect = useAction(api.metaMessaging.startMetaConnect);
  const metaState = searchParams.get("state");
  const finalizeStarted = useRef<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [finalizedPendingId, setFinalizedPendingId] = useState<Id<"metaOAuthPending"> | null>(null);
  useEffect(() => {
    if (metaCode !== "finalizar" || !metaState) return;
    if (finalizeStarted.current === metaState) return;
    finalizeStarted.current = metaState;
    const state = metaState;
    setFinalizing(true);
    setFinalizeError(false);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("meta");
        next.delete("state");
        return next;
      },
      { replace: true }
    );
    void (async () => {
      try {
        const result = await finalizeMetaOAuth({ organizationId, state });
        const reconnecting = result.code === "ok" && safeSession.get(RECONNECT_FLAG_KEY) === "1";
        safeSession.remove(RECONNECT_FLAG_KEY);
        const action = finalizeMetaAction(result, reconnecting);
        if (action.type === "select") {
          setFinalizedPendingId(action.pendingId as Id<"metaOAuthPending">);
        } else {
          const { kind, text } = action.message;
          if (kind === "success") toast.success(text);
          else if (kind === "info") toast.info(text);
          else toast.error(text);
        }
      } catch {
        setFinalizeError(true);
        toast.error(FINALIZE_FAILED_TEXT);
      } finally {
        setFinalizing(false);
      }
    })();
  }, [metaCode, metaState, organizationId, finalizeMetaOAuth, setSearchParams]);

  const retryMetaConnect = async () => {
    setRetrying(true);
    try {
      const { url } = await startMetaConnect({ organizationId });
      window.location.href = url;
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Não foi possível iniciar a conexão com a Meta"));
      setRetrying(false);
    }
  };

  const closeSelection = useCallback(() => {
    setFinalizedPendingId(null);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("meta");
        next.delete("pendente");
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

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
      error: "Não foi possível atualizar status do número.",
    });
  };

  const handleToggleAutoTranscribe = (config: ChannelConfig) => {
    const next = !config.autoTranscribeAudio;
    toast.promise(updateChannelConfig({ configId: config._id, autoTranscribeAudio: next }), {
      loading: "Atualizando…",
      success: next ? "Transcrição automática ativada" : "Transcrição automática desativada",
      error: "Não foi possível atualizar transcrição automática.",
    });
  };

  const handleTogglePhoneNotifications = (config: ChannelConfig) => {
    const next = !(config.bridgePhoneNotifications ?? true);
    toast.promise(updateChannelConfig({ configId: config._id, bridgePhoneNotifications: next }), {
      loading: "Atualizando…",
      success: next ? "Notificações no celular ativadas" : "Notificações no celular desativadas",
      error: "Não foi possível atualizar notificações no celular.",
    });
  };

  const handleDelete = (configId: Id<"channelConfigs">) => {
    toast.promise(deleteChannelConfig({ configId }), {
      loading: "Excluindo número…",
      success: "Número desconectado",
      error: "Não foi possível excluir número.",
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
        toast.error(result.error ?? "Não foi possível testar conexão.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível testar conexão.");
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
      {finalizing && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-card border border-border bg-surface-raised p-4 text-sm text-text-secondary"
        >
          <Spinner size="sm" />
          Concluindo a conexão com a Meta…
        </div>
      )}
      {finalizeError && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-card border border-semantic-error/30 bg-semantic-error/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-text-primary">
            {FINALIZE_FAILED_TEXT} {FINALIZE_WRONG_ORG_HINT}
          </p>
          <Button
            variant="secondary"
            className="min-h-11 shrink-0"
            disabled={retrying}
            onClick={() => void retryMetaConnect()}
          >
            Conectar de novo
          </Button>
        </div>
      )}
      <InstagramPanel organizationId={organizationId} />

      <Card>
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10">
              <MessageCircle size={20} className="text-brand-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Canais</h3>
              <p className="text-sm text-text-secondary">
                Conecte números de WhatsApp pelo WhatsApp oficial (Meta) ou por QR code.
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
                onTogglePhoneNotifications={() => handleTogglePhoneNotifications(config)}
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
          O verify token de cada número do WhatsApp oficial está listado no card correspondente acima.
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
              Guia completo na documentação oficial da Meta:{" "}
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-text-primary"
              >
                Guia do WhatsApp oficial (Meta)
              </a>
              .
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

      {metaEnabled && canManage && (finalizedPendingId || (metaCode === "selecionar" && pendingId)) && (
        <MetaPageSelectionModal
          organizationId={organizationId}
          pendingId={(finalizedPendingId ?? pendingId) as Id<"metaOAuthPending">}
          onClose={closeSelection}
        />
      )}

      {showForm && (
        <ChannelFormModal
          organizationId={organizationId}
          metaEnabled={metaEnabled}
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
