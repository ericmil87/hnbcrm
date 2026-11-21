import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ChoiceCards } from "@/components/agenda/ChoiceCards";
import { Button } from "@/components/ui/Button";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { SectionCard } from "@/components/ui/SectionCard";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { useAgendaConfig } from "@/hooks/useAgendaConfig";
import {
  ackSentence, automationErrors, automationFromSettings, automationToPatch, DEFAULT_WEIGHTS_FORM, previewDefaultDate, previewDraftArgs, WEIGHT_KEYS, type AutomationForm, type SmartMode, type WeightKey,
} from "@/lib/agendaAutomation";
import { hasErrors, isEmptyPatch } from "@/lib/agendaConfigForms";
import { mutationErrorMessage } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { usePermissions } from "@/hooks/usePermissions";
import { VOCAB } from "@/lib/vocab";
import type { SettingsPanelProps } from "../registry";
import { SaveBar, useUnsavedGuard } from "../attendant/AttendantPanelFrame";
import { AiPolicyForm } from "./AiPolicyForm";
import { SuggestionPreviewView } from "./SuggestionPreviewView";

const SMART_MODES = (["off", "rank", "restrict"] as const).map((value) => ({ value, ...VOCAB.scheduling.config.smartModes[value] }));

const WEIGHT_LABELS: Record<WeightKey, string> = {
  adjacency: "Encostar um atendimento no outro",
  deadGap: "Evitar buraquinhos pequenos demais para encaixar alguém",
  openNewResource: "Evitar abrir outra sala ou profissional sem precisar",
  earlyFirst: "Preferir horários mais cedo",
  balance: "Distribuir o trabalho entre a equipe",
  preference: "Respeitar a preferência do cliente",
};

/** Painel "Sugestões e IA": modo inteligente com prévia, política da IA por ação e confirmações pelo WhatsApp. */
export function AgendaAutomationPanel({ organizationId }: SettingsPanelProps) {
  const { config, timezone, today, now } = useAgendaConfig(organizationId);
  const updateSettings = useMutation(api.schedulingConfig.updateSettings);
  const { member: me } = usePermissions(organizationId);
  const members = useQuery(api.teamMembers.getTeamMembers, config?.enabled ? { organizationId } : "skip") as Array<{ _id: string; name: string }> | undefined;
  const [draft, setDraft] = useState<AutomationForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [serviceId, setServiceId] = useState("");
  const [date, setDate] = useState(() => "");

  const saved = config ? automationFromSettings(config.settings) ?? null : null;
  const value = draft ?? saved;
  const dirty = !!draft && !!saved && !isEmptyPatch(automationToPatch(draft, saved).patch);
  const guard = useUnsavedGuard(dirty);

  const activeServices = config?.services.filter((s) => s.active) ?? [];
  const previewService = serviceId || activeServices[0]?._id || "";
  const previewDate = date || previewDefaultDate(today);
  const draftArgs = value ? previewDraftArgs(value) : null;
  const preview = useQuery(
    api.schedulingConfig.previewSuggestions,
    config?.enabled && value && previewService
      ? { organizationId, serviceId: previewService as Id<"schedServices">, localDate: previewDate, now, audience: "ai", ...draftArgs! }
      : "skip"
  );

  if (config === undefined) return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;
  if (config === null || !config.enabled || !saved || !value) {
    return <EmptyState icon={Sparkles} title={VOCAB.scheduling.config.noAccessAutomation.title} description={VOCAB.scheduling.config.noAccessAutomation.hint} />;
  }

  const errors = automationErrors(value);
  const set = (next: AutomationForm) => setDraft(next);
  const save = async () => {
    if (!draft) return;
    if (hasErrors(errors)) {
      setShowErrors(true);
      return;
    }
    const { patch, aiAutoAck } = automationToPatch(draft, saved);
    setSaving(true);
    try {
      await updateSettings({ organizationId, patch, ...(aiAutoAck !== undefined ? { aiAutoAck } : {}) });
      setDraft(null);
      setShowErrors(false);
      toast.success("Alterações salvas");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar."));
    } finally {
      setSaving(false);
    }
  };
  const disabled = saving || !config.canManage;

  return (
    <div className="space-y-4">
      <SectionCard title="Horários sugeridos" description="Quais horários a IA e o link público oferecem primeiro.">
        <div className="space-y-5">
          <ChoiceCards label="Modo de sugestão" options={SMART_MODES} value={value.smartMode} disabled={disabled} onChange={(smartMode: SmartMode) => set({ ...value, smartMode })} />

          <div className="space-y-3 rounded-card border border-border bg-surface-sunken p-3">
            <p className="text-sm font-medium text-text-primary">Prévia</p>
            {activeServices.length === 0 ? (
              <p className="text-sm text-text-muted">Cadastre um serviço e uma sala ou profissional para ver a prévia.</p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="Serviço" htmlFor="preview-service">
                    <Select id="preview-service" value={previewService} onValueChange={setServiceId} options={activeServices.map((s) => ({ value: s._id, label: s.name }))} />
                  </FormField>
                  <FormField label="Dia de exemplo" htmlFor="preview-date">
                    <Input id="preview-date" type="date" value={previewDate} min={today} onChange={(e) => setDate(e.target.value)} />
                  </FormField>
                </div>
                <SuggestionPreviewView
                  loading={preview === undefined}
                  suggestions={preview?.suggestions ?? []}
                  chronological={preview?.chronological ?? []}
                  timezone={timezone}
                  off={value.smartMode === "off"}
                />
              </>
            )}
          </div>

          <CollapsibleSection title="Avançado: pesos">
            <div className="space-y-3 pb-3">
              <p className="text-sm text-text-muted">Quanto cada preferência pesa na escolha (0 a 1000). Maior = mais importante. Em geral não precisa mexer.</p>
              {WEIGHT_KEYS.map((k) => (
                <FormField key={`w:${k}`} label={WEIGHT_LABELS[k]}>
                  {(aria) => <Input {...aria} type="number" inputMode="numeric" min={0} max={1000} value={value.weights[k]} disabled={disabled} onChange={(e) => set({ ...value, weights: { ...value.weights, [k]: e.target.value } })} />}
                </FormField>
              ))}
              {showErrors && errors.weights && <p role="alert" className="text-sm text-semantic-error">{errors.weights}</p>}
              <FormField label="Mínimo de opções oferecidas" hint="Se houver poucos horários encostados, completa com os melhores até este número." error={showErrors ? errors.minOffer : undefined}>
                {(aria) => <Input {...aria} type="number" inputMode="numeric" min={1} max={10} value={value.minOffer} disabled={disabled} onChange={(e) => set({ ...value, minOffer: e.target.value })} />}
              </FormField>
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => set({ ...value, weights: { ...DEFAULT_WEIGHTS_FORM } })}>Restaurar padrões</Button>
            </div>
          </CollapsibleSection>
        </div>
      </SectionCard>

      <SectionCard title="O que a IA pode fazer na agenda" description="Você escolhe, ação por ação, quanto a IA decide sozinha.">
        <AiPolicyForm
          value={value}
          onChange={set}
          disabled={disabled}
          errors={showErrors ? errors : {}}
          ackNote={saved.hasAck && saved.ackAt !== undefined ? ackSentence({ by: saved.ackBy, dateText: formatDate(saved.ackAt, { timeZone: timezone }) }, me?._id, (id) => members?.find((m) => m._id === id)?.name) : undefined}
        />
      </SectionCard>

      {guard}
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onDiscard={() => { setDraft(null); setShowErrors(false); }} />
    </div>
  );
}
