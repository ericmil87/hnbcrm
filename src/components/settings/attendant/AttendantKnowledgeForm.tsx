import { Textarea } from "@/components/ui/Textarea";
import type { ConfigFormProps, KnowledgeForm } from "@/lib/attendantConfig";

export interface AttendantKnowledgeFormProps extends ConfigFormProps<KnowledgeForm> {
  lockedPlaceholder?: string;
}

/** O que a IA sabe do seu negócio. Campo controlado, sem dados. */
export function AttendantKnowledgeForm({
  value,
  onChange,
  disabled,
  errors,
  variant = "panel",
  lockedPlaceholder,
}: AttendantKnowledgeFormProps) {
  const locked = !value.loaded;
  return (
    <Textarea
      label="O que a IA sabe do seu negócio"
      hint={variant === "panel" ? "Ela só afirma o que estiver aqui: preços, serviços, horários, políticas, diferenciais." : undefined}
      rows={variant === "wizard" ? 5 : 8}
      value={value.knowledge}
      disabled={disabled || locked}
      placeholder={locked ? lockedPlaceholder : "Preços, serviços, horários, políticas, diferenciais..."}
      error={errors?.knowledge}
      onChange={(e) => onChange({ ...value, knowledge: e.target.value })}
    />
  );
}
