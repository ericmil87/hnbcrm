import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { SEO } from "@/components/SEO";
import { EmailEntryCard } from "@/components/auth/EmailEntryCard";
import { CreateOrganizationForm } from "@/components/org/OrgSwitcher";
import { Button } from "@/components/ui/Button";
import { parsePlanKey, storePlanIntent } from "@/lib/authEntry";
import {
  decideOnboardingEntry,
  newOrgTrialNotice,
  optionDiscardsIntent,
  type EntryChoice,
  type EntryOption,
  type EntryOverview,
} from "@/lib/onboardingEntryChoice";
import { clearOnboardingIntent, readOnboardingIntent } from "@/lib/onboardingIntent";
import { readSelectedOrgId, writeSelectedOrgId } from "@/lib/selectedOrg";
import { ConversationCard, CopilotNote, IntentBubble, SignedOutIntro } from "./ConversationIntro";
import { ENTRY_STEP_LABEL, accountProgress } from "@/lib/onboardingChat";
import { OnboardingChatView } from "./OnboardingChatView";
import { OnboardingConversation, WIZARD_HREF } from "./OnboardingConversation";
import { APP_HREF } from "./OnboardingConversationController";
import { EntryChoiceView } from "./EntryChoice";

/** Destinos de "Ver o plano" e "Ver o uso de IA" (painéis de Configurações). */
const PLAN_HREF = "/app/configuracoes?secao=billing";
const USAGE_HREF = "/app/configuracoes?secao=ai-usage";

const noop = () => {};
const IDLE_BLOCK_CTX = { organizationId: null, sessionId: null, sendText: noop, sendEvent: noop, busy: true };

/**
 * Rota pública `/comecar`: a conversa do onboarding v2. Pública na URL, mas
 * conversar exige conta: sem login, a conversa mostra a mensagem guardada do
 * hero e o cartão de entrada (etapa 1); sem org, o formulário de criação de
 * sempre (Termos com aceite explícito, `?plano=` guardado e limpo por ele);
 * com empresa, a decisão de `decideOnboardingEntry`: direto para a conversa só
 * quem não tem operação que ela possa mexer; senão a tela de escolha (abrir o
 * CRM, continuar, ajustar, criar outra empresa), com a mensagem do hero usada
 * só depois da escolha.
 */
export function OnboardingChatPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [searchParams] = useSearchParams();
  const plan = parsePlanKey(searchParams.get("plano"));
  const [intent] = useState(() => readOnboardingIntent());

  // Mesmo comportamento de /entrar: o plano de interesse vale até a criação da org.
  useEffect(() => {
    storePlanIntent(plan);
  }, [plan]);

  return (
    <>
      <SEO title="Começar" description="Configure o seu CRM conversando com o Copiloto do HNBCRM." noindex />
      {isLoading ? (
        <IdleView intro={intent?.message ? <IntentBubble message={intent.message} /> : null} />
      ) : !isAuthenticated ? (
        <IdleView
          intro={<SignedOutIntro intentMessage={intent?.message} accountCard={<EmailEntryCard compact autoFocus />} />}
          placeholder="Entre na sua conta para continuar"
        />
      ) : (
        <SignedInConversation intent={intent} />
      )}
    </>
  );
}

function IdleView({ intro, placeholder = "Carregando…", entry = false }: { intro: React.ReactNode; placeholder?: string; entry?: boolean }) {
  return (
    <OnboardingChatView
      progress={entry ? accountProgress(ENTRY_STEP_LABEL) : accountProgress()}
      intro={intro}
      timeline={[]}
      typing={false}
      chips={[]}
      onChip={noop}
      composerValue=""
      onComposerChange={noop}
      onSubmit={noop}
      composerDisabled
      composerPlaceholder={placeholder}
      blockCtx={IDLE_BLOCK_CTX}
      formHref={WIZARD_HREF}
    />
  );
}

function SignedInConversation({ intent: initialIntent }: { intent: ReturnType<typeof readOnboardingIntent> }) {
  const navigate = useNavigate();
  // Consumida uma vez: trocar de org (remonta a conversa) não reenvia a mensagem do hero.
  const [intent, setIntent] = useState(initialIntent);
  // `now` fixo da visita: a query não lê o relógio (modo leitura, teto do mês, teste da empresa nova).
  const [now] = useState(() => Date.now());
  const overview = useQuery(api.onboardingSessions.getEntryOverview, { now });
  // Senha temporária é trava da conta: quem resolve é o /app (ChangePasswordScreen).
  const mustChangePassword = useQuery(api.teamMembers.getMustChangePassword, {});
  const [storedOrgId] = useState<string | null>(() => readSelectedOrgId());
  const [pickedOrgId, setPickedOrgId] = useState<string | null>(null);
  const [choice, setChoice] = useState<EntryChoice | null>(null);
  const intentBubble = intent?.message ? <IntentBubble message={intent.message} /> : null;

  if (mustChangePassword) {
    return <Navigate to="/app" replace />;
  }

  const decision =
    mustChangePassword === undefined
      ? ({ kind: "loading" } as const)
      : decideOnboardingEntry({
          auth: "signed_in",
          overview: overview as EntryOverview | null | undefined,
          storedOrgId,
          pickedOrgId,
          choice,
          hasIntent: !!intent?.message,
        });

  const openCrm = (orgId: string | null, to = APP_HREF) => {
    if (orgId) writeSelectedOrgId(orgId);
    navigate(to);
  };
  const goToConversation = (orgId: string) => {
    writeSelectedOrgId(orgId);
    setChoice({ action: "conversation", orgId });
  };
  const choose = (option: EntryOption, orgId: string | null) => {
    if (optionDiscardsIntent(option)) {
      clearOnboardingIntent();
      setIntent(null);
    }
    switch (option) {
      case "open_crm":
        return openCrm(orgId);
      case "see_plan":
        return openCrm(orgId, PLAN_HREF);
      case "see_usage":
        return openCrm(orgId, USAGE_HREF);
      case "create":
        return setChoice({ action: "create" });
      case "continue":
      case "adjust":
      case "start":
        if (orgId) goToConversation(orgId);
    }
  };

  switch (decision.kind) {
    case "loading":
    case "signed_out":
      return <IdleView intro={intentBubble} />;

    case "create_org": {
      const chosen = decision.reason === "chosen";
      const trial = overview ? newOrgTrialNotice(overview.newOrgTrial, overview.newOrgTrialEndsAt) : null;
      return (
        <IdleView
          intro={
            <>
              {intentBubble}
              <CopilotNote>
                {chosen
                  ? `Vamos criar outra empresa, separada da que você já tem. ${trial ?? ""}`.trim()
                  : "Conta pronta. Agora me diga o nome da sua empresa para eu criar o espaço dela no HNBCRM."}
              </CopilotNote>
              <ConversationCard title="Criar organização">
                <CreateOrganizationForm
                  cancelLabel={chosen ? "Voltar" : "Voltar ao início"}
                  onCancel={() => (chosen ? setChoice(null) : navigate("/"))}
                  onCreated={(orgId) => goToConversation(orgId)}
                />
              </ConversationCard>
            </>
          }
          placeholder="Crie a organização para continuar"
        />
      );
    }

    case "not_admin":
      return (
        <IdleView
          intro={
            <EntryChoiceView
              variant="not_admin"
              orgName={decision.orgName}
              state="configured"
              notice={null}
              stepLabel={null}
              options={decision.options}
              primary="open_crm"
              intentMessage={intent?.message || null}
              trialNotice={overview ? newOrgTrialNotice(overview.newOrgTrial, overview.newOrgTrialEndsAt) : ""}
              onChoose={(option) => choose(option, null)}
            />
          }
          placeholder="Escolha uma opção acima"
          entry
        />
      );

    case "choose": {
      const { org } = decision;
      return (
        <IdleView
          intro={
            <EntryChoiceView
              orgName={org.name}
              state={org.conversation === "in_progress" ? "in_progress" : org.configured || org.conversation === "applied" ? "configured" : "fresh"}
              notice={decision.notice}
              stepLabel={decision.stepLabel}
              orgs={decision.managed.map((o) => ({ id: o.organizationId, name: o.name }))}
              selectedOrgId={org.organizationId}
              onSelectOrg={setPickedOrgId}
              options={decision.options}
              primary={decision.primary}
              intentMessage={intent?.message || null}
              trialNotice={overview ? newOrgTrialNotice(overview.newOrgTrial, overview.newOrgTrialEndsAt) : ""}
              onChoose={(option) => choose(option, org.organizationId)}
            />
          }
          placeholder="Escolha uma opção acima"
          entry
        />
      );
    }

    case "conversation": {
      const managedCount = overview?.orgs.filter((o) => o.canManage).length ?? 0;
      const current = overview?.orgs.find((o) => o.organizationId === decision.orgId);
      // Quem tem mais de uma empresa (ou chegou pela tela de escolha) vê para qual está configurando e pode trocar.
      const orgPicker =
        current && (managedCount > 1 || choice !== null) ? (
          <div className="mx-auto flex w-full max-w-md flex-wrap items-center justify-center gap-x-2 pb-1 text-caption text-text-secondary">
            <span>
              Configurando <strong className="font-semibold text-text-primary">{current.name}</strong>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setChoice(null);
                setPickedOrgId(decision.orgId);
              }}
            >
              Trocar
            </Button>
          </div>
        ) : null;
      return (
        <OnboardingConversation
          key={decision.orgId}
          organizationId={decision.orgId as Id<"organizations">}
          intent={intent}
          onIntentConsumed={() => setIntent(null)}
          orgPicker={orgPicker}
        />
      );
    }
  }
}
