import { useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import {
  Plus,
  Trash2,
  Type,
  Mail,
  Phone,
  Hash,
  ChevronDown,
  AlignLeft,
  CheckSquare,
  Calendar,
} from "lucide-react";
import { CrmMappingSelect } from "./CrmMappingSelect";
import type { FormField } from "./types";

interface FieldConfigPanelProps {
  field: FormField;
  onChange: (updated: FormField) => void;
  organizationId: string;
}

const FIELD_ICONS: Record<FormField["type"], React.ElementType> = {
  text: Type,
  email: Mail,
  phone: Phone,
  number: Hash,
  select: ChevronDown,
  textarea: AlignLeft,
  checkbox: CheckSquare,
  date: Calendar,
};

const FIELD_LABELS: Record<FormField["type"], string> = {
  text: "Texto",
  email: "E-mail",
  phone: "Telefone",
  number: "Numero",
  select: "Selecao",
  textarea: "Area de Texto",
  checkbox: "Caixa de Selecao",
  date: "Data",
};

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-3 pb-2 border-b border-border-subtle">
      {children}
    </h3>
  );
}

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
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "relative flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-200",
        "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay",
        checked ? "bg-brand-600" : "bg-surface-overlay border border-border-strong"
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

function ToggleRow({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {description && (
          <p className="text-[12px] text-text-muted mt-0.5">{description}</p>
        )}
      </div>
      <ToggleSwitch checked={checked} onToggle={onToggle} label={label} />
    </div>
  );
}

export function FieldConfigPanel({
  field,
  onChange,
  organizationId,
}: FieldConfigPanelProps) {
  const [newOption, setNewOption] = useState("");

  const Icon = FIELD_ICONS[field.type];

  function update(patch: Partial<FormField>) {
    onChange({ ...field, ...patch });
  }

  function updateValidation(
    patch: Partial<NonNullable<FormField["validation"]>>
  ) {
    onChange({ ...field, validation: { ...field.validation, ...patch } });
  }

  function addOption() {
    const trimmed = newOption.trim();
    if (!trimmed) return;
    update({ options: [...(field.options ?? []), trimmed] });
    setNewOption("");
  }

  function removeOption(index: number) {
    const opts = [...(field.options ?? [])];
    opts.splice(index, 1);
    update({ options: opts });
  }

  const showTextValidation =
    field.type === "text" ||
    field.type === "textarea" ||
    field.type === "email" ||
    field.type === "phone";
  const showNumberValidation = field.type === "number";
  const showPatternInput = field.type === "text" || field.type === "textarea";
  const showSelectOptions = field.type === "select";
  const hasValidationSection =
    showTextValidation || showNumberValidation || showPatternInput;

  const currentWidth = field.width ?? "full";

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center flex-shrink-0">
          <Icon size={16} className="text-brand-500" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-text-primary">
            Configurar Campo
          </p>
          <p className="text-[12px] text-text-muted">
            {FIELD_LABELS[field.type]}
          </p>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* ── Propriedades ──────────────────────────────────────── */}
        <section aria-label="Propriedades">
          <SectionHeader>Propriedades</SectionHeader>
          <div className="space-y-3">
            <Input
              label="Rotulo *"
              value={field.label}
              onChange={(e) => update({ label: e.target.value })}
              placeholder="Ex: Nome completo"
            />

            {field.type !== "checkbox" && (
              <Input
                label="Placeholder"
                value={field.placeholder ?? ""}
                onChange={(e) =>
                  update({ placeholder: e.target.value || undefined })
                }
                placeholder="Ex: Digite seu nome"
              />
            )}

            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Texto de ajuda
              </label>
              <input
                type="text"
                value={field.helpText ?? ""}
                onChange={(e) =>
                  update({ helpText: e.target.value || undefined })
                }
                placeholder="Instrucoes adicionais para o usuario"
                className={cn(
                  "w-full bg-surface-raised border border-border-strong rounded-field",
                  "px-3.5 py-2.5 text-base md:text-sm text-text-primary placeholder:text-text-muted",
                  "transition-colors duration-150",
                  "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                )}
              />
            </div>

            <ToggleRow
              label="Obrigatorio"
              description="O usuario deve preencher este campo"
              checked={field.isRequired}
              onToggle={() => update({ isRequired: !field.isRequired })}
            />

            {/* Width selector */}
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Largura
              </label>
              <div className="flex gap-2">
                {(["full", "half"] as const).map((w) => (
                  <button
                    key={w}
                    onClick={() => update({ width: w })}
                    className={cn(
                      "flex-1 py-2 text-sm rounded-lg border transition-all duration-150",
                      "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay",
                      currentWidth === w
                        ? "border-brand-500 bg-brand-500/10 text-brand-500 font-medium"
                        : "border-border-strong bg-surface-raised text-text-secondary hover:border-border"
                    )}
                    aria-pressed={currentWidth === w}
                  >
                    {w === "full" ? "Largura total" : "Meia largura"}
                  </button>
                ))}
              </div>
            </div>

            <Input
              label="Valor padrao"
              value={field.defaultValue ?? ""}
              onChange={(e) =>
                update({ defaultValue: e.target.value || undefined })
              }
              placeholder="Valor pre-preenchido"
            />

            {/* Select options editor */}
            {showSelectOptions && (
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Opcoes de selecao
                </label>
                <div className="space-y-2">
                  {(field.options ?? []).map((opt, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <span className="flex-1 px-3 py-2 text-sm bg-surface-sunken border border-border rounded-lg text-text-primary truncate">
                        {opt}
                      </span>
                      <button
                        aria-label={`Remover opcao ${opt}`}
                        onClick={() => removeOption(index)}
                        className={cn(
                          "p-2 rounded-lg text-text-muted",
                          "hover:text-semantic-error hover:bg-semantic-error/10",
                          "transition-colors",
                          "focus:outline-none focus:ring-2 focus:ring-semantic-error"
                        )}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}

                  <div className="flex gap-2 mt-2">
                    <input
                      type="text"
                      value={newOption}
                      onChange={(e) => setNewOption(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addOption();
                        }
                      }}
                      placeholder="Nova opcao..."
                      className={cn(
                        "flex-1 bg-surface-raised border border-border-strong rounded-field",
                        "px-3.5 py-2.5 text-base md:text-sm text-text-primary placeholder:text-text-muted",
                        "transition-colors duration-150",
                        "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
                      )}
                    />
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={addOption}
                      aria-label="Adicionar opcao"
                    >
                      <Plus size={16} aria-hidden="true" />
                      <span className="hidden sm:inline">Adicionar</span>
                    </Button>
                  </div>

                  {(!field.options || field.options.length === 0) && (
                    <p className="text-[12px] text-text-muted text-center py-1">
                      Nenhuma opcao adicionada ainda
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── Validacao ─────────────────────────────────────────── */}
        {hasValidationSection && (
          <section aria-label="Validacao">
            <SectionHeader>Validacao</SectionHeader>
            <div className="space-y-3">
              {showTextValidation && (
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Min. caracteres"
                    type="number"
                    min={0}
                    value={field.validation?.minLength ?? ""}
                    onChange={(e) =>
                      updateValidation({
                        minLength: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="0"
                  />
                  <Input
                    label="Max. caracteres"
                    type="number"
                    min={0}
                    value={field.validation?.maxLength ?? ""}
                    onChange={(e) =>
                      updateValidation({
                        maxLength: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="255"
                  />
                </div>
              )}

              {showNumberValidation && (
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Minimo"
                    type="number"
                    value={field.validation?.min ?? ""}
                    onChange={(e) =>
                      updateValidation({
                        min: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="0"
                  />
                  <Input
                    label="Maximo"
                    type="number"
                    value={field.validation?.max ?? ""}
                    onChange={(e) =>
                      updateValidation({
                        max: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder="9999"
                  />
                </div>
              )}

              {showPatternInput && (
                <Input
                  label="Padrao (Regex)"
                  value={field.validation?.pattern ?? ""}
                  onChange={(e) =>
                    updateValidation({
                      pattern: e.target.value || undefined,
                    })
                  }
                  placeholder="Ex: ^[A-Z].*"
                />
              )}
            </div>
          </section>
        )}

        {/* ── Mapeamento CRM ────────────────────────────────────── */}
        <section aria-label="Mapeamento CRM">
          <SectionHeader>Mapeamento CRM</SectionHeader>
          <CrmMappingSelect
            value={field.crmMapping}
            onChange={(mapping) => update({ crmMapping: mapping })}
            organizationId={organizationId}
          />
        </section>
      </div>
    </div>
  );
}
