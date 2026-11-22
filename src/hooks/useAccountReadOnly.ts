import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { isEffectivelyReadOnly } from "@/lib/billingPanel";
import { useNow } from "./useNow";

/**
 * Conta em modo leitura (plano vencido, teste acabado)? Mesma regra do Composer: `readOnly` do servidor ou
 * teste vencido que o cron ainda não virou. Usa `getMyEntitlements`, que Configurações e o AppShell já assinam.
 * Ainda carregando = `false` (o servidor continua sendo a barreira).
 */
export function useAccountReadOnly(organizationId: Id<"organizations"> | undefined | null): boolean {
  const entitlements = useQuery(api.billing.getMyEntitlements, organizationId ? { organizationId } : "skip");
  const now = useNow(true, 5 * 60_000);
  return isEffectivelyReadOnly(entitlements, now);
}
