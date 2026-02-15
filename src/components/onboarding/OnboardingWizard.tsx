import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { WizardStepIndicator } from "./WizardStepIndicator";
import { WizardStep1Welcome } from "./WizardStep1Welcome";
import { WizardStep2Pipeline } from "./WizardStep2Pipeline";
import { WizardStep3SampleData } from "./WizardStep3SampleData";
import { WizardStep4TeamInvite } from "./WizardStep4TeamInvite";
import { WizardStep5Complete } from "./WizardStep5Complete";
import { getTemplateByIndustry } from "@/lib/onboardingTemplates";

interface OnboardingWizardProps {
  organizationId: Id<"organizations">;
  onComplete: () => void;
}

interface StageConfig {
  name: string;
  color: string;
  isClosedWon?: boolean;
  isClosedLost?: boolean;
}

interface InviteRow {
  email: string;
  role: "admin" | "manager" | "agent";
}

export function OnboardingWizard({
  organizationId,
  onComplete,
}: OnboardingWizardProps) {
  // Convex queries and mutations
  const savedProgress = useQuery(api.onboarding.getOnboardingProgress, {
    organizationId,
  });
  const initProgress = useMutation(api.onboarding.initOnboardingProgress);
  const updateStep = useMutation(api.onboarding.updateWizardStep);
  const setupPipeline = useMutation(api.onboarding.setupPipelineFromWizard);
  const requestSampleData = useMutation(api.onboarding.requestSampleData);
  const createTeamMember = useMutation(api.teamMembers.createTeamMember);
  const completeWizard = useMutation(api.onboarding.completeWizard);

  // Local state
  const [currentStep, setCurrentStep] = useState(0);
  const [industry, setIndustry] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [mainGoal, setMainGoal] = useState("");
  const [stages, setStages] = useState<StageConfig[]>([]);
  const [boardName, setBoardName] = useState("");
  const [sampleDataEnabled, setSampleDataEnabled] = useState(false);
  const [isGeneratingSample, setIsGeneratingSample] = useState(false);
  const [generatingStep, setGeneratingStep] = useState("");
  const [sampleDataGenerated, setSampleDataGenerated] = useState(false);
  const [invites, setInvites] = useState<InviteRow[]>([
    { email: "", role: "agent" },
  ]);
  const [isNavigating, setIsNavigating] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const loadedRef = useRef(false);

  // Initialize onboarding progress on mount
  useEffect(() => {
    if (!initialized) {
      initProgress({ organizationId })
        .then(() => setInitialized(true))
        .catch((error) => {
          console.error("Failed to init onboarding:", error);
          setInitialized(true); // Still mark as initialized to prevent retry loops
        });
    }
  }, [initialized, initProgress, organizationId]);

  // Load saved progress (only once)
  useEffect(() => {
    if (savedProgress && savedProgress.wizardData && !loadedRef.current) {
      loadedRef.current = true;
      const data = savedProgress.wizardData as Record<string, any>;

      if (typeof data.currentStep === "number") setCurrentStep(data.currentStep);
      if (data.industry) setIndustry(data.industry);
      if (data.companySize) setCompanySize(data.companySize);
      if (data.mainGoal) setMainGoal(data.mainGoal);
      if (Array.isArray(data.stages)) setStages(data.stages);
      if (data.boardName) setBoardName(data.boardName);
      if (typeof data.sampleDataEnabled === "boolean") setSampleDataEnabled(data.sampleDataEnabled);
      if (typeof data.sampleDataGenerated === "boolean") setSampleDataGenerated(data.sampleDataGenerated);
      if (Array.isArray(data.invites)) setInvites(data.invites);
    }
  }, [savedProgress]);

  // Persist wizard state
  const persistState = async (stepOverride?: number) => {
    const wizardData = {
      currentStep: stepOverride ?? currentStep,
      industry,
      companySize,
      mainGoal,
      stages,
      boardName,
      sampleDataEnabled,
      sampleDataGenerated,
      invites,
    };

    await updateStep({
      organizationId,
      step: stepOverride ?? currentStep,
      wizardData,
    });
  };

  // Validate current step
  const validateStep = (): boolean => {
    switch (currentStep) {
      case 0:
        if (!industry) {
          toast.error("Por favor, selecione um setor");
          return false;
        }
        return true;
      case 1:
        if (!boardName || stages.length === 0) {
          toast.error("Configure o pipeline antes de continuar");
          return false;
        }
        return true;
      default:
        return true;
    }
  };

  // Handle step transitions with side effects
  const handleNext = async () => {
    if (!validateStep()) return;

    setIsNavigating(true);

    try {
      if (currentStep === 0) {
        // Step 0 → 1: Load pipeline template from industry
        const template = getTemplateByIndustry(industry);
        setStages(template.stages);
        setBoardName(template.boardName);
        await persistState(1);
        setCurrentStep(1);
      } else if (currentStep === 1) {
        // Step 1 → 2: Setup pipeline in backend
        await setupPipeline({
          organizationId,
          boardName,
          stages,
        });
        await persistState(2);
        setCurrentStep(2);
      } else if (currentStep === 2) {
        // Step 2 → 3: Generate sample data if enabled
        if (sampleDataEnabled && !sampleDataGenerated) {
          setIsGeneratingSample(true);
          const animSteps = [
            "Criando contatos...",
            "Gerando leads...",
            "Configurando conversas...",
            "Finalizando...",
          ];

          // Fire the actual backend mutation
          requestSampleData({ organizationId, industry }).catch((err) => {
            console.error("Sample data generation error:", err);
          });

          // Show animated progress
          for (const step of animSteps) {
            setGeneratingStep(step);
            await new Promise((resolve) => setTimeout(resolve, 600));
          }

          setSampleDataGenerated(true);
          setIsGeneratingSample(false);
        }
        await persistState(3);
        setCurrentStep(3);
      } else if (currentStep === 3) {
        // Step 3 → 4: Create team members from invites
        const validInvites = invites.filter((inv) => inv.email.trim() !== "");

        for (const invite of validInvites) {
          const name = invite.email.split("@")[0];
          await createTeamMember({
            organizationId,
            name,
            email: invite.email,
            role: invite.role,
            type: "human",
          });
        }

        if (validInvites.length > 0) {
          toast.success(
            `${validInvites.length} membro${validInvites.length !== 1 ? "s" : ""} convidado${validInvites.length !== 1 ? "s" : ""}`
          );
        }

        await persistState(4);
        setCurrentStep(4);
      }
    } catch (error) {
      console.error("Navigation error:", error);
      toast.error("Erro ao avançar. Tente novamente.");
    } finally {
      setIsNavigating(false);
    }
  };

  const handleBack = async () => {
    if (currentStep > 0) {
      const newStep = currentStep - 1;
      await persistState(newStep);
      setCurrentStep(newStep);
    }
  };

  const handleComplete = async () => {
    try {
      await completeWizard({ organizationId });
      onComplete();
    } catch (error) {
      console.error("Failed to complete wizard:", error);
      toast.error("Erro ao finalizar configuração");
    }
  };

  // Loading state
  if (!initialized && savedProgress === undefined) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-surface-overlay to-surface-base flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-surface-overlay to-surface-base flex flex-col">
      {/* Header */}
      <header className="p-4 md:p-6 border-b border-border-subtle">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <img
            src="/orange_icon_logo_transparent-bg-528x488.png"
            alt="HNBCRM"
            className="h-10 w-10 md:h-12 md:w-12"
          />
          <div className="hidden md:block flex-1 ml-8">
            <WizardStepIndicator
              currentStep={currentStep}
              totalSteps={5}
            />
          </div>
        </div>
      </header>

      {/* Mobile step indicator */}
      <div className="md:hidden px-4 py-3">
        <WizardStepIndicator currentStep={currentStep} totalSteps={5} />
      </div>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="max-w-2xl mx-auto">
          <div key={currentStep} className="animate-fade-in-up">
            {currentStep === 0 && (
              <WizardStep1Welcome
                industry={industry}
                companySize={companySize}
                mainGoal={mainGoal}
                onIndustryChange={setIndustry}
                onCompanySizeChange={setCompanySize}
                onMainGoalChange={setMainGoal}
              />
            )}
            {currentStep === 1 && (
              <WizardStep2Pipeline
                boardName={boardName}
                stages={stages}
                onBoardNameChange={setBoardName}
                onStagesChange={setStages}
              />
            )}
            {currentStep === 2 && (
              <WizardStep3SampleData
                enabled={sampleDataEnabled}
                onToggle={setSampleDataEnabled}
                isGenerating={isGeneratingSample}
                generatingStep={generatingStep}
              />
            )}
            {currentStep === 3 && (
              <WizardStep4TeamInvite
                invites={invites}
                onInvitesChange={setInvites}
              />
            )}
            {currentStep === 4 && (
              <WizardStep5Complete
                pipelineName={boardName}
                stageCount={stages.length}
                inviteCount={invites.filter((inv) => inv.email.trim() !== "").length}
                sampleDataGenerated={sampleDataGenerated}
                onGoToDashboard={handleComplete}
              />
            )}
          </div>
        </div>
      </main>

      {/* Footer navigation (hidden on last step) */}
      {currentStep < 4 && (
        <footer className="p-4 md:p-6 border-t border-border-subtle bg-surface-base">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
            {currentStep > 0 ? (
              <Button
                variant="ghost"
                onClick={handleBack}
                disabled={isNavigating}
                className="flex-shrink-0"
              >
                <ChevronLeft size={18} />
                Voltar
              </Button>
            ) : (
              <div />
            )}

            <Button
              variant="primary"
              onClick={handleNext}
              disabled={isNavigating}
              className="flex-shrink-0 ml-auto"
            >
              {isNavigating ? <Spinner size="sm" /> : currentStep === 3 ? "Finalizar" : "Próximo"}
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}
