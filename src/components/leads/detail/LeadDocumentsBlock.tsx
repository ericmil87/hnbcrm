import type { Id } from "../../../../convex/_generated/dataModel";
import { LeadDocuments } from "@/components/LeadDocuments";

/** "Documentos" do lead. Fica como bloco próprio para a aba Detalhes só compor. */
export function LeadDocumentsBlock({ leadId, organizationId }: { leadId: Id<"leads">; organizationId: Id<"organizations"> }) {
  return <LeadDocuments leadId={leadId} organizationId={organizationId} />;
}
