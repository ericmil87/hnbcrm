import { Link } from "react-router";
import { Globe } from "lucide-react";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { GRID_MINUTES_OPTIONS } from "../../../../convex/lib/schedConstants";
import { stageChoiceGroups, type FormErrors, type GeneralForm, type StageOption } from "@/lib/agendaConfigForms";
import { TAB_ROUTES } from "@/lib/routes";
import { NoticeField } from "./NoticeField";

interface GeneralSettingsFormProps {
  value: GeneralForm;
  onChange: (next: GeneralForm) => void;
  errors?: FormErrors<"gridMinutes" | "minNotice" | "maxAdvanceDays">;
  disabled?: boolean;
  services: Array<{ _id: string; name: string }>;
  boards: Array<{ _id: string; name: string; stages: StageOption[] }>;
  timezoneLabel: string;
}

/** Ajustes gerais da Agenda (controlado, sem Convex). */
export function GeneralSettingsForm({ value, onChange, errors = {}, disabled, services, boards, timezoneLabel }: GeneralSettingsFormProps) {
  const set = (patch: Partial<GeneralForm>) => onChange({ ...value, ...patch });
  const groups = (selected: string) => stageChoiceGroups(boards, [selected]);
  const stageSelect = (label: string, hint: string, key: "onScheduledStageId" | "onCompletedStageId" | "onNoShowStageId") => (
    <FormField label={label} hint={hint}>
      {(aria) => (
        <Select {...aria} value={value[key]} disabled={disabled} onValueChange={(v) => set({ [key]: v } as Partial<GeneralForm>)} options={[{ value: "", label: "Não mover" }]} groups={groups(value[key])} />
      )}
    </FormField>
  );
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <p className="text-sm font-medium text-text-primary">Horários oferecidos</p>
        <FormField label="De quanto em quanto tempo" hint="Os horários livres aparecem neste passo, por exemplo de 30 em 30 minutos." error={errors.gridMinutes}>
          {(aria) => (
            <Select {...aria} value={value.gridMinutes} disabled={disabled} onValueChange={(gridMinutes) => set({ gridMinutes })} options={GRID_MINUTES_OPTIONS.map((m) => ({ value: String(m), label: `${m} minutos` }))} />
          )}
        </FormField>
        <NoticeField label="Antecedência mínima" hint="Quanto tempo antes a IA e o link público podem marcar. A equipe pode marcar a qualquer hora." value={value.minNotice} error={errors.minNotice} disabled={disabled} onChange={(minNotice) => set({ minNotice })} />
        <FormField label="Até quantos dias à frente" hint="Quão longe no futuro dá para marcar." error={errors.maxAdvanceDays}>
          {(aria) => <Input {...aria} type="number" inputMode="numeric" min={1} max={730} value={value.maxAdvanceDays} disabled={disabled} onChange={(e) => set({ maxAdvanceDays: e.target.value })} />}
        </FormField>
        <p className="flex items-start gap-2 rounded-card border border-border bg-surface-sunken p-3 text-sm text-text-secondary">
          <Globe size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden="true" />
          <span>
            Os horários seguem o fuso da empresa: <strong>{timezoneLabel}</strong>. Para mudar, vá em{" "}
            <Link className="font-medium text-brand-500 underline" to={`${TAB_ROUTES.settings}?secao=general`}>Configurações › Dados da empresa</Link>
            . Não dá para trocar o fuso enquanto houver horários marcados no futuro.
          </span>
        </p>
      </section>

      <section className="space-y-3">
        <p className="text-sm font-medium text-text-primary">Confirmações pelo WhatsApp</p>
        <FormField label="Serviço padrão" hint="Usado quando a confirmação do cliente não diz qual serviço é.">
          {(aria) => (
            <Select {...aria} value={value.defaultServiceId} disabled={disabled} onValueChange={(defaultServiceId) => set({ defaultServiceId })} options={[{ value: "", label: "Nenhum" }, ...services.map((s) => ({ value: s._id, label: s.name }))]} />
          )}
        </FormField>
      </section>

      <section className="space-y-3">
        <div>
          <p className="text-sm font-medium text-text-primary">Etapa do funil</p>
          <p className="text-sm text-text-muted">Mova o lead de etapa sozinho. Etapas de perda não aparecem: elas pedem um motivo.</p>
        </div>
        {stageSelect("Ao marcar um horário", "O lead vai para esta etapa quando o horário é marcado.", "onScheduledStageId")}
        {stageSelect("Ao atender", "Quando o atendimento é concluído.", "onCompletedStageId")}
        {stageSelect("Quando o cliente faltar", "Quando o horário é marcado como falta.", "onNoShowStageId")}
      </section>
    </div>
  );
}
