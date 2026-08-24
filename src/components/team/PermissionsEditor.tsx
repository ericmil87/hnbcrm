import { cn } from "@/lib/utils";
import {
  type Permissions,
  type PermissionCategory,
  type Role,
  CATEGORY_LABELS,
  LEVEL_LABELS,
  getLevelsForCategory,
  DEFAULT_PERMISSIONS,
} from "../../../convex/lib/permissions";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";

const CATEGORIES: PermissionCategory[] = [
  "leads",
  "contacts",
  "inbox",
  "tasks",
  "reports",
  "team",
  "settings",
  "auditLogs",
  "apiKeys",
];

interface PermissionsEditorProps {
  /** Current permission values */
  value: Permissions;
  /** Callback when any permission changes */
  onChange: (permissions: Permissions) => void;
  /** The role this permission set belongs to (for showing defaults) */
  role?: Role;
  /** Whether the editor is read-only */
  disabled?: boolean;
}

export function PermissionsEditor({
  value,
  onChange,
  role,
  disabled = false,
}: PermissionsEditorProps) {
  const handleChange = (category: PermissionCategory, level: string) => {
    onChange({ ...value, [category]: level });
  };

  const handleResetToDefaults = () => {
    if (role) {
      onChange({ ...DEFAULT_PERMISSIONS[role] });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-brand-500" />
          <span className="text-sm font-semibold text-text-primary">
            Permissoes
          </span>
        </div>
        {role && !disabled && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleResetToDefaults}
          >
            Restaurar padrão
          </Button>
        )}
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        {/* Header */}
        <div className="hidden md:grid md:grid-cols-[180px_1fr] bg-surface-sunken border-b border-border px-4 py-2.5">
          <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
            Categoria
          </span>
          <span className="text-xs font-medium text-text-muted uppercase tracking-wide">
            Nivel de Acesso
          </span>
        </div>

        {/* Rows */}
        {CATEGORIES.map((category, i) => {
          const levels = getLevelsForCategory(category);
          const currentLevel = value[category];

          return (
            <div
              key={category}
              className={cn(
                "grid grid-cols-1 md:grid-cols-[180px_1fr] gap-2 md:gap-4 px-4 py-3 items-center",
                i < CATEGORIES.length - 1 && "border-b border-border-subtle"
              )}
            >
              {/* Category label */}
              <span className="text-sm font-medium text-text-primary">
                {CATEGORY_LABELS[category]}
              </span>

              {/* Level selector */}
              <div className="flex flex-wrap gap-1.5">
                {levels.map((level) => {
                  const isActive = currentLevel === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      disabled={disabled}
                      onClick={() => handleChange(category, level)}
                      className={cn(
                        "px-2.5 py-1 rounded-full text-xs font-medium transition-colors min-h-[32px]",
                        isActive
                          ? "bg-brand-500 text-white"
                          : "bg-surface-raised text-text-secondary hover:bg-surface-overlay hover:text-text-primary border border-border-subtle",
                        disabled && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      {LEVEL_LABELS[level] || level}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
