import { cn } from "@/lib/utils";

const REMINDER_OPTIONS = [
  { value: "", label: "Nenhum" },
  { value: "10", label: "10 minutos antes" },
  { value: "30", label: "30 minutos antes" },
  { value: "60", label: "1 hora antes" },
  { value: "180", label: "3 horas antes" },
  { value: "1440", label: "1 dia antes" },
  { value: "2880", label: "2 dias antes" },
] as const;

interface ReminderSelectProps {
  /** Antecedência em minutos, ou undefined para "sem lembrete". */
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  /** Desabilita o controle (ex.: quando não há data de vencimento). */
  disabled?: boolean;
  className?: string;
}

/** Select de "Lembrete antecipado". Não renderiza label próprio — o
 * consumidor decide o layout (bloco vs. linha inline). */
export function ReminderSelect({ value, onChange, disabled, className }: ReminderSelectProps) {
  return (
    <div className={className}>
      <select
        value={value ? String(value) : ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
        disabled={disabled}
        className={cn(
          "w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500",
          "disabled:opacity-50 disabled:cursor-not-allowed"
        )}
        style={{ fontSize: "16px" }}
        aria-label="Lembrete antecipado"
      >
        {REMINDER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {disabled && (
        <p className="mt-1 text-xs text-text-muted">
          Defina uma data de vencimento para habilitar o lembrete antecipado.
        </p>
      )}
    </div>
  );
}
