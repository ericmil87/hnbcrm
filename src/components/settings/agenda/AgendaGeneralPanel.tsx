import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { CalendarClock, Wand2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { AgendaSetupWizard } from "@/components/agenda/onboarding/AgendaSetupWizard";
import { SchedulingDisableButton, SchedulingEnableCard } from "@/components/agenda/SchedulingEnableCard";
import { Button } from "@/components/ui/Button";
import { SectionCard } from "@/components/ui/SectionCard";
import { Spinner } from "@/components/ui/Spinner";
import { useAgendaConfig } from "@/hooks/useAgendaConfig";
import { useOrgModules } from "@/hooks/useOrgModules";
import { usePermissions } from "@/hooks/usePermissions";
import { enableCardState } from "@/lib/agendaAccess";
import { generalErrors, generalFromSettings, generalToPatch, hasErrors, isEmptyPatch } from "@/lib/agendaConfigForms";
import { mutationErrorMessage } from "@/lib/errors";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";
import { SaveBar, useUnsavedGuard } from "../attendant/AttendantPanelFrame";
import { GeneralSettingsForm } from "./GeneralSettingsForm";
import { useFunnelStages } from "./useFunnelStages";

/**
 * Painel "Agendamento". Desligado: cartão com o botão Ativar. Ligado: assistente (abre logo após ativar e pode
 * ser reaberto enquanto a agenda está vazia) e ajustes gerais.
 */
export function AgendaGeneralPanel({ organizationId }: SettingsPanelProps) {
  const { modules, isLoading } = useOrgModules(organizationId);
  const { can } = usePermissions(organizationId);
  const on = modules.scheduling;
  const { config, timezone } = useAgendaConfig(organizationId, on);
  const stages = useFunnelStages(organizationId, on);
  const updateSettings = useMutation(api.schedulingConfig.updateSettings);

  const [wizardOpen, setWizardOpen] = useState(false);
  // Abre o assistente quando o módulo acabou de ser ligado AQUI (não a cada visita ao painel).
  const sawOff = useRef(false);
  const [justActivated, setJustActivated] = useState(false);
  useEffect(() => {
    if (isLoading) return;
    if (!on) sawOff.current = true;
    else if (sawOff.current) {
      sawOff.current = false;
      setJustActivated(true);
    }
  }, [on, isLoading]);

  const empty = config ? config.enabled && config.services.length === 0 && config.resources.length === 0 : false;
  useEffect(() => {
    if (justActivated && config?.enabled) {
      setJustActivated(false);
      if (empty) setWizardOpen(true);
    }
  }, [justActivated, config, empty]);

  const [draft, setDraft] = useState<ReturnType<typeof generalFromSettings> | null>(null);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const saved = config ? generalFromSettings(config.settings) : null;
  const value = draft ?? saved;
  const dirty = !!draft && !!saved && !isEmptyPatch(generalToPatch(draft, saved));
  const guard = useUnsavedGuard(dirty);

  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>;
  const state = enableCardState(modules, can);
  if (state !== "hidden") return <SchedulingEnableCard organizationId={organizationId} state={state} />;

  const errors = value ? generalErrors(value) : {};
  const save = async () => {
    if (!draft || !saved) return;
    if (hasErrors(errors)) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      await updateSettings({ organizationId, patch: generalToPatch(draft, saved) });
      setDraft(null);
      setShowErrors(false);
      toast.success("Alterações salvas");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title={VOCAB.scheduling.enable.on}
        description="Ajustes gerais da Agenda."
        icon={<CalendarClock size={20} aria-hidden="true" />}
        actions={can("settings", "manage") ? <SchedulingDisableButton organizationId={organizationId} /> : undefined}
      >
        {config === null ? (
          <p className="text-sm text-text-muted">Você não tem acesso às configurações da Agenda.</p>
        ) : config === undefined || !value ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <div className="space-y-6">
            {empty && (
              <div className="flex flex-col gap-3 rounded-card border border-brand-500/30 bg-brand-500/5 p-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-text-secondary">Sua agenda está vazia. Em 3 passos preparamos salas, profissionais, serviços e horários para o seu tipo de negócio.</p>
                <Button size="md" onClick={() => setWizardOpen(true)}>
                  <Wand2 size={16} aria-hidden="true" /> {VOCAB.scheduling.enable.ctaWizard}
                </Button>
              </div>
            )}
            <GeneralSettingsForm
              value={value}
              onChange={setDraft}
              errors={showErrors ? errors : {}}
              disabled={saving || !config.canManage}
              services={config.services
                .filter((s) => s.active || s._id === value.defaultServiceId)
                .map((s) => ({ _id: s._id, name: s.active ? s.name : `${s.name} (arquivado)` }))}
              boards={stages.groups}
              timezoneLabel={timezone}
            />
          </div>
        )}
      </SectionCard>
      {stages.source}
      {guard}
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onDiscard={() => { setDraft(null); setShowErrors(false); }} />
      <AgendaSetupWizard organizationId={organizationId} open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </div>
  );
}
