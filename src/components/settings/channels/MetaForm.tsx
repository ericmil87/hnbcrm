import { useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { Input } from "@/components/ui/Input";
import { Copy, Check, Dices } from "lucide-react";
import type { ChannelConfig, CreateChannelConfigFn, UpdateChannelConfigFn } from "./types";
import { copyToClipboard } from "./copyToClipboard";

// URL pública do webhook da Meta: o deployment ".convex.cloud" do cliente mapeia para o host HTTP ".convex.site".
const CONVEX_SITE = ((import.meta.env.VITE_CONVEX_URL as string) ?? "").replace(".convex.cloud", ".convex.site");
const WEBHOOK_CALLBACK_URL = `${CONVEX_SITE}/webhooks/whatsapp`;

export function MetaForm({
  organizationId,
  config,
  onClose,
  createChannelConfig,
  updateChannelConfig,
  onBack,
  onCreated,
}: {
  organizationId: Id<"organizations">;
  config: ChannelConfig | null;
  onClose: () => void;
  createChannelConfig: CreateChannelConfigFn;
  updateChannelConfig: UpdateChannelConfigFn;
  onBack?: () => void;
  /** Número novo criado (segue o fluxo do chamador em vez de só fechar). */
  onCreated?: (configId: Id<"channelConfigs">) => void;
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

  const [webhookCopied, setWebhookCopied] = useState(false);
  const handleCopyWebhook = async () => {
    await copyToClipboard(WEBHOOK_CALLBACK_URL, "URL de callback copiada");
    setWebhookCopied(true);
    setTimeout(() => setWebhookCopied(false), 2000);
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
        ).unwrap();
      } else {
        const id = await toast.promise(
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
        ).unwrap();
        if (onCreated) {
          onCreated(id);
          return;
        }
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

      <CollapsibleSection title="Detalhes técnicos">
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            No app da Meta (Meta for Developers), use esta URL de callback ao configurar o webhook do WhatsApp,
            assinando o campo <span className="font-mono text-text-secondary">messages</span>.
          </p>
          <div className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-surface-base p-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="break-all font-mono text-sm text-text-primary">{WEBHOOK_CALLBACK_URL}</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="shrink-0 self-start sm:self-auto"
              onClick={() => void handleCopyWebhook()}
            >
              {webhookCopied ? <Check size={14} /> : <Copy size={14} />}
              Copiar URL
            </Button>
          </div>
          <ol className="list-inside list-decimal space-y-2 text-sm text-text-secondary">
            <li>Crie um app na Meta for Developers do tipo Business.</li>
            <li>Adicione o produto WhatsApp e anote o Phone Number ID e o WABA ID.</li>
            <li>Crie um System User no Business Manager e gere um token de acesso permanente.</li>
            <li>Copie o App Secret nas configurações do app.</li>
            <li>
              Configure o webhook com a URL de callback e o Verify Token acima, assinando o campo{" "}
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
      </CollapsibleSection>

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
