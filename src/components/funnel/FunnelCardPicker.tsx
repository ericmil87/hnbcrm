import { useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Popover } from "@/components/ui/Popover";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Tooltip } from "@/components/ui/Tooltip";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  FUNNEL_CARD_FIELDS,
  FUNNEL_CARD_FIELD_LABELS,
  isFieldVisible,
  toggleFunnelCardField,
  type FunnelCardDensity,
  type FunnelCardPrefs,
} from "@/lib/funnelCardPrefs";

export interface FunnelCardPickerProps {
  prefs: FunnelCardPrefs;
  onChange: (next: FunnelCardPrefs) => void;
}

const DENSITY_OPTIONS = [
  { value: "compact", label: "Compacto" },
  { value: "comfortable", label: "Confortável" },
];

/** Botão "Exibição dos cards": densidade e campos visíveis; as mudanças valem na hora. */
export function FunnelCardPicker({ prefs, onChange }: FunnelCardPickerProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");

  return (
    <>
      <Tooltip content="Exibição dos cards">
        <Button
          ref={anchor}
          type="button"
          variant="secondary"
          iconOnly
          aria-label="Exibição dos cards"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
        </Button>
      </Tooltip>

      <Popover
        open={open}
        onOpenChange={setOpen}
        anchor={anchor}
        align="end"
        sheet={isMobile}
        role="dialog"
        aria-label="Exibição dos cards"
        className="w-72 p-4 pb-safe"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium text-text-primary">Densidade</p>
            <SegmentedControl
              ariaLabel="Densidade dos cards"
              value={prefs.density}
              onValueChange={(density) => onChange({ ...prefs, density: density as FunnelCardDensity })}
              options={DENSITY_OPTIONS}
            />
          </div>

          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm font-medium text-text-primary">Campos no card</legend>
            {FUNNEL_CARD_FIELDS.map((field) => (
              <Checkbox
                key={field}
                id={`funnel-card-field-${field}`}
                label={FUNNEL_CARD_FIELD_LABELS[field]}
                checked={isFieldVisible(prefs, field)}
                onChange={(e) => onChange(toggleFunnelCardField(prefs, field, e.target.checked))}
                containerClassName="flex w-full items-center py-2.5 coarse:min-h-11"
              />
            ))}
          </fieldset>
        </div>
      </Popover>
    </>
  );
}
