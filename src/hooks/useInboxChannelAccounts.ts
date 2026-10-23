import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { InboxChannelAccount } from "@/lib/channelAccounts";

const EMPTY: InboxChannelAccount[] = [];

/**
 * Contas de canal da org (WhatsApp, Instagram, Messenger) para rótulo de origem
 * e chips de filtro. UMA assinatura por inbox, nunca por linha (D11).
 */
export function useInboxChannelAccounts(organizationId: Id<"organizations"> | undefined | null): {
  accounts: InboxChannelAccount[];
  byId: Map<string, InboxChannelAccount>;
  isLoading: boolean;
} {
  const data = useQuery(
    api.channelConfigs.getInboxChannelAccounts,
    organizationId ? { organizationId } : "skip"
  );
  const accounts = (data as InboxChannelAccount[] | undefined) ?? EMPTY;
  const byId = useMemo(() => new Map(accounts.map((a) => [a._id as string, a])), [accounts]);
  return { accounts, byId, isLoading: organizationId ? data === undefined : false };
}
