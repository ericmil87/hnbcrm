import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate, useOutletContext } from "react-router";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { CopilotPanel } from "@/components/copilot/CopilotPanel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePageTitle } from "@/hooks/usePageTitle";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import {
  NO_EMAIL_NOTICE,
  firstPendingStep,
  nextStepId,
  previousStepId,
  readWizardData,
  savedStepFromProgress,
  skipIsPersisted,
  stepIndex,
  visibleWizardSteps,
  wizardDataPatch,
  type WizardData,
  type WizardStepId,
} from "@/lib/onboardingWizard";
import { TAB_ROUTES } from "@/lib/routes";
import { OnboardingWizardV2View } from "./OnboardingWizardV2View";
import { PlaceholderStep } from "./PlaceholderStep";
import { StepAttendant } from "./StepAttendant";
import { StepBusiness } from "./StepBusiness";
import { StepFunnel } from "./StepFunnel";
import { StepWhatsapp } from "./StepWhatsapp";

const COPILOT_HINT = "Marque “Quero que a IA me ajude” no passo 1.";

/** Configuração inicial (rota `/app/configuracao-inicial`): carrega o estado e liga os passos ao Convex. */
export function OnboardingWizardV2() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  usePageTitle("Configuração inicial");
  const navigate = useNavigate();
  const { can, isLoading: permsLoading } = usePermissions(organizationId);
  const wide = useMediaQuery("(min-width: 1024px)");

  const status = useQuery(api.onboarding.getOnboardingStatus, { organizationId });
  const progress = useQuery(api.onboarding.getOnboardingProgress, { organizationId });
  const aiStatus = useQuery(api.aiSettings.getAiStatus, { organizationId });
  const orgs = useQuery(api.organizations.getUserOrganizations);

  const initProgress = useMutation(api.onboarding.initOnboardingProgress);
  const updateStep = useMutation(api.onboarding.updateWizardStep);
  const markStep = useMutation(api.onboarding.markWizardStep);
  const deferWizard = useMutation(api.onboarding.deferWizard);

  const [current, setCurrent] = useState<WizardStepId | null>(null);
  const [local, setLocal] = useState<WizardData>({});
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [deferring, setDeferring] = useState(false);
  const [skipping, setSkipping] = useState(false);

  // O registro de progresso do membro precisa existir antes de gravar a posição.
  const progressReady = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    progressReady.current = initProgress({ organizationId }).catch(() => undefined);
  }, [initProgress, organizationId]);

  const loaded = status !== undefined && progress !== undefined;
  useEffect(() => {
    if (current === null && loaded && status) {
      setCurrent(firstPendingStep(status, savedStepFromProgress(progress)));
    }
  }, [current, loaded, status, progress]);

  const stored = readWizardData((progress as { wizardData?: unknown } | undefined)?.wizardData);
  const data: WizardData = { ...stored, ...local };

  const persist = async (step: WizardStepId, extra?: Record<string, unknown>) => {
    try {
      await progressReady.current;
      await updateStep({ organizationId, step: stepIndex(step), wizardData: wizardDataPatch(extra) });
    } catch {
      // A posição é só conforto de retomada: falhar em gravar não pode travar o passo.
    }
  };

  const goTo = (step: WizardStepId | null, extra?: Record<string, unknown>) => {
    if (!step) return;
    setCurrent(step);
    void persist(step, extra);
    window.scrollTo?.({ top: 0 });
  };

  if (permsLoading || !loaded || !status || current === null) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!can("settings", "manage")) {
    return (
      <EmptyState
        icon={Lock}
        headingLevel="h2"
        title="Só administradores fazem a configuração inicial"
        description="Peça a um administrador da sua conta para continuar."
        action={{ label: "Ir para o painel", href: TAB_ROUTES.dashboard }}
      />
    );
  }

  const steps = visibleWizardSteps(status);
  const prev = previousStepId(current, status);
  const next = nextStepId(current, status);
  const aiActive = aiStatus?.active === true;
  const org = orgs?.find((o) => o?._id === organizationId);

  const skip = async (step: Extract<WizardStepId, "whatsapp" | "attendant">) => {
    setSkipping(true);
    try {
      if (skipIsPersisted(step)) await markStep({ organizationId, step, status: "skipped" });
      goTo(next);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível pular."));
    } finally {
      setSkipping(false);
    }
  };

  const handleDefer = async () => {
    setDeferring(true);
    try {
      await deferWizard({ organizationId });
      navigate(TAB_ROUTES.dashboard);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar."));
      setDeferring(false);
    }
  };

  const back = prev ? () => goTo(prev) : () => navigate(TAB_ROUTES.dashboard);
  const forward = () => goTo(next);

  let body: React.ReactNode;
  switch (current) {
    case "business":
      body = (
        <StepBusiness
          organizationId={organizationId}
          status={status}
          aiActive={aiActive}
          orgDefaults={org?.settings}
          onSaved={forward}
        />
      );
      break;
    case "funnel":
      body = (
        <StepFunnel
          organizationId={organizationId}
          segment={status.segment}
          onBack={back}
          onApplied={(boardId) => {
            setLocal((l) => ({ ...l, funnelBoardId: boardId }));
            goTo(next, { funnelBoardId: boardId });
          }}
          onSkip={forward}
        />
      );
      break;
    case "whatsapp":
      body = (
        <StepWhatsapp
          organizationId={organizationId}
          status={status}
          connectedChannelId={data.connectedChannelId}
          onConnected={(id: Id<"channelConfigs">) => {
            setLocal((l) => ({ ...l, connectedChannelId: id }));
            void persist("whatsapp", { connectedChannelId: id });
          }}
          onBack={back}
          onNext={forward}
          onSkip={() => void skip("whatsapp")}
          skipLoading={skipping}
        />
      );
      break;
    case "attendant":
      body = (
        <StepAttendant
          organizationId={organizationId}
          status={status}
          aiActive={aiActive}
          connectedChannelId={data.connectedChannelId}
          funnelBoardId={data.funnelBoardId}
          onBack={back}
          onNext={forward}
          onSkip={() => void skip("attendant")}
          skipLoading={skipping}
        />
      );
      break;
    default:
      body = (
        <PlaceholderStep
          step={current}
          onBack={back}
          onNext={next ? forward : undefined}
          onFinish={next ? undefined : () => navigate(TAB_ROUTES.dashboard)}
        />
      );
  }
  return renderView(body);

  function renderView(content: React.ReactNode) {
    const copilotOffered = status?.capabilities?.llm !== false && aiStatus !== undefined;
    const copilotReady = aiStatus?.active === true && aiStatus.copilotEnabled;
    const panel = (
      <CopilotPanel
        variant="embedded"
        purpose="setup"
        organizationId={organizationId}
        initialThreadId={data.setupThreadId}
        onThreadChange={(id) => {
          setLocal((l) => ({ ...l, setupThreadId: id ?? undefined }));
          void persist(current as WizardStepId, { setupThreadId: id });
        }}
      />
    );
    const showSide = copilotOpen && copilotReady && wide;
    return (
      <>
        <OnboardingWizardV2View
          steps={steps}
          current={current as WizardStepId}
          completed={steps
            .filter((s) => s.id !== "done" && status && status.steps?.[s.id as Exclude<WizardStepId, "done">] !== "pending")
            .map((s) => s.id)}
          onStepClick={(id) => goTo(id)}
          onDefer={() => void handleDefer()}
          deferLoading={deferring}
          notice={status?.accountHasEmail === false ? NO_EMAIL_NOTICE : undefined}
          copilot={
            copilotOffered && (copilotReady || !aiActive)
              ? {
                  open: copilotOpen,
                  onToggle: () => setCopilotOpen((o) => !o),
                  disabledReason: copilotReady ? undefined : COPILOT_HINT,
                }
              : undefined
          }
          sidePanel={showSide ? panel : undefined}
        >
          {content}
        </OnboardingWizardV2View>
        {copilotOpen && copilotReady && !wide && (
          <Modal open onClose={() => setCopilotOpen(false)} title="Configurar conversando">
            <div className="h-[70vh] supports-[height:100dvh]:h-[70dvh]">{panel}</div>
          </Modal>
        )}
      </>
    );
  }
}
