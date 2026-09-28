import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Navigate,
  Outlet,
  ScrollRestoration,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { AppShell } from "./AppShell";
import { Spinner } from "../ui/Spinner";
import { Modal } from "../ui/Modal";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Building2, LogOut, Plus } from "lucide-react";
import { toast } from "sonner";
import { OnboardingWizard } from "../onboarding/OnboardingWizard";
import { ErrorBoundary } from "../ErrorBoundary";
import { ChangePasswordScreen } from "../team/ChangePasswordScreen";
import {
  CreateOrganizationForm,
  OrgSwitcherModal,
  roleLabel,
  toOrgSummaries,
  type OrgSummary,
} from "../org/OrgSwitcher";
import {
  entityDeepLink,
  newlyAddedOrgIds,
  pathAfterOrgSwitch,
  withoutSearchParam,
} from "@/lib/orgSwitch";

export type AppOutletContext = {
  organizationId: Id<"organizations">;
};

const SELECTED_ORG_KEY = "hnbcrm.selectedOrgId";
const KNOWN_ORGS_KEY_PREFIX = "hnbcrm.knownOrgIds.";

function readStoredOrgId(): Id<"organizations"> | null {
  try {
    return localStorage.getItem(SELECTED_ORG_KEY) as Id<"organizations"> | null;
  } catch {
    return null;
  }
}

function clearStoredOrgId() {
  try {
    localStorage.removeItem(SELECTED_ORG_KEY);
  } catch {
    // localStorage indisponível — nada a limpar
  }
}

function readKnownOrgIds(userId: string): string[] | null {
  try {
    const raw = localStorage.getItem(KNOWN_ORGS_KEY_PREFIX + userId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

function writeKnownOrgIds(userId: string, ids: string[]) {
  try {
    localStorage.setItem(KNOWN_ORGS_KEY_PREFIX + userId, JSON.stringify(ids));
  } catch {
    // localStorage indisponível — o aviso de org nova só não persiste
  }
}

/**
 * O assistente é para o admin configurar uma org nova. O backend decide em
 * `shouldShowWizard`; o ramo legado (sem o campo) vale só para admin, porque
 * os passos chamam mutations admin-only e prenderiam um agente convidado.
 */
function shouldShowWizard(progress: unknown, memberRole: string | undefined): boolean {
  if (progress && typeof progress === "object" && "shouldShowWizard" in progress) {
    return (progress as { shouldShowWizard: unknown }).shouldShowWizard === true;
  }
  if (memberRole !== "admin") return false;
  return (
    progress === null ||
    (typeof progress === "object" &&
      (progress as { wizardCompleted?: unknown }).wizardCompleted === false)
  );
}

export function AuthLayout() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [selectedOrgId, setSelectedOrgIdState] =
    useState<Id<"organizations"> | null>(readStoredOrgId);
  // Por org: concluir/pular o assistente na A não pode pular o da B.
  const [wizardClosedOrgs, setWizardClosedOrgs] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [switcherMode, setSwitcherMode] = useState<"list" | "create" | null>(null);
  const { signOut } = useAuthActions();

  const setSelectedOrgId = useCallback((orgId: Id<"organizations"> | null) => {
    try {
      if (orgId) localStorage.setItem(SELECTED_ORG_KEY, orgId);
      else localStorage.removeItem(SELECTED_ORG_KEY);
    } catch {
      // localStorage indisponível (ex.: modo privado) — segue só em memória
    }
    setSelectedOrgIdState(orgId);
  }, []);

  const loggedInUser = useQuery(
    api.auth.loggedInUser,
    isAuthenticated ? undefined : "skip"
  );
  const rawOrganizations = useQuery(
    api.organizations.getUserOrganizations,
    isAuthenticated ? undefined : "skip"
  );
  const organizations = useMemo(
    () => (rawOrganizations === undefined ? undefined : toOrgSummaries(rawOrganizations)),
    [rawOrganizations]
  );

  // Só usa o org salvo/selecionado depois de validar que o usuário ainda é membro
  const activeOrg: OrgSummary | null =
    (selectedOrgId && organizations?.find((org) => org._id === selectedOrgId)) || null;
  const activeOrgId = activeOrg?._id ?? null;

  // Última org ativa (id + nome) — para avisar quem perdeu o acesso a ela.
  const lastActiveOrgRef = useRef<OrgSummary | null>(null);
  if (activeOrg) lastActiveOrgRef.current = activeOrg;

  // Orgs que a própria pessoa criou nesta sessão não disparam "você foi adicionado".
  const createdOrgIdsRef = useRef<Set<string>>(new Set());

  /**
   * Troca de org escolhida pela pessoa. Saindo de uma org ativa, descarta os
   * deep-links de entidade da URL (senão a conversa/tarefa da org anterior
   * seguiria aberta dentro da nova). Da tela de boas-vindas o link é mantido —
   * pode ser justamente o link do e-mail para aquela org.
   */
  // Troca MANUAL vence o deep-link: guarda a URL de antes da troca para os
  // efeitos de deep-link ignorarem o param antigo até a limpeza da URL
  // aplicar. Sem isso, no mesmo tick do `selectOrg` o efeito via o POP + o
  // `?lead=` da org anterior e trocava de volta para ela.
  const manualSwitchSearchRef = useRef<string | null>(null);
  const selectOrg = useCallback(
    (orgId: Id<"organizations">) => {
      if (activeOrgId && orgId !== activeOrgId) {
        manualSwitchSearchRef.current = location.search;
        navigate(pathAfterOrgSwitch(location.pathname, location.search), { replace: true });
      }
      setSelectedOrgId(orgId);
    },
    [activeOrgId, location.pathname, location.search, navigate, setSelectedOrgId]
  );

  useEffect(() => {
    if (organizations === undefined) return;
    if (selectedOrgId && !activeOrgId) {
      // Org salva inválida: a pessoa foi removida dela (ou é de outro usuário
      // neste navegador). Descarta e limpa a URL, que pode apontar para
      // registros daquela org.
      const lost = lastActiveOrgRef.current;
      if (lost && lost._id === selectedOrgId) {
        toast.info(`Você não tem mais acesso à organização "${lost.name}".`);
        lastActiveOrgRef.current = null;
        navigate(pathAfterOrgSwitch(location.pathname, location.search), { replace: true });
      }
      setSelectedOrgId(null);
    } else if (!selectedOrgId && organizations.length === 1) {
      setSelectedOrgId(organizations[0]._id);
    }
  }, [organizations, selectedOrgId, activeOrgId, setSelectedOrgId, navigate, location.pathname, location.search]);

  // Aviso discreto quando surge uma org nova na lista (convite para outra org).
  const userId: string | undefined = loggedInUser?._id;
  useEffect(() => {
    if (!userId || organizations === undefined) return;
    const currentIds = organizations.map((o) => o._id as string);
    const added = newlyAddedOrgIds(readKnownOrgIds(userId), currentIds, createdOrgIdsRef.current);
    for (const id of added) {
      const org = organizations.find((o) => o._id === id);
      if (!org || org._id === activeOrgId) continue;
      // Só vínculo de CONVITE avisa (`invited` do servidor): org que a própria
      // pessoa criou — aqui, em outra aba ou outro aparelho — nunca.
      if (org.invited !== true) continue;
      toast(`Você foi adicionado à organização "${org.name}"`, {
        duration: 10000,
        action: { label: "Abrir", onClick: () => selectOrg(org._id) },
      });
    }
    writeKnownOrgIds(userId, currentIds);
    // selectOrg/activeOrgId mudam a cada troca; o aviso só depende da lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, organizations]);

  const onboardingProgress = useQuery(
    api.onboarding.getOnboardingProgress,
    activeOrgId ? { organizationId: activeOrgId } : "skip"
  );
  const currentMember = useQuery(
    api.teamMembers.getCurrentTeamMember,
    activeOrgId ? { organizationId: activeOrgId } : "skip"
  );
  const mustChangePassword = useQuery(
    api.teamMembers.getMustChangePassword,
    isAuthenticated ? {} : "skip"
  );

  // Deep-link de entidade (`?task=`, `?lead=`, `?conversation=`, `?handoff=`).
  // Links de e-mail/notificação não levam a org, então na CHEGADA (navegação
  // "POP": link externo, F5, voltar/avançar) a org do item é resolvida UMA vez
  // por id e guardada em `entityOrgs`. Ids que a própria tela grava ao abrir um
  // lead/tarefa (PUSH/REPLACE) já são da org ativa e entram direto no cache —
  // por isso voltar/avançar dentro da org não consulta nem bloqueia nada, e a
  // query sai de cena após a 1ª resposta (excluir o item aberto depois não
  // vira "não encontrado").
  const navigationType = useNavigationType();
  const [entityOrgs, setEntityOrgs] = useState<Readonly<Record<string, string | null>>>({});
  if (manualSwitchSearchRef.current !== null && manualSwitchSearchRef.current !== location.search) {
    manualSwitchSearchRef.current = null; // a URL já foi limpa
  }
  const staleAfterManualSwitch = manualSwitchSearchRef.current === location.search;
  const deepLink = staleAfterManualSwitch ? null : entityDeepLink(location.search);
  const deepLinkKey = deepLink ? `${deepLink.kind}:${deepLink.id}` : null;
  const knownEntityOrg = deepLinkKey ? entityOrgs[deepLinkKey] : undefined;
  const needsEntityResolve =
    deepLinkKey !== null &&
    knownEntityOrg === undefined &&
    navigationType === "POP" &&
    activeOrgId !== null;
  const resolvedEntityOrg = useQuery(
    api.organizations.resolveEntityOrg,
    needsEntityResolve && deepLink ? deepLink : "skip"
  );
  // Bloqueia a tela só enquanto a org do item é desconhecida (1ª vez) ou
  // conhecida e diferente da ativa (troca em curso) — nunca na navegação comum.
  const deepLinkPending =
    needsEntityResolve ||
    (navigationType === "POP" &&
      typeof knownEntityOrg === "string" &&
      activeOrgId !== null &&
      knownEntityOrg !== activeOrgId);

  // Id gravado pela própria tela → é da org ativa.
  useEffect(() => {
    if (!deepLinkKey || navigationType === "POP" || !activeOrgId) return;
    if (entityOrgs[deepLinkKey] !== undefined) return;
    setEntityOrgs((prev) => ({ ...prev, [deepLinkKey]: activeOrgId }));
  }, [deepLinkKey, navigationType, activeOrgId, entityOrgs]);

  // 1ª resposta do servidor para este id: guarda e age (troca ou avisa).
  useEffect(() => {
    if (!needsEntityResolve || !deepLinkKey || !deepLink || resolvedEntityOrg === undefined) return;
    const orgId = resolvedEntityOrg?.organizationId ?? null;
    setEntityOrgs((prev) => ({ ...prev, [deepLinkKey]: orgId }));
    if (orgId === activeOrgId) return;
    const targetOrg = orgId ? organizations?.find((o) => o._id === orgId) : undefined;
    if (targetOrg) {
      // O item é de outra org da pessoa: troca para ela mantendo o link.
      setSelectedOrgId(targetOrg._id);
      toast.info(`Abrimos a organização "${targetOrg.name}", onde está este item.`);
    } else {
      // Não existe, ou é de uma org da qual a pessoa não é membro.
      toast.error("Não encontramos esse item, ou você não tem acesso a ele.");
      navigate(withoutSearchParam(location.pathname, location.search, deepLink.kind), {
        replace: true,
      });
    }
    // deepLink/deepLinkKey derivam de location.search (já nas deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedEntityOrg, needsEntityResolve, activeOrgId, organizations, location.pathname, location.search]);

  // Voltar/avançar para um link JÁ resolvido de outra org (ex.: histórico de
  // antes de uma troca): troca de novo, em silêncio — sem nova consulta.
  useEffect(() => {
    if (navigationType !== "POP" || typeof knownEntityOrg !== "string" || !activeOrgId) return;
    if (knownEntityOrg === activeOrgId) return;
    const targetOrg = organizations?.find((o) => o._id === knownEntityOrg);
    if (targetOrg) {
      setSelectedOrgId(targetOrg._id);
    } else if (deepLink) {
      navigate(withoutSearchParam(location.pathname, location.search, deepLink.kind), {
        replace: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownEntityOrg, navigationType, activeOrgId, organizations]);

  const handleSignOut = useCallback(() => {
    setSwitcherMode(null);
    // Esquece a org escolhida: o próximo usuário deste navegador não pode
    // cair na org do anterior (caso também seja membro dela).
    // (Só o storage: zerar o estado agora faria o auto-select da org única
    // regravá-la antes do signOut terminar.)
    clearStoredOrgId();
    // Toasts da sessão (ex.: "você foi adicionado…", com botão de trocar de
    // org) não podem sobrar para o próximo usuário deste navegador.
    toast.dismiss();
    void signOut().finally(() => toast.dismiss());
  }, [signOut]);

  const handleOrgCreated = useCallback((orgId: Id<"organizations">) => {
    createdOrgIdsRef.current.add(orgId);
  }, []);

  if (isLoading) {
    return <FullScreenSpinner />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/entrar" replace />;
  }

  if (loggedInUser === undefined || organizations === undefined || mustChangePassword === undefined) {
    return <FullScreenSpinner />;
  }

  // Senha temporária é trava da CONTA, não da org: vale antes de tudo e em
  // qualquer org selecionada (antes era por membro, e escolher outra org
  // escapava dela). A troca limpa a flag em todos os vínculos do usuário; a
  // action só pede uma org da qual a pessoa seja membro.
  const passwordOrgId = activeOrgId ?? organizations[0]?._id ?? null;
  if (mustChangePassword && passwordOrgId) {
    return (
      <ChangePasswordScreen
        organizationId={passwordOrgId}
        onSignOut={handleSignOut}
        onSuccess={() => {
          // getMustChangePassword atualiza sozinha quando a flag é limpa
        }}
      />
    );
  }

  if (!activeOrgId) {
    // Com uma única org (ou org salva inválida a descartar), o useEffect acima resolve — evita flash da tela de seleção
    if (organizations.length === 1 || selectedOrgId) {
      return <FullScreenSpinner />;
    }
    return (
      <WelcomeScreen
        organizations={organizations}
        onSelectOrg={selectOrg}
        onOrgCreated={handleOrgCreated}
        onSignOut={handleSignOut}
      />
    );
  }

  const switcher = (
    <OrgSwitcherModal
      open={switcherMode !== null}
      initialMode={switcherMode ?? "list"}
      onClose={() => setSwitcherMode(null)}
      organizations={organizations}
      activeOrgId={activeOrgId}
      onSelectOrg={selectOrg}
      onCreated={handleOrgCreated}
      onSignOut={handleSignOut}
    />
  );

  if (!currentMember) {
    return <FullScreenSpinner />;
  }

  if (
    onboardingProgress !== undefined &&
    !wizardClosedOrgs.has(activeOrgId) &&
    shouldShowWizard(onboardingProgress, currentMember.role)
  ) {
    const closeWizard = () =>
      setWizardClosedOrgs((prev) => new Set(prev).add(activeOrgId));
    return (
      <>
        <OnboardingWizard
          key={activeOrgId}
          organizationId={activeOrgId}
          organizationName={activeOrg?.name ?? ""}
          onComplete={closeWizard}
          onSkip={closeWizard}
          onOpenOrgSwitcher={() => setSwitcherMode("list")}
          onSignOut={handleSignOut}
        />
        {switcher}
      </>
    );
  }

  return (
    <>
      <ScrollRestoration />
      {/* key: trocar de org remonta a área autenticada inteira — nenhum estado
          local (formulário, seleção, painel aberto) atravessa de uma org para outra */}
      <AppShell
        key={activeOrgId}
        onSignOut={handleSignOut}
        organizationId={activeOrgId}
        orgName={activeOrg?.name ?? ""}
        onOpenOrgSwitcher={() => setSwitcherMode("list")}
      >
        {/* resetKey: navegar para outra tela sai do "Algo deu errado" sem F5 */}
        <ErrorBoundary resetKey={location.pathname}>
          {deepLinkPending ? (
            // Segura a tela até saber a org do item: sem isso a conversa/tarefa
            // de A aparecia dentro da UI de B antes da troca.
            <div className="flex justify-center py-16">
              <Spinner size="lg" />
            </div>
          ) : (
            <Outlet context={{ organizationId: activeOrgId } satisfies AppOutletContext} />
          )}
        </ErrorBoundary>
      </AppShell>
      {switcher}
    </>
  );
}

function FullScreenSpinner() {
  return (
    <div className="flex justify-center items-center h-screen bg-surface-base">
      <Spinner size="lg" />
    </div>
  );
}

interface WelcomeScreenProps {
  organizations: OrgSummary[];
  onSelectOrg: (orgId: Id<"organizations">) => void;
  onOrgCreated: (orgId: Id<"organizations">) => void;
  onSignOut: () => void;
}

function WelcomeScreen({
  organizations,
  onSelectOrg,
  onOrgCreated,
  onSignOut,
}: WelcomeScreenProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);

  return (
    <div className="flex items-center justify-center min-h-screen px-4 py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 animate-fade-in-up">
          <img
            src="/orange_icon_logo_transparent-bg-528x488.png"
            alt="HNBCRM"
            className="h-20 w-20 mx-auto mb-6 object-contain"
          />
          <h1 className="text-2xl md:text-3xl font-bold text-text-primary mb-2">
            Bem-vindo ao HNBCRM
          </h1>
          <p className="text-text-secondary text-base md:text-lg">
            {organizations.length > 0
              ? "Selecione uma organização para começar"
              : "Crie sua organização para começar"}
          </p>
        </div>

        <div className="space-y-3 animate-fade-in-up">
          {organizations.map((org) => (
            <Card
              key={org._id}
              variant="interactive"
              className="flex items-center gap-4"
              onClick={() => onSelectOrg(org._id)}
            >
              <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-brand-500/10 shrink-0">
                <Building2 size={20} className="text-brand-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{org.name}</p>
                <p className="text-xs text-text-muted truncate">{org.slug}</p>
              </div>
              <Badge variant="brand">{roleLabel(org.role)}</Badge>
            </Card>
          ))}

          <Card
            variant="interactive"
            className="flex items-center gap-4 border-dashed"
            onClick={() => setShowCreateModal(true)}
          >
            <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-surface-overlay shrink-0">
              <Plus size={20} className="text-text-muted" />
            </div>
            <p className="text-sm font-medium text-text-secondary">Criar organização</p>
          </Card>

          <button
            type="button"
            onClick={onSignOut}
            className="w-full flex items-center justify-center gap-2 min-h-[44px] rounded-full text-sm font-medium text-text-muted hover:text-semantic-error transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <LogOut size={16} />
            Sair
          </button>
        </div>

        <Modal
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          title="Criar organização"
        >
          <CreateOrganizationForm
            onCancel={() => setShowCreateModal(false)}
            onCreated={(orgId) => {
              setShowCreateModal(false);
              onOrgCreated(orgId);
              onSelectOrg(orgId);
            }}
          />
        </Modal>
      </div>
    </div>
  );
}
