import { Info } from "lucide-react";

/** Aviso de uma linha quando há mais de um atendente ativo: os painéis editam só um deles. */
export function MultiAttendantNotice({ count, name }: { count: number; name: string }) {
  if (count <= 1) return null;
  return (
    <p className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text-secondary">
      <Info size={14} className="shrink-0" aria-hidden="true" />
      Esta organização tem mais de um atendente; os painéis editam {name}.
    </p>
  );
}
