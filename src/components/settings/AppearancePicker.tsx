import { useRef } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { THEME_OPTIONS, type ThemePreview, type UiTheme } from "@/lib/theme";

interface AppearancePickerProps {
  value: UiTheme;
  onValueChange: (theme: UiTheme) => void;
  disabled?: boolean;
}

/** Static thumbnail: fixed colors from data (style), so it never follows the active theme. */
function ThemeThumbnail({ preview }: { preview: ThemePreview }) {
  return (
    <div
      aria-hidden="true"
      className="flex h-16 w-full overflow-hidden rounded-md border border-border"
      style={{ background: preview.background }}
    >
      <div className="w-4 shrink-0" style={{ background: preview.sidebar }} />
      <div className="flex flex-1 gap-1 p-1.5">
        <div className="flex w-1/3 flex-col gap-1">
          <div className="h-2 rounded-sm" style={{ background: preview.row }} />
          <div className="h-2 rounded-sm" style={{ background: preview.row }} />
        </div>
        <div className="flex flex-1 flex-col justify-center gap-1">
          <div className="h-2.5 w-2/3 self-start rounded-md" style={{ background: preview.bubbleIn }} />
          <div className="h-2.5 w-2/3 self-end rounded-md" style={{ background: preview.bubbleOut }} />
        </div>
      </div>
    </div>
  );
}

export function AppearancePicker({ value, onValueChange, disabled }: AppearancePickerProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, delta: number | "start" | "end") => {
    const last = THEME_OPTIONS.length - 1;
    const next =
      delta === "start" ? 0 : delta === "end" ? last : (from + delta + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    onValueChange(THEME_OPTIONS[next].id);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (disabled) return;
    const map: Record<string, number | "start" | "end"> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
      Home: "start",
      End: "end",
    };
    if (e.key in map) {
      e.preventDefault();
      move(index, map[e.key]);
    }
  };

  return (
    <div role="radiogroup" aria-label="Aparência" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {THEME_OPTIONS.map((option, index) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onValueChange(option.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              "relative flex min-h-[44px] flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3 text-left transition-colors",
              "hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50",
              selected && "ring-2 ring-brand-500",
            )}
          >
            <ThemeThumbnail preview={option.preview} />
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">{option.label}</span>
              {selected && <Check size={16} className="ml-auto shrink-0 text-brand-500" aria-hidden="true" />}
            </span>
            <span className="text-caption text-text-secondary">{option.description}</span>
          </button>
        );
      })}
    </div>
  );
}
