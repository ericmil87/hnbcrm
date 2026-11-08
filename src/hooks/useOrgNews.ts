import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { otherOrgNews, type OrgNewsEntry } from "@/lib/notificationInbox";

/**
 * Novidades (avisos novos desde o último "visto") das OUTRAS organizações do
 * usuário. O servidor entrega uma contagem por vínculo ativo (teto 20).
 */
export function useOrgNews(activeOrgId: string | null, enabled = true): {
  others: OrgNewsEntry[];
  byOrg: Record<string, number>;
  total: number;
} {
  const list = useQuery(api.notifications.unreadCountsByUser, enabled ? {} : "skip");
  return useMemo(() => {
    const others = otherOrgNews(list, activeOrgId);
    const byOrg: Record<string, number> = {};
    for (const o of others) byOrg[o.organizationId] = o.unseen;
    return { others, byOrg, total: others.reduce((sum, o) => sum + o.unseen, 0) };
  }, [list, activeOrgId]);
}
