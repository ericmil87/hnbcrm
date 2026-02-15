import { Authenticated, Unauthenticated, useQuery, useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";
import { SignInForm } from "./SignInForm";
import { Toaster, toast } from "sonner";
import { useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { OrganizationSelector } from "./components/OrganizationSelector";
import { AppShell } from "./components/layout/AppShell";
import { Spinner } from "./components/ui/Spinner";
import { Modal } from "./components/ui/Modal";
import { Card } from "./components/ui/Card";
import { Badge } from "./components/ui/Badge";
import { Button } from "./components/ui/Button";
import { Input } from "./components/ui/Input";
import { Building2, Plus } from "lucide-react";
import type { Tab } from "./components/layout/BottomTabBar";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";

export default function App() {
  const [selectedOrgId, setSelectedOrgId] = useState<Id<"organizations"> | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const { signOut } = useAuthActions();

  return (
    <div className="min-h-screen bg-surface-base">
      <Authenticated>
        <AppShell
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onSignOut={() => signOut()}
          orgSelector={
            <OrganizationSelector
              selectedOrgId={selectedOrgId}
              onSelectOrg={setSelectedOrgId}
            />
          }
        >
          <Content
            selectedOrgId={selectedOrgId}
            onSelectOrg={setSelectedOrgId}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        </AppShell>
      </Authenticated>

      <Unauthenticated>
        <AuthScreen />
      </Unauthenticated>

      <Toaster theme="dark" />
    </div>
  );
}

function Content({
  selectedOrgId,
  onSelectOrg,
  activeTab,
  onTabChange,
}: {
  selectedOrgId: Id<"organizations"> | null;
  onSelectOrg: (orgId: Id<"organizations">) => void;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}) {
  const [wizardDone, setWizardDone] = useState(false);
  const loggedInUser = useQuery(api.auth.loggedInUser);
  const onboardingProgress = useQuery(
    api.onboarding.getOnboardingProgress,
    selectedOrgId ? { organizationId: selectedOrgId } : "skip"
  );

  if (loggedInUser === undefined) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!selectedOrgId) {
    return <WelcomeScreen onSelectOrg={onSelectOrg} />;
  }

  // Show wizard for new orgs (null progress = no record + no data)
  // Don't show if wizard was just completed in this session
  if (
    onboardingProgress !== undefined &&
    !wizardDone &&
    (onboardingProgress === null || onboardingProgress.wizardCompleted === false)
  ) {
    return (
      <OnboardingWizard
        organizationId={selectedOrgId}
        onComplete={() => setWizardDone(true)}
      />
    );
  }

  return (
    <Dashboard
      organizationId={selectedOrgId}
      activeTab={activeTab}
      onTabChange={onTabChange}
    />
  );
}

function WelcomeScreen({ onSelectOrg }: { onSelectOrg: (orgId: Id<"organizations">) => void }) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgSlug, setNewOrgSlug] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const organizations = useQuery(api.organizations.getUserOrganizations);
  const createOrganization = useMutation(api.organizations.createOrganization);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOrgName.trim() || !newOrgSlug.trim()) return;

    setIsCreating(true);
    try {
      const orgId = await createOrganization({
        name: newOrgName,
        slug: newOrgSlug,
      });
      toast.success("Organização criada!");
      setShowCreateModal(false);
      setNewOrgName("");
      setNewOrgSlug("");
      onSelectOrg(orgId);
    } catch {
      toast.error("Falha ao criar organização. O slug pode já estar em uso.");
    } finally {
      setIsCreating(false);
    }
  };

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
            Selecione uma organização para começar
          </p>
        </div>

        {organizations === undefined ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : (
          <div className="space-y-3 animate-fade-in-up">
            {organizations.filter(Boolean).map((org) => {
              if (!org) return null;
              return (
                <Card
                  key={org._id}
                  variant="interactive"
                  className="flex items-center gap-4"
                  onClick={() => onSelectOrg(org._id as Id<"organizations">)}
                >
                  <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-brand-500/10 shrink-0">
                    <Building2 size={20} className="text-brand-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {org.name}
                    </p>
                    <p className="text-xs text-text-muted truncate">
                      {org.slug}
                    </p>
                  </div>
                  <Badge variant="brand">{org.role}</Badge>
                </Card>
              );
            })}

            <Card
              variant="interactive"
              className="flex items-center gap-4 border-dashed"
              onClick={() => setShowCreateModal(true)}
            >
              <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-surface-overlay shrink-0">
                <Plus size={20} className="text-text-muted" />
              </div>
              <p className="text-sm font-medium text-text-secondary">
                Criar Organização
              </p>
            </Card>
          </div>
        )}

        <Modal
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          title="Criar Organização"
        >
          <form onSubmit={handleCreate} className="space-y-4">
            <Input
              label="Nome da Organização"
              placeholder="Minha Empresa"
              value={newOrgName}
              onChange={(e) => {
                setNewOrgName(e.target.value);
                setNewOrgSlug(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, "-")
                    .replace(/-+/g, "-")
                    .replace(/^-|-$/g, "")
                );
              }}
              required
            />
            <Input
              label="Slug (identificador URL)"
              placeholder="minha-empresa"
              value={newOrgSlug}
              onChange={(e) => setNewOrgSlug(e.target.value)}
              required
            />
            <div className="flex gap-3 pt-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowCreateModal(false)}
                className="flex-1"
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={isCreating || !newOrgName.trim() || !newOrgSlug.trim()}
                className="flex-1"
              >
                {isCreating ? "Criando..." : "Criar"}
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    </div>
  );
}

function AuthScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen px-4 bg-gradient-to-b from-surface-overlay to-surface-base">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 animate-fade-in-up">
          <img
            src="/orange_icon_logo_transparent-bg-528x488.png"
            alt="HNBCRM"
            className="h-16 w-16 mx-auto mb-4 object-contain"
          />
          <h1 className="text-3xl md:text-4xl font-bold text-text-primary mb-2">
            HNBCRM
          </h1>
          <p className="text-lg md:text-xl text-text-secondary">
            CRM multi-tenant com colaboração humano-IA
          </p>
        </div>
        <div className="animate-fade-in-up">
          <SignInForm />
        </div>
      </div>
    </div>
  );
}
