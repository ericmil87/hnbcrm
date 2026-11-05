import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Building2, ChevronsUpDown, Lock, LogOut } from "lucide-react";
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
  WIZARD_STEP_PARAM,
  firstPendingStep,
  markOnContinue,
  nextStepId,
  parseStepParam,
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
import { StepAttendant } from "./StepAttendant";
import { StepBusiness } from "./StepBusiness";
import { StepDone } from "./StepDone";
import { StepExtras } from "./StepExtras";
import { StepFunnel } from "./StepFunnel";
import { StepTeam } from "./StepTeam";
import { StepTest } from "./StepTest";
import { StepWhatsapp } from "./StepWhatsapp";

const COPILOT_HINT = "Marque “Quero que a IA me ajude” no passo 1.";

interface OnboardingWizardV2Props {
  /** Quando o `AuthLayout` renderiza o assistente em tela cheia (sem `Outlet`). */
  organizationId?: Id<"organizations">;
  /** Saídas da tela cheia: o assistente nunca prende ninguém numa organização. */
  chrome?: { organizationName: string; onOpenOrgSwitcher: () => void; onSignOut: () => void };
}

/** Configuração inicial (rota `/app/configuracao-inicial` e tela cheia do `AuthLayout`): carrega o estado e liga os passos ao Convex. */
export function OnboardingWizardV2({ organizationId: orgProp, chrome }: OnboardingWizardV2Props = {}) {
  const outlet = useOutletContext<AppOutletContext | undefined>();
  const organizationId = (orgProp ?? outlet?.organizationId) as Id<"organizations">;
  const [searchParams, setSearchParams] = useSearchParams();
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
  const completeWizard = useMutation(api.onboarding.completeWizard);
  const testMarked = useRef(false);

  // Passo de retomada (primeiro pendente); `?passo=` vale mais quando presente e válido.
  const [resume, setResume] = useState<WizardStepId | null>(null);
  const paramStep = parseStepParam(searchParams.get(WIZARD_STEP_PARAM), status);
  const current = paramStep ?? resume;
  const [local, setLocal] = useState<WizardData>({});
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [deferring, setDeferring] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [skipping, setSkipping] = useState(false);

  // O registro de progresso do membro precisa existir antes de gravar a posição.
  const progressReady = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    progressReady.current = initProgress({ organizationId }).catch(() => undefined);
  }, [initProgress, organizationId]);

  const loaded = status !== undefined && progress !== undefined;
  useEffect(() => {
    if (resume === null && loaded && status) {
      setResume(firstPendingStep(status, savedStepFromProgress(progress)));
    }
  }, [resume, loaded, status, progress]);

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
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set(WIZARD_STEP_PARAM, step);
        return p;
      },
      { replace: false },
    );
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

  const skip = async (step: Extract<WizardStepId, "funnel" | "whatsapp" | "attendant" | "test" | "extras" | "team">) => {
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

  const handleFinish = async () => {
    setFinishing(true);
    try {
      await progressReady.current;
      // Org legada: completar em v2 viraria `wizardVersion: 2` e reabriria "negócio" e "teste" como pendentes.
      if (!status.legacy) await completeWizard({ organizationId, version: 2 });
      navigate(TAB_ROUTES.dashboard);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível concluir."));
      setFinishing(false);
    }
  };

  // Teste, Extras e Equipe: seguir adiante sem fazer grava "pulou" só se ainda estava pendente.
  const forwardMarking = async () => {
    // "Teste" feito na própria sessão: a query pode ainda não ter chegado e o "pulou" venceria o "feito".
    const mark = current === "test" && testMarked.current ? null : markOnContinue(current, status);
    if (mark) {
      try {
        await markStep({ organizationId, step: current as "test" | "extras" | "team", status: mark });
      } catch (e) {
        toast.error(mutationErrorMessage(e, "Não foi possível salvar."));
        return;
      }
    }
    goTo(next);
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
          hideSettingsLink={!!chrome}
        />
      );
      break;
    case "funnel":
      body = (
        <StepFunnel
          organizationId={organizationId}
          status={status}
          funnelBoardId={data.funnelBoardId}
          onBack={back}
          onApplied={(boardId) => {
            setLocal((l) => ({ ...l, funnelBoardId: boardId }));
            goTo(next, { funnelBoardId: boardId });
          }}
          onSkip={() => void skip("funnel")}
          skipLoading={skipping}
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
          hideSettingsLink={!!chrome}
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
    case "test":
      body = (
        <StepTest
          organizationId={organizationId}
          status={status}
          onAdjustPersona={() => goTo("attendant")}
          onBack={back}
          onNext={() => void forwardMarking()}
          onSkip={() => void skip("test")}
          skipLoading={skipping}
          onMarked={() => {
            testMarked.current = true;
          }}
        />
      );
      break;
    case "extras":
      body = (
        <StepExtras
          organizationId={organizationId}
          status={status}
          aiActive={aiActive}
          visionEnabled={aiStatus?.visionEnabled === true}
          onBack={back}
          onGoToWhatsapp={() => goTo("whatsapp")}
          onNext={() => void forwardMarking()}
          onSkip={() => void skip("extras")}
          skipLoading={skipping}
        />
      );
      break;
    case "team":
      body = (
        <StepTeam
          organizationId={organizationId}
          onBack={back}
          onNext={() => void forwardMarking()}
          onSkip={() => void skip("team")}
          skipLoading={skipping}
        />
      );
      break;
    default:
      body = <StepDone status={status} onBack={back} onFinish={() => void handleFinish()} finishLoading={finishing} />;
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
        {chrome && <FullScreenChrome {...chrome} />}
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

function FullScreenChrome({
  organizationName,
  onOpenOrgSwitcher,
  onSignOut,
}: {
  organizationName: string;
  onOpenOrgSwitcher: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="border-b border-border-subtle p-2 md:px-6">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-2">
        <img src="/orange_icon_logo_transparent-bg-528x488.png" alt="HNBCRM" className="h-10 w-10 object-contain" />
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={onOpenOrgSwitcher}
            className="flex min-h-11 min-w-0 max-w-[200px] items-center gap-2 rounded-full px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label={`Organização atual: ${organizationName}. Trocar ou criar organização`}
          >
            <Building2 size={16} className="shrink-0 text-brand-500" aria-hidden="true" />
            <span className="truncate">{organizationName}</span>
            <ChevronsUpDown size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-semantic-error/10 hover:text-semantic-error focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Sair"
          >
            <LogOut size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}
