import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export interface SettingsNavGroup {
  id: string;
  label: string;
  panels: ReadonlyArray<SettingsNavItem>;
}

export interface SettingsNavViewProps {
  groups: ReadonlyArray<SettingsNavGroup>;
  /** Painel aberto (`aria-current`); `null` na lista do celular. */
  active: string | null;
  onSelect: (id: string) => void;
  /** `list`: lista de ajustes do celular (descrição + chevron). `sidebar`: coluna do desktop. */
  variant?: "list" | "sidebar";
}

/** Navegação de dois níveis (grupos -> painéis). Apresentacional: o estado é a URL. */
export function SettingsNavView({ groups, active, onSelect, variant = "sidebar" }: SettingsNavViewProps) {
  const isList = variant === "list";
  return (
    <nav aria-label="Seções de configurações" className="space-y-5">
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
          <h2
            id={`settings-group-${group.id}`}
            className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-text-muted"
          >
            {group.label}
          </h2>
          <ul
            className={cn(
              isList ? "overflow-hidden rounded-card border border-border-subtle bg-surface-raised divide-y divide-border-subtle" : "space-y-0.5"
            )}
          >
            {group.panels.map((panel) => {
              const Icon = panel.icon;
              const isActive = panel.id === active;
              return (
                <li key={panel.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(panel.id)}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex w-full min-h-11 items-center gap-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                      isList ? "px-4 py-3 hover:bg-surface-overlay" : "rounded-field px-3 py-2 text-sm",
                      isActive
                        ? "bg-brand-600/15 text-text-primary font-medium"
                        : "text-text-secondary hover:bg-surface-overlay hover:text-text-primary"
                    )}
                  >
                    <Icon size={isList ? 20 : 18} aria-hidden="true" className="shrink-0 text-text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate", isList && "text-sm font-medium text-text-primary")}>{panel.label}</span>
                      {isList && <span className="block truncate text-xs text-text-muted">{panel.description}</span>}
                    </span>
                    {isList && <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-text-muted" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
