import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { FormField } from "@/components/ui/FormField";
import type { ConfigFormProps, PipelineForm } from "@/lib/attendantConfig";
import { NumberField, SwitchRow } from "./fields";

export interface FunnelOptions {
  boards: ReadonlyArray<{ _id: string; name: string }>;
  /** Etapas do funil escolhido (vazio enquanto nenhum funil foi escolhido). */
  stages: ReadonlyArray<{ _id: string; name: string }>;
  /** Campos personalizados de lead; `undefined` = carregando. */
  leadFields: ReadonlyArray<{ key: string; name: string }> | undefined;
}

/** Funil dos leads novos e regras para a IA mover etapas. Dados chegam por `options`. */
export function FunnelRulesForm({
  value,
  onChange,
  disabled,
  errors,
  variant = "panel",
  options,
}: ConfigFormProps<PipelineForm> & { options: FunnelOptions }) {
  const panel = variant === "panel";
  const set = (patch: Partial<PipelineForm>) => onChange({ ...value, ...patch });
  const toggleField = (key: string) =>
    set({
      captureFields: value.captureFields.includes(key)
        ? value.captureFields.filter((k) => k !== key)
        : [...value.captureFields, key],
    });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <div className="flex-1 min-w-[220px]">
          <FormField label="Funil para novos leads">
            {(aria) => (
              <Select
                {...aria}
                value={value.boardId}
                disabled={disabled}
                onValueChange={(boardId) => set({ boardId, initialStageId: "", qualifiedStageId: "" })}
                options={[
                  { value: "", label: "Sem funil dedicado (comportamento atual)" },
                  ...options.boards.map((b) => ({ value: b._id, label: b.name })),
                ]}
              />
            )}
          </FormField>
        </div>
        <div className="flex-1 min-w-[220px]">
          <FormField label="Etapa inicial">
            {(aria) => (
              <Select
                {...aria}
                value={value.initialStageId}
                disabled={disabled || !value.boardId}
                onValueChange={(initialStageId) => set({ initialStageId })}
                options={[
                  { value: "", label: "Primeira etapa do funil" },
                  ...options.stages.map((s) => ({ value: s._id, label: s.name })),
                ]}
              />
            )}
          </FormField>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 items-start">
        <div className="flex-1 min-w-[220px]">
          <FormField label="Mover para esta etapa ao qualificar">
            {(aria) => (
              <Select
                {...aria}
                value={value.qualifiedStageId}
                disabled={disabled || !value.boardId}
                onValueChange={(qualifiedStageId) => set({ qualifiedStageId })}
                options={[
                  { value: "", label: "Não mover automaticamente" },
                  ...options.stages.map((s) => ({ value: s._id, label: s.name })),
                ]}
              />
            )}
          </FormField>
        </div>
        <NumberField
          className="w-28"
          label="Limiar BANT"
          min={1}
          max={4}
          value={String(value.qualifyThreshold)}
          disabled={disabled}
          error={errors?.qualifyThreshold}
          onChange={(raw) => set({ qualifyThreshold: raw.trim() === "" ? Number.NaN : Number(raw) })}
        />
      </div>
      {panel && (
        <p className="text-xs text-text-muted -mt-2">
          Ao atingir o limiar, o lead é movido automaticamente (apenas em Responder sozinha).
        </p>
      )}

      <Textarea
        label="Quando avançar o lead"
        rows={3}
        value={value.advanceRules}
        disabled={disabled}
        error={errors?.advanceRules}
        placeholder='Ex.: mova para "Proposta" quando o cliente pedir orçamento; para "Agendado" quando marcar visita.'
        onChange={(e) => set({ advanceRules: e.target.value })}
      />

      <SwitchRow
        title="Atendente pode mover leads no funil"
        description={
          panel
            ? "Desligado, a IA não move etapas por conta própria; a regra de qualificação acima continua valendo."
            : undefined
        }
        checked={value.allowMoveStages}
        disabled={disabled}
        onChange={(allowMoveStages) => set({ allowMoveStages })}
      />

      <div>
        <p className="text-sm font-medium text-text-primary mb-1">Campos que a IA captura</p>
        {panel && (
          <p className="text-xs text-text-muted mb-2">
            A IA preenche estes campos conforme a conversa revela (com validação de opções).
          </p>
        )}
        {options.leadFields === undefined ? (
          <Spinner size="sm" />
        ) : options.leadFields.length === 0 ? (
          <p className="text-xs text-text-muted">Nenhum campo personalizado de lead cadastrado.</p>
        ) : (
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {options.leadFields.map((f) => (
              <Checkbox
                key={f.key}
                checked={value.captureFields.includes(f.key)}
                disabled={disabled}
                onChange={() => toggleField(f.key)}
                label={
                  <span className="text-xs text-text-secondary">
                    {f.name} <span className="text-text-muted">({f.key})</span>
                  </span>
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
