import { useState } from "react";
import { useSearchParams } from "react-router";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SlideOver } from "@/components/ui/SlideOver";
import { cn } from "@/lib/utils";
import { Tabs, TabPanel } from "@/components/ui/Tabs";
import { LeadCampaignsSection } from "@/components/campaigns/LeadCampaignsSection";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import { DEFAULT_LEAD_TAB, LEAD_TAB_PARAM, isLeadTabInUrl, resolveLeadTab, type LeadTab } from "@/lib/leadTab";
import { LeadConversationTab } from "./LeadConversationTab";
import { LeadActionsMenu } from "./LeadActionsMenu";
import { LeadDetailsTab } from "./LeadDetailsTab";
import { LeadTasksTab } from "./LeadTasksTab";
import { LeadActivityTab } from "./LeadActivityTab";

const TAB_ITEMS: { id: LeadTab; label: string }[] = [
  { id: "conversation", label: "Conversa" },
  { id: "details", label: "Detalhes" },
  { id: "tasks", label: "Tarefas" },
  { id: "campaigns", label: "Campanhas" },
  { id: "activity", label: "Atividade" },
];

const TABS_ID_PREFIX = "lead-detail";

interface LeadDetailPanelProps {
  leadId: Id<"leads">;
  organizationId: Id<"organizations">;
  onClose: () => void;
  /** Aba aberta ao montar o painel. Padrão: "conversation". */
  initialTab?: LeadTab;
}

/**
 * Painel do lead (casca): abas e ações do cabeçalho. A aba vai para
 * `?leadTab=` (replace) só quando o painel foi aberto por `?lead=` deste lead
 * (Funil); aberto por estado local (dentro do contato, overlay de Conversas) a
 * aba fica local, para nunca existir `leadTab` sem `lead` na URL.
 */
export function LeadDetailPanel({ leadId, organizationId, onClose, initialTab }: LeadDetailPanelProps) {
  const [searchParams] = useSearchParams();
  const tabParam = useSearchParamState("leadTab", LEAD_TAB_PARAM);
  const [localTab, setLocalTab] = useState<LeadTab>(initialTab ?? DEFAULT_LEAD_TAB);

  const inUrl = isLeadTabInUrl(searchParams.get("lead"), leadId);
  const activeTab = resolveLeadTab({ inUrl, urlTab: tabParam.value, localTab, initialTab });
  const selectTab = (tab: LeadTab) => (inUrl ? tabParam.set(tab) : setLocalTab(tab));

  return (
    <SlideOver
      open={true}
      onClose={onClose}
      title="Detalhes do lead"
      headerActions={<LeadActionsMenu leadId={leadId} organizationId={organizationId} onDeleted={onClose} />}
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
    >
      <Tabs
        value={activeTab}
        onValueChange={(id) => selectTab(id as LeadTab)}
        items={TAB_ITEMS}
        ariaLabel="Seções do lead"
        idPrefix={TABS_ID_PREFIX}
        className="shrink-0 bg-surface-raised"
      />

      <div className="flex-1 min-h-0">
        {/* A conversa rola por dentro (thread + composer); as outras abas rolam aqui. */}
        <TabPanel id={activeTab} idPrefix={TABS_ID_PREFIX} className={cn("h-full", activeTab !== "conversation" && "overflow-y-auto")}>
          {activeTab === "conversation" && <LeadConversationTab leadId={leadId} organizationId={organizationId} />}
          {activeTab === "details" && <LeadDetailsTab leadId={leadId} organizationId={organizationId} />}
          {activeTab === "tasks" && <LeadTasksTab leadId={leadId} organizationId={organizationId} />}
          {activeTab === "campaigns" && <LeadCampaignsSection leadId={leadId} />}
          {activeTab === "activity" && <LeadActivityTab leadId={leadId} />}
        </TabPanel>
      </div>
    </SlideOver>
  );
}
