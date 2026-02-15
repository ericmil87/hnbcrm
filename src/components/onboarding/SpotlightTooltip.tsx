import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Lightbulb, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { SPOTLIGHTS } from "@/lib/celebrations";

interface SpotlightTooltipProps {
  spotlightId: string;
  organizationId: Id<"organizations">;
}

export function SpotlightTooltip({
  spotlightId,
  organizationId,
}: SpotlightTooltipProps) {
  const [dismissed, setDismissed] = useState(false);

  const progress = useQuery(api.onboarding.getOnboardingProgress, {
    organizationId,
  });
  const markSeen = useMutation(api.onboarding.markSpotlightSeen);

  // Don't render if: still loading, no progress record, already seen, or locally dismissed
  if (!progress || dismissed) return null;
  if (progress.seenSpotlights?.includes(spotlightId)) return null;

  const config = SPOTLIGHTS.find((s) => s.id === spotlightId);
  if (!config) return null;

  const handleDismiss = () => {
    setDismissed(true);
    markSeen({ organizationId, spotlightId }).catch(() => {});
  };

  return (
    <div className="mb-4 animate-fade-in-up">
      <div className="flex items-start gap-3 bg-surface-overlay border-l-4 border-l-brand-500 border border-border rounded-card p-4">
        <Lightbulb size={20} className="text-brand-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-text-primary">{config.title}</p>
          <p className="text-sm text-text-secondary mt-0.5">{config.description}</p>
        </div>
        <button
          onClick={handleDismiss}
          className="p-1 text-text-muted hover:text-text-primary rounded-lg hover:bg-surface-raised transition-colors flex-shrink-0"
          aria-label="Fechar dica"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
