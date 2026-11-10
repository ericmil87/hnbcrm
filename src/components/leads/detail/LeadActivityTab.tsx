import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { History } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";

/* ------------------------------------------------------------------ */
/*  Activity Tab                                                       */
/* ------------------------------------------------------------------ */

// `fg` per background: dark text on the light fills (semantic, brand-500, ai-500), white on the deep ones
// (ai-600/700, brand-600/800, identical to before in Escuro) and primary text on the neutral note.
const activityTypeConfig: Record<string, { color: string; fg: string; letter: string }> = {
  created: { color: "bg-semantic-success", fg: "text-surface-base", letter: "C" },
  stage_change: { color: "bg-ai-500", fg: "text-surface-base", letter: "S" },
  assignment: { color: "bg-ai-700", fg: "text-white", letter: "A" },
  message_sent: { color: "bg-brand-500", fg: "text-surface-base", letter: "M" },
  message_received: { color: "bg-brand-800", fg: "text-white", letter: "R" },
  handoff: { color: "bg-brand-600", fg: "text-white", letter: "H" },
  qualification_update: { color: "bg-semantic-warning", fg: "text-surface-base", letter: "Q" },
  note: { color: "bg-surface-overlay", fg: "text-text-primary", letter: "N" },
  call: { color: "bg-ai-600", fg: "text-white", letter: "P" },
  email_sent: { color: "bg-semantic-info", fg: "text-surface-base", letter: "E" },
};

export function LeadActivityTab({ leadId }: { leadId: Id<"leads"> }) {
  const activities = useQuery(api.activities.getActivities, {
    leadId,
  });

  if (!activities) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <EmptyState icon={History} size="sm" title="Nenhuma atividade registrada ainda" />
    );
  }

  return (
    <div className="p-4">
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />

        <div className="space-y-6">
          {activities.map((activity) => {
            const config = activityTypeConfig[activity.type] || {
              color: "bg-text-muted",
              fg: "text-surface-base",
              letter: "?",
            };

            return (
              <div key={activity._id} className="relative flex items-start gap-3 pl-1">
                {/* Icon */}
                <div
                  className={cn(
                    "relative z-10 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold",
                    config.color,
                    config.fg
                  )}
                >
                  {config.letter}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-text-primary">
                      {activity.actorName}
                    </span>
                    <span className="text-xs text-text-muted whitespace-nowrap tabular-nums">
                      {formatDateTime(activity.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm text-text-secondary mt-0.5">
                    {activity.content || activity.type.replace(/_/g, " ")}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

