import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Spinner } from "@/components/ui/Spinner";
import { LeadCentralSection } from "@/components/inbox/central/LeadCentralSection";
import { LeadContactBlock } from "./LeadContactBlock";
import { LeadOwnerStageBlock } from "./LeadOwnerStageBlock";
import { LeadBasicsBlock } from "./LeadBasicsBlock";
import { LeadCustomFieldsBlock } from "./LeadCustomFieldsBlock";
import { LeadQualificationBlock } from "./LeadQualificationBlock";
import { LeadDocumentsBlock } from "./LeadDocumentsBlock";

interface LeadDetailsTabProps {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
}

/** Aba "Detalhes": só carrega o lead e compõe os blocos; cada um salva o que é seu. */
export function LeadDetailsTab({ leadId, organizationId }: LeadDetailsTabProps) {
  const lead = useQuery(api.leads.getLead, { leadId });

  if (!lead) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-6">
      {/* Central (opcional por org): unidade, tipo de contato e origem */}
      <LeadCentralSection organizationId={organizationId} lead={lead} />
      <LeadContactBlock leadId={leadId} organizationId={organizationId} lead={lead} />
      <LeadOwnerStageBlock leadId={leadId} organizationId={organizationId} lead={lead} />
      <LeadBasicsBlock leadId={leadId} lead={lead} />
      <LeadCustomFieldsBlock
        leadId={leadId}
        organizationId={organizationId}
        customFields={(lead.customFields ?? {}) as Record<string, unknown>}
      />
      <LeadQualificationBlock leadId={leadId} lead={lead} />
      <LeadDocumentsBlock leadId={leadId} organizationId={organizationId} />
    </div>
  );
}
