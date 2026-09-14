import { useQuery } from "convex/react";
import { useNavigate } from "react-router";
import { ExternalLink, Megaphone, MessageSquare } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { TAB_ROUTES } from "@/lib/routes";
import type { CampaignStatus, RecipientStatus } from "./types";
import {
  CAMPAIGN_STATUS_LABELS,
  RECIPIENT_STATUS_LABELS,
  RECIPIENT_STATUS_VARIANT,
  formatDateTime,
} from "./campaignUtils";

interface LeadCampaignRow {
  recipientId: string;
  campaignId: Id<"campaigns">;
  campaignName: string;
  campaignStatus: CampaignStatus;
  provider: "meta" | "bridge";
  status: RecipientStatus;
  sentAt: number | null;
  deliveredAt: number | null;
  readAt: number | null;
  repliedAt: number | null;
  lastError: string | null;
  conversationId: Id<"conversations"> | null;
  createdAt: number;
}

/** Campanhas de que este lead participou (aba do LeadDetailPanel). */
export function LeadCampaignsSection({ leadId }: { leadId: Id<"leads"> }) {
  const navigate = useNavigate();
  const rows = useQuery(api.campaigns.getCampaignsForLead, { leadId }) as LeadCampaignRow[] | undefined;

  if (rows === undefined) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-6 text-center">
        <Megaphone size={32} className="mx-auto text-text-muted mb-2" />
        <p className="text-sm text-text-muted">Este lead ainda não recebeu nenhuma campanha.</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.recipientId} className="px-4 py-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`${TAB_ROUTES.campaigns}?campanha=${r.campaignId}`)}
              className="text-sm font-medium text-text-primary hover:text-brand-400 truncate text-left flex-1 min-h-[36px]"
            >
              {r.campaignName}
            </button>
            <Badge variant={RECIPIENT_STATUS_VARIANT[r.status]}>{RECIPIENT_STATUS_LABELS[r.status]}</Badge>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-xs text-text-muted">
            <span>{CAMPAIGN_STATUS_LABELS[r.campaignStatus]}</span>
            <span>·</span>
            <span>{r.provider === "bridge" ? "Bridge" : "Cloud API"}</span>
            {r.sentAt && (
              <>
                <span>·</span>
                <span className="tabular-nums">enviada {formatDateTime(r.sentAt)}</span>
              </>
            )}
            {r.repliedAt && (
              <>
                <span>·</span>
                <span className="tabular-nums text-semantic-success">respondeu {formatDateTime(r.repliedAt)}</span>
              </>
            )}
            {r.lastError && (
              <>
                <span>·</span>
                <span className="text-semantic-error">{r.lastError}</span>
              </>
            )}
            {r.conversationId && (
              <button
                type="button"
                onClick={() => navigate(`${TAB_ROUTES.inbox}?conversation=${r.conversationId}`)}
                className="ml-auto inline-flex items-center gap-1 text-brand-500 hover:text-brand-400 min-h-[36px]"
              >
                <MessageSquare size={12} /> conversa <ExternalLink size={11} />
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
