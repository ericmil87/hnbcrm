import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/ui/BrandLogo";

export interface PhoneNotificationAction {
  label: string;
  /** Botão principal (cor da marca). */
  primary?: boolean;
  /** Com handler vira `<button>` de verdade (44 px); sem, é só desenho. */
  onClick?: () => void;
}

export interface PhoneNotificationProps {
  /** Nome do app na linha de cima. Padrão: "HNBCRM". */
  app?: string;
  /** Quando ("agora"). */
  time?: string;
  title: string;
  body?: string;
  /** Ícone do app. Padrão: o ícone da marca (`BrandLogo`). */
  icon?: ReactNode;
  actions?: readonly PhoneNotificationAction[];
  /** Entrada descendo do topo, como um aviso do celular. */
  enter?: boolean;
  className?: string;
}

/**
 * Aviso de celular ilustrativo (cena "Você": "Marina quer fechar. Assumir?").
 * Só apresentação; ações sem handler são desenho, não botões.
 */
export function PhoneNotification({
  app = "HNBCRM",
  time = "agora",
  title,
  body,
  icon,
  actions = [],
  enter = false,
  className,
}: PhoneNotificationProps) {
  return (
    <div
      className={cn(
        "w-full rounded-2xl border border-border-subtle bg-surface-overlay p-3 shadow-elevated",
        enter && "motion-safe:animate-notify-in",
        className
      )}
    >
      <div className="flex items-center gap-2 text-caption text-text-muted">
        {icon ?? <BrandLogo variant="icon" size="sm" decorative className="h-5" />}
        <span className="font-medium uppercase tracking-wide">{app}</span>
        <span aria-hidden="true">·</span>
        <span>{time}</span>
      </div>
      <p className="mt-1.5 text-sm font-semibold text-text-primary">{title}</p>
      {body && <p className="text-sm text-text-secondary">{body}</p>}
      {actions.length > 0 && (
        <div className="mt-2 flex gap-2">
          {actions.map((action) => {
            const look = cn(
              "inline-flex min-h-11 flex-1 items-center justify-center rounded-full px-3 text-sm font-semibold",
              action.primary ? "bg-brand-600 text-white" : "border border-border bg-surface-raised text-text-primary"
            );
            return action.onClick ? (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                className={cn(
                  look,
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
                )}
              >
                {action.label}
              </button>
            ) : (
              <span key={action.label} className={look}>
                {action.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
