import { useState } from "react";
import { useQuery } from "convex/react";
import { Sparkles } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { BottomTabBar } from "./BottomTabBar";
import { CopilotPanel } from "@/components/copilot/CopilotPanel";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";

interface AppShellProps {
  onSignOut: () => void;
  organizationId: Id<"organizations">;
  orgSelector?: React.ReactNode;
  children: React.ReactNode;
}

export function AppShell({ onSignOut, organizationId, orgSelector, children }: AppShellProps) {
  const [showMore, setShowMore] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);

  // IA é opt-in por organização — sem status "active", o gatilho nem renderiza.
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });

  return (
    <div className="min-h-screen bg-surface-base">
      {/* Desktop sidebar */}
      <Sidebar
        onSignOut={onSignOut}
        organizationId={organizationId}
        orgSelector={orgSelector}
      />

      {/* Main content area */}
      <main className="md:ml-16 lg:ml-56 transition-all duration-200">
        {/* Header — sino de notificações (desktop e mobile) */}
        <header className="sticky top-0 z-30 h-14 md:h-16 flex items-center justify-end px-4 md:px-6 bg-surface-raised/95 backdrop-blur border-b border-border">
          <NotificationBell organizationId={organizationId} />
        </header>

        <div className="min-h-[calc(100vh-3.5rem)] md:min-h-[calc(100vh-4rem)] pb-20 md:pb-0">
          <div className="p-4 md:p-6">
            {children}
          </div>
        </div>
      </main>

      {/* Mobile bottom tab bar */}
      <BottomTabBar
        organizationId={organizationId}
        showMore={showMore}
        onToggleMore={() => setShowMore(!showMore)}
      />

      {/* Gatilho flutuante do Copiloto IA — só aparece se a org ativou a IA e o produto Copiloto */}
      {aiStatus?.active && aiStatus.copilotEnabled && (
        <>
          <button
            onClick={() => setCopilotOpen(true)}
            className="fixed z-40 bottom-20 right-4 md:bottom-6 md:right-6 h-14 w-14 flex items-center justify-center rounded-full bg-brand-600 text-white shadow-elevated hover:bg-brand-700 active:bg-brand-800 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
            aria-label="Abrir Copiloto IA"
            title="Copiloto IA"
          >
            <Sparkles size={22} />
          </button>
          <CopilotPanel
            organizationId={organizationId}
            open={copilotOpen}
            onClose={() => setCopilotOpen(false)}
          />
        </>
      )}
    </div>
  );
}
