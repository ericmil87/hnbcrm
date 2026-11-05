import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { cn } from "@/lib/utils";

export interface SearchInputProps {
  /** Valor externo (controlado). Mudanças externas sobrescrevem o texto digitado. */
  value: string;
  /** Chamado após `debounceMs` sem digitação. */
  onValueChange: (value: string) => void;
  placeholder?: string;
  onClear?: () => void;
  debounceMs?: number;
  ariaLabel?: string;
  className?: string;
}

/** Campo de busca com debounce, ícone e botão de limpar. */
export function SearchInput({
  value,
  onValueChange,
  placeholder = "Buscar",
  onClear,
  debounceMs = 300,
  ariaLabel,
  className,
}: SearchInputProps) {
  const [text, setText] = useState(value);
  const debounced = useDebouncedValue(text, debounceMs);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastEmitted = useRef(value);
  const onChange = useRef(onValueChange);
  onChange.current = onValueChange;

  // Valor externo mudou (ex.: limpar filtros): sincroniza o texto.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    if (debounced !== lastEmitted.current) {
      lastEmitted.current = debounced;
      onChange.current(debounced);
    }
  }, [debounced]);

  const clear = () => {
    setText("");
    lastEmitted.current = "";
    onValueChange("");
    onClear?.();
    inputRef.current?.focus();
  };

  return (
    <div className={cn("relative", className)}>
      <Search
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
      />
      <input
        ref={inputRef}
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className="h-10 coarse:min-h-11 w-full rounded-field border border-border bg-surface-raised pl-9 pr-10 text-base md:text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base [&::-webkit-search-cancel-button]:appearance-none"
      />
      {text && (
        <button
          type="button"
          aria-label="Limpar busca"
          onClick={clear}
          className="absolute right-1 top-1/2 -translate-y-1/2 flex h-8 w-8 coarse:h-11 coarse:w-11 items-center justify-center rounded-full text-text-muted hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
