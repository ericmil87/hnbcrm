import { forwardRef } from "react";
import { cn } from "@/lib/utils";

const variants = {
  primary: "bg-brand-600 text-white font-semibold hover:bg-brand-700 active:bg-brand-800 focus-visible:ring-brand-500",
  secondary: "bg-surface-overlay text-text-primary font-medium hover:bg-surface-raised active:bg-surface-sunken border border-border focus-visible:ring-brand-500",
  ghost: "bg-transparent text-brand-500 font-medium hover:bg-brand-500/10 active:bg-brand-500/20 focus-visible:ring-brand-500",
  dark: "bg-surface-raised text-brand-400 font-medium hover:bg-surface-overlay active:bg-surface-base border border-border focus-visible:ring-brand-500",
  danger: "bg-semantic-error text-white font-semibold hover:bg-red-600 active:bg-red-700 focus-visible:ring-semantic-error",
} as const;

const sizes = {
  sm: "h-8 coarse:min-h-11 px-3 text-[13px] gap-1.5",
  md: "h-10 coarse:min-h-11 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-base gap-2",
} as const;

const iconOnlySizes = {
  sm: "h-8 w-8 coarse:min-h-11 coarse:min-w-11",
  md: "w-10 h-10 coarse:min-w-11 coarse:min-h-11",
  lg: "h-12 w-12",
} as const;

interface ButtonBaseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  /** Mostra um spinner, marca `aria-busy` e desabilita o botão. */
  loading?: boolean;
}

interface TextButtonProps extends ButtonBaseProps {
  iconOnly?: false;
}

/** Botão só com ícone: exige nome acessível. */
interface IconButtonProps extends ButtonBaseProps {
  iconOnly: true;
  "aria-label": string;
}

export type ButtonProps = TextButtonProps | IconButtonProps;

/** Classes de botão para elementos que não são `<button>` (ex.: `Link`). */
export function buttonClassName(
  variant: keyof typeof variants = "primary",
  size: keyof typeof sizes = "md",
  className?: string
) {
  return cn(
    "inline-flex items-center justify-center rounded-full transition-all duration-150",
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
    variants[variant],
    sizes[size],
    className
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", loading = false, iconOnly = false, className, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          "inline-flex items-center justify-center rounded-full transition-all duration-150",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
          "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none",
          variants[variant],
          iconOnly ? cn(iconOnlySizes[size], "p-0") : sizes[size],
          className
        )}
        {...props}
      >
        {loading && (
          <span
            aria-hidden="true"
            className="h-4 w-4 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin"
          />
        )}
        {loading && iconOnly ? null : children}
      </button>
    );
  }
);

Button.displayName = "Button";
