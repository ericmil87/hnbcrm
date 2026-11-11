import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

interface TabsProps {
  value: string;
  onValueChange: (id: string) => void;
  items: TabItem[];
  ariaLabel: string;
  variant?: "underline" | "pills";
  /** Prefixo dos ids; use o mesmo em `TabPanel`. Torne único se houver várias `Tabs` na página. */
  idPrefix?: string;
  className?: string;
}

export function tabDomId(idPrefix: string, id: string) {
  return `${idPrefix}-tab-${id}`;
}
export function tabPanelDomId(idPrefix: string, id: string) {
  return `${idPrefix}-panel-${id}`;
}

/** Abas com navegação por teclado (setas, Home, End) e rolagem horizontal no mobile. */
export function Tabs({
  value,
  onValueChange,
  items,
  ariaLabel,
  variant = "underline",
  idPrefix = "tabs",
  className,
}: TabsProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const enabled = items.filter((i) => !i.disabled);
  // Se o valor atual não é focável, a primeira aba habilitada recebe o tabindex 0.
  const focusableId = enabled.some((i) => i.id === value) ? value : enabled[0]?.id;

  const move = (id: string | undefined) => {
    if (!id) return;
    refs.current.get(id)?.focus();
    onValueChange(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const found = enabled.findIndex((i) => i.id === value);
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        move(enabled[(found + 1) % enabled.length].id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        move(enabled[(found < 0 ? enabled.length - 1 : found - 1 + enabled.length) % enabled.length].id);
        break;
      case "Home":
        e.preventDefault();
        move(enabled[0].id);
        break;
      case "End":
        e.preventDefault();
        move(enabled[enabled.length - 1].id);
        break;
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn(
        "flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        variant === "underline" ? "gap-1 border-b border-border-subtle" : "gap-2",
        className
      )}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) refs.current.set(item.id, node);
              else refs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={tabDomId(idPrefix, item.id)}
            aria-selected={selected}
            // Só a aba selecionada tem painel no DOM.
            aria-controls={selected ? tabPanelDomId(idPrefix, item.id) : undefined}
            tabIndex={item.id === focusableId ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.id)}
            className={cn(
              "inline-flex min-h-11 shrink-0 snap-start items-center gap-2 whitespace-nowrap text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
              "disabled:cursor-not-allowed disabled:opacity-50",
              variant === "underline"
                ? cn(
                    "-mb-px border-b-2 px-3",
                    selected
                      ? "border-brand-500 text-text-primary"
                      : "border-transparent text-text-muted hover:text-text-secondary"
                  )
                : cn(
                    "rounded-full px-4",
                    selected
                      ? "bg-brand-700 text-white"
                      : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
                  )
            )}
          >
            {item.icon}
            {item.label}
            {item.badge !== undefined && item.badge !== null && (
              <span className="rounded-full bg-surface-overlay px-1.5 text-xs tabular-nums text-text-secondary">
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface TabPanelProps {
  /** Id da aba a que o painel pertence. */
  id: string;
  idPrefix?: string;
  className?: string;
  children: ReactNode;
}

export function TabPanel({ id, idPrefix = "tabs", className, children }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={tabPanelDomId(idPrefix, id)}
      aria-labelledby={tabDomId(idPrefix, id)}
      tabIndex={0}
      className={cn("focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500", className)}
    >
      {children}
    </div>
  );
}
