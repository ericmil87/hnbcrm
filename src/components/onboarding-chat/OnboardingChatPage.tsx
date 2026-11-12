import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { SEO } from "@/components/SEO";
import { EmailEntryCard } from "@/components/auth/EmailEntryCard";
import { CreateOrganizationForm, toOrgSummaries, type OrgSummary } from "@/components/org/OrgSwitcher";
import { Select } from "@/components/ui/Select";
import { parsePlanKey, storePlanIntent } from "@/lib/authEntry";
import { readOnboardingIntent } from "@/lib/onboardingIntent";
import { pickOnboardingOrg, readSelectedOrgId, writeSelectedOrgId } from "@/lib/selectedOrg";
import { ConversationCard, CopilotNote, IntentBubble, SignedOutIntro } from "./ConversationIntro";
import { accountProgress } from "@/lib/onboardingChat";
import { OnboardingChatView } from "./OnboardingChatView";
import { OnboardingConversation, WIZARD_HREF } from "./OnboardingConversation";

const noop = () => {};
const IDLE_BLOCK_CTX = { organizationId: null, sessionId: null, sendText: noop, sendEvent: noop, busy: true };

/**
 * Rota pública `/comecar`: a conversa do onboarding v2. Pública na URL, mas
 * conversar exige conta: sem login, a conversa mostra a mensagem guardada do
 * hero e o cartão de entrada (etapa 1); sem org, o formulário de criação de
 * sempre (Termos com aceite explícito, `?plano=` guardado e limpo por ele);
 * com org, `OnboardingConversation`.
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

function IdleView({ intro, placeholder = "Carregando…" }: { intro: React.ReactNode; placeholder?: string }) {
  return (
    <OnboardingChatView
      progress={accountProgress()}
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
  const rawOrgs = useQuery(api.organizations.getUserOrganizations);
  // Senha temporária é trava da conta: quem resolve é o /app (ChangePasswordScreen).
  const mustChangePassword = useQuery(api.teamMembers.getMustChangePassword, {});
  const orgs = useMemo(() => (rawOrgs === undefined ? undefined : toOrgSummaries(rawOrgs)), [rawOrgs]);
  const [chosenId, setChosenId] = useState<string | null>(() => readSelectedOrgId());
  const intentBubble = intent?.message ? <IntentBubble message={intent.message} /> : null;

  if (mustChangePassword) {
    return <Navigate to="/app" replace />;
  }

  if (orgs === undefined || mustChangePassword === undefined) {
    return <IdleView intro={intentBubble} />;
  }

  const org: OrgSummary | null = pickOnboardingOrg(orgs, chosenId);

  if (!org) {
    return (
      <IdleView
        intro={
          <>
            {intentBubble}
            <CopilotNote>Conta pronta. Agora me diga o nome da sua empresa para eu criar o espaço dela no HNBCRM.</CopilotNote>
            <ConversationCard title="Criar organização">
              <CreateOrganizationForm
                cancelLabel="Voltar ao início"
                onCancel={() => navigate("/")}
                onCreated={(orgId) => {
                  writeSelectedOrgId(orgId);
                  setChosenId(orgId);
                }}
              />
            </ConversationCard>
          </>
        }
        placeholder="Crie a organização para continuar"
      />
    );
  }

  const orgPicker =
    orgs.length > 1 ? (
      <div className="mx-auto w-full max-w-xs pb-1">
        <Select
          label="Organização"
          value={org._id}
          options={orgs.map((o) => ({ value: o._id, label: o.name }))}
          onValueChange={(value) => {
            writeSelectedOrgId(value);
            setChosenId(value);
          }}
        />
      </div>
    ) : null;

  return (
    <OnboardingConversation
      key={org._id}
      organizationId={org._id as Id<"organizations">}
      intent={intent}
      onIntentConsumed={() => setIntent(null)}
      orgPicker={orgPicker}
    />
  );
}
