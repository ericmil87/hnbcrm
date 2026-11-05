import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { ArrowRight, Check, ChevronDown, ChevronUp, PartyPopper, X } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Card } from "@/components/ui/Card";
import {
  CHECKLIST_MILESTONE,
  checklistAction,
  checklistTotals,
  hasWizardWork,
  orderChecklistItems,
  type ChecklistItemInput,
} from "@/lib/onboardingChecklist";
import { ONBOARDING_ROUTE } from "@/lib/routes";
import { cn } from "@/lib/utils";

interface OnboardingChecklistProps {
  organizationId: Id<"organizations">;
}

/** "Primeiros passos" no Painel: itens derivados de dados reais; some sozinho (com uma comemoração) quando tudo está feito. */
export function OnboardingChecklist({ organizationId }: OnboardingChecklistProps) {
  const [expanded, setExpanded] = useState(true);
  const checklist = useQuery(api.onboarding.getOnboardingChecklist, { organizationId });
  const dismissChecklist = useMutation(api.onboarding.dismissChecklist);
  const markCelebrated = useMutation(api.onboarding.markMilestoneCelebrated);

  const items = orderChecklistItems((checklist?.items ?? []) as ChecklistItemInput[]);
  const { completed, total, percent, allDone } = checklistTotals(items);
  const alreadyCelebrated = (checklist?.celebratedMilestones ?? []).includes(CHECKLIST_MILESTONE);

  // Comemora uma única vez: marca o marco e, no próximo carregamento, o cartão não volta.
  const [celebrating, setCelebrating] = useState(false);
  const shouldCelebrate = !!checklist && allDone && !alreadyCelebrated;
  useEffect(() => {
    if (!shouldCelebrate) return;
    setCelebrating(true);
    markCelebrated({ organizationId, milestoneId: CHECKLIST_MILESTONE }).catch(() => {});
  }, [shouldCelebrate, markCelebrated, organizationId]);

  if (!checklist || checklist.dismissed) return null;
  if (allDone && alreadyCelebrated && !celebrating) return null;

  if (allDone) {
    return (
      <Card className="mb-6 animate-fade-in-up">
        <div className="flex items-center gap-3">
          <PartyPopper size={20} className="shrink-0 text-semantic-success" aria-hidden="true" />
          <p className="flex-1 text-sm font-medium text-semantic-success">Parabéns! Tudo configurado.</p>
          <button
            type="button"
            onClick={() => setCelebrating(false)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted hover:bg-surface-overlay hover:text-text-primary"
            aria-label="Fechar"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </Card>
    );
  }

  const handleDismiss = () => {
    dismissChecklist({ organizationId }).catch(() => {});
  };

  return (
    <Card className="mb-6 animate-fade-in-up">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-text-primary">Primeiros passos</h3>
            <span className="text-xs tabular-nums text-text-muted">
              {completed}/{total}
            </span>
          </div>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-overlay"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Progresso dos primeiros passos"
          >
            <div className="h-full rounded-full bg-brand-500 transition-all duration-500 ease-out" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary md:hidden"
            aria-label={expanded ? "Recolher" : "Expandir"}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary"
            aria-label="Dispensar"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <ul className={cn("mt-3 space-y-1", !expanded && "hidden md:block")}>
        {items.map((item) => {
          const action = checklistAction(item);
          const row = (
            <>
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                  item.completed ? "border-semantic-success bg-semantic-success" : "border-border-strong",
                )}
                aria-hidden="true"
              >
                {item.completed && <Check size={12} className="text-surface-base" />}
              </span>
              <span className={cn("flex-1 text-sm", item.completed ? "text-text-muted line-through" : "text-text-primary")}>
                {item.label}
              </span>
              {item.completed ? (
                <span className="text-xs font-medium text-semantic-success">Concluído</span>
              ) : action ? (
                <span className="flex items-center gap-1 text-xs font-medium text-brand-500">
                  {action.label}
                  <ArrowRight size={12} aria-hidden="true" />
                </span>
              ) : null}
            </>
          );
          const base = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left";
          return (
            <li key={item.id}>
              {action ? (
                <Link
                  to={action.to}
                  className={cn(base, "transition-colors hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500")}
                >
                  {row}
                </Link>
              ) : (
                <div className={cn(base, item.completed && "opacity-70")}>{row}</div>
              )}
            </li>
          );
        })}
      </ul>

      {hasWizardWork(items) && (
        <div className="mt-3 border-t border-border pt-3">
          <Link
            to={ONBOARDING_ROUTE}
            className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-500 hover:text-brand-400"
          >
            Continuar configuração
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      )}
    </Card>
  );
}
