import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { zonedToday } from "@/lib/agendaZone";
import { useOrgTimezone } from "./useOrgTimezone";
import { useRoundedNow } from "./useRoundedNow";

export type AgendaConfig = NonNullable<FunctionReturnType<typeof api.schedulingConfig.getConfig>>;

/**
 * Configuração da Agenda (`getConfig`): serviços, recursos, ajustes e fechamentos a partir de hoje no fuso da
 * org. `config === undefined` carrega; `null` = sem acesso. `enabled=false` não assina.
 */
export function useAgendaConfig(organizationId: Id<"organizations">, enabled = true) {
  const timezone = useOrgTimezone(organizationId);
  const now = useRoundedNow(60 * 60_000);
  const today = zonedToday(now, timezone);
  const config = useQuery(api.schedulingConfig.getConfig, enabled ? { organizationId, closuresFrom: today } : "skip");
  return { config, timezone, today, now };
}
