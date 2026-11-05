import type { ConfigFormProps, HandoffForm } from "@/lib/attendantConfig";
import { NumberField } from "./fields";

/** Palavras que fazem a IA parar e chamar a equipe. Campo controlado, sem dados. */
export function HandoffRulesForm({ value, onChange, disabled, errors, variant = "panel" }: ConfigFormProps<HandoffForm>) {
  return (
    <NumberField
      type="text"
      label="Palavras que chamam a equipe (separadas por vírgula)"
      hint={variant === "panel" ? "Quando o cliente escrever uma delas, a IA para na hora e chama alguém do time." : undefined}
      placeholder="humano, atendente"
      value={value.keywords}
      disabled={disabled}
      error={errors?.keywords}
      onChange={(keywords) => onChange({ ...value, keywords })}
    />
  );
}
