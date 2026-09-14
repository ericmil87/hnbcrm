import { AlertTriangle, Clock, DollarSign, Gauge, MessageSquareText, Radio, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { WhatsAppPreview } from "../WhatsAppPreview";
import type { CampaignPacing, CampaignSchedule } from "../types";
import { estimateCampaignDurationMs, formatDuration, formatUsd, pacingSummary, scheduleSummary } from "../campaignUtils";
import { SAMPLE_RECIPIENT_VARS, isWithinSafe, type WizardDraft } from "../wizardState";

interface StepReviewProps {
  draft: WizardDraft;
  recipientsTotal: number;
  channelName: string;
  safePacing: CampaignPacing | null;
  consentAck: boolean;
  bridgeRiskAck: boolean;
  onConsentAck: (v: boolean) => void;
  onBridgeRiskAck: (v: boolean) => void;
  canLaunch: boolean;
  estimatedCostUsd: number | null;
  warnings: string[];
}

export function StepReview({
  draft,
  recipientsTotal,
  channelName,
  safePacing,
  consentAck,
  bridgeRiskAck,
  onConsentAck,
  onBridgeRiskAck,
  canLaunch,
  estimatedCostUsd,
  warnings,
}: StepReviewProps) {
  const isBridge = draft.provider === "bridge";
  const pacing = draft.pacing;
  const schedule = draft.schedule as CampaignSchedule;
  const withinSafe = pacing && safePacing ? isWithinSafe(pacing, safePacing) : true;
  const durationMs = pacing && schedule ? estimateCampaignDurationMs(recipientsTotal, pacing, schedule) : 0;
  const previewText =
    draft.content.kind === "template"
      ? draft.content.template?.bodyText ?? `[template ${draft.content.template?.name ?? ""}]`
      : draft.content.variants[0]?.text ?? "";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <SummaryTile icon={Radio} label="Canal" value={channelName} sub={isBridge ? "Bridge (API não oficial)" : "Cloud API (Meta)"} />
          <SummaryTile
            icon={Users}
            label="Destinatários"
            value={draft.audience.source === "segment" ? "calculado no lançamento" : recipientsTotal.toLocaleString("pt-BR")}
            sub={draft.audience.source === "segment" ? "segmento congelado ao lançar" : draft.audience.source === "import" ? "importados" : "manuais"}
          />
          <SummaryTile
            icon={Clock}
            label="Duração estimada"
            value={draft.audience.source === "segment" ? "depende do público" : formatDuration(durationMs)}
            sub={schedule ? scheduleSummary(schedule) : ""}
          />
          <SummaryTile
            icon={DollarSign}
            label="Custo estimado"
            value={isBridge ? "sem custo da Meta" : formatUsd(estimatedCostUsd)}
            sub={isBridge ? "custo do seu gateway" : draft.content.template?.category ? `template ${draft.content.template.category.toLowerCase()}` : "texto livre na janela"}
          />
        </div>

        {pacing && (
          <div className={`rounded-lg border p-4 ${withinSafe ? "border-border bg-surface-sunken" : "border-semantic-warning/40 bg-semantic-warning/10"}`}>
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Gauge size={16} className={withinSafe ? "text-semantic-success" : "text-semantic-warning"} />
              {withinSafe ? "Limites no modo seguro" : "Limites ACIMA do modo seguro (override)"}
            </div>
            <p className="text-xs text-text-secondary mt-1">{pacingSummary(pacing)}</p>
          </div>
        )}

        <div className="rounded-lg border border-border bg-surface-sunken p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary mb-1">
            <MessageSquareText size={16} className="text-brand-500" />
            Mensagem
          </div>
          <p className="text-xs text-text-secondary">
            {draft.content.kind === "template"
              ? `Template «${draft.content.template?.name}» (${draft.content.template?.language})`
              : `${draft.content.variants.length} variante${draft.content.variants.length > 1 ? "s" : ""} de texto${draft.content.contentType && draft.content.contentType !== "text" ? ` + ${draft.content.contentType === "image" ? "imagem" : draft.content.contentType === "audio" ? "áudio" : "arquivo"}` : ""}`}
          </p>
        </div>

        {warnings.length > 0 && (
          <ul className="space-y-1.5">
            {warnings.map((w) => (
              <li key={w} className="flex items-start gap-2 text-sm text-text-secondary">
                <AlertTriangle size={14} className="shrink-0 mt-0.5 text-semantic-warning" />
                {w}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-4">
          <Checkbox
            checked={consentAck}
            onChange={(e) => onConsentAck(e.target.checked)}
            label="Declaro que a organização possui base legal (consentimento ou legítimo interesse documentado) para contatar esta lista"
            description="Exigido pela LGPD e pelos Termos de Uso. Quem pedir para parar entra na lista de supressão e nunca mais recebe campanha."
          />
          {isBridge && (
            <Checkbox
              checked={bridgeRiskAck}
              onChange={(e) => onBridgeRiskAck(e.target.checked)}
              label="Aceito e reconheço que a API não-oficial viola os Termos do WhatsApp e pode causar banimento permanente do número"
              description="Disparo em massa é o uso de maior risco do bridge, mesmo dentro dos limites seguros."
            />
          )}
          {!canLaunch && (
            <p className="text-xs text-text-muted">Você pode salvar o rascunho, mas só quem tem permissão total em Campanhas consegue lançar. Peça a um administrador.</p>
          )}
        </div>
      </div>

      <div>
        <WhatsAppPreview
          text={previewText}
          vars={SAMPLE_RECIPIENT_VARS}
          businessName={channelName}
          compact
        />
      </div>
    </div>
  );
}

function SummaryTile({ icon: Icon, label, value, sub }: { icon: React.ElementType; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-sunken px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
        <Icon size={12} /> {label}
      </div>
      <p className="text-sm font-semibold text-text-primary mt-0.5 truncate">{value}</p>
      {sub && <p className="text-[11px] text-text-muted truncate">{sub}</p>}
    </div>
  );
}
