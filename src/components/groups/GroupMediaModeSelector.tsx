import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
  /** Selo "recomendado" ao lado do rótulo. */
  recommended?: boolean;
}

/**
 * Seletor segmentado de uma linha (Imagens / Áudios / …) da política de mídia.
 *
 * Radios nativos escondidos por baixo: setas do teclado, leitor de tela e
 * `fieldset disabled` funcionam sem reimplementar nada. No mobile cada opção
 * vira uma faixa inteira (44px) e empilha; do `sm` em diante vira pílula.
 */
export function GroupMediaModeSelector<T extends string>({
  name,
  legend,
  value,
  options,
  disabled = false,
  onChange,
}: {
  /** `name` do grupo de radios — tem de ser único na tela. */
  name: string;
  legend: string;
  value: T;
  options: SegmentOption<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium text-text-primary">{legend}</legend>
      <div
        className={cn(
          "flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-1 sm:flex-row",
          disabled && "opacity-50"
        )}
      >
        {options.map((option) => {
          const checked = value === option.id;
          return (
            <label
              key={option.id}
              className={cn(
                "relative flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-center text-sm transition-colors sm:min-h-9 sm:text-xs",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500",
                checked
                  ? "bg-brand-500/15 font-medium text-brand-400 ring-1 ring-inset ring-brand-500"
                  : "text-text-secondary hover:bg-surface-raised hover:text-text-primary",
                disabled && "cursor-not-allowed"
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={checked}
                onChange={() => onChange(option.id)}
                className="sr-only"
              />
              <span>{option.label}</span>
              {option.recommended && (
                <span className="rounded-full bg-brand-500/15 px-1.5 py-px text-[10px] font-medium text-brand-400">
                  recomendado
                </span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
