import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { useOrgModules } from "@/hooks/useOrgModules";
import { ColorChip } from "./CentralChips";
import {
  attributionSourceMeta,
  contactKindLabel,
  formatStayRange,
  shortId,
  type LeadAttribution,
} from "./centralMeta";

interface LeadCentralSectionProps {
  organizationId: Id<"organizations">;
  lead: {
    unitId?: Id<"units">;
    contactKind?: string;
    attribution?: LeadAttribution;
    customFields?: Record<string, unknown>;
  };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 break-words text-right text-text-primary">{children}</span>
    </div>
  );
}

/**
 * Bloco da Central no painel do lead: unidade + tipo de contato (módulos
 * units/qualquer) e "Origem" (módulo attribution). Sem módulo, não renderiza.
 */
export function LeadCentralSection({ organizationId, lead }: LeadCentralSectionProps) {
  const { modules, anyEnabled } = useOrgModules(organizationId);
  const units = useQuery(api.units.listUnits, modules.units && lead.unitId ? { organizationId } : "skip");
  if (!anyEnabled) return null;

  const unit = lead.unitId ? units?.find((u) => u._id === lead.unitId) : undefined;
  const attribution = modules.attribution ? lead.attribution : undefined;
  const stay = formatStayRange(lead.customFields?.checkin, lead.customFields?.checkout);
  const guests = lead.customFields?.hospedes;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {modules.units && unit && (
          <ColorChip name={unit.name} color={unit.color} title={`Unidade: ${unit.name}`} className="max-w-[14rem]" />
        )}
        <span className="inline-flex items-center rounded-full bg-surface-overlay px-2 py-px text-[11px] font-medium text-text-secondary">
          {contactKindLabel(lead.contactKind)}
        </span>
        {stay && (
          <span className="inline-flex items-center rounded-full bg-semantic-success/10 px-2 py-px text-[11px] font-medium text-semantic-success tabular-nums">
            Estadia {stay}
            {typeof guests === "number" || typeof guests === "string" ? ` · ${guests} hósp.` : ""}
          </span>
        )}
      </div>

      {attribution && (
        <div>
          <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-text-secondary">Origem</h3>
          <div className="space-y-2 rounded-card bg-surface-sunken p-4 text-sm">
            {(() => {
              const meta = attributionSourceMeta(attribution.source);
              const Icon = meta.icon;
              return (
                <Row label="Canal">
                  <span className="inline-flex items-center gap-1.5">
                    <Icon size={14} className={meta.tone} aria-hidden />
                    {meta.label}
                  </span>
                </Row>
              );
            })()}
            {(attribution.campaignName || attribution.utmCampaign) && (
              <Row label="Campanha">{attribution.campaignName ?? attribution.utmCampaign}</Row>
            )}
            {attribution.adHeadline && <Row label="Anúncio">“{attribution.adHeadline}”</Row>}
            {attribution.utmTerm && <Row label="Termo">{attribution.utmTerm}</Row>}
            {(attribution.utmSource || attribution.utmMedium) && (
              <Row label="UTM">{[attribution.utmSource, attribution.utmMedium].filter(Boolean).join(" / ")}</Row>
            )}
            {attribution.ctwaClid && (
              <Row label="Clique (ctwa)">
                <span className="font-mono text-xs" title={attribution.ctwaClid}>
                  {shortId(attribution.ctwaClid)}
                </span>
              </Row>
            )}
            {attribution.gclid && (
              <Row label="Clique (gclid)">
                <span className="font-mono text-xs" title={attribution.gclid}>
                  {shortId(attribution.gclid)}
                </span>
              </Row>
            )}
            {attribution.adSourceUrl && /^https?:\/\//i.test(attribution.adSourceUrl) && (
              <Row label="Link">
                <a
                  href={attribution.adSourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded text-brand-500 hover:text-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  Ver anúncio
                </a>
              </Row>
            )}
            {attribution.capturedAt && (
              <Row label="Captado em">
                <span className="tabular-nums">
                  {new Date(attribution.capturedAt).toLocaleDateString("pt-BR")}
                </span>
              </Row>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
