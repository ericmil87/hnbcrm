import { useState } from "react";
import { toast } from "sonner";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { QrRiskNotice } from "./QrRiskNotice";
import type {
  ChannelConfig,
  CreateChannelConfigFn,
  CreateManagedChannelFn,
  UpdateChannelConfigFn,
} from "./types";

/** Servidor gerenciado do HNBCRM: quando existe, criar o número não pede URL nem token. */
export interface QrConnectDefaults {
  managedAvailable: boolean;
  managedGatewayUrl?: string | null;
}

/** De onde vem a conexão: servidor do HNBCRM, servidor próprio (criar) ou conexão que já existe. */
type Source = "managed" | "own" | "existing";

interface QrCodeConnectFormProps {
  organizationId: Id<"organizations">;
  /** Edição de um número existente; sem isso é um número novo. */
  config: ChannelConfig | null;
  /** `undefined` enquanto carrega. */
  defaults: QrConnectDefaults | undefined;
  onClose: () => void;
  createChannelConfig: CreateChannelConfigFn;
  updateChannelConfig: UpdateChannelConfigFn;
  createManagedChannel: CreateManagedChannelFn;
  /** Número novo criado: segue para o passo de conexão. */
  onCreated?: (configId: Id<"channelConfigs">) => void;
  onBack?: () => void;
}

/**
 * Formulário do WhatsApp por QR code. Número novo: aviso de risco com aceite e "Conectar número"
 * (os campos manuais ficam no bloco "Configuração manual (avançado)"). Edição: nome e, no bloco
 * avançado, os dados da conexão (segredos sempre mascarados).
 */
export function QrCodeConnectForm({
  organizationId,
  config,
  defaults,
  onClose,
  createChannelConfig,
  updateChannelConfig,
  createManagedChannel,
  onCreated,
  onBack,
}: QrCodeConnectFormProps) {
  const isEditing = !!config;
  const managedAvailable = defaults?.managedAvailable ?? false;
  const [sourceOverride, setSourceOverride] = useState<Source | null>(null);
  const source: Source = sourceOverride ?? (managedAvailable ? "managed" : "existing");
  const [form, setForm] = useState(() => ({
    displayName: config?.displayName ?? "WhatsApp",
    bridgeBaseUrl: config?.bridgeBaseUrl ?? "",
    bridgeInstanceId: config?.bridgeInstanceId ?? "",
    bridgeToken: "",
    adminToken: "",
  }));
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [saving, setSaving] = useState(false);

  // Editar um número que já existe não pede o aceite de novo.
  const needsRiskAck = !isEditing;

  const finish = (id?: Id<"channelConfigs">) => {
    if (id && onCreated) onCreated(id);
    else onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (needsRiskAck && !riskAccepted) {
      toast.error("Aceite o aviso de risco para conectar por QR code.");
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
            success: "Número atualizado",
            error: (error) => (error instanceof Error ? error.message : "Não foi possível atualizar o número."),
          }
        ).unwrap();
        finish();
      } else if (source === "existing") {
        const id = await toast.promise(
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
            loading: "Conectando número…",
            success: "Número adicionado",
            error: (error) => (error instanceof Error ? error.message : "Não foi possível conectar o número."),
          }
        ).unwrap();
        finish(id);
      } else {
        const id = await toast.promise(
          createManagedChannel({
            organizationId,
            displayName: form.displayName,
            ...(source === "managed"
              ? { useManagedGateway: true }
              : { bridgeBaseUrl: form.bridgeBaseUrl, adminToken: form.adminToken }),
          }),
          {
            loading: "Conectando número…",
            success: "Número adicionado",
            error: (error) => (error instanceof Error ? error.message : "Não foi possível conectar o número."),
          }
        ).unwrap();
        finish(id);
      }
    } catch {
      // toast.promise já mostrou o erro
    } finally {
      setSaving(false);
    }
  };

  // Evita piscar: o padrão depende de haver servidor do HNBCRM.
  if (!isEditing && defaults === undefined) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  const sourceOptions = [
    ...(managedAvailable ? [{ value: "managed", label: "Servidor do HNBCRM" }] : []),
    { value: "own", label: "Criar no meu servidor" },
    { value: "existing", label: "Conexão existente" },
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {needsRiskAck && <QrRiskNotice accepted={riskAccepted} onAcceptedChange={setRiskAccepted} />}

      <Input
        label="Nome de exibição"
        type="text"
        value={form.displayName}
        onChange={(e) => setForm({ ...form, displayName: e.target.value })}
        placeholder="ex.: WhatsApp vendas (QR code)"
        required
      />

      <CollapsibleSection title="Configuração manual (avançado)" defaultOpen={isEditing || !managedAvailable}>
        <div className="space-y-4">
          {!isEditing && (
            <SegmentedControl
              ariaLabel="Origem da conexão"
              value={source}
              onValueChange={(v) => setSourceOverride(v as Source)}
              options={sourceOptions}
              className="w-full"
            />
          )}

          {!isEditing && source === "managed" && (
            <p className="text-xs text-text-secondary">
              A conexão será criada automaticamente no servidor do HNBCRM{" "}
              {defaults?.managedGatewayUrl && (
                <span className="break-all font-mono">({defaults.managedGatewayUrl})</span>
              )}{" "}
              , sem URL nem token para configurar.
            </p>
          )}

          {(isEditing || source !== "managed") && (
            <Input
              label="URL do servidor de conexão"
              type="text"
              value={form.bridgeBaseUrl}
              onChange={(e) => setForm({ ...form, bridgeBaseUrl: e.target.value })}
              placeholder="ex: https://wa-gw.seudominio.com.br"
              required
            />
          )}

          {(isEditing || source === "existing") && (
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
                <p className="-mt-2 text-[13px] text-text-muted">
                  O ID da conexão não pode ser alterado. Deixe o token em branco para manter o atual; ele fica
                  sempre mascarado.
                </p>
              )}
            </>
          )}

          {!isEditing && source === "own" && (
            <>
              <Input
                label="Token de administrador do servidor"
                type="password"
                value={form.adminToken}
                onChange={(e) => setForm({ ...form, adminToken: e.target.value })}
                placeholder="Token de administração do servidor"
                required
              />
              <p className="-mt-2 text-[13px] text-text-muted">
                Usado só uma vez para criar a conexão. Não é armazenado.
              </p>
            </>
          )}
        </div>
      </CollapsibleSection>

      <div className="flex gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onBack ?? onClose} className="flex-1">
          {onBack ? "Voltar" : "Cancelar"}
        </Button>
        <Button type="submit" className="flex-1" disabled={saving || (needsRiskAck && !riskAccepted)}>
          {saving ? "Salvando…" : isEditing ? "Salvar" : "Conectar número"}
        </Button>
      </div>
    </form>
  );
}
