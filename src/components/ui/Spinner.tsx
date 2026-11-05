import { cn } from "@/lib/utils";

const sizes = {
  sm: "h-4 w-4 border-[1.5px]",
  md: "h-6 w-6 border-2",
  lg: "h-8 w-8 border-2",
} as const;

interface SpinnerProps {
  size?: keyof typeof sizes;
  className?: string;
}

export function Spinner({ size = "md", className }: SpinnerProps) {
  return (
    <div
      className={cn(
        "animate-spin rounded-full border-brand-500 border-t-transparent",
        sizes[size],
        className
      )}
      role="status"
    >
      <span className="sr-only">Carregando…</span>
    </div>
  );
}
