import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { resolveOrgTimezone } from "@/lib/agendaZone";

/**
 * Fuso IANA da organização (`settings.timezone`), para a Agenda v2 formatar e converter datas no fuso da
 * org e não no do navegador. Org sem fuso gravado usa o mesmo default do servidor. Reaproveita
 * `getUserOrganizations` (a mesma assinatura que o `AuthLayout` já mantém).
 */
export function useOrgTimezone(organizationId: Id<"organizations"> | undefined | null): string {
  const orgs = useQuery(api.organizations.getUserOrganizations);
  const org = orgs?.find((o) => o?._id === organizationId);
  return resolveOrgTimezone(org?.settings?.timezone);
}
