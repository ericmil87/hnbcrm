import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { NavBadgeSource, NavItemDef } from "@/lib/nav";


/** Quais contagens precisam de query: só as de itens visíveis (as demais usam `"skip"`). */
export function badgeQueriesFor(visibleItems: ReadonlyArray<NavItemDef>): Record<NavBadgeSource, boolean> {
  const enabled: Record<NavBadgeSource, boolean> = {
    inboxUnread: false,
    pendingAttention: false,
    pausedCampaigns: false,
  };
  for (const item of visibleItems) {
    if (item.badge) enabled[item.badge] = true;
  }
  return enabled;
}


/** Contagens dos badges do menu (Conversas, Requer atenção, Campanhas). Zero enquanto carrega ou oculto. */
export function useNavBadges(
  organizationId: Id<"organizations">,
  visibleItems: ReadonlyArray<NavItemDef>
): Record<NavBadgeSource, number> {
  const enabled = badgeQueriesFor(visibleItems);
  const inboxUnread = useQuery(
    api.conversations.getInboxUnreadCount,
    enabled.inboxUnread ? { organizationId } : "skip"
  );
  const pendingAttention = useQuery(
    api.handoffs.getPendingHandoffCount,
    enabled.pendingAttention ? { organizationId } : "skip"
  );
  const pausedCampaigns = useQuery(
    api.campaigns.getPausedCount,
    enabled.pausedCampaigns ? { organizationId } : "skip"
  );
  return {
    inboxUnread: inboxUnread ?? 0,
    pendingAttention: pendingAttention ?? 0,
    pausedCampaigns: pausedCampaigns ?? 0,
  };
}
