import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

export interface OrgModules {
  units: boolean;
  departments: boolean;
  attribution: boolean;
  central: boolean;
  demoMode: boolean;
}

const ALL_OFF: OrgModules = {
  units: false,
  departments: false,
  attribution: false,
  central: false,
  demoMode: false,
};

/**
 * Módulos opcionais da org (MVP "Central"). Enquanto carrega — ou sem org —
 * tudo vem DESLIGADO: org que não ligou nada nunca vê a UI nova, nem por um
 * frame.
 */
export function useOrgModules(organizationId: Id<"organizations"> | undefined | null): {
  modules: OrgModules;
  isLoading: boolean;
  anyEnabled: boolean;
} {
  const data = useQuery(
    api.orgModules.getOrgModules,
    organizationId ? { organizationId } : "skip"
  );
  const modules = data ?? ALL_OFF;
  return {
    modules,
    isLoading: organizationId ? data === undefined : false,
    anyEnabled: modules.units || modules.departments || modules.attribution || modules.central,
  };
}
