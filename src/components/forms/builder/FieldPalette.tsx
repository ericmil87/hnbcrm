import { cn } from "@/lib/utils";
import {
  Type,
  Mail,
  Phone,
  Hash,
  ChevronDown,
  AlignLeft,
  CheckSquare,
  Calendar,
  CircleDot,
  Link,
  EyeOff,
  Star,
  Heading,
  Minus,
} from "lucide-react";
import type { FormField } from "./types";

interface FieldPaletteProps {
  onAddField: (type: FormField["type"]) => void;
}

interface FieldTypeEntry {
  type: FormField["type"];
  label: string;
  icon: React.ElementType;
}

const INPUT_FIELD_TYPES: FieldTypeEntry[] = [
  { type: "text", label: "Texto", icon: Type },
  { type: "email", label: "Email", icon: Mail },
  { type: "phone", label: "Telefone", icon: Phone },
  { type: "number", label: "Numero", icon: Hash },
  { type: "select", label: "Selecao", icon: ChevronDown },
  { type: "textarea", label: "Area de Texto", icon: AlignLeft },
  { type: "checkbox", label: "Checkbox", icon: CheckSquare },
  { type: "date", label: "Data", icon: Calendar },
  { type: "radio", label: "Radio", icon: CircleDot },
  { type: "url", label: "URL", icon: Link },
  { type: "hidden", label: "Oculto", icon: EyeOff },
  { type: "rating", label: "Avaliacao", icon: Star },
];

const LAYOUT_FIELD_TYPES: FieldTypeEntry[] = [
  { type: "heading", label: "Titulo", icon: Heading },
  { type: "divider", label: "Divisor", icon: Minus },
];

function FieldTypeButton({
  type,
  label,
  icon: Icon,
  onAddField,
}: FieldTypeEntry & { onAddField: (type: FormField["type"]) => void }) {
  return (
    <button
      key={type}
      onClick={() => onAddField(type)}
      aria-label={`Adicionar campo ${label}`}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5",
        "min-h-[56px] px-2 py-3 rounded-lg",
        "border border-border-strong bg-surface-raised",
        "text-text-secondary text-[13px] font-medium",
        "hover:border-brand-500 hover:text-brand-500 hover:bg-brand-500/5",
        "active:bg-brand-500/10",
        "transition-all duration-150",
        "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
      )}
    >
      <Icon size={18} aria-hidden="true" />
      <span className="leading-tight text-center">{label}</span>
    </button>
  );
}

export function FieldPalette({ onAddField }: FieldPaletteProps) {
  return (
    <div className="space-y-4">
      {/* Campos de Entrada */}
      <div>
        <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-2">
          Campos de Entrada
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {INPUT_FIELD_TYPES.map((entry) => (
            <FieldTypeButton key={entry.type} {...entry} onAddField={onAddField} />
          ))}
        </div>
      </div>

      {/* Layout */}
      <div>
        <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-2">
          Layout
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {LAYOUT_FIELD_TYPES.map((entry) => (
            <FieldTypeButton key={entry.type} {...entry} onAddField={onAddField} />
          ))}
        </div>
      </div>
    </div>
  );
}
