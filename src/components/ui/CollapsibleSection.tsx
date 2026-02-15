import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  filledCount?: number;
  totalCount?: number;
  children: React.ReactNode;
}

export function CollapsibleSection({
  title,
  defaultOpen,
  filledCount,
  totalCount,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between w-full py-3 text-left group"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{title}</span>
          {filledCount !== undefined && totalCount !== undefined && totalCount > 0 && (
            <span className="text-[11px] font-medium text-text-muted bg-surface-overlay px-1.5 py-0.5 rounded-full">
              {filledCount}/{totalCount}
            </span>
          )}
        </div>
        <ChevronDown
          size={16}
          className={cn(
            "text-text-muted transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div className="pb-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
