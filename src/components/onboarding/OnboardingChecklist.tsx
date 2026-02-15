import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Check, X, ChevronDown, ChevronUp, ArrowRight } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import type { Tab } from "@/components/layout/BottomTabBar";

interface OnboardingChecklistProps {
  organizationId: Id<"organizations">;
  onTabChange: (tab: Tab) => void;
}

const ITEM_NAV: Record<string, { tab: Tab; label: string }> = {
  pipelineCustomized: { tab: "board", label: "Concluído!" },
  firstLeadCreated: { tab: "board", label: "Pipeline" },
  firstContactAdded: { tab: "contacts", label: "Contatos" },
  teamMemberInvited: { tab: "team", label: "Equipe" },
  webhookOrApiKey: { tab: "settings", label: "Config" },
  customFieldsExplored: { tab: "settings", label: "Config" },
};

export function OnboardingChecklist({
  organizationId,
  onTabChange,
}: OnboardingChecklistProps) {
  const [expanded, setExpanded] = useState(true);

  const checklist = useQuery(api.onboarding.getOnboardingChecklist, {
    organizationId,
  });
  const dismissChecklist = useMutation(api.onboarding.dismissChecklist);

  if (!checklist || checklist.dismissed) return null;

  const { items, completedCount, totalCount } = checklist;
  const progressPct = Math.round((completedCount / totalCount) * 100);
  const allDone = completedCount === totalCount;

  const handleDismiss = () => {
    dismissChecklist({ organizationId }).catch(() => {});
  };

  return (
    <Card className="mb-6 animate-fade-in-up">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-text-primary">
              Primeiros Passos
            </h3>
            <span className="text-xs text-text-muted">
              {completedCount}/{totalCount}
            </span>
          </div>
          {/* Progress bar */}
          <div className="mt-2 w-full h-1.5 bg-surface-overlay rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${progressPct}%`,
                backgroundColor: allDone ? "#22C55E" : "#FF6B00",
              }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Mobile collapse toggle */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="md:hidden p-1.5 text-text-muted hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors"
            aria-label={expanded ? "Recolher" : "Expandir"}
          >
            {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>

          {/* Dismiss button */}
          <button
            onClick={handleDismiss}
            className="p-1.5 text-text-muted hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors"
            aria-label="Dispensar"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Items — always visible on desktop, collapsible on mobile */}
      <div className={cn("mt-4 space-y-1", !expanded && "hidden md:block")}>
        {items.map((item: { id: string; label: string; completed: boolean }) => {
          const nav = ITEM_NAV[item.id];
          const isCompleted = item.completed;

          return (
            <button
              key={item.id}
              onClick={() => {
                if (!isCompleted && nav) onTabChange(nav.tab);
              }}
              disabled={isCompleted}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
                isCompleted
                  ? "opacity-60 cursor-default"
                  : "hover:bg-surface-overlay cursor-pointer"
              )}
            >
              {/* Check circle */}
              <div
                className={cn(
                  "w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 border transition-colors",
                  isCompleted
                    ? "bg-semantic-success border-semantic-success"
                    : "border-border-strong"
                )}
              >
                {isCompleted && <Check size={12} className="text-white" />}
              </div>

              {/* Label */}
              <span
                className={cn(
                  "text-sm flex-1",
                  isCompleted ? "text-text-muted line-through" : "text-text-primary"
                )}
              >
                {item.label}
              </span>

              {/* Action */}
              {isCompleted ? (
                <span className="text-xs text-semantic-success font-medium">
                  Concluído!
                </span>
              ) : nav ? (
                <span className="flex items-center gap-1 text-xs text-brand-500 font-medium">
                  {nav.label}
                  <ArrowRight size={12} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* All done message */}
      {allDone && (
        <div className="mt-4 pt-3 border-t border-border text-center">
          <p className="text-sm text-semantic-success font-medium">
            Parabéns! Todos os passos concluídos!
          </p>
        </div>
      )}
    </Card>
  );
}
