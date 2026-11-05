import { Link } from "react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button, buttonClassName } from "./Button";

interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  /** Quando presente, renderiza um `Link` em vez de um botão. */
  href?: string;
}

interface EmptyStateProps {
  icon: React.ElementType;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  size?: "sm" | "md";
  /** Nível do título (padrão `h3`). */
  headingLevel?: "h2" | "h3";
  /** Conteúdo extra abaixo da descrição, antes das ações. */
  children?: ReactNode;
  className?: string;
}

function ActionButton({ action, variant }: { action: EmptyStateAction; variant: "primary" | "secondary" }) {
  if (action.href) {
    return (
      <Link to={action.href} onClick={action.onClick} className={buttonClassName(variant, "md")}>
        {action.label}
      </Link>
    );
  }
  return (
    <Button variant={variant} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  size = "md",
  headingLevel = "h3",
  children,
  className,
}: EmptyStateProps) {
  const Heading = headingLevel;
  const small = size === "sm";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center px-4",
        small ? "py-6" : "py-12",
        className
      )}
    >
      <Icon size={small ? 32 : 48} className={cn("text-text-muted", small ? "mb-3" : "mb-4")} aria-hidden="true" />
      <Heading className={cn("font-medium text-text-primary mb-2", small ? "text-base" : "text-lg")}>{title}</Heading>
      {description && (
        <p className={cn("text-sm text-text-secondary max-w-md", small ? "mb-4" : "mb-6")}>{description}</p>
      )}
      {children && <div className={cn("w-full max-w-md", small ? "mb-4" : "mb-6")}>{children}</div>}
      {(action || secondaryAction) && (
        <div className="flex flex-col-reverse sm:flex-row items-center gap-2">
          {secondaryAction && <ActionButton action={secondaryAction} variant="secondary" />}
          {action && <ActionButton action={action} variant="primary" />}
        </div>
      )}
    </div>
  );
}
