import { proposeCountryForCurrency } from "@/lib/defaultCountry";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { Building2, ChevronLeft, ChevronsUpDown, LogOut } from "lucide-react";
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
import {
  WizardInviteResults,
  summarizeInviteOutcomes,
  type InviteOutcome,
} from "./WizardInviteResults";
import { getTemplateByIndustry } from "@/lib/onboardingTemplates";
import { mutationErrorMessage } from "@/lib/errors";

interface OnboardingWizardProps {
  organizationId: Id<"organizations">;
  organizationName: string;
  onComplete: () => void;
  /** Sai do assistente sem concluir — a org já nasce com um pipeline padrão. */
  onSkip: () => void;
  onOpenOrgSwitcher: () => void;
  onSignOut: () => void;
}

interface StageConfig {
  name: string;
  color: string;
  isClosedWon?: boolean;
  isClosedLost?: boolean;
}

interface InviteRow {
  type: "human" | "ai";
  name: string;
  email: string;
  role: "admin" | "manager" | "agent";
}

export function OnboardingWizard({
  organizationId,
  organizationName,
  onComplete,
  onSkip,
  onOpenOrgSwitcher,
  onSignOut,
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
  const inviteHumanMember = useAction(api.nodeActions.inviteHumanMember);
  const completeWizard = useMutation(api.onboarding.completeWizard);

  // Local state
  const [currentStep, setCurrentStep] = useState(0);
  const [industry, setIndustry] = useState("");
  const [companySize, setCompanySize] = useState("");
  const [mainGoal, setMainGoal] = useState("");
  const [currency, setCurrency] = useState("BRL");
  const [timezone, setTimezone] = useState("America/Sao_Paulo");
  const [defaultCountryCode, setDefaultCountryCode] = useState("55");
  const [countryPicked, setCountryPicked] = useState(false);
  const [stages, setStages] = useState<StageConfig[]>([]);
  const [boardName, setBoardName] = useState("");
  const [sampleDataEnabled, setSampleDataEnabled] = useState(false);
  const [isGeneratingSample, setIsGeneratingSample] = useState(false);
  const [generatingStep, setGeneratingStep] = useState("");
  const [sampleDataGenerated, setSampleDataGenerated] = useState(false);
  const [invites, setInvites] = useState<InviteRow[]>([
    { type: "human", name: "", email: "", role: "agent" },
  ]);
  // Só em memória: tem senha temporária, que nunca vai para o wizardData.
  const [inviteOutcomes, setInviteOutcomes] = useState<InviteOutcome[]>([]);
  const [isNavigating, setIsNavigating] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const loadedRef = useRef(false);
  // Último funil gravado nesta sessão (nome + estágios) — evita recriar igual.
  const pipelineKeyRef = useRef<string | null>(null);

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
      if (data.currency) setCurrency(data.currency);
      if (data.timezone) setTimezone(data.timezone);
      if (typeof data.defaultCountryCode === "string" && /^\d{1,3}$/.test(data.defaultCountryCode)) {
        setDefaultCountryCode(data.defaultCountryCode);
        setCountryPicked(data.defaultCountryCode !== "55");
      }
      if (Array.isArray(data.stages) && data.stages.length > 0) setStages(data.stages);
      if (data.boardName) setBoardName(data.boardName);
      if (typeof data.sampleDataEnabled === "boolean") setSampleDataEnabled(data.sampleDataEnabled);
      if (typeof data.sampleDataGenerated === "boolean") setSampleDataGenerated(data.sampleDataGenerated);
      if (Array.isArray(data.invites)) {
        setInvites(
          data.invites.map((inv: any) => ({
            type: inv.type ?? "human",
            name: inv.name ?? "",
            email: inv.email ?? "",
            role: inv.role ?? "agent",
          }))
        );
      }
    }
  }, [savedProgress]);

  // Safety net: if on step 1 with no stages, reload template from industry
  useEffect(() => {
    if (currentStep === 1 && stages.length === 0 && industry) {
      const template = getTemplateByIndustry(industry);
      setStages(template.stages);
      if (!boardName) setBoardName(template.boardName);
    }
  }, [currentStep, stages.length, industry]);

  // Currency change handler — auto-sets a sensible default timezone
  const handleCurrencyChange = (c: string) => {
    setCurrency(c);
    const defaults: Record<string, string> = {
      BRL: "America/Sao_Paulo",
      USD: "America/New_York",
      EUR: "Europe/Paris",
    };
    setTimezone(defaults[c] ?? timezone);
    setDefaultCountryCode(proposeCountryForCurrency(c, defaultCountryCode, countryPicked));
  };

  const handleCountryChange = (code: string) => {
    setDefaultCountryCode(code);
    setCountryPicked(true);
  };

  // Persist wizard state
  const persistState = async (stepOverride?: number) => {
    const wizardData = {
      currentStep: stepOverride ?? currentStep,
      industry,
      companySize,
      mainGoal,
      currency,
      timezone,
      defaultCountryCode,
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
        // Step 1 → 2: Setup pipeline in backend. O servidor APAGA os boards e
        // recria — por isso não repete com os mesmos estágios (voltar e
        // avançar), e recusa quando já há leads (ex.: dados de exemplo do
        // passo 2). Recusado, o funil atual fica e o assistente segue.
        const pipelineKey = JSON.stringify({ boardName, stages });
        if (pipelineKeyRef.current !== pipelineKey) {
          try {
            await setupPipeline({ organizationId, boardName, stages });
            pipelineKeyRef.current = pipelineKey;
          } catch (error) {
            toast.warning(
              `${mutationErrorMessage(error, "Não foi possível recriar o funil")} O funil atual foi mantido.`
            );
          }
        }
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
        // Step 3 → 4: convites de verdade — pessoa pelo fluxo de convite
        // (conta + senha temporária + e-mail; quem já tem conta só é
        // adicionado), IA como membro. Voltar e avançar de novo não reconvida
        // quem já foi processado.
        const validInvites = invites.filter((inv) =>
          inv.type === "ai" ? inv.name.trim() !== "" : inv.email.trim() !== ""
        );
        const done = new Set(
          inviteOutcomes.filter((o) => o.kind !== "failed").map((o) => o.key)
        );
        const results: InviteOutcome[] = [];

        for (const invite of validInvites) {
          const key =
            invite.type === "ai"
              ? `ai:${invite.name.trim().toLowerCase()}`
              : `human:${invite.email.trim().toLowerCase()}`;
          if (done.has(key)) continue;

          if (invite.type === "ai") {
            const name = invite.name.trim();
            try {
              await createTeamMember({ organizationId, name, role: "ai", type: "ai" });
              results.push({ key, name, kind: "ai" });
            } catch (error) {
              results.push({ key, name, kind: "failed", error: mutationErrorMessage(error, "Falha ao convidar") });
            }
            continue;
          }

          const email = invite.email.trim();
          const name = invite.name.trim() || email.split("@")[0];
          try {
            const result = await inviteHumanMember({
              organizationId,
              name,
              email,
              role: invite.role,
            });
            results.push({
              key,
              name,
              email,
              kind: result.isNewUser ? "new" : result.reactivated ? "reactivated" : "existing",
              tempPassword: result.tempPassword,
              emailSent: result.emailSent,
              pendingPasswordChange: !result.isNewUser && result.pendingPasswordChange,
            });
          } catch (error) {
            const message = mutationErrorMessage(error, "Falha ao convidar");
            results.push({
              key,
              name,
              email,
              kind: /já é membro/i.test(message) ? "already_member" : "failed",
              error: message,
            });
          }
        }

        if (results.length > 0) {
          const merged = [
            ...inviteOutcomes.filter((o) => !results.some((r) => r.key === o.key)),
            ...results,
          ];
          setInviteOutcomes(merged);
          const summary = summarizeInviteOutcomes(results);
          if (results.some((r) => r.kind === "failed")) toast.warning(summary);
          else toast.success(summary);
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
      // O servidor grava fuso, moeda E o país padrão dos telefones a partir do
      // wizardData salvo (`completeWizard` faz merge em `settings`).
      await completeWizard({ organizationId });
      onComplete();
    } catch (error) {
      console.error("Failed to complete wizard:", error);
      toast.error("Erro ao finalizar configuração");
    }
  };

  // "Pular" fecha o assistente da org (a org já nasce com um pipeline padrão).
  // Se o servidor recusar, fecha só nesta sessão — nunca prende ninguém aqui.
  const handleSkip = async () => {
    setIsNavigating(true);
    try {
      await completeWizard({ organizationId });
    } catch (error) {
      console.error("Failed to skip wizard:", error);
    } finally {
      setIsNavigating(false);
    }
    onSkip();
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
            className="h-10 w-10 md:h-12 md:w-12 object-contain"
          />
          <div className="hidden md:block flex-1 mx-8">
            <WizardStepIndicator
              currentStep={currentStep}
              totalSteps={5}
            />
          </div>
          {/* Saídas: o assistente nunca pode prender ninguém numa org */}
          <div className="flex items-center gap-1 min-w-0">
            <button
              type="button"
              onClick={onOpenOrgSwitcher}
              className="flex items-center gap-2 min-w-0 max-w-[160px] md:max-w-[220px] min-h-[44px] px-3 rounded-full text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
              aria-label={`Organização atual: ${organizationName}. Trocar ou criar organização`}
            >
              <Building2 size={16} className="shrink-0 text-brand-500" />
              <span className="truncate">{organizationName}</span>
              <ChevronsUpDown size={14} className="shrink-0 text-text-muted" />
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="flex items-center justify-center h-11 w-11 shrink-0 rounded-full text-text-muted hover:text-semantic-error hover:bg-semantic-error/10 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
              aria-label="Sair"
              title="Sair"
            >
              <LogOut size={18} />
            </button>
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
                currency={currency}
                timezone={timezone}
                defaultCountryCode={defaultCountryCode}
                onDefaultCountryChange={handleCountryChange}
                onIndustryChange={setIndustry}
                onCompanySizeChange={setCompanySize}
                onMainGoalChange={setMainGoal}
                onCurrencyChange={handleCurrencyChange}
                onTimezoneChange={setTimezone}
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
                inviteCount={
                  inviteOutcomes.filter((o) => o.kind !== "failed" && o.kind !== "already_member")
                    .length
                }
                sampleDataGenerated={sampleDataGenerated}
                onGoToDashboard={handleComplete}
              />
            )}
            {currentStep === 4 && <WizardInviteResults outcomes={inviteOutcomes} />}
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
              variant="ghost"
              onClick={handleSkip}
              disabled={isNavigating}
              className="flex-shrink-0 ml-auto"
            >
              Pular
            </Button>
            <Button
              variant="primary"
              onClick={handleNext}
              disabled={isNavigating}
              className="flex-shrink-0"
            >
              {isNavigating ? <Spinner size="sm" /> : currentStep === 3 ? "Finalizar" : "Próximo"}
            </Button>
          </div>
        </footer>
      )}
    </div>
  );
}
