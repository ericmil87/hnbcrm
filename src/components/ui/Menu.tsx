import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { Check } from "lucide-react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import { Popover } from "./Popover";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Linha separadora antes do item. */
  separatorBefore?: boolean;
  /** Chave estável (padrão: rótulo + posição). */
  id?: string;
  /** Item de escolha única: vira `menuitemradio` com `aria-checked` e mostra o check quando marcado. */
  checked?: boolean;
}

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
}

export interface MenuProps {
  /** Renderiza o gatilho; espalhe as props recebidas no botão. */
  trigger: (props: MenuTriggerProps, state: { open: boolean }) => ReactNode;
  items: MenuItem[];
  ariaLabel: string;
  align?: "start" | "center" | "end";
  className?: string;
}

/** Menu de ações: popover ancorado no desktop, folha inferior no mobile. */
export function Menu({ trigger, items, ariaLabel, align = "end", className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const menuId = useId();

  const buttons = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)') ?? []);

  useEffect(() => {
    if (open) buttons()[0]?.focus();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") {
      anchorRef.current?.focus();
      setOpen(false);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    list[next].focus();
  };

  const select = (item: MenuItem) => {
    setOpen(false);
    anchorRef.current?.focus();
    item.onSelect();
  };

  return (
    <>
      {trigger(
        {
          ref: anchorRef,
          onClick: () => setOpen((v) => !v),
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-controls": open ? menuId : undefined,
        },
        { open }
      )}
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchor={anchorRef}
        align={align}
        sheet={isMobile}
        className={cn(!isMobile && "min-w-56 max-w-xs", className)}
      >
        <div ref={listRef} id={menuId} role="menu" aria-label={ariaLabel} onKeyDown={onKeyDown} className="py-1">
          {items.map((item, index) => (
            <button
              key={item.id ?? `${item.label}-${index}`}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => select(item)}
              className={cn(
                "flex w-full min-h-11 items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors",
                "hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
                "disabled:cursor-not-allowed disabled:opacity-50",
                item.separatorBefore && index > 0 && "border-t border-border mt-1",
                item.danger ? "text-semantic-error" : "text-text-primary"
              )}
            >
              {item.icon}
              {item.label}
              {item.checked && <Check size={16} aria-hidden="true" className="ml-auto shrink-0 text-brand-500 light-theme:text-brand-600" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
