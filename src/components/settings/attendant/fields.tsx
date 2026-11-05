import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";

// Grupo de campos do editor do atendente: título + descrição curta, separado do
// grupo anterior por uma linha (o primeiro não precisa — o bloco já tem borda).
export function FieldGroup({
  title,
  description,
  divided = true,
  children,
}: {
  title: string;
  description?: string;
  divided?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("space-y-3", divided && "pt-4 border-t border-border")}>
      <div>
        <p className="text-sm font-medium text-text-primary">{title}</p>
        {description && <p className="text-xs text-text-muted mt-0.5">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function WarningNote({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="flex items-start gap-2 p-2.5 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10">
      <AlertTriangle size={14} className="shrink-0 text-semantic-warning mt-0.5" />
      <div className="space-y-0.5 min-w-0">
        {messages.map((m) => (
          <p key={m} className="text-xs text-text-secondary break-words">
            {m}
          </p>
        ))}
      </div>
    </div>
  );
}


/** Cartão de uma das 3 posições do interruptor de follow-up (molde de `ModeButton` do wizard de grupos). */
export function FollowUpModeCard({
  active,
  icon: Icon,
  title,
  subtitle,
  badge,
  onClick,
  disabled,
}: {
  active: boolean;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  badge?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-card border p-3 text-left transition-colors min-h-[44px] disabled:cursor-not-allowed disabled:opacity-60",
        active
          ? "border-brand-500 bg-brand-500/10"
          : "border-border bg-surface-raised hover:border-border-strong"
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
        <Icon size={15} className={active ? "text-brand-500" : "text-text-muted"} />
        {title}
        {badge && (
          <span className="ml-auto shrink-0 rounded-full bg-semantic-success/10 px-1.5 py-0.5 text-[10px] font-medium text-semantic-success">
            {badge}
          </span>
        )}
      </span>
      <span className="mt-1 block text-xs text-text-muted">{subtitle}</span>
    </button>
  );
}


/** Campo numérico/texto curto em string (vazio = padrão do servidor), com rótulo, dica e erro ligados por id. */
export function NumberField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  min,
  max,
  disabled,
  className,
  type = "number",
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  error?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
  type?: "number" | "text";
  maxLength?: number;
}) {
  return (
    <FormField label={label} hint={hint} error={error} className={className}>
      {(aria) => (
        <Input
          {...aria}
          type={type}
          inputMode={type === "number" ? "numeric" : undefined}
          min={min}
          max={max}
          maxLength={maxLength}
          step={type === "number" ? 1 : undefined}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          className={error ? "border-semantic-error" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </FormField>
  );
}

/** Linha com título, descrição opcional e Switch (rótulo só para leitores de tela). */
export function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        {description && <p className="text-xs text-text-muted mt-0.5">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={title} hideLabel disabled={disabled} />
    </div>
  );
}
