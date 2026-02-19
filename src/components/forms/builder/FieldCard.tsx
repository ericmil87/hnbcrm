import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import {
  GripVertical,
  X,
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

interface FieldCardProps {
  field: FormField;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

const FIELD_ICONS: Record<FormField["type"], React.ElementType> = {
  text: Type,
  email: Mail,
  phone: Phone,
  number: Hash,
  select: ChevronDown,
  textarea: AlignLeft,
  checkbox: CheckSquare,
  date: Calendar,
};

const FIELD_LABELS: Record<FormField["type"], string> = {
  text: "Texto",
  email: "Email",
  phone: "Telefone",
  number: "Numero",
  select: "Selecao",
  textarea: "Area de Texto",
  checkbox: "Checkbox",
  date: "Data",
};

export function FieldCard({ field, isSelected, onSelect, onDelete }: FieldCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const Icon = FIELD_ICONS[field.type];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group relative flex items-center gap-3 min-h-[56px] px-3 py-3 rounded-lg",
        "border bg-surface-raised",
        "transition-all duration-150 cursor-pointer",
        isSelected
          ? "border-brand-500 bg-brand-500/10 shadow-sm"
          : "border-border hover:border-border-strong",
        isDragging && "opacity-40 shadow-lg scale-[1.02] z-50"
      )}
      onClick={onSelect}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        aria-label="Arrastar campo"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex-shrink-0 p-1 -ml-1 rounded touch-none",
          "text-text-muted hover:text-text-secondary",
          "cursor-grab active:cursor-grabbing",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 focus:ring-offset-surface-raised",
          "transition-colors"
        )}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>

      {/* Field type icon */}
      <div className="flex-shrink-0 text-text-muted">
        <Icon size={16} aria-hidden="true" />
      </div>

      {/* Label + type */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary truncate">{field.label}</p>
        <p className="text-[12px] text-text-muted">{FIELD_LABELS[field.type]}</p>
      </div>

      {/* Required badge */}
      {field.isRequired && (
        <span
          aria-label="Obrigatorio"
          className="flex-shrink-0 text-semantic-error text-[13px] font-bold leading-none"
        >
          *
        </span>
      )}

      {/* Delete button — appears on hover or when selected */}
      <button
        aria-label={`Remover campo ${field.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className={cn(
          "flex-shrink-0 p-1.5 rounded-full",
          "text-text-muted hover:text-semantic-error hover:bg-semantic-error/10",
          "opacity-0 group-hover:opacity-100 focus:opacity-100",
          "transition-all duration-150",
          "focus:outline-none focus:ring-2 focus:ring-semantic-error focus:ring-offset-1 focus:ring-offset-surface-raised",
          isSelected && "opacity-100"
        )}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
