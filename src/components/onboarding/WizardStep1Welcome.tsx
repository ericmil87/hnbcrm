import {
  Building2,
  ShoppingCart,
  Cloud,
  Wrench,
  GraduationCap,
  HeartPulse,
  Landmark,
  MoreHorizontal,
  TrendingUp,
  Contact2,
  Bot,
  Sparkles,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import {
  INDUSTRY_TEMPLATES,
  COMPANY_SIZES,
  MAIN_GOALS,
} from "@/lib/onboardingTemplates";

interface WizardStep1WelcomeProps {
  industry: string;
  companySize: string;
  mainGoal: string;
  onIndustryChange: (industry: string) => void;
  onCompanySizeChange: (size: string) => void;
  onMainGoalChange: (goal: string) => void;
}

const ICON_MAP: Record<string, React.ElementType> = {
  Building2,
  ShoppingCart,
  Cloud,
  Wrench,
  GraduationCap,
  HeartPulse,
  Landmark,
  MoreHorizontal,
  TrendingUp,
  Contact2,
  Bot,
  Sparkles,
};

export function WizardStep1Welcome({
  industry,
  companySize,
  mainGoal,
  onIndustryChange,
  onCompanySizeChange,
  onMainGoalChange,
}: WizardStep1WelcomeProps) {
  return (
    <div className="space-y-8 animate-fade-in-up">
      {/* Header */}
      <div className="text-center space-y-2">
        <h2 className="text-2xl md:text-3xl font-bold text-text-primary">
          Vamos personalizar seu CRM
        </h2>
        <p className="text-text-secondary">
          Responda algumas perguntas para configurar tudo automaticamente
        </p>
      </div>

      {/* Section 1: Industry */}
      <div className="space-y-3">
        <label className="block text-sm font-semibold text-text-primary">
          Qual o setor do seu negócio?
        </label>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {INDUSTRY_TEMPLATES.map((template) => {
            const Icon = ICON_MAP[template.icon];
            const isSelected = industry === template.key;

            return (
              <Card
                key={template.key}
                variant="interactive"
                className={cn(
                  "flex flex-col items-center justify-center gap-2 p-4 cursor-pointer transition-all duration-150",
                  isSelected &&
                    "border-brand-500 bg-brand-500/10 shadow-md shadow-brand-500/10"
                )}
                onClick={() => onIndustryChange(template.key)}
              >
                {Icon && (
                  <Icon
                    size={24}
                    className={cn(
                      "transition-colors duration-150",
                      isSelected ? "text-brand-500" : "text-text-secondary"
                    )}
                  />
                )}
                <span
                  className={cn(
                    "text-xs md:text-sm font-medium text-center transition-colors duration-150",
                    isSelected ? "text-text-primary" : "text-text-secondary"
                  )}
                >
                  {template.label}
                </span>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Section 2: Company Size */}
      <div className="space-y-3">
        <label className="block text-sm font-semibold text-text-primary">
          Tamanho da equipe
        </label>
        <div className="flex flex-wrap gap-2">
          {COMPANY_SIZES.map((size) => {
            const isSelected = companySize === size.key;

            return (
              <button
                key={size.key}
                onClick={() => onCompanySizeChange(size.key)}
                className={cn(
                  "px-4 py-2 rounded-full text-sm font-medium transition-all duration-150",
                  "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
                  isSelected &&
                    "bg-brand-500 text-white shadow-md shadow-brand-500/20",
                  !isSelected &&
                    "bg-surface-overlay text-text-secondary hover:bg-surface-raised hover:text-text-primary border border-border"
                )}
              >
                {size.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Section 3: Main Goal */}
      <div className="space-y-3">
        <label className="block text-sm font-semibold text-text-primary">
          Qual seu principal objetivo?
        </label>
        <div className="grid grid-cols-2 gap-3">
          {MAIN_GOALS.map((goal) => {
            const Icon = ICON_MAP[goal.icon];
            const isSelected = mainGoal === goal.key;

            return (
              <Card
                key={goal.key}
                variant="interactive"
                className={cn(
                  "flex flex-col items-center justify-center gap-2 p-4 cursor-pointer transition-all duration-150",
                  isSelected &&
                    "border-brand-500 bg-brand-500/10 shadow-md shadow-brand-500/10"
                )}
                onClick={() => onMainGoalChange(goal.key)}
              >
                {Icon && (
                  <Icon
                    size={24}
                    className={cn(
                      "transition-colors duration-150",
                      isSelected ? "text-brand-500" : "text-text-secondary"
                    )}
                  />
                )}
                <span
                  className={cn(
                    "text-sm font-medium text-center transition-colors duration-150",
                    isSelected ? "text-text-primary" : "text-text-secondary"
                  )}
                >
                  {goal.label}
                </span>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
