import { useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Copy, Check, Dices, Cloud } from "lucide-react";
import type { ChannelConfig, CreateChannelConfigFn, UpdateChannelConfigFn } from "./types";
import { copyToClipboard } from "./copyToClipboard";

// --- Meta (Cloud API) form — unchanged behavior from the original ---
export function MetaForm({
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
            loading: "Salvando alterações…",
            success: "Número atualizado",
            error: (error) => (error instanceof Error ? error.message : "Não foi possível atualizar número."),
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
            loading: "Conectando número…",
            success: "Número conectado",
            error: (error) => (error instanceof Error ? error.message : "Não foi possível conectar número."),
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
        placeholder="ex.: Atendimento comercial"
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
          {saving ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}
