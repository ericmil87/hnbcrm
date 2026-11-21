import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { formatDate } from "@/lib/format";
import type { AiLevel, AutomationForm, HumanConfirmMode } from "@/lib/agendaAutomation";
import { cn } from "@/lib/utils";
import { VOCAB } from "@/lib/vocab";

type AutoField = "book" | "reschedule" | "cancel";

interface AiPolicyFormProps {
  value: AutomationForm;
  onChange: (next: AutomationForm) => void;
  disabled?: boolean;
  errors?: { maxAiBookingsPerContactPerDay?: string };
}

function Choice<T extends string>({ label, options, value, onPick, disabled }: { label: string; options: Array<{ value: T; title: string; hint: string }>; value: T; onPick: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-3">
      {options.map((o) => (
        <button
          key={`${label}:${o.value}`}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onPick(o.value)}
          className={cn(
            "min-h-11 rounded-card border p-3 text-left transition-colors disabled:opacity-60",
            value === o.value ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface-raised hover:border-border-strong"
          )}
        >
          <span className="block text-sm font-medium text-text-primary">{o.title}</span>
          <span className="mt-1 block text-sm text-text-muted">{o.hint}</span>
        </button>
      ))}
    </div>
  );
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

/** Política da IA por ação, com AVISO + ACEITE ao escolher "marca sozinha". Controlado, sem Convex. */
export function AiPolicyForm({ value, onChange, disabled, errors = {} }: AiPolicyFormProps) {
  const [pending, setPending] = useState<{ field: AutoField } | null>(null);
  const set = (patch: Partial<AutomationForm>) => onChange({ ...value, ...patch });
  const pick = (field: AutoField, level: AiLevel | "handoff") => {
    if (level === "auto" && !value.hasAck && !value.ackAcceptedNow) {
      setPending({ field });
      return;
    }
    set({ [field]: level } as Partial<AutomationForm>);
  };
  const confirmAck = () => {
    if (pending) onChange({ ...value, [pending.field]: "auto", ackAcceptedNow: true });
    setPending(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Consultar horários livres</p>
          <p className="text-sm text-text-muted">A IA vê o que está livre e responde ao cliente.</p>
        </div>
        <Switch checked={value.consult} onCheckedChange={(consult) => set({ consult })} label="Consultar horários livres" hideLabel disabled={disabled} />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-text-primary">Marcar horário</p>
        <Choice label="Marcar horário" options={LEVELS("marca")} value={value.book} disabled={disabled} onPick={(v) => pick("book", v)} />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-text-primary">Remarcar</p>
        <Choice label="Remarcar" options={LEVELS("remarca")} value={value.reschedule} disabled={disabled} onPick={(v) => pick("reschedule", v)} />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-text-primary">Cancelar</p>
        <Choice
          label="Cancelar"
          options={[
            { value: "handoff" as const, title: "Chama a equipe", hint: "O cancelamento passa por uma pessoa." },
            { value: "auto" as const, title: "Cancela sozinha", hint: "Vale na hora, sem passar por você." },
          ]}
          value={value.cancel}
          disabled={disabled}
          onPick={(v) => pick("cancel", v)}
        />
      </div>
      {value.hasAck && value.ackAt !== undefined && (
        <p className="text-sm text-text-muted">Você aceitou o aviso do &ldquo;marca sozinha&rdquo; em {formatDate(value.ackAt)}.</p>
      )}

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

      <div className="space-y-2">
        <p className="text-sm font-medium text-text-primary">Interpretar minhas confirmações pelo WhatsApp</p>
        <p className="text-sm text-text-muted">Quando você escreve para o cliente &ldquo;fechado, quinta às 10h&rdquo;, o sistema entende o horário e marca para você. Na dúvida, ele só sugere: nunca marca por conta própria sem ter certeza.</p>
        <Choice label="Interpretar minhas confirmações pelo WhatsApp" options={CONFIRM} value={value.humanConfirmMode} disabled={disabled} onPick={(humanConfirmMode) => set({ humanConfirmMode })} />
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmAck}
        title="A IA vai agir sozinha"
        description={VOCAB.scheduling.autoAck.text}
        confirmLabel={VOCAB.scheduling.autoAck.confirm}
        cancelLabel="Voltar"
      />
    </div>
  );
}
