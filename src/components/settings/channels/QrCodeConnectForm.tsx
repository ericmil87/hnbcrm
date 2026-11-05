import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChannelConfig, CreateChannelConfigFn, UpdateChannelConfigFn, ProvisionBridgeFn } from "./types";

// --- Bridge (unofficial gateway) form — manual config OR assisted provisioning ---
// Derive the public webhook callback host from the Convex deployment URL
// (client-facing ".convex.cloud" deployment maps to the HTTP action host ".convex.site")
const CONVEX_SITE = ((import.meta.env.VITE_CONVEX_URL as string) ?? "").replace(
  ".convex.cloud",
  ".convex.site"
);
const BRIDGE_WEBHOOK_URL = `${CONVEX_SITE}/webhooks/bridge`;

export function QrCodeConnectForm({
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
      toast.error("É preciso aceitar os termos de risco para conectar por QR code.");
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
            loading: "Salvando alterações…",
            success: "Canal atualizado",
            error: (error) => (error instanceof Error ? error.message : "Não foi possível atualizar canal."),
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
            loading: "Conectando número…",
            success: "Número criado. Mostre o QR code para conectar",
            error: (error) => (error instanceof Error ? error.message : "Não foi possível conectar o número."),
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
            loading: "Conectando canal…",
            success: "Canal conectado. Mostre o QR code para conectar",
            error: (error) => (error instanceof Error ? error.message : "Não foi possível conectar canal."),
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
            <li>Usa um protocolo não sancionado pela Meta e viola os Termos de uso do WhatsApp.</li>
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
              Termos de uso
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
            Conexão existente
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
            Criar nova conexão
          </button>
        </div>
      )}

      <Input
        label="Nome de exibição"
        type="text"
        value={form.displayName}
        onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        placeholder="ex.: WhatsApp vendas (QR code)"
        required
      />
      {(isEditing || mode === "manual" || gatewayChoice === "custom") && (
        <Input
          label="URL do servidor de conexão"
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
            label="ID da conexão"
            type="text"
            value={form.bridgeInstanceId}
            onChange={(e) => setForm({ ...form, bridgeInstanceId: e.target.value })}
            placeholder="ex: org_minhaempresa"
            required={!isEditing}
            disabled={isEditing}
          />
          <Input
            label="Token da conexão"
            type="password"
            value={form.bridgeToken}
            onChange={(e) => setForm({ ...form, bridgeToken: e.target.value })}
            placeholder={isEditing ? "•••• (cole para substituir)" : "Token da conexão"}
            required={!isEditing}
          />
          {isEditing && (
            <p className="text-[13px] text-text-muted -mt-2">
              O ID da conexão não pode ser alterado. Deixe o token em branco para manter o atual.
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
            A conexão será criada automaticamente no servidor gerenciado do HNBCRM{" "}
            {bridgeDefaults?.managedGatewayUrl && (
              <span className="font-mono break-all">({bridgeDefaults.managedGatewayUrl})</span>
            )}{" "}
            — sem URL nem token para configurar. Depois é só escanear o QR code para conectar o número.
          </p>
        </div>
      ) : (
        <>
          <Input
            label="Token de administrador do servidor"
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
          {saving ? "Salvando…" : mode === "assisted" && !isEditing ? "Conectar" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}
