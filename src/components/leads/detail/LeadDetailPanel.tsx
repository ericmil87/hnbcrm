import { useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { LeadCampaignsSection } from "@/components/campaigns/LeadCampaignsSection";
import { LeadConversationTab } from "./LeadConversationTab";
import { LeadActionsMenu } from "./LeadActionsMenu";
import { DetailsTab } from "./LeadDetailsTab";
import { TasksTab } from "./LeadTasksTab";
import { ActivityTab } from "./LeadActivityTab";
import { cn } from "@/lib/utils";

interface LeadDetailPanelProps {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  onClose: () => void;
  /** Aba aberta ao montar o painel. Padrão: "conversation". */
  initialTab?: Tab;
}

type Tab = "conversation" | "details" | "tasks" | "campaigns" | "activity";

export function LeadDetailPanel({ leadId, organizationId, onClose, initialTab }: LeadDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? "conversation");

  const tabLabels: Record<Tab, string> = {
    conversation: "Conversa",
    details: "Detalhes",
    tasks: "Tarefas",
    campaigns: "Campanhas",
    activity: "Atividade",
  };

  return (
    <SlideOver
      open={true}
      onClose={onClose}
      title="Detalhes do lead"
      headerActions={
        <LeadActionsMenu leadId={leadId} organizationId={organizationId} onDeleted={onClose} />
      }
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
    >
      {/* Tab Bar */}
      <div className="flex shrink-0 border-b border-border bg-surface-raised">
        {(["conversation", "details", "tasks", "campaigns", "activity"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex-1 px-2 md:px-3 py-3 text-xs md:text-sm font-medium text-center transition-colors whitespace-nowrap",
              activeTab === tab
                ? "text-brand-500 border-b-2 border-brand-500"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 min-h-0">
        {activeTab === "conversation" && (
          <LeadConversationTab leadId={leadId} organizationId={organizationId} />
        )}
        {activeTab === "details" && (
          <div className="h-full overflow-y-auto">
            <DetailsTab leadId={leadId} organizationId={organizationId} />
          </div>
        )}
        {activeTab === "tasks" && (
          <div className="h-full overflow-y-auto">
            <TasksTab leadId={leadId} organizationId={organizationId} />
          </div>
        )}
        {activeTab === "campaigns" && (
          <div className="h-full overflow-y-auto">
            <LeadCampaignsSection leadId={leadId} />
          </div>
        )}
        {activeTab === "activity" && (
          <div className="h-full overflow-y-auto">
            <ActivityTab leadId={leadId} />
          </div>
        )}
      </div>
    </SlideOver>
  );
}

