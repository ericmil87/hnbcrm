import { useEffect, useState } from "react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { ChoiceCards } from "@/components/agenda/ChoiceCards";
import { AiPolicyForm } from "@/components/settings/agenda/AiPolicyForm";
import { defaultAutomationForm, needsAutoAck, type AutomationForm } from "@/lib/agendaAutomation";
import { VOCAB } from "@/lib/vocab";
import { Spinner } from "@/components/ui/Spinner";
import { Stepper } from "@/components/ui/Stepper";
import { WeeklyHoursEditor } from "@/components/agenda/WeeklyHoursEditor";
import { weekErrors, weekSummary, type WeekForm } from "@/lib/agendaWeek";
import {
  addSetupResource, addSetupService, draftToForm, formToDraft, hasSetupErrors, removeSetupResource, removeSetupService, setupErrors, setupSummary,
  updateSetupResource, updateSetupService, SETUP_MAX_RESOURCES, SETUP_MAX_SERVICES, type SetupForm,
} from "@/lib/agendaSetupDraft";
import { SCHED_TEMPLATE_KEYS, SCHED_TEMPLATE_LABELS, type SchedTemplateDraft, type SchedTemplateKey } from "../../../../convex/lib/schedTemplates";

type StepId = "model" | "adjust" | "ai";
const STEPS = [
  { id: "model", label: VOCAB.scheduling.onboarding.steps.model },
  { id: "adjust", label: VOCAB.scheduling.onboarding.steps.review },
  { id: "ai", label: VOCAB.scheduling.onboarding.steps.ai },
];

export interface AgendaSetupWizardViewProps {
  open: boolean;
  onClose: () => void;
  templateKey: SchedTemplateKey | null;
  onTemplateChange: (key: SchedTemplateKey) => void;
  /** Rascunho do servidor: `undefined` carregando, `null` indisponível. */
  serverDraft: SchedTemplateDraft | null | undefined;
  submitting: boolean;
  /** Mensagem do servidor da última tentativa (ex.: agenda já tem dados). */
  error: string | null;
  onApply: (draft: SchedTemplateDraft, ai: AutomationForm) => void;
  /** A agenda foi criada, mas a escolha da IA não foi salva: a tela explica e só oferece fechar. */
  partialNotice?: string | null;
}

/** Assistente de 3 passos. Apresentacional: o container liga `previewTemplate` e `applyTemplate`. */
export function AgendaSetupWizardView({ open, onClose, templateKey, onTemplateChange, serverDraft, submitting, error, onApply, partialNotice = null }: AgendaSetupWizardViewProps) {
  const [step, setStep] = useState<StepId>("model");
  const [formState, setFormState] = useState<SetupForm | null>(null);
  // Chave do modelo cujo rascunho já virou formulário: atualização do servidor com o assistente aberto NÃO
  // descarta o que a pessoa editou; só trocar de modelo recomeça.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [ai, setAi] = useState<AutomationForm>(() => defaultAutomationForm());
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (serverDraft && serverDraft.templateKey === templateKey && loadedKey !== templateKey) {
      setFormState(draftToForm(serverDraft));
      setLoadedKey(templateKey);
    }
  }, [serverDraft, templateKey, loadedKey]);

  // Reabrir recomeça do primeiro passo (o que foi editado fica).
  useEffect(() => {
    if (open) {
      setStep("model");
      setShowErrors(false);
    }
  }, [open]);

  const form = loadedKey === templateKey ? formState : null;
  const setForm = (next: SetupForm | null) => setFormState(next);

  const errors = form ? setupErrors(form) : null;
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const loading = templateKey !== null && serverDraft === undefined;
  const unavailable = templateKey !== null && serverDraft === null;

  const toAdjust = () => setStep("adjust");
  const toAi = () => {
    if (errors && hasSetupErrors(errors)) {
      setShowErrors(true);
      return;
    }
    setStep("ai");
  };

  const set = (next: SetupForm) => setForm(next);

  return (
    <Modal open={open} onClose={onClose} title={VOCAB.scheduling.onboarding.title} className="sm:max-w-2xl">
      <div className="space-y-5">
        <Stepper steps={STEPS} current={step} completed={STEPS.slice(0, stepIndex).map((s) => s.id)} ariaLabel="Passos do assistente" />

        {step === "model" && (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary">Escolha o que mais se parece com o seu negócio. Preparamos salas, profissionais, serviços e horários para você ajustar no próximo passo.</p>
            <ChoiceCards
              label={VOCAB.scheduling.onboarding.steps.model}
              columns={2}
              options={SCHED_TEMPLATE_KEYS.map((key) => ({ value: key, title: SCHED_TEMPLATE_LABELS[key].title, hint: SCHED_TEMPLATE_LABELS[key].description }))}
              value={templateKey}
              onChange={onTemplateChange}
            />
            {loading && <div className="flex justify-center py-2"><Spinner /></div>}
            {unavailable && <p role="alert" className="text-sm text-semantic-error">Não foi possível preparar este modelo. Tente de novo.</p>}
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={onClose}>Agora não</Button>
              <Button className="flex-1" disabled={!form} onClick={toAdjust}>Continuar</Button>
            </div>
          </div>
        )}

        {step === "adjust" && form && errors && (
          <div className="space-y-6">
            <ResourceBlock title="Salas" kind="room" form={form} onChange={set} errors={showErrors ? errors : null} />
            <ResourceBlock title="Profissionais" kind="person" form={form} onChange={set} errors={showErrors ? errors : null} />
            {form.resources.some((r) => r.kind === "equipment") && <ResourceBlock title="Equipamentos" kind="equipment" form={form} onChange={set} errors={showErrors ? errors : null} />}

            <section className="space-y-3">
              <h3 className="text-base font-semibold text-text-primary">Serviços</h3>
              {form.services.map((s, i) => (
                <div key={`svc:${i}`} className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <FormField label={`Serviço ${i + 1}`} error={showErrors ? errors.services[i]?.name : undefined}>
                      {(aria) => <Input {...aria} value={s.name} maxLength={60} onChange={(e) => set(updateSetupService(form, i, { name: e.target.value }))} />}
                    </FormField>
                  </div>
                  <div className="w-28 shrink-0">
                    <FormField label="Minutos" error={showErrors ? errors.services[i]?.durationMin : undefined}>
                      {(aria) => <Input {...aria} type="number" inputMode="numeric" value={s.durationMin} onChange={(e) => set(updateSetupService(form, i, { durationMin: e.target.value }))} />}
                    </FormField>
                  </div>
                  {form.services.length > 1 && (
                    <Button iconOnly variant="ghost" aria-label={`Remover serviço ${s.name || i + 1}`} onClick={() => set(removeSetupService(form, i))}>
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  )}
                </div>
              ))}
              {form.services.length < SETUP_MAX_SERVICES && (
                <Button size="sm" variant="secondary" onClick={() => set(addSetupService(form))}>
                  <Plus size={14} aria-hidden="true" /> Adicionar serviço
                </Button>
              )}
            </section>

            <section className="space-y-3">
              <div>
                <h3 className="text-base font-semibold text-text-primary">Horário de funcionamento</h3>
                <p className="text-sm text-text-muted">Vale para todas as salas e profissionais. Depois você pode dar um horário diferente a cada um.</p>
              </div>
              <WeeklyHoursEditor value={form.week} onChange={(week: WeekForm) => set({ ...form, week })} errors={showErrors ? weekErrors(form.week) : undefined} />
              {showErrors && errors.week && !Object.keys(weekErrors(form.week)).length && <p role="alert" className="text-sm text-semantic-error">{errors.week}</p>}
            </section>

            <section className="space-y-1 rounded-card border border-border bg-surface-sunken p-3 text-sm text-text-primary" aria-label="Resumo">
              <p className="font-medium">Vamos criar</p>
              <ul className="space-y-0.5">
                {setupSummary(form).map((l) => <li key={l}>{l}</li>)}
                <li className="text-text-secondary">{weekSummary(form.week)}</li>
              </ul>
              <p className="text-text-muted">Nada é marcado ainda: isto só cria a estrutura da agenda. Você muda tudo depois em Configurações.</p>
            </section>

            {showErrors && errors.general.map((m) => <p key={m} role="alert" className="text-sm text-semantic-error">{m}</p>)}
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setStep("model")}>
                <ArrowLeft size={16} aria-hidden="true" /> Voltar
              </Button>
              <Button className="flex-1" onClick={toAi}>Continuar</Button>
            </div>
          </div>
        )}

        {step === "ai" && form && (
          <div className="space-y-4">
            {partialNotice ? (
              <>
                <p role="status" className="rounded-card border border-semantic-warning/30 bg-semantic-warning/5 p-3 text-sm text-text-primary">{partialNotice}</p>
                <Button className="w-full" onClick={onClose}>Fechar</Button>
              </>
            ) : (
              <>
                <p className="text-sm text-text-secondary">Escolha quanto a IA decide sozinha na agenda. Você pode mudar isso quando quiser em Configurações › Sugestões e IA.</p>
                <AiPolicyForm variant="wizard" value={ai} onChange={setAi} disabled={submitting} />
                {error && <p role="alert" className="rounded-card border border-semantic-error/30 bg-semantic-error/5 p-3 text-sm text-semantic-error">{error}</p>}
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" disabled={submitting} onClick={() => setStep("adjust")}>
                    <ArrowLeft size={16} aria-hidden="true" /> Voltar
                  </Button>
                  <Button className="flex-1" loading={submitting} disabled={needsAutoAck(ai)} onClick={() => onApply(formToDraft(form), ai)}>Criar minha agenda</Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ResourceBlock({ title, kind, form, onChange, errors }: { title: string; kind: "room" | "person" | "equipment"; form: SetupForm; onChange: (f: SetupForm) => void; errors: ReturnType<typeof setupErrors> | null }) {
  const rows = form.resources.filter((r) => r.kind === kind);
  const addLabel = kind === "room" ? "Adicionar sala" : kind === "person" ? "Adicionar profissional" : "Adicionar equipamento";
  return (
    <section className="space-y-3">
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      {rows.map((r, i) => (
        <div key={`res:${r.ref}`} className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <FormField label={`${kind === "room" ? "Sala" : kind === "person" ? "Profissional" : "Equipamento"} ${i + 1}`} error={errors?.resources[r.ref]?.name}>
              {(aria) => <Input {...aria} value={r.name} maxLength={60} onChange={(e) => onChange(updateSetupResource(form, r.ref, { name: e.target.value }))} />}
            </FormField>
          </div>
          {kind !== "person" && (
            <div className="w-36 shrink-0">
              <FormField label="Pessoas ao mesmo tempo" error={errors?.resources[r.ref]?.capacity}>
                {(aria) => <Input {...aria} type="number" inputMode="numeric" min={1} max={50} value={r.capacity} onChange={(e) => onChange(updateSetupResource(form, r.ref, { capacity: e.target.value }))} />}
              </FormField>
            </div>
          )}
          <Button iconOnly variant="ghost" aria-label={`Remover ${r.name || `${title.toLowerCase()} ${i + 1}`}`} onClick={() => onChange(removeSetupResource(form, r.ref))}>
            <Trash2 size={16} aria-hidden="true" />
          </Button>
        </div>
      ))}
      {kind === "room" && <p className="text-sm text-text-muted">Uma sala que atende 2 pessoas ao mesmo tempo (um casal, por exemplo) tem <strong>2</strong> em &ldquo;Pessoas ao mesmo tempo&rdquo;.</p>}
      {form.resources.length < SETUP_MAX_RESOURCES && (
        <Button size="sm" variant="secondary" onClick={() => onChange(addSetupResource(form, kind))}>
          <Plus size={14} aria-hidden="true" /> {addLabel}
        </Button>
      )}
    </section>
  );
}
