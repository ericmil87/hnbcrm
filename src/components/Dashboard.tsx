import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { DashboardOverview } from "./DashboardOverview";
import { KanbanBoard } from "./KanbanBoard";
import { Inbox } from "./Inbox";
import { HandoffQueue } from "./HandoffQueue";
import { TeamPage } from "./TeamPage";
import { Settings } from "./Settings";
import { AuditLogs } from "./AuditLogs";

interface DashboardProps {
  organizationId: string;
}

type Tab = "dashboard" | "board" | "inbox" | "handoffs" | "team" | "audit" | "settings";

export function Dashboard({ organizationId }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const currentMember = useQuery(api.teamMembers.getCurrentTeamMember, {
    organizationId: organizationId as Id<"organizations">
  });

  const tabs = [
    { id: "dashboard", name: "Dashboard", icon: "🏠" },
    { id: "board", name: "Pipeline", icon: "📊" },
    { id: "inbox", name: "Inbox", icon: "💬" },
    { id: "handoffs", name: "Handoffs", icon: "🔄" },
    { id: "team", name: "Team", icon: "👥" },
    { id: "audit", name: "Audit", icon: "📋" },
    { id: "settings", name: "Settings", icon: "⚙️" },
  ];

  if (!currentMember) {
    return (
      <div className="flex justify-center items-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Navigation Tabs */}
      <div className="border-b bg-white">
        <div className="px-6">
          <nav className="flex space-x-8">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as Tab)}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.id
                    ? "border-blue-500 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                <span className="mr-2">{tab.icon}</span>
                {tab.name}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full p-6 overflow-y-auto">
          {activeTab === "dashboard" && (
            <DashboardOverview organizationId={organizationId} />
          )}
          {activeTab === "board" && (
            <KanbanBoard organizationId={organizationId} />
          )}
          {activeTab === "inbox" && (
            <Inbox organizationId={organizationId} />
          )}
          {activeTab === "handoffs" && (
            <HandoffQueue organizationId={organizationId} />
          )}
          {activeTab === "team" && (
            <TeamPage organizationId={organizationId} />
          )}
          {activeTab === "audit" && (
            <AuditLogs organizationId={organizationId} />
          )}
          {activeTab === "settings" && (
            <Settings organizationId={organizationId} />
          )}
        </div>
      </div>
    </div>
  );
}
