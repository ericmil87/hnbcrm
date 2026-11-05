import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { resolveDefaultCountry } from "../../../../convex/lib/orgPhone";

/** DDI padrão da organização (ex.: "55"), ou `undefined` enquanto carrega. */
export function useOrgDefaultCountry(organizationId: Id<"organizations">): string | undefined {
  const orgs = useQuery(api.organizations.getUserOrganizations);
  const org = orgs?.find((o) => o?._id === organizationId);
  return org ? resolveDefaultCountry(org.settings) : undefined;
}
