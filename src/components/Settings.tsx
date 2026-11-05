import { usePageTitle } from "@/hooks/usePageTitle";
import { VOCAB } from "@/lib/vocab";
import { useEffect, useRef, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { usePermissions } from "@/hooks/usePermissions";
import { cn } from "@/lib/utils";
import { ShieldAlert } from "lucide-react";
import { NotificationsSection } from "@/components/notifications/NotificationPreferences";
import { ChannelsSection } from "@/components/settings/ChannelsSection";
import { AiSection } from "@/components/settings/AiSection";
import { DataSection } from "@/components/settings/DataSection";
import { CentralSection } from "@/components/settings/CentralSection";
import { OrgProfilePanel } from "@/components/settings/OrgProfilePanel";
import { CustomFieldsPanel } from "@/components/settings/CustomFieldsPanel";
import { LeadSourcesPanel } from "@/components/settings/LeadSourcesPanel";
import { ApiKeysPanel } from "@/components/settings/advanced/ApiKeysPanel";
import { WebhooksPanel } from "@/components/settings/advanced/WebhooksPanel";
import { useOrgModules } from "@/hooks/useOrgModules";

type SettingsSection = "general" | "ai" | "apikeys" | "fields" | "sources" | "webhooks" | "channels" | "data" | "notifications" | "central";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; name: string }> = [
  { id: "general", name: "Geral" },
  { id: "ai", name: "IA" },
  { id: "apikeys", name: VOCAB.apiKeys },
  { id: "fields", name: "Campos personalizados" },
  { id: "sources", name: VOCAB.origin.leadSources },
  { id: "webhooks", name: "Webhooks" },
  { id: "channels", name: "Canais" },
  { id: "data", name: "Dados" },
  { id: "notifications", name: "Notificações" },
  { id: "central", name: VOCAB.unitsAndDepartments },
];

export function isSettingsSection(value: string | null): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

export function Settings() {
  usePageTitle(VOCAB.settings.title);
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can } = usePermissions(organizationId);
  const { anyEnabled: anyModuleEnabled } = useOrgModules(organizationId);

  // Deep-link `/app/configuracoes?secao=<id>` (usado pelo Painel).
  const [searchParams] = useSearchParams();
  const sectionParam = searchParams.get("secao");
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    isSettingsSection(sectionParam) ? sectionParam : "general"
  );
  const lastParamRef = useRef<string | null>(sectionParam);

  useEffect(() => {
    if (lastParamRef.current === sectionParam) return;
    lastParamRef.current = sectionParam;
    if (isSettingsSection(sectionParam)) setActiveSection(sectionParam);
  }, [sectionParam]);

  if (!can("settings", "view")) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20">
        <ShieldAlert size={48} className="text-text-muted" />
        <p className="text-text-secondary text-sm">Você não tem permissão para acessar as configurações.</p>
      </div>
    );
  }

  // "Central" (módulos opcionais): quem pode ligar vê sempre; os demais só
  // depois que algum módulo estiver ligado.
  const showCentral = can("settings", "manage") || anyModuleEnabled;
  const sections = SETTINGS_SECTIONS.filter((section) => section.id !== "central" || showCentral);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-text-primary">Configurações</h2>

      {/* Section tabs */}
      <div className="flex gap-2 flex-wrap">
        {sections.map((section) => (
          <button
            key={section.id}
            onClick={() => setActiveSection(section.id)}
            className={cn(
              "px-4 py-2 rounded-full text-sm font-medium transition-colors",
              activeSection === section.id
                ? "bg-brand-600 text-white"
                : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
            )}
          >
            {section.name}
          </button>
        ))}
      </div>

      {activeSection === "general" && <OrgProfilePanel organizationId={organizationId} />}
      {activeSection === "ai" && <AiSection organizationId={organizationId} />}
      {activeSection === "apikeys" && <ApiKeysPanel organizationId={organizationId} />}
      {activeSection === "fields" && <CustomFieldsPanel organizationId={organizationId} />}
      {activeSection === "sources" && <LeadSourcesPanel organizationId={organizationId} />}
      {activeSection === "webhooks" && <WebhooksPanel organizationId={organizationId} />}
      {activeSection === "channels" && <ChannelsSection organizationId={organizationId} />}
      {activeSection === "data" && <DataSection organizationId={organizationId} />}
      {activeSection === "notifications" && <NotificationsSection organizationId={organizationId} />}
      {activeSection === "central" && showCentral && <CentralSection organizationId={organizationId} />}
    </div>
  );
}
