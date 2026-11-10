import { useSyncExternalStore } from "react";
import { Palette } from "lucide-react";
import { Menu } from "@/components/ui/Menu";
import { THEME_OPTIONS } from "@/lib/theme";
import { getAppliedTheme, setPublicTheme, subscribe } from "@/lib/themeDom";
import { cn } from "@/lib/utils";

interface PublicThemeButtonProps {
  className?: string;
}

/**
 * Theme choice for visitors on the public pages (icon button next to GitHub in the headers). Saved per
 * device in `hnbcrm:public-theme`, never on an account; under /app the account theme rules apply instead.
 */
export function PublicThemeButton({ className }: PublicThemeButtonProps) {
  const theme = useSyncExternalStore(subscribe, getAppliedTheme, getAppliedTheme);
  return (
    <Menu
      ariaLabel="Tema"
      items={THEME_OPTIONS.map((option) => ({
        id: option.id,
        label: option.label,
        checked: option.id === theme,
        onSelect: () => setPublicTheme(option.id),
      }))}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label="Escolher tema"
          className={cn(
            "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
            className
          )}
        >
          <Palette size={20} aria-hidden="true" />
        </button>
      )}
    />
  );
}
