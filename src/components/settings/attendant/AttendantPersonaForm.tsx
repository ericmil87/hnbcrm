import { Textarea } from "@/components/ui/Textarea";
import type { ConfigFormProps, PersonaTextForm } from "@/lib/attendantConfig";

export interface AttendantPersonaFormProps extends ConfigFormProps<PersonaTextForm> {
  /** Texto exibido enquanto os textos não carregaram (ex.: "Carregando…" ou aviso de permissão). */
  lockedPlaceholder?: string;
}

/** Jeito de atender: como a IA se apresenta e conversa. Campo controlado, sem dados. */
export function AttendantPersonaForm({
  value,
  onChange,
  disabled,
  errors,
  variant = "panel",
  lockedPlaceholder,
}: AttendantPersonaFormProps) {
  const locked = !value.loaded;
  return (
    <Textarea
      label="Como a IA deve se apresentar e conversar"
      hint={variant === "panel" ? "Quem é o atendente, o tom de voz e o que ele pode afirmar ao cliente." : undefined}
      rows={variant === "wizard" ? 4 : 6}
      value={value.systemPrompt}
      disabled={disabled || locked}
      placeholder={locked ? lockedPlaceholder : undefined}
      error={errors?.systemPrompt}
      onChange={(e) => onChange({ ...value, systemPrompt: e.target.value })}
    />
  );
}
