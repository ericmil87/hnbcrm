import { useState } from "react";
import { ChoiceCards } from "@/components/agenda/ChoiceCards";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { applyWizardAiChoice, autoAckText, type AiLevel, type AutomationForm, type HumanConfirmMode } from "@/lib/agendaAutomation";
import { VOCAB } from "@/lib/vocab";

type AutoField = "book" | "reschedule" | "cancel";

interface AiPolicyFormProps {
  value: AutomationForm;
  onChange: (next: AutomationForm) => void;
  disabled?: boolean;
  errors?: { maxAiBookingsPerContactPerDay?: string };
  /** `wizard`: uma escolha só (não mexe / propõe / marca sozinha) e o interruptor das confirmações. */
  variant?: "panel" | "wizard";
  /** "Você aceitou ... em 12/11/2026." (já montado; só aparece com aceite gravado). */
  ackNote?: string;
}

const LEVELS = (verb: string): Array<{ value: AiLevel; title: string; hint: string }> => [
  { value: "off", title: VOCAB.scheduling.onboarding.aiOptions.off, hint: `A IA não ${verb}.` },
  { value: "propose", title: VOCAB.scheduling.onboarding.aiOptions.propose, hint: "Ela escolhe o horário e você aprova antes de valer." },
  { value: "auto", title: VOCAB.scheduling.onboarding.aiOptions.auto, hint: "Vale na hora, sem passar por você." },
];

const CONFIRM: Array<{ value: HumanConfirmMode; title: string; hint: string }> = [
  { value: "auto", title: "Marcar sozinho", hint: "Quando você confirma um horário na conversa, o sistema marca." },
  { value: "suggest", title: "Só sugerir", hint: "O sistema mostra a sugestão e você toca para marcar." },
  { value: "off", title: "Desligado", hint: "O sistema não interpreta suas mensagens." },
];

const INTERPRET_EXPLAIN =
  "Quando você escreve para o cliente “fechado, quinta às 10h”, o sistema entende o horário e marca para você. Na dúvida, ele só sugere: nunca marca por conta própria sem ter certeza.";

/** Política da IA por ação, com AVISO + ACEITE ao escolher "marca sozinha". Controlado, sem Convex. */
export function AiPolicyForm({ value, onChange, disabled, errors = {}, variant = "panel", ackNote }: AiPolicyFormProps) {
  const [pending, setPending] = useState<{ next: AutomationForm } | null>(null);
  const set = (patch: Partial<AutomationForm>) => onChange({ ...value, ...patch });
  const needsAsk = (next: AutomationForm) => next.book === "auto" || next.reschedule === "auto" || next.cancel === "auto" ? !value.hasAck && !value.ackAcceptedNow : false;

  const pick = (field: AutoField, level: AiLevel | "handoff") => {
    const next = { ...value, [field]: level } as AutomationForm;
    if (level === "auto" && needsAsk(next)) setPending({ next });
    else onChange(next);
  };
  const pickWizard = (level: AiLevel) => {
    const next = applyWizardAiChoice(value, level);
    if (level === "auto" && needsAsk(next)) setPending({ next });
    else onChange(next);
  };
  const confirmAck = () => {
    if (pending) onChange({ ...pending.next, ackAcceptedNow: true });
    setPending(null);
  };

  const interpret =
    variant === "wizard" ? (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{VOCAB.scheduling.onboarding.understandConfirmations}</p>
          <p className="mt-0.5 text-sm text-text-muted">{INTERPRET_EXPLAIN}</p>
        </div>
        <Switch
          checked={value.humanConfirmMode !== "off"}
          onCheckedChange={(on) => set({ humanConfirmMode: on ? "auto" : "off" })}
          label="Interpretar minhas confirmações pelo WhatsApp"
          hideLabel
          disabled={disabled}
        />
      </div>
    ) : (
      <div className="space-y-2">
        <p className="text-sm font-medium text-text-primary">Interpretar minhas confirmações pelo WhatsApp</p>
        <p className="text-sm text-text-muted">{INTERPRET_EXPLAIN}</p>
        <ChoiceCards label="Interpretar minhas confirmações pelo WhatsApp" options={CONFIRM} value={value.humanConfirmMode} disabled={disabled} onChange={(humanConfirmMode) => set({ humanConfirmMode })} />
      </div>
    );

  return (
    <div className="space-y-6">
      {variant === "wizard" ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-text-primary">{VOCAB.scheduling.onboarding.steps.ai}</p>
          <ChoiceCards label={VOCAB.scheduling.onboarding.steps.ai} options={LEVELS("mexe na agenda")} value={value.book} disabled={disabled} onChange={pickWizard} />
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">Consultar horários livres</p>
              <p className="text-sm text-text-muted">A IA vê o que está livre e responde ao cliente.</p>
            </div>
            <Switch checked={value.consult} onCheckedChange={(consult) => set({ consult })} label="Consultar horários livres" hideLabel disabled={disabled} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-text-primary">Marcar horário</p>
            <ChoiceCards label="Marcar horário" options={LEVELS("marca")} value={value.book} disabled={disabled} onChange={(v) => pick("book", v)} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-text-primary">Remarcar</p>
            <ChoiceCards label="Remarcar" options={LEVELS("remarca")} value={value.reschedule} disabled={disabled} onChange={(v) => pick("reschedule", v)} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-text-primary">Cancelar</p>
            <ChoiceCards
              label="Cancelar"
              columns={2}
              options={[
                { value: "handoff" as const, title: "Chama a equipe", hint: "O cancelamento passa por uma pessoa." },
                { value: "auto" as const, title: "Cancela sozinha", hint: "Vale na hora, sem passar por você." },
              ]}
              value={value.cancel}
              disabled={disabled}
              onChange={(v) => pick("cancel", v)}
            />
          </div>
          {ackNote && <p className="text-sm text-text-muted">{ackNote}</p>}

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">Primeira visita sempre com aprovação</p>
              <p className="text-sm text-text-muted">Mesmo com a IA marcando sozinha, quem nunca veio antes passa pela sua aprovação.</p>
            </div>
            <Switch checked={value.firstVisitNeedsApproval} onCheckedChange={(firstVisitNeedsApproval) => set({ firstVisitNeedsApproval })} label="Primeira visita sempre com aprovação" hideLabel disabled={disabled} />
          </div>

          <FormField label="Limite de marcações da IA por cliente, por dia" error={errors.maxAiBookingsPerContactPerDay}>
            {(aria) => <Input {...aria} type="number" inputMode="numeric" min={1} max={50} value={value.maxAiBookingsPerContactPerDay} disabled={disabled} onChange={(e) => set({ maxAiBookingsPerContactPerDay: e.target.value })} />}
          </FormField>
        </>
      )}

      {interpret}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmAck}
        title="A IA vai agir sozinha"
        description={pending ? autoAckText(pending.next) : undefined}
        confirmLabel={VOCAB.scheduling.autoAck.confirm}
        cancelLabel="Voltar"
      />
    </div>
  );
}
