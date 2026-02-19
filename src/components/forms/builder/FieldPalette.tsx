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

const FIELD_TYPES: FieldTypeEntry[] = [
  { type: "text", label: "Texto", icon: Type },
  { type: "email", label: "Email", icon: Mail },
  { type: "phone", label: "Telefone", icon: Phone },
  { type: "number", label: "Numero", icon: Hash },
  { type: "select", label: "Selecao", icon: ChevronDown },
  { type: "textarea", label: "Area de Texto", icon: AlignLeft },
  { type: "checkbox", label: "Checkbox", icon: CheckSquare },
  { type: "date", label: "Data", icon: Calendar },
];

export function FieldPalette({ onAddField }: FieldPaletteProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      {FIELD_TYPES.map(({ type, label, icon: Icon }) => (
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
      ))}
    </div>
  );
}
