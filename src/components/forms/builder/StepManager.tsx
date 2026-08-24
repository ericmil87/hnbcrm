import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import {
  Plus,
  Trash2,
  GripVertical,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  X,
} from "lucide-react";
import type { FormStep, FormField } from "./types";

// ── ID generator ────────────────────────────────────────────────────────────

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function genStepId(): string {
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return id;
}

// ── Toggle switch (shared pattern from FieldConfigPanel) ────────────────────

interface ToggleSwitchProps {
  checked: boolean;
  onToggle: () => void;
  label: string;
}

function ToggleSwitch({ checked, onToggle, label }: ToggleSwitchProps) {
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

// ── Icon-only action button ─────────────────────────────────────────────────

interface IconButtonProps {
  onClick: () => void;
  "aria-label": string;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}

function IconButton({
  onClick,
  "aria-label": ariaLabel,
  disabled = false,
  danger = false,
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "flex items-center justify-center w-8 h-8 rounded-lg transition-colors duration-150",
        "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised",
        "disabled:opacity-30 disabled:cursor-not-allowed",
        danger
          ? "text-text-muted hover:text-semantic-error hover:bg-semantic-error/10"
          : "text-text-muted hover:text-text-primary hover:bg-surface-overlay"
      )}
    >
      {children}
    </button>
  );
}

// ── Types ───────────────────────────────────────────────────────────────────

interface StepManagerProps {
  steps: FormStep[] | undefined;
  onChange: (steps: FormStep[] | undefined) => void;
  fields: FormField[];
}

// ── Step card ───────────────────────────────────────────────────────────────

interface StepCardProps {
  step: FormStep;
  index: number;
  totalSteps: number;
  allFields: FormField[];
  assignedFieldIds: Set<string>;
  onUpdate: (updated: FormStep) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function StepCard({
  step,
  index,
  totalSteps,
  allFields,
  assignedFieldIds,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
}: StepCardProps) {
  const [expanded, setExpanded] = useState(true);

  // Fields assigned to THIS step (resolved to full field objects, in order)
  const stepFields = step.fieldIds
    .map((fid) => allFields.find((f) => f.id === fid))
    .filter((f): f is FormField => f !== undefined);

  // Fields not assigned to any step globally (available to be added here)
  const unassignedFields = allFields.filter(
    (f) => !assignedFieldIds.has(f.id)
  );

  function addField(fieldId: string) {
    onUpdate({ ...step, fieldIds: [...step.fieldIds, fieldId] });
  }

  function removeField(fieldId: string) {
    onUpdate({
      ...step,
      fieldIds: step.fieldIds.filter((id) => id !== fieldId),
    });
  }

  const isFirst = index === 0;
  const isLast = index === totalSteps - 1;

  return (
    <div className="bg-surface-raised border border-border rounded-lg overflow-hidden">
      {/* ── Card header ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        {/* Drag handle (visual only — reordering uses buttons) */}
        <span
          className="text-text-muted flex-shrink-0 cursor-default"
          aria-hidden="true"
        >
          <GripVertical size={16} />
        </span>

        {/* Step number badge */}
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand-500/10 text-brand-400 text-[11px] font-bold flex items-center justify-center tabular-nums select-none">
          {index + 1}
        </span>

        {/* Editable title */}
        <input
          type="text"
          value={step.title}
          onChange={(e) => onUpdate({ ...step, title: e.target.value })}
          aria-label={`Título da etapa ${index + 1}`}
          placeholder="Título da etapa"
          className={cn(
            "flex-1 min-w-0 bg-transparent text-sm font-medium text-text-primary",
            "placeholder:text-text-muted",
            "focus:outline-none focus:ring-0",
            "border-b border-transparent focus:border-border-strong",
            "transition-colors duration-150 py-0.5"
          )}
        />

        {/* Field count pill */}
        <span className="flex-shrink-0 px-2 py-0.5 rounded-full bg-surface-overlay text-text-secondary text-[11px] font-medium tabular-nums">
          {step.fieldIds.length} {step.fieldIds.length === 1 ? "campo" : "campos"}
        </span>

        {/* Reorder controls */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <IconButton
            onClick={onMoveUp}
            aria-label={`Mover etapa ${index + 1} para cima`}
            disabled={isFirst}
          >
            <ChevronUp size={15} aria-hidden="true" />
          </IconButton>
          <IconButton
            onClick={onMoveDown}
            aria-label={`Mover etapa ${index + 1} para baixo`}
            disabled={isLast}
          >
            <ChevronDown size={15} aria-hidden="true" />
          </IconButton>
        </div>

        {/* Expand / collapse */}
        <IconButton
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Recolher etapa" : "Expandir etapa"}
        >
          {expanded ? (
            <ChevronUp size={15} aria-hidden="true" />
          ) : (
            <ChevronDown size={15} aria-hidden="true" />
          )}
        </IconButton>

        {/* Delete step */}
        <IconButton
          onClick={onDelete}
          aria-label={`Excluir etapa ${index + 1}`}
          danger
        >
          <Trash2 size={15} aria-hidden="true" />
        </IconButton>
      </div>

      {/* ── Expanded body ──────────────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-4">
          {/* Description textarea */}
          <div>
            <label
              htmlFor={`step-desc-${step.id}`}
              className="block text-[12px] font-medium text-text-secondary mb-1.5"
            >
              Descrição <span className="text-text-muted font-normal">(opcional)</span>
            </label>
            <textarea
              id={`step-desc-${step.id}`}
              value={step.description ?? ""}
              onChange={(e) =>
                onUpdate({
                  ...step,
                  description: e.target.value || undefined,
                })
              }
              placeholder="Instruções ou contexto exibidos ao usuário nesta etapa"
              rows={2}
              className={cn(
                "w-full bg-surface-sunken border border-border-strong rounded-lg",
                "px-3 py-2 text-base md:text-sm text-text-primary placeholder:text-text-muted",
                "resize-none transition-colors duration-150",
                "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              )}
            />
          </div>

          {/* Fields in this step */}
          <div>
            <p className="text-[12px] font-medium text-text-secondary mb-2">
              Campos nesta etapa
            </p>
            {stepFields.length === 0 ? (
              <p className="text-[12px] text-text-muted italic py-1">
                Nenhum campo atribuído. Adicione campos abaixo.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {stepFields.map((field) => (
                  <span
                    key={field.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-brand-500/10 text-brand-400"
                  >
                    {field.label}
                    <button
                      type="button"
                      onClick={() => removeField(field.id)}
                      aria-label={`Remover campo ${field.label} desta etapa`}
                      className={cn(
                        "flex items-center justify-center w-4 h-4 rounded-full",
                        "text-brand-400/70 hover:text-brand-300 hover:bg-brand-500/20",
                        "transition-colors duration-100",
                        "focus:outline-none focus:ring-1 focus:ring-brand-500"
                      )}
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Available (unassigned) fields */}
          {unassignedFields.length > 0 && (
            <div>
              <p className="text-[12px] font-medium text-text-secondary mb-2">
                Campos disponíveis
              </p>
              <div className="flex flex-wrap gap-1.5">
                {unassignedFields.map((field) => (
                  <button
                    key={field.id}
                    type="button"
                    onClick={() => addField(field.id)}
                    aria-label={`Adicionar campo ${field.label} a esta etapa`}
                    className={cn(
                      "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium",
                      "bg-surface-sunken text-text-secondary border border-border",
                      "hover:border-brand-500 hover:text-brand-400 hover:bg-brand-500/5",
                      "transition-colors duration-150",
                      "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 focus:ring-offset-surface-raised"
                    )}
                  >
                    <Plus size={10} aria-hidden="true" />
                    {field.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function StepManager({ steps, onChange, fields }: StepManagerProps) {
  const isEnabled = steps !== undefined;

  // Set of ALL field IDs that are assigned to at least one step
  const assignedFieldIds = new Set<string>(
    (steps ?? []).flatMap((s) => s.fieldIds)
  );

  // Fields not assigned to any step (only meaningful when steps exist)
  const unassignedFields = fields.filter((f) => !assignedFieldIds.has(f.id));
  const hasUnassigned = isEnabled && unassignedFields.length > 0;
  const showWarning = isEnabled && (steps?.length ?? 0) >= 2 && hasUnassigned;

  // ── Toggle multi-step on/off ─────────────────────────────────────────────

  function handleToggle() {
    if (isEnabled) {
      // Disabling: revert to single-page (undefined)
      onChange(undefined);
    } else {
      // Enabling: create one step with all existing fields
      const firstStep: FormStep = {
        id: genStepId(),
        title: "Etapa 1",
        description: undefined,
        fieldIds: fields.map((f) => f.id),
      };
      onChange([firstStep]);
    }
  }

  // ── Step mutation helpers ────────────────────────────────────────────────

  function updateStep(index: number, updated: FormStep) {
    if (!steps) return;
    const next = [...steps];
    next[index] = updated;
    onChange(next);
  }

  function deleteStep(index: number) {
    if (!steps) return;
    // Removing a step: its fields become unassigned (no longer in any step)
    const next = steps.filter((_, i) => i !== index);
    onChange(next.length === 0 ? [] : next);
  }

  function addStep() {
    if (!steps) return;
    const newStep: FormStep = {
      id: genStepId(),
      title: `Etapa ${steps.length + 1}`,
      description: undefined,
      fieldIds: [],
    };
    onChange([...steps, newStep]);
  }

  function moveStep(index: number, direction: "up" | "down") {
    if (!steps) return;
    const next = [...steps];
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= next.length) return;
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    onChange(next);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Enable toggle row */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-surface-raised border border-border rounded-lg">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-text-primary">
            Formulário multi-etapas
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            Divida o formulário em etapas para melhorar a experiência do usuário
          </p>
        </div>
        <ToggleSwitch
          checked={isEnabled}
          onToggle={handleToggle}
          label="Ativar formulário multi-etapas"
        />
      </div>

      {/* Step list (only rendered when enabled) */}
      {isEnabled && steps !== undefined && (
        <div className="space-y-3">
          {/* Unassigned fields warning */}
          {showWarning && (
            <div
              role="alert"
              className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-semantic-warning/10 border border-semantic-warning/30"
            >
              <AlertTriangle
                size={15}
                className="text-semantic-warning flex-shrink-0 mt-0.5"
                aria-hidden="true"
              />
              <p className="text-[12px] text-semantic-warning leading-relaxed">
                <span className="font-semibold">
                  {unassignedFields.length}{" "}
                  {unassignedFields.length === 1
                    ? "campo não atribuído"
                    : "campos não atribuídos"}
                </span>
                {" — "}
                Campos sem etapa não serão exibidos no formulário. Atribua-os a
                uma etapa abaixo.
              </p>
            </div>
          )}

          {/* Step cards */}
          {steps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-text-muted">
                Nenhuma etapa criada ainda.
              </p>
              <p className="text-[12px] text-text-muted mt-1">
                Clique em "Adicionar etapa" para começar.
              </p>
            </div>
          ) : (
            <div className="space-y-2" role="list" aria-label="Etapas do formulário">
              {steps.map((step, index) => (
                <div key={step.id} role="listitem">
                  <StepCard
                    step={step}
                    index={index}
                    totalSteps={steps.length}
                    allFields={fields}
                    assignedFieldIds={assignedFieldIds}
                    onUpdate={(updated) => updateStep(index, updated)}
                    onDelete={() => deleteStep(index)}
                    onMoveUp={() => moveStep(index, "up")}
                    onMoveDown={() => moveStep(index, "down")}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Add step button */}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addStep}
            className="w-full"
            aria-label="Adicionar nova etapa ao formulário"
          >
            <Plus size={15} aria-hidden="true" />
            Adicionar etapa
          </Button>
        </div>
      )}
    </div>
  );
}
