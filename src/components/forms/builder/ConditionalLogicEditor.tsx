import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { GitBranch, Plus, X } from "lucide-react";
import type { ConditionalLogic } from "./types";
import { LAYOUT_FIELD_TYPES } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AvailableField {
  id: string;
  label: string;
  type: string;
}

interface ConditionalLogicEditorProps {
  logic: ConditionalLogic | undefined;
  onChange: (logic: ConditionalLogic | undefined) => void;
  fields: AvailableField[];
  currentFieldId: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

type Operator = ConditionalLogic["conditions"][number]["operator"];

const OPERATOR_LABELS: Record<Operator, string> = {
  equals: "é igual a",
  not_equals: "não é igual a",
  contains: "contém",
  not_contains: "não contém",
  is_empty: "está vazio",
  is_not_empty: "não está vazio",
  greater_than: "maior que",
  less_than: "menor que",
};

/** Operators that have no value input */
const VALUE_LESS_OPERATORS: Operator[] = ["is_empty", "is_not_empty"];

const DEFAULT_LOGIC: ConditionalLogic = {
  action: "show",
  logic: "all",
  conditions: [],
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToggleSwitch({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "relative flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-200",
        "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay",
        checked
          ? "bg-brand-600"
          : "bg-surface-overlay border border-border-strong"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm",
          "transition-transform duration-200",
          checked ? "translate-x-4" : "translate-x-0"
        )}
        aria-hidden="true"
      />
    </button>
  );
}

/** Two-button segment control (same pattern as width selector in FieldConfigPanel) */
function SegmentControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <fieldset>
      <legend className="sr-only">{label}</legend>
      <div className="flex gap-2">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={value === opt.value}
            className={cn(
              "flex-1 py-2 text-sm rounded-lg border transition-all duration-150",
              "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay",
              value === opt.value
                ? "border-brand-500 bg-brand-500/10 text-brand-500 font-medium"
                : "border-border-strong bg-surface-raised text-text-secondary hover:border-border"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** A single condition row */
function ConditionRow({
  condition,
  availableFields,
  onUpdate,
  onRemove,
  index,
}: {
  condition: ConditionalLogic["conditions"][number];
  availableFields: AvailableField[];
  onUpdate: (patch: Partial<ConditionalLogic["conditions"][number]>) => void;
  onRemove: () => void;
  index: number;
}) {
  const showValueInput = !VALUE_LESS_OPERATORS.includes(condition.operator);

  const selectClass = cn(
    "w-full bg-surface-raised border border-border-strong rounded-field",
    "px-3.5 py-2.5 text-base md:text-sm text-text-primary",
    "transition-colors duration-150",
    "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
    "appearance-none"
  );

  const inputClass = cn(
    "w-full bg-surface-raised border border-border-strong rounded-field",
    "px-3.5 py-2.5 text-base md:text-sm text-text-primary placeholder:text-text-muted",
    "transition-colors duration-150",
    "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
  );

  return (
    <div
      className="rounded-lg bg-surface-sunken border border-border-subtle p-3 space-y-2"
      role="group"
      aria-label={`Condição ${index + 1}`}
    >
      {/* Row header: condition index + remove button */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
          Condição {index + 1}
        </span>
        <button
          type="button"
          aria-label={`Remover condição ${index + 1}`}
          onClick={onRemove}
          className={cn(
            "p-1.5 rounded-md text-text-muted transition-colors",
            "hover:text-semantic-error hover:bg-semantic-error/10",
            "focus:outline-none focus:ring-2 focus:ring-semantic-error"
          )}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {/* Field selector */}
      <div>
        <label
          htmlFor={`condition-field-${index}`}
          className="block text-[12px] font-medium text-text-secondary mb-1"
        >
          Campo
        </label>
        <select
          id={`condition-field-${index}`}
          value={condition.fieldId}
          onChange={(e) => onUpdate({ fieldId: e.target.value })}
          className={selectClass}
        >
          {availableFields.length === 0 ? (
            <option value="" disabled>
              Nenhum campo disponível
            </option>
          ) : (
            availableFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label || "(sem rótulo)"}
              </option>
            ))
          )}
        </select>
      </div>

      {/* Operator selector */}
      <div>
        <label
          htmlFor={`condition-operator-${index}`}
          className="block text-[12px] font-medium text-text-secondary mb-1"
        >
          Operador
        </label>
        <select
          id={`condition-operator-${index}`}
          value={condition.operator}
          onChange={(e) =>
            onUpdate({
              operator: e.target.value as Operator,
              // Clear value when switching to a valueless operator
              value: VALUE_LESS_OPERATORS.includes(e.target.value as Operator)
                ? undefined
                : condition.value,
            })
          }
          className={selectClass}
        >
          {(Object.entries(OPERATOR_LABELS) as [Operator, string][]).map(
            ([op, label]) => (
              <option key={op} value={op}>
                {label}
              </option>
            )
          )}
        </select>
      </div>

      {/* Value input — hidden for is_empty / is_not_empty */}
      {showValueInput && (
        <div>
          <label
            htmlFor={`condition-value-${index}`}
            className="block text-[12px] font-medium text-text-secondary mb-1"
          >
            Valor
          </label>
          <input
            id={`condition-value-${index}`}
            type="text"
            value={condition.value ?? ""}
            onChange={(e) =>
              onUpdate({ value: e.target.value || undefined })
            }
            placeholder="Ex: Sim"
            className={inputClass}
          />
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ConditionalLogicEditor({
  logic,
  onChange,
  fields,
  currentFieldId,
}: ConditionalLogicEditorProps) {
  const isEnabled = logic !== undefined;

  /** Fields available for condition selection — exclude current field and layout-only types */
  const availableFields = fields.filter(
    (f) =>
      f.id !== currentFieldId &&
      !LAYOUT_FIELD_TYPES.includes(f.type as (typeof LAYOUT_FIELD_TYPES)[number])
  );

  // ── Handlers ────────────────────────────────────────────────────────────────

  function handleToggle() {
    if (isEnabled) {
      onChange(undefined);
    } else {
      onChange({ ...DEFAULT_LOGIC });
    }
  }

  function updateLogic(patch: Partial<ConditionalLogic>) {
    if (!logic) return;
    onChange({ ...logic, ...patch });
  }

  function addCondition() {
    if (!logic) return;
    const firstField = availableFields[0];
    const newCondition: ConditionalLogic["conditions"][number] = {
      fieldId: firstField?.id ?? "",
      operator: "equals",
      value: undefined,
    };
    updateLogic({ conditions: [...logic.conditions, newCondition] });
  }

  function updateCondition(
    index: number,
    patch: Partial<ConditionalLogic["conditions"][number]>
  ) {
    if (!logic) return;
    const updated = logic.conditions.map((c, i) =>
      i === index ? { ...c, ...patch } : c
    );
    updateLogic({ conditions: updated });
  }

  function removeCondition(index: number) {
    if (!logic) return;
    const updated = logic.conditions.filter((_, i) => i !== index);
    updateLogic({ conditions: updated });
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <section
      aria-label="Lógica condicional"
      className="rounded-lg border border-border-subtle overflow-hidden"
    >
      {/* ── Section header / enable toggle ──────────────────────── */}
      <div
        className={cn(
          "flex items-center justify-between gap-3 px-4 py-3",
          isEnabled
            ? "bg-surface-sunken border-b border-border-subtle"
            : "bg-surface-sunken"
        )}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <GitBranch
            size={16}
            className={cn(
              "flex-shrink-0 transition-colors",
              isEnabled ? "text-brand-500" : "text-text-muted"
            )}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p
              className={cn(
                "text-sm font-medium transition-colors",
                isEnabled ? "text-text-primary" : "text-text-secondary"
              )}
            >
              Lógica condicional
            </p>
            {!isEnabled && (
              <p className="text-[12px] text-text-muted mt-0.5 hidden sm:block">
                Mostrar ou ocultar este campo com base em outros campos
              </p>
            )}
          </div>
        </div>

        <ToggleSwitch
          checked={isEnabled}
          onToggle={handleToggle}
          label="Ativar lógica condicional"
        />
      </div>

      {/* ── Expanded body (only when enabled) ──────────────────── */}
      {isEnabled && logic && (
        <div className="bg-surface-raised px-4 py-4 space-y-4">

          {/* ── Action selector ───────────────────────────────────── */}
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
Ação
            </label>
            <SegmentControl
              label="Ação condicional"
              value={logic.action}
              options={[
                { value: "show", label: "Mostrar" },
                { value: "hide", label: "Ocultar" },
              ]}
              onChange={(v) => updateLogic({ action: v })}
            />
          </div>

          {/* ── Logic combinator selector ─────────────────────────── */}
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Este campo quando
            </label>
            <SegmentControl
              label="Combinador de condições"
              value={logic.logic}
              options={[
                { value: "all", label: "Todas as condições" },
                { value: "any", label: "Qualquer condição" },
              ]}
              onChange={(v) => updateLogic({ logic: v })}
            />
          </div>

          {/* ── Condition rows ────────────────────────────────────── */}
          {logic.conditions.length > 0 ? (
            <div className="space-y-2" role="list" aria-label="Condições">
              {logic.conditions.map((condition, index) => (
                <div key={index} role="listitem">
                  <ConditionRow
                    condition={condition}
                    availableFields={availableFields}
                    onUpdate={(patch) => updateCondition(index, patch)}
                    onRemove={() => removeCondition(index)}
                    index={index}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-text-muted text-center py-3 bg-surface-sunken rounded-lg border border-border-subtle">
              Nenhuma condição adicionada. Clique em "Adicionar condição" abaixo.
            </p>
          )}

          {/* ── Add condition button ──────────────────────────────── */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addCondition}
            disabled={availableFields.length === 0}
            aria-label="Adicionar condição"
            className="w-full"
          >
            <Plus size={14} aria-hidden="true" />
            Adicionar condição
          </Button>

          {availableFields.length === 0 && (
            <p className="text-[12px] text-text-muted text-center -mt-2">
              Adicione outros campos ao formulário para criar condições.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
