import { Tooltip } from "@/components/ui/Tooltip";
import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { PermissionGate } from "@/components/guards/PermissionGate";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { Copy, Check, RefreshCw, Power, Trash2, QrCode, Cloud, Radio, LayoutTemplate, BellRing } from "lucide-react";
import { cn } from "@/lib/utils";
import { statusBadgeVariant, statusLabel, bridgeStateBadge } from "@/lib/channelBadges";
import { BridgeGroupsPanel } from "@/components/settings/BridgeGroupsPanel";
import { ChannelTranscriptionToggle } from "./ChannelTranscriptionToggle";
import type { ChannelConfig } from "./types";
import { BridgeHistoryPanel } from "./BridgeHistoryPanel";

// --- One channel card (provider-aware) ---
export function ChannelCard({
  organizationId,
  config,
  testing,
  copiedField,
  onTest,
  onEdit,
  onToggle,
  onTogglePhoneNotifications,
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
  onTogglePhoneNotifications: () => void;
  onDelete: () => void;
  onShowQr: () => void;
  onCopy: (field: string, value: string, message: string) => void;
}) {
  const isBridge = config.provider === "bridge";
  const phoneNotificationsOn = config.bridgePhoneNotifications ?? true;
  // Subtitle: prefer a human phone number; sem número ainda, "Aguardando conexão".
  const subtitle = config.displayPhoneNumber ?? (isBridge ? "Aguardando conexão" : config.phoneNumberId);

  // Templates da Meta (campanhas): sync sob demanda, cache em whatsappTemplates.
  const syncTemplates = useAction(api.whatsappTemplates.syncMetaTemplates);
  const [syncingTemplates, setSyncingTemplates] = useState(false);
  const templates = useQuery(
    api.whatsappTemplates.listTemplates,
    !isBridge ? { channelConfigId: config._id } : "skip"
  ) as { status: string }[] | undefined;
  const approvedCount = templates?.filter((t) => t.status === "APPROVED").length ?? 0;
  const handleSyncTemplates = async () => {
    setSyncingTemplates(true);
    try {
      const r = await syncTemplates({ channelConfigId: config._id });
      toast.success(`${r.approved} templates aprovados de ${r.synced} sincronizados`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^.*Uncaught Error: /, "") : "Não foi possível sincronizar templates.");
    } finally {
      setSyncingTemplates(false);
    }
  };

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
                  <Radio size={11} /> WhatsApp por QR code
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <Cloud size={11} /> WhatsApp oficial (Meta)
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
              <Button
                variant={config.bridgeSessionState === "connected" ? "secondary" : "primary"}
                size="sm"
                onClick={onShowQr}
              >
                <QrCode size={14} />
                Mostrar QR code
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={onTest} disabled={testing}>
              {testing ? <Spinner size="sm" /> : <RefreshCw size={14} />}
              Testar conexão
            </Button>
            {!isBridge && (
              <Tooltip content="Sincroniza os templates de mensagem aprovados na Meta (usados nas campanhas)" asInfo>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleSyncTemplates()}
                  disabled={syncingTemplates}
                >
                  {syncingTemplates ? <Spinner size="sm" /> : <LayoutTemplate size={14} />}
                  Templates{templates !== undefined ? ` (${approvedCount})` : ""}
                </Button>
              </Tooltip>
            )}
            <Button variant="ghost" size="sm" onClick={onEdit}>
              Editar
            </Button>
            <button
              onClick={onToggle}
              aria-label={config.status === "active" ? "Desativar número" : "Ativar número"}
              className="flex items-center justify-center h-8 w-8 coarse:h-11 coarse:w-11 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
            >
              <Power size={16} />
            </button>
            <button
              onClick={onDelete}
              aria-label="Excluir número"
              className="flex items-center justify-center h-8 w-8 coarse:h-11 coarse:w-11 rounded-full text-semantic-error hover:bg-semantic-error/10 transition-colors"
            >
              <Trash2 size={16} />
            </button>
          </PermissionGate>
        </div>
      </div>

      <div className="mt-3">
        <ChannelTranscriptionToggle
          organizationId={organizationId}
          configId={config._id}
          checked={config.autoTranscribeAudio}
          description="Transcreve automaticamente os áudios recebidos dos contatos e os enviados pela equipe (pelo HNBCRM ou pelo celular). A transcrição fica no histórico e o Atendente IA a lê."
        />
      </div>

      {isBridge && (
        <div className="mt-3 rounded-lg bg-surface-base border border-border-subtle p-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-start gap-2">
              <BellRing size={16} className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true" />
              <div className="min-w-0">
                <span className="text-sm text-text-primary">Notificações no celular</span>
                <p className="text-xs text-text-muted mt-0.5">
                  {phoneNotificationsOn
                    ? "O HNBCRM fica invisível como aparelho conectado, então o WhatsApp continua tocando e notificando no telefone. Recomendado."
                    : "O número aparece \"online\" enquanto o HNBCRM estiver conectado e o WhatsApp silencia as notificações no celular."}
                </p>
              </div>
            </div>
            <PermissionGate
              organizationId={organizationId}
              category="settings"
              level="manage"
              fallback={
                <Badge variant={phoneNotificationsOn ? "success" : "default"}>
                  {phoneNotificationsOn ? "Ativado" : "Desativado"}
                </Badge>
              }
            >
              <Switch
                checked={phoneNotificationsOn}
                onCheckedChange={onTogglePhoneNotifications}
                label="Notificações no celular"
                hideLabel
              />
            </PermissionGate>
          </div>
          <p className="mt-1.5 text-xs text-text-muted">
            A mudança vale na hora e é reforçada a cada 15 minutos. Abrir uma conversa no inbox continua marcando como lida no WhatsApp.
          </p>
        </div>
      )}

      {isBridge && <BridgeHistoryPanel organizationId={organizationId} config={config} />}

      {isBridge && <BridgeGroupsPanel organizationId={organizationId} config={config} />}

      {/* Meta: verify token footer. QR code: dados da conexão (sem segredos). */}
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
        <details className="mt-3 rounded-lg bg-surface-base border border-border-subtle p-2.5 text-xs text-text-muted">
          <summary className="cursor-pointer select-none py-1 coarse:min-h-11 text-text-secondary">Detalhes técnicos</summary>
          <div className="mt-1 space-y-0.5 break-all">
          {config.bridgeBaseUrl && (
            <div>
              Servidor de conexão: <span className="font-mono text-text-secondary">{config.bridgeBaseUrl}</span>
            </div>
          )}
          {config.bridgeInstanceId && (
            <div>
              ID da conexão: <span className="font-mono text-text-secondary">{config.bridgeInstanceId}</span>
            </div>
          )}
          </div>
        </details>
      )}
    </div>
  );
}
