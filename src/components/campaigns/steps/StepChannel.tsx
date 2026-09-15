import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { AlertTriangle, Cloud, Gauge, Radio, ShieldAlert } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import type { ChannelConfigItem, SafeDefaults } from "../types";
import type { WizardDraft } from "../wizardState";

interface StepChannelProps {
  organizationId: Id<"organizations">;
  draft: WizardDraft;
  setDraft: (updater: (prev: WizardDraft) => WizardDraft) => void;
  locked: boolean; // campanha já lançada/pausada não troca de canal
  now: number;
}

const SESSION_LABELS: Record<string, { label: string; variant: "success" | "warning" | "error" | "default" }> = {
  connected: { label: "Conectado", variant: "success" },
  connecting: { label: "Conectando", variant: "warning" },
  qr: { label: "Aguardando QR", variant: "warning" },
  disconnected: { label: "Desconectado", variant: "error" },
  banned: { label: "Banido", variant: "error" },
};

export function StepChannel({ organizationId, draft, setDraft, locked, now }: StepChannelProps) {
  const channels = useQuery(api.channelConfigs.getChannelConfigs, { organizationId }) as
    | ChannelConfigItem[]
    | undefined;
  const whatsappChannels = (channels ?? []).filter((c) => c.status !== "disabled");

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Nome da campanha"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="Ex.: Promoção de setembro"
          maxLength={80}
        />
        <Input
          label="Descrição (opcional)"
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          placeholder="Para a equipe entender o objetivo"
          maxLength={200}
        />
      </div>

      <div>
        <p className="text-[13px] font-medium text-text-secondary mb-2">Número que vai disparar</p>
        {channels === undefined ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : whatsappChannels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
            Nenhum canal WhatsApp ativo. Conecte um número em Configurações → Canais.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {whatsappChannels.map((channel) => {
              const selected = draft.channelConfigId === channel._id;
              const isBridge = channel.provider === "bridge";
              const session = channel.bridgeSessionState ? SESSION_LABELS[channel.bridgeSessionState] : null;
              return (
                <button
                  key={channel._id}
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      channelConfigId: channel._id,
                      provider: channel.provider,
                      // Trocar de canal invalida limites/segurança calculados p/ o anterior
                      pacing: d.channelConfigId === channel._id ? d.pacing : null,
                      safety: d.channelConfigId === channel._id ? d.safety : {},
                      tierAtLaunch: null,
                      content:
                        channel.provider === "bridge" && d.content.kind === "template"
                          ? { kind: "text", variants: [{ text: "" }], contentType: "text" }
                          : d.content,
                    }))
                  }
                  className={cn(
                    "text-left rounded-lg border p-3.5 transition-colors min-h-[44px]",
                    selected
                      ? "border-brand-500 bg-brand-500/10"
                      : "border-border bg-surface-sunken hover:bg-surface-overlay",
                    locked && "opacity-60 cursor-not-allowed"
                  )}
                  aria-pressed={selected}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-text-primary">{channel.displayName}</span>
                    <Badge variant={isBridge ? "warning" : "brand"}>
                      <span className="inline-flex items-center gap-1">
                        {isBridge ? <Radio size={11} /> : <Cloud size={11} />}
                        {isBridge ? "Bridge" : "Cloud API"}
                      </span>
                    </Badge>
                    {session && <Badge variant={session.variant}>{session.label}</Badge>}
                    {channel.status === "error" && <Badge variant="error">Erro</Badge>}
                  </div>
                  {channel.displayPhoneNumber && (
                    <p className="text-sm text-text-secondary mt-1 tabular-nums">{channel.displayPhoneNumber}</p>
                  )}
                  <p className="text-xs text-text-muted mt-1">
                    {isBridge
                      ? "Sem janela de 24h nem templates. Risco de banimento — limites conservadores."
                      : "Templates aprovados pela Meta para números novos; cobrança por mensagem."}
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {draft.channelConfigId && <ChannelHealth channelConfigId={draft.channelConfigId} draft={draft} setDraft={setDraft} now={now} />}
    </div>
  );
}

function ChannelHealth({
  channelConfigId,
  draft,
  setDraft,
  now,
}: {
  channelConfigId: Id<"channelConfigs">;
  draft: WizardDraft;
  setDraft: StepChannelProps["setDraft"];
  now: number;
}) {
  const defaults = useQuery(api.campaigns.getSafeDefaults, {
    channelConfigId,
    now,
    ...(draft.tierAtLaunch ? { tier: draft.tierAtLaunch } : {}),
  }) as SafeDefaults | undefined;
  const readTier = useAction(api.whatsappTemplates.readMetaTier);
  const [readingTier, setReadingTier] = useState(false);

  if (!defaults) return null;
  const isBridge = defaults.provider === "bridge";
  const ageDays = Math.max(1, Math.floor((now - defaults.connectedAt) / 86_400_000) + 1);

  const handleReadTier = async () => {
    setReadingTier(true);
    try {
      const result = await readTier({ channelConfigId });
      setDraft((d) => ({ ...d, tierAtLaunch: result.tier }));
      toast.success(
        result.limit ? `Limite do portfólio: ${result.limit.toLocaleString("pt-BR")} destinatários/dia` : `Limite: ${result.tier}`
      );
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível ler o limite na Meta"));
    } finally {
      setReadingTier(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <Gauge size={16} className="text-brand-500" />
        Saúde do número para campanhas
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <Stat label={isBridge ? "Idade da conexão" : "Idade do canal"} value={`${ageDays} dia${ageDays > 1 ? "s" : ""}`} />
        {isBridge ? (
          <Stat label="Dia de aquecimento" value={`${defaults.warmupDay}`} />
        ) : (
          <Stat label="Tier da Meta" value={draft.tierAtLaunch ?? defaults.tier ?? "não lido"} />
        )}
        <Stat label="Máx. seguro/dia" value={`${defaults.safe.maxPerDay}`} />
        <Stat label="Delay seguro" value={`${defaults.safe.minDelaySec}–${defaults.safe.maxDelaySec}s`} />
      </div>
      {!isBridge && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={() => void handleReadTier()} disabled={readingTier}>
            {readingTier ? <Spinner size="sm" /> : null}
            Ler limite na Meta
          </Button>
          <span className="text-xs text-text-muted">
            O limite é por portfólio (250 → 2.000 → 10.000 → 100.000 → ilimitado). Sem leitura, o modo seguro assume 250.
          </span>
        </div>
      )}
      {defaults.newNumberRisk && (
        <div className="flex items-start gap-2 rounded-lg border border-semantic-error/40 bg-semantic-error/10 p-3 text-sm text-text-primary">
          <ShieldAlert size={16} className="shrink-0 text-semantic-error mt-0.5" />
          <div>
            <p className="font-medium">Número recém-conectado — risco alto de banimento</p>
            <p className="mt-0.5 text-text-secondary">{defaults.newNumberRisk}</p>
          </div>
        </div>
      )}
      {!defaults.newNumberRisk && defaults.warmupWarning && (
        <div className="flex items-start gap-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3 text-sm text-text-primary">
          <AlertTriangle size={16} className="shrink-0 text-semantic-warning mt-0.5" />
          <span>{defaults.warmupWarning}</span>
        </div>
      )}
      {isBridge && (
        <p className="text-xs text-text-muted">
          Aquecimento reduz o risco, mas não o elimina: o que derruba o número é denúncia e bloqueio de quem não pediu contato.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-raised border border-border px-3 py-2">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className="font-semibold text-text-primary tabular-nums">{value}</p>
    </div>
  );
}
