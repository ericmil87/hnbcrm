import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

export interface OrgModules {
  units: boolean;
  departments: boolean;
  attribution: boolean;
  central: boolean;
  demoMode: boolean;
  /** Instagram e Messenger (Meta Messaging). NÃO acende a Central. */
  metaMessaging: boolean;
}

const ALL_OFF: OrgModules = {
  units: false,
  departments: false,
  attribution: false,
  central: false,
  demoMode: false,
  metaMessaging: false,
};

/** Gate da Central: `metaMessaging` e `demoMode` ficam de fora de propósito. */
export function computeAnyEnabled(m: OrgModules): boolean {
  return m.units || m.departments || m.attribution || m.central;
}

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
    anyEnabled: computeAnyEnabled(modules),
  };
}
