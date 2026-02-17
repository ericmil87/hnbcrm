import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { BottomTabBar } from "./BottomTabBar";
import { Id } from "../../../convex/_generated/dataModel";

interface AppShellProps {
  onSignOut: () => void;
  organizationId: Id<"organizations">;
  orgSelector?: React.ReactNode;
  children: React.ReactNode;
}

export function AppShell({ onSignOut, organizationId, orgSelector, children }: AppShellProps) {
  const [showMore, setShowMore] = useState(false);

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
        <div className="min-h-screen pb-20 md:pb-0">
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
    </div>
  );
}
